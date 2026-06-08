'use strict';

const log = require('npmlog');
const ObjectId = require('mongodb').ObjectId;
const forward = require('./forward');
const autoreply = require('./autoreply');
const Maildropper = require('./maildropper');
const tools = require('./tools');
const consts = require('./consts');
const util = require('util');
const parseMimeTree = require('../imap-core/lib/indexer/parse-mime-tree');

const getHeaderEnd = source => {
    let headerEnd = source.indexOf(Buffer.from('\r\n\r\n'));
    let separatorLength = 4;

    const lfHeaderEnd = source.indexOf(Buffer.from('\n\n'));
    if (lfHeaderEnd >= 0 && (headerEnd < 0 || lfHeaderEnd < headerEnd)) {
        headerEnd = lfHeaderEnd;
        separatorLength = 2;
    }

    return { headerEnd, separatorLength };
};

const replaceRawHeaders = (source, headers) => {
    const sourceBuffer = Buffer.isBuffer(source) ? source : Buffer.from(source || '', 'binary');

    const headerBlock = Buffer.from([].concat(headers || []).join('\r\n') + '\r\n\r\n', 'binary');
    const { headerEnd, separatorLength } = getHeaderEnd(sourceBuffer);

    if (headerEnd >= 0) {
        return Buffer.concat([headerBlock, sourceBuffer.subarray(headerEnd + separatorLength)]);
    }

    return Buffer.concat([headerBlock, sourceBuffer]);
};

const cloneMimeTreeRoot = mimeTree => {
    if (!mimeTree) {
        return mimeTree;
    }

    const cloned = Object.assign({}, mimeTree);
    cloned.header = [].concat(mimeTree.header || []);
    cloned.parsedHeader = Object.assign({}, mimeTree.parsedHeader || {});

    return cloned;
};

const cloneMimeTree = mimeTree => {
    const cloned = cloneMimeTreeRoot(mimeTree);
    if (!cloned) {
        return cloned;
    }

    if (Array.isArray(mimeTree.childNodes)) {
        cloned.childNodes = mimeTree.childNodes.map(childNode => cloneMimeTree(childNode));
    }

    if (mimeTree.message) {
        cloned.message = cloneMimeTree(mimeTree.message);
    }

    return cloned;
};

const stripRecipientHeaders = mimeTree => {
    if (!mimeTree || !Array.isArray(mimeTree.header)) {
        return mimeTree;
    }

    while (mimeTree.header.length && (/^Delivered-To\s*:/i.test(mimeTree.header[0]) || /^Return-Path\s*:/i.test(mimeTree.header[0]))) {
        mimeTree.header.shift();
    }

    if (mimeTree.parsedHeader) {
        delete mimeTree.parsedHeader['delivered-to'];
        delete mimeTree.parsedHeader['return-path'];
    }

    return mimeTree;
};

const rebuildMimeTree = async (indexer, mimeTree) => {
    const outputStream = indexer.rebuild(mimeTree);
    if (!outputStream || outputStream.type !== 'stream' || !outputStream.value) {
        throw new Error('Cannot rebuild message');
    }

    return await new Promise((resolve, reject) => {
        const chunks = [];
        let chunklen = 0;

        outputStream.value
            .on('data', chunk => {
                chunks.push(chunk);
                chunklen += chunk.length;
            })
            .on('end', () => resolve(Buffer.concat(chunks, chunklen)))
            .on('error', reject);
    });
};

const addRawHeaders = (source, prependHeaders, appendHeaders) => {
    const sourceBuffer = Buffer.isBuffer(source) ? source : Buffer.from(source || '', 'binary');
    const prependHeaderLines = [].concat(prependHeaders || []).filter(line => line);
    let appendHeaderLines = [].concat(appendHeaders || []).filter(line => line);

    if (!prependHeaderLines.length && !appendHeaderLines.length) {
        return sourceBuffer;
    }

    const { headerEnd, separatorLength } = getHeaderEnd(sourceBuffer);
    let sourceHeader = '';
    let body = sourceBuffer;

    if (headerEnd >= 0) {
        sourceHeader = sourceBuffer.subarray(0, headerEnd).toString('binary');
        body = sourceBuffer.subarray(headerEnd + separatorLength);
    }

    if (sourceHeader && appendHeaderLines.length) {
        const existingHeaders = new Set(sourceHeader.split(/\r?\n/));
        appendHeaderLines = appendHeaderLines.filter(line => !existingHeaders.has(line));
    }

    const headerBlock = Buffer.from(prependHeaderLines.concat(sourceHeader || []).concat(appendHeaderLines).join('\r\n') + '\r\n\r\n', 'binary');
    return Buffer.concat([headerBlock, body]);
};

