'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const libmime = require('libmime');
const addressparser = require('nodemailer/lib/addressparser');
const MailComposer = require('nodemailer/lib/mail-composer');
const { htmlToText } = require('html-to-text');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const consts = require('../consts');
const libbase64 = require('libbase64');
const libqp = require('libqp');
const forward = require('../forward');
const Maildropper = require('../maildropper');
const util = require('util');
const roles = require('../roles');
const { preprocessAttachments } = require('../data-url');
const TaskHandler = require('../task-handler');
const { prepareSearchFilter, uidRangeStringToQuery } = require('../prepare-search-filter');
const { getMongoDBQuery /*, getElasticSearchQuery*/ } = require('../search-query');
//const { getClient } = require('../elasticsearch');
let iconv = require('iconv-lite');

const BimiHandler = require('../bimi-handler');
const {
    AddressOptionalNameArray,
    Header,
    Attachment,
    ReferenceWithAttachments,
    Bimi,
    AddressOptionalName
} = require('../schemas/request/messages-schemas');
const { MsgEnvelope, MsgVerificationResults } = require('../schemas/response/messages-schemas');

const userId = { $ref: 'wd:userId' };
const mailboxId = { $ref: 'wd:mailboxId' };
const messageId = { $ref: 'wd:messageId' };
const sessSchema = { $ref: 'wd:sess' };
const sessIPSchema = { $ref: 'wd:ip' };
const nextPageCursorSchema = { $ref: 'wd:cursor', description: 'Cursor value for next page, retrieved from nextCursor response value' };
const previousPageCursorSchema = { $ref: 'wd:cursor', description: 'Cursor value for previous page, retrieved from previousCursor response value' };

const shortTextQuery = description => ({ type: 'string', maxLength: 255, minLength: 1, wdTrim: true, wdEmpty: true, description });

const hexId24 = description => {
    const schema = {
        type: 'string',
        pattern: '^[0-9a-f]{24}$',
        minLength: 24,
        maxLength: 24,
        wdLowercase: true
    };
    if (description) {
        schema.description = description;
    }
    return schema;
};

// message uid set: comma separated list or colon separated range
const uidRangeSchema = description => ({
    type: 'string',
    pattern: '^\\d+(,\\d+)*$|^\\d+:(\\d+|\\*)$',
    wdRequired: true,
    description
});

// Joi.alternatives(Joi.date(), booleanSchema): datestring or boolean false
const expiresSchema = description => ({
    anyOf: [{ wdType: 'date', wdInstanceof: 'Date' }, { type: 'boolean', wdType: 'boolean' }],
    description
});

// ---- response building blocks: containers stay open so serialization is a
// pass-through of what the restify implementation sent ----

const AddressResponse = {
    type: 'object',
    title: 'Address',
    additionalProperties: true,
    properties: {
        name: { type: 'string', description: 'Name of the sender/recipient' },
        address: { type: 'string', description: 'Address of the sender/recipient' }
    }
};

const attachmentListItemResponse = {
    type: 'object',
    additionalProperties: true,
    properties: {
        id: { type: 'string', description: 'Attachment ID' },
        hash: { type: 'string', description: 'SHA-256 hash of the contents of the attachment' },
        filename: { type: 'string', description: 'Filename of the attachment' },
        contentType: { type: 'string', description: 'MIME type' },
        disposition: { description: 'Attachment disposition' },
        transferEncoding: { description: 'Which transfer encoding was used (actual content when fetching attachments is not encoded)' },
        related: { type: 'boolean', description: 'Was this attachment found from a multipart/related node. This usually means that this is an embedded image' },
        sizeKb: { type: 'number', description: 'Approximate size of the attachment in kilobytes' },
        size: { type: 'number', description: 'Attachment filesize in bytes' }
    }
};

const bimiResponse = {
    type: 'object',
    additionalProperties: true,
    description: 'BIMI logo info. If logo validation failed in any way, then this property is not set',
    properties: {
        certified: { type: 'boolean', description: 'If true, then this logo is from a VMC file' },
        url: { type: 'string', description: 'URL of the resource the logo was retrieved from' },
        image: { type: 'string', description: 'Data URL for the SVG image' },
        type: { type: 'string', description: 'Certificate type (only for VMC files)' }
    }
};

const contentTypeResponse = {
    type: 'object',
    title: 'ContentType',
    additionalProperties: true,
    description: 'Parsed Content-Type header. Usually needed to identify encrypted messages and such',
    properties: {
        value: { type: 'string', description: 'MIME type of the message, eg. "multipart/mixed"' },
        params: { type: 'object', additionalProperties: true, description: 'An object with Content-Type params as key-value pairs' }
    }
};

const messageListingItemResponse = {
    type: 'object',
    title: 'GetMessagesResult',
    additionalProperties: true,
    properties: {
        id: { type: 'number', description: 'ID of the Message' },
        mailbox: { type: 'string', description: 'ID of the Mailbox' },
        thread: { type: 'string', description: 'ID of the Thread' },
        threadMessageCount: { type: 'number', description: 'Amount of messages in the Thread. Included if threadCounters query argument was true' },
        hasDrafts: { type: 'boolean', description: 'If true, then the Thread contains at least one draft. Included if threadCounters query argument was true' },
        from: AddressResponse,
        to: { type: 'array', items: AddressResponse, description: 'Recipients in To: field' },
        cc: { type: 'array', items: AddressResponse, description: 'Recipients in Cc: field' },
        bcc: { type: 'array', items: AddressResponse, description: 'Recipients in Bcc: field. Usually only available for drafts' },
        messageId: { type: 'string', description: 'Message ID' },
        subject: { type: 'string', description: 'Message subject' },
        date: { description: 'Date string from header' },
        idate: { description: 'Date string of receive time' },
        intro: { type: 'string', description: 'First 128 bytes of the message' },
        attachments: { type: 'boolean', description: 'Does the message have attachments' },
        attachmentsList: { type: 'array', items: attachmentListItemResponse, description: 'Attachments for the message' },
        size: { type: 'number', description: 'Message size in bytes' },
        seen: { type: 'boolean', description: 'Is this message already seen or not' },
        deleted: {
            type: 'boolean',
            description: 'Does this message have a Deleted flag (should not have as messages are automatically deleted once this flag is set)'
        },
        flagged: { type: 'boolean', description: 'Does this message have a Flagged flag' },
        draft: { type: 'boolean', description: 'is this message a draft' },
        answered: { type: 'boolean', description: 'Does this message have a Answered flag' },
        forwarded: { type: 'boolean', description: 'Does this message have a $Forwarded flag' },
        references: { type: 'array', items: { type: 'string' }, description: 'References' },
        bimi: bimiResponse,
        contentType: contentTypeResponse,
        encrypted: { type: 'boolean', description: 'Specifies whether the message is encrypted' },
        metaData: { description: 'Custom metadata value. Included if metaData query argument was true' },
        headers: { type: 'object', additionalProperties: true, description: 'All parsed message headers. Included when includeHeaders is true' }
    }
};

const messageListingResponse = title => ({
    type: 'object',
    title,
    additionalProperties: true,
    properties: {
        success: { $ref: 'wd:successRes' },
        query: { type: 'string', description: 'Query' },
        total: { $ref: 'wd:totalRes' },
        page: { $ref: 'wd:pageRes' },
        specialUse: { description: 'Special use. If available' },
        previousCursor: { $ref: 'wd:previousCursorRes' },
        nextCursor: { $ref: 'wd:nextCursorRes' },
        results: { type: 'array', items: messageListingItemResponse, description: 'Message listing' }
    },
    required: ['success']
});
const { mongopagingFindWrapper, mongopagingAggregateWrapper } = require('../mongopaging-find-wrapper');
const { isEncryptedContentType } = require('../message-handler');

