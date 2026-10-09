'use strict';

const crypto = require('crypto');
const { randomUUID: uuid } = require('crypto');
const ObjectId = require('mongodb').ObjectId;
const Indexer = require('../imap-core/lib/indexer/indexer');
const ImapNotifier = require('./imap-notifier');
const ApnClient = require('./apn-client');
const config = require('@zone-eu/wild-config');
const AttachmentStorage = require('./attachment-storage');
const AuditHandler = require('./audit-handler');
const libmime = require('libmime');
const counters = require('./counters');
const consts = require('./consts');
const tools = require('./tools');
const openpgp = require('openpgp');
const parseDate = require('../imap-core/lib/parse-date');
const log = require('npmlog');
const packageData = require('../package.json');
const { SettingsHandler } = require('./settings-handler');
const SMIMEEncryptor = require('@zone-eu/smime-js');
const { htmlToText } = require('html-to-text');
const { Headers } = require('@zone-eu/mailsplit');
const metrics = require('./metrics');
const { getLabelMaps, labelNamesForMessage, getMessageImapFlags, prepareLabelChanges } = require('./label-handler');
const { publish, MARKED_HAM } = require('./events');

const DISALLOWED_HEADERS_FOR_ADDRESS_REGISTER = ['list-id', 'auto-submitted', 'x-auto-response-suppress'];

openpgp.config.commentstring = 'Plaintext message encrypted by WildDuck Mail Server';
openpgp.config.versionString = `WildDuck v${packageData.version}`;

// Headers duplicated on the outer envelope for UX/UI purposes (like BIMI-* or Subject).
// Non-listed headers will only reside in the encrypted body for privacy.
const OUTER_HEADER_NAMES = [
    'date',
    'subject',
    'from',
    'to',
    'message-id',
    'mime-version',
    'bimi-location',
    'bimi-indicator',
    'authentication-results',
    'references',
    'in-reply-to'
];

// RFC 2045 §6.8: base64-encoded lines MUST be no longer than 76 characters.
const TARGET_LINE_LENGTH = 76;

// IMAP clients get TRYCREATE, API clients 404 NoSuchMailbox
const mailboxMissingError = () => {
    const err = new Error('Mailbox is missing');
    err.imapResponse = 'TRYCREATE';
    err.responseCode = 404;
    err.code = 'NoSuchMailbox';
    return err;
};

class MessageHandler {
    constructor(options) {
        this.database = options.database;
        this.redis = options.redis;
        this.settingsHandler = options.settingsHandler || new SettingsHandler({ db: this.database });

        this.loggelf = options.loggelf || (() => false);

        this.attachmentStorage =
            options.attachmentStorage ||
            new AttachmentStorage({
                gridfs: options.gridfs || options.database,
                options: options.attachments,
                redis: this.redis
            });

        this.indexer = new Indexer({
            attachmentStorage: this.attachmentStorage,
            loggelf: message => this.loggelf(message)
        });

        this.notifier = new ImapNotifier({
            database: options.database,
            redis: this.redis,
            settingsHandler: this.settingsHandler,
            pushOnly: true,
            // Shared-library SMTP delivery does not pass an APNs client.
            apn:
                options.apn === undefined
                    ? ApnClient.get({ config: config.imap && config.imap.aps, database: this.database, loggelf: this.loggelf })
                    : options.apn
        });

        this.users = options.users || options.database;
        this.counters = counters(this.redis);

        this.auditHandler = new AuditHandler({
            database: this.database,
            users: this.users,
            gridfs: options.gridfs || this.database,
            bucket: 'audit',
            loggelf: message => this.loggelf(message)
        });
    }

    /**
     * Checks whether a message is already encrypted (PGP or S/MIME).
     * @param {string} contentTypeHeader - Full Content-Type header value (e.g. "multipart/encrypted; ...")
     * @returns {boolean}
     */
    static isMessageEncrypted(contentTypeHeader) {
        if (!contentTypeHeader) return false;
        let ct = contentTypeHeader.split(';').shift().trim().toLowerCase();
        if (ct === 'multipart/encrypted') return true;
        return ct === 'application/pkcs7-mime' && /smime-type\s*=\s*(?:auth)?enveloped-data/i.test(contentTypeHeader);
    }

    // Pre-parsed Content-Type variant of isMessageEncrypted.
    static isEncryptedContentType(parsedContentType) {
        if (!parsedContentType) return false;
        let value = String(parsedContentType.value || '').toLowerCase();
        if (value === 'multipart/encrypted') return true;
        if (value !== 'application/pkcs7-mime') return false;
        let smimeType = String((parsedContentType.params || {})['smime-type'] || '').toLowerCase();
        return smimeType === 'enveloped-data' || smimeType === 'authenveloped-data';
    }

    /**
     * Extracts the Content-Type header value from a mimeTree or raw Buffer.
     * @param {object|Buffer} source - mimeTree (with .header array) or raw Buffer
     * @returns {string} Content-Type header value or empty string
     */
    _getContentType(source) {
        // From mimeTree: find content-type in header array
        if (source && source.header) {
            let ctLine = source.header.find(h => /^content-type\s*:/i.test(h));
            return ctLine ? ctLine.replace(/^content-type\s*:\s*/i, '').trim() : '';
        }
        // From raw Buffer
        if (Buffer.isBuffer(source)) {
            let end = source.indexOf('\r\n\r\n');
            if (end < 0) return '';
            let headers = new Headers(source.subarray(0, end + 4));
            return headers.getFirst('content-type') || '';
        }
        return '';
    }

    async getMailboxAsync(options) {
        let query = options.query;
        if (!query) {
            query = {};
            if (options.mailbox) {
                if (tools.isId(options.mailbox._id)) {
                    return options.mailbox;
                }

                if (tools.isId(options.mailbox)) {
                    query._id = new ObjectId(options.mailbox);
                } else {
                    throw new Error('Invalid mailbox ID');
                }

                if (options.user) {
                    query.user = options.user;
                }
            } else {
                query.user = options.user;
                if (options.specialUse) {
                    query.specialUse = options.specialUse;
                } else if (options.path) {
                    query.path = options.path;
                } else {
                    throw mailboxMissingError();
                }
            }
        }

        let mailboxData = await this.database.collection('mailboxes').findOne(query);
        if (!mailboxData) {
            if (options.path !== 'INBOX' && options.inboxDefault) {
                // fall back to INBOX if requested mailbox is missing
                mailboxData = await this.database.collection('mailboxes').findOne({
                    user: options.user,
                    path: 'INBOX'
                });

                if (!mailboxData) {
                    throw mailboxMissingError();
                }

                return mailboxData;
            }

            throw mailboxMissingError();
        }

        return mailboxData;
    }

    getMailbox(options, callback) {
        this.getMailboxAsync(options)
            .then(mailboxData => callback(null, mailboxData))
            .catch(err => callback(err));
    }

    add(options, callback) {
        this.addAsync(options)
            .then(messageAddedData => callback(null, messageAddedData.status, messageAddedData.data))
            .catch(err => callback(err));
    }

    /**
     * Adds or updates messages in the address register that is needed for typeahead address search
     * @param {ObjectId} user
     * @param {Object[]} addresses
     * @param {string} [addresses.name] Name from the address
     * @param {string} [addresses.address] Email address
     */
    async updateAddressRegister(user, addresses) {
        if (!addresses || !addresses.length) {
            return;
        }

        try {
            for (let addr of addresses) {
                if (!addr.address) {
                    continue;
                }

                addr = tools.normalizeAddress(addr, true);
                addr.addrview = tools.uview(addr.address);

                let updates = { updated: new Date() };
                if (addr.name) {
                    updates.name = addr.name;
                    try {
                        // try to decode
                        updates.name = libmime.decodeWords(updates.name);
                    } catch (E) {
                        // ignore
                    }
                }

                await this.database.collection('addressregister').findOneAndUpdate(
                    {
                        user,
                        addrview: addr.addrview,
                        disabled: false // if disabled then do not update
                    },
                    {
                        $set: updates,
                        $setOnInsert: {
                            user,
                            address: addr.address,
                            addrview: addr.addrview,
                            disabled: false
                        }
                    },
                    { upsert: true, projection: { _id: true } }
                );
            }
        } catch {
            // can ignore, not an important operation
        }
    }

    async addAsync(options) {
        let source = metrics.normalizeSource(options);
        let endMetric = metrics.startMessageOperation('add', source);

        try {
            let result = await this._addAsync(options);
            endMetric('success');

            let size = result && result.data && Number(result.data.size);
            if (typeof size === 'number' && isFinite(size) && size >= 0) {
                metrics.recordMessageSize(source, size);
            }

            return result;
        } catch (err) {
            endMetric('error');
            throw err;
        }
    }

