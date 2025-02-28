'use strict';

const config = require('wild-config');
const log = require('npmlog');
const libmime = require('libmime');
const util = require('util');
const MailComposer = require('nodemailer/lib/mail-composer');
const { htmlToText } = require('html-to-text');
const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const Maildropper = require('../maildropper');
const roles = require('../roles');
const Transform = require('stream').Transform;
const { sessSchema, sessIPSchema, booleanSchema, metaDataSchema } = require('../schemas');
const { preprocessAttachments } = require('../data-url');
const { userId, mailboxId } = require('../schemas/request/general-schemas');
const { AddressOptionalName, AddressOptionalNameArray, Header, ReferenceWithoutAttachments } = require('../schemas/request/messages-schemas');
const { successRes } = require('../schemas/response/general-schemas');

class StreamCollect extends Transform {
    constructor() {
        super();
        this.chunks = [];
        this.chunklen = 0;
    }
    _transform(chunk, encoding, done) {
        this.chunks.push(chunk);
        this.chunklen += chunk.length;
        this.push(chunk);
        done();
    }
}

module.exports = (db, server, messageHandler, userHandler, settingsHandler) => {
    let maildrop = new Maildropper({
        db,
        zone: config.sender.zone,
        collection: config.sender.collection,
        gfs: config.sender.gfs,
        loopSecret: config.sender.loopSecret
    });

    function submitMessage(options, callback) {
        let user = options.user;

        db.users.collection('users').findOne(
            { _id: user },
            {
                projection: {
                    username: true,
                    name: true,
                    address: true,
                    quota: true,
                    storageUsed: true,
                    recipients: true,
                    encryptMessages: true,
                    pubKey: true,
                    disabled: true,
                    suspended: true,
                    fromWhitelist: true
                }
            },
            (err, userData) => {
                if (err) {
                    err.responseCode = 500;
                    err.code = 'InternalDatabaseError';
                    return callback(err);
                }

                if (!userData) {
                    err = new Error('This user does not exist');
                    err.responseCode = 404;
                    err.code = 'UserNotFound';
                    return callback();
                }

                if (userData.disabled || userData.suspended) {
                    err = new Error('User account is disabled');
                    err.responseCode = 403;
                    err.code = 'UserDisabled';
                    return callback(err);
                }

                settingsHandler
                    .getMulti(['const:max:storage', 'const:max:recipients', 'const:max:forwards'])
                    .then(settings => {
                        let overQuota = Number(userData.quota || settings['const:max:storage']) - userData.storageUsed <= 0;
                        let maxRecipients = userData.recipients || config.maxRecipients || settings['const:max:recipients'];

                        let getReferencedMessage = done => {
                            if (!options.reference) {
                                return done(null, false);
                            }
                            let query = {};
                            if (typeof options.reference === 'object') {
                                query.mailbox = options.reference.mailbox;
                                query.uid = options.reference.id;
                            } else {
                                return done(null, false);
                            }
                            query.user = user;

                            let getMessage = next => {
                                let updateable = ['reply', 'replyAll', 'forward'];
                                if (!options.reference || !updateable.includes(options.reference.action)) {
                                    return db.database.collection('messages').findOne(
                                        query,
                                        {
                                            projection: {
                                                'mimeTree.parsedHeader': true,
                                                thread: true
                                            }
                                        },
                                        next
                                    );
                                }
                                let $addToSet = {};
                                switch (options.reference.action) {
                                    case 'reply':
                                    case 'replyAll':
                                        $addToSet.flags = '\\Answered';
                                        break;
                                    case 'forward':
                                        $addToSet.flags = { $each: ['\\Answered', '$Forwarded'] };
                                        break;
                                }

                                db.database.collection('messages').findOneAndUpdate(
                                    query,
                                    {
                                        $addToSet
                                    },
                                    {
                                        returnDocument: 'after',
                                        projection: {
                                            'mimeTree.parsedHeader': true,
                                            uid: true,
                                            flags: true,
                                            thread: true
                                        }
                                    },
                                    (err, r) => {
                                        if (err) {
                                            return next(err);
                                        }

                                        let messageData = r && r.value;
                                        if (!messageData) {
                                            return next(null, false);
                                        }

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

                                        return messageHandler.notifier.addEntries(options.reference.mailbox, notifyEntries, () => {
                                            messageHandler.notifier.fire(user);
                                            return next(null, messageData);
                                        });
                                    }
                                );
                            };

                            getMessage((err, messageData) => {
                                if (err) {
                                    err.responseCode = 500;
                                    err.code = 'InternalDatabaseError';
                                    return callback(err);
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
                                    let address = tools.normalizeAddress(addr.address);

                                    if (address !== userData.address && !uniqueRecipients.has(address)) {
                                        uniqueRecipients.add(address);
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

                                if (sender && sender.address) {
                                    checkAddress(replyTo, sender);
                                }

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

                                let referenceData = {
                                    replyTo,
                                    replyCc,
                                    subject,
                                    thread: messageData.thread,
                                    inReplyTo: messageId,
                                    references: references.join(' ')
                                };

                                return done(null, referenceData);
                            });
                        };

                        getReferencedMessage((err, referenceData) => {
                            if (err) {
                                return callback(err);
                            }

                            let envelope = options.envelope;

                            if (!envelope) {
                                envelope = {
                                    from: options.from,
                                    to: []
                                };
                            }

                            if (!envelope.from) {
                                if (options.from) {
                                    envelope.from = options.from;
                                } else {
                                    options.from = envelope.from = {
                                        name: userData.name || '',
                                        address: userData.address
                                    };
                                }
                            }

                            options.from = options.from || envelope.from;

                            let validateFromAddress = (address, next) => {
                                if (options.uploadOnly) {
                                    // message is not sent, so we do not care if address is valid or not
                                    return next(null, address);
                                }

                                if (!address || address === userData.address) {
                                    // using default address, ok
                                    return next(null, userData.address);
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
                                        return next(null, address);
                                    }
                                }

                                userHandler.get(address, false, (err, resolvedUser) => {
                                    if (err) {
                                        return next(err);
                                    }
                                    if (!resolvedUser || resolvedUser._id.toString() !== userData._id.toString()) {
                                        return next(null, userData.address);
                                    }
                                    return next(null, address);
                                });
                            };

                            // make sure that envelope address is allowed for current user
                            validateFromAddress(tools.normalizeAddress(envelope.from.address), (err, address) => {
                                if (err) {
                                    return callback(err);
                                }
                                envelope.from.address = address;

                                // make sure that message header address is allowed for current user
                                validateFromAddress(tools.normalizeAddress(options.from.address), (err, address) => {
                                    if (err) {
                                        return callback(err);
                                    }
                                    options.from.address = address;

                                    if (!envelope.to.length) {
                                        envelope.to = envelope.to
                                            .concat(options.to || [])
                                            .concat(options.cc || [])
                                            .concat(options.bcc || []);
                                        if (!envelope.to.length && referenceData && ['reply', 'replyAll'].includes(options.reference.action)) {
                                            envelope.to = envelope.to.concat(referenceData.replyTo || []).concat(referenceData.replyCc || []);
                                            options.to = referenceData.replyTo;
                                            options.cc = referenceData.replyCc;
                                        }
                                    }

                                    let extraHeaders = [];
                                    if (referenceData) {
                                        if (['reply', 'replyAll'].includes(options.reference.action) && referenceData.inReplyTo) {
                                            extraHeaders.push({ key: 'In-Reply-To', value: referenceData.inReplyTo });
                                        }
                                        if (referenceData.references) {
                                            extraHeaders.push({ key: 'References', value: referenceData.references });
                                        }
                                    }

                                    let now = new Date();
                                    let sendTime = options.sendTime;
                                    if (!sendTime || sendTime < now) {
                                        sendTime = now;
                                    }

                                    let data = {
                                        envelope,
                                        from: options.from,
                                        date: sendTime,
                                        to: options.to || [],
                                        cc: options.cc || [],
                                        bcc: options.bcc || [],
                                        subject: options.subject || (referenceData && referenceData.subject) || '',
                                        text: options.text || '',
                                        html: options.html || '',
                                        headers: extraHeaders.concat(options.headers || []),
                                        attachments: options.attachments || [],
                                        disableFileAccess: true,
                                        disableUrlAccess: true
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

                                    let compiler = new MailComposer(data);
                                    let compiled = compiler.compile();
                                    let collector = new StreamCollect();
                                    let compiledEnvelope = compiled.getEnvelope();

                                    let messageId = new ObjectId();
                                    let addToDeliveryQueue = next => {
                                        if (!compiledEnvelope.to || !compiledEnvelope.to.length || options.uploadOnly) {
                                            // no delivery, just build the message
                                            collector.on('data', () => false); //drain
                                            collector.on('end', () => {
                                                next(null, false);
                                            });
                                            collector.once('error', err => {
                                                next(err);
                                            });
                                            let stream = compiled.createReadStream();
                                            stream.once('error', err => collector.emit('error', err));
                                            stream.pipe(collector);
                                            return;
                                        }

                                        messageHandler.counters.ttlcounter(
                                            'wdr:' + userData._id.toString(),
                                            compiledEnvelope.to.length,
                                            maxRecipients,
                                            false,
                                            (err, result) => {
                                                if (err) {
                                                    err.responseCode = 500;
                                                    err.code = 'InternalDatabaseError';
                                                    return callback(err);
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
                                                    let err = new Error(
                                                        'You reached a daily sending limit for your account' + (ttl ? '. Limit expires in ' + ttlHuman : '')
                                                    );
                                                    err.responseCode = 403;
                                                    err.code = 'RateLimitedError';
                                                    return setImmediate(() => callback(err));
                                                }

                                                // push message to outbound queue
                                                let message = maildrop.push(
                                                    {
                                                        user: userData._id,
                                                        userEmail: userData.address,
                                                        parentId: messageId,
                                                        reason: 'submit',
                                                        from: compiledEnvelope.from,
                                                        to: compiledEnvelope.to,
                                                        sendTime,
                                                        origin: options.ip,
                                                        runPlugins: true
                                                    },
                                                    (err, ...args) => {
                                                        if (err || !args[0]) {
                                                            if (err) {
                                                                if (!err.code && err.name === 'SMTPReject') {
                                                                    err.code = 'MessageRejected';
                                                                }

                                                                err.code = err.code || 'ERRCOMPOSE';
                                                            }
                                                            err.responseCode = 500;
                                                            return callback(err, ...args);
                                                        }

                                                        let outbound = args[0].id;
                                                        return next(null, outbound);
                                                    }
                                                );

                                                if (message) {
                                                    let stream = compiled.createReadStream();
                                                    stream.once('error', err => message.emit('error', err));
                                                    stream.pipe(collector).pipe(message);
                                                }
                                            }
                                        );
                                    };

                                    addToDeliveryQueue((err, outbound) => {
                                        if (err) {
                                            // ignore
                                        }
                                        if (overQuota) {
                                            log.info('API', 'STOREFAIL user=%s error=%s', user, 'Over quota');
                                            return callback(null, {
                                                id: false,
                                                mailbox: false,
                                                queueId: outbound,
                                                overQuota: true
                                            });
                                        }

                                        // Checks if the message needs to be encrypted before storing it
                                        messageHandler.encryptMessage(
                                            userData.encryptMessages ? userData.pubKey : false,
                                            { chunks: collector.chunks, chunklen: collector.chunklen },
                                            (err, encrypted) => {
                                                let raw = false;
                                                if (!err && encrypted) {
                                                    // message was encrypted, so use the result instead of raw
                                                    raw = encrypted;
                                                }

                                                let meta = {
                                                    source: 'API',
                                                    from: compiledEnvelope.from,
                                                    to: compiledEnvelope.to,
                                                    origin: options.ip,
                                                    sess: options.sess,
                                                    time: new Date()
                                                };

                                                if (options.meta) {
                                                    Object.keys(options.meta || {}).forEach(key => {
                                                        if (!(key in meta)) {
                                                            meta[key] = options.meta[key];
                                                        }
                                                    });
                                                }

                                                let messageOptions = {
                                                    user: userData._id,
                                                    [options.mailbox ? 'mailbox' : 'specialUse']: options.mailbox
                                                        ? new ObjectId(options.mailbox)
                                                        : options.isDraft
                                                        ? '\\Drafts'
                                                        : '\\Sent',

                                                    outbound,

                                                    meta,

                                                    date: false,
                                                    flags: ['\\Seen'].concat(options.isDraft ? '\\Draft' : [])
                                                };

                                                if (raw) {
                                                    messageOptions.raw = raw;
                                                } else {
                                                    messageOptions.raw = Buffer.concat(collector.chunks, collector.chunklen);
                                                }

                                                messageHandler.add(messageOptions, (err, success, info) => {
                                                    if (err) {
                                                        log.error('API', 'SUBMITFAIL user=%s error=%s', user, err.message);
                                                        err.responseCode = 500;
                                                        err.code = 'InternalDatabaseError';
                                                        return callback(err);
                                                    } else if (!info) {
                                                        log.info('API', 'SUBMITSKIP user=%s message=already exists', user);
                                                        return callback(null, false);
                                                    }

                                                    let done = () =>
                                                        callback(null, {
                                                            id: info.uid,
                                                            mailbox: info.mailbox,
                                                            queueId: outbound
                                                        });

                                                    if (options.draft) {
                                                        return db.database.collection('messages').findOne(
                                                            {
                                                                mailbox: new ObjectId(options.draft.mailbox),
                                                                uid: options.draft.id
                                                            },
                                                            (err, messageData) => {
                                                                if (err || !messageData || messageData.user.toString() !== user.toString()) {
                                                                    return done();
                                                                }

                                                                messageHandler.del(
                                                                    {
                                                                        user,
                                                                        mailbox: new ObjectId(options.draft.mailbox),
                                                                        messageData,
                                                                        archive: !messageData.flags.includes('\\Draft')
                                                                    },
                                                                    done
                                                                );
                                                            }
                                                        );
                                                    }
                                                    done();
                                                });
                                            }
                                        );
                                    });
                                });
                            });
                        });
                    })
                    .catch(err => callback(err));
            }
        );
    }

    const submitMessageWrapper = util.promisify(submitMessage);

    server.post(
        {
            name: 'submitMessage',
            path: '/users/:user/submit',
            tags: ['Submission'],
            summary: 'Submit a Message for Delivery',
            description: 'Use this method to send emails from a user account',
            validationObjs: {
                requestBody: {
                    mailbox: Joi.string().hex().lowercase().length(24).description('ID of the Mailbox'),
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
                    attachments: Joi.array()
                        .items(
                            Joi.object({
                                filename: Joi.string().empty('').max(255).description('Attachment filename'),
                                contentType: Joi.string().empty('').max(255).description('MIME type for the attachment file'),
                                encoding: Joi.string().empty('').default('base64').description('Encoding to use to store the attachments'),
                                contentTransferEncoding: Joi.string().empty('').description('Transfer encoding'),
                                contentDisposition: Joi.string().empty('').trim().lowercase().valid('inline', 'attachment').description('Content Disposition'),
                                content: Joi.string().required().description('Base64 encoded attachment content'),
                                cid: Joi.string()
                                    .empty('')
                                    .max(255)
                                    .description('Content-ID value if you want to reference to this attachment from HTML formatted message')
                            })
                        )
                        .description('Attachments for the message'),

                    meta: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),
                    sess: sessSchema,
                    ip: sessIPSchema,
                    reference: ReferenceWithoutAttachments.description(
                        'Optional referenced email. If uploaded message is a reply draft and relevant fields are not provided then these are resolved from the message to be replied to'
                    ),
                    // if true then treat this message as a draft
                    isDraft: booleanSchema.default(false).description('Is the message a draft or not'),
                    // if set then this message is based on a draft that should be deleted after processing
                    draft: Joi.object()
                        .keys({
                            mailbox: mailboxId,
                            id: Joi.number().required().description('Message ID')
                        })
                        .description('Draft message to base this one on'),
                    sendTime: Joi.date().description('Send time'),
                    uploadOnly: booleanSchema.default(false).description('If true only uploads the message but does not send it'),
                    envelope: Joi.object()
                        .keys({
                            from: AddressOptionalName.description('Address for the From: header'),
                            to: Joi.array().items(
                                Joi.object()
                                    .keys({
                                        name: Joi.string().empty('').max(255).description('Name of the sender'),
                                        address: Joi.string().email({ tlds: false }).required().description('Address of the sender')
                                    })
                                    .description('Addresses for the To: header')
                            )
                        })
                        .description('Optional envelope')
                },
                queryParams: {},
                pathParams: {
                    user: userId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            message: Joi.object({
                                mailbox: Joi.string().required().description('Mailbox ID the message was stored to'),
                                id: Joi.number().description('Message ID in the Mailbox').required(),
                                queueId: Joi.string().required().description('Queue ID in MTA')
                            })
                                .required()
                                .description('Information about submitted Message')
                                .$_setFlag('objectName', 'MessageWithQueueId')
                        }).$_setFlag('objectName', 'SubmitMessageResponse')
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

            // extract embedded attachments from HTML
            preprocessAttachments(req.params);

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
                req.validate(roles.can(req.role).createOwn('messages'));
            } else {
                req.validate(roles.can(req.role).createAny('messages'));
            }

            result.value.user = new ObjectId(result.value.user);
            if (result.value.reference && result.value.reference.mailbox) {
                result.value.reference.mailbox = new ObjectId(result.value.reference.mailbox);
            }

            let info;
            try {
                info = await submitMessageWrapper(result.value);
            } catch (err) {
                log.error('API', 'SUBMIT error=%s', err.message);
                res.status(500); // TODO: use response code specific status
                return res.json({
                    error: err.message,
                    code: err.code
                });
            }

            return res.json({
                success: true,
                message: info
            });
        })
    );
};