module.exports = (db, server, messageHandler, userHandler, storageHandler, settingsHandler) => {
    let maildrop = new Maildropper({
        db,
        zone: config.sender.zone,
        collection: config.sender.collection,
        gfs: config.sender.gfs,
        loopSecret: config.sender.loopSecret
    });

    const bimiHandler = BimiHandler.create({
        database: db.database,
        loggelf: message => server.loggelf(message)
    });

    const taskHandler = new TaskHandler({ database: db.database });

    const putMessage = util.promisify(messageHandler.put.bind(messageHandler));
    const updateMessage = util.promisify(messageHandler.update.bind(messageHandler));

    const getMailboxCounter = tools.getMailboxCounter;
    const asyncForward = util.promisify(forward);

    const getMessageListingProjection = (metaData, includeHeaders) => {
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
            // get all headers
            projection['mimeTree.parsedHeader'] = true;
        } else {
            // get only required headers
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
    };

    const addThreadCountersToMessageList = async (user, list, collection = 'messages') => {
        const threadIdsToCount = list.map(message => message.thread);
        const threadCounts = await db.database
            .collection(collection)
            .aggregate([
                {
                    $match: {
                        user: new ObjectId(user),
                        thread: { $in: threadIdsToCount }
                    }
                },
                {
                    $group: {
                        _id: '$thread',
                        count: {
                            $sum: 1
                        },
                        hasDrafts: {
                            $max: {
                                $cond: ['$draft', 1, 0]
                            }
                        }
                    }
                }
            ])
            .toArray();

        const threadCountMap = new Map(threadCounts.map(thread => [thread._id.toString(), thread]));

        return list.map(message => {
            const matchingThreadCount = threadCountMap.get(message.thread.toString());
            message.threadMessageCount = matchingThreadCount ? matchingThreadCount.count : undefined;
            message.hasDrafts = !!(matchingThreadCount && matchingThreadCount.hasDrafts);
            return message;
        });
    };

    const getCollapsedMessageCount = async filter => {
        const countResult = await db.database
            .collection('messages')
            .aggregate(
                [
                    {
                        $match: filter
                    },
                    {
                        $group: {
                            _id: '$thread'
                        }
                    },
                    {
                        $count: 'total'
                    }
                ],
                {
                    allowDiskUse: true,
                    maxTimeMS: consts.DB_MAX_TIME_MESSAGES
                }
            )
            .toArray();

        return countResult[0] ? countResult[0].total : 0;
    };

    const getCollapsedMessagePipeline = (filter, sortAscending, paginatedField = 'idate') => {
        const sortDirection = sortAscending ? 1 : -1;
        const sort = {
            [paginatedField]: sortDirection
        };

        if (paginatedField !== '_id') {
            sort._id = sortDirection;
        }

        return [
            {
                $match: filter
            },
            {
                $sort: sort
            },
            {
                $group: {
                    _id: '$thread',
                    message: {
                        $first: '$$ROOT'
                    }
                }
            },
            {
                $replaceRoot: {
                    newRoot: '$message'
                }
            }
        ];
    };

    const applyBimiToListing = async messages => {
        let bimiList = new Set();
        for (let messageData of messages) {
            if (
                messageData.verificationResults &&
                messageData.verificationResults.bimi &&
                typeof messageData.verificationResults.bimi.toHexString === 'function'
            ) {
                let bimiId = messageData.verificationResults.bimi.toString();
                bimiList.add(bimiId);
            }
        }

        if (bimiList.size) {
            try {
                let bimiEntries = await db.database
                    .collection('bimi')
                    .find({ _id: { $in: Array.from(bimiList).map(id => new ObjectId(id)) } })
                    .toArray();

                for (let messageData of messages) {
                    if (messageData.verificationResults && messageData.verificationResults.bimi) {
                        let bimiData = bimiEntries.find(entry => entry._id.equals(messageData.verificationResults.bimi));
                        if (bimiData?.content && !bimiData?.error) {
                            messageData.bimi = {
                                certified: bimiData.type === 'authority',
                                url: bimiData.url,
                                image: `data:image/svg+xml;base64,${bimiData.content.toString('base64')}`,
                                type: bimiData.type === 'authority' ? bimiData.vmc?.type || 'VMC' : undefined
                            };
                        }
                        delete messageData.verificationResults.bimi;
                    }
                }
            } catch (err) {
                log.error('BIMI', 'messages=%s error=%s', Array.from(bimiList).join(','), err.message);
            }
        }
    };

    const putMessageHandler = async (req, res) => {
        res.charSet('utf-8');

        const result = { value: req.params };

        if (result.value.metaData) {
            if (typeof result.value.metaData === 'object') {
                try {
                    result.value.metaData = JSON.stringify(result.value.metaData);
                } catch (err) {
                    res.status(400);
                    return res.json({
                        error: 'metaData value must be serializable to JSON',
                        code: 'InputValidationError'
                    });
                }
            } else {
                try {
                    let value = JSON.parse(result.value.metaData);
                    if (!value || typeof value !== 'object') {
                        throw new Error('Not an object');
                    }
                } catch (err) {
                    res.status(400);
                    return res.json({
                        error: 'metaData value must be valid JSON object string',
                        code: 'InputValidationError'
                    });
                }
            }
        }

        // permissions check
        if (req.user && req.user === result.value.user) {
            req.validate(roles.can(req.role).updateOwn('messages'));
        } else {
            req.validate(roles.can(req.role).updateAny('messages'));
        }

        let user = new ObjectId(result.value.user);
        let mailbox = new ObjectId(result.value.mailbox);
        let moveTo = result.value.moveTo ? new ObjectId(result.value.moveTo) : false;
        let message = result.value.message;

        let messageQuery = uidRangeStringToQuery(message);

        if (!messageQuery) {
            res.status(404);
            return res.json({
                error: 'Invalid message identifier',
                code: 'MessageNotFound'
            });
        }

        if (moveTo) {
            let info;

            let lockKey = ['mbwr', mailbox.toString()].join(':');

            let lock;
            let extendLockIntervalTimer = null;

            try {
                const LOCK_TTL = 2 * 60 * 1000;

                lock = await server.lock.waitAcquireLock(lockKey, LOCK_TTL, 1 * 60 * 1000);
                if (!lock.success) {
                    throw new Error('Failed to get folder write lock');
                }
                log.verbose(
                    'API',
                    'Acquired lock for moving messages user=%s mailbox=%s message=%s moveTo=%s lock=%s',
                    user.toString(),
                    mailbox.toString(),
                    message,
                    moveTo,
                    lock.id
                );
                extendLockIntervalTimer = setInterval(
                    () => {
                        server.lock
                            .extendLock(lock, LOCK_TTL)
                            .then(info => {
                                log.verbose('API', `Lock extended lock=${info.id} result=${info.success ? 'yes' : 'no'}`);
                            })
                            .catch(err => {
                                log.verbose('API', 'Failed to extend lock lock=%s error=%s', lock?.id, err.message);
                            });
                    },
                    Math.round(LOCK_TTL * 0.8)
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: err.message,
                    code: err.code || 'LockFail'
                });
            }

            try {
                const data = await messageHandler.moveAsync({
                    user,
                    source: { user, mailbox },
                    destination: { user, mailbox: moveTo },
                    updates: result.value,
                    messageQuery
                });
                info = data.info;
            } catch (err) {
                res.status(500); // TODO: use response code specific status
                return res.json({
                    error: err.message,
                    code: err.code
                });
            } finally {
                clearInterval(extendLockIntervalTimer);
                await server.lock.releaseLock(lock);
            }

            if (!info || !info.destinationUid || !info.destinationUid.length) {
                res.status(404);
                return res.json({
                    error: 'Could not move message, check if message exists',
                    code: 'MessageNotFound'
                });
            }

            return res.json({
                success: true,
                mailbox: moveTo,
                id: info && info.sourceUid && info.sourceUid.map((uid, i) => [uid, info.destinationUid && info.destinationUid[i]])
            });
        }

        let updated;
        try {
            updated = await updateMessage(user, mailbox, messageQuery, result.value);
        } catch (err) {
            res.status(500); // TODO: use response code specific status
            return res.json({
                error: err.message,
                code: err.code
            });
        }

        if (!updated) {
            res.status(404);
            return res.json({
                error: 'No message matched query',
                code: 'MessageNotFound'
            });
        }

        return res.json({
            success: true,
            updated
        });
    };

    server.get(
        {
            path: '/users/:user/mailboxes/:mailbox/messages',
            summary: 'List messages in a Mailbox',
            name: 'getMessages',
            description: 'Lists all messages in a mailbox',
            jsonSchema: true,
            allowUnknown: true,
            validationObjs: {
                requestBody: {},
                pathParams: {
                    user: userId,
                    mailbox: mailboxId
                },
                queryParams: {
                    unseen: {
                        $ref: 'wd:boolean',
                        description: 'If true, then returns only unseen messages. If false, then returs only seen messages. Leave blank to return all messages'
                    },
                    metaData: { $ref: 'wd:boolean', default: false, description: 'If true, then includes metaData in the response' },
                    threadCounters: {
                        $ref: 'wd:boolean',
                        default: false,
                        description: 'If true, then includes threadMessageCount and hasDrafts in the response. Counters come with some overhead'
                    },
                    collapseThreads: {
                        $ref: 'wd:boolean',
                        default: false,
                        description: 'If true, then returns only the newest or oldest message from each thread, depending on the order argument'
                    },
                    limit: { $ref: 'wd:pageLimit', wdEmpty: true },
                    order: { enum: ['asc', 'desc'], default: 'desc', wdEmpty: true, description: 'Ordering of the records by insert date' },
                    next: nextPageCursorSchema,
                    previous: previousPageCursorSchema,
                    sess: sessSchema,
                    ip: sessIPSchema,
                    includeHeaders: {
                        $ref: 'wd:boolean',
                        default: false,
                        description:
                            'If true, then includes all message headers in the response. If false, then includes only From, Sender, To, Cc, Bcc, Content-Type and References headers'
                    }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: messageListingResponse('GetMessagesResponse')
                    }
                }
            },
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('messages'));
            } else {
                req.validate(roles.can(req.role).readAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);
            let limit = result.value.limit;
            let threadCounters = result.value.threadCounters;
            let collapseThreads = result.value.collapseThreads;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;
            let sortAscending = result.value.order === 'asc';
            const filterUnseen = result.value.unseen;

            const includeHeaders = result.value.includeHeaders;

            let mailboxData;
            try {
                mailboxData = await db.database.collection('mailboxes').findOne(
                    {
                        _id: mailbox,
                        user
                    },
                    {
                        projection: {
                            path: true,
                            specialUse: true,
                            uidNext: true
                        }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!mailboxData) {
                res.status(404);
                return res.json({
                    error: 'This mailbox does not exist',
                    code: 'NoSuchMailbox'
                });
            }

            let filter = {
                mailbox
            };

            if (typeof filterUnseen === 'boolean') {
                filter.unseen = filterUnseen;
            }

            let total = collapseThreads ? await getCollapsedMessageCount(filter) : await getFilteredMessageCount(filter);
            let projection = getMessageListingProjection(result.value.metaData, includeHeaders);

            let opts = {
                limit,
                query: filter,
                fields: {
                    idate: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection,
                    maxTimeMS: consts.DB_MAX_TIME_MESSAGES
                },
                paginatedField: 'idate',
                sortAscending
            };

            if (pageNext) {
                opts.next = pageNext;
            }
            if (pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listingWrapper;
            try {
                listingWrapper = collapseThreads
                    ? await mongopagingAggregateWrapper(db.database.collection('messages'), {
                          pipeline: getCollapsedMessagePipeline(filter, sortAscending),
                          limit,
                          projection,
                          paginatedField: 'idate',
                          sortAscending,
                          next: pageNext,
                          previous: pagePrevious,
                          aggregateOptions: {
                              allowDiskUse: true,
                              maxTimeMS: consts.DB_MAX_TIME_MESSAGES
                          }
                      })
                    : await mongopagingFindWrapper(db.database.collection('messages'), opts);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (threadCounters) {
                listingWrapper.listing.results = await addThreadCountersToMessageList(user, listingWrapper.listing.results);
            }

            await applyBimiToListing(listingWrapper.listing.results);

            let response = {
                success: true,
                total,
                page: listingWrapper.page,
                previousCursor: listingWrapper.previousCursor,
                nextCursor: listingWrapper.nextCursor,
                specialUse: mailboxData.specialUse,
                results: (listingWrapper.listing.results || []).map(entry => formatMessageListing(entry, includeHeaders))
            };

            return res.json(response);
        })
    );

    const searchSchema = {
        q: { type: 'string', maxLength: 1024, minLength: 1, wdTrim: true, wdEmpty: true, description: 'Additional query string' },

        mailbox: {
            type: 'string',
            pattern: '^[0-9a-fA-F]{24}$',
            minLength: 24,
            maxLength: 24,
            wdEmpty: true,
            description: 'ID of the Mailbox'
        },
        id: {
            type: 'string',
            pattern: '^\\d+(,\\d+)*$|^\\d+:(\\d+|\\*)$',
            wdTrim: true,
            wdEmpty: true,
            description:
                'Message ID values, only applies when used in combination with `mailbox`. Either comma separated numbers (1,2,3) or colon separated range (3:15), or a range from UID to end (3:*)'
        },
        thread: {
            type: 'string',
            pattern: '^[0-9a-fA-F]{24}$',
            minLength: 24,
            maxLength: 24,
            wdEmpty: true,
            description: 'Thread ID'
        },

        or: {
            type: 'object',
            additionalProperties: false,
            description: 'At least onOne of the included terms must match',
            properties: {
                query: {
                    type: 'string',
                    maxLength: 255,
                    minLength: 1,
                    wdTrim: true,
                    wdEmpty: true,
                    description:
                        'Search string, uses MongoDB fulltext index. Covers data from message body and also common headers like from, to, subject etc.'
                },
                from: shortTextQuery('Partial match for the From: header line'),
                to: shortTextQuery('Partial match for the To: and Cc: header lines'),
                subject: shortTextQuery('Partial match for the Subject: header line')
            }
        },

        query: {
            type: 'string',
            maxLength: 255,
            minLength: 1,
            wdTrim: true,
            wdEmpty: true,
            description: 'Search string, uses MongoDB fulltext index. Covers data from message body and also common headers like from, to, subject etc.'
        },
        datestart: { wdType: 'date', wdInstanceof: 'Date', wdEmpty: true, description: 'Datestring for the earliest message storing time' },
        dateend: { wdType: 'date', wdInstanceof: 'Date', wdEmpty: true, description: 'Datestring for the latest message storing time' },
        from: shortTextQuery('Partial match for the From: header line'),
        to: shortTextQuery('Partial match for the To: and Cc: header lines'),
        subject: shortTextQuery('Partial match for the Subject: header line'),
        minSize: { type: 'number', wdType: 'number', wdEmpty: true, description: 'Minimal message size in bytes' },
        maxSize: { type: 'number', wdType: 'number', wdEmpty: true, description: 'Maximal message size in bytes' },
        attachments: { $ref: 'wd:boolean', description: 'If true, then matches only messages with attachments' },
        flagged: { $ref: 'wd:boolean', description: 'If true, then matches only messages with \\Flagged flags' },
        unseen: { $ref: 'wd:boolean', description: 'If true, then matches only messages without \\Seen flags. Takes precedence over the seen flag' },
        seen: { $ref: 'wd:boolean', description: 'If true, then matches only messages with \\Seen flags' },
        useAndSearch: { $ref: 'wd:boolean', default: false, description: 'If true, then fulltext search terms are combined with AND semantics' },
        includeHeaders: {
            $ref: 'wd:boolean',
            default: false,
            description:
                'If true, then includes all message headers in the response. If false, then includes only From, Sender, To, Cc, Bcc, Content-Type and References headers'
        },
        metaData: { $ref: 'wd:boolean', default: false, description: 'If true, then includes metaData in the response' },
        searchable: { $ref: 'wd:boolean', description: 'If true, then matches messages not in Junk or Trash' },
        sess: sessSchema,
        ip: sessIPSchema
    };

    server.get(
        {
            path: '/users/:user/search',
            jsonSchema: true,
            allowUnknown: true,
            validationObjs: {
                queryParams: {
                    ...searchSchema,
                    ...{
                        threadCounters: {
                            $ref: 'wd:boolean',
                            default: false,
                            description: 'If true, then includes threadMessageCount and hasDrafts in the response. Counters come with some overhead'
                        },
                        collapseThreads: {
                            $ref: 'wd:boolean',
                            default: false,
                            description:
                                'If true, then returns only the newest or oldest matching message from each thread, depending on the order argument'
                        },
                        limit: { $ref: 'wd:pageLimit' },
                        order: {
                            enum: ['asc', 'desc'],
                            wdEmpty: true,
                            description: 'Ordering of the records by insert date. If no order is supplied, results are sorted by heir mongoDB ObjectId.'
                        },
                        next: nextPageCursorSchema,
                        previous: previousPageCursorSchema
                    }
                },
                pathParams: { user: userId },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: messageListingResponse('SearchMessagesResponse')
                    }
                }
            },
            summary: 'Search for messages',
            description: 'This method allows searching for matching messages.',
            tags: ['Messages'],
            name: 'searchMessages'
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('messages'));
            } else {
                req.validate(roles.can(req.role).readAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let threadCounters = result.value.threadCounters;
            let collapseThreads = result.value.collapseThreads;
            let limit = result.value.limit;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;
            let order = result.value.order;

            const includeHeaders = result.value.includeHeaders;

            let filter;
            let query;

            if (result.value.q) {
                let hasESFeatureFlag = await db.redis.sismember(`feature:indexing`, user.toString());
                if (hasESFeatureFlag) {
                    // search from ElasticSearch
                    /*
                    // TODO: paging and cursors for ElasticSearch results

                    let searchQuery = await getElasticSearchQuery(db, user, result.value.q);

                    const esclient = getClient();

                    const searchOpts = {
                        index: config.elasticsearch.index,
                        body: { query: searchQuery, sort: { uid: 'desc' } }
                    };

                    let searchResult = await esclient.search(searchOpts);
                    const searchHits = searchResult && searchResult.body && searchResult.body.hits;

                    console.log('ES RESULTS');
                    console.log(util.inspect(searchResult, false, 22, true));
                    */
                }

                filter = await getMongoDBQuery(db, user, result.value.q, { useAndSearch: result.value.useAndSearch, searchable: result.value.searchable });
                query = result.value.q;
            } else {
                let prepared = await prepareSearchFilter(db, user, result.value);
                filter = prepared.filter;
                query = prepared.query;
            }

            let total = collapseThreads ? await getCollapsedMessageCount(filter) : await getFilteredMessageCount(filter);
            log.verbose('API', 'Searching %s', JSON.stringify(filter));

            const paginatedField = order !== undefined ? 'idate' : '_id';
            const sortAscending = order === 'asc' ? true : undefined;
            const projection = getMessageListingProjection(result.value.metaData, includeHeaders);

            let opts = {
                limit,
                query: filter,
                fields: {
                    // FIXME: hack to keep _id in response
                    _id: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection,
                    maxTimeMS: consts.DB_MAX_TIME_MESSAGES_SEARCH
                },
                paginatedField,
                sortAscending
            };

            if (pageNext) {
                opts.next = pageNext;
            }
            if (pagePrevious) {
                opts.previous = pagePrevious;
            }

            const getSearchListing = maxTimeMS => {
                opts.fields.maxTimeMS = maxTimeMS;

                if (!collapseThreads) {
                    return mongopagingFindWrapper(db.database.collection('messages'), opts);
                }

                return mongopagingAggregateWrapper(db.database.collection('messages'), {
                    pipeline: getCollapsedMessagePipeline(filter, sortAscending, paginatedField),
                    limit,
                    projection: opts.fields.projection,
                    paginatedField,
                    sortAscending,
                    next: pageNext,
                    previous: pagePrevious,
                    aggregateOptions: {
                        allowDiskUse: true,
                        maxTimeMS
                    }
                });
            };

            let listingWrapper;
            try {
                const start = Date.now();
                listingWrapper = await getSearchListing(consts.DB_MAX_TIME_MESSAGES_SEARCH);
                const elapsed = Date.now() - start;

                server.loggelf({
                    short_message: `[MESSAGES] Search listing`,
                    _mail_action: 'messages_search',
                    _user: user.toString(),
                    _sess: result.value.sess,
                    _ip: result.value.ip,
                    _query_time: elapsed
                });
            } catch (err) {
                if (err.code === 50 && err.codeName === 'MaxTimeMSExpired') {
                    try {
                        opts.fields.maxTimeMS = consts.DB_MAX_TIME_MESSAGES;
                        delete opts.query.mailbox; // query all mailboxes

                        if (pageNext) opts.next = pageNext;
                        if (pagePrevious) opts.previous = pagePrevious;

                        const start = Date.now();
                        listingWrapper = await getSearchListing(consts.DB_MAX_TIME_MESSAGES);
                        const elapsed = Date.now() - start;

                        server.loggelf({
                            short_message: `[MESSAGES] Search listing retry`,
                            _mail_action: 'messages_search',
                            _is_retry: true,
                            _user: user.toString(),
                            _sess: result.value.sess,
                            _ip: result.value.ip,
                            _query_time: elapsed
                        });
                    } catch (error) {
                        res.status(500);
                        return res.json({
                            error: 'MongoDB Error: ' + error.message,
                            code: 'InternalDatabaseError'
                        });
                    }
                } else {
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }
            }

            if (threadCounters) {
                listingWrapper.listing.results = await addThreadCountersToMessageList(user, listingWrapper.listing.results);
            }

            await applyBimiToListing(listingWrapper.listing.results);

            let response = {
                success: true,
                query,
                total,
                page: listingWrapper.page,
                previousCursor: listingWrapper.previousCursor,
                nextCursor: listingWrapper.nextCursor,
                results: (listingWrapper.listing.results || []).map(entry => formatMessageListing(entry, includeHeaders))
            };

            return res.json(response);
        })
    );

    server.post(
        {
            name: 'searchApplyMessages',
            path: '/users/:user/search',
            summary: 'Search and update messages',
            description:
                'This method allows applying an action to all matching messages. This is an async method so that it will return immediately. Actual modifications are run in the background.',
            tags: ['Messages'],
            jsonSchema: true,
            allowUnknown: true,
            validationObjs: {
                requestBody: {
                    ...searchSchema,
                    ...{
                        // actions to take on matching messages; when delete is
                        // true then no other action field can be set
                        action: {
                            type: 'object',
                            additionalProperties: false,
                            wdRequired: true,
                            description: 'Define actions to take with matching messages',
                            properties: {
                                moveTo: hexId24('ID of the target Mailbox if you want to move messages'),
                                seen: { $ref: 'wd:boolean', description: 'State of the \\Seen flag' },
                                flagged: { $ref: 'wd:boolean', description: 'State of the \\Flagged flag' },
                                delete: { $ref: 'wd:boolean', default: false, description: 'If true then delete all found messages' }
                            },
                            allOf: [
                                {
                                    if: { properties: { delete: { const: true } }, required: ['delete'] },
                                    then: { not: { anyOf: [{ required: ['moveTo'] }, { required: ['seen'] }, { required: ['flagged'] }] } }
                                }
                            ]
                        }
                    }
                },
                queryParams: {},
                pathParams: {
                    user: userId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SearchApplyMessagesResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                scheduled: { type: 'string', description: 'ID of the scheduled operation' },
                                existing: { type: 'boolean', description: 'Indicates if the scheduled operation already exists' }
                            },
                            required: ['success', 'scheduled', 'existing']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(
                    result.value.action && result.value.action.delete ? roles.can(req.role).deleteOwn('messages') : roles.can(req.role).updateOwn('messages')
                );
            } else {
                req.validate(
                    result.value.action && result.value.action.delete ? roles.can(req.role).deleteAny('messages') : roles.can(req.role).updateAny('messages')
                );
            }

            let user = new ObjectId(result.value.user);

            let r;
            try {
                r = await taskHandler.ensure(
                    'search-apply',
                    {
                        user,
                        // always force new task
                        time: Date.now()
                    },
                    result.value
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return res.json({
                success: true,
                existing: r.existing,
                scheduled: r.task
            });
        })
    );

    server.get(
        {
            name: 'getMessage',
            path: '/users/:user/mailboxes/:mailbox/messages/:message',
            summary: 'Request Message information',
            jsonSchema: true,
            validationObjs: {
                queryParams: {
                    replaceCidLinks: { $ref: 'wd:boolean', default: false, description: 'If true then replaces cid links' },
                    markAsSeen: { $ref: 'wd:boolean', default: false, description: 'If true then marks message as seen' },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    mailbox: mailboxId,
                    message: messageId
                },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetMessageResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'number', description: 'Message ID' },
                                mailbox: { type: 'string', description: 'ID of the Mailbox' },
                                user: { type: 'string', description: 'ID of the User' },
                                envelope: MsgEnvelope,
                                thread: { type: 'string', description: 'ID of the Thread' },
                                from: AddressResponse,
                                replyTo: { type: 'array', items: AddressResponse, description: 'Addresses for the Reply-To: header' },
                                to: { type: 'array', items: AddressResponse, description: 'Addresses for the To: header' },
                                cc: { type: 'array', items: AddressResponse, description: 'Addresses for the Cc: header' },
                                bcc: { type: 'array', items: AddressResponse, description: 'Addresses for the Bcc: header' },
                                subject: { type: 'string', description: 'Message subject' },
                                messageId: { type: 'string', description: 'Message-ID header' },
                                date: { description: 'Date string from header' },
                                idate: { description: 'Date string of receive time' },
                                list: {
                                    type: 'object',
                                    title: 'List',
                                    additionalProperties: true,
                                    description: 'If set then this message is from a mailing list',
                                    properties: {
                                        id: {
                                            type: 'object',
                                            additionalProperties: true,
                                            description: 'Parsed List-ID entry',
                                            properties: {
                                                name: { type: 'string', description: 'List-ID display name' },
                                                address: { type: 'string', description: 'List-ID value' }
                                            }
                                        },
                                        unsubscribe: {
                                            type: 'array',
                                            description: 'Parsed List-Unsubscribe entries',
                                            items: {
                                                type: 'object',
                                                additionalProperties: true,
                                                properties: {
                                                    name: { type: 'string', description: 'List-Unsubscribe display name' },
                                                    address: { type: 'string', description: 'List-Unsubscribe value' }
                                                }
                                            }
                                        }
                                    }
                                },
                                size: { type: 'number', description: 'Message size' },
                                expires: { description: 'Datestring, if set then indicates the time after this message is automatically deleted' },
                                seen: { type: 'boolean', description: 'Does this message have a Seen flag' },
                                deleted: { type: 'boolean', description: 'Does this message have a Deleted flag' },
                                flagged: { type: 'boolean', description: 'Does this message have a Flagged flag' },
                                draft: { type: 'boolean', description: 'Does this message have a Draft flag' },
                                html: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description:
                                        'An array of HTML string. Every array element is from a separate mime node, usually you would just join these to a single string'
                                },
                                text: { type: 'string', description: 'Plaintext content of the message' },
                                attachments: { type: 'array', items: attachmentListItemResponse, description: 'Attachments for the message' },
                                verificationResults: MsgVerificationResults,
                                bimi: bimiResponse,
                                contentType: contentTypeResponse,
                                metaData: { description: 'Custom metadata object set for this message' },
                                references: { type: 'array', items: { type: 'string' }, description: 'References' },
                                files: {
                                    type: 'array',
                                    description:
                                        'List of files added to this message as attachments. Applies to Drafts, normal messages do not have this property. Needed to prevent uploading the same attachment every time a draft is updated',
                                    items: {
                                        type: 'object',
                                        title: 'StoredFile',
                                        additionalProperties: true,
                                        properties: {
                                            id: { type: 'string', description: 'Storage file ID' },
                                            filename: { type: 'string', description: 'Filename of the stored file' },
                                            contentType: { type: 'string', description: 'MIME type of the stored file' },
                                            size: { type: 'number', description: 'Stored file size in bytes' },
                                            cid: { type: 'string', description: 'Content-ID of the stored file' }
                                        }
                                    }
                                },
                                outbound: {
                                    type: 'array',
                                    description: 'Outbound queue entries',
                                    items: {
                                        type: 'object',
                                        title: 'OutboundQueue',
                                        additionalProperties: true,
                                        properties: {
                                            queueId: { type: 'string', description: 'Outbound queue ID' },
                                            entries: {
                                                type: 'array',
                                                description: 'Queue entries for the outbound message',
                                                items: {
                                                    type: 'object',
                                                    title: 'OutboundQueueEntry',
                                                    additionalProperties: true,
                                                    properties: {
                                                        seq: { description: 'Queue entry sequence' },
                                                        recipient: { type: 'string', description: 'Recipient address' },
                                                        sendingZone: { type: 'string', description: 'Sending zone identifier' },
                                                        queued: { description: 'Queue entry time' }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                },
                                forwardTargets: {
                                    type: 'array',
                                    description: 'Forward targets',
                                    items: {
                                        type: 'object',
                                        title: 'ForwardTarget',
                                        additionalProperties: true,
                                        properties: {
                                            type: { type: 'string', description: 'Forward target type' },
                                            value: { type: 'string', description: 'Forward target value' }
                                        }
                                    }
                                },
                                reference: { type: 'object', additionalProperties: true, description: 'Referenced message info' },
                                answered: { type: 'boolean', description: 'Answered flag value' },
                                forwarded: { type: 'boolean', description: '$Forwarded flag value' },
                                encrypted: { type: 'boolean', description: 'True if message is encrypted' }
                            },
                            required: ['success']
                        }
                    }
                }
            },
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('messages'));
            } else {
                req.validate(roles.can(req.role).readAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);
            let message = result.value.message;
            let replaceCidLinks = result.value.replaceCidLinks;

            let messageData;
            try {
                messageData = await db.database.collection('messages').findOne(
                    {
                        mailbox,
                        uid: message
                    },
                    {
                        projection: {
                            _id: true,
                            user: true,
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
                            forwardTargets: true,
                            meta: true,
                            verificationResults: true,
                            outbound: true
                        }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }
            if (!messageData || messageData.user.toString() !== user.toString()) {
                res.status(404);
                return res.json({
                    error: 'This message does not exist',
                    code: 'MessageNotFound'
                });
            }

            let parsedHeader = (messageData.mimeTree && messageData.mimeTree.parsedHeader) || {};

            let envelope = {
                from: (messageData.meta && messageData.meta.from) || '',
                rcpt: []
                    .concat((messageData.meta && messageData.meta.to) || [])
                    .map(rcpt => rcpt && rcpt.trim())
                    .filter(rcpt => rcpt)
                    .map(rcpt => ({
                        value: rcpt,
                        formatted: tools.normalizeAddress(rcpt, false, { removeLabel: true, removeDots: true })
                    }))
            };

            let from = parsedHeader.from ||
                parsedHeader.sender || [
                    {
                        name: '',
                        address: (messageData.meta && messageData.meta.from) || ''
                    }
                ];
            tools.decodeAddresses(from);

            let replyTo = parsedHeader['reply-to'];
            if (replyTo) {
                tools.decodeAddresses(replyTo);
            }

            let to = parsedHeader.to;
            if (to) {
                tools.decodeAddresses(to);
            }

            let cc = parsedHeader.cc;
            if (cc) {
                tools.decodeAddresses(cc);
            }

            let bcc = parsedHeader.bcc;
            if (bcc) {
                tools.decodeAddresses(bcc);
            }

            let list;
            if (parsedHeader['list-id'] || parsedHeader['list-unsubscribe']) {
                let listId = parsedHeader['list-id'];
                if (listId) {
                    listId = addressparser(listId.toString());
                    tools.decodeAddresses(listId);
                    listId = listId.shift();
                }

                let listUnsubscribe = parsedHeader['list-unsubscribe'];
                if (listUnsubscribe) {
                    listUnsubscribe = addressparser(listUnsubscribe.toString());
                    tools.decodeAddresses(listUnsubscribe);
                }

                list = {
                    id: listId,
                    unsubscribe: listUnsubscribe
                };
            }

            let expires;
            if (messageData.exp) {
                expires = new Date(messageData.rdate).toISOString();
            }

            messageData.text = (messageData.text || '') + (messageData.textFooter || '');

            if (replaceCidLinks) {
                messageData.html = (messageData.html || []).map(html =>
                    html.replace(/attachment:([a-f0-9]+)\/(ATT\d+)/g, (str, mid, aid) =>
                        server.router.render('attachment', { user, mailbox, message, attachment: aid })
                    )
                );

                messageData.text = messageData.text.replace(/attachment:([a-f0-9]+)\/(ATT\d+)/g, (str, mid, aid) =>
                    server.router.render('attachment', { user, mailbox, message, attachment: aid })
                );
            }

            if (result.value.markAsSeen && messageData.unseen) {
                // we need to mark this message as seen
                try {
                    await updateMessage(user, mailbox, message, { seen: true });
                } catch (err) {
                    return res.json({
                        error: err.message
                    });
                }
                messageData.unseen = false;
            }

            let response = {
                success: true,
                id: message,
                mailbox,
                thread: messageData.thread,
                user,
                envelope,
                from: from[0],
                replyTo,
                to,
                cc,
                bcc,
                subject: messageData.subject,
                messageId: messageData.msgid,
                date: messageData.hdate ? messageData.hdate.toISOString() : null,
                idate: messageData.idate ? messageData.idate.toISOString() : null,
                list,
                expires,
                size: messageData.size,
                seen: !messageData.unseen,
                deleted: !messageData.undeleted,
                flagged: messageData.flagged,
                draft: messageData.draft,
                answered: messageData.flags.includes('\\Answered') && !messageData.flags.includes('$Forwarded'),
                forwarded: messageData.flags.includes('$Forwarded'),
                html: messageData.html,
                text: messageData.text,
                forwardTargets: messageData.forwardTargets,
                attachments: (messageData.attachments || []).map(attachmentData => {
                    let hash = messageData.mimeTree && messageData.mimeTree.attachmentMap && messageData.mimeTree.attachmentMap[attachmentData.id];
                    if (!hash) {
                        return attachmentData;
                    }
                    return Object.assign({ hash: hash.toString('hex') }, attachmentData);
                }),
                references: (parsedHeader.references || '')
                    .toString()
                    .split(/\s+/)
                    .filter(ref => ref),
                metaData: tools.formatMetaData(messageData.meta.custom)
            };

            if (messageData.meta.files && messageData.meta.files.length) {
                response.files = messageData.meta.files;
            }

            if (messageData.verificationResults) {
                if (messageData.verificationResults.bimi) {
                    try {
                        let bimiData = await db.database.collection('bimi').findOne({ _id: messageData.verificationResults.bimi });
                        if (bimiData?.content && !bimiData?.error) {
                            response.bimi = {
                                certified: bimiData.type === 'authority',
                                url: bimiData.url,
                                image: `data:image/svg+xml;base64,${bimiData.content.toString('base64')}`,
                                type: bimiData.type === 'authority' ? bimiData.vmc?.type || 'VMC' : undefined
                            };
                        }
                    } catch (err) {
                        log.error('BIMI', 'message=%s error=%s', messageData._id, err.message);
                    }

                    delete messageData.verificationResults.bimi;
                }

                response.verificationResults = messageData.verificationResults;
            }

            if (messageData.meta.reference) {
                response.reference = messageData.meta.reference;
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

            if (messageData.outbound) {
                let queued = [];
                for (let queueId of messageData.outbound) {
                    let queueEntries = await db.senderDb.collection(config.sender.collection).find({ id: queueId }).toArray();
                    if (queueEntries && queueEntries.length) {
                        queued.push({
                            queueId,
                            entries: queueEntries.map(entry => ({
                                seq: entry.seq,
                                recipient: entry.recipient,
                                sendingZone: entry.sendingZone,
                                queued: entry.queued
                            }))
                        });
                    }
                }
                if (queued.length) {
                    response.outbound = queued;
                }
            }

            return res.json(response);
        })
    );

    server.get(
        {
            name: 'getMessageSource',
            path: '/users/:user/mailboxes/:mailbox/messages/:message/message.eml',
            summary: 'Get Message source',
            description: 'This method returns the full RFC822 formatted source of the stored message',
            jsonSchema: true,
            // the restify-era handler never called res.charSet()
            charset: false,
            validationObjs: {
                pathParams: {
                    user: userId,
                    mailbox: mailboxId,
                    message: messageId
                },
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: undefined
                    }
                }
            },
            responseType: 'message/rfc822',
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('messages'));
            } else {
                req.validate(roles.can(req.role).readAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);
            let message = result.value.message;

            let messageData;
            try {
                messageData = await db.database.collection('messages').findOne(
                    {
                        mailbox,
                        uid: message
                    },
                    {
                        projection: {
                            _id: true,
                            user: true,
                            mimeTree: true
                        }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }
            if (!messageData || messageData.user.toString() !== user.toString()) {
                res.status(404);
                return res.json({
                    error: 'This message does not exist',
                    code: 'MessageNotFound'
                });
            }

            let response = messageHandler.indexer.rebuild(messageData.mimeTree);
            if (!response || response.type !== 'stream' || !response.value) {
                res.status(404);
                return res.json({
                    error: 'This message does not exist',
                    code: 'MessageNotFound'
                });
            }

            res.setHeader('Content-Type', 'message/rfc822');
            response.value.on('error', err => {
                log.error('API', 'message=%s error=%s', messageData._id, err.message);
                try {
                    res.end();
                } catch (err) {
                    //ignore
                }
            });

            return new Promise((resolve, reject) => {
                response.value.pipe(res, { end: false });
                response.value.on('end', () => {
                    res.end();
                    resolve();
                });
                response.value.on('error', err => reject(err));
            });
        })
    );

    server.get(
        {
            name: 'getMessageAttachment',
            path: '/users/:user/mailboxes/:mailbox/messages/:message/attachments/:attachment',
            summary: 'Download Attachment',
            description: 'This method returns attachment file contents in binary form',
            jsonSchema: true,
            // the restify-era handler never called res.charSet()
            charset: false,
            validationObjs: {
                queryParams: {
                    sendAsString: {
                        $ref: 'wd:boolean',
                        default: false,
                        description: 'If true then sends the original attachment back in string format with correct encoding.'
                    }
                },
                pathParams: {
                    user: userId,
                    mailbox: mailboxId,
                    message: messageId,
                    attachment: {
                        type: 'string',
                        pattern: '^ATT\\d+$',
                        wdUppercase: true,
                        wdRequired: true,
                        description: 'ID of the Attachment'
                    }
                },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: undefined
                    }
                }
            },
            responseType: 'application/octet-stream',
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('attachments'));
            } else {
                req.validate(roles.can(req.role).readAny('attachments'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);
            let message = result.value.message;
            let attachment = result.value.attachment;

            let messageData;
            try {
                messageData = await db.database.collection('messages').findOne(
                    {
                        mailbox,
                        uid: message,
                        user
                    },
                    {
                        projection: {
                            _id: true,
                            user: true,
                            attachments: true,
                            mimeTree: true
                        }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }
            if (!messageData || messageData.user.toString() !== user.toString()) {
                res.status(404);
                return res.json({
                    error: 'This message does not exist',
                    code: 'MessageNotFound'
                });
            }

            let attachmentId = messageData.mimeTree.attachmentMap && messageData.mimeTree.attachmentMap[attachment];
            if (!attachmentId) {
                res.status(404);
                return res.json({
                    error: 'This attachment does not exist',
                    code: 'AttachmentNotFound'
                });
            }

            let attachmentData;
            try {
                attachmentData = await messageHandler.attachmentStorage.get(attachmentId);
            } catch (err) {
                return res.json({
                    error: err.message
                });
            }

            let [attachmentCharset] = getAttachmentCharset(messageData.mimeTree, attachment);
            let [attachmentContentDisposition] = getAttachmentContentDisposition(messageData.mimeTree, attachment);
            let headers = {
                'Content-Type': attachmentData.contentType || 'application/octet-stream'
            };

            if (attachmentContentDisposition) {
                headers['Content-Disposition'] = attachmentContentDisposition;
            }

            res.writeHead(200, headers);

            let decode = true;

            if (attachmentData.metadata.decoded) {
                attachmentData.metadata.decoded = false;
                decode = false;
            }

            let attachmentStream;
            try {
                attachmentStream = messageHandler.attachmentStorage.createReadStream(attachmentId, attachmentData);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'Failed to read attachment',
                    code: 'InternalError'
                });
            }

            attachmentStream.once('error', err => {
                log.error('API', 'message=%s attachment=%s error=%s', messageData._id, attachment, err.message);
                try {
                    res.end();
                } catch (err) {
                    //ignore
                }
            });

            if (!decode) {
                attachmentStream.pipe(res);
                return;
            }

            if (attachmentData.transferEncoding === 'base64') {
                attachmentStream.pipe(new libbase64.Decoder()).pipe(res);
            } else if (attachmentData.transferEncoding === 'quoted-printable') {
                attachmentStream.pipe(new libqp.Decoder()).pipe(res);
            } else {
                if (!/ascii|utf[-_]?8/i.test(attachmentCharset) && result.value.sendAsString) {
                    attachmentStream.pipe(iconv.decodeStream(attachmentCharset)).pipe(res);
                    return;
                }
                attachmentStream.pipe(res);
            }
        })
    );

    server.put(
        {
            path: '/users/:user/mailboxes/:mailbox/messages/:message',
            tags: ['Messages'],
            summary: 'Update message information with path param',
            name: 'updateMessagePathParams',
            description: 'This method updates message flags and also allows to move messages to a different mailbox',
            jsonSchema: true,
            validationObjs: {
                requestBody: {
                    moveTo: hexId24('ID of the target Mailbox if you want to move messages'),

                    seen: { $ref: 'wd:boolean', description: 'State of the \\Seen flag' },
                    deleted: { $ref: 'wd:boolean', description: 'State of the \\Deleted flag' },
                    flagged: { $ref: 'wd:boolean', description: 'State of the \\Flagged flag' },
                    markHam: {
                        $ref: 'wd:boolean',
                        default: false,
                        description: 'If true then emits the marked.ham webhook for matched messages. Setting flagged=true also emits marked.ham'
                    },
                    draft: { $ref: 'wd:boolean', description: 'State of the \\Draft flag' },
                    expires: expiresSchema('Either expiration date or false to turn off autoexpiration'),
                    metaData: { $ref: 'wd:metaData', description: 'Optional metadata, must be an object or JSON formatted string' },

                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    user: userId,
                    mailbox: mailboxId,
                    message: uidRangeSchema(
                        'Message ID. Either singular or comma separated number (1,2,3) or colon separated range (3:15), or a range from UID to end (3:*)'
                    )
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'UpdateMessageResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: {
                                    type: 'array',
                                    items: { type: 'array', items: { type: 'number' } },
                                    description:
                                        'If messages were moved then lists new ID values. Array entry is an array with first element pointing to old ID and second to new ID'
                                },
                                mailbox: { type: 'string', description: 'MoveTo mailbox address' },
                                updated: { type: 'number', description: 'If messages were not moved, then indicates the number of updated messages' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(putMessageHandler)
    );
    server.put(
        {
            path: '/users/:user/mailboxes/:mailbox/messages',
            tags: ['Messages'],
            summary: 'Update Message information',
            name: 'updateMessage',
            description: 'This method updates message flags and also allows to move messages to a different mailbox',
            jsonSchema: true,
            validationObjs: {
                requestBody: {
                    message: uidRangeSchema(
                        'Message ID. Either singular or comma separated number (1,2,3) or colon separated range (3:15), or a range from UID to end (3:*)'
                    ),
                    moveTo: hexId24('ID of the target Mailbox if you want to move messages'),

                    seen: { $ref: 'wd:boolean', description: 'State of the \\Seen flag' },
                    deleted: { $ref: 'wd:boolean', description: 'State of the \\Deleted flag' },
                    flagged: { $ref: 'wd:boolean', description: 'State of the \\Flagged flag' },
                    markHam: {
                        $ref: 'wd:boolean',
                        default: false,
                        description: 'If true then emits the marked.ham webhook for matched messages. Setting flagged=true also emits marked.ham'
                    },
                    draft: { $ref: 'wd:boolean', description: 'State of the \\Draft flag' },
                    expires: expiresSchema('Either expiration date or false to turn off autoexpiration'),
                    metaData: { $ref: 'wd:metaData', description: 'Optional metadata, must be an object or JSON formatted string' },

                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    user: userId,
                    mailbox: mailboxId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'UpdateMessageResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: {
                                    type: 'array',
                                    items: { type: 'array', items: { type: 'number' } },
                                    description:
                                        'If messages were moved then lists new ID values. Array entry is an array with first element pointing to old ID and second to new ID'
                                },
                                mailbox: { type: 'string', description: 'MoveTo mailbox address' },
                                updated: { type: 'number', description: 'If messages were not moved, then indicates the number of updated messages' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(putMessageHandler)
    );

    server.del(
        {
            path: '/users/:user/mailboxes/:mailbox/messages/:message',
            tags: ['Messages'],
            name: 'deleteMessage',
            summary: 'Delete a Message',
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    mailbox: mailboxId,
                    message: messageId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SuccessResponse',
                            properties: { success: { $ref: 'wd:successRes' } },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).deleteOwn('messages'));
            } else {
                req.validate(roles.can(req.role).deleteAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);
            let message = result.value.message;

            let messageData;
            try {
                messageData = await db.database.collection('messages').findOne({
                    mailbox,
                    uid: message
                });
            } catch (err) {
                return res.json({
                    error: err.message
                });
            }

            if (!messageData || messageData.user.toString() !== user.toString()) {
                res.status(404);
                return res.json({
                    error: 'Message was not found'
                });
            }

            try {
                await messageHandler.delAsync({
                    user,
                    mailbox: { user, mailbox },
                    messageData,
                    archive: !messageData.flags.includes('\\Draft')
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: err.message
                });
            }

            return res.json({
                success: true
            });
        })
    );

    server.del(
        {
            path: '/users/:user/mailboxes/:mailbox/messages',
            tags: ['Messages'],
            summary: 'Delete all Messages from a Mailbox',
            name: 'deleteMessagesInMailbox',
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    async: { $ref: 'wd:boolean', default: false, description: 'Schedule deletion task' },

                    skipArchive: { $ref: 'wd:boolean', default: false, description: 'Skip archived messages' },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    mailbox: mailboxId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'DeleteMessagesInMailboxResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                deleted: { type: 'number', description: 'Indicates the count of deleted messages (synchronous response)' },
                                errors: { type: 'number', description: 'Indicate the count of errors during the delete (synchronous response)' },
                                existing: { type: 'boolean', description: 'Indicates if a scheduled delete task already exists (async response)' },
                                scheduled: { type: 'string', description: 'ID of the scheduled delete task (async response)' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).deleteOwn('messages'));
            } else {
                req.validate(roles.can(req.role).deleteAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);
            let mailboxData;

            try {
                mailboxData = await db.database.collection('mailboxes').findOne({
                    _id: mailbox,
                    user
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!mailboxData) {
                res.status(404);
                return res.json({
                    error: 'This mailbox does not exist',
                    code: 'NoSuchMailbox'
                });
            }

            if (result.value.async) {
                // instead of deleting immediately, schedule deletion task
                let r;

                try {
                    r = await taskHandler.ensure('clear-folder', { user, mailbox }, { user, mailbox, skipArchive: result.value.skipArchive });
                } catch (err) {
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }

                return res.json({
                    success: true,
                    existing: r.existing,
                    scheduled: r.task
                });
            }

            let cursor = await db.database
                .collection('messages')
                .find({
                    mailbox,
                    user
                })
                .sort({ uid: -1 });

            let messageData;
            let deleted = 0;
            let errors = 0;
            try {
                while ((messageData = await cursor.next())) {
                    if (!messageData || messageData.user.toString() !== user.toString()) {
                        continue;
                    }

                    try {
                        await messageHandler.delAsync({
                            user,
                            mailbox: { user, mailbox },
                            messageData,
                            archive: !messageData.flags.includes('\\Draft') && !result.value.skipArchive
                        });
                        deleted++;
                    } catch (err) {
                        errors++;
                    }
                }
                await cursor.close();
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError',
                    deleted,
                    errors
                });
            }

            try {
                // clear counters
                await db.redis.multi().del(`total:${mailbox}`).del(`unseen:${mailbox}`).exec();
            } catch (err) {
                // ignore
            }

            return res.json({
                success: true,
                deleted,
                errors
            });
        })
    );

    server.post(
        {
            path: '/users/:user/mailboxes/:mailbox/messages',
            summary: 'Upload Message',
            name: 'uploadMessage',
            description:
                'This method allows to upload either an RFC822 formatted message or a message structure to a mailbox. Raw message is stored unmodified, no headers are added or removed. If you want to generate the uploaded message from structured data fields, then do not use the raw property.',
            jsonSchema: true,
            rawBodyParam: 'raw',
            // do this before validation so we would not end up with too large html values
            preValidate: preprocessAttachments,
            validationObjs: {
                pathParams: {
                    user: userId,
                    mailbox: mailboxId
                },
                requestBody: {
                    date: { wdType: 'date', wdInstanceof: 'Date', description: 'Date' },
                    unseen: { $ref: 'wd:boolean', default: false, description: 'Is the message unseen or not' },
                    flagged: { $ref: 'wd:boolean', default: false, description: 'Is the message flagged or not' },
                    draft: { $ref: 'wd:boolean', default: false, description: 'Is the message a draft or not' },

                    raw: {
                        wdType: 'binary',
                        wdInstanceof: 'Buffer',
                        wdMaxBytes: consts.MAX_ALLOWED_MESSAGE_SIZE,
                        wdEmpty: true,
                        description:
                            'base64 encoded message source. Alternatively, you can provide this value as POST body by using message/rfc822 MIME type. If raw message is provided then it overrides any other mail configuration'
                    },

                    from: Object.assign({}, AddressOptionalName, { description: 'Address for the From: header' }),

                    replyTo: Object.assign({}, AddressOptionalName, { description: 'Address for the Reply-To: header' }),

                    to: {
                        type: 'array',
                        items: {
                            type: 'object',
                            title: 'AddressOptionalName',
                            additionalProperties: false,
                            properties: {
                                name: { type: 'string', maxLength: 255, minLength: 1, wdEmpty: true, description: 'Name of the sender' },
                                // email().failover(''): any invalid or missing
                                // value silently becomes an empty string
                                address: { type: 'string', wdValidator: 'emailFailoverEmpty', default: '', description: 'Address of the sender' }
                            }
                        },
                        description: 'Addresses for the To: header'
                    },

                    cc: Object.assign({}, AddressOptionalNameArray, { description: 'Addresses for the Cc: header' }),

                    bcc: Object.assign({}, AddressOptionalNameArray, { description: 'Addresses for the Bcc: header' }),

                    headers: {
                        type: 'array',
                        items: Header,
                        description:
                            'Custom headers for the message. If reference message is set then In-Reply-To and References headers are set automatically'
                    },

                    subject: {
                        type: 'string',
                        maxLength: 2 * 1024,
                        minLength: 1,
                        wdEmpty: true,
                        description: 'Message subject. If not then resolved from Reference message'
                    },
                    text: {
                        type: 'string',
                        maxLength: 1024 * 1024,
                        minLength: 1,
                        wdEmpty: true,
                        description: 'Plaintext message'
                    },
                    html: {
                        type: 'string',
                        maxLength: 1024 * 1024,
                        minLength: 1,
                        wdEmpty: true,
                        description: 'HTML formatted message'
                    },

                    files: {
                        type: 'array',
                        items: hexId24(),
                        description:
                            'Attachments as storage file IDs. NB! When retrieving message info then an array of objects is returned. When uploading a message then an array of IDs is used.'
                    },

                    attachments: { type: 'array', items: Attachment, description: 'Attachments for the message' },

                    metaData: { $ref: 'wd:metaData', description: 'Optional metadata, must be an object or JSON formatted string' },

                    reference: Object.assign({}, ReferenceWithAttachments, {
                        description:
                            'Optional referenced email. If uploaded message is a reply draft and relevant fields are not provided then these are resolved from the message to be replied to'
                    }),

                    replacePrevious: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            mailbox: hexId24(),
                            id: { type: 'number', wdType: 'number', wdRequired: true }
                        },
                        required: ['id'],
                        description: 'If set, then deletes a previous message when storing the new one. Useful when uploading a new Draft message.'
                    },

                    bimi: Object.assign({}, Bimi, {
                        description: 'Marks BIMI verification as passed for a domain. NB! BIMI record and logo files for the domain must be valid.'
                    }),

                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'UploadMessageResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                message: {
                                    type: 'object',
                                    additionalProperties: true,
                                    description: 'Message information',
                                    properties: {
                                        id: { type: 'number', description: 'Message ID in mailbox' },
                                        mailbox: { type: 'string', description: 'Mailbox ID the message was stored into' },
                                        size: { type: 'number', description: 'Size of the RFC822 formatted email' }
                                    }
                                },
                                previousDeleted: { type: 'boolean', description: 'Set if replacing a previous message was requested' },
                                previousDeleteError: { type: 'string', description: 'Previous delete error message' }
                            },
                            required: ['success']
                        }
                    }
                }
            },
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            if (result.value.metaData) {
                if (typeof result.value.metaData === 'object') {
                    try {
                        result.value.metaData = JSON.stringify(result.value.metaData);
                    } catch (err) {
                        res.status(400);
                        return res.json({
                            error: 'metaData value must be serializable to JSON',
                            code: 'InputValidationError'
                        });
                    }
                } else {
                    try {
                        let value = JSON.parse(result.value.metaData);
                        if (!value || typeof value !== 'object') {
                            throw new Error('Not an object');
                        }
                    } catch (err) {
                        res.status(400);
                        return res.json({
                            error: 'metaData value must be valid JSON object string',
                            code: 'InputValidationError'
                        });
                    }
                }
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).createOwn('messages'));
            } else {
                req.validate(roles.can(req.role).createAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);
            let raw = result.value.raw;
            let date = result.value.date || new Date();
            let files = [];

            let replacePrevious = result.value.replacePrevious;

            let mailboxData;
            try {
                mailboxData = await db.database.collection('mailboxes').findOne({
                    _id: mailbox,
                    user
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!mailboxData) {
                res.status(404);
                return res.json({
                    error: 'This mailbox does not exist',
                    code: 'NoSuchMailbox'
                });
            }

            let userData;
            try {
                userData = await db.users.collection('users').findOne({
                    _id: user
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!userData) {
                res.status(404);
                return res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
            }

            if (userData.quota && userData.storageUsed > userData.quota) {
                res.status(400);
                return res.json({
                    error: 'User is over quota',
                    code: 'OverQuotaError'
                });
            }

            if (userData.disabled || userData.suspended) {
                res.status(403);
                return res.json({
                    error: 'User account is disabled',
                    code: 'UserDisabled'
                });
            }

            let extraHeaders = [];
            let extraAttachments = [];
            let referencedMessage = await getReferencedMessage(userData, result.value);

            if (referencedMessage) {
                if (['reply', 'replyAll'].includes(result.value.reference.action) && referencedMessage.inReplyTo) {
                    extraHeaders.push({ key: 'In-Reply-To', value: referencedMessage.inReplyTo });
                }
                if (referencedMessage.references) {
                    extraHeaders.push({ key: 'References', value: referencedMessage.references });
                }
                extraAttachments = referencedMessage.attachments || [];
                result.value.draft = true; // only draft messages can reference to another message
            }

            if (result.value.files && result.value.files.length) {
                for (let file of result.value.files) {
                    try {
                        let fileData = await storageHandler.get(userData._id, new ObjectId(file));
                        if (fileData) {
                            extraAttachments.push(fileData);
                            let fileEntry = {
                                id: fileData.id,
                                filename: fileData.filename,
                                contentType: fileData.contentType,
                                size: fileData.size,
                                cid: fileData.cid
                            };
                            files.push(fileEntry);
                        }
                    } catch (err) {
                        log.error('API', 'STORAGEFAIL user=%s file=%s error=%s', userData._id, file, err.message);
                    }
                }
            }

            let data = {
                from: result.value.from || { name: userData.name, address: userData.address },
                date,
                replyTo: result.value.replyTo,
                to: result.value.to ? result.value.to.filter(toObj => toObj.address !== '') : undefined,
                cc: result.value.cc,
                bcc: result.value.bcc,
                subject: result.value.subject || referencedMessage.subject,
                text: result.value.text,
                html: result.value.html,
                headers: extraHeaders.concat(result.value.headers || []),
                attachments: extraAttachments.concat(result.value.attachments || []),
                disableFileAccess: true,
                disableUrlAccess: true,
                keepBcc: true,

                newline: '\r\n'
            };

            // ensure plaintext content if html is provided
            if (data.html && !data.text) {
                try {
                    // might explode on long or strange strings
                    data.text = htmlToText(data.html);
                } catch (E) {
                    // ignore
                }
            }

            // remove empty keys
            for (let key of Object.keys(data)) {
                if (!data[key]) {
                    delete data[key];
                }
            }

            let compiler = new MailComposer(data);
            let compiled = compiler.compile();
            let envelope = compiled.getEnvelope();

            let envelopeFrom = envelope.from;

            if (result.value.draft) {
                // override From addresses for drafts
                envelope.from = data.from.address = await validateFromAddress(userData, envelopeFrom);
            }

            if (!data.to && !envelope.to.length && referencedMessage && ['reply', 'replyAll'].includes(result.value.reference.action)) {
                envelope.to = envelope.to.concat(parseAddresses(referencedMessage.replyTo || [])).concat(parseAddresses(referencedMessage.replyCc || []));
                data.to = [].concat(referencedMessage.replyTo || []);
                data.cc = [].concat(referencedMessage.replyCc || []);
            }

            if (!req.params.raw) {
                raw = await getCompiledMessage(data, {
                    isDraft: !!result.value.draft
                });
            }

            if (!raw || !raw.length) {
                res.status(400);
                return res.json({
                    error: 'Empty message provided',
                    code: 'EmptyMessage'
                });
            }

            if ((userData.encryptMessages || mailboxData.encryptMessages) && !result.value.draft) {
                // encrypt message if global encryption ON or encrypted target mailbox
                try {
                    let encryptResult = await messageHandler.encryptMessageAsync(tools.getUserEncryptionKey(userData), raw);
                    if (encryptResult) {
                        raw = encryptResult.raw;
                    } else {
                        log.error(
                            'ENCRYPT',
                            'Encryption returned false, message stored unencrypted (source=%s user=%s ip=%s)',
                            'api_messages',
                            user,
                            result.value.ip || req.remoteAddress
                        );
                        server.loggelf({
                            short_message: '[ENCRYPTSKIP] Encryption returned false, message stored unencrypted',
                            _mail_action: 'encrypt_skip',
                            _user: user,
                            _ip: result.value.ip || req.remoteAddress,
                            _source: 'api_messages'
                        });
                    }
                } catch (err) {
                    log.error(
                        'ENCRYPT',
                        'Encryption failed, message stored unencrypted (source=%s user=%s ip=%s code=%s): %s',
                        'api_messages',
                        user,
                        result.value.ip || req.remoteAddress,
                        err.code || 'EncryptionError',
                        err.message
                    );
                    server.loggelf({
                        short_message: '[ENCRYPTFAIL] Encryption failed, message stored unencrypted',
                        _mail_action: 'encrypt_fail',
                        _user: user,
                        _error: err.message,
                        _code: err.code || 'EncryptionError',
                        _ip: result.value.ip || req.remoteAddress,
                        _source: 'api_messages'
                    });
                }
            }

            let verificationResults = false;
            if (result.value.bimi) {
                try {
                    let bimiRecord = await bimiHandler.fetchByDomain(result.value.bimi.domain, result.value.bimi.selector);
                    if (bimiRecord) {
                        verificationResults = {
                            bimi: bimiRecord._id
                        };
                    }
                } catch (err) {
                    log.error('API', 'BIMIFAIL domain=%s selector=%s error=%s', result.value.bimi.domain, result.value.bimi.selector || '', err.message);
                }
            }

            let status, messageData;
            try {
                const resp = await messageHandler.addAsync({
                    user,
                    mailbox: mailboxData,
                    meta: {
                        source: 'API',
                        from: '',
                        origin: result.value.ip || '127.0.0.1',
                        transtype: 'UPLOAD',
                        time: date,
                        custom: result.value.metaData || '',
                        reference: referencedMessage
                            ? {
                                  action: result.value.reference.action,
                                  mailbox: result.value.reference.mailbox,
                                  id: result.value.reference.id
                              }
                            : false,
                        envelope,
                        files
                    },
                    session: result.value.sess,
                    date,
                    verificationResults,
                    flags: []
                        .concat('unseen' in result.value ? (result.value.unseen ? [] : '\\Seen') : [])
                        .concat('flagged' in result.value ? (result.value.flagged ? '\\Flagged' : []) : [])
                        .concat('draft' in result.value ? (result.value.draft ? '\\Draft' : []) : []),
                    raw,
                    referencedMessage: referencedMessage || false
                });
                status = resp.status;
                messageData = resp.data;
            } catch (err) {
                res.status(500); // TODO: use response code specific status
                return res.json({
                    error: err.message,
                    code: err.imapResponse
                });
            }

            let response = {
                success: status,
                message: messageData
                    ? {
                          id: messageData.uid,
                          mailbox: messageData.mailbox,
                          size: messageData.size
                      }
                    : false
            };

            if (replacePrevious) {
                // delete previous version of the message
                let previousMessageMailbox = replacePrevious.mailbox ? new ObjectId(replacePrevious.mailbox) : mailboxData._id;
                let previousMessage = replacePrevious.id;

                let previousMessageData;
                try {
                    previousMessageData = await db.database.collection('messages').findOne({
                        mailbox: previousMessageMailbox,
                        uid: previousMessage
                    });

                    if (!previousMessageData || previousMessageData.user.toString() !== user.toString()) {
                        throw new Error('Message was not found');
                    }

                    response.previousDeleted = await messageHandler.delAsync({
                        user,
                        mailbox: {
                            user,
                            mailbox: previousMessageMailbox
                        },
                        messageData: previousMessageData,
                        archive: !previousMessageData.flags.includes('\\Draft')
                    });
                } catch (err) {
                    response.previousDeleteError = 'Failed to delete previous message. ' + err.message;

                    log.error(
                        'API',
                        'action=add-message message=%s previous=%s error=%s',
                        messageData._id,
                        previousMessage,
                        'Failed to delete previous message. ' + err.message
                    );
                }
            }

            return res.json(response);
        })
    );

    server.post(
        {
            path: '/users/:user/mailboxes/:mailbox/messages/:message/forward',
            validationObjs: {
                pathParams: {
                    user: userId,
                    mailbox: mailboxId,
                    message: messageId
                },
                queryParams: {},
                requestBody: {
                    target: { type: 'number', minimum: 1, maximum: 1000, wdType: 'number', description: 'Number of original forwarding target' },
                    addresses: {
                        type: 'array',
                        items: { type: 'string', wdValidator: 'email' },
                        description: 'An array of additional forward targets'
                    },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'ForwardStoredMessageResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                queueId: { type: 'string', description: 'Message ID in outbound queue' },
                                forwarded: {
                                    type: 'array',
                                    description: 'Information about forwarding targets',
                                    items: {
                                        type: 'object',
                                        title: 'Forwarded',
                                        additionalProperties: true,
                                        properties: {
                                            seq: { type: 'string', description: 'Sequence ID' },
                                            type: { type: 'string', description: 'Target type' },
                                            value: { type: 'string', description: 'Target address' }
                                        }
                                    }
                                }
                            },
                            required: ['success']
                        }
                    }
                }
            },
            summary: 'Forward stored Message',
            name: 'forwardStoredMessage',
            jsonSchema: true,
            description:
                'This method allows either to re-forward a message to an original forward target or forward it to some other address. This is useful if a user had forwarding turned on but the message was not delivered so you can try again. Forwarding does not modify the original message.',
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).createOwn('messages'));
            } else {
                req.validate(roles.can(req.role).createAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);
            let message = result.value.message;

            let messageData;
            let userData;
            try {
                messageData = await db.database.collection('messages').findOne(
                    {
                        mailbox,
                        uid: message
                    },
                    {
                        projection: {
                            _id: true,
                            mailbox: true,
                            user: true,
                            uid: true,
                            'meta.from': true,
                            'meta.to': true,
                            mimeTree: true,
                            forwardTargets: true
                        }
                    }
                );

                userData = await db.database.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            _id: true,
                            mtaRelay: true
                        }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }
            if (!messageData || messageData.user.toString() !== user.toString()) {
                res.status(404);
                return res.json({
                    error: 'This message does not exist',
                    code: 'MessageNotFound'
                });
            }

            let forwardTargets = [];

            [].concat(result.value.addresses || []).forEach(address => {
                forwardTargets.push({ type: 'mail', value: address });
            });

            if (messageData.forwardTargets) {
                if (result.value.target) {
                    forwardTargets = forwardTargets.concat(messageData.forwardTargets[result.value.target - 1] || []);
                } else if (!forwardTargets.length) {
                    forwardTargets = messageData.forwardTargets;
                }
            }

            if (!forwardTargets || !forwardTargets.length) {
                return res.json({
                    success: true,
                    forwarded: []
                });
            }

            let response = messageHandler.indexer.rebuild(messageData.mimeTree);
            if (!response || response.type !== 'stream' || !response.value) {
                res.status(404);
                return res.json({
                    error: 'This message does not exist',
                    code: 'MessageNotFound'
                });
            }

            let forwardData = {
                db,
                maildrop,
                parentId: messageData._id,
                sender: messageData.meta.from,
                recipient: messageData.meta.to,
                targets: forwardTargets,
                stream: response.value,
                userData
            };

            let queueId;
            try {
                queueId = await asyncForward(forwardData);
            } catch (err) {
                log.error(
                    'API',
                    '%s FRWRDFAIL from=%s to=%s target=%s error=%s',
                    forwardData.parentId.toString(),
                    forwardData.sender,
                    forwardData.recipient,
                    forwardTargets.map(target => (typeof target.value === 'string' ? target.value : 'relay')).join(','),
                    err.message
                );
            }

            if (queueId) {
                log.silly(
                    'API',
                    '%s FRWRDOK id=%s from=%s to=%s target=%s',
                    forwardData.parentId.toString(),
                    queueId,
                    forwardData.sender,
                    forwardData.recipient,
                    forwardTargets.map(target => (typeof target.value === 'string' ? target.value : 'relay')).join(',')
                );
            }

            try {
                await db.database.collection('messages').updateOne(
                    {
                        _id: messageData._id,
                        mailbox: messageData.mailbox,
                        uid: messageData.uid
                    },
                    {
                        $addToSet: {
                            outbound: queueId
                        }
                    }
                );
            } catch (err) {
                // ignore
            }

            return res.json({
                success: true,
                queueId,
                forwarded: forwardTargets.map((target, i) => ({
                    seq: leftPad((i + 1).toString(16), '0', 3),
                    type: target.type,
                    value: target.value
                }))
            });
        })
    );

    server.post(
        {
            path: '/users/:user/mailboxes/:mailbox/messages/:message/submit',
            validationObjs: {
                pathParams: {
                    user: userId,
                    mailbox: mailboxId,
                    message: messageId
                },
                queryParams: {},
                requestBody: {
                    deleteFiles: { $ref: 'wd:boolean', description: 'If true then deletes attachment files listed in metaData.files array' },
                    sendTime: { wdType: 'date', wdInstanceof: 'Date', description: 'Datestring for delivery if message should be sent some later time' },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SubmitStoredMessageResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                queueId: { type: 'string', description: 'Message ID in outbound queue' },
                                message: {
                                    type: 'object',
                                    title: 'Message',
                                    additionalProperties: true,
                                    description: 'Message information',
                                    properties: {
                                        id: { type: 'number', description: 'Message ID in mailbox' },
                                        mailbox: { type: 'string', description: 'Mailbox ID the message was stored into' },
                                        size: { type: 'number', description: 'Size of the RFC822 formatted email' }
                                    }
                                }
                            },
                            required: ['success']
                        }
                    }
                }
            },
            summary: 'Submit Draft for delivery',
            name: 'submitStoredMessage',
            jsonSchema: true,
            description: 'This method allows to submit a draft message for delivery. Draft is moved to Sent mail folder.',
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).createOwn('messages'));
            } else {
                req.validate(roles.can(req.role).createAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);
            let message = result.value.message;
            let deleteFiles = result.value.deleteFiles;
            let sendTime = result.value.sendTime;

            let userData;
            try {
                userData = await db.users.collection('users').findOne({
                    _id: user
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!userData) {
                res.status(404);
                return res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
            }

            if (userData.disabled || userData.suspended) {
                res.status(403);
                return res.json({
                    error: 'User account is disabled',
                    code: 'UserDisabled'
                });
            }

            let messageData;
            try {
                messageData = await db.database.collection('messages').findOne({
                    mailbox,
                    uid: message,
                    user
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!messageData) {
                res.status(404);
                return res.json({
                    error: 'This message does not exist',
                    code: 'MessageNotFound'
                });
            }

            if (!messageData.draft) {
                res.status(400);
                return res.json({
                    error: 'This message is not a draft',
                    code: 'MessageNotDraft'
                });
            }

            let now = new Date();
            if (!sendTime || sendTime < now) {
                sendTime = now;
            }

            // update message headers, use updated Date value
            if (messageData.mimeTree.header) {
                let headerFound = false;
                for (let i = 0; i < messageData.mimeTree.header.length; i++) {
                    if (/^date\s*:/i.test(messageData.mimeTree.header[i])) {
                        headerFound = true;
                        messageData.mimeTree.header[i] = `Date: ${sendTime.toUTCString().replace(/GMT/, '+0000')}`;
                    }
                }
                if (!headerFound) {
                    messageData.mimeTree.header.push(`Date: ${sendTime.toUTCString().replace(/GMT/, '+0000')}`);
                }

                messageData.mimeTree.parsedHeader.date = sendTime;

                // update Draft message entry. This is later moved to Sent Mail folder so the Date values
                // must be correct ones
                await db.database.collection('messages').updateOne(
                    {
                        _id: messageData._id
                    },
                    {
                        $set: {
                            'mimeTree.header': messageData.mimeTree.header,
                            'mimeTree.parsedHeader.date': sendTime,
                            hdate: sendTime
                        }
                    }
                );
            }

            let envelope = messageData.meta.envelope;
            if (!envelope) {
                // fetch envelope data from message headers
                envelope = {
                    from: parseAddresses(messageData.mimeTree.parsedHeader.from).shift() || '',
                    to: Array.from(
                        new Set(
                            []
                                .concat(parseAddresses(messageData.mimeTree.parsedHeader.to) || [])
                                .concat(parseAddresses(messageData.mimeTree.parsedHeader.cc) || [])
                                .concat(parseAddresses(messageData.mimeTree.parsedHeader.bcc) || [])
                        )
                    )
                };

                let envelopeFrom = envelope.from;
                envelope.from = await validateFromAddress(userData, envelopeFrom);
            }

            if (!envelope.to || !envelope.to.length) {
                return res.json({
                    success: true
                });
            }

            let maxRecipients = Number(userData.recipients) || (await settingsHandler.get('const:max:recipients'));
            let maxRptsTo = await settingsHandler.get('const:max:rcpt_to');

            // Trying to send more than allowed recipients count per email
            if (envelope.to.length > maxRptsTo) {
                res.status(403);
                return res.json({
                    error: 'Your email has too many recipients',
                    code: 'TooMany'
                });
            }

            let limitCheck;
            try {
                limitCheck = await messageHandler.counters.asyncTTLCounter('wdr:' + userData._id.toString(), 0, maxRecipients, false);
            } catch (err) {
                log.error('API', 'Failed to check draft submit rate limit for user=%s message=%s error=%s', userData._id, messageData._id, err.message);
                res.status(500);
                return res.json({
                    error: 'Database error',
                    code: 'InternalDatabaseError'
                });
            }

            // Already limited. Or would hit the limit with this message.
            let { success: notLimited, value: messagesSent } = limitCheck || {};

            let ttl = limitCheck.ttl;

            let ttlHuman = false;
            if (ttl && ttl > 0) {
                if (ttl < 60) {
                    ttlHuman = ttl + ' seconds';
                } else if (ttl < 3600) {
                    ttlHuman = Math.round(ttl / 60) + ' minutes';
                } else {
                    ttlHuman = Math.round(ttl / 3600) + ' hours';
                }
            }

            if (!notLimited || messagesSent + envelope.to.length > maxRecipients) {
                res.status(403);
                log.info('API', 'RCPTDENY denied sent=%s allowed=%s expires=%ss.', messagesSent, maxRecipients, ttl);
                return res.json({
                    error: 'You reached a daily sending limit for your account' + (ttl && ttl >= 0 ? '. Limit expires in ' + ttlHuman : ''),
                    code: 'RateLimitedError'
                });
            }

            let rebuilder = messageHandler.indexer.rebuild(messageData.mimeTree);
            if (!rebuilder || rebuilder.type !== 'stream' || !rebuilder.value) {
                res.status(404);
                return res.json({
                    error: 'This message does not exist',
                    code: 'MessageNotFound'
                });
            }

            let queueId = await submitMessage(userData, envelope, sendTime, rebuilder.value, {
                origin: result.value.ip
            });

            let response = {
                success: true
            };

            if (queueId) {
                response.queueId = queueId;
                const moved = await messageHandler.moveAsync({
                    user,
                    source: {
                        user: messageData.user,
                        mailbox: messageData.mailbox
                    },
                    destination: {
                        user: messageData.user,
                        specialUse: '\\Sent'
                    },
                    updates: {
                        draft: false,
                        seen: true,
                        outbound: [queueId]
                    },
                    messageQuery: messageData.uid
                });

                response.message = {
                    id: moved.info && moved.info.destinationUid && moved.info.destinationUid[0],
                    mailbox: moved.info && moved.info.target,
                    size: messageData.size
                };
            }

            if (messageData.meta.reference) {
                let setFlag;
                switch (messageData.meta.reference.action) {
                    case 'reply':
                    case 'replyAll':
                        setFlag = '\\Answered';
                        break;
                    case 'forward':
                        setFlag = { $each: ['\\Answered', '$Forwarded'] };
                        break;
                }

                if (setFlag) {
                    try {
                        let mailbox = new ObjectId(messageData.meta.reference.mailbox);
                        let r = await db.database.collection('messages').findOneAndUpdate(
                            {
                                mailbox,
                                uid: messageData.meta.reference.id,
                                user: messageData.user
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
                        if (r && r.value) {
                            let messageData = r.value;

                            let notifyEntries = [
                                {
                                    command: 'FETCH',
                                    uid: messageData.uid,
                                    flags: messageData.flags,
                                    message: messageData._id,
                                    thread: messageData.thread,
                                    unseenChange: false
                                }
                            ];

                            await new Promise(resolve => {
                                messageHandler.notifier.addEntries(mailbox, notifyEntries, () => {
                                    messageHandler.notifier.fire(messageData.user);
                                    resolve();
                                });
                            });
                        }
                    } catch (err) {
                        // not important
                    }
                }
            }

            if (deleteFiles && messageData.meta.files && messageData.meta.files.length) {
                for (let fileData of messageData.meta.files) {
                    try {
                        await storageHandler.delete(userData._id, new ObjectId(fileData.id));
                    } catch (err) {
                        log.error('API', 'STORAGEDELFAIL user=%s file=%s error=%s', userData._id, fileData.id, err.message);
                    }
                }
            }

            for (const to of Array.isArray(envelope.to) ? envelope.to : [envelope.to]) {
                server.loggelf({
                    short_message: `[RCPT TO: ${to}] ${result.value.sess}`,
                    _mail_action: 'rcpt_to',
                    _user: userData._id.toString(),
                    _queue_id: queueId,
                    _sent_mailbox: response.message && response.message.mailbox,
                    _sent_mailbox_path: response.message && response.message.mailboxPath,
                    _sent_message: response.message && response.message.id,
                    _send_time: sendTime && sendTime.toISOString && sendTime.toISOString(),
                    _from: envelope.from,
                    _to: to,
                    _message_id: messageData.msgid,
                    _subject: messageData.subject,
                    _sess: result.value.sess,
                    _ip: result.value.ip,
                    _limit_allowed: userData.recipients,
                    _limit_sent: messagesSent + envelope.to.length
                });
            }

            server.loggelf({
                short_message: '[SUBMIT] draft',
                _mail_action: 'submit_draft',
                _user: userData._id.toString(),
                _queue_id: queueId,
                _sent_mailbox: response.message && response.message.mailbox,
                _sent_mailbox_path: response.message && response.message.mailboxPath,
                _sent_message: response.message && response.message.id,
                _send_time: sendTime && sendTime.toISOString && sendTime.toISOString(),
                _from: envelope.from,
                _to: envelope.to && envelope.to.join(','),
                _message_id: messageData.msgid,
                _subject: messageData.subject,
                _sess: result.value.sess,
                _ip: result.value.ip
            });

            return res.json(response);
        })
    );

    server.del(
        {
            path: '/users/:user/outbound/:queueId',
            tags: ['Messages'],
            summary: 'Delete an Outbound Message',
            name: 'deleteOutboundMessage',
            description: 'You can delete outbound emails that are still in queue. Queue ID can be found from the `outbound` property of a stored email.',
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    queueId: {
                        type: 'string',
                        pattern: '^[0-9a-f]+$',
                        minLength: 18,
                        maxLength: 24,
                        wdLowercase: true,
                        wdRequired: true,
                        description: 'Outbound queue ID of the message'
                    }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SuccessResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                queueId: { type: 'string', description: 'Outbound queue ID' },
                                deleted: { type: 'number', description: 'Count of deleted queue entries' },
                                code: { type: 'string', description: 'Error code if the request failed' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).deleteOwn('messages'));
            } else {
                req.validate(roles.can(req.role).deleteAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let queueId = result.value.queueId;

            let response = await maildrop.removeFromQueue(queueId, user);

            return res.json(response);
        })
    );

    server.get(
        {
            name: 'getArchivedMessages',
            path: '/users/:user/archived/messages',
            summary: 'List archived messages',
            description: 'Lists archived (recently deleted) messages for the user. Drafts are not archived.',
            jsonSchema: true,
            allowUnknown: true,
            validationObjs: {
                pathParams: {
                    user: userId
                },
                queryParams: {
                    metaData: { $ref: 'wd:boolean', default: false, description: 'If true, then includes metaData in the response' },
                    limit: { $ref: 'wd:pageLimit', wdEmpty: true },
                    next: nextPageCursorSchema,
                    previous: previousPageCursorSchema,
                    order: { enum: ['asc', 'desc'], default: 'desc', wdEmpty: true, description: 'Ordering of the records by insert date' },
                    threadCounters: {
                        $ref: 'wd:boolean',
                        default: false,
                        description: 'If true, then includes threadMessageCount and hasDrafts in the response. Counters come with some overhead'
                    },
                    includeHeaders: {
                        $ref: 'wd:boolean',
                        default: false,
                        description:
                            'If true, then includes all message headers in the response. If false, then includes only From, Sender, To, Cc, Bcc, Content-Type and References headers'
                    },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: messageListingResponse('GetArchivedMessagesResponse')
                    }
                }
            },
            tags: ['Archive']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('messages'));
            } else {
                req.validate(roles.can(req.role).readAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let limit = result.value.limit;
            let threadCounters = result.value.threadCounters;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;
            let sortAscending = result.value.order === 'asc';

            const includeHeaders = result.value.includeHeaders;

            let total = await db.database.collection('archived').countDocuments({ user });
            const projection = getMessageListingProjection(result.value.metaData, includeHeaders);

            let opts = {
                limit,
                query: { user },
                fields: {
                    // FIXME: hack to keep _id in response
                    _id: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection,
                    maxTimeMS: consts.DB_MAX_TIME_MESSAGES
                },
                paginatedField: '_id',
                sortAscending
            };

            if (pageNext) {
                opts.next = pageNext;
            }
            if (pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listingWrapper;
            try {
                listingWrapper = await mongopagingFindWrapper(db.database.collection('archived'), opts);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (threadCounters) {
                listingWrapper.listing.results = await addThreadCountersToMessageList(user, listingWrapper.listing.results, 'archived');
            }

            await applyBimiToListing(listingWrapper.listing.results);

            let response = {
                success: true,
                total,
                page: listingWrapper.page,
                previousCursor: listingWrapper.previousCursor,
                nextCursor: listingWrapper.nextCursor,
                results: (listingWrapper.listing.results || [])
                    .map(m => {
                        // prepare message for output
                        m.uid = m._id;
                        return m;
                    })
                    .map(entry => formatMessageListing(entry, includeHeaders))
            };

            return res.json(response);
        })
    );

    server.post(
        {
            name: 'restoreMessages',
            path: '/users/:user/archived/restore',
            tags: ['Archive'],
            jsonSchema: true,
            summary: 'Restore archived messages by date range',
            description:
                'Initiates a restore task to move archived messages within the specified date range back to the mailboxes the messages were deleted from. If a target mailbox does not exist, then the messages are moved to INBOX.',
            validationObjs: {
                pathParams: {
                    user: userId
                },
                requestBody: {
                    start: { wdType: 'date', wdInstanceof: 'Date', wdRequired: true, description: 'Datestring' },
                    end: { wdType: 'date', wdInstanceof: 'Date', wdRequired: true, description: 'Datestring' },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'RestoreMessagesResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                task: { type: 'string', description: 'Task ID' }
                            },
                            required: ['success', 'task']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).updateOwn('messages'));
            } else {
                req.validate(roles.can(req.role).updateAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let start = result.value.start;
            let end = result.value.end;

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            _id: true
                        }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!userData) {
                res.status(404);
                return res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
            }

            let task;
            try {
                task = await taskHandler.add('restore', { user, start, end });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return res.json({
                success: true,
                task
            });
        })
    );

    server.post(
        {
            name: 'restoreMessage',
            path: '/users/:user/archived/messages/:message/restore',
            summary: 'Restore a single archived message',
            description: 'Restores one archived message to its original mailbox, or to the specified target mailbox if provided.',
            tags: ['Archive'],
            jsonSchema: true,
            validationObjs: {
                requestBody: {
                    mailbox: hexId24('ID of the target Mailbox. If not set then original mailbox is used.'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    user: userId,
                    message: Object.assign({}, messageId, { description: 'Archived message ID' })
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'RestoreMessageResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                mailbox: { type: 'string', description: 'Mailbox ID the message was moved to' },
                                id: { type: 'number', description: 'New ID for the Message' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).updateOwn('messages'));
            } else {
                req.validate(roles.can(req.role).updateAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let message = new ObjectId(result.value.message);
            let mailbox = result.value.mailbox ? new ObjectId(result.value.mailbox) : false;

            let messageData;
            try {
                messageData = await db.database.collection('archived').findOne({
                    // hash key: {user, _id}
                    user,
                    _id: message
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!messageData) {
                res.status(404);
                return res.json({
                    error: 'This message does not exist',
                    code: 'MessageNotFound'
                });
            }

            messageData.mailbox = mailbox || messageData.mailbox;
            delete messageData.archived;
            delete messageData.exp;
            delete messageData.rdate;

            let response = await putMessage(messageData);
            if (!response) {
                return res.json({
                    success: false,
                    error: 'Failed to restore message'
                });
            }

            try {
                await db.users.collection('users').updateOne(
                    {
                        _id: messageData.user
                    },
                    {
                        $inc: {
                            storageUsed: messageData.size
                        }
                    }
                );
            } catch (err) {
                log.error('API', 'action=restore message=%s error=%s', messageData._id, 'Failed to update user quota. ' + err.message);
            }

            try {
                await db.database.collection('archived').deleteOne({
                    // hash key: {user, _id}
                    user,
                    _id: messageData._id
                });
            } catch (err) {
                // ignore
            }

            return res.json({
                success: true,
                mailbox: response.mailbox,
                id: response.uid
            });
        })
    );

    async function getFilteredMessageCount(filter) {
        if (Object.keys(filter).length === 1 && filter.mailbox) {
            // Try to use cached value to get the count
            return await getMailboxCounter(db, filter.mailbox);
        }

        return await db.database.collection('messages').countDocuments(filter);
    }

    async function getReferencedMessage(userData, options) {
        if (!options.reference) {
            return false;
        }

        let query = {};
        if (typeof options.reference === 'object') {
            query.mailbox = new ObjectId(options.reference.mailbox);
            query.uid = options.reference.id;
        } else {
            return false;
        }

        query.user = userData._id;

        let userAddresses = await db.users.collection('addresses').find({ user: userData._id }).toArray();
        userAddresses = userAddresses.map(address => address.addrview);

        let messageData = await db.database.collection('messages').findOne(query, {
            projection: {
                attachments: true,
                'mimeTree.attachmentMap': true,
                'mimeTree.parsedHeader': true,
                thread: true
            }
        });

        if (!messageData) {
            return false;
        }

        let headers = (messageData && messageData.mimeTree && messageData.mimeTree.parsedHeader) || {};

        let subject = headers.subject || '';
        try {
            subject = libmime.decodeWords(subject).trim();
        } catch (E) {
            // failed to parse value
        }

        if (!/^\w+: /.test(subject)) {
            subject = ((options.reference.action === 'forward' ? 'Fwd' : 'Re') + ': ' + subject).trim();
        }

        let sender = headers['reply-to'] || headers.from || headers.sender;
        let replyTo = [];
        let replyCc = [];
        let uniqueRecipients = new Set();

        let checkAddress = (target, addr) => {
            let addrview = tools.normalizeAddress(addr.address, false, { removeLabel: true, removeDots: true });
            if (!userAddresses.includes(addrview) && !uniqueRecipients.has(addrview)) {
                uniqueRecipients.add(addrview);
                if (addr.name) {
                    try {
                        addr.name = libmime.decodeWords(addr.name).trim();
                    } catch (E) {
                        // failed to parse value
                    }
                }
                target.push(addr);
            }
        };

        [].concat(sender || {}).forEach(addr => checkAddress(replyTo, addr));

        if (options.reference.action === 'replyAll') {
            [].concat(headers.to || []).forEach(addr => {
                let walk = addr => {
                    if (addr.address) {
                        checkAddress(replyTo, addr);
                    } else if (addr.group) {
                        addr.group.forEach(walk);
                    }
                };
                walk(addr);
            });
            [].concat(headers.cc || []).forEach(addr => {
                let walk = addr => {
                    if (addr.address) {
                        checkAddress(replyCc, addr);
                    } else if (addr.group) {
                        addr.group.forEach(walk);
                    }
                };
                walk(addr);
            });
        }

        let messageId = (headers['message-id'] || '').trim();
        let references = (headers.references || '')
            .trim()
            .replace(/\s+/g, ' ')
            .split(' ')
            .filter(mid => mid);

        if (messageId && !references.includes(messageId)) {
            references.unshift(messageId);
        }

        if (references.length > 50) {
            references = references.slice(0, 50);
        }

        let attachments = false;
        if (options.reference.attachments && messageData.attachments && messageData.attachments.length) {
            // load attachments as well
            for (let attachment of messageData.attachments) {
                if (!attachment || attachment.related) {
                    // skip embedded images
                    continue;
                }
                if (Array.isArray(options.reference.attachments) && !options.reference.attachments.includes(attachment.id)) {
                    // skip attachments not listed in the API call
                    continue;
                }

                try {
                    let attachmentId = messageData.mimeTree.attachmentMap && messageData.mimeTree.attachmentMap[attachment.id];
                    let content = await fetchAttachment(attachmentId);
                    if (!attachments) {
                        attachments = [];
                    }
                    attachments.push({
                        content,
                        filename: attachment.filename,
                        contentType: attachment.contentType
                    });
                } catch (err) {
                    // ignore
                }
            }
        }

        return {
            replyTo,
            replyCc,
            subject,
            thread: messageData.thread,
            inReplyTo: messageId,
            references: references.join(' '),
            attachments
        };
    }

    async function fetchAttachment(attachmentId) {
        let attachmentData = await messageHandler.attachmentStorage.get(attachmentId);

        let decode = true;

        if (attachmentData.metadata.decoded) {
            attachmentData.metadata.decoded = false;
            decode = false;
        }

        return new Promise((resolve, reject) => {
            let attachmentStream = messageHandler.attachmentStorage.createReadStream(attachmentId, attachmentData);

            attachmentStream.once('error', err => {
                log.error('API', 'attachment=%s error=%s', attachmentId, err.message);
                reject(err);
            });

            let decodedStream;

            if (!decode) {
                decodedStream = attachmentStream;
            } else if (attachmentData.transferEncoding === 'base64') {
                decodedStream = new libbase64.Decoder();
                attachmentStream.pipe(decodedStream);
            } else if (attachmentData.transferEncoding === 'quoted-printable') {
                decodedStream = new libqp.Decoder();
                attachmentStream.pipe(decodedStream);
            } else {
                decodedStream = attachmentStream;
            }

            let chunks = [];
            let chunklen = 0;
            decodedStream.on('readable', () => {
                let chunk;
                while ((chunk = decodedStream.read()) !== null) {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                }
            });

            decodedStream.once('end', () => {
                let raw = Buffer.concat(chunks, chunklen);
                resolve(raw);
            });
        });
    }

    async function validateFromAddress(userData, address) {
        if (!address || address === userData.address) {
            // using default address, ok
            return userData.address;
        }

        if (userData.fromWhitelist && userData.fromWhitelist.length) {
            if (
                userData.fromWhitelist.some(addr => {
                    if (addr === address) {
                        return true;
                    }

                    if (addr.charAt(0) === '*' && address.endsWith(addr.substr(1))) {
                        return true;
                    }

                    if (addr.charAt(addr.length - 1) === '*' && address.indexOf(addr.substr(0, addr.length - 1)) === 0) {
                        return true;
                    }

                    return false;
                })
            ) {
                // whitelisted address
                return address;
            }
        }

        let resolvedUser = await userHandler.asyncGet(address, false);

        if (!resolvedUser || resolvedUser._id.toString() !== userData._id.toString()) {
            return userData.address;
        }

        return address;
    }

    async function submitMessage(userData, envelope, sendTime, stream, options) {
        options = options || {};

        let settings = await settingsHandler.getMulti(['const:max:recipients']);
        let maxRecipients = Number(userData.recipients) || config.maxRecipients || settings['const:max:recipients'];

        return new Promise((resolve, reject) => {
            // push message to outbound queue
            let message = maildrop.push(
                {
                    user: userData._id,
                    userEmail: userData.address,
                    reason: 'submit',
                    from: envelope.from,
                    to: envelope.to,
                    sendTime,
                    origin: options.origin || options.ip,
                    passwordType: 'master',
                    runPlugins: true,
                    mtaRelay: userData.mtaRelay || false
                },
                (err, ...args) => {
                    if (err || !args[0]) {
                        if (err && !err.code && err.name === 'SMTPReject') {
                            err.code = 'MessageRejected';
                        }
                        if (err) {
                            err.code = err.code || 'ERRCOMPOSE';
                        } else {
                            err = new Error('Could not queue message for delivery');
                            err.code = 'ERRCOMPOSE';
                        }
                        err.responseCode = 500;
                        return reject(err);
                    }

                    // Update counters only after message has been succesfully sent and not rejected
                    messageHandler.counters.ttlcounter('wdr:' + userData._id.toString(), envelope.to.length, maxRecipients, false, err => {
                        if (err) {
                            err.responseCode = 500;
                            err.code = 'InternalDatabaseError';
                            return reject(err);
                        }
                    });

                    // Update addressregister - output can be ignored as it is not an important operation
                    messageHandler.updateAddressRegister(
                        userData._id,
                        envelope.to.map(el => ({ address: el })) // envelope.to is an array of raw "to" address strings
                    );

                    let outbound = args[0].id;
                    return resolve(outbound);
                }
            );

            if (message) {
                stream.once('error', err => message.emit('error', err));
                stream.pipe(message);
            }
        });
    }
};

function leftPad(val, chr, len) {
    return chr.repeat(len - val.toString().length) + val;
}

function formatMessageListing(messageData, includeHeaders) {
    let parsedHeader = (messageData.mimeTree && messageData.mimeTree.parsedHeader) || {};

    if (includeHeaders === true) {
        includeHeaders = Object.keys(parsedHeader);
    }

    includeHeaders = []
        .concat(includeHeaders || [])
        .map(entry => {
            if (typeof entry !== 'string') {
                return false;
            }
            return entry.toLowerCase().trim();
        })
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
        mailbox: messageData.mailbox,
        thread: messageData.thread,
        threadMessageCount: messageData.threadMessageCount,
        hasDrafts: messageData.hasDrafts,
        from: from && from[0],
        to,
        cc,
        bcc,
        messageId: messageData.msgid,
        subject: messageData.subject,
        date: messageData.hdate ? messageData.hdate.toISOString() : null,
        idate: messageData.idate ? messageData.idate.toISOString() : null,
        intro: messageData.intro,
        attachments: !!messageData.ha,
        attachmentsList: (messageData.attachments || []).map(attachmentData => {
            let hash = messageData.mimeTree && messageData.mimeTree.attachmentMap && messageData.mimeTree.attachmentMap[attachmentData.id];
            if (!hash) {
                return attachmentData;
            }
            return Object.assign({ hash: hash.toString('hex') }, attachmentData);
        }),
        size: messageData.size,
        seen: !messageData.unseen,
        deleted: !messageData.undeleted,
        flagged: messageData.flagged,
        draft: messageData.draft,
        answered: messageData.flags.includes('\\Answered') && !messageData.flags.includes('$Forwarded'),
        forwarded: messageData.flags.includes('$Forwarded'),
        references: (parsedHeader.references || '')
            .toString()
            .split(/\s+/)
            .filter(ref => ref),
        bimi: messageData.bimi
    };

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

async function getCompiledMessage(data, options) {
    options = options || {};
    return new Promise((resolve, reject) => {
        let compiler = new MailComposer(data);
        let compiled = compiler.compile();
        if (options.isDraft) {
            compiled.keepBcc = true;
        }
        let stream = compiled.createReadStream();
        let chunks = [];
        let chunklen = 0;
        stream.once('error', err => reject(err));
        stream.on('readable', () => {
            let chunk;
            while ((chunk = stream.read()) !== null) {
                chunks.push(chunk);
                chunklen += chunk.length;
            }
        });
        stream.once('end', () => {
            let raw = Buffer.concat(chunks, chunklen);
            resolve(raw);
        });
    });
}

function parseAddresses(data) {
    let addresses = new Set();
    let walk = list => {
        if (typeof list === 'string') {
            list = [{ address: list }];
        }
        [].concat(list || []).forEach(item => {
            if (item.address) {
                addresses.add(item.address);
            }
            if (item.group) {
                walk(item.group);
            }
        });
    };
    walk([].concat(data || []));
    return Array.from(addresses);
}

function getAttachmentCharset(mimeTree, attachmentId) {
    if (mimeTree.attachmentId && mimeTree.attachmentId === attachmentId) {
        // current mimeTree (sub)object has the attachmentId field, and it is the one we search
        // get the parsedHeader -> content-type -> params -> charset

        return [mimeTree.parsedHeader['content-type']?.params?.charset || 'UTF-8', true];
    } else if (mimeTree.childNodes) {
        // current mimetree (sub)object does not have the attachmentId field and it is not equal to the one we search
        // loop childNodes
        let charset;
        for (const childNode of Object.values(mimeTree.childNodes)) {
            charset = getAttachmentCharset(childNode, attachmentId);
            if (charset[1] === true) {
                // actually found the charset, early return
                return charset;
            }
        }
    }

    return ['UTF-8', false];
}

function getAttachmentContentDisposition(mimeTree, attachmentId) {
    if (mimeTree.attachmentId && mimeTree.attachmentId === attachmentId) {
        // current mimeTree (sub)object has the attachmentId field, and it is the one we search
        // return the original unfolded Content-Disposition header value if it exists

        for (let header of [].concat(mimeTree.header || [])) {
            if (/^content-disposition\s*:/i.test(header)) {
                return [
                    header
                        .replace(/^content-disposition\s*:/i, '')
                        .replace(/\s*\r?\n\s*/g, ' ')
                        .trim(),
                    true
                ];
            }
        }

        return [false, true];
    } else if (mimeTree.childNodes) {
        // current mimetree (sub)object does not have the attachmentId field and it is not equal to the one we search
        // loop childNodes
        let contentDisposition;
        for (const childNode of Object.values(mimeTree.childNodes)) {
            contentDisposition = getAttachmentContentDisposition(childNode, attachmentId);
            if (contentDisposition[1] === true) {
                // actually found the content disposition, early return
                return contentDisposition;
            }
        }
    }

    return [false, false];
}
