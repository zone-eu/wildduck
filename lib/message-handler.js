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
const { htmlToText } = require('html-to-text');

// index only the following headers for SEARCH
const INDEXED_HEADERS = ['to', 'cc', 'subject', 'from', 'sender', 'reply-to', 'message-id', 'thread-index', 'list-id', 'delivered-to'];
const DISALLOWED_HEADERS_FOR_ADDRESS_REGISTER = ['list-id', 'auto-submitted', 'x-auto-response-suppress'];

openpgp.config.commentstring = 'Plaintext message encrypted by WildDuck Mail Server';
openpgp.config.versionString = `WildDuck v${packageData.version}`;

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
                        addrview: addr.addrview
                    },
                    {
                        $set: updates,
                        $setOnInsert: {
                            user,
                            address: addr.address,
                            addrview: addr.addrview
                        }
                    },
                    { upsert: true, projection: { _id: true } }
                );
            }
        } catch (err) {
            // can ignore, not an important operation
        }
    }

    // Monster method for inserting new messages to a mailbox
    // TODO: Refactor into smaller pieces
    add(options, callback) {
        if (!options.prepared && options.raw && options.raw.length > consts.MAX_ALLOWED_MESSAGE_SIZE) {
            return setImmediate(() => callback(new Error('Message size ' + options.raw.length + ' bytes is too large')));
        }

        this.getMailbox(options, (err, mailboxData) => {
            if (err) {
                return callback(err);
            }

            // get target mailbox data

            options.targetMailboxEncrypted = !!mailboxData.encryptMessages;

            this.users.collection('users').findOne({ _id: options.user }, (err, userData) => {
                if (err) {
                    return callback(err);
                }

                // get target user data
                let prepared = options.prepared; // might be undefined

                // check if already encrypted
                let alreadyEncrypted = false;

                // message already prepared, check if encrypted
                if (prepared) {
                    // got prepared
                    const parsedHeader = (prepared.mimeTree && prepared.mimeTree?.parsedHeader) || {};
                    const parsedContentType = parsedHeader['content-type'];

                    if (parsedContentType && parsedContentType.subtype === 'encrypted') {
                        alreadyEncrypted = true;
                    }
                } else {
                    // no prepared, use raw
                    if (options.rawchunks && !options.raw) {
                        // got rawchunks instead of raw
                        if (options.chunklen) {
                            options.raw = Buffer.concat(options.rawchunks, options.chunklen);
                        } else {
                            options.raw = Buffer.concat(options.rawchunks);
                        }
                    }

                    const rawString = options.raw.toString('binary'); // get string from the raw bytes of message
                    const regex = /Content-Type:\s*multipart\/encrypted/gim;

                    if (regex.test(rawString)) {
                        // if there is encrypted content-type then message already encrypted, no need to re-encrypt it
                        alreadyEncrypted = true;
                    }
                }

                let flags = Array.isArray(options.flags) ? options.flags : [].concat(options.flags || []);

                let addMessage = () => {
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

                    let cleanup = (...args) => {
                        if (!args[0]) {
                            return callback(...args);
                        }

                        let attachmentIds = Object.keys(mimeTree.attachmentMap || {}).map(key => mimeTree.attachmentMap[key]);
                        if (!attachmentIds.length) {
                            return callback(...args);
                        }

                        this.attachmentStorage.deleteMany(attachmentIds, maildata.magic, () => callback(...args));
                    };

                    this.indexer.storeNodeBodies(maildata, mimeTree, err => {
                        if (err) {
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
                                messageData.text.length <= consts.MAX_PLAINTEXT_CONTENT
                                    ? messageData.text
                                    : messageData.text.substr(0, consts.MAX_PLAINTEXT_CONTENT);

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

                        this.users.collection('users').findOneAndUpdate(
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
                            },
                            (err, r) => {
                                if (err) {
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

                                let rollback = err => {
                                    this.users.collection('users').findOneAndUpdate(
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
                                        },
                                        (...args) => {
                                            let r = args && args[1];

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
                                                    _error: err.message,
                                                    _code: err.code
                                                });
                                            }

                                            cleanup(err);
                                        }
                                    );
                                };

                                // acquire new UID+MODSEQ
                                this.database.collection('mailboxes').findOneAndUpdate(
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
                                    },
                                    (err, item) => {
                                        if (err) {
                                            return rollback(err);
                                        }

                                        if (!item || !item.value) {
                                            // was not able to acquire a lock
                                            let err = new Error('Mailbox is missing');
                                            err.imapResponse = 'TRYCREATE';
                                            return rollback(err);
                                        }

                                        let mailboxData = item.value;

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

                                        this.getThreadId(mailboxData.user, subject, mimeTree, (err, thread) => {
                                            if (err) {
                                                return rollback(err);
                                            }

                                            messageData.thread = thread;

                                            this.database.collection('messages').insertOne(messageData, { writeConcern: 'majority' }, (err, r) => {
                                                if (err) {
                                                    return rollback(err);
                                                }

                                                if (!r || !r.acknowledged) {
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

                                                if (
                                                    options.session &&
                                                    options.session.selected &&
                                                    options.session.selected.mailbox &&
                                                    options.session.selected.mailbox.toString() === mailboxData._id.toString()
                                                ) {
                                                    options.session.writeStream.write(options.session.formatResponse('EXISTS', messageData.uid));
                                                }

                                                let updateAddressRegister = next => {
                                                    let addresses = [];

                                                    if (messageData.junk || flags.includes('\\Draft')) {
                                                        // skip junk and draft messages
                                                        return next();
                                                    }

                                                    let parsed = messageData.mimeTree && messageData.mimeTree.parsedHeader;

                                                    if (parsed) {
                                                        let keyList = mailboxData.specialUse === '\\Sent' ? ['to', 'cc', 'bcc'] : ['from'];

                                                        for (const disallowedHeader of DISALLOWED_HEADERS_FOR_ADDRESS_REGISTER) {
                                                            // if email contains headers that we do not want,
                                                            // don't add any emails to address register
                                                            if (parsed[disallowedHeader]) {
                                                                return next();
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
                                                        return next();
                                                    }

                                                    this.updateAddressRegister(mailboxData.user, addresses)
                                                        .then(() => next())
                                                        .catch(err => next(err));
                                                };

                                                updateAddressRegister(() => {
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
                                                            this.notifier.fire(mailboxData.user);

                                                            let raw = options.rawchunks || options.raw;
                                                            let processAudits = async () => {
                                                                let audits = await this.database
                                                                    .collection('audits')
                                                                    .find({ user: mailboxData.user, expires: { $gt: new Date() } })
                                                                    .toArray();

                                                                let now = new Date();
                                                                for (let auditData of audits) {
                                                                    if ((auditData.start && auditData.start > now) || (auditData.end && auditData.end < now)) {
                                                                        // audit not active
                                                                        continue;
                                                                    }
                                                                    await this.auditHandler.store(auditData._id, raw, {
                                                                        date: messageData.idate,
                                                                        msgid: messageData.msgid,
                                                                        header: messageData.mimeTree && messageData.mimeTree.parsedHeader,
                                                                        ha: messageData.ha,
                                                                        mailbox: mailboxData._id,
                                                                        mailboxPath: mailboxData.path,
                                                                        info: Object.assign({ queueId: messageData.outbound }, messageData.meta)
                                                                    });
                                                                }
                                                            };

                                                            let next = () => {
                                                                cleanup(null, true, {
                                                                    uidValidity,
                                                                    uid,
                                                                    id: messageData._id.toString(),
                                                                    mailbox: mailboxData._id.toString(),
                                                                    mailboxPath: mailboxData.path,
                                                                    size,
                                                                    status: 'new'
                                                                });
                                                            };

                                                            // do not use more suitable .finally() as it is not supported in Node v8
                                                            return processAudits().then(next).catch(next);
                                                        }
                                                    );
                                                });
                                            });
                                        });
                                    }
                                );
                            }
                        );
                    });
                };

                if (!alreadyEncrypted) {
                    // not already encrypted, check if user has encryption on or target mailbox is encrypted
                    if ((userData.encryptMessages || !!mailboxData.encryptMessages) && userData.pubKey && !flags.includes('\\Draft')) {
                        if (options.rawchunks && !options.raw) {
                            // got rawchunks instead of raw
                            if (options.chunklen) {
                                options.raw = Buffer.concat(options.rawchunks, options.chunklen);
                            } else {
                                options.raw = Buffer.concat(options.rawchunks);
                            }
                        }
                        // user has encryption on or target mailbox encrypted, encrypt message and prepare again
                        // do not encrypt drafts
                        // may have a situation where we got prepared and no options.raw but options.rawchunks instead, concat them
                        this.encryptMessage(userData.pubKey, options.raw, (err, res) => {
                            if (err) {
                                return callback(err);
                            }

                            if (res) {
                                // new encrypted raw available
                                options.raw = res;
                            }

                            delete options.prepared; // delete any existing prepared as new will be generated
                            this.prepareMessage(options, (err, newPrepared) => {
                                if (err) {
                                    return callback(err);
                                }

                                newPrepared.id = prepared.id; // retain original

                                options.prepared = newPrepared; // new prepared in options just in case
                                prepared = newPrepared; // overwrite top-level original prepared
                                options.maildata = this.indexer.getMaildata(newPrepared.mimeTree); // get new maildata of encrypted message
                                addMessage();
                            });
                        });
                    } else {
                        // not already encrypted and no need to
                        this.prepareMessage(options, (err, newPrepared) => {
                            if (err) {
                                return callback(err);
                            }

                            prepared = newPrepared;
                            addMessage();
                        });
                    }
                } else {
                    // message already encrypted
                    this.prepareMessage(options, (err, newPrepared) => {
                        if (err) {
                            return callback(err);
                        }

                        prepared = newPrepared;
                        addMessage();
                    });
                }
            });
        });
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
                    await new Promise((resolve, reject) => {
                        this.attachmentStorage.deleteMany(attachmentIds, messageData.magic, err => {
                            if (err) {
                                return reject(err);
                            }
                            resolve();
                        });
                    });
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
        this.getMailbox(options.source, (err, mailboxData) => {
            if (err) {
                return callback(err);
            }

            this.getMailbox(options.destination, (err, targetData) => {
                if (err) {
                    return callback(err);
                }

                this.database.collection('mailboxes').findOneAndUpdate(
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
                    },
                    (err, item) => {
                        if (err) {
                            return callback(err);
                        }

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

                        let done = err => {
                            let next = () => {
                                if (err) {
                                    return callback(err);
                                }
                                return callback(null, true, {
                                    uidValidity: targetData.uidValidity,
                                    sourceUid,
                                    destinationUid,
                                    mailbox: mailboxData._id,
                                    target: targetData._id,
                                    status: 'moved'
                                });
                            };

                            if (sourceUid.length && options.showExpunged) {
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
                                return this.notifier.addEntries(mailboxData, removeEntries, () => {
                                    // mark messages as added to new mailbox
                                    this.notifier.addEntries(targetData, existsEntries, () => {
                                        this.notifier.fire(mailboxData.user);
                                        next();
                                    });
                                });
                            }

                            next();
                        };

                        let processNext = () => {
                            cursor.next((err, message) => {
                                if (err) {
                                    return done(err);
                                }
                                if (!message) {
                                    return cursor.close(done);
                                }

                                let messageId = message._id;
                                let messageUid = message.uid;

                                if (options.returnIds) {
                                    sourceUid.push(message._id);
                                } else {
                                    sourceUid.push(messageUid);
                                }

                                this.database.collection('mailboxes').findOneAndUpdate(
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
                                    },
                                    (err, item) => {
                                        if (err) {
                                            return cursor.close(() => done(err));
                                        }

                                        if (!item || !item.value) {
                                            return cursor.close(() => done(new Error('Mailbox disappeared')));
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

                                        const updateMessage = () => {
                                            this.database.collection('messages').insertOne(message, { writeConcern: 'majority' }, (err, r) => {
                                                if (err) {
                                                    return cursor.close(() => done(err));
                                                }

                                                if (!r || !r.acknowledged) {
                                                    let err = new Error('Failed to store message [2]');
                                                    err.responseCode = 500;
                                                    err.code = 'StoreError';
                                                    return cursor.close(() => done(err));
                                                }

                                                let insertId = r.insertedId;

                                                // delete old message
                                                this.database.collection('messages').deleteOne(
                                                    {
                                                        _id: messageId,
                                                        mailbox: mailboxData._id,
                                                        uid: messageUid
                                                    },
                                                    { writeConcern: 'majority' },
                                                    (err, r) => {
                                                        if (err) {
                                                            return cursor.close(() => done(err));
                                                        }

                                                        if (r && r.deletedCount) {
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

                                                            if (options.showExpunged) {
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

                                                        if (existsEntries.length >= consts.BULK_BATCH_SIZE) {
                                                            // mark messages as deleted from old mailbox
                                                            return this.notifier.addEntries(mailboxData, removeEntries, () => {
                                                                // mark messages as added to new mailbox
                                                                this.notifier.addEntries(targetData, existsEntries, () => {
                                                                    removeEntries = [];
                                                                    existsEntries = [];
                                                                    this.notifier.fire(mailboxData.user);
                                                                    processNext();
                                                                });
                                                            });
                                                        }
                                                        processNext();
                                                    }
                                                );
                                            });
                                        };

                                        if (targetData.encryptMessages) {
                                            // move target mailbox is encrypted
                                            const parsedHeader = (message.mimeTree && message.mimeTree.parsedHeader) || {};
                                            const parsedContentType = parsedHeader['content-type'];

                                            if (parsedContentType && parsedContentType.subtype === 'encrypted') {
                                                // message already encrypted, just continue move
                                                updateMessage();
                                            } else {
                                                // not yet encrypted
                                                this.users.collection('users').findOne({ _id: mailboxData.user }, (err, res) => {
                                                    if (err) {
                                                        return done(err);
                                                    }
                                                    // get user data
                                                    if (!res.pubKey) {
                                                        return updateMessage();
                                                    }

                                                    // get raw from existing mimetree
                                                    let outputStream = this.indexer.rebuild(message.mimeTree); // get raw rebuilder response obj (.value is the stream)

                                                    if (!outputStream || outputStream.type !== 'stream' || !outputStream.value) {
                                                        return done(new Error('Cannot fetch message'));
                                                    }
                                                    outputStream = outputStream.value; // set stream to actual stream object (.value)

                                                    let chunks = [];
                                                    let chunklen = 0;
                                                    outputStream
                                                        .on('readable', () => {
                                                            let chunk;
                                                            while ((chunk = outputStream.read()) !== null) {
                                                                chunks.push(chunk);
                                                                chunklen += chunk.length;
                                                            }
                                                        })
                                                        .on('end', () => {
                                                            // when done rebuilding
                                                            const raw = Buffer.concat(chunks, chunklen);
                                                            this.encryptMessage(res.pubKey, raw, (err, res) => {
                                                                if (err) {
                                                                    return done(err);
                                                                }

                                                                // encrypt rebuilt raw

                                                                if (res) {
                                                                    // encrypted
                                                                    this.prepareMessage({ raw: res }, (err, prepared) => {
                                                                        if (err) {
                                                                            return done(err);
                                                                        }
                                                                        // prepare new message structure from encrypted raw

                                                                        prepared.id = message.id; // reuse existing id

                                                                        const maildata = this.indexer.getMaildata(prepared.mimeTree); // get new maildata

                                                                        // add attachments of encrypted messages
                                                                        if (maildata.attachments && maildata.attachments.length) {
                                                                            message.attachments = maildata.attachments;
                                                                            message.ha = maildata.attachments.some(a => !a.related);
                                                                        } else {
                                                                            message.ha = false;
                                                                        }

                                                                        // remove fields that may leak data in FE or DB
                                                                        delete message.text;
                                                                        delete message.html;
                                                                        message.intro = '';

                                                                        this.indexer.storeNodeBodies(maildata, prepared.mimeTree, err => {
                                                                            // store new attachments
                                                                            let cleanup = (...args) => {
                                                                                if (!args[0]) {
                                                                                    return callback(...args);
                                                                                }

                                                                                let attachmentIds = Object.keys(prepared.mimeTree.attachmentMap || {}).map(
                                                                                    key => prepared.mimeTree.attachmentMap[key]
                                                                                );
                                                                                if (!attachmentIds.length) {
                                                                                    return callback(...args);
                                                                                }

                                                                                this.attachmentStorage.deleteMany(attachmentIds, maildata.magic, () =>
                                                                                    callback(...args)
                                                                                );
                                                                            };

                                                                            if (err) {
                                                                                return cleanup(err);
                                                                            }

                                                                            // overwrite required values of existing message with new values
                                                                            message.mimeTree = prepared.mimeTree;
                                                                            message.size = prepared.size;
                                                                            message.bodystructure = prepared.bodystructure;
                                                                            message.envelope = prepared.envelope;
                                                                            message.headers = prepared.headers;
                                                                            updateMessage();
                                                                        });
                                                                    });
                                                                } else {
                                                                    updateMessage();
                                                                }
                                                            });
                                                        });
                                                });
                                            }
                                        } else {
                                            // move target is not encrypted so proceed
                                            updateMessage();
                                        }
                                    }
                                );
                            });
                        };

                        processNext();
                    }
                );
            });
        });
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

    prepareMessage(options, callback) {
        if (options.prepared) {
            return setImmediate(() => callback(null, options.prepared));
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

        return setImmediate(() => callback(null, prepared));
    }

    // resolves or generates new thread id for a message
    getThreadId(userId, subject, mimeTree, callback) {
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

        // most messages are not threaded, so an upsert call should be ok to make
        this.database.collection('threads').findOneAndUpdate(
            {
                user: userId,
                ids: { $in: referenceIds },
                subject
            },
            {
                $addToSet: {
                    ids: { $each: referenceIds }
                },
                $set: {
                    updated: new Date()
                }
            },
            {
                returnDocument: 'after'
            },
            (err, r) => {
                if (err) {
                    return callback(err);
                }
                if (r.value) {
                    return callback(null, r.value._id);
                }
                // thread not found, create a new one
                this.database.collection('threads').insertOne(
                    {
                        user: userId,
                        subject,
                        ids: referenceIds,
                        updated: new Date()
                    },
                    (err, r) => {
                        if (err) {
                            return callback(err);
                        }
                        return callback(null, r.insertedId);
                    }
                );
            }
        );
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

                                if (notifyEntries.length >= consts.BULK_BATCH_SIZE) {
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

                processNext();
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

    encryptMessage(pubKey, raw, callback) {
        this.encryptMessageAsync(pubKey, raw)
            .then(res => callback(null, res))
            .catch(err => callback(err));
    }

    async encryptMessageAsync(pubKeyArmored, raw) {
        if (!pubKeyArmored) {
            return false;
        }

        if (raw && Array.isArray(raw.chunks) && raw.chunklen) {
            raw = Buffer.concat(raw.chunks, raw.chunklen);
        }

        let lastBytes = [];
        let headerEnd = raw.length;
        let headerLength = 0;

        // split the message into header and body
        for (let i = 0, len = raw.length; i < len; i++) {
            lastBytes.unshift(raw[i]);
            if (lastBytes.length > 10) {
                lastBytes.length = 4;
            }
            if (lastBytes.length < 2) {
                continue;
            }
            let pos = 0;
            if (lastBytes[pos] !== 0x0a) {
                continue;
            }
            pos++;
            if (lastBytes[pos] === 0x0d) {
                pos++;
            }
            if (lastBytes[pos] !== 0x0a) {
                continue;
            }
            pos++;
            if (lastBytes[pos] === 0x0d) {
                pos++;
            }
            // we have a match!'
            headerEnd = i + 1 - pos;
            headerLength = pos;
            break;
        }

        let header = raw.slice(0, headerEnd);
        let breaker = headerLength ? raw.slice(headerEnd, headerEnd + headerLength) : Buffer.alloc(0);
        let body = headerEnd + headerLength < raw.length ? raw.slice(headerEnd + headerLength) : Buffer.alloc(0);

        // modify headers
        let headers = [];
        let bodyHeaders = [];
        let lastHeader = false;
        let boundary = 'nm_' + crypto.randomBytes(14).toString('hex');

        let headerLines = header.toString('binary').split('\r\n');
        // use for, so we could escape from it if needed
        for (let i = 0, len = headerLines.length; i < len; i++) {
            let line = headerLines[i];
            if (!i || !lastHeader || !/^\s/.test(line)) {
                lastHeader = [line];
                if (/^content-type:/i.test(line)) {
                    let parts = line.split(':');
                    let value = parts.slice(1).join(':');
                    if (value.split(';').shift().trim().toLowerCase() === 'multipart/encrypted') {
                        // message is already encrypted, do nothing
                        return false;
                    }
                    bodyHeaders.push(lastHeader);
                } else if (/^content-transfer-encoding:/i.test(line)) {
                    bodyHeaders.push(lastHeader);
                } else {
                    headers.push(lastHeader);
                }
            } else {
                lastHeader.push(line);
            }
        }

        headers.push(['Content-Type: multipart/encrypted; protocol="application/pgp-encrypted";'], [' boundary="' + boundary + '"']);

        headers.push(['Content-Description: OpenPGP encrypted message']);
        headers.push(['Content-Transfer-Encoding: 7bit']);

        headers = Buffer.from(headers.map(line => line.join('\r\n')).join('\r\n'), 'binary');
        bodyHeaders = Buffer.from(bodyHeaders.map(line => line.join('\r\n')).join('\r\n'), 'binary');

        let pubKey;
        try {
            pubKey = await openpgp.readKey({ armoredKey: tools.prepareArmoredPubKey(pubKeyArmored), config: { tolerant: true } });
        } catch (err) {
            return false;
        }
        if (!pubKey) {
            return false;
        }

        let ciphertext;
        try {
            ciphertext = await openpgp.encrypt({
                message: await openpgp.createMessage({ binary: Buffer.concat([Buffer.from(bodyHeaders + '\r\n\r\n'), body]) }),
                encryptionKeys: pubKey,
                format: 'armored',
                config: { minRSABits: 1024 }
            });
        } catch (err) {
            return false;
        }

        let text =
            'This is an OpenPGP/MIME encrypted message\r\n\r\n' +
            '--' +
            boundary +
            '\r\n' +
            'Content-Type: application/pgp-encrypted\r\n' +
            'Content-Transfer-Encoding: 7bit\r\n' +
            '\r\n' +
            'Version: 1\r\n' +
            '\r\n' +
            '--' +
            boundary +
            '\r\n' +
            'Content-Type: application/octet-stream; name=encrypted.asc\r\n' +
            'Content-Disposition: inline; filename=encrypted.asc\r\n' +
            'Content-Transfer-Encoding: 7bit\r\n' +
            '\r\n' +
            ciphertext +
            '\r\n--' +
            boundary +
            '--\r\n';

        return Buffer.concat([headers, breaker, Buffer.from(text)]);
    }
}

module.exports = MessageHandler;