    // Monster method for inserting new messages to a mailbox
    async _addAsync(options) {
        if (!options.prepared && options.raw && options.raw.length > consts.MAX_ALLOWED_MESSAGE_SIZE) {
            throw new Error('Message size ' + options.raw.length + ' bytes is too large');
        }

        // get target mailbox data
        // get target user data
        // if throws will be handled by caller or wrapper
        let [mailboxData, userData] = await Promise.all([this.getMailboxAsync(options), this.users.collection('users').findOne({ _id: options.user })]);

        if (!userData) {
            throw new Error('No such user!');
        }

        let prepared = options.prepared; // might be undefined

        // Coalesce rawchunks into raw if needed (used for encryption check and downstream)
        if (!prepared && options.rawchunks && !options.raw) {
            if (options.chunklen) {
                options.raw = Buffer.concat(options.rawchunks, options.chunklen);
            } else {
                options.raw = Buffer.concat(options.rawchunks);
            }
        }

        let alreadyEncrypted = prepared
            ? MessageHandler.isMessageEncrypted(this._getContentType(prepared.mimeTree))
            : MessageHandler.isMessageEncrypted(this._getContentType(options.raw));

        const flags = Array.isArray(options.flags) ? options.flags : [].concat(options.flags || []);
        const assignedLabelIds = [].concat(options.labels || []).filter(label => label && typeof label.toHexString === 'function');
        const assignedLabelMaps = assignedLabelIds.length
            ? await getLabelMaps(this.database, userData._id, { ids: assignedLabelIds })
            : { records: [], byId: new Map() };
        const assignedLabels = assignedLabelMaps.records;
        const labels = assignedLabels.map(label => label._id);
        const labelNames = assignedLabels.map(label => label.name);

        let encryptionKey =
            !alreadyEncrypted &&
            (userData.encryptMessages || !!mailboxData.encryptMessages) &&
            !flags.includes('\\Draft') &&
            tools.getUserEncryptionKey(userData);

        if (encryptionKey) {
            // encrypt message and re-prepare
            const encryptResult = await this.encryptMessageAsync(encryptionKey, options.raw);

            if (encryptResult) {
                options.raw = encryptResult.raw;
            } else {
                log.error('ENCRYPT', 'Encryption returned false, message stored unencrypted (source=%s user=%s)', 'message_add', userData._id);
                this.loggelf({
                    short_message: '[ENCRYPTSKIP] Encryption returned false, message stored unencrypted',
                    _mail_action: 'encrypt_skip',
                    _user: userData._id,
                    _source: 'message_add'
                });
            }

            delete options.prepared;
            const newPrepared = await this.prepareMessageAsync(options);

            if (prepared) {
                newPrepared.id = prepared.id; // retain original
            }
            options.prepared = newPrepared;
            prepared = newPrepared;
            options.maildata = this.indexer.getMaildata(newPrepared.mimeTree);
        } else {
            const newPrepared = await this.prepareMessageAsync(options);
            prepared = newPrepared;
        }

        let id = prepared.id;
        let mimeTree = prepared.mimeTree;
        let size = prepared.size;
        let bodystructure = prepared.bodystructure;
        let envelope = prepared.envelope;
        let idate = prepared.idate;
        let hdate = prepared.hdate;
        let hdateDay = prepared.hdateDay;
        let msgid = prepared.msgid;
        let subject = prepared.subject;
        let headers = prepared.headers;

        let maildata = options.maildata || this.indexer.getMaildata(mimeTree);

        let cleanup = async (err, status, data) => {
            if (!err) {
                // no error
                return { status, data };
            }

            let attachmentIds = Object.keys(mimeTree.attachmentMap || {}).map(key => mimeTree.attachmentMap[key]);
            if (!attachmentIds.length) {
                // with err, no attachments
                throw err;
            }

            // with err, with attachments
            try {
                await this.attachmentStorage.deleteManyAsync(attachmentIds, maildata.magic);
            } catch {
                // throw original error
                throw err;
            }
            throw err;
        };

        try {
            await new Promise((resolve, reject) => {
                this.indexer.storeNodeBodies(maildata, mimeTree, err => {
                    if (err) {
                        return reject(err);
                    }
                    return resolve();
                });
            });
        } catch (err) {
            return cleanup(err);
        }

        // prepare message object
        let messageData = {
            _id: id,

            // should be kept when COPY'ing or MOVE'ing
            root: id,

            v: consts.SCHEMA_VERSION,

            // make sure the field exists. it is set to true when user is deleted
            userDeleted: false,

            idate,
            hdate,
            hdateDay,
            flags,
            labels,
            size,

            // some custom metadata about the delivery
            meta: options.meta || {},

            // list filter IDs that matched this message
            filters: Array.isArray(options.filters) ? options.filters : [].concat(options.filters || []),

            headers,
            mimeTree,
            envelope,
            bodystructure,
            msgid,

            // use boolean for more commonly used (and searched for) flags
            unseen: !flags.includes('\\Seen'),
            flagged: flags.includes('\\Flagged'),
            undeleted: !flags.includes('\\Deleted'),
            draft: flags.includes('\\Draft'),

            magic: maildata.magic,

            subject,

            // do not archive deleted messages that have been copied
            copied: false
        };

        tools.applyMessageRetention(messageData, mailboxData, id.getTimestamp().getTime());

        if (options.verificationResults) {
            messageData.verificationResults = options.verificationResults;
        }

        if (options.outbound) {
            messageData.outbound = [].concat(options.outbound || []);
        }

        if (options.forwardTargets) {
            messageData.forwardTargets = [].concat(options.forwardTargets || []);
        }

        if (maildata.attachments && maildata.attachments.length) {
            messageData.attachments = maildata.attachments;
            messageData.ha = maildata.attachments.some(a => !a.related);
        } else {
            messageData.ha = false;
        }

        if (maildata.text) {
            messageData.text = maildata.text.replace(/\r\n/g, '\n').trim();

            // text is indexed with a fulltext index, so only store the beginning of it
            if (messageData.text.length > consts.MAX_PLAINTEXT_INDEXED) {
                messageData.textFooter = messageData.text.substr(consts.MAX_PLAINTEXT_INDEXED);
                messageData.text = messageData.text.substr(0, consts.MAX_PLAINTEXT_INDEXED);

                // truncate remaining text if total length exceeds maximum allowed
                if (
                    consts.MAX_PLAINTEXT_CONTENT > consts.MAX_PLAINTEXT_INDEXED &&
                    messageData.textFooter.length > consts.MAX_PLAINTEXT_CONTENT - consts.MAX_PLAINTEXT_INDEXED
                ) {
                    messageData.textFooter = messageData.textFooter.substr(0, consts.MAX_PLAINTEXT_CONTENT - consts.MAX_PLAINTEXT_INDEXED);
                }
            }
            messageData.text =
                messageData.text.length <= consts.MAX_PLAINTEXT_CONTENT ? messageData.text : messageData.text.substr(0, consts.MAX_PLAINTEXT_CONTENT);

            messageData.intro = this.createIntro(messageData.text);
        }

        if (maildata.html && maildata.html.length) {
            let htmlSize = 0;
            messageData.html = maildata.html
                .map(html => {
                    if (htmlSize >= consts.MAX_HTML_CONTENT || !html) {
                        return '';
                    }

                    if (htmlSize + Buffer.byteLength(html) <= consts.MAX_HTML_CONTENT) {
                        htmlSize += Buffer.byteLength(html);
                        return html;
                    }

                    html = html.substr(0, consts.MAX_HTML_CONTENT);
                    htmlSize += Buffer.byteLength(html);
                    return html;
                })
                .filter(html => html);

            // if message has HTML content use it instead of text/plain content for intro
            try {
                messageData.intro = this.createIntro(htmlToText(messageData.html.join('')));
            } catch {
                // ignore
            }
        }

        let r;

        try {
            r = await this.users.collection('users').findOneAndUpdate(
                {
                    _id: mailboxData.user
                },
                {
                    $inc: {
                        storageUsed: size
                    }
                },
                {
                    returnDocument: 'after',
                    projection: {
                        storageUsed: true
                    }
                }
            );
        } catch (err) {
            return cleanup(err);
        }

        if (r && r.value) {
            this.loggelf({
                short_message: '[QUOTA] +',
                _mail_action: 'quota',
                _user: mailboxData.user,
                _inc: size,
                _storage_used: r.value.storageUsed,
                _sess: options.session && options.session.id,
                _mailbox: mailboxData._id,
                _mailbox_path: mailboxData.path
            });
        }

        let rollback = async rollbackError => {
            let r;
            try {
                r = await this.users.collection('users').findOneAndUpdate(
                    {
                        _id: mailboxData.user
                    },
                    {
                        $inc: {
                            storageUsed: -size
                        }
                    },
                    {
                        returnDocument: 'after',
                        projection: {
                            storageUsed: true
                        }
                    }
                );
            } catch {
                // some error, clean up immediately
                return cleanup(rollbackError);
            }

            if (r && r.value) {
                this.loggelf({
                    short_message: '[QUOTA] -',
                    _mail_action: 'quota',
                    _user: mailboxData.user,
                    _inc: -size,
                    _storage_used: r.value.storageUsed,
                    _sess: options.session && options.session.id,
                    _mailbox: mailboxData._id,
                    _mailbox_path: mailboxData.path,
                    _rollback: 'yes',
                    _error: rollbackError.message,
                    _code: rollbackError.code
                });
            }

            return cleanup(rollbackError);
        };

        // acquire new UID+MODSEQ

        let item;

        try {
            item = await this.database.collection('mailboxes').findOneAndUpdate(
                {
                    _id: mailboxData._id
                },
                {
                    $inc: {
                        // allocate bot UID and MODSEQ values so when journal is later sorted by
                        // modseq then UIDs are always in ascending order
                        uidNext: 1,
                        modifyIndex: 1
                    }
                },
                {
                    // use original value to get correct UIDNext
                    returnDocument: 'before'
                }
            );
        } catch (err) {
            return rollback(err);
        }

        if (!item || !item.value) {
            // was not able to acquire a lock
            return rollback(mailboxMissingError());
        }

        mailboxData = item.value;

        // updated message object by setting mailbox specific values
        messageData.mailbox = mailboxData._id;
        messageData.user = mailboxData.user;
        messageData.uid = mailboxData.uidNext;
        messageData.modseq = mailboxData.modifyIndex + 1;

        // RFC 3501 6.4.4: BODY and TEXT match "messages that contain the specified string", and
        // 2.3.2 makes \Deleted only a marker, so a message stays searchable until it is expunged
        messageData.searchable = true;

        if (mailboxData.specialUse === '\\Junk') {
            messageData.junk = true;
        }

        let thread;

        // If referencing a message then use referenced message's thread (applies to any action)
        if (
            options?.referencedMessage?.thread &&
            this.normalizeSubject(subject, {
                removePrefix: true
            }) ===
                this.normalizeSubject(options?.referencedMessage?.subject || '', {
                    removePrefix: true
                }) &&
            thread !== options.referencedMessage.thread
        ) {
            thread = options.referencedMessage.thread;
        }

        try {
            thread = await this.getThreadIdAsync(mailboxData.user, subject, mimeTree, thread);
        } catch (err) {
            return rollback(err);
        }

        messageData.thread = thread;

        let insertRes;

        try {
            insertRes = await this.database.collection('messages').insertOne(messageData, { writeConcern: 'majority' });
        } catch (err) {
            // an error does not always mean the message was not stored (a write concern error comes after the
            // write), and a stored message without its attachment references would lose them to the collector
            let stored = await this.storedDespiteError(messageData._id);
            if (stored === false) {
                return rollback(err);
            }
            if (stored === null) {
                // can not tell: keep quota and references, a leak is better than a loss, and fail the store
                throw err;
            }
            log.error('Messages', 'Stored message %s despite error=%s', messageData._id, err.message);
            insertRes = { acknowledged: true };
        }

        if (!insertRes || !insertRes.acknowledged) {
            let err = new Error('Failed to store message [1]');
            err.responseCode = 500;
            err.code = 'StoreError';
            return rollback(err);
        }

        let logTime = messageData.meta.time || new Date();
        if (typeof logTime === 'number') {
            logTime = new Date(logTime);
        }

        let uidValidity = mailboxData.uidValidity;
        let uid = messageData.uid;

        // journals the new message, runs the audits and resolves with the cleanup result
        const finishFunc = async () => {
            try {
                await this.notifier.addEntriesAsync(mailboxData, {
                    command: 'EXISTS',
                    uid: messageData.uid,
                    ignore: options.session && options.session.id,
                    message: messageData._id,
                    modseq: messageData.modseq,
                    unseen: messageData.unseen,
                    flagged: messageData.flagged,
                    labels: labelNames,
                    idate: messageData.idate,
                    thread: messageData.thread
                });
            } catch {
                // the message is stored, only the journal entry is missing
            }

            // added Entries
            this.notifier.fire(mailboxData.user);

            let raw = options.rawchunks || options.raw;
            let processAudits = async () => {
                let audits = await this.database
                    .collection('audits')
                    .find({ user: mailboxData.user, expires: { $gt: new Date() } })
                    .toArray();

                let now = new Date();
                const auditPromises = [];

                for (let auditData of audits) {
                    if ((auditData.start && auditData.start > now) || (auditData.end && auditData.end < now)) {
                        // audit not active
                        continue;
                    }

                    auditPromises.push(
                        this.auditHandler.store(auditData._id, raw, {
                            date: messageData.idate,
                            msgid: messageData.msgid,
                            header: messageData.mimeTree && messageData.mimeTree.parsedHeader,
                            ha: messageData.ha,
                            mailbox: mailboxData._id,
                            mailboxPath: mailboxData.path,
                            info: Object.assign({ queueId: messageData.outbound }, messageData.meta)
                        })
                    );
                }

                await Promise.all(auditPromises);
            };

            // can safely cleanup, no err given. Returns pending promise, which is fine
            const cleanupRes = cleanup(null, true, {
                uidValidity,
                uid,
                id: messageData._id.toString(),
                mailbox: mailboxData._id.toString(),
                mailboxPath: mailboxData.path,
                size,
                status: 'new',
                prepared
            });

            try {
                await processAudits();
            } catch {
                // audit failures do not fail the store
            }

            return cleanupRes;
        };

        if (tools.isSelectedMailbox(options.session, mailboxData._id)) {
            options.session.writeStream.write(options.session.formatResponse('EXISTS', messageData.uid));
        }

        let addresses = [];

        if (messageData.junk || flags.includes('\\Draft')) {
            // skip junk and draft messages
            return finishFunc();
        }

        let parsed = messageData.mimeTree && messageData.mimeTree.parsedHeader;

        if (parsed) {
            let keyList = mailboxData.specialUse === '\\Sent' ? ['to', 'cc', 'bcc'] : ['from'];

            for (const disallowedHeader of DISALLOWED_HEADERS_FOR_ADDRESS_REGISTER) {
                // if email contains headers that we do not want,
                // don't add any emails to address register
                if (parsed[disallowedHeader]) {
                    return finishFunc();
                }
            }

            for (let key of keyList) {
                if (parsed[key] && parsed[key].length) {
                    for (let addr of parsed[key]) {
                        if (/no-?reply/i.test(addr.address)) {
                            continue;
                        }
                        if (!addresses.some(a => a.address === addr.address)) {
                            addresses.push(addr);
                        }
                    }
                }
            }
        }

        if (!addresses.length) {
            return finishFunc();
        }

        await this.updateAddressRegister(mailboxData.user, addresses);
        return finishFunc();
    }

