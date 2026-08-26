'use strict';

const ObjectId = require('mongodb').ObjectId;
const log = require('npmlog');
const tools = require('./tools');
const consts = require('./consts');
const { prepareSearchFilter } = require('./prepare-search-filter');
const { getMongoDBQuery } = require('./search-query');
const { mongopagingFindWrapper, mongopagingAggregateWrapper } = require('./mongopaging-find-wrapper');
const { isEncryptedContentType } = require('./message-handler');
const { parseListId, parseListUnsubscribe } = require('./list-headers');

function createError(message, code, responseCode) {
    let err = new Error(message);
    err.code = code;
    err.responseCode = responseCode;
    err.formattedMessage = message;
    return err;
}

function normalizeReadError(err) {
    if (err.code === 'cursorerr') {
        err.responseCode = 500;
        err.formattedMessage = err.message;
        return err;
    }
    if (!err.responseCode) {
        err.responseCode = 500;
        err.code = 'InternalDatabaseError';
        err.formattedMessage = 'Database Error';
    }
    return err;
}

function asObjectId(value, code, message) {
    try {
        return value instanceof ObjectId ? value : new ObjectId(value);
    } catch (err) {
        throw createError(message || 'Invalid identifier', code || 'InputValidationError', 400);
    }
}

function getMessageListingProjection(metaData, includeHeaders) {
    const projection = {
        _id: true,
        uid: true,
        msgid: true,
        mailbox: true,
        'mimeTree.attachmentMap': true,
        hdate: true,
        idate: true,
        subject: true,
        ha: true,
        attachments: true,
        size: true,
        intro: true,
        unseen: true,
        undeleted: true,
        flagged: true,
        draft: true,
        thread: true,
        flags: true,
        verificationResults: true
    };

    projection[metaData ? 'meta' : 'meta.from'] = true;

    if (includeHeaders === true) {
        projection['mimeTree.parsedHeader'] = true;
    } else {
        for (let requiredHeader of [
            'mimeTree.parsedHeader.from',
            'mimeTree.parsedHeader.sender',
            'mimeTree.parsedHeader.to',
            'mimeTree.parsedHeader.cc',
            'mimeTree.parsedHeader.bcc',
            'mimeTree.parsedHeader.content-type',
            'mimeTree.parsedHeader.references'
        ]) {
            projection[requiredHeader] = true;
        }
    }

    return projection;
}

function safeAttachment(attachment) {
    return {
        id: attachment.id,
        filename: attachment.filename || '',
        contentType: attachment.contentType || 'application/octet-stream',
        disposition: attachment.disposition || 'attachment',
        related: !!attachment.related,
        size: Number(attachment.size) || 0,
        sizeKb: Number(attachment.sizeKb) || Math.ceil((Number(attachment.size) || 0) / 1024)
    };
}