const getHeaderName = name => {
    const headerName = (name || '').toString().trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(headerName)) {
        return false;
    }
    return headerName;
};

const getHeaderLine = (name, value) => {
    const headerName = getHeaderName(name);
    if (!headerName) {
        return false;
    }

    const headerValue = (value === undefined || value === null ? '' : value.toString()).replace(/[\r\n]+[ \t]*/g, ' ');
    return headerName + ': ' + headerValue;
};

const getHeaderKey = line => (line || '').toString().split(':').shift().trim().toLowerCase();

const findHeaderIndex = (headers, name, pos) => {
    const headerName = getHeaderName(name);
    if (!headerName || !Array.isArray(headers)) {
        return -1;
    }

    let seen = 0;
    for (let i = 0; i < headers.length; i++) {
        if (getHeaderKey(headers[i]) === headerName.toLowerCase() && ++seen === pos) {
            return i;
        }
    }

    return -1;
};

class FilterHandler {
    constructor(options) {
        this.db = options.db;
        this.messageHandler = options.messageHandler;

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
            smimeCerts: true,
            smimeCipher: true,
            smimeKeyTransport: true,
            spamLevel: true,
            tagsview: true,
            mtaRelay: true
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
        const sender = options.sender || '';
        const recipient = options.recipient || userData.address;

        const filterResults = [];

        const extraHeaderLines = ['Delivered-To: ' + recipient, 'Return-Path: <' + sender + '>'];
        const visibleHeaders = [];

        let chunks = options.chunks;
        let chunklen = options.chunklen;

        if (!chunks && options.raw) {
            chunks = [options.raw];
            chunklen = options.raw.length;
        }

        const rawchunks = chunks;

        let raw;

        let prepared;
        let reusableMimeTree;
        let reusableMaildata;
        if (options.mimeTree) {
            reusableMimeTree = options.maildata ? cloneMimeTreeRoot(options.mimeTree) : cloneMimeTree(options.mimeTree);
            stripRecipientHeaders(reusableMimeTree);

            if (options.maildata) {
                reusableMaildata = options.maildata;
            } else {
                reusableMaildata = this.messageHandler.indexer.getMaildata(reusableMimeTree);
            }
            prepared = await this.messageHandler.prepareMessageAsync({
                mimeTree: cloneMimeTreeRoot(reusableMimeTree)
            });
        } else {
            raw = Buffer.concat(chunks, chunklen);
            prepared = await this.messageHandler.prepareMessageAsync({
                raw
            });
            reusableMaildata = this.messageHandler.indexer.getMaildata(prepared.mimeTree);
            reusableMimeTree = cloneMimeTreeRoot(prepared.mimeTree);
        }

        const meta = options.meta || {};
        let headersChanged = false;

        const addHeader = (name, value) => {
            const headerLine = getHeaderLine(name, value);
            if (!headerLine) {
                return false;
            }
            prepared.mimeTree.header.push(headerLine);
            visibleHeaders.push(headerLine);
            headersChanged = true;
            return true;
        };

        prepared.mimeTree.header.unshift('Return-Path: <' + Buffer.from(sender).toString('binary') + '>');
        prepared.mimeTree.header.unshift('Delivered-To: ' + Buffer.from(recipient).toString('binary'));

        prepared.mimeTree.parsedHeader['return-path'] = '<' + sender + '>';
        prepared.mimeTree.parsedHeader['delivered-to'] = '<' + recipient + '>';
        headersChanged = true;

        const refreshPrepared = async () => {
            if (!headersChanged) {
                return;
            }

            const preparedId = prepared.id;
            const preparedIdate = prepared.idate;
            const preparedFlags = prepared.flags;
            const parsedMimeTree = parseMimeTree(Buffer.from([].concat(prepared.mimeTree.header || []).join('\r\n') + '\r\n\r\n', 'binary'));

            prepared.mimeTree.parsedHeader = (parsedMimeTree && parsedMimeTree.parsedHeader) || {};
            prepared = await this.messageHandler.prepareMessageAsync({
                mimeTree: prepared.mimeTree,
                date: preparedIdate,
                flags: preparedFlags
            });

            prepared.id = preparedId;
            prepared.idate = preparedIdate;
            prepared.flags = preparedFlags;
            prepared.headers = this.messageHandler.generateIndexedHeaders(prepared.mimeTree.header);
            prepared.size = this.messageHandler.indexer.getSize(prepared.mimeTree);
            headersChanged = false;
        };

        const overrideHeaders = Array.isArray(meta?.overrides?.headers) ? meta.overrides.headers : [];
        overrideHeaders.forEach(change => {
            if (!change) {
                return;
            }

            switch (change.action) {
                case 'add':
                    addHeader(change.name, change.value);
                    break;

                case 'insert': {
                    const headerLine = getHeaderLine(change.name, change.value);
                    if (!headerLine) {
                        return;
                    }

                    const pos = Math.trunc(Number(change.pos));
                    if (!Number.isFinite(pos) || pos < 0 || pos >= prepared.mimeTree.header.length) {
                        prepared.mimeTree.header.push(headerLine);
                    } else {
                        prepared.mimeTree.header.splice(pos, 0, headerLine);
                    }
                    visibleHeaders.push(headerLine);
                    headersChanged = true;
                    break;
                }

                case 'change': {
                    const headerLine = getHeaderLine(change.name, change.value);
                    if (!headerLine) {
                        return;
                    }

                    const pos = Math.trunc(Number(change.pos));
                    const index = pos > 0 ? findHeaderIndex(prepared.mimeTree.header, change.name, pos) : -1;
                    if (index < 0) {
                        prepared.mimeTree.header.push(headerLine);
                        visibleHeaders.push(headerLine);
                        headersChanged = true;
                        return;
                    }

                    const previousHeaderLine = prepared.mimeTree.header[index];
                    prepared.mimeTree.header[index] = headerLine;
                    headersChanged = true;

                    const visibleIndex = visibleHeaders.indexOf(previousHeaderLine);
                    if (visibleIndex >= 0) {
                        visibleHeaders[visibleIndex] = headerLine;
                    }
                    break;
                }

                case 'delete': {
                    const pos = Math.max(Math.trunc(Number(change.pos)) || 1, 1);
                    const index = findHeaderIndex(prepared.mimeTree.header, change.name, pos);
                    if (index >= 0) {
                        const visibleIndex = visibleHeaders.indexOf(prepared.mimeTree.header[index]);
                        if (visibleIndex >= 0) {
                            visibleHeaders.splice(visibleIndex, 1);
                        }
                        prepared.mimeTree.header.splice(index, 1);
                        headersChanged = true;
                    }
                    break;
                }
            }
        });
        await refreshPrepared();

        let maildata = reusableMaildata;

        // default flags are empty
        const flags = [];

        // default mailbox target is INBOX
        let mailboxQueryKey = 'path';
        let mailboxQueryValue = 'INBOX';

        // allow to define mailbox
        if (options.mailbox && tools.isId(options.mailbox)) {
            mailboxQueryKey = 'mailbox';
            mailboxQueryValue = new ObjectId(options.mailbox);
        }

        const parsedHeader = (prepared.mimeTree.parsedHeader && prepared.mimeTree.parsedHeader) || {};

        const received = [].concat(parsedHeader.received || []);
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
        const forwardTargets = new Map();

        const matchingFilters = [];
        const filterActions = new Map();
        let spamActionSource = false;
        let originalSpam = false;
        let spamOverrideApplied = false;

        // check global whitelist/blacklist before filters
        if (userData.tagsview && userData.tagsview.length) {
            let from = parsedHeader.from || parsedHeader.sender;
            from = [].concat(from || []);
            tools.decodeAddresses(from);
            from = from.flatMap(address => tools.flatAddresses(address));

            if (from && from.length) {
                from = from[0];
                const domain = tools.normalizeDomain(from.address.split('@').pop());
                try {
                    const domainaccessData = await this.db.database.collection('domainaccess').findOne({
                        tag: { $in: userData.tagsview },
                        domain
                    });

                    if (domainaccessData) {
                        switch (domainaccessData.action) {
                            case 'block':
                                filterActions.set('spam', true);
                                spamActionSource = 'domainaccess';
                                matchingFilters.push(`block:${domainaccessData.tag}:${domainaccessData._id}`);
                                break;
                            case 'allow':
                                filterActions.set('spam', false);
                                spamActionSource = 'domainaccess';
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

                if (key === 'spam' && filterData.action[key] === null) {
                    return;
                }

                // if a previous filter already has set a value then do not touch it
                if (!filterActions.has(key)) {
                    filterActions.set(key, filterData.action[key]);
                    if (key === 'spam') {
                        spamActionSource = 'filter';
                    }
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
                if (!filterActions.has('spam')) {
                    filterActions.set('spam', false);
                    spamActionSource = 'spamLevel';
                }
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
                spamActionSource = 'spamLevel';
            }
        }

        const overrideFlags = Array.isArray(meta?.overrides?.flags) ? meta.overrides.flags : false;
        if (overrideFlags && spamActionSource !== 'filter') {
            // Recipient-level overrides may only replace domainaccess and user spamLevel decisions.
            originalSpam = filterActions.get('spam') === true;
            if (overrideFlags.includes('ham')) {
                if (filterActions.get('spam') !== false) {
                    spamOverrideApplied = true;
                    filterActions.set('spam', false);
                }
            } else if (overrideFlags.includes('spam') || overrideFlags.includes('softlist') || overrideFlags.includes('blacklist')) {
                if (filterActions.get('spam') !== true) {
                    spamOverrideApplied = true;
                    filterActions.set('spam', true);
                }
            }
        }

        if (!spamOverrideApplied && spamActionSource !== false) {
            let classificationInfo;
            switch (spamActionSource) {
                case 'domainaccess':
                case 'spamLevel':
                case 'filter':
                    classificationInfo = 'TBD';
                    break;
                default:
                    classificationInfo = 'None';
            }

            addHeader('WD-Mail-Classification', filterActions.get('spam') ? 'junk' : 'not-junk');
            addHeader('WD-Mail-Classification-Source', spamActionSource);
            addHeader('WD-Mail-Classification-Info', classificationInfo);
        }
        await refreshPrepared();

        const encryptMessage = async () => {
            if (isEncrypted) {
                return;
            }

            try {
                const sourceRaw = raw || (Array.isArray(chunks) && Buffer.concat(chunks, chunklen)) || (await rebuildMimeTree(this.messageHandler.indexer, prepared.mimeTree));
                const encryptionRaw = replaceRawHeaders(sourceRaw, prepared.mimeTree.header);
                const encryptResult = await this.messageHandler.encryptMessageAsync(tools.getUserEncryptionKey(userData), encryptionRaw);

                if (encryptResult) {
                    chunks = [encryptResult.raw];
                    chunklen = encryptResult.raw.length;
                    isEncrypted = true;

                    prepared = await this.messageHandler.prepareMessageAsync({
                        raw: addRawHeaders(encryptResult.raw, extraHeaderLines, visibleHeaders)
                    });
                    maildata = this.messageHandler.indexer.getMaildata(prepared.mimeTree);
                } else {
                    log.error('ENCRYPT', 'Encryption returned false, message stored unencrypted (source=%s user=%s)', 'filter_handler', userData._id);
                    this.loggelf({
                        short_message: '[ENCRYPTSKIP] Encryption returned false, message stored unencrypted',
                        _mail_action: 'encrypt_skip',
                        _user: userData._id,
                        _source: 'filter_handler'
                    });
                }
            } catch (err) {
                log.error(
                    'ENCRYPT',
                    'Encryption failed, message stored unencrypted (source=%s user=%s code=%s): %s',
                    'filter_handler',
                    userData._id,
                    err.code || 'EncryptionError',
                    err.message
                );
                this.loggelf({
                    short_message: '[ENCRYPTFAIL] Encryption failed, message stored unencrypted',
                    _mail_action: 'encrypt_fail',
                    _user: userData._id,
                    _error: err.message,
                    _code: err.code || 'EncryptionError',
                    _source: 'filter_handler'
                });
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

            if (userData.encryptForwarded && tools.getUserEncryptionKey(userData)) {
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
            this.loggelf({
                short_message: '[AUTOREPLYFAIL] Failed to queue autoreply',
                _stack: err && err.stack,
                _queue_id: prepared.id && prepared.id.toString(),
                _error: err && err.message,
                _code: err && err.code,
                _failure: 'yes',
                _mail_action: 'autoreply',
                _user: userData && userData._id && userData._id.toString(),
                _to: sender,
                _recipient: recipient,
                _message_id: prepared.mimeTree.parsedHeader['message-id']
            });
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
                        filterResults.push(spamOverrideApplied ? { spam: true, originalSpam } : { spam: true });
                    } else if (spamOverrideApplied) {
                        filterResults.push({ spam: false, originalSpam });
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
            session: options.session,
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

        if (userData.encryptMessages && tools.getUserEncryptionKey(userData)) {
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

        let targetMailboxData;
        const sourceMessageId = prepared.mimeTree?.parsedHeader?.['message-id'];
        if (sourceMessageId && prepared.msgid && prepared.hdate) {
            try {
                targetMailboxData = await this.messageHandler.getMailboxAsync({
                    user: userData._id,
                    [mailboxQueryKey]: mailboxQueryValue,
                    inboxDefault: true
                });

                let existingMessage = await this.db.database.collection('messages').findOne(
                    {
                        mailbox: targetMailboxData._id,
                        msgid: prepared.msgid,
                        hdate: prepared.hdate
                    },
                    {
                        projection: {
                            _id: true,
                            uid: true
                        }
                    }
                );

                if (existingMessage) {
                    filterResults.push({
                        duplicate: true,
                        mailbox: targetMailboxData._id.toString(),
                        path: targetMailboxData.path,
                        uid: existingMessage.uid,
                        id: existingMessage._id.toString()
                    });

                    log.silly(
                        'Filter',
                        '%s DUPLSKIP from=%s to=%s duplicate=%s hdate=%s mailbox=%s',
                        prepared.id.toString(),
                        sender,
                        recipient,
                        existingMessage._id.toString(),
                        prepared.hdate,
                        targetMailboxData._id
                    );

                    return {
                        response: {
                            userData,
                            response: 'Message dropped as duplicate of ' + existingMessage._id.toString(),
                            size: prepared.size,
                            filterResults,
                            attachments: [].concat((maildata && maildata.attachments) || []).map(att => {
                                const binaryHash = prepared.mimeTree?.attachmentMap?.[att.id];
                                const resp = Object.assign({}, att); // cheap copy
                                if (binaryHash) {
                                    resp.encodedSha256 = binaryHash.toString('base64');
                                }

                                const attachmentInfo = maildata.attachments.find(a => a.id === att.id);

                                if (attachmentInfo && attachmentInfo.fileContentHash) {
                                    resp.fileContentHash = attachmentInfo.fileContentHash;
                                }
                                return resp;
                            })
                        },
                        prepared:
                            (!isEncrypted && {
                                // reuse parsed values
                                mimeTree: reusableMimeTree,
                                maildata: reusableMaildata
                            }) ||
                            false
                    };
                }
            } catch {
                // if lookup fails, ignore it, continue storing duplicate
            }
        }

        if (targetMailboxData) {
            // mailbox already resolved during duplicate check, reuse it in addAsync
            messageOpts.mailbox = targetMailboxData;
        }

        try {
            const { data } = await this.messageHandler.addAsync(messageOpts); // returns {status, data}
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
                        size: data.size,
                        filterResults,
                        attachments: [].concat((maildata && maildata.attachments) || []).map(att => {
                            const binaryHash = prepared.mimeTree?.attachmentMap?.[att.id];
                            const resp = Object.assign({}, att); // cheap copy
                            if (binaryHash) {
                                resp.encodedSha256 = binaryHash.toString('base64');
                            }

                            const attachmentInfo = maildata.attachments.find(a => a.id === att.id);

                            if (attachmentInfo && attachmentInfo.fileContentHash) {
                                resp.fileContentHash = attachmentInfo.fileContentHash;
                            }
                            return resp;
                        })
                    },
                    prepared:
                        (!isEncrypted && {
                            // reuse parsed values
                            mimeTree: reusableMimeTree,
                            maildata: reusableMaildata
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
                        mimeTree: reusableMimeTree,
                        maildata: reusableMaildata
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

    if (query.text) {
        const { andTerms, orTerms, exactPhrases } = tools.parseFilterQueryText(query.text);

        const normalizedEmailText = maildata.text.toLowerCase().replace(/\s+/g, ' ');

        if (!andTerms.length && !orTerms.length && normalizedEmailText.indexOf(query.text.toLowerCase()) < 0) {
            // message plaintext does not match the text field value
            return false;
        }

        const andMatches = !andTerms.length || andTerms.every(term => tools.filterQueryTermMatches(normalizedEmailText, term, exactPhrases));

        const orMatches = !orTerms.length || orTerms.some(term => tools.filterQueryTermMatches(normalizedEmailText, term, exactPhrases));

        if (!(andMatches && orMatches)) {
            return false; // Filter not satisfied
        }
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