    /**
     * Whether a message whose insert threw was stored anyway, as it is when the error is a write concern error
     * that came after the write
     *
     * @param {ObjectId} id Message id
     * @returns {Boolean|null} true or false, null when it can not be told
     */
    async storedDespiteError(id) {
        try {
            return !!(await this.database.collection('messages').findOne({ _id: id }, { projection: { _id: true } }));
        } catch {
            return null;
        }
    }

    async updateQuotaAsync(user, inc, options) {
        inc = inc || {};

        if (options.delayNotifications) {
            // quota change is handled at some later time
            return;
        }

        let r = await this.users.collection('users').findOneAndUpdate(
            {
                _id: user
            },
            {
                $inc: {
                    storageUsed: Number(inc.storageUsed) || 0
                }
            },
            {
                returnDocument: 'after',
                projection: {
                    storageUsed: true
                }
            }
        );

        if (r && r.value) {
            this.loggelf({
                short_message: '[QUOTA] ' + (Number(inc.storageUsed) || 0 < 0 ? '-' : '+'),
                _mail_action: 'quota',
                _user: user,
                _inc: inc.storageUsed,
                _storage_used: r.value.storageUsed,
                _sess: options.session && options.session.id,
                _mailbox: inc.mailbox,
                _mailbox_path: inc.mailboxPath
            });
        }

        return r;
    }

    updateQuota(user, inc, options, callback) {
        this.updateQuotaAsync(user, inc, options)
            .then(res => callback(null, res))
            .catch(err => callback(err));
    }

    async delAsync(options) {
        let source = metrics.normalizeSource(options);
        let endMetric = metrics.startMessageOperation('delete', source);

        try {
            let result = await this._delAsync(options);
            endMetric('success');
            return result;
        } catch (err) {
            endMetric('error');
            throw err;
        }
    }

    async _delAsync(options) {
        let messageData = options.messageData;
        let curtime = new Date();
        const labelMaps = messageData.labels?.length ? await getLabelMaps(this.database, messageData.user, { ids: messageData.labels }) : { byId: new Map() };
        const labelNames = labelNamesForMessage(messageData, labelMaps.byId);
        let mailboxData;
        try {
            mailboxData = await this.getMailboxAsync(
                options.mailbox || {
                    mailbox: messageData.mailbox
                }
            );
        } catch (err) {
            if (!err.imapResponse) {
                throw err;
            }
        }

        if (options.archive) {
            let archiveTime = await this.settingsHandler.get('const:archive:time', {});

            messageData.archived = curtime;
            messageData.exp = true;
            messageData.rdate = curtime.getTime() + archiveTime;

            let r;
            try {
                r = await this.database.collection('archived').insertOne(messageData, { writeConcern: 'majority' });
            } catch (err) {
                // if code is 11000 then message is already archived, probably the same message from another mailbox
                if (err.code !== 11000) {
                    throw err;
                }
            }

            if (r && r.acknowledged) {
                this.loggelf({
                    short_message: '[ARCHIVED]',
                    _mail_action: 'archived',
                    _user: messageData.user,
                    _mailbox: messageData.mailbox,
                    _mailbox_path: mailboxData && mailboxData.path,
                    _uid: messageData.uid,
                    _stored_id: messageData._id,
                    _subject: messageData.subject,
                    _expires: messageData.rdate,
                    _sess: options.session && options.session.id,
                    _size: messageData.size
                });
            }
        }

        let r = await this.database.collection('messages').deleteOne(
            {
                _id: messageData._id,
                mailbox: messageData.mailbox,
                uid: messageData.uid
            },
            { writeConcern: 'majority' }
        );

        if (!r || !r.deletedCount) {
            // nothing was deleted!
            return false;
        }

        try {
            await this.updateQuotaAsync(
                messageData.user,
                {
                    storageUsed: -messageData.size,
                    mailbox: messageData.mailbox,
                    mailboxPath: mailboxData && mailboxData.path
                },
                options
            );
        } catch (err) {
            log.error('messagedel', err);
        }

        if (!mailboxData) {
            // deleted an orphan message
            return true;
        }

        if (!options.archive) {
            // archived messages still need the attachments

            let attachmentIds = Object.keys(messageData.mimeTree.attachmentMap || {}).map(key => messageData.mimeTree.attachmentMap[key]);

            if (attachmentIds.length) {
                try {
                    await this.attachmentStorage.deleteManyAsync(attachmentIds, messageData.magic);
                } catch (err) {
                    log.error('attachdel', err);
                }
            }
        }

        if (tools.isSelectedMailbox(options.session, mailboxData._id)) {
            options.session.writeStream.write(options.session.formatResponse('EXPUNGE', messageData.uid));
        }

        try {
            await this.notifier.addEntriesAsync(mailboxData, {
                command: 'EXPUNGE',
                ignore: options.session && options.session.id,
                uid: messageData.uid,
                message: messageData._id,
                unseen: messageData.unseen,
                flagged: messageData.flagged,
                labels: labelNames,
                thread: messageData.thread
            });
        } catch (err) {
            log.error('notify', err);
        }

        if (!options.delayNotifications) {
            this.notifier.fire(mailboxData.user);
        }

        return true;
    }

    del(options, callback) {
        this.delAsync(options)
            .then(res => callback(null, res))
            .catch(err => callback(err));
    }

    move(options, callback) {
        this.moveAsync(options)
            .then(movedMessageRes => callback(null, movedMessageRes.result, movedMessageRes.info))
            .catch(err => callback(err));
    }

    async moveAsync(options) {
        let source = metrics.normalizeSource(options);
        let endMetric = metrics.startMessageOperation('move', source);

        try {
            let result = await this._moveAsync(options);
            endMetric('success');
            return result;
        } catch (err) {
            endMetric('error');
            throw err;
        }
    }