function formatMessageListing(messageData, options) {
    options = options || {};
    let includeHeaders = options.includeHeaders;
    let parsedHeader = (messageData.mimeTree && messageData.mimeTree.parsedHeader) || {};

    if (includeHeaders === true) {
        includeHeaders = Object.keys(parsedHeader);
    }

    includeHeaders = []
        .concat(includeHeaders || [])
        .map(entry => (typeof entry === 'string' ? entry.toLowerCase().trim() : false))
        .filter(entry => entry);

    let from = parsedHeader.from ||
        parsedHeader.sender || [
            {
                name: '',
                address: (messageData.meta && messageData.meta.from) || ''
            }
        ];
    let to = [].concat(parsedHeader.to || []);
    let cc = [].concat(parsedHeader.cc || []);
    let bcc = [].concat(parsedHeader.bcc || []);

    tools.decodeAddresses(from);
    tools.decodeAddresses(to);
    tools.decodeAddresses(cc);
    tools.decodeAddresses(bcc);

    let response = {
        id: messageData.uid,
        mailbox: options.safe ? messageData.mailbox.toString() : messageData.mailbox,
        thread: options.safe ? messageData.thread.toString() : messageData.thread,
        threadMessageCount: messageData.threadMessageCount,
        hasDrafts: messageData.hasDrafts,
        from: from && from[0],
        to,
        cc,
        bcc,
        messageId: messageData.msgid || '',
        subject: messageData.subject || '',
        date: messageData.hdate ? messageData.hdate.toISOString() : null,
        idate: messageData.idate ? messageData.idate.toISOString() : null,
        intro: messageData.intro || '',
        attachments: !!messageData.ha,
        attachmentsList: (messageData.attachments || []).map(attachmentData => {
            if (options.safe) {
                return safeAttachment(attachmentData);
            }
            let hash = messageData.mimeTree && messageData.mimeTree.attachmentMap && messageData.mimeTree.attachmentMap[attachmentData.id];
            return hash ? Object.assign({ hash: hash.toString('hex') }, attachmentData) : attachmentData;
        }),
        size: Number(messageData.size) || 0,
        seen: !messageData.unseen,
        deleted: !messageData.undeleted,
        flagged: !!messageData.flagged,
        draft: !!messageData.draft,
        answered: (messageData.flags || []).includes('\\Answered') && !(messageData.flags || []).includes('$Forwarded'),
        forwarded: (messageData.flags || []).includes('$Forwarded'),
        references: (parsedHeader.references || '')
            .toString()
            .split(/\s+/)
            .filter(ref => ref)
    };

    if (!options.safe) {
        response.bimi = messageData.bimi;

        if (includeHeaders.length) {
            response.headers = {};
            for (let headerKey of includeHeaders) {
                if (parsedHeader[headerKey]) {
                    response.headers[headerKey] = parsedHeader[headerKey];
                }
            }
        }

        if (messageData.meta && 'custom' in messageData.meta) {
            response.metaData = tools.formatMetaData(messageData.meta.custom);
        }
    }

    let parsedContentType = parsedHeader['content-type'];
    if (parsedContentType) {
        response.contentType = {
            value: parsedContentType.value
        };
        if (parsedContentType.hasParams) {
            response.contentType.params = parsedContentType.params;
        }
        if (isEncryptedContentType(parsedContentType)) {
            response.encrypted = true;
        }
    }

    return response;
}

class BoundMailReader {
    constructor(handler, user) {
        this.handler = handler;
        this.user = user;
    }

    async assertUser(projection) {
        let userData = await this.handler.users.collection('users').findOne(
            { _id: this.user },
            {
                projection: projection || { _id: true },
                maxTimeMS: consts.DB_MAX_TIME_USERS
            }
        );
        if (!userData) {
            throw createError('This user does not exist', 'UserNotFound', 404);
        }
        return userData;
    }

