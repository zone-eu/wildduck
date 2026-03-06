'use strict';

const crypto = require('crypto');
const { randomUUID: uuid } = require('crypto');
const ObjectId = require('mongodb').ObjectId;
const Indexer = require('../imap-core/lib/indexer/indexer');
const ImapNotifier = require('./imap-notifier');
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
const SMIMEEncryptor = require('./smime');
const { htmlToText } = require('html-to-text');
const { Headers } = require('@zone-eu/mailsplit');

// index only the following headers for SEARCH
const INDEXED_HEADERS = ['to', 'cc', 'subject', 'from', 'sender', 'reply-to', 'message-id', 'thread-index', 'list-id', 'delivered-to'];
const DISALLOWED_HEADERS_FOR_ADDRESS_REGISTER = ['list-id', 'auto-submitted', 'x-auto-response-suppress'];

openpgp.config.commentstring = 'Plaintext message encrypted by WildDuck Mail Server';
openpgp.config.versionString = `WildDuck v${packageData.version}`;

// Headers duplicated on the outer envelope for UX/UI purposes (like BIMI-* or Subject).
// Non-listed headers will only reside in the encrypted body for privacy.
const OUTER_HEADER_NAMES = ['date', 'subject', 'from', 'to', 'message-id', 'mime-version', 'bimi-location', 'bimi-indicator', 'authentication-results'];

// RFC 2045 §6.8: base64-encoded lines MUST be no longer than 76 characters.
const TARGET_LINE_LENGTH = 76;

class MessageHandler {
    constructor(options) {
        this.database = options.database;
        this.redis = options.redis;

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
            pushOnly: true
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

        this.settingsHandler = new SettingsHandler({ db: this.database });
    }

    /**
     * Checks whether a message is already encrypted (PGP or S/MIME).
     * @param {string} contentTypeHeader - Full Content-Type header value (e.g. "multipart/encrypted; ...")
     * @returns {boolean}
     */
    isMessageEncrypted(contentTypeHeader) {
        if (!contentTypeHeader) return false;
        let ct = contentTypeHeader.split(';').shift().trim().toLowerCase();
        if (ct === 'multipart/encrypted') return true;
        return ct === 'application/pkcs7-mime' && /smime-type\s*=\s*(?:auth)?enveloped-data/i.test(contentTypeHeader);
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
                    let err = new Error('Mailbox is missing');
                    err.imapResponse = 'TRYCREATE';
                    throw err;
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
                    let err = new Error('Mailbox is missing');
                    err.imapResponse = 'TRYCREATE';
                    throw err;
                }