    async _moveAsync(options) {
        // concurrent promises
        const [mailboxData, targetData] = await Promise.all([this.getMailboxAsync(options.source), this.getMailboxAsync(options.destination)]);
        if (options.updates) {
            options.updates = await prepareLabelChanges(this.database, mailboxData.user, options.updates);
        }
        // Label maps are only needed for messages that have label IDs (or
        // when label changes have already supplied a prepared map). Avoid a
        // collection lookup for ordinary messages.
        let labelMaps = options.updates?._labelNamesById ? { byId: options.updates._labelNamesById } : null;

        let sourceUid = [];
        let destinationUid = [];

        let removeEntries = [];
        let existsEntries = [];

        // Fetch user encryption key once before the loop to avoid per-message DB queries
        let moveEncryptionKey = false;
        try {
            let encryptionUser = await this.users
                .collection('users')
                .findOne(
                    { _id: mailboxData.user },
                    { projection: { encryptMessages: true, pubKey: true, smimeCerts: true, smimeCipher: true, smimeKeyTransport: true } }
                );
            if (encryptionUser && (encryptionUser.encryptMessages || targetData.encryptMessages)) {
                moveEncryptionKey = tools.getUserEncryptionKey(encryptionUser);
            }
        } catch (err) {
            return this.moveDone(err, { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries }, options);
        }

        let cursor = this.database
            .collection('messages')
            .find({
                mailbox: mailboxData._id,
                uid: options.messageQuery ? options.messageQuery : tools.checkRangeQuery(options.messages)
            })
            // ordering is needed for IMAP UIDPLUS results
            .sort({ uid: 1 });

        let message = {};
        // Loop through all moved messages
        while (message !== undefined) {
            try {
                message = await cursor.next();

                if (!message) {
                    await cursor.close(); // close cursor
                    return this.moveDone(null, { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries }, options); // return move result
                }
            } catch (err) {
                return this.moveDone(err, { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries }, options);
            }

            let messageId = message._id;
            let messageUid = message.uid;

            if (options.returnIds) {
                sourceUid.push(message._id);
            } else {
                sourceUid.push(messageUid);
            }

            let item;

            try {
                item = await this.database.collection('mailboxes').findOneAndUpdate(
                    {
                        _id: targetData._id
                    },
                    {
                        $inc: {
                            uidNext: 1
                        }
                    },
                    {
                        projection: {
                            uidNext: true,
                            modifyIndex: true
                        },
                        returnDocument: 'before'
                    }
                );

                if (!item || !item.value) {
                    await cursor.close();
                    return this.moveDone(
                        new Error('Mailbox disappeared'),
                        { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries },
                        options
                    );
                }
            } catch (err) {
                await cursor.close();
                return this.moveDone(err, { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries }, options);
            }

            message._id = new ObjectId();

            let uidNext = item.value.uidNext;
            let modifyIndex = item.value.modifyIndex;

            if (options.returnIds) {
                destinationUid.push(message._id);
            } else {
                destinationUid.push(uidNext);
            }

            // set new mailbox
            message.mailbox = targetData._id;

            // new mailbox means new UID
            message.uid = uidNext;

            tools.applyMessageRetention(message, targetData, message._id.getTimestamp().getTime());
            message.modseq = modifyIndex; // reset message modseq to whatever it is for the mailbox right now

            if (!labelMaps && message.labels && message.labels.length) {
                labelMaps = await getLabelMaps(this.database, mailboxData.user);
            }

            const messageLabelMaps = labelMaps || { byId: new Map() };

            let unseen = message.unseen;
            let flagged = (message.flags ?? []).includes('\\Flagged');
            let labels = labelNamesForMessage(message, messageLabelMaps.byId);

            message.searchable = true;

            let junk = false;
            if (targetData.specialUse === '\\Junk' && !message.junk) {
                message.junk = true;
                junk = 1;
            } else if (targetData.specialUse !== '\\Trash' && message.junk) {
                delete message.junk;
                junk = -1;
            }

            Object.keys(options.updates || {}).forEach(key => {
                switch (key) {
                    case 'seen':
                    case 'deleted':
                        {
                            let fname = '\\' + key.charAt(0).toUpperCase() + key.substr(1);

                            if (options.updates[key] && !message.flags.includes(fname)) {
                                // add missing flag
                                message.flags.push(fname);
                            } else if (!options.updates[key] && message.flags.includes(fname)) {
                                // remove non-needed flag
                                let flags = new Set(message.flags);
                                flags.delete(fname);
                                message.flags = Array.from(flags);
                            }
                            message['un' + key] = !options.updates[key];
                        }
                        break;

                    case 'flagged':
                    case 'draft':
                        {
                            let fname = '\\' + key.charAt(0).toUpperCase() + key.substr(1);
                            if (options.updates[key] && !message.flags.includes(fname)) {
                                // add missing flag
                                message.flags.push(fname);
                            } else if (!options.updates[key] && message.flags.includes(fname)) {
                                // remove non-needed flag
                                let flags = new Set(message.flags);
                                flags.delete(fname);
                                message.flags = Array.from(flags);
                            }
                            message[key] = options.updates[key];
                        }
                        break;

                    case 'expires':
                        {
                            if (options.updates.expires) {
                                message.exp = true;
                                message.rdate = options.updates.expires.getTime();
                                delete message.retention;
                            } else {
                                message.exp = false;
                                delete message.rdate;
                                delete message.retention;
                            }
                        }
                        break;

                    case 'metaData':
                        message.meta = message.meta || {};
                        message.meta.custom = options.updates.metaData;
                        break;

                    case 'labels':
                        message.labels = [...options.updates._labelIds];
                        break;

                    case 'addLabels':
                        message.labels = [...new Map([...(message.labels || []), ...options.updates._addLabelIds].map(id => [id.toString(), id])).values()];
                        break;

                    case 'removeLabels': {
                        let removeLabels = new Set(options.updates._removeLabelIds.map(id => id.toString()));
                        message.labels = (message.labels || []).filter(id => !removeLabels.has(id.toString()));
                        break;
                    }

                    case 'outbound':
                        message.outbound = [].concat(message.outbound || []).concat(options.updates.outbound || []);
                        break;
                }
            });

            if (options.markAsSeen) {
                message.unseen = false;
                if (!message.flags.includes('\\Seen')) {
                    message.flags.push('\\Seen');
                }
            }

            const destinationLabels = labelNamesForMessage(message, messageLabelMaps.byId);

            const bulk_batch_size = await this.settingsHandler.get('const:max:bulk_batch_size', {});

            // updateMessage()'s raw deleteOne doesn't release source attachments or adjust quota
            let encryptedMoveCleanup = null;

            // new encrypted-body refs, released by updateMessage() only if the destination insert fails
            let encryptedInsertCleanup = null;

            if (moveEncryptionKey && !MessageHandler.isMessageEncrypted(this._getContentType(message.mimeTree))) {
                try {
                    let oldAttachmentIds = Object.keys(message.mimeTree.attachmentMap || {}).map(k => message.mimeTree.attachmentMap[k]);
                    let oldMagic = message.magic;
                    let oldSize = Number(message.size) || 0;

                    let result = await this.encryptAndPrepareMessageAsync(message.mimeTree, moveEncryptionKey);
                    if (result) {
                        message.attachments = result.maildata.attachments || [];
                        message.ha = (result.maildata.attachments || []).some(a => !a.related);
                        delete message.text;
                        delete message.textFooter;
                        delete message.html;
                        message.intro = '';
                        message.mimeTree = result.prepared.mimeTree;
                        message.size = result.prepared.size;
                        message.bodystructure = result.prepared.bodystructure;
                        message.envelope = result.prepared.envelope;
                        message.headers = result.prepared.headers;
                        message.magic = result.maildata.magic;

                        encryptedMoveCleanup = {
                            oldAttachmentIds,
                            oldMagic,
                            sizeDelta: (Number(message.size) || 0) - oldSize
                        };

                        encryptedInsertCleanup = {
                            newAttachmentIds: Object.keys(result.prepared.mimeTree.attachmentMap || {}).map(k => result.prepared.mimeTree.attachmentMap[k]),
                            newMagic: result.maildata.magic
                        };
                    } else {
                        log.error('ENCRYPT', 'Encryption returned false, message stored unencrypted (source=%s user=%s)', 'imap_move', mailboxData.user);
                        this.loggelf({
                            short_message: '[ENCRYPTSKIP] Encryption returned false, message stored unencrypted',
                            _mail_action: 'encrypt_skip',
                            _user: mailboxData.user,
                            _source: 'imap_move'
                        });
                    }
                } catch (err) {
                    return this.moveDone(err, { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries }, options);
                }
            }

            await this.updateMessage(
                {
                    message,
                    targetData,
                    sourceUid,
                    destinationUid,
                    mailboxData,
                    existsEntries,
                    removeEntries,
                    messageId,
                    messageUid,
                    unseen,
                    flagged,
                    labels,
                    destinationLabels,
                    uidNext,
                    junk,
                    bulk_batch_size,
                    encryptedInsertCleanup
                },
                cursor,
                options
            );

            if (encryptedMoveCleanup) {
                if (encryptedMoveCleanup.oldAttachmentIds.length) {
                    try {
                        await this.attachmentStorage.deleteManyAsync(encryptedMoveCleanup.oldAttachmentIds, encryptedMoveCleanup.oldMagic);
                    } catch (err) {
                        log.error(
                            'MOVE',
                            'Failed to release source attachments after encrypted move (source=%s user=%s mailbox=%s code=%s): %s',
                            'imap_move',
                            mailboxData.user,
                            targetData._id,
                            err.code || 'AttachmentReleaseError',
                            err.message
                        );
                        this.loggelf({
                            short_message: '[MOVEATTACHFAIL] Failed to release source attachments after encrypted move',
                            _mail_action: 'move_attach_fail',
                            _user: mailboxData.user,
                            _mailbox: targetData._id,
                            _mailbox_path: targetData.path,
                            _error: err.message,
                            _code: err.code || 'AttachmentReleaseError',
                            _source: 'imap_move'
                        });
                    }
                }

                if (encryptedMoveCleanup.sizeDelta) {
                    try {
                        await this.updateQuotaAsync(
                            mailboxData.user,
                            { storageUsed: encryptedMoveCleanup.sizeDelta, mailbox: targetData._id, mailboxPath: targetData.path },
                            options
                        );
                    } catch (err) {
                        log.error(
                            'MOVE',
                            'Failed to adjust storageUsed after encrypted move (source=%s user=%s mailbox=%s delta=%s code=%s): %s',
                            'imap_move',
                            mailboxData.user,
                            targetData._id,
                            encryptedMoveCleanup.sizeDelta,
                            err.code || 'QuotaUpdateError',
                            err.message
                        );
                        this.loggelf({
                            short_message: '[MOVEQUOTAFAIL] Failed to adjust storageUsed after encrypted move',
                            _mail_action: 'move_quota_fail',
                            _user: mailboxData.user,
                            _mailbox: targetData._id,
                            _mailbox_path: targetData.path,
                            _delta: encryptedMoveCleanup.sizeDelta,
                            _error: err.message,
                            _code: err.code || 'QuotaUpdateError',
                            _source: 'imap_move'
                        });
                    }
                }
            }
        }
    }

    /**
     * Marks the message a reply or a forward was based on as answered or forwarded and
     * notifies the connected clients. Best-effort: the new message is already stored,
     * so failures are ignored
     *
     * @param {ObjectId} user User ID
     * @param {Object} reference Reference info of the submitted message
     * @param {ObjectId|String} reference.mailbox Mailbox ID of the referenced message
     * @param {Number} reference.id UID of the referenced message
     * @param {String} reference.action reply, replyAll or forward
     * @returns {Promise<Boolean>} true if the referenced message was updated
     */
    async flagReferencedMessage(user, reference) {
        let setFlag;
        switch (reference && reference.action) {
            case 'reply':
            case 'replyAll':
                setFlag = '\\Answered';
                break;
            case 'forward':
                setFlag = { $each: ['\\Answered', '$Forwarded'] };
                break;
            default:
                return false;
        }

        let mailbox = new ObjectId(reference.mailbox);

        let r;
        try {
            r = await this.database.collection('messages').findOneAndUpdate(
                {
                    mailbox,
                    uid: reference.id,
                    user
                },
                {
                    $addToSet: {
                        flags: setFlag
                    }
                },
                {
                    returnDocument: 'after',
                    projection: {
                        uid: true,
                        flags: true,
                        thread: true
                    }
                }
            );
        } catch (err) {
            return false;
        }

        let messageData = r && r.value;
        if (!messageData) {
            return false;
        }

        try {
            await this.notifier.addEntriesAsync(mailbox, [
                {
                    command: 'FETCH',
                    uid: messageData.uid,
                    flags: messageData.flags,
                    message: messageData._id,
                    thread: messageData.thread,
                    unseenChange: false
                }
            ]);
        } catch (err) {
            // the flag is set, only the journal entry is missing
        }
        this.notifier.fire(user);

        return true;
    }

    /**
     * Stores an already prepared message to a mailbox. Resolves with the stored
     * location, or false if an identical message already exists. NB! does not update
     * user quota
     *
     * @returns {Promise<{mailbox: ObjectId, message: ObjectId, uid: Number}|false>}
     */
    async putAsync(messageData) {
        let source = metrics.normalizeSource(messageData && messageData.meta ? { meta: messageData.meta } : 'task');
        let endMetric = metrics.startMessageOperation('put', source);

        try {
            let result = await this._putAsync(messageData);
            endMetric('success');
            if (messageData && typeof messageData.size === 'number') {
                metrics.recordMessageSize(source, messageData.size);
            }
            return result;
        } catch (err) {
            endMetric('error');
            throw err;
        }
    }

    // NB! does not update user quota
    put(messageData, callback) {
        this.putAsync(messageData).then(result => callback(null, result), callback);
    }