    async getAccount() {
        let userData = await this.assertUser({
            _id: true,
            username: true,
            name: true,
            address: true,
            quota: true,
            storageUsed: true
        });
        let addresses = await this.handler.users
            .collection('addresses')
            .find(
                { user: this.user },
                {
                    projection: { address: true, name: true },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            )
            .sort({ address: 1 })
            .toArray();

        let defaultQuota = consts.MAX_STORAGE;
        if (this.handler.settingsHandler) {
            defaultQuota = await this.handler.settingsHandler.get('const:max:storage');
        }

        let aliases = [];
        let seen = new Set([userData.address]);
        for (let addressData of addresses) {
            if (!addressData.address || seen.has(addressData.address)) {
                continue;
            }
            seen.add(addressData.address);
            aliases.push({
                address: addressData.address,
                name: addressData.name || undefined
            });
        }

        return {
            id: userData._id.toString(),
            username: userData.username,
            name: userData.name || '',
            primaryAddress: userData.address,
            aliases,
            quota: {
                allowed: Number(userData.quota) || Number(defaultQuota) || consts.MAX_STORAGE,
                used: Math.max(Number(userData.storageUsed) || 0, 0)
            }
        };
    }

    async resolveMailbox(reference) {
        let query = { user: this.user };
        if (reference instanceof ObjectId || (typeof reference === 'string' && /^[a-f0-9]{24}$/i.test(reference))) {
            query._id = asObjectId(reference, 'NoSuchMailbox', 'Invalid mailbox identifier');
        } else if (typeof reference === 'string' && reference) {
            query.path = reference;
        } else {
            throw createError('Mailbox is required', 'NoSuchMailbox', 404);
        }

        let mailbox = await this.handler.database.collection('mailboxes').findOne(query, {
            projection: {
                _id: true,
                user: true,
                path: true,
                specialUse: true,
                hidden: true,
                uidNext: true
            },
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        });
        if (!mailbox) {
            throw createError('This mailbox does not exist', 'NoSuchMailbox', 404);
        }
        return mailbox;
    }

    async listMailboxes(options) {
        options = options || {};
        await this.assertUser({ _id: true });

        let sizeValues = false;
        if (options.sizes) {
            try {
                sizeValues = await this.handler.database
                    .collection('messages')
                    .aggregate([
                        { $match: { user: this.user } },
                        { $project: { mailbox: '$mailbox', size: '$size' } },
                        { $group: { _id: '$mailbox', mailboxSize: { $sum: '$size' } } }
                    ])
                    .toArray();
            } catch (err) {
                sizeValues = false;
            }
        }

        let mailboxes = await this.handler.database
            .collection('mailboxes')
            .find({ user: this.user }, { maxTimeMS: consts.DB_MAX_TIME_MAILBOXES })
            .toArray();

        if (options.specialUse) {
            mailboxes = mailboxes.filter(mailbox => mailbox.path === 'INBOX' || mailbox.specialUse);
        }
        if (!options.showHidden) {
            mailboxes = mailboxes.filter(mailbox => !mailbox.hidden);
        }

        mailboxes.sort((a, b) => {
            if (a.path === 'INBOX') return -1;
            if (b.path === 'INBOX') return 1;
            if (a.path.startsWith('INBOX/') && !b.path.startsWith('INBOX/')) return -1;
            if (!a.path.startsWith('INBOX/') && b.path.startsWith('INBOX/')) return 1;
            if (a.subscribed !== b.subscribed) return (a.subscribed ? 0 : 1) - (b.subscribed ? 0 : 1);
            return a.path.localeCompare(b.path);
        });

        let sizeMap = new Map((sizeValues || []).map(entry => [entry._id.toString(), entry.mailboxSize]));
        let results = mailboxes.map(mailbox => {
            let pathParts = mailbox.path.split('/');
            let response = {
                id: mailbox._id.toString(),
                name: pathParts.pop(),
                path: mailbox.path,
                specialUse: mailbox.specialUse,
                modifyIndex: mailbox.modifyIndex,
                subscribed: mailbox.subscribed,
                hidden: !!mailbox.hidden,
                encryptMessages: !!mailbox.encryptMessages
            };
            if (mailbox.retention) response.retention = mailbox.retention;
            if (sizeValues && sizeMap.has(mailbox._id.toString())) response.size = Number(sizeMap.get(mailbox._id.toString())) || 0;
            return response;
        });

        if (options.counters) {
            await Promise.all(
                results.flatMap((response, index) => {
                    let mailbox = mailboxes[index];
                    return [
                        this.handler
                            .getMailboxCounter(
                                {
                                    database: this.handler.database,
                                    redis: this.handler.redis
                                },
                                mailbox._id
                            )
                            .then(value => {
                                response.total = value;
                            })
                            .catch(() => false),
                        this.handler
                            .getMailboxCounter(
                                {
                                    database: this.handler.database,
                                    redis: this.handler.redis
                                },
                                mailbox._id,
                                'unseen'
                            )
                            .then(value => {
                                response.unseen = value;
                            })
                            .catch(() => false)
                    ];
                })
            );
        }

        return { success: true, results };
    }

    async getFilteredMessageCount(filter) {
        let keys = Object.keys(filter);
        if (keys.length === 2 && filter.user && filter.mailbox) {
            return await this.handler.getMailboxCounter(
                {
                    database: this.handler.database,
                    redis: this.handler.redis
                },
                filter.mailbox
            );
        }
        return await this.handler.database.collection('messages').countDocuments(filter);
    }

    async getCollapsedMessageCount(filter) {
        let result = await this.handler.database
            .collection('messages')
            .aggregate([{ $match: filter }, { $group: { _id: '$thread' } }, { $count: 'total' }], {
                allowDiskUse: true,
                maxTimeMS: consts.DB_MAX_TIME_MESSAGES
            })
            .toArray();
        return result[0] ? result[0].total : 0;
    }

    getCollapsedMessagePipeline(filter, sortAscending, paginatedField) {
        const sortDirection = sortAscending ? 1 : -1;
        const sort = { [paginatedField]: sortDirection };
        if (paginatedField !== '_id') sort._id = sortDirection;

        const group = { _id: '$thread', mid: { $first: '$_id' } };
        const tupleProjection = { _id: '$mid' };
        if (paginatedField !== '_id') {
            group[paginatedField] = { $first: `$${paginatedField}` };
            tupleProjection[paginatedField] = true;
        }

        return [{ $match: filter }, { $sort: sort }, { $group: group }, { $project: tupleProjection }];
    }

    async getCollapsedListing(filter, options) {
        let wrapper = await mongopagingAggregateWrapper(this.handler.database.collection('messages'), {
            pipeline: this.getCollapsedMessagePipeline(filter, options.sortAscending, options.paginatedField),
            limit: options.limit,
            paginatedField: options.paginatedField,
            sortAscending: options.sortAscending,
            next: options.next,
            previous: options.previous,
            aggregateOptions: {
                allowDiskUse: true,
                maxTimeMS: options.maxTimeMS
            }
        });

        let tuples = wrapper.listing.results || [];
        if (tuples.length) {
            let documents = await this.handler.database
                .collection('messages')
                .find(
                    {
                        _id: { $in: tuples.map(tuple => tuple._id) },
                        user: this.user
                    },
                    { projection: options.projection, maxTimeMS: options.maxTimeMS }
                )
                .toArray();
            let documentMap = new Map(documents.map(message => [message._id.toString(), message]));
            wrapper.listing.results = tuples.map(tuple => documentMap.get(tuple._id.toString())).filter(message => message);
        }
        return wrapper;
    }

    async addThreadCounters(messages, options) {
        options = options || {};
        if (!messages.length) return messages;

        let group = { _id: '$thread' };
        if (options.includeThreadMessageCount) group.count = { $sum: 1 };
        if (options.includeHasDrafts && !options.matchDraftReferences) group.hasDrafts = { $max: { $cond: ['$draft', 1, 0] } };
        if (options.includeHasDrafts && options.matchDraftReferences) {
            group.draftReferences = { $addToSet: { $cond: ['$draft', '$mimeTree.parsedHeader.in-reply-to', false] } };
        }

        let counts = await this.handler.database
            .collection('messages')
            .aggregate([{ $match: { user: this.user, thread: { $in: messages.map(message => message.thread) } } }, { $group: group }])
            .toArray();
        let countMap = new Map(counts.map(entry => [entry._id.toString(), entry]));

        for (let message of messages) {
            let count = countMap.get(message.thread.toString());
            if (options.includeThreadMessageCount) message.threadMessageCount = count ? count.count : undefined;
            if (options.includeHasDrafts && options.matchDraftReferences) {
                let references = new Set(
                    ((count && count.draftReferences) || [])
                        .flatMap(reference => [].concat(reference || []))
                        .flatMap(reference => reference.toString().split(/\s+/))
                        .filter(reference => reference)
                );
                message.hasDrafts = references.has(message.msgid);
            } else if (options.includeHasDrafts) {
                message.hasDrafts = !!(count && count.hasDrafts);
            }
        }
        return messages;
    }

    async applyBimi(messages) {
        let ids = new Set(
            messages
                .map(message => message.verificationResults && message.verificationResults.bimi)
                .filter(value => value && typeof value.toHexString === 'function')
                .map(value => value.toString())
        );
        if (!ids.size) return;

        let entries;
        try {
            entries = await this.handler.database
                .collection('bimi')
                .find({ _id: { $in: Array.from(ids).map(id => new ObjectId(id)) } })
                .toArray();
        } catch (err) {
            log.error('BIMI', 'messages=%s error=%s', Array.from(ids).join(','), err.message);
            return;
        }
        for (let message of messages) {
            if (!message.verificationResults || !message.verificationResults.bimi) continue;
            let entry = entries.find(candidate => candidate._id.equals(message.verificationResults.bimi));
            if (entry && entry.content && !entry.error) {
                message.bimi = {
                    certified: entry.type === 'authority',
                    url: entry.url,
                    image: `data:image/svg+xml;base64,${entry.content.toString('base64')}`,
                    type: entry.type === 'authority' ? (entry.vmc && entry.vmc.type) || 'VMC' : undefined
                };
            }
            delete message.verificationResults.bimi;
        }
    }

    normalizePagingOptions(options) {
        let max = Math.min(this.handler.maxResults, Number(options.maxLimit) || this.handler.maxResults);
        let limit = Math.min(max, Math.max(1, Number(options.limit) || 20));
        return {
            limit,
            next: options.next || options.cursor,
            previous: options.previous,
            order: options.order || 'desc'
        };
    }

    async listMessages(options) {
        options = options || {};
        let paging = this.normalizePagingOptions(options);
        let mailbox = await this.resolveMailbox(options.mailbox);
        let filter = { user: this.user, mailbox: mailbox._id };
        if (typeof options.unseen === 'boolean') filter.unseen = options.unseen;

        let total = options.collapseThreads ? await this.getCollapsedMessageCount(filter) : await this.getFilteredMessageCount(filter);
        let projection = getMessageListingProjection(options.metaData, options.includeHeaders);
        let sortAscending = paging.order === 'asc';
        let wrapper;

        if (options.collapseThreads) {
            wrapper = await this.getCollapsedListing(filter, {
                limit: paging.limit,
                projection,
                paginatedField: 'idate',
                sortAscending,
                next: paging.next,
                previous: paging.previous,
                maxTimeMS: consts.DB_MAX_TIME_MESSAGES
            });
        } else {
            let findOptions = {
                limit: paging.limit,
                query: filter,
                fields: {
                    idate: true,
                    projection,
                    maxTimeMS: consts.DB_MAX_TIME_MESSAGES
                },
                paginatedField: 'idate',
                sortAscending
            };
            if (paging.next) findOptions.next = paging.next;
            if (paging.previous) findOptions.previous = paging.previous;
            wrapper = await mongopagingFindWrapper(this.handler.database.collection('messages'), findOptions);
        }

        if (options.threadCounters || options.includeHasDrafts) {
            await this.addThreadCounters(wrapper.listing.results, {
                includeThreadMessageCount: options.threadCounters,
                includeHasDrafts: options.includeHasDrafts,
                matchDraftReferences: !options.collapseThreads
            });
        }
        if (options.includeBimi) await this.applyBimi(wrapper.listing.results);

        return {
            success: true,
            total,
            page: wrapper.page,
            previousCursor: wrapper.previousCursor,
            nextCursor: wrapper.nextCursor,
            specialUse: mailbox.specialUse,
            results: (wrapper.listing.results || []).map(entry =>
                formatMessageListing(entry, {
                    includeHeaders: options.includeHeaders,
                    safe: options.safe
                })
            )
        };
    }

    async searchMessages(options) {
        options = options || {};
        let paging = this.normalizePagingOptions(options);
        const typedKeys = ['query', 'datestart', 'dateend', 'from', 'to', 'subject', 'minSize', 'maxSize', 'attachments', 'flagged', 'unseen', 'seen'];
        if (options.rejectMixedSearch && options.q && typedKeys.some(key => options[key] !== undefined)) {
            throw createError('q can not be combined with typed search filters', 'InputValidationError', 400);
        }

        let mailbox;
        if (options.mailbox) mailbox = await this.resolveMailbox(options.mailbox);

        let filter;
        let query;
        if (options.q) {
            try {
                filter = await getMongoDBQuery(
                    {
                        database: this.handler.database,
                        users: this.handler.users
                    },
                    this.user,
                    options.q,
                    { useAndSearch: options.useAndSearch, searchable: options.searchable }
                );
            } catch (err) {
                if (err.responseCode) throw err;
                throw createError('Invalid search query', 'InputValidationError', 400);
            }
            query = options.q;
            if (mailbox) filter.mailbox = mailbox._id;
        } else {
            let prepared = await prepareSearchFilter(
                {
                    database: this.handler.database,
                    users: this.handler.users
                },
                this.user,
                { ...options, mailbox: mailbox && mailbox._id.toString() }
            );
            filter = prepared.filter;
            query = prepared.query;
        }

        filter.user = this.user;
        let total = options.collapseThreads ? await this.getCollapsedMessageCount(filter) : await this.getFilteredMessageCount(filter);
        let paginatedField = options.order !== undefined ? 'idate' : '_id';
        let sortAscending = options.order === 'asc' ? true : undefined;
        let projection = getMessageListingProjection(options.metaData, options.includeHeaders);

        const getListing = maxTimeMS => {
            if (options.collapseThreads) {
                return this.getCollapsedListing(filter, {
                    limit: paging.limit,
                    projection,
                    paginatedField,
                    sortAscending,
                    next: paging.next,
                    previous: paging.previous,
                    maxTimeMS
                });
            }
            let findOptions = {
                limit: paging.limit,
                query: filter,
                fields: { _id: true, projection, maxTimeMS },
                paginatedField,
                sortAscending
            };
            if (paging.next) findOptions.next = paging.next;
            if (paging.previous) findOptions.previous = paging.previous;
            return mongopagingFindWrapper(this.handler.database.collection('messages'), findOptions);
        };

        let wrapper;
        let started = Date.now();
        try {
            wrapper = await getListing(consts.DB_MAX_TIME_MESSAGES_SEARCH);
            if (options.onTiming) options.onTiming({ retry: false, elapsed: Date.now() - started });
        } catch (err) {
            if (err.code !== 50 || err.codeName !== 'MaxTimeMSExpired') throw err;
            started = Date.now();
            wrapper = await getListing(consts.DB_MAX_TIME_MESSAGES);
            if (options.onTiming) options.onTiming({ retry: true, elapsed: Date.now() - started });
        }

        if (options.threadCounters || options.includeHasDrafts) {
            await this.addThreadCounters(wrapper.listing.results, {
                includeThreadMessageCount: options.threadCounters,
                includeHasDrafts: options.includeHasDrafts,
                matchDraftReferences: !options.collapseThreads
            });
        }
        if (options.includeBimi) await this.applyBimi(wrapper.listing.results);

        return {
            success: true,
            query: query || '',
            total,
            page: wrapper.page,
            previousCursor: wrapper.previousCursor,
            nextCursor: wrapper.nextCursor,
            results: (wrapper.listing.results || []).map(entry =>
                formatMessageListing(entry, {
                    includeHeaders: options.includeHeaders,
                    safe: options.safe
                })
            )
        };
    }

    truncateBody(value, maxChars) {
        if (value === undefined || value === null) {
            return {
                available: false,
                content: '',
                truncated: false,
                originalLength: 0,
                returnedLength: 0
            };
        }
        value = value.toString();
        let content = value.slice(0, maxChars);
        return {
            available: true,
            content,
            truncated: content.length < value.length,
            originalLength: value.length,
            returnedLength: content.length
        };
    }

    async getMessage(options) {
        options = options || {};
        let mailbox = await this.resolveMailbox(options.mailbox);
        let uid = Number(options.uid || options.message);
        if (!Number.isInteger(uid) || uid < 1) {
            throw createError('Invalid message identifier', 'MessageNotFound', 404);
        }

        let projection = {
            _id: true,
            user: true,
            mailbox: true,
            uid: true,
            thread: true,
            hdate: true,
            idate: true,
            'mimeTree.parsedHeader': true,
            'mimeTree.attachmentMap': true,
            subject: true,
            msgid: true,
            exp: true,
            rdate: true,
            ha: true,
            size: true,
            unseen: true,
            undeleted: true,
            flagged: true,
            draft: true,
            flags: true,
            attachments: true,
            html: true,
            text: true,
            textFooter: true,
            'meta.from': true,
            'meta.to': true,
            verificationResults: true
        };
        if (options.includeSensitive) {
            delete projection['meta.from'];
            delete projection['meta.to'];
            projection.meta = true;
            projection.forwardTargets = true;
            projection.outbound = true;
        }

        let message = await this.handler.database.collection('messages').findOne(
            { user: this.user, mailbox: mailbox._id, uid },
            { projection, maxTimeMS: consts.DB_MAX_TIME_MESSAGES }
        );
        if (!message) {
            throw createError('This message does not exist', 'MessageNotFound', 404);
        }

        let parsedHeader = (message.mimeTree && message.mimeTree.parsedHeader) || {};
        let from = parsedHeader.from ||
            parsedHeader.sender || [
                {
                    name: '',
                    address: (message.meta && message.meta.from) || ''
                }
            ];
        let replyTo = parsedHeader['reply-to'];
        let to = parsedHeader.to;
        let cc = parsedHeader.cc;
        let bcc = parsedHeader.bcc;
        tools.decodeAddresses(from);
        if (replyTo) tools.decodeAddresses(replyTo);
        if (to) tools.decodeAddresses(to);
        if (cc) tools.decodeAddresses(cc);
        if (bcc) tools.decodeAddresses(bcc);

        let list;
        if (parsedHeader['list-id'] || parsedHeader['list-unsubscribe']) {
            list = {
                id: parseListId(parsedHeader['list-id']) || undefined,
                unsubscribe: parsedHeader['list-unsubscribe'] ? parseListUnsubscribe(parsedHeader['list-unsubscribe']) : undefined
            };
        }

        let hasText = (message.text !== undefined && message.text !== null) || (message.textFooter !== undefined && message.textFooter !== null);
        let hasHtml = message.html !== undefined && message.html !== null;
        let text = (message.text || '') + (message.textFooter || '');
        let html = Array.isArray(message.html) ? message.html : hasHtml ? [message.html.toString()] : [];
        if (options.replaceCidLinks && options.renderAttachmentUrl) {
            html = html.map(value =>
                value.replace(/attachment:([a-f0-9]+)\/(ATT\d+)/g, (str, mid, aid) => options.renderAttachmentUrl(aid))
            );
            text = text.replace(/attachment:([a-f0-9]+)\/(ATT\d+)/g, (str, mid, aid) => options.renderAttachmentUrl(aid));
        }

        let attachments = (message.attachments || []).map(attachment => {
            if (options.safe) {
                return safeAttachment(attachment);
            }
            let hash = message.mimeTree && message.mimeTree.attachmentMap && message.mimeTree.attachmentMap[attachment.id];
            return hash ? Object.assign({ hash: hash.toString('hex') }, attachment) : attachment;
        });

        let response = {
            success: true,
            id: uid,
            mailbox: options.safe ? mailbox._id.toString() : mailbox._id,
            thread: options.safe ? message.thread.toString() : message.thread,
            user: options.safe ? undefined : this.user,
            from: from[0],
            replyTo,
            to,
            cc,
            bcc,
            subject: message.subject || '',
            messageId: message.msgid || '',
            date: message.hdate ? message.hdate.toISOString() : null,
            idate: message.idate ? message.idate.toISOString() : null,
            list,
            expires: message.exp && message.rdate ? new Date(message.rdate).toISOString() : undefined,
            size: Number(message.size) || 0,
            seen: !message.unseen,
            deleted: !message.undeleted,
            flagged: !!message.flagged,
            draft: !!message.draft,
            answered: (message.flags || []).includes('\\Answered') && !(message.flags || []).includes('$Forwarded'),
            forwarded: (message.flags || []).includes('$Forwarded'),
            attachments,
            references: (parsedHeader.references || '')
                .toString()
                .split(/\s+/)
                .filter(reference => reference)
        };

        let parsedContentType = parsedHeader['content-type'];
        if (parsedContentType) {
            response.contentType = { value: parsedContentType.value };
            if (parsedContentType.hasParams) response.contentType.params = parsedContentType.params;
            if (isEncryptedContentType(parsedContentType)) response.encrypted = true;
        }

        if (options.safe) {
            let format = options.bodyFormat || 'text';
            response.body = {};
            if (format === 'text' || format === 'both') response.body.text = this.truncateBody(hasText ? text : undefined, this.handler.maxBodyChars);
            if (format === 'html' || format === 'both') response.body.html = this.truncateBody(hasHtml ? html.join('\n') : undefined, this.handler.maxBodyChars);
            return response;
        }

        response.envelope = {
            from: (message.meta && message.meta.from) || '',
            rcpt: []
                .concat((message.meta && message.meta.to) || [])
                .map(rcpt => rcpt && rcpt.trim())
                .filter(rcpt => rcpt)
                .map(rcpt => ({
                    value: rcpt,
                    formatted: tools.normalizeAddress(rcpt, false, { removeLabel: true, removeDots: true })
                }))
        };
        response.html = options.replaceCidLinks ? html : message.html;
        response.text = text;
        response.forwardTargets = message.forwardTargets;
        response.metaData = tools.formatMetaData(message.meta && message.meta.custom);
        if (message.meta && message.meta.files && message.meta.files.length) response.files = message.meta.files;
        if (message.meta && message.meta.reference) response.reference = message.meta.reference;

        if (message.verificationResults) {
            if (message.verificationResults.bimi) {
                try {
                    let bimi = await this.handler.database.collection('bimi').findOne({ _id: message.verificationResults.bimi });
                    if (bimi && bimi.content && !bimi.error) {
                        response.bimi = {
                            certified: bimi.type === 'authority',
                            url: bimi.url,
                            image: `data:image/svg+xml;base64,${bimi.content.toString('base64')}`,
                            type: bimi.type === 'authority' ? (bimi.vmc && bimi.vmc.type) || 'VMC' : undefined
                        };
                    }
                } catch (err) {
                    log.error('BIMI', 'message=%s error=%s', message._id, err.message);
                }
                delete message.verificationResults.bimi;
            }
            response.verificationResults = message.verificationResults;
        }

        if (message.outbound && this.handler.senderDb && this.handler.senderCollection) {
            let queued = [];
            for (let queueId of message.outbound) {
                let entries = await this.handler.senderDb.collection(this.handler.senderCollection).find({ id: queueId }).toArray();
                if (entries.length) {
                    queued.push({
                        queueId,
                        entries: entries.map(entry => ({
                            seq: entry.seq,
                            recipient: entry.recipient,
                            sendingZone: entry.sendingZone,
                            queued: entry.queued
                        }))
                    });
                }
            }
            if (queued.length) response.outbound = queued;
        }

        return response;
    }
}

class MailReadHandler {
    constructor(options) {
        this.database = options.database;
        this.users = options.users || options.database;
        this.redis = options.redis;
        this.senderDb = options.senderDb;
        this.senderCollection = options.senderCollection;
        this.settingsHandler = options.settingsHandler;
        this.getMailboxCounter = options.getMailboxCounter || tools.getMailboxCounter;
        this.maxResults = Math.max(1, Number(options.maxResults) || 50);
        this.maxBodyChars = Math.max(1, Number(options.maxBodyChars) || 50000);
    }

    bind(user) {
        let reader = new BoundMailReader(this, asObjectId(user, 'UserNotFound', 'Invalid user identifier'));
        return new Proxy(reader, {
            get(target, property) {
                let value = target[property];
                if (typeof value !== 'function') return value;
                return async (...args) => {
                    try {
                        return await value.apply(target, args);
                    } catch (err) {
                        throw normalizeReadError(err);
                    }
                };
            }
        });
    }
}

module.exports = MailReadHandler;
module.exports.formatMessageListing = formatMessageListing;
module.exports.normalizeReadError = normalizeReadError;
module.exports.safeAttachment = safeAttachment;
