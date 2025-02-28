'use strict';

const log = require('npmlog');
const ObjectId = require('mongodb').ObjectId;
const forward = require('./forward');
const autoreply = require('./autoreply');
const Maildropper = require('./maildropper');
const tools = require('./tools');
const consts = require('./consts');
const util = require('util');

class FilterHandler {
    constructor(options) {
        this.db = options.db;
        this.messageHandler = options.messageHandler;

        this.prepareMessage = util.promisify(this.messageHandler.prepareMessage.bind(this.messageHandler));
        this.encryptMessage = util.promisify(this.messageHandler.encryptMessage.bind(this.messageHandler));

        this.addMessage = util.promisify((...args) => {
            let callback = args.pop();
            this.messageHandler.add(...args, (err, status, data) => {
                if (err) {
                    return callback(err);
                }
                return callback(null, { status, data });
            });
        });

        this.ttlcounter = util.promisify(this.messageHandler.counters.ttlcounter.bind(this.messageHandler.counters));
        this.forward = util.promisify(forward);

        this.maildrop = new Maildropper({
            db: this.db,
            zone: options.sender.zone,
            collection: options.sender.collection,
            gfs: options.sender.gfs,
            loopSecret: options.sender.loopSecret
        });

        this.loggelf = options.loggelf || (() => false);
    }

    getUserData(address, callback) {
        let query = {};
        if (!address) {
            return callback(null, false);
        }
        if (typeof address === 'object' && address._id) {
            return callback(null, address);
        }

        let collection;

        if (tools.isId(address)) {
            query._id = new ObjectId(address);
            collection = 'users';
        } else if (typeof address !== 'string') {
            return callback(null, false);
        } else if (address.indexOf('@') >= 0) {
            query.addrview = tools.uview(address);
            collection = 'addresses';
        } else {
            query.unameview = address.replace(/\./g, '');
            collection = 'users';
        }

        let fields = {
            name: true,
            forwards: true,
            targets: true,
            autoreply: true,
            encryptMessages: true,
            encryptForwarded: true,
            pubKey: true,
            spamLevel: true,
            tagsview: true
        };

        if (collection === 'users') {
            return this.db.users.collection('users').findOne(
                query,
                {
                    projection: fields
                },
                callback
            );
        }

        return this.db.users.collection('addresses').findOne(query, (err, addressData) => {
            if (err) {
                return callback(err);
            }
            if (!addressData || !!addressData.user) {
                return callback(null, false);
            }
            return this.db.users.collection('users').findOne(
                {
                    _id: addressData.user
                },
                {
                    projection: fields
                },
                callback
            );
        });
    }

    process(options, callback) {
        this.getUserData(options.user || options.recipient, (err, userData) => {
            if (err) {
                return callback(err);
            }

            if (!userData) {
                return callback(null, false);
            }

            this.storeMessage(userData, options)
                .then(status => callback(null, status.response, status.prepared))
                .catch(callback);
        });
    }