    async _putAsync(messageData) {
        let mailboxData;
        try {
            mailboxData = await this.getMailboxAsync({ mailbox: messageData.mailbox });
        } catch (err) {
            if (err.imapResponse !== 'TRYCREATE') {
                throw err;
            }
        }

        if (!mailboxData) {
            mailboxData = await this.getMailboxAsync({
                query: {
                    user: messageData.user,
                    path: 'INBOX'
                }
            });
        }

        // the UID of the new message is the uidNext value before the increment
        let item = await this.database.collection('mailboxes').findOneAndUpdate(
            {
                _id: mailboxData._id
            },
            {
                $inc: {
                    uidNext: 1
                }
            },
            {
                returnDocument: 'before'
            }
        );

        if (!item || !item.value) {
            throw new Error('Mailbox disappeared');
        }

        let uidNext = item.value.uidNext;

        // set new mailbox
        messageData.mailbox = mailboxData._id;

        // new mailbox means new UID
        messageData.uid = uidNext;

        // this will be changed later by the notification system
        messageData.modseq = 0;

        tools.applyMessageRetention(messageData, mailboxData);

        messageData.searchable = true;

        let junk = false;
        if (mailboxData.specialUse === '\\Junk' && !messageData.junk) {
            messageData.junk = true;
            junk = 1;
        } else if (mailboxData.specialUse !== '\\Trash' && messageData.junk) {
            delete messageData.junk;
            junk = -1;
        }

        let r;
        try {
            r = await this.database.collection('messages').insertOne(messageData, { writeConcern: 'majority' });
        } catch (err) {
            if (err.code === 11000) {
                // message already exists
                return false;
            }
            throw err;
        }

        if (!r || !r.acknowledged) {
            let err = new Error('Failed to store message [3]');
            err.responseCode = 500;
            err.code = 'StoreError';
            throw err;
        }

        let insertId = r.insertedId;

        const labelMaps = messageData.labels?.length ? await getLabelMaps(this.database, messageData.user, { ids: messageData.labels }) : { byId: new Map() };
        let labelNames = labelNamesForMessage(messageData, labelMaps.byId);

        let entry = {
            command: 'EXISTS',
            uid: uidNext,
            message: insertId,
            unseen: messageData.unseen,
            flagged: messageData.flags.includes('\\Flagged'),
            labels: labelNames,
            idate: messageData.idate,
            thread: messageData.thread
        };
        if (junk) {
            entry.junk = junk;
        }

        // mark messages as added to new mailbox
        try {
            await this.notifier.addEntriesAsync(mailboxData, entry);
        } catch {
            // the message is stored, only the journal entry is missing
        }
        this.notifier.fire(mailboxData.user);

        return {
            mailbox: mailboxData._id,
            message: insertId,
            uid: uidNext
        };
    }

    generateIndexedHeaders(headersArray) {
        // allow configuring extra header keys that are indexed
        return (headersArray || [])
            .map(line => {
                line = Buffer.from(line, 'binary').toString();

                let key = line.substr(0, line.indexOf(':')).trim().toLowerCase();

                if (!consts.INDEXED_HEADERS.includes(key)) {
                    // do not index this header
                    return false;
                }

                let value = line
                    .substr(line.indexOf(':') + 1)
                    .trim()
                    .replace(/\s*\r?\n\s*/g, ' ');

                try {
                    value = libmime.decodeWords(value);
                } catch (E) {
                    // ignore
                }

                // store indexed value as lowercase for easier SEARCHing
                value = value.toLowerCase();

                switch (key) {
                    case 'list-id':
                        // only index the actual ID of the list
                        if (value.indexOf('<') >= 0) {
                            let m = value.match(/<([^>]+)/);
                            if (m && m[1] && m[1].trim()) {
                                value = m[1].trim();
                            }
                        }
                        break;
                }

                // trim long values as mongodb indexed fields can not be too long
                if (Buffer.byteLength(key, 'utf-8') >= 255) {
                    key = Buffer.from(key).slice(0, 255).toString();
                    key = key.substr(0, key.length - 4);
                }

                if (Buffer.byteLength(value, 'utf-8') >= 880) {
                    // value exceeds MongoDB max indexed value length
                    value = Buffer.from(value).slice(0, 880).toString();
                    // remove last 4 chars to be sure we do not have any incomplete unicode sequences
                    value = value.substr(0, value.length - 4);
                }

                return {
                    key,
                    value
                };
            })
            .filter(line => line);
    }

    async prepareMessageAsync(options) {
        if (options.prepared) {
            return options.prepared;
        }

        let id = new ObjectId();

        let mimeTree = options.mimeTree || this.indexer.parseMimeTree(options.raw);

        let size = this.indexer.getSize(mimeTree);
        let bodystructure = this.indexer.getBodyStructure(mimeTree);
        let envelope = this.indexer.getEnvelope(mimeTree);

        let idate = (options.date && parseDate(options.date)) || new Date();
        let dateHeader = [].concat(mimeTree.parsedHeader.date || []).pop() || '';
        let hdate = (mimeTree.parsedHeader.date && parseDate(dateHeader, idate)) || false;

        let subject = ([].concat(mimeTree.parsedHeader.subject || []).pop() || '').trim();
        try {
            subject = libmime.decodeWords(subject);
        } catch (E) {
            // ignore
        }

        subject = this.normalizeSubject(subject, {
            removePrefix: false
        });

        let flags = [].concat(options.flags || []);

        if (!hdate || hdate.toString() === 'Invalid Date') {
            hdate = idate;
            // the zone of a header we could not read says nothing about the internal date
            dateHeader = '';
        }

        // RFC 3501 6.4.4: SENTBEFORE, SENTON and SENTSINCE compare the Date header "disregarding
        // time and timezone", which the instant in hdate alone can not answer
        let hdateDay = parseDate.getCalendarDay(hdate, dateHeader);

        let msgid = envelope[9] || '<' + uuid() + '@wildduck.email>';

        let headers = this.generateIndexedHeaders(mimeTree.header);

        let prepared = {
            id,
            mimeTree,
            size,
            bodystructure,
            envelope,
            idate,
            hdate,
            hdateDay,
            flags,
            msgid,
            headers,
            subject
        };

        return prepared;
    }

    prepareMessage(options, callback) {
        this.prepareMessageAsync(options)
            .then(prepared => callback(null, prepared))
            .catch(err => callback(err));
    }

    // resolves or generates new thread id for a message
    async getThreadIdAsync(userId, subject, mimeTree, referencedThreadId) {
        let referenceIds = new Set(
            [
                [].concat(mimeTree.parsedHeader['message-id'] || []).pop() || '',
                [].concat(mimeTree.parsedHeader['in-reply-to'] || []).pop() || '',
                ([].concat(mimeTree.parsedHeader['thread-index'] || []).pop() || '').substr(0, 22),
                [].concat(mimeTree.parsedHeader.references || []).pop() || ''
            ]
                .join(' ')
                .split(/\s+/)
                .map(id => id.replace(/[<>]/g, '').trim())
                .filter(id => id)
                .map(id => crypto.createHash('sha1').update(id).digest('base64').replace(/[=]+$/g, ''))
        );

        subject = this.normalizeSubject(subject, {
            removePrefix: true
        });
        referenceIds = Array.from(referenceIds).slice(0, 10);

        // Thread may not exist, but the message is referencing a thread that may have existed before, in that case recreate thread
        const query = referencedThreadId ? { _id: new ObjectId(referencedThreadId), user: userId } : { user: userId, ids: { $in: referenceIds }, subject };

        // most messages are not threaded, so an upsert call should be ok to make
        const existingThread = await this.database.collection('threads').findOneAndUpdate(
            query,
            [
                {
                    $set: {
                        ids: {
                            $cond: [{ $isArray: '$ids' }, '$ids', ['$ids']]
                        },
                        updated: new Date(),
                        user: { $ifNull: ['$user', userId] },
                        // Use a literal so subjects starting with "$" are not parsed as field paths
                        subject: { $ifNull: ['$subject', { $literal: subject }] }
                    }
                },
                {
                    $set: {
                        ids: { $setUnion: ['$ids', referenceIds] }
                    }
                }
            ],
            {
                upsert: true,
                returnDocument: 'after',
                projection: { _id: 1 }
            }
        );

        return existingThread.value._id;
    }

    normalizeSubject(subject, options) {
        options = options || {};
        subject = subject.replace(/\s+/g, ' ').trim();

        // `Re: [EXTERNAL] Re: Fwd: Example subject (fwd)` becomes `Example subject`
        if (options.removePrefix) {
            let match = true;
            while (match) {
                match = false;
                subject = subject
                    .replace(/^(re|fwd?)\s*:|^\[.+?\](?=\s.+)|\s*\(fwd\)\s*$/gi, () => {
                        match = true;
                        return '';
                    })
                    .trim();
            }
        }

        return subject;
    }

    /**
     * Updates flags, labels, metadata or the date of the messages matching a query in a mailbox
     *
     * @returns {Promise<Number>} Number of updated messages
     */
    async updateAsync(user, mailbox, messageQuery, changes) {
        let endMetric = metrics.startMessageOperation('update', 'unknown');

        try {
            const hasLabelChanges = changes && ['labels', 'addLabels', 'removeLabels'].some(key => key in changes);
            if (hasLabelChanges) {
                changes = await prepareLabelChanges(this.database, user, changes);
            }
            let result = await this._updateAsync(user, mailbox, messageQuery, changes);
            endMetric('success');
            return result;
        } catch (err) {
            endMetric('error');
            throw err;
        }
    }

    update(user, mailbox, messageQuery, changes, callback) {
        this.updateAsync(user, mailbox, messageQuery, changes).then(result => callback(null, result), callback);
    }

    /**
     * Builds the update fragment that brings every stored representation of the message date in sync
     *
     * Header lines are rebuilt from `mimeTree.header`, so changing the Date line also changes the size of
     * the resulting RFC822 message. The stored size is what IMAP reports as RFC822.SIZE and what quota
     * accounting is based on, so the caller must apply `sizeDelta` to the user quota as well.
     *
     * @param {Object} message Message document, should include `mimeTree.header`, `envelope` and `size`
     * @param {Date} sendTime New message date
     * @returns {Object} `{ update, sizeDelta }` where `update` is a $set fragment and `sizeDelta` is the
     *                   change of the stored message size in bytes
     */
    getMessageDateUpdate(message, sendTime) {
        let formattedDate = tools.formatDateHeader(sendTime);
        let dateHeader = `Date: ${formattedDate}`;
        let headerFound = false;
        let sizeDelta = 0;

        // map() returns a fresh array, the stored header list is not mutated
        let headers = ((message.mimeTree && message.mimeTree.header) || []).map(header => {
            if (!/^date\s*:/i.test(header)) {
                return header;
            }

            headerFound = true;
            sizeDelta += Buffer.byteLength(dateHeader, 'binary') - Buffer.byteLength(header, 'binary');
            return dateHeader;
        });

        if (!headerFound) {
            // header lines are joined with CRLF when the message is rebuilt
            sizeDelta += Buffer.byteLength(dateHeader, 'binary') + 2;
            headers.push(dateHeader);
        }

        let update = {
            hdate: sendTime,
            'mimeTree.header': headers,
            // parsed headers store the raw header value, not a Date object
            'mimeTree.parsedHeader.date': formattedDate
        };

        // the cached ENVELOPE response starts with the date value. Only rewrite it if the caller actually
        // loaded the envelope, replacing an unloaded one would leave the message with a 1 element ENVELOPE
        if (Array.isArray(message.envelope) && message.envelope.length) {
            let envelope = [].concat(message.envelope);
            envelope[0] = formattedDate;
            update.envelope = envelope;
        }

        if (typeof message.size === 'number' && sizeDelta) {
            update.size = message.size + sizeDelta;
        } else {
            // without a known starting size we can not keep the stored size correct, so leave quota alone as well
            sizeDelta = 0;
        }

        return { update, sizeDelta };
    }