                return mailboxData;
            }

            let err = new Error('Mailbox is missing');
            err.imapResponse = 'TRYCREATE';
            throw err;
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

    // Monster method for inserting new messages to a mailbox
    async addAsync(options) {
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
            ? this.isMessageEncrypted(this._getContentType(prepared.mimeTree))
            : this.isMessageEncrypted(this._getContentType(options.raw));

        let flags = Array.isArray(options.flags) ? options.flags : [].concat(options.flags || []);

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
                log.error('ENCRYPT', 'Encryption returned false for user %s, message stored unencrypted (source: add)', userData._id);
                this.loggelf({
                    short_message: '[ENCRYPTSKIP] Encryption returned false during message add',
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

            // if true then expires after rdate + retention
            exp: !!mailboxData.retention,
            rdate: Date.now() + (mailboxData.retention || 0),

            // make sure the field exists. it is set to true when user is deleted
            userDeleted: false,

            idate,
            hdate,
            flags,
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
            messageData.intro = this.createIntro(htmlToText(messageData.html.join('')));
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
                _mailbox: mailboxData._id
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
            let err = new Error('Mailbox is missing');
            err.imapResponse = 'TRYCREATE';
            return rollback(err);
        }

        mailboxData = item.value;

        // updated message object by setting mailbox specific values
        messageData.mailbox = mailboxData._id;
        messageData.user = mailboxData.user;
        messageData.uid = mailboxData.uidNext;
        messageData.modseq = mailboxData.modifyIndex + 1;

        if (!flags.includes('\\Deleted')) {
            messageData.searchable = true;
        }

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
            return rollback(err);
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

        const finishFunc = // finishFunc:
            async () =>
                new Promise(resolve => {
                    this.notifier.addEntries(
                        mailboxData,
                        {
                            command: 'EXISTS',
                            uid: messageData.uid,
                            ignore: options.session && options.session.id,
                            message: messageData._id,
                            modseq: messageData.modseq,
                            unseen: messageData.unseen,
                            idate: messageData.idate,
                            thread: messageData.thread
                        },
                        () => {
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

                            // do not use more suitable finally as it is not supported in Node v8
                            processAudits()
                                .then(() => resolve(cleanupRes))
                                .catch(() => resolve(cleanupRes));
                        }
                    );
                });

        if (
            options.session &&
            options.session.selected &&
            options.session.selected.mailbox &&
            options.session.selected.mailbox.toString() === mailboxData._id.toString()
        ) {
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
                _mailbox: inc.mailbox
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
        let messageData = options.messageData;
        let curtime = new Date();
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
                    _uid: messageData.uid,
                    _stored_id: messageData._id,
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
                    mailbox: messageData.mailbox
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

        if (
            options.session &&
            options.session.selected &&
            options.session.selected.mailbox &&
            options.session.selected.mailbox.toString() === mailboxData._id.toString()
        ) {
            options.session.writeStream.write(options.session.formatResponse('EXPUNGE', messageData.uid));
        }

        try {
            await new Promise((resolve, reject) => {
                this.notifier.addEntries(
                    mailboxData,
                    {
                        command: 'EXPUNGE',
                        ignore: options.session && options.session.id,
                        uid: messageData.uid,
                        message: messageData._id,
                        unseen: messageData.unseen,
                        thread: messageData.thread
                    },
                    err => {
                        if (err) {
                            return reject(err);
                        }
                        resolve();
                    }
                );
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
        // concurrent promises
        const [mailboxData, targetData] = await Promise.all([this.getMailboxAsync(options.source), this.getMailboxAsync(options.destination)]);

        const item = await this.database.collection('mailboxes').findOneAndUpdate(
            {
                _id: mailboxData._id
            },
            {
                $inc: {
                    // increase the mailbox modification index
                    // to indicate that something happened
                    modifyIndex: 1
                }
            },
            {
                returnDocument: 'after',
                projection: {
                    _id: true,
                    uidNext: true,
                    modifyIndex: true
                }
            }
        );

        let newModseq = (item && item.value && item.value.modifyIndex) || 1;

        let cursor = this.database
            .collection('messages')
            .find({
                mailbox: mailboxData._id,
                uid: options.messageQuery ? options.messageQuery : tools.checkRangeQuery(options.messages)
            })
            // ordering is needed for IMAP UIDPLUS results
            .sort({ uid: 1 });

        let sourceUid = [];
        let destinationUid = [];

        let removeEntries = [];
        let existsEntries = [];

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

            // retention settings
            message.exp = !!targetData.retention;
            message.rdate = Date.now() + (targetData.retention || 0);
            message.modseq = modifyIndex; // reset message modseq to whatever it is for the mailbox right now

            let unseen = message.unseen;

            if (!message.flags.includes('\\Deleted')) {
                message.searchable = true;
            } else {
                delete message.searchable;
            }

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
                            } else {
                                message.exp = false;
                            }
                        }
                        break;

                    case 'metaData':
                        message.meta = message.meta || {};
                        message.meta.custom = options.updates.metaData;
                        break;

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

            const bulk_batch_size = await this.settingsHandler.get('const:max:bulk_batch_size', {});

            if (!this.isMessageEncrypted(this._getContentType(message.mimeTree))) {
                // check if encryption is needed (user-level or mailbox-level)
                let res;
                try {
                    res = await this.users.collection('users').findOne({ _id: mailboxData.user });
                } catch (err) {
                    return this.moveDone(err, { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries }, options);
                }

                let encryptionKey = res && (res.encryptMessages || targetData.encryptMessages) ? tools.getUserEncryptionKey(res) : false;
                if (encryptionKey) {
                    try {
                        let result = await this.encryptAndPrepareMessageAsync(message.mimeTree, encryptionKey);
                        if (result) {
                            message.attachments = result.maildata.attachments || [];
                            message.ha = true;
                            delete message.text;
                            delete message.html;
                            message.intro = '';
                            message.mimeTree = result.prepared.mimeTree;
                            message.size = result.prepared.size;
                            message.bodystructure = result.prepared.bodystructure;
                            message.envelope = result.prepared.envelope;
                            message.headers = result.prepared.headers;
                        } else {
                            log.error('ENCRYPT', 'Encryption returned false for user %s, message stored unencrypted (source: move)', mailboxData.user);
                            this.loggelf({
                                short_message: '[ENCRYPTSKIP] Encryption returned false during IMAP MOVE',
                                _mail_action: 'encrypt_skip',
                                _user: mailboxData.user,
                                _source: 'imap_move'
                            });
                        }
                    } catch (err) {
                        return this.moveDone(err, { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries }, options);
                    }
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
                    newModseq,
                    uidNext,
                    junk,
                    bulk_batch_size
                },
                cursor,
                options
            );
        }
    }

    // NB! does not update user quota
    put(messageData, callback) {
        let getMailbox = next => {
            this.getMailbox({ mailbox: messageData.mailbox }, (err, mailboxData) => {
                if (err && err.imapResponse !== 'TRYCREATE') {
                    return callback(err);
                }

                if (mailboxData) {
                    return next(null, mailboxData);
                }

                this.getMailbox(
                    {
                        query: {
                            user: messageData.user,
                            path: 'INBOX'
                        }
                    },
                    next
                );
            });
        };

        getMailbox((err, mailboxData) => {
            if (err) {
                return callback(err);
            }

            this.database.collection('mailboxes').findOneAndUpdate(
                {
                    _id: mailboxData._id
                },
                {
                    $inc: {
                        uidNext: 1
                    }
                },
                {
                    uidNext: true
                },
                (err, item) => {
                    if (err) {
                        return callback(err);
                    }

                    if (!item || !item.value) {
                        return callback(new Error('Mailbox disappeared'));
                    }

                    let uidNext = item.value.uidNext;

                    // set new mailbox
                    messageData.mailbox = mailboxData._id;

                    // new mailbox means new UID
                    messageData.uid = uidNext;

                    // this will be changed later by the notification system
                    messageData.modseq = 0;

                    // retention settings
                    messageData.exp = !!mailboxData.retention;
                    messageData.rdate = Date.now() + (mailboxData.retention || 0);

                    if (!mailboxData.undeleted) {
                        delete messageData.searchable;
                    } else {
                        messageData.searchable = true;
                    }

                    let junk = false;
                    if (mailboxData.specialUse === '\\Junk' && !messageData.junk) {
                        messageData.junk = true;
                        junk = 1;
                    } else if (mailboxData.specialUse !== '\\Trash' && messageData.junk) {
                        delete messageData.junk;
                        junk = -1;
                    }

                    this.database.collection('messages').insertOne(messageData, { writeConcern: 'majority' }, (err, r) => {
                        if (err) {
                            if (err.code === 11000) {
                                // message already exists
                                return callback(null, false);
                            }
                            return callback(err);
                        }

                        if (!r || !r.acknowledged) {
                            let err = new Error('Failed to store message [3]');
                            err.responseCode = 500;
                            err.code = 'StoreError';
                            return callback(err);
                        }

                        let insertId = r.insertedId;

                        let entry = {
                            command: 'EXISTS',
                            uid: uidNext,
                            message: insertId,
                            unseen: messageData.unseen,
                            idate: messageData.idate,
                            thread: messageData.thread
                        };
                        if (junk) {
                            entry.junk = junk;
                        }
                        // mark messages as added to new mailbox
                        this.notifier.addEntries(mailboxData, entry, () => {
                            this.notifier.fire(mailboxData.user);
                            return callback(null, {
                                mailbox: mailboxData._id,
                                message: insertId,
                                uid: uidNext
                            });
                        });
                    });
                }
            );
        });
    }

    generateIndexedHeaders(headersArray) {
        // allow configuring extra header keys that are indexed
        return (headersArray || [])
            .map(line => {
                line = Buffer.from(line, 'binary').toString();

                let key = line.substr(0, line.indexOf(':')).trim().toLowerCase();

                if (!INDEXED_HEADERS.includes(key)) {
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
        let hdate = (mimeTree.parsedHeader.date && parseDate([].concat(mimeTree.parsedHeader.date || []).pop() || '', idate)) || false;

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
        }

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
                        subject: { $ifNull: ['$subject', subject] }
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

    update(user, mailbox, messageQuery, changes, callback) {
        let updates = { $set: {} };
        let update = false;
        let addFlags = [];
        let removeFlags = [];

        let notifyEntries = [];

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
                    updates.$set.flagged = changes.draft;
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
                    }
                    update = true;
                    break;

                case 'metaData':
                    updates.$set['meta.custom'] = changes.metaData;
                    update = true;
                    break;
            }
        });

        if (!update) {
            return callback(new Error('Nothing was changed'));
        }

        if (addFlags.length) {
            if (!updates.$addToSet) {
                updates.$addToSet = {};
            }
            updates.$addToSet.flags = { $each: addFlags };
        }

        if (removeFlags.length) {
            if (!updates.$pull) {
                updates.$pull = {};
            }
            updates.$pull.flags = { $in: removeFlags };
        }

        // acquire new MODSEQ
        this.database.collection('mailboxes').findOneAndUpdate(
            {
                _id: mailbox,
                user
            },
            {
                $inc: {
                    // allocate new MODSEQ value
                    modifyIndex: 1
                }
            },
            {
                returnDocument: 'after'
            },
            (err, item) => {
                if (err) {
                    return callback(err);
                }

                if (!item || !item.value) {
                    return callback(new Error('Mailbox is missing'));
                }

                let mailboxData = item.value;

                updates.$set.modseq = mailboxData.modifyIndex;

                let updatedCount = 0;
                let cursor = this.database
                    .collection('messages')
                    .find({
                        mailbox: mailboxData._id,
                        uid: messageQuery
                    })
                    .project({
                        _id: true,
                        uid: true
                    });

                let done = err => {
                    let next = () => {
                        if (err) {
                            return callback(err);
                        }
                        return callback(null, updatedCount);
                    };

                    if (notifyEntries.length) {
                        return this.notifier.addEntries(mailboxData, notifyEntries, () => {
                            notifyEntries = [];
                            this.notifier.fire(mailboxData.user);
                            next();
                        });
                    }
                    next();
                };

                let bulk_batch_size = consts.BULK_BATCH_SIZE;

                let processNext = () => {
                    cursor.next((err, messageData) => {
                        if (err) {
                            return done(err);
                        }

                        if (!messageData) {
                            return cursor.close(done);
                        }

                        this.database.collection('messages').findOneAndUpdate(
                            {
                                _id: messageData._id,
                                // hash key
                                mailbox,
                                uid: messageData.uid
                            },
                            updates,
                            {
                                projection: {
                                    _id: true,
                                    uid: true,
                                    thread: true,
                                    flags: true
                                },
                                returnDocument: 'after'
                            },
                            (err, item) => {
                                if (err) {
                                    return cursor.close(() => done(err));
                                }

                                if (!item || !item.value) {
                                    return processNext();
                                }

                                let messageData = item.value;
                                updatedCount++;

                                notifyEntries.push({
                                    command: 'FETCH',
                                    uid: messageData.uid,
                                    flags: messageData.flags,
                                    thread: messageData.thread,
                                    message: messageData._id,
                                    unseenChange: 'seen' in changes
                                });

                                if (notifyEntries.length >= bulk_batch_size) {
                                    return this.notifier.addEntries(mailboxData, notifyEntries, () => {
                                        notifyEntries = [];
                                        this.notifier.fire(mailboxData.user);
                                        processNext();
                                    });
                                }
                                processNext();
                            }
                        );
                    });
                };

                this.settingsHandler
                    .get('const:max:bulk_batch_size', {})
                    .then(set_bulk_batch_size => {
                        bulk_batch_size = set_bulk_batch_size;
                    })
                    .finally(() => {
                        // Regardless of response process next
                        processNext();
                    });
            }
        );
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
        if (this.isMessageEncrypted(this._getContentType(mimeTree))) return false;

        // Rebuild raw from mimeTree
        let outputStream = this.indexer.rebuild(mimeTree);
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
        if (this.isMessageEncrypted(ct)) {
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

        let derEncoded;
        let smimeType;

        if (cipher === 'AES-CBC') {
            // AES-256-CBC via Node.js crypto primitives
            let result;
            try {
                result = await SMIMEEncryptor.encryptCBC(validCerts, raw, { keyTransport });
            } catch (err) {
                log.error('SMIME', 'AES-CBC encryption failed: %s', err.message);
                this.loggelf({
                    short_message: '[ENCRYPTFAIL] AES-CBC encryption failed',
                    _mail_action: 'encrypt_fail',
                    _error: err.message,
                    _source: 'smime_encrypt'
                });
                return false;
            }
            if (!result) {
                log.error('SMIME', 'AES-CBC encryption returned no result');
                this.loggelf({
                    short_message: '[ENCRYPTFAIL] AES-CBC encryption returned no result',
                    _mail_action: 'encrypt_fail',
                    _error: 'No result from encryptCBC',
                    _source: 'smime_encrypt'
                });
                return false;
            }
            derEncoded = result;
            smimeType = 'enveloped-data';
        } else {
            // AES-256-GCM via custom AuthEnvelopedData builder
            let result;
            try {
                result = await SMIMEEncryptor.encryptGCM(validCerts, raw, { keyTransport });
            } catch (err) {
                log.error('SMIME', 'AES-GCM encryption failed: %s', err.message);
                this.loggelf({
                    short_message: '[ENCRYPTFAIL] AES-GCM encryption failed',
                    _mail_action: 'encrypt_fail',
                    _error: err.message,
                    _source: 'smime_encrypt'
                });
                return false;
            }
            if (!result) {
                log.error('SMIME', 'AES-GCM encryption returned no result');
                this.loggelf({
                    short_message: '[ENCRYPTFAIL] AES-GCM encryption returned no result',
                    _mail_action: 'encrypt_fail',
                    _error: 'No result from encryptGCM',
                    _source: 'smime_encrypt'
                });
                return false;
            }
            derEncoded = result;
            smimeType = 'authEnveloped-data';
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

        // Show Expunged
        if (options.session && sourceUid.length && options.showExpunged) {
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
            // mark messages as deleted from old mailbox
            await new Promise(resolve => {
                this.notifier.addEntries(mailboxData, removeEntries, () => {
                    // mark messages as added to new mailbox
                    this.notifier.addEntries(targetData, existsEntries, () => {
                        this.notifier.fire(mailboxData.user);

                        return resolve();
                    });
                });
            });
        }

        if (err) {
            throw err;
        }

        return {
            result: true,
            info: {
                uidValidity: targetData.uidValidity,
                sourceUid,
                destinationUid,
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
            newModseq,
            uidNext,
            junk,
            bulk_batch_size
        } = data;

        try {
            r = await this.database.collection('messages').insertOne(message, { writeConcern: 'majority' });

            if (!r || !r.acknowledged) {
                let err = new Error('Failed to store message [2]');
                err.responseCode = 500;
                err.code = 'StoreError';

                await cursor.close();
                return this.moveDone(err, { targetData, sourceUid, destinationUid, mailboxData, existsEntries, removeEntries }, options); // will throw
            }
        } catch (err) {
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

            removeEntries.push({
                command: 'EXPUNGE',
                ignore: options.session && options.session.id,
                uid: messageUid,
                message: messageId,
                thread: message.thread,
                unseen,
                // modseq is needed to avoid updating mailbox entry
                modseq: newModseq
            });

            if (options.session && options.showExpunged) {
                options.session.writeStream.write(options.session.formatResponse('EXPUNGE', messageUid));
            }
        }

        let entry = {
            command: 'EXISTS',
            uid: uidNext,
            message: insertId,
            unseen: message.unseen,
            idate: message.idate,
            thread: message.thread
        };
        if (junk) {
            entry.junk = junk;
        }
        existsEntries.push(entry);

        if (existsEntries.length >= bulk_batch_size) {
            // mark messages as deleted from old mailbox
            return new Promise(resolve => {
                this.notifier.addEntries(mailboxData, removeEntries, () => {
                    // mark messages as added to new mailbox
                    this.notifier.addEntries(targetData, existsEntries, () => {
                        removeEntries.length = 0; // Clear top-level argument array, setting length to 0 clears array object
                        existsEntries.length = 0;
                        this.notifier.fire(mailboxData.user);
                        return resolve(true);
                    });
                });
            });
        }
        return true;
    }
}

module.exports = MessageHandler;
