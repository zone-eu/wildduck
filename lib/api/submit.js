'use strict';

const config = require('@zone-eu/wild-config');
const { objectIdSchema } = require('../schemas/json-schemas');
const log = require('npmlog');
const libmime = require('libmime');
const { buffer } = require('stream/consumers');
const MailComposer = require('nodemailer/lib/mail-composer');
const { htmlToText } = require('html-to-text');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const Maildropper = require('../maildropper');
const roles = require('../roles');
const { preprocessAttachments } = require('../data-url');
const { AddressOptionalName, AddressOptionalNameArray, Attachment, Header, ReferenceWithoutAttachments } = require('../schemas/request/messages-schemas');

const USER_PROJECTION = {
    username: true,
    name: true,
    address: true,
    quota: true,
    storageUsed: true,
    recipients: true,
    encryptMessages: true,
    pubKey: true,
    smimeCerts: true,
    smimeCipher: true,
    smimeKeyTransport: true,
    disabled: true,
    suspended: true,
    fromWhitelist: true,
    mtaRelay: true
};

const databaseError = err => {
    err.responseCode = 500;
    err.code = 'InternalDatabaseError';
    return err;
};

// reply/replyAll recipients are the sender and (for replyAll) everyone in To/Cc,
// except the user's own address and duplicates
const collectReplyRecipients = (headers, userAddress, action) => {
    let replyTo = [];
    let replyCc = [];
    let uniqueRecipients = new Set();

    let checkAddress = (target, addr) => {
        let address = tools.normalizeAddress(addr.address);

        if (address !== userAddress && !uniqueRecipients.has(address)) {
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

    let walk = (target, addr) => {
        if (addr.address) {
            checkAddress(target, addr);
        } else if (addr.group) {
            addr.group.forEach(entry => walk(target, entry));
        }
    };

    // parsed address headers are arrays
    let sender = headers['reply-to'] || headers.from || headers.sender;
    [].concat(sender || []).forEach(addr => walk(replyTo, addr));

    if (action === 'replyAll') {
        [].concat(headers.to || []).forEach(addr => walk(replyTo, addr));
        [].concat(headers.cc || []).forEach(addr => walk(replyCc, addr));
    }

    return { replyTo, replyCc };
};

const formatTtl = ttl => {
    if (!ttl || ttl <= 0) {
        return false;
    }
    if (ttl < 60) {
        return ttl + ' seconds';
    }
    if (ttl < 3600) {
        return Math.round(ttl / 60) + ' minutes';
    }
    return Math.round(ttl / 3600) + ' hours';
};

module.exports = (db, server, messageHandler, userHandler, settingsHandler) => {
    let maildrop = new Maildropper({
        db,
        zone: config.sender.zone,
        collection: config.sender.collection,
        gfs: config.sender.gfs,
        maxQueueTime: config.sender.maxQueueTime,
        loopSecret: config.sender.loopSecret
    });

    // Loads the message a reply or a forward is based on and derives the subject,
    // the reply recipients and the threading headers from it
    async function getReferencedMessage(options, userData) {
        if (!options.reference || typeof options.reference !== 'object') {
            return false;
        }

        let query = {
            mailbox: options.reference.mailbox,
            uid: options.reference.id,
            user: options.user
        };

        let messageData;
        try {
            messageData = await db.database.collection('messages').findOne(query, {
                projection: {
                    'mimeTree.parsedHeader': true,
                    thread: true
                }
            });
        } catch (err) {
            throw databaseError(err);
        }

        if (!messageData) {
            return false;
        }

        let headers = (messageData.mimeTree && messageData.mimeTree.parsedHeader) || {};
        let subject = headers.subject || '';
        try {
            subject = libmime.decodeWords(subject).trim();
        } catch (E) {
            // failed to parse value
        }

        if (!/^\w+: /.test(subject)) {
            subject = ((options.reference.action === 'forward' ? 'Fwd' : 'Re') + ': ' + subject).trim();
        }

        let { replyTo, replyCc } = collectReplyRecipients(headers, userData.address, options.reference.action);

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

        return {
            replyTo,
            replyCc,
            subject,
            thread: messageData.thread,
            inReplyTo: messageId,
            references: references.join(' ')
        };
    }

    // Removes the draft the submitted message was based on. Failures are logged only,
    // the submitted message is already stored
    async function deleteDraft(options, user) {
        if (!options.draft) {
            return;
        }

        let mailbox = new ObjectId(options.draft.mailbox);

        let messageData;
        try {
            messageData = await db.database.collection('messages').findOne({
                mailbox,
                uid: options.draft.id
            });
        } catch {
            return;
        }

        if (!messageData || messageData.user.toString() !== user.toString()) {
            return;
        }

        try {
            await messageHandler.delAsync({
                user,
                mailbox: {
                    user,
                    mailbox
                },
                messageData,
                archive: !messageData.flags.includes('\\Draft')
            });
        } catch (err) {
            log.error('API', 'DRAFTDELFAIL user=%s mailbox=%s uid=%s error=%s', user, mailbox, options.draft.id, err.message);
        }
    }

    // Resolves which sender address the user may use. Unknown addresses fall back to
    // the account's main address unless whitelisted or owned by the same user
    async function validateFromAddress(userData, address, options) {
        if (options.uploadOnly) {
            // message is not sent, so we do not care if address is valid or not
            return address;
        }

        if (!address || address === userData.address) {
            // using default address, ok
            return userData.address;
        }

        if (
            userData.fromWhitelist &&
            userData.fromWhitelist.length &&
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

        let resolvedUser = await userHandler.asyncGet(address, false);
        if (!resolvedUser || resolvedUser._id.toString() !== userData._id.toString()) {
            return userData.address;
        }
        return address;
    }

    const recipientCounterKey = userData => 'wdr:' + userData._id.toString();

    // Rejects if the message has more recipients than allowed per message or than the
    // account may still send today
    async function checkDeliveryLimits(userData, recipientCount, { maxRecipients, maxRptsTo }) {
        if (recipientCount > maxRptsTo) {
            let err = new Error('Your email has too many recipients');
            err.responseCode = 403;
            err.code = 'TooMany';
            throw err;
        }

        let limitCheck;
        try {
            limitCheck = await messageHandler.counters.asyncTTLCounter(recipientCounterKey(userData), 0, maxRecipients, false);
        } catch (err) {
            throw databaseError(err);
        }

        let { success, value: sent, ttl } = limitCheck;

        if (!success || sent + recipientCount > maxRecipients) {
            log.info('API', 'RCPTDENY denied sent=%s allowed=%s expires=%ss.', sent, maxRecipients, ttl);
            let ttlHuman = formatTtl(ttl);
            let err = new Error('You reached a daily sending limit for your account' + (ttlHuman ? '. Limit expires in ' + ttlHuman : ''));
            err.responseCode = 403;
            err.code = 'RateLimitedError';
            throw err;
        }
    }

    // Pushes the compiled message to the outbound queue and counts its recipients
    // against the daily limit. Resolves with the queue id
    async function queueForDelivery(userData, raw, compiledEnvelope, { parentId, sendTime, origin, maxRecipients }) {
        let queued = await maildrop.pushStream(
            {
                user: userData._id,
                userEmail: userData.address,
                parentId,
                reason: 'submit',
                from: compiledEnvelope.from,
                to: compiledEnvelope.to,
                sendTime,
                origin,
                passwordType: 'master',
                runPlugins: true,
                mtaRelay: userData.mtaRelay || false
            },
            raw
        );

        try {
            await messageHandler.counters.asyncTTLCounter(recipientCounterKey(userData), compiledEnvelope.to.length, maxRecipients, false);
        } catch (err) {
            throw databaseError(err);
        }

        return queued.id;
    }

    // Encrypts the message for storage if the account requires it. Any failure
    // falls back to storing the message unencrypted
    async function encryptForStorage(userData, raw, options) {
        try {
            let encryptResult = await messageHandler.encryptMessageAsync(tools.getUserEncryptionKey(userData), raw);
            if (encryptResult) {
                return encryptResult.raw;
            }
            log.error(
                'ENCRYPT',
                'Encryption returned false, message stored unencrypted (source=%s user=%s ip=%s sess=%s)',
                'api_submit',
                userData._id,
                options.ip,
                options.sess
            );
            server.loggelf({
                short_message: '[ENCRYPTSKIP] Encryption returned false, message stored unencrypted',
                _mail_action: 'encrypt_skip',
                _user: userData._id,
                _ip: options.ip,
                _sess: options.sess,
                _source: 'api_submit'
            });
        } catch (err) {
            log.error(
                'ENCRYPT',
                'Encryption failed, message stored unencrypted (source=%s user=%s ip=%s sess=%s code=%s): %s',
                'api_submit',
                userData._id,
                options.ip,
                options.sess,
                err.code || 'EncryptionError',
                err.message
            );
            server.loggelf({
                short_message: '[ENCRYPTFAIL] Encryption failed, message stored unencrypted',
                _mail_action: 'encrypt_fail',
                _user: userData._id,
                _error: err.message,
                _code: err.code || 'EncryptionError',
                _ip: options.ip,
                _sess: options.sess,
                _source: 'api_submit'
            });
        }
        return raw;
    }

    // Composes the message, queues it for delivery (unless it is a draft or upload
    // only) and stores a copy in the Drafts or Sent folder. Resolves with the stored
    // message info, or false if an identical message was already stored
    async function submitMessage(options) {
        let user = options.user;

        let loadUser = async () => {
            try {
                return await db.users.collection('users').findOne({ _id: user }, { projection: USER_PROJECTION });
            } catch (err) {
                throw databaseError(err);
            }
        };

        let [userData, settings] = await Promise.all([
            loadUser(),
            settingsHandler.getMulti(['const:max:storage', 'const:max:recipients', 'const:max:forwards', 'const:max:rcpt_to'])
        ]);

        if (!userData) {
            let err = new Error('This user does not exist');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        if (userData.disabled || userData.suspended) {
            let err = new Error('User account is disabled');
            err.responseCode = 403;
            err.code = 'UserDisabled';
            throw err;
        }

        let overQuota = Number(userData.quota || settings['const:max:storage']) - userData.storageUsed <= 0;
        let maxRecipients = userData.recipients || config.maxRecipients || settings['const:max:recipients'];
        let maxRptsTo = settings['const:max:rcpt_to'];

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

        let envelopeFrom = tools.normalizeAddress(envelope.from.address);
        let headerFrom = tools.normalizeAddress(options.from.address);

        // make sure that the envelope and the message header addresses are allowed for the
        // current user; the header address usually is the envelope address, so it is only
        // resolved separately when it differs
        let [referenceData, validatedEnvelopeFrom, validatedHeaderFrom] = await Promise.all([
            getReferencedMessage(options, userData),
            validateFromAddress(userData, envelopeFrom, options),
            headerFrom !== envelopeFrom && validateFromAddress(userData, headerFrom, options)
        ]);

        envelope.from.address = validatedEnvelopeFrom;
        options.from.address = validatedHeaderFrom || validatedEnvelopeFrom;

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
            replyTo: options.replyTo,
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
        // Keep Bcc in the local Draft/Sent copy. Maildropper strips Bcc from queued delivery.
        compiled.keepBcc = true;
        let compiledEnvelope = compiled.getEnvelope();

        let deliver = !!(compiledEnvelope.to && compiledEnvelope.to.length && !options.uploadOnly && !options.isDraft);
        if (deliver) {
            // reject early, before the message is composed
            await checkDeliveryLimits(userData, compiledEnvelope.to.length, { maxRecipients, maxRptsTo });
        }

        let raw;
        try {
            raw = await buffer(compiled.createReadStream());
        } catch (err) {
            err.code = err.code || 'ERRCOMPOSE';
            err.responseCode = 500;
            throw err;
        }

        let messageId = new ObjectId();

        let outbound = false;
        if (deliver) {
            outbound = await queueForDelivery(userData, raw, compiledEnvelope, {
                parentId: messageId,
                sendTime,
                origin: options.ip,
                maxRecipients
            });
        }

        if (overQuota) {
            log.info('API', 'STOREFAIL user=%s error=%s', user, 'Over quota');
            if (outbound) {
                await messageHandler.flagReferencedMessage(user, options.reference);
            }
            return {
                id: false,
                mailbox: false,
                queueId: outbound,
                overQuota: true
            };
        }

        if (userData.encryptMessages && !options.isDraft) {
            raw = await encryptForStorage(userData, raw, options);
        }

        let reference = referenceData && options.reference;
        let meta = {
            source: 'API',
            from: compiledEnvelope.from,
            to: compiledEnvelope.to,
            origin: options.ip,
            sess: options.sess,
            time: new Date(),
            reference: reference
                ? {
                      action: options.reference.action,
                      mailbox:
                          options.reference.mailbox && options.reference.mailbox.toString ? options.reference.mailbox.toString() : options.reference.mailbox,
                      id: options.reference.id
                  }
                : false
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
            [options.mailbox ? 'mailbox' : 'specialUse']: options.mailbox ? new ObjectId(options.mailbox) : options.isDraft ? '\\Drafts' : '\\Sent',

            outbound,

            meta,

            date: false,
            flags: ['\\Seen'].concat(options.isDraft ? '\\Draft' : []),
            raw
        };

        let added;
        try {
            added = await messageHandler.addAsync(messageOptions);
        } catch (err) {
            log.error('API', 'SUBMITFAIL user=%s error=%s', user, err.message);
            throw databaseError(err);
        }

        let info = added && added.data;
        if (!info) {
            log.info('API', 'SUBMITSKIP user=%s message=already exists', user);
            return false;
        }

        await Promise.all([outbound && messageHandler.flagReferencedMessage(user, options.reference), deleteDraft(options, user)]);

        return {
            id: info.uid,
            mailbox: info.mailbox,
            queueId: outbound
        };
    }

    server.route({
        method: 'POST',
        url: '/users/:user/submit',
        schema: {
            summary: 'Submit a Message for Delivery',
            description: 'Use this method to send emails from a user account',
            tags: ['Submission']
        },
        config: {
            name: 'submitMessage',
            allowUnknown: true,
            // extract embedded attachments from HTML before validation
            preValidate: preprocessAttachments,
            validationObjs: {
                requestBody: {
                    mailbox: objectIdSchema('ID of the Mailbox'),
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
                        description: 'Custom headers for the message. If reference message is set then In-Reply-To and References headers are set automatically'
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
                    attachments: {
                        type: 'array',
                        items: Attachment,
                        description: 'Attachments for the message'
                    },

                    meta: { $ref: 'wd:metaData', description: 'Optional metadata, must be an object or JSON formatted string' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' },
                    reference: Object.assign({}, ReferenceWithoutAttachments, {
                        description:
                            'Optional referenced email. If uploaded message is a reply draft and relevant fields are not provided then these are resolved from the message to be replied to'
                    }),
                    // if true then treat this message as a draft
                    isDraft: { $ref: 'wd:boolean', default: false, description: 'If true then stores the message as a draft without queueing delivery' },
                    // if set then this message is based on a draft that should be deleted after processing
                    draft: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            mailbox: objectIdSchema('ID of the Mailbox', { wdRequired: true }),
                            id: { type: 'number', wdType: 'number', wdRequired: true, description: 'Message ID' }
                        },
                        required: ['mailbox', 'id'],
                        description: 'Draft message to base this one on'
                    },
                    sendTime: { wdType: 'date', wdInstanceof: 'Date', description: 'Send time' },
                    uploadOnly: { $ref: 'wd:boolean', default: false, description: 'If true only uploads the message but does not send it' },
                    envelope: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            from: Object.assign({}, AddressOptionalName, { description: 'Address for the From: header' }),
                            to: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    description: 'Addresses for the To: header',
                                    properties: {
                                        name: { type: 'string', maxLength: 255, minLength: 1, wdEmpty: true, description: 'Name of the sender' },
                                        address: { type: 'string', wdValidator: 'email', wdRequired: true, description: 'Address of the sender' }
                                    },
                                    required: ['address']
                                }
                            }
                        },
                        description: 'Optional envelope'
                    }
                },
                queryParams: {},
                pathParams: {
                    user: { $ref: 'wd:userId' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SubmitMessageResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                message: {
                                    // the message value is false when the message was deduplicated
                                    // instead of stored (SUBMITSKIP), hence the boolean alternative
                                    anyOf: [
                                        {
                                            type: 'object',
                                            title: 'MessageWithQueueId',
                                            additionalProperties: true,
                                            properties: {
                                                mailbox: { description: 'Mailbox ID the message was stored to or false if not stored' },
                                                id: { description: 'Message ID in the Mailbox or false if not stored' },
                                                queueId: { description: 'Queue ID in MTA or false if not queued' }
                                            }
                                        },
                                        { type: 'boolean' }
                                    ],
                                    description: 'Information about submitted Message'
                                }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).createOwn('messages'));
            } else {
                req.validate(roles.can(req.role).createAny('messages'));
            }

            if (values.meta && typeof values.meta === 'string') {
                try {
                    values.meta = JSON.parse(values.meta);
                } catch (err) {
                    values.meta = undefined;
                }
            }

            values.user = new ObjectId(values.user);
            if (values.reference && values.reference.mailbox) {
                values.reference.mailbox = new ObjectId(values.reference.mailbox);
            }

            let info;
            try {
                info = await submitMessage(values);
            } catch (err) {
                log.error('API', 'SUBMIT error=%s', err.message);
                return reply.code(err.responseCode || 500).send({
                    error: err.message,
                    code: err.code
                });
            }

            return reply.send({
                success: true,
                message: info
            });
        }
    });
};