    async _updateAsync(user, mailbox, messageQuery, changes) {
        let updates = { $set: {} };
        let update = false;
        let updateDate = false;
        let addFlags = [];
        let removeFlags = [];
        let updateLabels = false;
        let updateFlagsWithPipeline = false;
        let setLabelIds = null;
        let addLabelIds = [];
        let removeLabelIds = [];
        let markHam = changes && (changes.markHam === true || changes.flagged === true);

        let notifyEntries = [];

        if (changes && 'date' in changes) {
            // resolved before the change loop, as an invalid value must not half apply the update
            updateDate = changes.date instanceof Date ? changes.date : new Date(changes.date);
            if (updateDate.toString() === 'Invalid Date') {
                throw new Error('Invalid date value');
            }
        }

        Object.keys(changes || {}).forEach(key => {
            switch (key) {
                case 'seen':
                    updates.$set.unseen = !changes.seen;
                    if (changes.seen) {
                        addFlags.push('\\Seen');
                    } else {
                        removeFlags.push('\\Seen');
                    }
                    update = true;
                    break;

                case 'deleted':
                    updates.$set.undeleted = !changes.deleted;
                    if (changes.deleted) {
                        addFlags.push('\\Deleted');
                    } else {
                        removeFlags.push('\\Deleted');
                    }
                    update = true;
                    break;

                case 'flagged':
                    updates.$set.flagged = changes.flagged;
                    if (changes.flagged) {
                        addFlags.push('\\Flagged');
                    } else {
                        removeFlags.push('\\Flagged');
                    }
                    update = true;
                    break;

                case 'draft':
                    updates.$set.draft = changes.draft;
                    if (changes.draft) {
                        addFlags.push('\\Draft');
                    } else {
                        removeFlags.push('\\Draft');
                    }
                    update = true;
                    break;

                case 'expires':
                    if (changes.expires) {
                        updates.$set.exp = true;
                        updates.$set.rdate = changes.expires.getTime();
                    } else {
                        updates.$set.exp = false;
                        updates.$unset = updates.$unset || {};
                        updates.$unset.rdate = true;
                    }
                    updates.$unset = updates.$unset || {};
                    updates.$unset.retention = true;
                    update = true;
                    break;

                case 'metaData':
                    updates.$set['meta.custom'] = changes.metaData;
                    update = true;
                    break;

                case 'labels':
                    updateLabels = true;
                    setLabelIds = changes._labelIds || [];
                    update = true;
                    break;

                case 'addLabels':
                    updateLabels = true;
                    addLabelIds.push(...(changes._addLabelIds || []));
                    update = true;
                    break;

                case 'removeLabels':
                    updateLabels = true;
                    removeLabelIds.push(...(changes._removeLabelIds || []));
                    update = true;
                    break;

                case 'date':
                    // the actual fields are resolved per message in getMessageDateUpdate
                    update = true;
                    break;
            }
        });

        if (!update && !markHam) {
            let err = new Error('Nothing was changed');
            err.responseCode = 400;
            err.code = 'NothingChanged';
            throw err;
        }

        updateFlagsWithPipeline = updateLabels || (addFlags.length > 0 && removeFlags.length > 0);

        const applyFlagChanges = flags => {
            let updatedFlags = [...(flags ?? [])];

            if (removeFlags.length) {
                const removed = new Set(removeFlags);
                updatedFlags = updatedFlags.filter(flag => !removed.has(flag));
            }

            if (addFlags.length) {
                updatedFlags = [...new Set([...updatedFlags, ...addFlags])];
            }

            return updatedFlags;
        };

        const applyLabelChanges = labels => {
            let updatedLabels = setLabelIds === null ? [...(labels || [])] : [...setLabelIds];
            if (removeLabelIds.length) {
                const removed = new Set(removeLabelIds.map(id => id.toString()));
                updatedLabels = updatedLabels.filter(id => !removed.has(id.toString()));
            }
            if (addLabelIds.length) {
                updatedLabels = [...new Map([...updatedLabels, ...addLabelIds].map(id => [id.toString(), id])).values()];
            }
            return updatedLabels;
        };

        if (updateFlagsWithPipeline) {
            let flagsBase = removeFlags.length
                ? {
                      $filter: {
                          input: { $ifNull: ['$flags', []] },
                          as: 'flag',
                          cond: { $not: { $in: ['$$flag', { $literal: removeFlags }] } }
                      }
                  }
                : { $ifNull: ['$flags', []] };
            if (addFlags.length || removeFlags.length) {
                updates.$set.flags = { $setUnion: [flagsBase, { $literal: addFlags }] };
            }

            if (updateLabels) {
                let labelBase = setLabelIds === null ? { $ifNull: ['$labels', []] } : { $literal: setLabelIds };
                if (removeLabelIds.length) {
                    labelBase = {
                        $filter: {
                            input: labelBase,
                            as: 'label',
                            cond: { $not: { $in: ['$$label', { $literal: removeLabelIds }] } }
                        }
                    };
                }
                updates.$set.labels = { $setUnion: [labelBase, { $literal: addLabelIds }] };
            }
        } else {
            if (addFlags.length) {
                updates.$addToSet = {
                    flags: { $each: addFlags }
                };
            }

            if (removeFlags.length) {
                updates.$pull = {
                    flags: { $in: removeFlags }
                };
            }
        }

        let mailboxQuery = {
            _id: mailbox,
            user
        };

        let mailboxData;
        if (!update) {
            mailboxData = await this.database.collection('mailboxes').findOne(mailboxQuery);
        } else {
            // acquire new MODSEQ
            let item = await this.database.collection('mailboxes').findOneAndUpdate(
                mailboxQuery,
                {
                    $inc: {
                        // allocate new MODSEQ value
                        modifyIndex: 1
                    }
                },
                {
                    returnDocument: 'after'
                }
            );
            mailboxData = item && item.value;
        }

        if (!mailboxData) {
            throw mailboxMissingError();
        }

        if (update) {
            updates.$set.modseq = mailboxData.modifyIndex;
        }

        let updatedCount = 0;
        let sizeDelta = 0;
        let markHamEntries = [];
        let messageProjection = {
            _id: true,
            uid: true,
            flags: true,
            labels: true
        };

        if (updateDate) {
            messageProjection.envelope = true;
            messageProjection.size = true;
            messageProjection['mimeTree.header'] = true;
        }

        let activeLabelNamesById = changes._labelNamesById;
        const loadActiveLabelNames = async () => {
            if (!update) {
                activeLabelNamesById = new Map();
                return;
            }
            if (activeLabelNamesById) {
                return;
            }
            const labelIds = await this.database
                .collection('messages')
                .distinct('labels', { mailbox: mailboxData._id, uid: messageQuery }, { maxTimeMS: consts.DB_MAX_TIME_MESSAGES });
            activeLabelNamesById = labelIds.length ? (await getLabelMaps(this.database, mailboxData.user, { ids: labelIds })).byId : new Map();
        };

        let bulk_batch_size = consts.BULK_BATCH_SIZE;
        await Promise.all([
            this.settingsHandler
                .get('const:max:bulk_batch_size', {})
                .then(set_bulk_batch_size => {
                    bulk_batch_size = set_bulk_batch_size;
                })
                .catch(() => false),
            loadActiveLabelNames()
        ]);

        const publishMarkHamEntries = async () => {
            if (!markHamEntries.length) {
                return;
            }

            let entries = markHamEntries;
            markHamEntries = [];

            await Promise.all(
                entries.map(entry =>
                    publish(this.redis, {
                        ev: MARKED_HAM,
                        user: mailboxData.user.toString(),
                        mailbox: mailboxData._id.toString(),
                        message: entry.message.toString(),
                        id: entry.uid
                    })
                )
            );
        };

        const flushUpdates = async () => {
            if (notifyEntries.length) {
                try {
                    await this.notifier.addEntriesAsync(mailboxData, notifyEntries);
                } catch {
                    // the messages are updated, only the journal entries are missing
                }
                notifyEntries = [];
                this.notifier.fire(mailboxData.user);
            }

            await publishMarkHamEntries();
        };

        const markMessageHam = messageData => {
            if (markHam) {
                markHamEntries.push({
                    uid: messageData.uid,
                    message: messageData._id
                });
            }
        };

        let cursor = this.database
            .collection('messages')
            .find({
                mailbox: mailboxData._id,
                uid: messageQuery
            })
            .project(messageProjection);

        try {
            for await (let messageData of cursor) {
                if (!update) {
                    updatedCount++;
                    markMessageHam(messageData);

                    if (markHamEntries.length >= bulk_batch_size) {
                        await flushUpdates();
                    }
                    continue;
                }

                let messageUpdates = updates;
                let messageSizeDelta = 0;
                if (updateDate) {
                    let dateUpdate = this.getMessageDateUpdate(messageData, updateDate);
                    messageSizeDelta = dateUpdate.sizeDelta;
                    messageUpdates = {
                        ...updates,
                        $set: {
                            ...updates.$set,
                            ...dateUpdate.update
                        }
                    };
                }

                let updatedSize = messageUpdates.$set.size;

                if (updateFlagsWithPipeline) {
                    // Pipeline form allows the flags update to refer to the current $flags value.
                    let pipelineSet = {};
                    for (let [key, value] of Object.entries(messageUpdates.$set)) {
                        pipelineSet[key] = ['flags', 'labels'].includes(key) ? value : { $literal: value };
                    }
                    let updatePipeline = [{ $set: pipelineSet }];
                    if (messageUpdates.$unset) {
                        updatePipeline.push({ $unset: Object.keys(messageUpdates.$unset) });
                    }
                    messageUpdates = updatePipeline;
                }

                let item = await this.database.collection('messages').findOneAndUpdate(
                    {
                        _id: messageData._id,
                        // hash key
                        mailbox,
                        uid: messageData.uid
                    },
                    messageUpdates,
                    {
                        projection: {
                            _id: true,
                            uid: true,
                            thread: true,
                            flags: true,
                            labels: true
                        },
                        returnDocument: 'before'
                    }
                );

                if (!item || !item.value) {
                    continue;
                }

                const previousMessageData = item.value;
                const updatedMessageData = {
                    ...previousMessageData,
                    flags: applyFlagChanges(previousMessageData.flags),
                    labels: applyLabelChanges(previousMessageData.labels)
                };

                const oldLabels = new Set(labelNamesForMessage(previousMessageData, activeLabelNamesById));
                const newLabels = new Set(labelNamesForMessage(updatedMessageData, activeLabelNamesById));
                const messageWasSeen = (previousMessageData.flags ?? []).includes('\\Seen');
                const messageIsSeen = (updatedMessageData.flags ?? []).includes('\\Seen');
                const messageWasFlagged = (previousMessageData.flags ?? []).includes('\\Flagged');
                const messageIsFlagged = (updatedMessageData.flags ?? []).includes('\\Flagged');

                const addedLabels = [...newLabels].filter(label => !oldLabels.has(label));
                const removedLabels = [...oldLabels].filter(label => !newLabels.has(label));

                updatedCount++;
                sizeDelta += messageSizeDelta;

                let notifyEntry = {
                    command: 'FETCH',
                    uid: updatedMessageData.uid,
                    flags: getMessageImapFlags(updatedMessageData, activeLabelNamesById),
                    addedLabels,
                    removedLabels,
                    thread: updatedMessageData.thread,
                    message: updatedMessageData._id,
                    unseenChange: messageWasSeen !== messageIsSeen
                };

                if (notifyEntry.unseenChange && newLabels.size) {
                    notifyEntry.labels = [...newLabels];
                }

                if (messageWasFlagged !== messageIsFlagged) {
                    notifyEntry.flaggedChangedTo = messageIsFlagged;
                }

                if (updateDate) {
                    // carried over to the search index, which otherwise only tracks flag changes
                    notifyEntry.hdate = updateDate;
                    if (typeof updatedSize === 'number') {
                        notifyEntry.size = updatedSize;
                    }
                }

                notifyEntries.push(notifyEntry);

                markMessageHam(updatedMessageData);

                if (notifyEntries.length >= bulk_batch_size || markHamEntries.length >= bulk_batch_size) {
                    await flushUpdates();
                }
            }
        } finally {
            await cursor.close().catch(() => false);

            // pending entries are reported even if the update stopped early
            try {
                await flushUpdates();
            } catch {
                // ignore
            }
        }

        if (sizeDelta) {
            // rewriting the Date header changed the size of the stored messages
            try {
                await this.updateQuotaAsync(user, { storageUsed: sizeDelta, mailbox: mailboxData._id, mailboxPath: mailboxData.path }, {});
            } catch (err) {
                this.loggelf({
                    short_message: '[QUOTAFAIL] Failed to adjust storageUsed after a message date update',
                    _mail_action: 'quota',
                    _user: user.toString(),
                    _mailbox: mailboxData._id.toString(),
                    _inc: sizeDelta,
                    _error: err.message
                });
            }
        }

        return updatedCount;
    }