    async storeMessage(userData, options) {
        let sender = options.sender || '';
        let recipient = options.recipient || userData.address;

        let filterResults = [];

        // create Delivered-To and Return-Path headers
        let extraHeader = Buffer.from(['Delivered-To: ' + recipient, 'Return-Path: <' + sender + '>'].join('\r\n') + '\r\n');

        let chunks = options.chunks;
        let chunklen = options.chunklen;

        if (!chunks && options.raw) {
            chunks = [options.raw];
            chunklen = options.raw.length;
        }

        let rawchunks = chunks;

        let raw;

        let prepared;
        if (options.mimeTree) {
            if (options.mimeTree && options.mimeTree.header) {
                // remove old headers
                if (/^Delivered-To/.test(options.mimeTree.header[0])) {
                    options.mimeTree.header.shift();
                }
                if (/^Return-Path/.test(options.mimeTree.header[0])) {
                    options.mimeTree.header.shift();
                }
            }
            prepared = await this.prepareMessage({
                mimeTree: options.mimeTree
            });
        } else {
            raw = Buffer.concat(chunks, chunklen);
            prepared = await this.prepareMessage({
                raw
            });
        }

        prepared.mimeTree.header.unshift('Return-Path: <' + Buffer.from(sender).toString('binary') + '>');
        prepared.mimeTree.header.unshift('Delivered-To: ' + Buffer.from(recipient).toString('binary'));

        prepared.mimeTree.parsedHeader['return-path'] = '<' + sender + '>';
        prepared.mimeTree.parsedHeader['delivered-to'] = '<' + recipient + '>';

        // updated Delivered-To in indexed headers object
        for (let i = prepared.headers.length - 1; i > 0; i--) {
            if (prepared.headers.key === 'delivered-to') {
                prepared.headers.splice(i, 1);
            }
        }
        prepared.headers.push({ key: 'delivered-to', value: recipient.toLowerCase() });

        prepared.size = this.messageHandler.indexer.getSize(prepared.mimeTree);

        let maildata = options.maildata || this.messageHandler.indexer.getMaildata(prepared.mimeTree);

        // default flags are empty
        let flags = [];

        // default mailbox target is INBOX
        let mailboxQueryKey = 'path';
        let mailboxQueryValue = 'INBOX';

        // allow to define mailbox
        if (options.mailbox && tools.isId(options.mailbox)) {
            mailboxQueryKey = 'mailbox';
            mailboxQueryValue = new ObjectId(options.mailbox);
        }

        let meta = options.meta || {};

        let parsedHeader = (prepared.mimeTree.parsedHeader && prepared.mimeTree.parsedHeader) || {};

        let received = [].concat(parsedHeader.received || []);
        if (received.length) {
            let receivedData = parseReceived(received[0]);

            if (!receivedData.has('id') && received.length > 1) {
                receivedData = parseReceived(received[1]);
            }

            if (receivedData.has('with')) {
                meta.transtype = receivedData.get('with');
            }

            if (receivedData.has('id')) {
                meta.queueId = receivedData.get('id');
            }

            if (receivedData.has('from')) {
                meta.origin = receivedData.get('from');
            }
        }

        let filters = [];
        try {
            filters = await this.db.database
                .collection('filters')
                .find({
                    user: userData._id,
                    disabled: { $ne: true }
                })
                .sort({
                    _id: 1
                })
                .toArray();
        } catch (err) {
            // ignore as filters are not so importand
        }

        let isEncrypted = false;
        let forwardTargets = new Map();

        let matchingFilters = [];
        let filterActions = new Map();

        // check global whitelist/blacklist before filters
        if (userData.tagsview && userData.tagsview.length) {
            let from = parsedHeader.from || parsedHeader.sender;
            from = [].concat(from || []);
            tools.decodeAddresses(from);
            from = tools.flatAddresses(from);

            if (from && from.length) {
                from = from[0];
                let domain = tools.normalizeDomain(from.address.split('@').pop());
                try {
                    let domainaccessData = await this.db.database.collection('domainaccess').findOne({
                        tag: { $in: userData.tagsview },
                        domain
                    });

                    if (domainaccessData) {
                        switch (domainaccessData.action) {
                            case 'block':
                                filterActions.set('spam', true);
                                matchingFilters.push(`block:${domainaccessData.tag}:${domainaccessData._id}`);
                                break;
                            case 'allow':
                                filterActions.set('spam', false);
                                matchingFilters.push(`allow:${domainaccessData.tag}:${domainaccessData._id}`);
                                break;
                        }
                    }
                } catch (err) {
                    // ignore, not important
                }
            }
        }

        for (let filterData of filters) {
            if (!(await checkFilter(filterData, prepared, maildata))) {
                continue;
            }

            matchingFilters.push(filterData.id || filterData._id);

            // apply matching filter
            Object.keys(filterData.action).forEach(key => {
                if (key === 'targets') {
                    [].concat(filterData.action[key] || []).forEach(target => {
                        forwardTargets.set(target.value, target);
                    });
                    return;
                }

                // if a previous filter already has set a value then do not touch it
                if (!filterActions.has(key)) {
                    filterActions.set(key, filterData.action[key]);
                }
            });
        }

        if (typeof userData.spamLevel === 'number' && userData.spamLevel >= 0) {
            let isSpam;

            if (userData.spamLevel === 0) {
                // always mark as spam
                isSpam = true;
            } else if (userData.spamLevel === 100) {
                // always mark as ham
                isSpam = false;
                filterActions.set('spam', false);
            } else if (!filterActions.has('spam')) {
                let spamScore;
                switch (meta.spamAction) {
                    case 'reject':
                        spamScore = 75;
                        break;

                    case 'rewrite subject':
                    case 'soft reject':
                    case 'greylist':
                        spamScore = 50;
                        break;

                    case 'add header':
                        spamScore = 25;
                        break;

                    case 'no action':
                    default:
                        spamScore = 0;
                        break;
                }
                isSpam = spamScore >= userData.spamLevel;
            }

            if (isSpam && !filterActions.has('spam')) {
                // only update if spam decision is not yet made
                filterActions.set('spam', true);
            }
        }

        let encryptMessage = async () => {
            if (isEncrypted) {
                return;
            }

            let encrypted = await this.encryptMessage(userData.pubKey, {
                chunks,
                chunklen
            });

            if (encrypted) {
                chunks = [encrypted];
                chunklen = encrypted.length;
                isEncrypted = true;

                prepared = await this.prepareMessage({
                    raw: Buffer.concat([extraHeader, encrypted])
                });
                maildata = this.messageHandler.indexer.getMaildata(prepared.mimeTree);
            }
        };

        let forwardMessage = async () => {
            if (!filterActions.get('delete')) {
                // forward to default recipient only if the message is not deleted

                if (userData.targets && userData.targets.length) {
                    userData.targets.forEach(targetData => {
                        let key = targetData.value;
                        if (targetData.type === 'relay') {
                            targetData.recipient = userData.address;
                            key = `${targetData.recipient}:${targetData.value}`;
                        }
                        forwardTargets.set(key, targetData);
                    });
                } else if (options.targets && options.targets.length) {
                    // if user had no special targets, then use default ones provided by options
                    options.targets.forEach(targetData => {
                        let key = targetData.value;
                        if (targetData.type === 'relay') {
                            targetData.recipient = userData.address;
                            key = `${targetData.recipient}:${targetData.value}`;
                        }
                        forwardTargets.set(key, targetData);
                    });
                }
            }

            // never forward messages marked as spam
            if (!forwardTargets.size) {
                return false;
            }

            const targets = Array.from(forwardTargets).map(row => ({
                type: row[1].type,
                value: row[1].value,
                recipient
            }));

            const logdata = {
                _user: userData._id.toString(),
                _mail_action: 'forward',
                _sender: sender,
                _recipient: recipient,
                _target_address: (targets || []).map(target => ((target && target.value) || target).toString().replace(/\?.*$/, '')).join('\n'),
                _message_id: prepared.mimeTree.parsedHeader['message-id']
            };

            if (filterActions.get('spam')) {
                logdata.short_message = '[FRWRDFAIL] Skipped forwarding due to spam';
                logdata._error = 'Skipped forwarding due to spam';
                logdata._code = 'ESPAM';
                this.loggelf(logdata);
                return;
            }

            // check limiting counters
            try {
                let counterResult = await this.ttlcounter(
                    'wdf:' + userData._id.toString(),
                    forwardTargets.size,
                    userData.forwards || consts.MAX_FORWARDS,
                    false
                );
                if (!counterResult.success) {
                    log.silly('Filter', 'FRWRDFAIL key=%s error=%s', 'wdf:' + userData._id.toString(), 'Precondition failed');

                    logdata.short_message = '[FRWRDFAIL] Skipped forwarding due to rate limiting';
                    logdata._error = 'Skipped forwarding due to rate limiting';
                    logdata._code = 'ERATELIMIT';
                    logdata._forwarded = 'no';
                    this.loggelf(logdata);
                    return false;
                }
            } catch (err) {
                // failed checks, ignore
                log.info('Filter', 'FRWRDFAIL key=%s error=%s', 'wdf:' + userData._id.toString(), err.message);

                logdata.short_message = '[FRWRDFAIL] Skipped forwarding due to database error';
                logdata._error = err.message;
                logdata._code = err.code;
                logdata._forwarded = 'no';
                this.loggelf(logdata);
            }

            if (userData.encryptForwarded && userData.pubKey) {
                await encryptMessage();
            }

            try {
                let forwardResponse = await this.forward({
                    db: this.db,
                    maildrop: this.maildrop,

                    parentId: prepared.id,
                    userData,
                    sender,
                    recipient,

                    targets,

                    origin: meta.origin,

                    chunks,
                    chunklen
                });

                if (forwardResponse) {
                    logdata.short_message = '[FRWRDOK] Scheduled forwarding';
                    logdata._target_queue_id = forwardResponse;
                    logdata._forwarded = 'yes';
                    this.loggelf(logdata);
                }

                return forwardResponse;
            } catch (err) {
                logdata.short_message = '[FRWRDFAIL] Skipped forwarding due to queueing error';
                logdata._error = err.message;
                logdata._code = err.code;
                logdata._forwarded = 'no';
                this.loggelf(logdata);
            }
        };

        let sendAutoreply = async () => {
            // never reply to messages marked as spam
            if (!sender || !userData.autoreply || filterActions.get('spam') || options.disableAutoreply) {
                return;
            }

            let curtime = new Date();
            let autoreplyData = await this.db.database.collection('autoreplies').findOne({
                user: userData._id
            });

            if (!autoreplyData || !autoreplyData.status) {
                return false;
            }

            if (autoreplyData.start && autoreplyData.start > curtime) {
                return false;
            }

            if (autoreplyData.end && autoreplyData.end < curtime) {
                return false;
            }

            let autoreplyResponse = await autoreply(
                {
                    db: this.db,
                    maildrop: this.maildrop,

                    parentId: prepared.id,
                    userData,
                    sender,
                    recipient,
                    chunks,
                    chunklen,
                    messageHandler: this.messageHandler
                },
                autoreplyData
            );

            return autoreplyResponse;
        };

        let outbound = [];

        try {
            let forwardId = await forwardMessage();
            if (forwardId) {
                filterResults.push({
                    forward: Array.from(forwardTargets)
                        .map(row => row[0])
                        .join(','),
                    'forward-queue-id': forwardId
                });
                outbound.push(forwardId);
                log.silly(
                    'Filter',
                    '%s FRWRDOK id=%s from=%s to=%s target=%s',
                    prepared.id.toString(),
                    forwardId,
                    sender,
                    recipient,
                    Array.from(forwardTargets)
                        .map(row => row[0])
                        .join(',')
                );
            }
        } catch (err) {
            log.error(
                'Filter',
                '%s FRWRDFAIL from=%s to=%s target=%s error=%s',
                prepared.id.toString(),
                sender,
                recipient,
                Array.from(forwardTargets)
                    .map(row => row[0])
                    .join(','),
                err.message
            );
        }

        try {
            let autoreplyId = await sendAutoreply();
            if (autoreplyId) {
                filterResults.push({ autoreply: sender, 'autoreply-queue-id': autoreplyId });
                outbound.push(autoreplyId);
                log.silly('Filter', '%s AUTOREPLYOK id=%s from=%s to=%s', prepared.id.toString(), autoreplyId, '<>', sender);
            }
        } catch (err) {
            log.error('Filter', '%s AUTOREPLYFAIL from=%s to=%s error=%s', prepared.id.toString(), '<>', sender, err.message);
        }

        if (filterActions.get('delete')) {
            // nothing to do with the message, just continue
            let err = new Error(`Message dropped by policy [${matchingFilters.map(id => (id || '').toString()).join(':')}]`);
            err.code = 'DroppedByPolicy';

            filterResults.push({ delete: true });

            try {
                let audits = await this.db.database
                    .collection('audits')
                    .find({ user: userData._id, expires: { $gt: new Date() } })
                    .toArray();

                let now = new Date();
                for (let auditData of audits) {
                    if ((auditData.start && auditData.start > now) || (auditData.end && auditData.end < now)) {
                        // audit not active
                        continue;
                    }
                    await this.auditHandler.store(auditData._id, rawchunks, {
                        date: prepared.idate || new Date(),
                        msgid: prepared.msgid,
                        header: prepared.mimeTree && prepared.mimeTree.parsedHeader,
                        ha: prepared.ha,
                        info: Object.assign({ notStored: true }, meta || {})
                    });
                }
            } catch (err) {
                log.error('Filter', '%s AUDITFAIL from=%s to=%s error=%s', prepared.id.toString(), '<>', sender, err.message);
            }
            return {
                response: {
                    userData,
                    response: 'Message dropped by policy as ' + prepared.id.toString(),
                    error: err
                }
            };
        }

        // apply filter results to the message
        filterActions.forEach((value, key) => {
            switch (key) {
                case 'spam':
                    if (value > 0) {
                        // positive value is spam
                        mailboxQueryKey = 'specialUse';
                        mailboxQueryValue = '\\Junk';
                        filterResults.push({ spam: true });
                    }
                    break;
                case 'seen':
                    if (value) {
                        flags.push('\\Seen');
                        filterResults.push({ seen: true });
                    }
                    break;
                case 'flag':
                    if (value) {
                        flags.push('\\Flagged');
                        filterResults.push({ flagged: true });
                    }
                    break;
                case 'mailbox':
                    if (value) {
                        // positive value is spam
                        mailboxQueryKey = 'mailbox';
                        mailboxQueryValue = value;
                    }
                    break;
            }
        });

        let messageOpts = {
            user: userData._id,
            [mailboxQueryKey]: mailboxQueryValue,
            inboxDefault: true, // if mailbox is not found, then store to INBOX

            prepared,
            maildata,

            meta,

            filters: matchingFilters,

            date: false,
            flags,
            rawchunks,
            chunklen
        };

        if (raw) {
            messageOpts.raw = raw;
        }

        if (options.verificationResults) {
            messageOpts.verificationResults = options.verificationResults;
        }

        if (outbound && outbound.length) {
            messageOpts.outbound = [].concat(outbound || []);
        }

        if (forwardTargets.size) {
            messageOpts.forwardTargets = Array.from(forwardTargets).map(row => ({
                type: row[1].type,
                value: row[1].value
            }));
        }

        if (userData.encryptMessages && userData.pubKey) {
            await encryptMessage();
            if (isEncrypted) {
                // make sure we have the updated message structure values
                messageOpts.prepared = prepared;
                messageOpts.maildata = maildata;
                filterResults.push({ encrypted: true });
            }
        }

        if (matchingFilters && matchingFilters.length) {
            filterResults.push({
                matchingFilters: matchingFilters.map(id => (id || '').toString())
            });
        }

        try {
            let { data } = await this.addMessage(messageOpts);
            if (data) {
                filterResults.push({
                    mailbox: data.mailbox && data.mailbox.toString(),
                    path: data.mailboxPath,
                    uid: data.uid,
                    id: data.id && data.id.toString()
                });

                return {
                    response: {
                        userData,
                        response: 'Message stored as ' + data.id.toString(),
                        filterResults,
                        attachments: [].concat((maildata && maildata.attachments) || []).map(att => {
                            let binaryHash = prepared.mimeTree?.attachmentMap?.[att.id];
                            let resp = Object.assign({}, att); // cheap copy
                            if (binaryHash) {
                                resp.encodedSha256 = binaryHash.toString('base64');
                            }

                            let attachmentInfo = maildata.attachments.find(a => a.id === att.id);

                            if (attachmentInfo && attachmentInfo.fileContentHash) {
                                resp.fileContentHash = attachmentInfo.fileContentHash;
                            }
                            return resp;
                        })
                    },
                    prepared:
                        (!isEncrypted && {
                            // reuse parsed values
                            mimeTree: messageOpts.prepared.mimeTree,
                            maildata: messageOpts.maildata
                        }) ||
                        false
                };
            }
        } catch (err) {
            return {
                response: {
                    userData,
                    response: err,
                    filterResults,
                    attachments: (maildata && maildata.attachments) || [],
                    error: err
                },
                prepared:
                    (!isEncrypted && {
                        // reuse parsed values
                        mimeTree: messageOpts.prepared.mimeTree,
                        maildata: messageOpts.maildata
                    }) ||
                    false
            };
        }
    }
}

