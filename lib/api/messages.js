'use strict';

const config = require('wild-config');
const log = require('npmlog');
const libmime = require('libmime');
const Joi = require('joi');
const MongoPaging = require('mongo-cursor-pagination');
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
const { nextPageCursorSchema, previousPageCursorSchema, pageNrSchema, sessSchema, sessIPSchema, booleanSchema, metaDataSchema } = require('../schemas');
const { preprocessAttachments } = require('../data-url');
const TaskHandler = require('../task-handler');
const { prepareSearchFilter, uidRangeStringToQuery } = require('../prepare-search-filter');
const { getMongoDBQuery /*, getElasticSearchQuery*/ } = require('../search-query');
//const { getClient } = require('../elasticsearch');
let iconv = require('iconv-lite');

const BimiHandler = require('../bimi-handler');
const {
    Address,
    AddressOptionalNameArray,
    Header,
    Attachment,
    ReferenceWithAttachments,
    Bimi,
    AddressOptionalName
} = require('../schemas/request/messages-schemas');
const { userId, mailboxId, messageId } = require('../schemas/request/general-schemas');
const { MsgEnvelope } = require('../schemas/response/messages-schemas');
const { successRes } = require('../schemas/response/general-schemas');

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

    const encryptMessage = util.promisify(messageHandler.encryptMessage.bind(messageHandler));

    const getMailboxCounter = util.promisify(tools.getMailboxCounter);
    const asyncForward = util.promisify(forward);

    const addMessage = util.promisify((...args) => {
        let callback = args.pop();
        messageHandler.add(...args, (err, status, data) => {
            if (err) {
                return callback(err);
            }
            return callback(null, { status, data });
        });
    });

    const moveMessage = util.promisify((...args) => {
        let callback = args.pop();
        messageHandler.move(...args, (err, result, info) => {
            if (err) {
                return callback(err);
            }
            return callback(null, { result, info });
        });
    });

    const addThreadCountersToMessageList = async (user, list) => {
        const threadIdsToCount = list.map(message => message.thread);
        const threadCounts = await db.database
            .collection('messages')
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
                        }
                    }
                }
            ])
            .toArray();

        return list.map(message => {
            const matchingThreadCount = threadCounts.find(thread => thread._id.toString() === message.thread.toString());
            message.threadMessageCount = matchingThreadCount ? matchingThreadCount.count : undefined;
            return message;
        });
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

        const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;

        const schema = Joi.object({
            ...requestBody,
            ...queryParams,
            ...pathParams
        });

        const result = schema.validate(req.params, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.status(400);
            return res.json({
                error: result.error.message,
                code: 'InputValidationError',
                details: tools.validationErrors(result)
            });
        }

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
                extendLockIntervalTimer = setInterval(() => {
                    server.lock
                        .extendLock(lock, LOCK_TTL)
                        .then(info => {
                            log.verbose('API', `Lock extended lock=${info.id} result=${info.success ? 'yes' : 'no'}`);
                        })
                        .catch(err => {
                            log.verbose('API', 'Failed to extend lock lock=%s error=%s', lock?.id, err.message);
                        });
                }, Math.round(LOCK_TTL * 0.8));
            } catch (err) {
                res.status(500);
                return res.json({
                    error: err.message,
                    code: err.code || 'LockFail'
                });
            }

            try {
                let data = await moveMessage({
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
            validationObjs: {
                requestBody: {},
                pathParams: {
                    user: Joi.string().hex().lowercase().length(24).required().description('ID of the User'),
                    mailbox: Joi.string().hex().lowercase().length(24).required().description('ID of the Mailbox')
                },
                queryParams: {
                    unseen: booleanSchema.description('If true, then returns only unseen messages'),
                    metaData: booleanSchema.default(false).description('If true, then includes metaData in the response'),
                    threadCounters: booleanSchema
                        .default(false)
                        .description('If true, then includes threadMessageCount in the response. Counters come with some overhead'),
                    limit: Joi.number().empty('').default(20).min(1).max(250).description('How many records to return'),
                    order: Joi.any().empty('').allow('asc', 'desc').default('desc').description('Ordering of the records by insert date'),
                    next: nextPageCursorSchema,
                    previous: previousPageCursorSchema,
                    page: pageNrSchema,
                    sess: sessSchema,
                    ip: sessIPSchema,
                    includeHeaders: Joi.alternatives()
                        .try(Joi.string(), booleanSchema)
                        .description('Comma separated list of header keys to include in the response')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: booleanSchema.description('Indicates successful response').required(),
                            total: Joi.number().description('How many results were found').required(),
                            page: Joi.number().description('Current page number. Derived from page query argument').required(),
                            previousCursor: Joi.alternatives()
                                .try(Joi.string(), booleanSchema)
                                .description('Either a cursor string or false if there are not any previous results')
                                .required(),
                            nextCursor: Joi.alternatives()
                                .try(Joi.string(), booleanSchema)
                                .description('Either a cursor string or false if there are not any next results')
                                .required(),
                            specialUse: Joi.string().description('Special use. If available').required(),
                            results: Joi.array()
                                .items(
                                    Joi.object({
                                        id: Joi.number().required().description('ID of the Message'),
                                        mailbox: Joi.string().required().description('ID of the Mailbox'),
                                        thread: Joi.string().required().description('ID of the Thread'),
                                        threadMessageCount: Joi.number().description(
                                            'Amount of messages in the Thread. Included if threadCounters query argument was true'
                                        ),
                                        from: Address.description('Sender in From: field'),
                                        to: Joi.array().items(Address).required().description('Recipients in To: field'),
                                        cc: Joi.array().items(Address).required().description('Recipients in Cc: field'),
                                        bcc: Joi.array().items(Address).required().description('Recipients in Bcc: field. Usually only available for drafts'),
                                        messageId: Joi.string().required().description('Message ID'),
                                        subject: Joi.string().required().description('Message subject'),
                                        date: Joi.date().required().description('Date string from header'),
                                        idate: Joi.date().description('Date string of receive time'),
                                        intro: Joi.string().required().description('First 128 bytes of the message'),
                                        attachments: booleanSchema.required().description('Does the message have attachments'),
                                        attachmentsList: Joi.array()
                                            .items(
                                                Joi.object({
                                                    id: Joi.string().required().description('Attachment ID'),
                                                    hash: Joi.string().description('SHA-256 hash of the contents of the attachment'),
                                                    filename: Joi.string().required().description('Filename of the attachment'),
                                                    contentType: Joi.string().required().description('MIME type'),
                                                    disposition: Joi.string().required().description('Attachment disposition'),
                                                    transferEncoding: Joi.string()
                                                        .required()
                                                        .description(
                                                            'Which transfer encoding was used (actual content when fetching attachments is not encoded)'
                                                        ),
                                                    related: booleanSchema
                                                        .required()
                                                        .description(
                                                            'Was this attachment found from a multipart/related node. This usually means that this is an embedded image'
                                                        ),
                                                    sizeKb: Joi.number().required().description('Approximate size of the attachment in kilobytes')
                                                })
                                            )
                                            .description('Attachments for the message'),
                                        size: Joi.number().required().description('Message size in bytes'),
                                        seen: booleanSchema.required().description('Is this message already seen or not'),
                                        deleted: booleanSchema
                                            .required()
                                            .description(
                                                'Does this message have a Deleted flag (should not have as messages are automatically deleted once this flag is set)'
                                            ),
                                        flagged: booleanSchema.required().description('Does this message have a Flagged flag'),
                                        draft: booleanSchema.required().description('is this message a draft'),
                                        answered: booleanSchema.required().description('Does this message have a Answered flag'),
                                        forwarded: booleanSchema.required().description('Does this message have a $Forwarded flag'),
                                        references: Joi.array().items(ReferenceWithAttachments).required().description('References'),
                                        bimi: Bimi.required().description(
                                            'Marks BIMI verification as passed for a domain. NB! BIMI record and logo files for the domain must be valid.'
                                        ),
                                        contentType: Joi.object({
                                            value: Joi.string().required().description('MIME type of the message, eg. "multipart/mixed"'),
                                            params: Joi.object().required().description('An object with Content-Type params as key-value pairs')
                                        })
                                            .$_setFlag('objectName', 'ContentType')
                                            .required()
                                            .description('Parsed Content-Type header. Usually needed to identify encrypted messages and such'),
                                        encrypted: booleanSchema.description('Specifies whether the message is encrypted'),
                                        metaData: Joi.object().description('Custom metadata value. Included if metaData query argument was true'),
                                        headers: Joi.object().description('Header object keys requested with the includeHeaders argument')
                                    }).$_setFlag('objectName', 'GetMessagesResult')
                                )
                                .required()
                                .description('Message listing')
                        }).$_setFlag('objectName', 'GetMessagesResponse')
                    }
                }
            },
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { requestBody, pathParams, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...requestBody,
                ...pathParams,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true,
                allowUnknown: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

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
            let page = result.value.page;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;
            let sortAscending = result.value.order === 'asc';
            let filterUnseen = result.value.unseen;

            let includeHeaders = result.value.includeHeaders ? result.value.includeHeaders.split(',') : false;

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

            if (filterUnseen) {
                filter.unseen = true;
            }

            let total = await getFilteredMessageCount(filter);

            let opts = {
                limit,
                query: filter,
                fields: {
                    idate: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection: {
                        _id: true,
                        uid: true,
                        msgid: true,
                        mailbox: true,
                        [result.value.metaData ? 'meta' : 'meta.from']: true,
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
                    }
                },
                paginatedField: 'idate',
                sortAscending
            };

            if (includeHeaders) {
                // get all headers
                opts.fields.projection['mimeTree.parsedHeader'] = true;
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
                    opts.fields.projection[requiredHeader] = true;
                }
            }

            if (pageNext) {
                opts.next = pageNext;
            } else if ((!page || page > 1) && pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listing;
            try {
                listing = await MongoPaging.find(db.database.collection('messages'), opts);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!listing.hasPrevious) {
                page = 1;
            }

            if (threadCounters) {
                listing.results = await addThreadCountersToMessageList(user, listing.results);
            }

            await applyBimiToListing(listing.results);

            let response = {
                success: true,
                total,
                page,
                previousCursor: listing.hasPrevious ? listing.previous : false,
                nextCursor: listing.hasNext ? listing.next : false,
                specialUse: mailboxData.specialUse,
                results: (listing.results || []).map(entry => formatMessageListing(entry, includeHeaders))
            };

            return res.json(response);
        })
    );

    const searchSchema = {
        q: Joi.string().trim().empty('').max(1024).optional().description('Additional query string'),

        mailbox: Joi.string().hex().length(24).empty('').description('ID of the Mailbox'),
        id: Joi.string()
            .trim()
            .empty('')
            .regex(/^\d+(,\d+)*$|^\d+:(\d+|\*)$/i)
            .description(
                'Message ID values, only applies when used in combination with `mailbox`. Either comma separated numbers (1,2,3) or colon separated range (3:15), or a range from UID to end (3:*)'
            ),
        thread: Joi.string().hex().length(24).empty('').description('Thread ID'),

        or: Joi.object({
            query: Joi.string()
                .trim()
                .max(255)
                .empty('')
                .description('Search string, uses MongoDB fulltext index. Covers data from message body and also common headers like from, to, subject etc.'),
            from: Joi.string().trim().empty('').description('Partial match for the From: header line'),
            to: Joi.string().trim().empty('').description('Partial match for the To: and Cc: header lines'),
            subject: Joi.string().trim().empty('').description('Partial match for the Subject: header line')
        }).description('At least onOne of the included terms must match'),

        query: Joi.string()
            .trim()
            .max(255)
            .empty('')
            .description('Search string, uses MongoDB fulltext index. Covers data from message body and also common headers like from, to, subject etc.'),
        datestart: Joi.date().label('Start time').empty('').description('Datestring for the earliest message storing time'),
        dateend: Joi.date().label('End time').empty('').description('Datestring for the latest message storing time'),
        from: Joi.string().trim().empty('').description('Partial match for the From: header line'),
        to: Joi.string().trim().empty('').description('Partial match for the To: and Cc: header lines'),
        subject: Joi.string().trim().empty('').description('Partial match for the Subject: header line'),
        minSize: Joi.number().empty('').description('Minimal message size in bytes'),
        maxSize: Joi.number().empty('').description('Maximal message size in bytes'),
        attachments: booleanSchema.description('If true, then matches only messages with attachments'),
        flagged: booleanSchema.description('If true, then matches only messages with \\Flagged flags'),
        unseen: booleanSchema.description('If true, then matches only messages without \\Seen flags'),
        includeHeaders: Joi.string()
            .max(1024)
            .trim()
            .empty('')
            .example('List-ID, MIME-Version')
            .description('Comma separated list of header keys to include in the response'),
        searchable: booleanSchema.description('If true, then matches messages not in Junk or Trash'),
        sess: sessSchema,
        ip: sessIPSchema
    };

    server.get(
        {
            path: '/users/:user/search',
            validationObjs: {
                queryParams: {
                    ...searchSchema,
                    ...{
                        threadCounters: booleanSchema
                            .default(false)
                            .description('If true, then includes threadMessageCount in the response. Counters come with some overhead'),
                        limit: Joi.number().default(20).min(1).max(250).description('How many records to return'),
                        order: Joi.any()
                            .empty('')
                            .allow('asc', 'desc')
                            .optional()
                            .description('Ordering of the records by insert date. If no order is supplied, results are sorted by heir mongoDB ObjectId.'),
                        includeHeaders: Joi.string()
                            .max(1024)
                            .trim()
                            .empty('')
                            .example('List-ID, MIME-Version')
                            .description('Comma separated list of header keys to include in the response'),
                        next: nextPageCursorSchema,
                        previous: previousPageCursorSchema,
                        page: pageNrSchema
                    }
                },
                pathParams: { user: userId },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: booleanSchema.required().description('Indicates successful response'),
                            query: Joi.string().required('Query'),
                            total: Joi.number().required('How many results were found'),
                            page: Joi.number().required('Current page number. Derived from page query argument'),
                            previousCursor: Joi.alternatives()
                                .try(booleanSchema, Joi.string())
                                .required()
                                .description('Either a cursor string or false if there are not any previous results'),
                            nextCursor: Joi.alternatives()
                                .try(booleanSchema, Joi.string())
                                .required()
                                .description('Either a cursor string or false if there are not any next results'),
                            results: Joi.array()
                                .items(
                                    Joi.object({
                                        id: messageId,
                                        mailbox: mailboxId,
                                        messageId: Joi.string().required().description('The message ID'),
                                        thread: Joi.string().required().description('ID of the Thread'),
                                        threadMessageCount: Joi.number().description(
                                            'Amount of messages in the Thread. Included if threadCounters query argument was true'
                                        ),
                                        from: Address,
                                        to: Joi.array().items(Address).required().description('Recipients in To: field'),
                                        cc: Joi.array().items(Address).required().description('Recipients in Cc: field'),
                                        bcc: Joi.array().items(Address).required().description('Recipients in Bcc: field. Usually only available for drafts'),
                                        subject: Joi.string().required().description('Message subject'),
                                        date: Joi.date().required().description('Date string from header'),
                                        idate: Joi.date().description('Date string of receive time'),
                                        size: Joi.number().required().description('Message size in bytes'),
                                        intro: Joi.string().required().description('First 128 bytes of the message'),
                                        attachments: booleanSchema.required().description('Does the message have attachments'),
                                        seen: booleanSchema.required().description('Is this message already seen or not'),
                                        deleted: booleanSchema
                                            .required()
                                            .description(
                                                'Does this message have a \\Deleted flag (should not have as messages are automatically deleted once this flag is set)'
                                            ),
                                        flagged: booleanSchema.required().description('Does this message have a \\Flagged flag'),
                                        answered: booleanSchema.required().description('Does this message have a \\Answered flag'),
                                        forwarded: booleanSchema.required().description('Does this message have a $Forwarded flag'),
                                        draft: booleanSchema.description('True if message is a draft').required(),
                                        contentType: Joi.object({
                                            value: Joi.string().required().description('MIME type of the message, eg. "multipart/mixed"'),
                                            params: Joi.object().required().description('An object with Content-Type params as key-value pairs')
                                        })
                                            .$_setFlag('objectName', 'ContentType')
                                            .required()
                                            .description('Parsed Content-Type header. Usually needed to identify encrypted messages and such'),
                                        metadata: metaDataSchema.description('Custom metadata value. Included if metaData query argument was true'),
                                        headers: Joi.object().description('Header object keys requested with the includeHeaders argument'),
                                        encrypted: booleanSchema.description('True if message is encryrpted'),
                                        references: Joi.array().items(ReferenceWithAttachments).required().description('References'),
                                        bimi: Bimi.required().description(
                                            'Marks BIMI verification as passed for a domain. NB! BIMI record and logo files for the domain must be valid.'
                                        )
                                    }).$_setFlag('objectName', 'GetMessagesResult')
                                )
                                .required()
                                .description('Message listing')
                        }).$_setFlag('objectName', 'SearchMessagesResponse')
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

            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;

            const schema = Joi.object({ ...requestBody, ...queryParams, ...pathParams });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true,
                allowUnknown: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('messages'));
            } else {
                req.validate(roles.can(req.role).readAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let threadCounters = result.value.threadCounters;
            let limit = result.value.limit;
            let page = result.value.page;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;
            let order = result.value.order;

            let includeHeaders = result.value.includeHeaders ? result.value.includeHeaders.split(',') : false;

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

                filter = await getMongoDBQuery(db, user, result.value.q);
                query = result.value.q;
            } else {
                let prepared = await prepareSearchFilter(db, user, result.value);
                filter = prepared.filter;
                query = prepared.query;
            }

            let total = await getFilteredMessageCount(filter);
            log.verbose('API', 'Searching %s', JSON.stringify(filter));

            let opts = {
                limit,
                query: filter,
                fields: {
                    // FIXME: hack to keep _id in response
                    _id: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection: {
                        _id: true,
                        uid: true,
                        msgid: true,
                        mailbox: true,
                        'meta.from': true,
                        hdate: true,
                        idate: true,
                        subject: true,
                        ha: true,
                        intro: true,
                        size: true,
                        unseen: true,
                        undeleted: true,
                        flagged: true,
                        draft: true,
                        thread: true,
                        flags: true,
                        verificationResults: true
                    }
                },
                paginatedField: order !== undefined ? 'idate' : '_id',
                sortAscending: order === 'asc' ? true : undefined
            };

            if (includeHeaders) {
                // get all headers
                opts.fields.projection['mimeTree.parsedHeader'] = true;
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
                    opts.fields.projection[requiredHeader] = true;
                }
            }

            if (pageNext) {
                opts.next = pageNext;
            } else if ((!page || page > 1) && pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listing;
            try {
                listing = await MongoPaging.find(db.database.collection('messages'), opts);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!listing.hasPrevious) {
                page = 1;
            }

            if (threadCounters) {
                listing.results = await addThreadCountersToMessageList(user, listing.results);
            }

            await applyBimiToListing(listing.results);

            let response = {
                success: true,
                query,
                total,
                page,
                previousCursor: listing.hasPrevious ? listing.previous : false,
                nextCursor: listing.hasNext ? listing.next : false,
                results: (listing.results || []).map(entry => formatMessageListing(entry, includeHeaders))
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
            validationObjs: {
                requestBody: {
                    ...searchSchema,
                    ...{
                        // actions to take on matching messages
                        action: Joi.object()
                            .keys({
                                moveTo: Joi.string().hex().lowercase().length(24).description('ID of the target Mailbox if you want to move messages'),
                                seen: booleanSchema.description('State of the \\Seen flag'),
                                flagged: booleanSchema.description('State of the \\Flagged flag')
                            })
                            .required()
                            .description('Define actions to take with matching messages')
                    }
                },
                queryParams: {},
                pathParams: {
                    user: Joi.string().hex().lowercase().length(24).required()
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: booleanSchema.required().description('Indicates if the action succeeded or not'),
                            scheduled: Joi.string().required().description('ID of the scheduled operation'),
                            existing: booleanSchema.required().description('Indicates if the scheduled operation already exists')
                        }).$_setFlag('objectName', 'SearchApplyMessagesResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({ ...pathParams, ...requestBody, ...queryParams });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true,
                allowUnknown: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('messages'));
            } else {
                req.validate(roles.can(req.role).readAny('messages'));
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
            validationObjs: {
                queryParams: {
                    replaceCidLinks: booleanSchema.default(false).description('If true then replaces cid links'),
                    markAsSeen: booleanSchema.default(false).description('If true then marks message as seen'),
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
                        model: Joi.object({
                            success: successRes,
                            id: messageId,
                            mailbox: mailboxId,
                            user: userId,
                            envelope: MsgEnvelope.required(),
                            thread: Joi.string().required().description('ID of the Thread'),
                            from: Address.required(),
                            replyTo: Address,
                            to: Address,
                            cc: Address,
                            bcc: Address,
                            subject: Joi.string().required().description('Message subject'),
                            messageId: Joi.string().required().description('Message-ID header'),
                            date: Joi.date().required().description('Date string from header'),
                            idate: Joi.date().description('Date string of receive time'),
                            list: Joi.object({
                                id: Joi.string().required().description('Value from List-ID header'),
                                unsubscribe: Joi.string().required().description('Value from List-Unsubscribe header')
                            })
                                .description('If set then this message is from a mailing list')
                                .$_setFlag('objectName', 'List'),
                            size: Joi.number().required().description('Message size'),
                            expires: Joi.string().description('Datestring, if set then indicates the time after this message is automatically deleted'),
                            seen: booleanSchema.required().description('Does this message have a \\Seen flag'),
                            deleted: booleanSchema.required().description('Does this message have a \\Deleted flag'),
                            flagged: booleanSchema.required().description('Does this message have a \\Flagged flag'),
                            draft: booleanSchema.required().description('Does this message have a \\Draft flag'),
                            html: Joi.array()
                                .items(Joi.string())
                                .description(
                                    'An array of HTML string. Every array element is from a separate mime node, usually you would just join these to a single string'
                                ),
                            text: Joi.string().description('Plaintext content of the message'),
                            attachments: Joi.array()
                                .items(
                                    Joi.object({
                                        id: Joi.string().required().description('Attachment ID'),
                                        hash: Joi.string().description('SHA-256 hash of the contents of the attachment'),
                                        filename: Joi.string().required().description('Filename of the attachment'),
                                        contentType: Joi.string().required().description('MIME type'),
                                        disposition: Joi.string().required().description('Attachment disposition'),
                                        transferEncoding: Joi.string()
                                            .required()
                                            .description('Which transfer encoding was used (actual content when fetching attachments is not encoded)'),
                                        related: booleanSchema
                                            .required()
                                            .description(
                                                'Was this attachment found from a multipart/related node. This usually means that this is an embedded image'
                                            ),
                                        sizeKb: Joi.number().required().description('Approximate size of the attachment in kilobytes')
                                    })
                                )
                                .description('Attachments for the message'),
                            verificationResults: Joi.object({
                                tls: Joi.object({
                                    name: Joi.object().required().description('Cipher name, eg "ECDHE-RSA-AES128-GCM-SHA256"'),
                                    version: Joi.object().required().description('TLS version, eg "TLSv1/SSLv3"')
                                })
                                    .$_setFlag('objectName', 'Tls')
                                    .required()
                                    .description('TLS information. Value is false if TLS was not used'),
                                spf: Joi.object({})
                                    .required()
                                    .description('Domain name (either MFROM or HELO) of verified SPF or false if no SPF match was found'),
                                dkim: Joi.object({}).required().description('Domain name of verified DKIM signature or false if no valid signature was found')
                            }).description(
                                'Security verification info if message was received from MX. If this property is missing then do not automatically assume invalid TLS, SPF or DKIM.'
                            ),
                            bimi: Joi.object({
                                certified: booleanSchema.description('If true, then this logo is from a VMC file'),
                                url: Joi.string().description('URL of the resource the logo was retrieved from'),
                                image: Joi.string().description('Data URL for the SVG image'),
                                type: Joi.string().valid('VMC', 'CMC').description('Certificate type (only for VMC files)')
                            }).description('BIMI logo info. If logo validation failed in any way, then this property is not set'),
                            contentType: Joi.object({
                                value: Joi.string().required().description('MIME type of the message, eg. "multipart/mixed'),
                                params: Joi.object({}).required().description('An object with Content-Type params as key-value pairs')
                            })
                                .required()
                                .description('Parsed Content-Type header. Usually needed to identify encrypted messages and such'),
                            metaData: Joi.object({}).description('Custom metadata object set for this message'),
                            references: Joi.array().items(ReferenceWithAttachments).required().description('References'),
                            files: Joi.object({}).description(
                                'List of files added to this message as attachments. Applies to Drafts, normal messages do not have this property. Needed to prevent uploading the same attachment every time a draft is updated'
                            ),
                            outbound: Joi.array().items(Joi.object({})).description('Outbound queue entries'),
                            forwardTargets: Joi.object({}).description('Forward targets'),
                            reference: Joi.object({}).description('Referenced message info'),
                            answered: booleanSchema.required().description('\\Answered flag value'),
                            forwarded: booleanSchema.required().description('$Forwarded flag value'),
                            encrypted: booleanSchema.description('True if message is encrypted')
                        }).$_setFlag('objectName', 'GetMessageResponse')
                    }
                }
            },
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;

            const schema = Joi.object({ ...requestBody, ...queryParams, ...pathParams });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

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

                if (parsedContentType.subtype === 'encrypted') {
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
                        model: Joi.object({
                            success: Joi.binary().description('Success')
                        })
                    }
                }
            },
            responseType: 'message/rfc822',
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            const { pathParams, queryParams, requestBody } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

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
            validationObjs: {
                queryParams: {
                    sendAsString: booleanSchema
                        .default(false)
                        .description('If true then sends the original attachment back in string format with correct encoding.')
                },
                pathParams: {
                    user: userId,
                    mailbox: mailboxId,
                    message: messageId,
                    attachment: Joi.string()
                        .regex(/^ATT\d+$/i)
                        .uppercase()
                        .required()
                        .description('ID of the Attachment')
                },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: Joi.binary()
                        })
                    }
                }
            },
            responseType: 'application/octet-stream',
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...requestBody,
                ...queryParams,
                ...pathParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

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

            res.writeHead(200, {
                'Content-Type': attachmentData.contentType || 'application/octet-stream'
            });

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
            validationObjs: {
                requestBody: {
                    moveTo: Joi.string().hex().lowercase().length(24).description('ID of the target Mailbox if you want to move messages'),

                    seen: booleanSchema.description('State of the \\Seen flag'),
                    deleted: booleanSchema.description('State of the \\Deleted flag'),
                    flagged: booleanSchema.description('State of the \\Flagged flag'),
                    draft: booleanSchema.description('State of the \\Draft flag'),
                    expires: Joi.alternatives()
                        .try(Joi.date(), booleanSchema.allow(false))
                        .description('Either expiration date or false to turn off autoexpiration'),
                    metaData: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),

                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    user: userId,
                    mailbox: mailboxId,
                    message: Joi.string()
                        .regex(/^\d+(,\d+)*$|^\d+:(\d+|\*)$/i)
                        .required()
                        .description(
                            'Message ID. Either singular or comma separated number (1,2,3) or colon separated range (3:15), or a range from UID to end (3:*)'
                        )
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: Joi.array()
                                .items(Joi.object({}))
                                .description(
                                    'If messages were moved then lists new ID values. Array entry is an array with first element pointing to old ID and second to new ID'
                                ),
                            mailbox: Joi.string().description('MoveTo mailbox address'),
                            updated: Joi.number().description('If messages were not moved, then indicates the number of updated messages')
                        }).$_setFlag('objectName', 'UpdateMessageResponse')
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
            validationObjs: {
                requestBody: {
                    message: Joi.string()
                        .regex(/^\d+(,\d+)*$|^\d+:(\d+|\*)$/i)
                        .required()
                        .description(
                            'Message ID. Either singular or comma separated number (1,2,3) or colon separated range (3:15), or a range from UID to end (3:*)'
                        ),
                    moveTo: Joi.string().hex().lowercase().length(24).description('ID of the target Mailbox if you want to move messages'),

                    seen: booleanSchema.description('State of the \\Seen flag'),
                    deleted: booleanSchema.description('State of the \\Deleted flag'),
                    flagged: booleanSchema.description('State of the \\Flagged flag'),
                    draft: booleanSchema.description('State of the \\Draft flag'),
                    expires: Joi.alternatives()
                        .try(Joi.date(), booleanSchema.allow(false))
                        .description('Either expiration date or false to turn off autoexpiration'),
                    metaData: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),

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
                        model: Joi.object({
                            success: successRes,
                            id: Joi.array()
                                .items(Joi.object({}))
                                .description(
                                    'If messages were moved then lists new ID values. Array entry is an array with first element pointing to old ID and second to new ID'
                                ),
                            mailbox: Joi.string().description('MoveTo mailbox address'),
                            updated: Joi.number().description('If messages were not moved, then indicates the number of updated messages')
                        }).$_setFlag('objectName', 'UpdateMessageResponse')
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
                response: { 200: { description: 'Success', model: Joi.object({ success: successRes }).$_setFlag('objectName', 'SuccessResponse') } }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...requestBody,
                ...queryParams,
                ...pathParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

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
            validationObjs: {
                requestBody: {},
                queryParams: {
                    async: booleanSchema.default(false).description('Schedule deletion task'),

                    skipArchive: booleanSchema.default(false).description('Skip archived messages'),
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
                        model: Joi.object({
                            success: successRes,
                            deleted: Joi.number().required().description('Indicates the count of deleted messages'),
                            errors: Joi.number().required().description('Indicate the count of errors during the delete')
                        }).$_setFlag('objectName', 'DeleteMessagesInMailboxResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...requestBody,
                ...queryParams,
                ...pathParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).deleteOwn('messages'));
            } else {
                req.validate(roles.can(req.role).deleteAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let mailbox = new ObjectId(result.value.mailbox);

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
                    mailbox
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
            validationObjs: {
                pathParams: {
                    user: userId,
                    mailbox: mailboxId
                },
                requestBody: {
                    date: Joi.date().description('Date'),
                    unseen: booleanSchema.default(false).description('Is the message unseen or not'),
                    flagged: booleanSchema.default(false).description('Is the message flagged or not'),
                    draft: booleanSchema.default(false).description('Is the message a draft or not'),

                    raw: Joi.binary()
                        .max(consts.MAX_ALLOWED_MESSAGE_SIZE)
                        .empty('')
                        .description(
                            'base64 encoded message source. Alternatively, you can provide this value as POST body by using message/rfc822 MIME type. If raw message is provided then it overrides any other mail configuration'
                        ),

                    from: AddressOptionalName.description('Address for the From: header'),

                    replyTo: AddressOptionalName.description('Address for the Reply-To: header'),

                    to: Joi.array()
                        .items(
                            Joi.object({
                                name: Joi.string().empty('').max(255).description('Name of the sender'),
                                address: Joi.string().email({ tlds: false }).failover('').required().description('Address of the sender')
                            }).$_setFlag('objectName', 'AddressOptionalName')
                        )
                        .description('Addresses for the To: header'),

                    cc: AddressOptionalNameArray.description('Addresses for the Cc: header'),

                    bcc: AddressOptionalNameArray.description('Addresses for the Bcc: header'),

                    headers: Joi.array()
                        .items(Header)
                        .description(
                            'Custom headers for the message. If reference message is set then In-Reply-To and References headers are set automatically'
                        ),

                    subject: Joi.string()
                        .empty('')
                        .max(2 * 1024)
                        .description('Message subject. If not then resolved from Reference message'),
                    text: Joi.string()
                        .empty('')
                        .max(1024 * 1024)
                        .description('Plaintext message'),
                    html: Joi.string()
                        .empty('')
                        .max(1024 * 1024)
                        .description('HTML formatted message'),

                    files: Joi.array()
                        .items(Joi.string().hex().lowercase().length(24))
                        .description(
                            'Attachments as storage file IDs. NB! When retrieving message info then an array of objects is returned. When uploading a message then an array of IDs is used.'
                        ),

                    attachments: Joi.array().items(Attachment).description('Attachments for the message'),

                    metaData: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),

                    reference: ReferenceWithAttachments.description(
                        'Optional referenced email. If uploaded message is a reply draft and relevant fields are not provided then these are resolved from the message to be replied to'
                    ),

                    replacePrevious: Joi.object({
                        mailbox: Joi.string().hex().lowercase().length(24),
                        id: Joi.number().required()
                    }).description('If set, then deletes a previous message when storing the new one. Useful when uploading a new Draft message.'),

                    bimi: Bimi.description('Marks BIMI verification as passed for a domain. NB! BIMI record and logo files for the domain must be valid.'),

                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            message: Joi.object({
                                id: Joi.number().required().description('Message ID in mailbox'),
                                malbox: Joi.string().required().description('Mailbox ID the message was stored into'),
                                size: Joi.number().required().description('Size of the RFC822 formatted email')
                            })
                                .required()
                                .description('Message information'),
                            previousDeleted: booleanSchema.description('Set if replacing a previous message was requested'),
                            previousDeleteError: Joi.string().description('Previous delete error message')
                        }).$_setFlag('objectName', 'UploadMessageResponse')
                    }
                }
            },
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            if (!req.params.raw && req.body && (Buffer.isBuffer(req.body) || typeof req.body === 'string')) {
                req.params.raw = req.body;
            }

            // do this before validation so we would not end up with too large html values
            preprocessAttachments(req.params);

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

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
                    let encrypted = await encryptMessage(userData.pubKey, raw);
                    if (encrypted) {
                        raw = encrypted;
                    }
                } catch (err) {
                    // ignore
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
                let resp = await addMessage({
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
                    raw
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
                    target: Joi.number().min(1).max(1000).description('Number of original forwarding target'),
                    addresses: Joi.array()
                        .items(Joi.string().email({ tlds: false }))
                        .description('An array of additional forward targets'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            queueId: Joi.string().description('Message ID in outbound queue'),
                            forwarded: Joi.array()
                                .items(
                                    Joi.object({
                                        seq: Joi.string().required().description('Sequence ID'),
                                        type: Joi.string().required().description('Target type'),
                                        value: Joi.string().required().description('Target address')
                                    }).$_setFlag('objectName', 'Forwarded')
                                )
                                .description('Information about forwarding targets')
                        }).$_setFlag('objectName', 'ForwardStoredMessageResponse')
                    }
                }
            },
            summary: 'Forward stored Message',
            name: 'forwardStoredMessage',
            description:
                'This method allows either to re-forward a message to an original forward target or forward it to some other address. This is useful if a user had forwarding turned on but the message was not delivered so you can try again. Forwarding does not modify the original message.',
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

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
                stream: response.value
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
                    deleteFiles: booleanSchema.description('If true then deletes attachment files listed in metaData.files array'),
                    sendTime: Joi.date().description('Datestring for delivery if message should be sent some later time'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            queueId: Joi.string().description('Message ID in outbound queue').required(),
                            message: Joi.object({
                                id: Joi.number().description('Message ID in mailbox').required(),
                                mailbox: Joi.string().description('Mailbox ID the message was stored into').required(),
                                size: Joi.number().required().description('Size of the RFC822 formatted email')
                            })
                                .description('Message information')
                                .$_setFlag('objectName', 'Message')
                        }).$_setFlag('objectName', 'SubmitStoredMessageResponse')
                    }
                }
            },
            summary: 'Submit Draft for delivery',
            name: 'submitStoredMessage',
            description: 'This method allows to submit a draft message for delivery. Draft is moved to Sent mail folder.',
            tags: ['Messages']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

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
                res.status(500);
                return res.json({
                    error: 'Database error',
                    code: 'InternalDatabaseError',
                    stack: err.stack
                });
            }

            // Already limited. Or would hit the limit with this message.
            let { success: notLimited, value: messagesSent } = limitCheck || {};
            if (!notLimited || messagesSent + envelope.to.length > maxRecipients) {
                res.status(403);
                return res.json({
                    error: 'You reached a daily sending limit for your account',
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
                let moved = await moveMessage({
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
                                    thread: true,
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
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    queueId: Joi.string().hex().lowercase().min(18).max(24).required().description('Outbound queue ID of the message')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes
                        }).$_setFlag('objectName', 'SuccessResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

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
            description: 'Archive contains all recently deleted messages besides Drafts etc.',
            validationObjs: {
                pathParams: {
                    user: userId
                },
                queryParams: {
                    limit: Joi.number().empty('').default(20).min(1).max(250).description('How many records to return'),
                    next: nextPageCursorSchema,
                    previous: previousPageCursorSchema,
                    order: Joi.any().empty('').allow('asc', 'desc').default('desc').description('Ordering of the records by insert date'),
                    includeHeaders: Joi.string()
                        .max(1024)
                        .trim()
                        .empty('')
                        .example('List-ID, MIME-Version')
                        .description('Comma separated list of header keys to include in the response'),
                    page: pageNrSchema,
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: booleanSchema.description('Indicates successful response').required(),
                            total: Joi.number().description('How many results were found').required(),
                            page: Joi.number().description('Current page number. Derived from page query argument').required(),
                            previousCursor: Joi.alternatives()
                                .try(Joi.string(), booleanSchema)
                                .description('Either a cursor string or false if there are not any previous results')
                                .required(),
                            nextCursor: Joi.alternatives()
                                .try(Joi.string(), booleanSchema)
                                .description('Either a cursor string or false if there are not any next results')
                                .required(),
                            results: Joi.array()
                                .items(
                                    Joi.object({
                                        id: Joi.number().required().description('ID of the Message'),
                                        mailbox: Joi.string().required().description('ID of the Mailbox'),
                                        thread: Joi.string().required().description('ID of the Thread'),
                                        threadMessageCount: Joi.number().description(
                                            'Amount of messages in the Thread. Included if threadCounters query argument was true'
                                        ),
                                        from: Address.description('Sender in From: field'),
                                        to: Joi.array().items(Address).required().description('Recipients in To: field'),
                                        cc: Joi.array().items(Address).required().description('Recipients in Cc: field'),
                                        bcc: Joi.array().items(Address).required().description('Recipients in Bcc: field. Usually only available for drafts'),
                                        messageId: Joi.string().required().description('Message ID'),
                                        subject: Joi.string().required().description('Message subject'),
                                        date: Joi.date().required().description('Date string from header'),
                                        idate: Joi.date().description('Date string of receive time'),
                                        intro: Joi.string().required().description('First 128 bytes of the message'),
                                        attachments: booleanSchema.required().description('Does the message have attachments'),
                                        size: Joi.number().required().description('Message size in bytes'),
                                        seen: booleanSchema.required().description('Is this message already seen or not'),
                                        deleted: booleanSchema
                                            .required()
                                            .description(
                                                'Does this message have a Deleted flag (should not have as messages are automatically deleted once this flag is set)'
                                            ),
                                        flagged: booleanSchema.required().description('Does this message have a Flagged flag'),
                                        draft: booleanSchema.required().description('is this message a draft'),
                                        answered: booleanSchema.required().description('Does this message have a Answered flag'),
                                        forwarded: booleanSchema.required().description('Does this message have a $Forwarded flag'),
                                        references: Joi.array().items(ReferenceWithAttachments).required().description('References'),
                                        bimi: Bimi.required().description(
                                            'Marks BIMI verification as passed for a domain. NB! BIMI record and logo files for the domain must be valid.'
                                        ),
                                        contentType: Joi.object({
                                            value: Joi.string().required().description('MIME type of the message, eg. "multipart/mixed"'),
                                            params: Joi.object().required().description('An object with Content-Type params as key-value pairs')
                                        })
                                            .$_setFlag('objectName', 'ContentType')
                                            .required()
                                            .description('Parsed Content-Type header. Usually needed to identify encrypted messages and such'),
                                        encrypted: booleanSchema.description('Specifies whether the message is encrypted'),
                                        metaData: Joi.object().description('Custom metadata value. Included if metaData query argument was true'),
                                        headers: Joi.object().description('Header object keys requested with the includeHeaders argument')
                                    }).$_setFlag('objectName', 'GetMessagesResult')
                                )
                                .required()
                                .description('Message listing')
                        }).$_setFlag('objectName', 'GetArchivedMessagesResponse')
                    }
                }
            },
            tags: ['Archive']
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, queryParams, requestBody } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true,
                allowUnknown: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('messages'));
            } else {
                req.validate(roles.can(req.role).readAny('messages'));
            }

            let user = new ObjectId(result.value.user);
            let limit = result.value.limit;
            let page = result.value.page;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;
            let sortAscending = result.value.order === 'asc';

            let includeHeaders = result.value.includeHeaders ? result.value.includeHeaders.split(',') : false;

            let total = await db.database.collection('archived').countDocuments({ user });

            let opts = {
                limit,
                query: { user },
                fields: {
                    // FIXME: hack to keep _id in response
                    _id: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection: {
                        _id: true,
                        uid: true,
                        msgid: true,
                        mailbox: true,
                        'meta.from': true,
                        hdate: true,
                        idate: true,
                        subject: true,
                        ha: true,
                        intro: true,
                        size: true,
                        unseen: true,
                        undeleted: true,
                        flagged: true,
                        draft: true,
                        thread: true,
                        flags: true
                    }
                },
                paginatedField: '_id',
                sortAscending
            };

            if (includeHeaders) {
                // get all headers
                opts.fields.projection['mimeTree.parsedHeader'] = true;
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
                    opts.fields.projection[requiredHeader] = true;
                }
            }

            if (pageNext) {
                opts.next = pageNext;
            } else if ((!page || page > 1) && pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listing;
            try {
                listing = await MongoPaging.find(db.database.collection('archived'), opts);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!listing.hasPrevious) {
                page = 1;
            }

            let response = {
                success: true,
                total,
                page,
                previousCursor: listing.hasPrevious ? listing.previous : false,
                nextCursor: listing.hasNext ? listing.next : false,
                results: (listing.results || [])
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
            summary: 'Restore archived messages',
            description:
                'Initiates a restore task to move archived messages of a date range back to the mailboxes the messages were deleted from. If target mailbox does not exist, then the messages are moved to INBOX.',
            validationObjs: {
                pathParams: {
                    user: userId
                },
                requestBody: {
                    start: Joi.date().label('Start time').required().description('Datestring'),
                    end: Joi.date().label('End time').required().description('Datestring'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: booleanSchema.required().description('Indicates successful response'),
                            task: Joi.string().required().description('Task ID')
                        }).$_setFlag('objectName', 'RestoreMessagesResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

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
            summary: 'Restore archived messages',
            description:
                'Initiates a restore task to move archived messages of a date range back to the mailboxes the messages were deleted from. If target mailbox does not exist, then the messages are moved to INBOX.',
            tags: ['Archive'],
            validationObjs: {
                requestBody: {
                    mailbox: Joi.string().hex().lowercase().length(24).description('ID of the target Mailbox. If not set then original mailbox is used.'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    user: userId,
                    message: messageId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: booleanSchema.required().description('Indicates successful response'),
                            mailbox: Joi.string().required().description('Mailbox ID the message was moved to'),
                            id: Joi.number().required().description('New ID for the Message')
                        }).$_setFlag('objectName', 'RestoreMessageResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

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
            // try to use cached value to get the count
            return await getMailboxCounter(db, filter.mailbox, false);
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

                    if (addr.charAt(0) === '*' && address.indexOf(addr.substr(1)) >= 0) {
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
            messageHandler.counters.ttlcounter('wdr:' + userData._id.toString(), envelope.to.length, maxRecipients, false, (err, result) => {
                if (err) {
                    err.responseCode = 500;
                    err.code = 'InternalDatabaseError';
                    return reject(err);
                }

                let success = result.success;
                let sent = result.value;
                let ttl = result.ttl;

                let ttlHuman = false;
                if (ttl) {
                    if (ttl < 60) {
                        ttlHuman = ttl + ' seconds';
                    } else if (ttl < 3600) {
                        ttlHuman = Math.round(ttl / 60) + ' minutes';
                    } else {
                        ttlHuman = Math.round(ttl / 3600) + ' hours';
                    }
                }

                if (!success) {
                    log.info('API', 'RCPTDENY denied sent=%s allowed=%s expires=%ss.', sent, maxRecipients, ttl);
                    let err = new Error('You reached a daily sending limit for your account' + (ttl ? '. Limit expires in ' + ttlHuman : ''));
                    err.responseCode = 403;
                    err.code = 'RateLimitedError';
                    return reject(err);
                }

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
                        runPlugins: true
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

                        let outbound = args[0].id;
                        return resolve(outbound);
                    }
                );

                if (message) {
                    stream.once('error', err => message.emit('error', err));
                    stream.pipe(message);
                }
            });
        });
    }
};

function leftPad(val, chr, len) {
    return chr.repeat(len - val.toString().length) + val;
}

function formatMessageListing(messageData, includeHeaders) {
    includeHeaders = []
        .concat(includeHeaders || [])
        .map(entry => {
            if (typeof entry !== 'string') {
                return false;
            }
            return entry.toLowerCase().trim();
        })
        .filter(entry => entry);

    let parsedHeader = (messageData.mimeTree && messageData.mimeTree.parsedHeader) || {};

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

        if (parsedContentType.subtype === 'encrypted') {
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