    createIntro(text) {
        // regexes
        let intro = text
            // assume we get the intro text from first 2 kB
            .substr(0, 2 * 1024)
            // remove markdown urls
            .replace(/\[[^\]]*\]/g, ' ')
            // remove quoted parts
            // "> quote from previous message"
            .replace(/^>.*$/gm, '')
            // remove lines with repetitive chars
            // "---------------------"
            .replace(/^\s*(.)\1+\s*$/gm, '')
            // join lines
            .replace(/\s+/g, ' ')
            .trim();

        if (intro.length > 128) {
            intro = intro.substr(0, 128);
            let lastSp = intro.lastIndexOf(' ');
            if (lastSp > 0) {
                intro = intro.substr(0, lastSp);
            }
            intro = intro + '…';
        }

        return intro;
    }

    /**
     * Rebuilds a message from its mimeTree, encrypts it, prepares the
     * encrypted result, stores node bodies.
     *
     * This function should only be used during a move or copy, where original mail is not available.
     *
     * @param {object} mimeTree - parsed MIME tree of the message
     * @param {object} encryptionKey - { type: 'pgp', key } or { type: 'smime', certs, cipher }
     * @returns {Promise<{prepared, maildata, type}|false>} false when already encrypted or encryption fails
     */
    async encryptAndPrepareMessageAsync(mimeTree, encryptionKey) {
        if (MessageHandler.isMessageEncrypted(this._getContentType(mimeTree))) return false;

        // Rebuild raw from mimeTree
        // the rebuilt message replaces the stored one, it must not lose an attachment that can not be read
        let outputStream = this.indexer.rebuild(mimeTree, false, { strict: true });
        if (!outputStream || outputStream.type !== 'stream' || !outputStream.value) {
            throw new Error('Cannot fetch message');
        }

        let raw = await new Promise((resolve, reject) => {
            let chunks = [];
            let chunklen = 0;
            outputStream.value
                .on('data', chunk => {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                })
                .on('end', () => resolve(Buffer.concat(chunks, chunklen)))
                .on('error', reject);
        });

        let encryptResult = await this.encryptMessageAsync(encryptionKey, raw);
        if (!encryptResult) return false;

        let prepared = await this.prepareMessageAsync({ raw: encryptResult.raw });
        let maildata = this.indexer.getMaildata(prepared.mimeTree);

        await new Promise((resolve, reject) => {
            this.indexer.storeNodeBodies(maildata, prepared.mimeTree, async err => {
                if (err) {
                    let ids = Object.keys(prepared.mimeTree.attachmentMap || {}).map(k => prepared.mimeTree.attachmentMap[k]);
                    if (ids.length) {
                        try {
                            await this.attachmentStorage.deleteManyAsync(ids, maildata.magic);
                        } catch {
                            // ignore cleanup error
                        }
                    }
                    return reject(err);
                }
                resolve();
            });
        });

        return { prepared, maildata, type: encryptResult.type };
    }

    /** @deprecated Use encryptMessageAsync() directly. Kept for external consumers (zonemta-wildduck). */
    encryptMessage(encryptionKey, raw, callback) {
        if (typeof encryptionKey === 'string') {
            encryptionKey = { type: 'pgp', key: encryptionKey };
        }
        this.encryptMessageAsync(encryptionKey, raw)
            .then(res => callback(null, res ? res.raw : false))
            .catch(err => callback(err));
    }

    async encryptMessageAsync(encryptionKey, raw) {
        if (!encryptionKey) {
            return false;
        }

        if (raw && Array.isArray(raw.chunks) && raw.chunklen) {
            raw = Buffer.concat(raw.chunks, raw.chunklen);
        }

        let breakPos = raw.indexOf('\r\n\r\n');
        if (breakPos < 0) {
            breakPos = raw.length;
        }
        let headers = new Headers(raw.subarray(0, breakPos + 4));

        let ct = headers.getFirst('content-type');
        if (MessageHandler.isMessageEncrypted(ct)) {
            log.info('ENCRYPT', 'Message already encrypted (content-type: %s), skipping', ct);
            return false;
        }

        let result;
        if (encryptionKey.type === 'smime') {
            result = await this._encryptSmimeAsync(encryptionKey, headers, raw);
        } else if (encryptionKey.type === 'pgp') {
            result = await this._encryptPgpAsync(encryptionKey.key, headers, raw);
        } else {
            log.verbose('ENCRYPT', 'Unknown encryption type: %s', encryptionKey.type);
        }

        if (result && Buffer.isBuffer(raw)) {
            raw.fill(0);
        }

        return result;
    }

    _extractOuterHeaders(headers) {
        let outerLines = [];
        for (let entry of headers.getList()) {
            if (entry.key === 'mime-version') {
                continue;
            }
            if (OUTER_HEADER_NAMES.includes(entry.key)) {
                outerLines.push(entry.line);
            }
        }
        outerLines.unshift('MIME-Version: 1.0');
        return outerLines;
    }

    async _encryptPgpAsync(pubKeyArmored, headers, raw) {
        let outerLines = this._extractOuterHeaders(headers);

        let boundary = 'nm_' + crypto.randomBytes(14).toString('hex');
        outerLines.push('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="' + boundary + '"');
        outerLines.push('Content-Description: OpenPGP encrypted message');
        outerLines.push('Content-Transfer-Encoding: 7bit');

        if (!pubKeyArmored) {
            log.error('PGP', 'No PGP public key configured');
            this.loggelf({
                short_message: '[ENCRYPTFAIL] No PGP public key configured',
                _mail_action: 'encrypt_fail',
                _error: 'No PGP public key',
                _source: 'pgp_encrypt'
            });
            return false;
        }

        let pubKey;
        try {
            pubKey = await openpgp.readKey({ armoredKey: tools.prepareArmoredPubKey(pubKeyArmored), config: { tolerant: true } });
        } catch (err) {
            log.error('PGP', 'Failed to parse PGP public key: %s', err.message);
            this.loggelf({
                short_message: '[ENCRYPTFAIL] PGP public key parse error',
                _mail_action: 'encrypt_fail',
                _error: 'Parse error: ' + err.message,
                _source: 'pgp_encrypt'
            });
            return false;
        }
        if (!pubKey) {
            log.error('PGP', 'PGP public key parsing returned empty result');
            this.loggelf({
                short_message: '[ENCRYPTFAIL] PGP public key parsed but empty',
                _mail_action: 'encrypt_fail',
                _error: 'Key parsed but result was empty',
                _source: 'pgp_encrypt'
            });
            return false;
        }

        let ciphertext;
        try {
            ciphertext = await openpgp.encrypt({
                message: await openpgp.createMessage({ binary: raw }),
                encryptionKeys: pubKey,
                format: 'armored',
                config: { minRSABits: 2048 }
            });
        } catch (err) {
            log.error('PGP', 'PGP encryption failed: %s', err.message);
            this.loggelf({
                short_message: '[ENCRYPTFAIL] PGP encryption failed',
                _mail_action: 'encrypt_fail',
                _error: err.message,
                _source: 'pgp_encrypt'
            });
            return false;
        }

        let bodyLines = [
            'This is an OpenPGP/MIME encrypted message',
            '',
            '--' + boundary,
            'Content-Type: application/pgp-encrypted',
            'Content-Transfer-Encoding: 7bit',
            '',
            'Version: 1',
            '',
            '--' + boundary,
            'Content-Type: application/octet-stream; name="encrypted.asc"',
            'Content-Disposition: inline; filename="encrypted.asc"',
            'Content-Transfer-Encoding: 7bit',
            '',
            ciphertext,
            '--' + boundary + '--',
            ''
        ];

        return { type: 'pgp', raw: Buffer.from(outerLines.join('\r\n') + '\r\n\r\n' + bodyLines.join('\r\n')) };
    }

    async _encryptSmimeAsync(smimeKey, headers, raw) {
        let certs = smimeKey.certs;
        let cipher = smimeKey.cipher || consts.SMIME_DEFAULT_CIPHER;
        let keyTransport = smimeKey.keyTransport || consts.SMIME_DEFAULT_RSA_KEY_TRANSPORT;

        if (!SMIMEEncryptor.CIPHERS.includes(cipher)) {
            log.error('SMIME', 'Unknown cipher %s, must be one of %s', cipher, SMIMEEncryptor.CIPHERS.join(', '));
            this.loggelf({
                short_message: '[ENCRYPTFAIL] Unknown S/MIME cipher: ' + cipher,
                _mail_action: 'encrypt_fail',
                _error: 'Unknown cipher ' + cipher,
                _source: 'smime_encrypt'
            });
            return false;
        }

        if (!SMIMEEncryptor.RSA_KEY_TRANSPORTS.includes(keyTransport)) {
            log.error('SMIME', 'Unknown keyTransport %s, must be one of %s', keyTransport, SMIMEEncryptor.RSA_KEY_TRANSPORTS.join(', '));
            this.loggelf({
                short_message: '[ENCRYPTFAIL] Unknown S/MIME keyTransport: ' + keyTransport,
                _mail_action: 'encrypt_fail',
                _error: 'Unknown keyTransport ' + keyTransport,
                _source: 'smime_encrypt'
            });
            return false;
        }

        if (!certs || !certs.length) {
            log.error('SMIME', 'No S/MIME certificates configured');
            this.loggelf({
                short_message: '[ENCRYPTFAIL] No S/MIME certificates configured',
                _mail_action: 'encrypt_fail',
                _error: 'No certificates configured',
                _source: 'smime_encrypt'
            });
            return false;
        }

        // Validate and filter certificates before either encryption path
        let validCerts = [];
        for (let pem of certs) {
            try {
                SMIMEEncryptor.validateCertKey(pem);
                validCerts.push(pem);
            } catch (err) {
                log.warn('SMIME', 'Skipping certificate (%d of %d): %s', certs.indexOf(pem) + 1, certs.length, err.message);
            }
        }

        if (!validCerts.length) {
            log.error('SMIME', 'All %d S/MIME certificate(s) failed validation', certs.length);
            this.loggelf({
                short_message: '[ENCRYPTFAIL] All S/MIME certificates failed validation',
                _mail_action: 'encrypt_fail',
                _error: 'All ' + certs.length + ' certificate(s) failed validation',
                _source: 'smime_encrypt'
            });
            return false;
        }

        let cipherConfig = {
            'AES-CBC': { fn: SMIMEEncryptor.encryptCBC, smimeType: 'enveloped-data' },
            'AES-GCM': { fn: SMIMEEncryptor.encryptGCM, smimeType: 'authEnveloped-data' }
        }[cipher];
        let encryptFn = cipherConfig.fn;
        let smimeType = cipherConfig.smimeType;

        let derEncoded;
        try {
            derEncoded = await encryptFn(validCerts, raw, { keyTransport });
        } catch (err) {
            log.error('SMIME', '%s encryption failed: %s', cipher, err.message);
            this.loggelf({
                short_message: '[ENCRYPTFAIL] ' + cipher + ' encryption failed',
                _mail_action: 'encrypt_fail',
                _error: err.message,
                _source: 'smime_encrypt'
            });
            return false;
        }
        if (!derEncoded) {
            log.error('SMIME', '%s encryption returned no result', cipher);
            this.loggelf({
                short_message: '[ENCRYPTFAIL] ' + cipher + ' encryption returned no result',
                _mail_action: 'encrypt_fail',
                _error: 'No result from ' + cipher,
                _source: 'smime_encrypt'
            });
            return false;
        }

        let b64Encoded = Buffer.from(derEncoded).toString('base64');
        let linePattern = new RegExp(`.{1,${TARGET_LINE_LENGTH}}`, 'g');
        let wrappedB64 = (b64Encoded.match(linePattern) || [b64Encoded]).join('\r\n');

        let outerLines = this._extractOuterHeaders(headers);
        outerLines.push(`Content-Type: application/pkcs7-mime; smime-type=${smimeType}; name=smime.p7m`);
        outerLines.push('Content-Transfer-Encoding: base64');
        outerLines.push('Content-Disposition: attachment; filename=smime.p7m');

        return { type: 'smime', raw: Buffer.from(outerLines.join('\r\n') + '\r\n\r\n' + wrappedB64 + '\r\n') };
    }

    async moveDone(err, data, options) {
        let { sourceUid, existsEntries, mailboxData, removeEntries, targetData, destinationUid } = data;

        // when the destination is the selected mailbox every moved message already produced its own
        // EXISTS below, so the summary would only repeat the same count
        let destinationIsSelected = tools.isSelectedMailbox(options.session, targetData._id);

        // Show Expunged
        if (options.session && sourceUid.length && options.showExpunged && !destinationIsSelected) {
            options.session.writeStream.write({
                tag: '*',
                command: String(options.session.selected.uidList.length),
                attributes: [
                    {
                        type: 'atom',
                        value: 'EXISTS'
                    }
                ]
            });
        }

        if (existsEntries.length) {
            await this.journalMove(mailboxData, removeEntries, targetData, existsEntries);
        }

        if (err) {
            throw err;
        }

        // RFC 6851 4.4: if at least one message was moved, the updated per-mailbox modification
        // sequence of the source mailbox has to be reported back to the client
        let highestModseq = false;
        if (sourceUid.length) {
            let updatedMailbox = await this.database.collection('mailboxes').findOne({ _id: mailboxData._id }, { projection: { modifyIndex: true } });
            highestModseq = (updatedMailbox && updatedMailbox.modifyIndex) || false;
        }

        return {
            result: true,
            info: {
                uidValidity: targetData.uidValidity,
                sourceUid,
                destinationUid,
                highestModseq,
                mailbox: mailboxData._id,
                target: targetData._id,
                status: 'moved'
            }
        };
    }

    async updateMessage(data, cursor, options) {
        let r;

        let {
            message,
            targetData,
            sourceUid,
            destinationUid,
            mailboxData,
            existsEntries,
            removeEntries,
            messageId,
            messageUid,
            unseen,
            flagged,
            labels,
            destinationLabels,
            uidNext,
            junk,
            bulk_batch_size,
            encryptedInsertCleanup
        } = data;

        // Release the newly encrypted bodies only when the insert didn't store the doc. Never after a
        // successful insert (e.g. a later source-delete failure): the destination is then live and owns them.
        let releaseEncryptedInsertRefs = async () => {
            if (!encryptedInsertCleanup || !encryptedInsertCleanup.newAttachmentIds || !encryptedInsertCleanup.newAttachmentIds.length) {
                return;
            }
            try {
                await this.attachmentStorage.deleteManyAsync(encryptedInsertCleanup.newAttachmentIds, encryptedInsertCleanup.newMagic);
            } catch (err) {
                log.error(
                    'MOVE',
                    'Failed to release encrypted attachments after failed destination insert (source=imap_move code=%s): %s',
                    err.code || 'AttachmentReleaseError',
                    err.message
                );
                this.loggelf({
                    short_message: '[MOVEATTACHFAIL] Failed to release encrypted attachments after failed destination insert',
                    _mail_action: 'move_attach_fail',
                    _user: mailboxData.user,
                    _mailbox: targetData._id,
                    _mailbox_path: targetData.path,
                    _error: err.message,
                    _code: err.code || 'AttachmentReleaseError',
                    _source: 'imap_move'
                });
            }
        };

        try {
            r = await this.database.collection('messages').insertOne(message, { writeConcern: 'majority' });

            if (!r || !r.acknowledged) {
                let err = new Error('Failed to store message [2]');
                err.responseCode = 500;
                err.code = 'StoreError';

                await releaseEncryptedInsertRefs();
                await cursor.close();
                return this.moveDone(err, { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries }, options); // will throw
            }
        } catch (err) {
            // only release the references of a copy that is not there, see storedDespiteError()
            if ((await this.storedDespiteError(message._id)) === false) {
                await releaseEncryptedInsertRefs();
            }
            await cursor.close();
            return this.moveDone(err, { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries }, options); // will throw
        }

        let insertId = r.insertedId;

        // delete old message
        let deleteMessageRes;

        try {
            deleteMessageRes = await this.database.collection('messages').deleteOne(
                {
                    _id: messageId,
                    mailbox: mailboxData._id,
                    uid: messageUid
                },
                { writeConcern: 'majority' }
            );
        } catch (err) {
            await cursor.close();
            return this.moveDone(err, { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries }, options); // will throw
        }

        if (deleteMessageRes && deleteMessageRes.deletedCount) {
            if (options.session) {
                options.session.writeStream.write(options.session.formatResponse('EXPUNGE', sourceUid));
            }

            // no modseq here on purpose: the entries are journaled in batches and addEntries() gives
            // each batch its own modseq. Sharing one modseq across batches makes every batch after the
            // first invisible to other sessions, because getUpdates() selects on modseq > modifyIndex
            removeEntries.push({
                command: 'EXPUNGE',
                ignore: options.session && options.session.id,
                uid: messageUid,
                message: messageId,
                thread: message.thread,
                unseen,
                flagged,
                labels
            });

            if (options.session && options.showExpunged) {
                options.session.writeStream.write(options.session.formatResponse('EXPUNGE', messageUid));
            }
        }

        let entry = {
            command: 'EXISTS',
            uid: uidNext,
            // this session is told about the new message below, as APPEND and COPY do
            ignore: options.session?.id,
            message: insertId,
            unseen: message.unseen,
            flagged: (message.flags ?? []).includes('\\Flagged'),
            labels: destinationLabels,
            idate: message.idate,
            thread: message.thread
        };
        if (junk) {
            entry.junk = junk;
        }
        if (options.updates && (options.updates.markHam === true || options.updates.flagged === true)) {
            entry.markHam = true;
        }
        existsEntries.push(entry);

        // RFC 3501 5.2: a mailbox size change observed while processing a command has to be reported.
        // The notifier would only reach this session on a later command
        if (tools.isSelectedMailbox(options.session, targetData._id)) {
            options.session.writeStream.write(options.session.formatResponse('EXISTS', uidNext));
        }

        if (existsEntries.length >= bulk_batch_size) {
            await this.journalMove(mailboxData, removeEntries, targetData, existsEntries);
            removeEntries.length = 0; // Clear top-level argument array, setting length to 0 clears array object
            existsEntries.length = 0;
        }
        return true;
    }

    /**
     * Journals a batch of moved messages: deleted from the source mailbox, added to the
     * target mailbox. The messages are moved already, so journal failures are ignored
     */
    async journalMove(mailboxData, removeEntries, targetData, existsEntries) {
        try {
            // mark messages as deleted from old mailbox
            await this.notifier.addEntriesAsync(mailboxData, removeEntries);
        } catch {
            // ignore
        }
        try {
            // mark messages as added to new mailbox
            await this.notifier.addEntriesAsync(targetData, existsEntries);
        } catch {
            // ignore
        }
        this.notifier.fire(mailboxData.user);
    }
}

module.exports = MessageHandler;