async function checkFilter(filterData, prepared, maildata) {
    if (!filterData || !filterData.query) {
        return false;
    }

    let query = filterData.query;

    // prepare filter data
    let headerFilters = new Map();
    if (query.headers) {
        Object.keys(query.headers).forEach(key => {
            let header = key.replace(/[A-Z]+/g, c => '-' + c.toLowerCase());
            let value = query.headers[key];
            if (!value || !value.isRegex) {
                value = (query.headers[key] || '').toString().toLowerCase();
            }
            if (value) {
                if (header === 'list-id' && typeof value === 'string' && value.indexOf('<') >= 0) {
                    // only check actual ID part of the List-ID header
                    let m = value.match(/<([^>]+)/);
                    if (m && m[1] && m[1].trim()) {
                        value = m[1].trim();
                    }
                }

                headerFilters.set(header, value);
            }
        });
    }

    // check headers
    if (headerFilters.size) {
        let headerMatches = new Set();
        for (let j = prepared.headers.length - 1; j >= 0; j--) {
            let header = prepared.headers[j];
            let key = header.key;

            switch (key) {
                case 'cc':
                case 'delivered-to':
                    if (!headerFilters.get(key)) {
                        // match against "to" query
                        key = 'to';
                    }
                    break;

                case 'sender':
                    if (!headerFilters.get(key)) {
                        // match against "from" query
                        key = 'from';
                    }
                    break;
            }

            if (headerFilters.has(key)) {
                let check = headerFilters.get(key);
                // value should already be lower case though
                let value = (header.value || '').toString().toLowerCase();

                if (check.isRegex) {
                    if (check.test(value)) {
                        headerMatches.add(key);
                    }
                } else if (value.indexOf(check) >= 0) {
                    headerMatches.add(key);
                }
            }
        }

        if (headerMatches.size < headerFilters.size) {
            // not enough matches
            return false;
        }
    }

    if (typeof query.ha === 'boolean') {
        let hasAttachments = maildata.attachments && maildata.attachments.length;
        // true ha means attachmens must exist
        if (!hasAttachments && query.ha) {
            return false;
        }
    }

    if (query.size) {
        let messageSize = prepared.size;
        let filterSize = Math.abs(query.size);
        // negative value means "less than", positive means "more than"
        if (query.size < 0 && messageSize > filterSize) {
            return false;
        }
        if (query.size > 0 && messageSize < filterSize) {
            return false;
        }
    }

    if (query.text && maildata.text.toLowerCase().replace(/\s+/g, ' ').indexOf(query.text.toLowerCase()) < 0) {
        // message plaintext does not match the text field value
        return false;
    }

    log.silly('Filter', 'Filter %s matched message %s', filterData.id, prepared.id);

    // we reached the end of the filter, so this means we have a match
    return filterData;
}

module.exports = FilterHandler;

function parseReceived(str) {
    let result = new Map();

    str.trim()
        .replace(/[\r\n\s\t]+/g, ' ')
        .trim()
        .replace(/(^|\s+)(from|by|with|id|for)\s+([^\s]+)/gi, (m, p, k, v) => {
            let key = k.toLowerCase();
            let value = v;
            if (!result.has(key)) {
                result.set(key, value);
            }
        });

    let date = str.split(';').pop().trim();
    if (date) {
        date = new Date(date);
        if (date.getTime()) {
            result.set('date', date);
        }
    }

    return result;
}
