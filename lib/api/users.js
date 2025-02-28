'use strict';

const log = require('npmlog');
const config = require('wild-config');
const Joi = require('joi');
const MongoPaging = require('mongo-cursor-pagination');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const errors = require('../errors');
const openpgp = require('openpgp');
const BSON = require('bson');
const consts = require('../consts');
const roles = require('../roles');
const imapTools = require('../../imap-core/lib/imap-tools');
const pwnedpasswords = require('pwnedpasswords');
const {
    nextPageCursorSchema,
    previousPageCursorSchema,
    pageNrSchema,
    sessSchema,
    sessIPSchema,
    booleanSchema,
    metaDataSchema,
    usernameSchema
} = require('../schemas');
const TaskHandler = require('../task-handler');
const { publish, FORWARD_ADDED } = require('../events');
const { ExportStream, ImportStream } = require('../export');
const { successRes, totalRes, pageRes, previousCursorRes, nextCursorRes, quotaRes } = require('../schemas/response/general-schemas');
const { GetUsersResult } = require('../schemas/response/users-schemas');
const { userId } = require('../schemas/request/general-schemas');

const FEATURE_FLAGS = ['indexing'];

module.exports = (db, server, userHandler, settingsHandler) => {
    const taskHandler = new TaskHandler({ database: db.database });

    server.get(
        {
            name: 'getUsers',
            path: '/users',
            summary: 'List registered Users',
            tags: ['Users'],
            validationObjs: {
                pathParams: {},
                requestBody: {},
                queryParams: {
                    query: Joi.string().empty('').lowercase().max(255).description('Partial match of username or default email address'),
                    forward: Joi.string().empty('').lowercase().max(255).description('Partial match of a forward email address or URL'),
                    tags: Joi.string().trim().empty('').max(1024).description('Comma separated list of tags. The User must have at least one to be set'),
                    requiredTags: Joi.string()
                        .trim()
                        .empty('')
                        .max(1024)
                        .description('Comma separated list of tags. The User must have all listed tags to be set'),
                    metaData: booleanSchema.description('If true, then includes metaData in the response'),
                    internalData: booleanSchema.description('If true, then includes internalData in the response. Not shown for user-role tokens.'),
                    limit: Joi.number().default(20).min(1).max(250).description('How many records to return'),
                    next: nextPageCursorSchema,
                    previous: previousPageCursorSchema,
                    page: pageNrSchema,
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            total: totalRes,
                            page: pageRes,
                            previousCursor: previousCursorRes,
                            nextCursor: nextCursorRes,
                            query: Joi.string().required().description('Partial match of username or default email address'),
                            results: Joi.array().items(GetUsersResult).required().description('User listing')
                        }).$_setFlag('objectName', 'GetUsersResponse')
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

            let permission;
            let ownOnly = false;
            permission = roles.can(req.role).readAny('userlisting');
            if (!permission.granted && req.user && ObjectId.isValid(req.user)) {
                permission = roles.can(req.role).readOwn('userlisting');
                if (permission.granted) {
                    ownOnly = true;
                }
            }
            // permissions check
            req.validate(permission);

            let query = result.value.query;
            let forward = result.value.forward;

            let limit = result.value.limit;
            let page = result.value.page;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;

            let filter = query
                ? {
                      $or: [
                          {
                              address: {
                                  $regex: tools.escapeRegexStr(query),
                                  $options: ''
                              }
                          },
                          {
                              unameview: {
                                  $regex: tools.escapeRegexStr(tools.uview(query)),
                                  $options: ''
                              }
                          }
                      ]
                  }
                : {};

            if (forward) {
                filter['targets.value'] = {
                    $regex: tools.escapeRegexStr(forward),
                    $options: ''
                };
            }

            let tagSeen = new Set();

            let requiredTags = (result.value.requiredTags || '')
                .split(',')
                .map(tag => tag.toLowerCase().trim())
                .filter(tag => {
                    if (tag && !tagSeen.has(tag)) {
                        tagSeen.add(tag);
                        return true;
                    }
                    return false;
                });

            let tags = (result.value.tags || '')
                .split(',')
                .map(tag => tag.toLowerCase().trim())
                .filter(tag => {
                    if (tag && !tagSeen.has(tag)) {
                        tagSeen.add(tag);
                        return true;
                    }
                    return false;
                });

            let tagsview = {};
            if (requiredTags.length) {
                tagsview.$all = requiredTags;
            }
            if (tags.length) {
                tagsview.$in = tags;
            }

            if (requiredTags.length || tags.length) {
                filter.tagsview = tagsview;
            }

            if (ownOnly) {
                filter._id = new ObjectId(req.user);
            }

            let total = await db.users.collection('users').countDocuments(filter);
            let opts = {
                limit,
                query: filter,
                fields: {
                    // FIXME: hack to keep _id in response
                    _id: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection: {
                        _id: true,
                        username: true,
                        name: true,
                        address: true,
                        tags: true,
                        storageUsed: true,
                        enabled2fa: true,
                        autoreply: true,
                        targets: true,
                        quota: true,
                        activated: true,
                        disabled: true,
                        suspended: true,
                        password: true,
                        encryptMessages: true,
                        encryptForwarded: true
                    }
                },
                // _id gets removed in response if not explicitly set in paginatedField
                paginatedField: '_id',
                sortAscending: true
            };

            if (result.value.metaData) {
                opts.fields.projection.metaData = true;
            }

            if (result.value.internalData) {
                opts.fields.projection.internalData = true;
            }

            if (pageNext) {
                opts.next = pageNext;
            } else if ((!page || page > 1) && pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listing;
            try {
                listing = await MongoPaging.find(db.users.collection('users'), opts);
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

            let settings = await settingsHandler.getMulti(['const:max:storage']);

            let response = {
                success: true,
                query,
                total,
                page,
                previousCursor: listing.hasPrevious ? listing.previous : false,
                nextCursor: listing.hasNext ? listing.next : false,
                results: (listing.results || []).map(userData => {
                    let values = {
                        id: userData._id.toString(),
                        username: userData.username,
                        name: userData.name,
                        address: userData.address,
                        tags: userData.tags || [],
                        targets: userData.targets && userData.targets.map(target => target.value).filter(target => target),
                        enabled2fa: tools.getEnabled2fa(userData.enabled2fa),
                        autoreply: !!userData.autoreply,
                        encryptMessages: !!userData.encryptMessages,
                        encryptForwarded: !!userData.encryptForwarded,
                        quota: {
                            allowed: Number(userData.quota) || settings['const:max:storage'],
                            used: Math.max(Number(userData.storageUsed) || 0, 0)
                        },
                        hasPasswordSet: !!userData.password || !!userData.tempPassword,
                        activated: !!userData.activated,
                        disabled: !!userData.disabled,
                        suspended: !!userData.suspended
                    };

                    if (userData.metaData) {
                        values.metaData = tools.formatMetaData(userData.metaData);
                    }

                    if (userData.internalData) {
                        values.internalData = tools.formatMetaData(userData.internalData);
                    }

                    return permission.filter(values);
                })
            };

            return res.json(response);
        })
    );

    server.post(
        {
            path: '/users',
            summary: 'Create new user',
            name: 'createUser',
            tags: ['Users'],
            validationObjs: {
                requestBody: {
                    username: usernameSchema
                        .required()
                        .description('Username of the User. Dots are allowed but informational only ("user.name" is the same as "username").'),
                    password: Joi.string()
                        .max(256)
                        .allow(false, '')
                        .required()
                        .description(
                            'Password for the account. Set to boolean false to disable password usage for the master scope, Application Specific Passwords would still be allowed'
                        ),
                    hashedPassword: booleanSchema
                        .default(false)
                        .description(
                            'If true then password is already hashed, so store as is. Supported hashes: pbkdf2, bcrypt ($2a, $2y, $2b), md5 ($1), sha512 ($6), sha256 ($5), argon2 ($argon2d, $argon2i, $argon2id). Stored hashes are rehashed to pbkdf2 on first successful password check.'
                        ),
                    allowUnsafe: booleanSchema
                        .default(true)
                        .description(
                            'If false then validates provided passwords against Have I Been Pwned API. Experimental, so validation is disabled by default but will be enabled automatically in some future version of WildDuck.'
                        ),

                    address: Joi.string().email({ tlds: false }).description('Default email address for the User (autogenerated if not set)'),
                    emptyAddress: booleanSchema
                        .default(false)
                        .description(
                            'If true then do not autogenerate missing email address for the User. Only needed if you want to create a user account that does not have any email address associated'
                        ),

                    language: Joi.string().empty('').max(20).description('Language code for the User'),

                    retention: Joi.number().min(0).default(0).description('Default retention time (in ms). Set to 0 to disable'),

                    name: Joi.string().max(256).description('Name of the User'),
                    targets: Joi.array()
                        .items(
                            Joi.string().email({ tlds: false }),
                            Joi.string().uri({
                                scheme: [/smtps?/, /https?/],
                                allowRelative: false,
                                relativeOnly: false
                            })
                        )
                        .description(
                            'An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to'
                        ),

                    spamLevel: Joi.number()
                        .min(0)
                        .max(100)
                        .default(50)
                        .description('Relative scale for detecting spam. 0 means that everything is spam, 100 means that nothing is spam'),

                    quota: Joi.number().min(0).default(0).description('Allowed quota of the user in bytes'),
                    recipients: Joi.number().min(0).default(0).description('How many messages per 24 hour can be sent'),
                    forwards: Joi.number().min(0).default(0).description('How many messages per 24 hour can be forwarded'),

                    filters: Joi.number().min(0).default(0).description('How many filters are allowed for this account'),

                    requirePasswordChange: booleanSchema
                        .default(false)
                        .description('If true then requires the user to change password, useful if password for the account was autogenerated'),

                    imapMaxUpload: Joi.number().min(0).default(0).description('How many bytes can be uploaded via IMAP during 24 hour'),
                    imapMaxDownload: Joi.number().min(0).default(0).description('How many bytes can be downloaded via IMAP during 24 hour'),
                    pop3MaxDownload: Joi.number().min(0).default(0).description('How many bytes can be downloaded via POP3 during 24 hour'),
                    pop3MaxMessages: Joi.number().min(0).default(0).description('How many latest messages to list in POP3 session'),
                    imapMaxConnections: Joi.number().min(0).default(0).description('How many parallel IMAP connections are allowed'),
                    receivedMax: Joi.number().min(0).default(0).description('How many messages can be received from MX during 60 seconds'),

                    fromWhitelist: Joi.array()
                        .items(Joi.string().trim().max(128))
                        .description('A list of additional email addresses this user can send mail from. Wildcard is allowed.'),

                    tags: Joi.array().items(Joi.string().trim().max(128)).description('A list of tags associated with this user'),
                    addTagsToAddress: booleanSchema.default(false).description('If true then autogenerated address gets the same tags as the user'),

                    uploadSentMessages: booleanSchema
                        .default(false)
                        .description(
                            'If true then all messages sent through MSA are also uploaded to the Sent Mail folder. Might cause duplicates with some email clients, so disabled by default.'
                        ),

                    mailboxes: Joi.object()
                        .keys({
                            sent: Joi.string()
                                .empty('')
                                .regex(/\/{2,}|\/$/, { invert: true }),
                            trash: Joi.string()
                                .empty('')
                                .regex(/\/{2,}|\/$/, { invert: true }),
                            junk: Joi.string()
                                .empty('')
                                .regex(/\/{2,}|\/$/, { invert: true }),
                            drafts: Joi.string()
                                .empty('')
                                .regex(/\/{2,}|\/$/, { invert: true })
                        })
                        .description('Optional names for special mailboxes')
                        .$_setFlag('objectName', 'Mailboxes'),

                    disabledScopes: Joi.array()
                        .items(
                            Joi.string()
                                .valid(...consts.SCOPES)
                                .$_setFlag('objectName', 'DisabledScopes')
                        )
                        .unique()
                        .default([])
                        .description('List of scopes that are disabled for this user ("imap", "pop3", "smtp")'),

                    metaData: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataSchema
                        .label('internalData')
                        .description(
                            'Optional metadata for internal use, must be an object or JSON formatted string of an object. Not available for user-role tokens'
                        ),

                    pubKey: Joi.string()
                        .empty('')
                        .trim()
                        .regex(/^-----BEGIN PGP PUBLIC KEY BLOCK-----/, 'PGP key format')
                        .description('Public PGP key for the User that is used for encryption. Use empty string to remove the key'),
                    encryptMessages: booleanSchema.default(false).description('If true then received messages are encrypted'),
                    encryptForwarded: booleanSchema.default(false).description('If true then forwarded messages are encrypted'),

                    featureFlags: Joi.object(Object.fromEntries(FEATURE_FLAGS.map(flag => [flag, booleanSchema.default(false)]))).description(
                        'Feature flags to specify'
                    ),

                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {},
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: userId
                        }).$_setFlag('objectName', 'CreateUserResponse')
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

            if (result.value.password && !result.value.hashedPassword && !result.value.allowUnsafe) {
                try {
                    let count = await pwnedpasswords(result.value.password);
                    if (count) {
                        res.status(403);
                        return res.json({
                            error: 'Provided password was found from breached passwords list',
                            code: 'InsecurePasswordError'
                        });
                    }
                } catch (E) {
                    // ignore errors, soft check only
                }
            }

            let permission = roles.can(req.role).createAny('users');

            // permissions check
            req.validate(permission);

            // filter out unallowed fields
            let values = permission.filter(result.value);

            let targets = values.targets;

            if (targets) {
                for (let i = 0, len = targets.length; i < len; i++) {
                    let target = targets[i];
                    if (!/^smtps?:/i.test(target) && !/^https?:/i.test(target) && target.indexOf('@') >= 0) {
                        // email
                        targets[i] = {
                            id: new ObjectId(),
                            type: 'mail',
                            value: target
                        };
                    } else if (/^smtps?:/i.test(target)) {
                        targets[i] = {
                            id: new ObjectId(),
                            type: 'relay',
                            value: target
                        };
                    } else if (/^https?:/i.test(target)) {
                        targets[i] = {
                            id: new ObjectId(),
                            type: 'http',
                            value: target
                        };
                    } else {
                        res.status(400);
                        return res.json({
                            error: 'Unknown target type "' + target + '"',
                            code: 'InputValidationError'
                        });
                    }
                }

                values.targets = targets;
            }

            if ('pubKey' in req.params && !values.pubKey) {
                values.pubKey = '';
            }

            if (values.tags) {
                let tagSeen = new Set();
                let tags = values.tags
                    .map(tag => tag.trim())
                    .filter(tag => {
                        if (tag && !tagSeen.has(tag.toLowerCase())) {
                            tagSeen.add(tag.toLowerCase());
                            return true;
                        }
                        return false;
                    })
                    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

                values.tags = tags;
                values.tagsview = tags.map(tag => tag.toLowerCase());
            }

            if (values.address && values.address.indexOf('*') >= 0) {
                res.status(400);
                return res.json({
                    error: 'Invalid character in email address: *',
                    code: 'InputValidationError'
                });
            }

            if (values.fromWhitelist && values.fromWhitelist.length) {
                values.fromWhitelist = Array.from(new Set(values.fromWhitelist.map(address => tools.normalizeAddress(address))));
            }

            if (values.mailboxes) {
                let seen = new Set(['INBOX']);
                for (let key of ['sent', 'junk', 'trash', 'drafts']) {
                    if (!values.mailboxes[key]) {
                        continue;
                    }
                    values.mailboxes[key] = imapTools.normalizeMailbox(values.mailboxes[key]);
                    if (seen.has(values.mailboxes[key])) {
                        res.status(400);
                        return res.json({
                            error: 'Duplicate mailbox name: ' + values.mailboxes[key],
                            code: 'InputValidationError'
                        });
                    }
                    seen.add(values.mailboxes[key]);

                    // rename key to use specialUse format ("seen"->"\\Seen")
                    delete values.mailboxes[key];
                    values.mailboxes[key.replace(/^./, c => '\\' + c.toUpperCase())] = values.mailboxes[key];
                }
            }

            try {
                await getKeyInfo(values.pubKey);
            } catch (err) {
                res.status(400);
                return res.json({
                    error: 'PGP key validation failed. ' + err.message,
                    code: 'InputValidationError'
                });
            }

            let user;
            try {
                user = await userHandler.create(values);
            } catch (err) {
                log.error('API', err);
                res.status(500); // TODO: use response code specific status
                return res.json({
                    error: err.message,
                    code: err.code,
                    username: values.username
                });
            }

            if (targets) {
                for (let target of targets) {
                    // log as new redirect targets
                    try {
                        await userHandler.logAuthEvent(user, {
                            action: 'user forward added',
                            result: 'success',
                            target: target.value,
                            protocol: 'API',
                            sess: values.sess,
                            ip: values.ip
                        });
                    } catch (err) {
                        // ignore
                        log.error('API', err);
                    }

                    await publish(db.redis, {
                        ev: FORWARD_ADDED,
                        user,
                        type: 'user',
                        target: target.value
                    });
                }
            }

            return res.json({
                success: !!user,
                id: user
            });
        })
    );

    server.get(
        {
            path: '/users/resolve/:username',
            summary: 'Resolve ID for a username',
            name: 'resolveUser',
            tags: ['Users'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    username: usernameSchema
                        .required()
                        .description(
                            'Username of the User. Alphanumeric value. Must start with a letter, dots are allowed but informational only ("user.name" is the same as "username")'
                        )
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes.example(true),
                            id: userId.description('Unique ID (24 byte hex)').example('609d201236d1d936948f23b1')
                        }).$_setFlag('objectName', 'ResolveIdForUsernameResponse')
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
            req.validate(roles.can(req.role).readAny('users'));

            let username = result.value.username;

            let userData;
            try {
                let unameview = '';
                if (username.includes('@')) {
                    unameview = tools.normalizeAddress(username, false, {
                        removeLabel: true,
                        removeDots: true
                    });
                } else {
                    unameview = username.replace(/\./g, '');
                }

                userData = await db.users.collection('users').findOne(
                    {
                        unameview
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

            return res.json({
                success: true,
                id: userData._id.toString()
            });
        })
    );

    server.get(
        {
            path: '/users/:user',
            summary: 'Request User information',
            name: 'getUser',
            tags: ['Users'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: userId.description('Users unique ID (24 byte hex)'),
                            username: Joi.string().required().description('Username of the User'),
                            name: Joi.string().required().description('Name of the User'),
                            address: Joi.string().required().description('Main email address of the User'),
                            retention: Joi.number().required().description('Default retention time (in ms). false if not enabled'),
                            enabled2fa: Joi.array().items(Joi.string()).required().description('List of enabled 2FA methods'),
                            autoreply: booleanSchema
                                .required()
                                .description('Is autoreply enabled or not (start time may still be in the future or end time in the past)'),
                            encryptMessages: booleanSchema.required().description('If true then received messages are encrypted'),
                            encryptForwarded: booleanSchema.required().description('If true then forwarded messages are encrypted'),
                            pubKey: Joi.string().required().description('Public PGP key for the User that is used for encryption'),
                            keyInfo: Joi.object({
                                name: Joi.string().required().description('Name listed in public key'),
                                address: Joi.string().required().description('E-mail address listed in public key'),
                                fingerprint: Joi.string().required().description('Fingerprint of the public key')
                            })
                                .$_setFlag('objectName', 'KeyInfo')
                                .required()
                                .description('Information about public key or false if key is not available'),
                            metaData: metaDataSchema.required().description('Custom metadata object set for this user'),
                            internalData: Joi.object({})
                                .required()
                                .description('Custom internal metadata object set for this user. Not available for user-role tokens'),
                            targets: Joi.array().items(Joi.string()).required().description('List of forwarding targets'),
                            spamLevel: Joi.number()
                                .required()
                                .description('Relative scale for detecting spam. 0 means that everything is spam, 100 means that nothing is spam'),
                            limits: Joi.object({
                                quota: quotaRes,
                                recipients: Joi.object({
                                    allowed: Joi.number().required().description('How many messages per 24 hours can be send'),
                                    used: Joi.number().required().description('How many messages are sent during current 24 hour period'),
                                    ttl: Joi.number().required().description('Time until the end of current 24 hour period')
                                })
                                    .required()
                                    .$_setFlag('objectName', 'Recipients')
                                    .description('Sending quota'),
                                filters: Joi.object({
                                    allowed: Joi.number().required().description('How many filters are allowed'),
                                    used: Joi.number().required().description('How many filters have been created')
                                })
                                    .required()
                                    .$_setFlag('objectName', 'Filters')
                                    .description('Sending quota'),
                                forwards: Joi.object({
                                    allowed: Joi.number().required().description('How many messages per 24 hours can be forwarded'),
                                    used: Joi.number().required().description('How many messages are forwarded during current 24 hour period'),
                                    ttl: Joi.number().required().description('Time until the end of current 24 hour period')
                                })
                                    .required()
                                    .$_setFlag('objectName', 'Forwards')
                                    .description('Forwarding quota'),
                                received: Joi.object({
                                    allowed: Joi.number().required().description('How many messages per 1 hour can be received'),
                                    used: Joi.number().required().description('How many messages are received during current 1 hour period'),
                                    ttl: Joi.number().required().description('Time until the end of current 1 hour period')
                                })
                                    .required()
                                    .$_setFlag('objectName', 'Received')
                                    .description('Receiving quota'),
                                imapUpload: Joi.object({
                                    allowed: Joi.number()
                                        .required()
                                        .description(
                                            'How many bytes per 24 hours can be uploaded via IMAP. Only message contents are counted, not protocol overhead.'
                                        ),
                                    used: Joi.number().required().description('How many bytes are uploaded during current 24 hour period'),
                                    ttl: Joi.number().required().description('Time until the end of current 24 hour period')
                                })
                                    .required()
                                    .description('IMAP upload quota')
                                    .$_setFlag('objectName', 'ImapUpload'),
                                imapDownload: Joi.object({
                                    allowed: Joi.number()
                                        .required()
                                        .description(
                                            'How many bytes per 24 hours can be downloaded via IMAP. Only message contents are counted, not protocol overhead.'
                                        ),
                                    used: Joi.number().required().description('How many bytes are downloaded during current 24 hour period'),
                                    ttl: Joi.number().required().description('Time until the end of current 24 hour period')
                                })
                                    .required()
                                    .description('IMAP download quota')
                                    .$_setFlag('objectName', 'ImapDownload'),
                                pop3Download: Joi.object({
                                    allowed: Joi.number()
                                        .required()
                                        .description(
                                            'How many bytes per 24 hours can be downloaded via POP3. Only message contents are counted, not protocol overhead.'
                                        ),
                                    used: Joi.number().required().description('How many bytes are downloaded during current 24 hour period'),
                                    ttl: Joi.number().required().description('Time until the end of current 24 hour period')
                                })
                                    .required()
                                    .description('POP3 download quota')
                                    .$_setFlag('objectName', 'Pop3Download'),
                                imapMaxConnections: Joi.object({
                                    allowed: Joi.number().required().description('How many parallel IMAP connections are permitted'),
                                    used: Joi.number().required().description('How many parallel IMAP connections are currently in use')
                                })
                                    .description('a')
                                    .$_setFlag('objectName', 'ImapMaxConnections')
                            })
                                .required()
                                .description('Account limits and usage')
                                .$_setFlag('objectName', 'UserLimits'),
                            tags: Joi.array().items(Joi.string()).required().description('List of tags associated with the User'),
                            fromWhitelist: Joi.array()
                                .items(Joi.string())
                                .description('A list of additional email addresses this user can send mail from. Wildcard is allowed.'),
                            disabledScopes: Joi.array()
                                .items(
                                    Joi.string()
                                        .valid(...consts.SCOPES)
                                        .$_setFlag('objectName', 'DisabledScopes')
                                )
                                .unique()
                                .required()
                                .default([])
                                .description('Disabled scopes for this user'),
                            hasPasswordSet: booleanSchema.required().description('If true then the User has a password set and can authenticate'),
                            activated: booleanSchema.required().description('Is the account activated'),
                            disabled: booleanSchema.required().description('If true then the user can not authenticate or receive any new mail'),
                            suspended: booleanSchema.required().description('If true then the user can not authenticate')
                        }).$_setFlag('objectName', 'GetUserResponse')
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
            let permission;
            if (req.user && req.user === result.value.user) {
                permission = roles.can(req.role).readOwn('users');
            } else {
                permission = roles.can(req.role).readAny('users');
            }
            req.validate(permission);

            let user = new ObjectId(result.value.user);

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

            let response;
            try {
                response = await db.redis
                    .multi()
                    // sending counters are stored in Redis

                    // sent messages
                    .get('wdr:' + userData._id.toString())
                    .ttl('wdr:' + userData._id.toString())

                    // forwarded messages
                    .get('wdf:' + userData._id.toString())
                    .ttl('wdf:' + userData._id.toString())

                    //  rate limited recipient
                    .get('rl:rcpt:' + userData._id.toString())
                    .ttl('rl:rcpt:' + userData._id.toString())

                    //  rate limited imap uploads
                    .get('iup:' + userData._id.toString())
                    .ttl('iup:' + userData._id.toString())

                    //  rate limited imap downloads
                    .get('idw:' + userData._id.toString())
                    .ttl('idw:' + userData._id.toString())

                    //  rate limited pop3 downloads
                    .get('pdw:' + userData._id.toString())
                    .ttl('pdw:' + userData._id.toString())

                    .hget('lim:imap', userData._id.toString())

                    .exec();
            } catch (err) {
                // ignore
                errors.notify(err, { userId: user });
            }

            const filtersCount = await db.database.collection('filters').countDocuments({
                user
            });

            let settings = await settingsHandler.getMulti([
                'const:max:storage',
                'const:max:recipients',
                'const:max:forwards',
                'const:max:filters',
                'const:max:imap:upload',
                'const:max:imap:download',
                'const:max:pop3:download'
            ]);

            let recipients = Number(userData.recipients) || config.maxRecipients || settings['const:max:recipients'];
            let forwards = Number(userData.forwards) || config.maxForwards || settings['const:max:forwards'];

            let filters = Number(userData.filters) || settings['const:max:filters'];

            let recipientsSent = Number(response && response[0] && response[0][1]) || 0;
            let recipientsTtl = Number(response && response[1] && response[1][1]) || 0;

            let forwardsSent = Number(response && response[2] && response[2][1]) || 0;
            let forwardsTtl = Number(response && response[3] && response[3][1]) || 0;

            let received = Number(response && response[4] && response[4][1]) || 0;
            let receivedTtl = Number(response && response[5] && response[5][1]) || 0;

            let imapUpload = Number(response && response[6] && response[6][1]) || 0;
            let imapUploadTtl = Number(response && response[7] && response[7][1]) || 0;

            let imapDownload = Number(response && response[8] && response[8][1]) || 0;
            let imapDownloadTtl = Number(response && response[9] && response[9][1]) || 0;

            let pop3Download = Number(response && response[10] && response[10][1]) || 0;
            let pop3DownloadTtl = Number(response && response[11] && response[11][1]) || 0;

            let imapMaxConnections = Number(response && response[12] && response[12][1]) || 0;

            let keyInfo;
            try {
                keyInfo = await getKeyInfo(userData.pubKey);
            } catch (err) {
                errors.notify(err, { userId: user, source: 'pgp' });
            }

            return res.json(
                permission.filter({
                    success: true,
                    id: user.toString(),

                    username: userData.username,
                    name: userData.name,

                    address: userData.address,

                    language: userData.language,
                    retention: userData.retention || false,

                    enabled2fa: tools.getEnabled2fa(userData.enabled2fa),
                    autoreply: !!userData.autoreply,

                    encryptMessages: userData.encryptMessages,
                    encryptForwarded: userData.encryptForwarded,
                    pubKey: userData.pubKey,
                    spamLevel: userData.spamLevel,
                    keyInfo,

                    metaData: tools.formatMetaData(userData.metaData),
                    internalData: tools.formatMetaData(userData.internalData),

                    targets: []
                        .concat(userData.targets || [])
                        .map(target => target.value)
                        .filter(target => target),

                    limits: {
                        quota: {
                            allowed: Number(userData.quota) || settings['const:max:storage'],
                            used: Math.max(Number(userData.storageUsed) || 0, 0)
                        },

                        recipients: {
                            allowed: recipients,
                            used: recipientsSent,
                            ttl: recipientsTtl >= 0 ? recipientsTtl : false
                        },

                        forwards: {
                            allowed: forwards,
                            used: forwardsSent,
                            ttl: forwardsTtl >= 0 ? forwardsTtl : false
                        },

                        received: {
                            allowed: Number(userData.receivedMax) || 60,
                            used: received,
                            ttl: receivedTtl >= 0 ? receivedTtl : false
                        },

                        filters: {
                            allowed: filters,
                            used: filtersCount
                        },

                        imapUpload: {
                            allowed: Number(userData.imapMaxUpload) || settings['const:max:imap:upload'],
                            used: imapUpload,
                            ttl: imapUploadTtl >= 0 ? imapUploadTtl : false
                        },

                        imapDownload: {
                            allowed: Number(userData.imapMaxDownload) || settings['const:max:imap:download'],
                            used: imapDownload,
                            ttl: imapDownloadTtl >= 0 ? imapDownloadTtl : false
                        },

                        pop3Download: {
                            allowed: Number(userData.pop3MaxDownload) || settings['const:max:pop3:download'],
                            used: pop3Download,
                            ttl: pop3DownloadTtl >= 0 ? pop3DownloadTtl : false
                        },

                        pop3MaxMessages: {
                            allowed: Number(userData.pop3MaxMessages) || config.pop3.maxMessages
                        },

                        imapMaxConnections: {
                            allowed: Number(userData.imapMaxConnections) || config.imap.maxConnections,
                            used: imapMaxConnections
                        }
                    },

                    tags: userData.tags || [],

                    fromWhitelist: userData.fromWhitelist || [],

                    featureFlags: userData.featureFlags || {},

                    disabledScopes: userData.disabledScopes || [],

                    hasPasswordSet: !!userData.password || !!userData.tempPassword,
                    activated: !!userData.activated,
                    disabled: !!userData.disabled,
                    suspended: !!userData.suspended
                })
            );
        })
    );

    server.put(
        {
            path: '/users/:user',
            summary: 'Update User information',
            name: 'updateUser',
            tags: ['Users'],
            validationObjs: {
                requestBody: {
                    existingPassword: Joi.string()
                        .empty('')
                        .min(1)
                        .max(256)
                        .description('If provided then validates against account password before applying any changes'),

                    password: Joi.string()
                        .max(256)
                        .allow(false, '')
                        .description(
                            'New password for the account. Set to boolean false to disable password usage for the master scope, Application Specific Passwords would still be allowed'
                        ),
                    hashedPassword: booleanSchema
                        .default(false)
                        .description(
                            'If true then password is already hashed, so store as is. Supported hashes: pbkdf2, bcrypt ($2a, $2y, $2b), md5 ($1), sha512 ($6), sha256 ($5), argon2 ($argon2d, $argon2i, $argon2id). Stored hashes are rehashed to pbkdf2 on first successful password check.'
                        ),
                    allowUnsafe: booleanSchema
                        .default(true)
                        .description(
                            'If false then validates provided passwords against Have I Been Pwned API. Experimental, so validation is disabled by default but will be enabled automatically in some future version of WildDuck.'
                        ),

                    language: Joi.string().empty('').max(20).description('Language code for the User'),

                    name: Joi.string().empty('').max(256).description('Name of the User'),
                    targets: Joi.array()
                        .items(
                            Joi.string().email({ tlds: false }),
                            Joi.string().uri({
                                scheme: [/smtps?/, /https?/],
                                allowRelative: false,
                                relativeOnly: false
                            })
                        )
                        .description(
                            'An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to'
                        ),

                    spamLevel: Joi.number()
                        .min(0)
                        .max(100)
                        .description('Relative scale for detecting spam. 0 means that everything is spam, 100 means that nothing is spam'),

                    uploadSentMessages: booleanSchema
                        .default(false)
                        .description(
                            'If true then all messages sent through MSA are also uploaded to the Sent Mail folder. Might cause duplicates with some email clients, so disabled by default.'
                        ),

                    fromWhitelist: Joi.array()
                        .items(Joi.string().trim().max(128))
                        .description('A list of additional email addresses this user can send mail from. Wildcard is allowed.'),

                    metaData: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataSchema
                        .label('internalData')
                        .description('Optional internal metadata, must be an object or JSON formatted string of an object. Not available for user-role tokens'),

                    pubKey: Joi.string()
                        .empty('')
                        .trim()
                        .regex(/^-----BEGIN PGP PUBLIC KEY BLOCK-----/, 'PGP key format')
                        .description('Public PGP key for the User that is used for encryption. Use empty string to remove the key'),
                    encryptMessages: booleanSchema.description('If true then received messages are encrypted'),
                    encryptForwarded: booleanSchema.description('If true then forwarded messages are encrypted'),
                    retention: Joi.number().min(0).description('Default retention time (in ms). Set to 0 to disable'),

                    quota: Joi.number().min(0).description('Allowed quota of the user in bytes'),
                    recipients: Joi.number().min(0).description('How many messages per 24 hour can be sent'),
                    forwards: Joi.number().min(0).description('How many messages per 24 hour can be forwarded'),

                    filters: Joi.number().min(0).description('How many filters are allowed for this account'),

                    imapMaxUpload: Joi.number().min(0).description('How many bytes can be uploaded via IMAP during 24 hour'),
                    imapMaxDownload: Joi.number().min(0).description('How many bytes can be downloaded via IMAP during 24 hour'),
                    pop3MaxDownload: Joi.number().min(0).description('How many bytes can be downloaded via POP3 during 24 hour'),
                    pop3MaxMessages: Joi.number().min(0).description('How many latest messages to list in POP3 session'),
                    imapMaxConnections: Joi.number().min(0).description('How many parallel IMAP connections are allowed'),

                    receivedMax: Joi.number().min(0).description('How many messages can be received from MX during 60 seconds'),

                    disable2fa: booleanSchema.description('If true, then disables 2FA for this user'),

                    tags: Joi.array().items(Joi.string().trim().max(128)).description('A list of tags associated with this user'),

                    disabledScopes: Joi.array()
                        .items(Joi.string().valid(...consts.SCOPES))
                        .unique()
                        .description('List of scopes that are disabled for this user ("imap", "pop3", "smtp")'),

                    disabled: booleanSchema.description('If true then disables user account (can not login, can not receive messages)'),

                    featureFlags: Joi.object(Object.fromEntries(FEATURE_FLAGS.map(flag => [flag, booleanSchema.default(false)]))).description(
                        'Enabled feature flags'
                    ),

                    suspended: booleanSchema.description('If true then disables authentication'),

                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    user: userId
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
            let permission;
            if (req.user && req.user === result.value.user) {
                permission = roles.can(req.role).updateOwn('users');
            } else {
                permission = roles.can(req.role).updateAny('users');
            }
            req.validate(permission);

            let values = permission.filter(result.value);

            if (values.password && !values.hashedPassword && !values.allowUnsafe) {
                try {
                    let count = await pwnedpasswords(values.password);
                    if (count) {
                        res.status(403);
                        return res.json({
                            error: 'Provided password was found from breached passwords list',
                            code: 'InsecurePasswordError'
                        });
                    }
                } catch (E) {
                    // ignore errors, soft check only
                }
            }

            let user = new ObjectId(values.user);

            let targets = values.targets;
            let existingTargets;

            if (targets) {
                for (let i = 0, len = targets.length; i < len; i++) {
                    let target = targets[i];
                    if (!/^smtps?:/i.test(target) && !/^https?:/i.test(target) && target.indexOf('@') >= 0) {
                        // email
                        targets[i] = {
                            id: new ObjectId(),
                            type: 'mail',
                            value: target
                        };
                    } else if (/^smtps?:/i.test(target)) {
                        targets[i] = {
                            id: new ObjectId(),
                            type: 'relay',
                            value: target
                        };
                    } else if (/^https?:/i.test(target)) {
                        targets[i] = {
                            id: new ObjectId(),
                            type: 'http',
                            value: target
                        };
                    } else {
                        res.status(400);
                        return res.json({
                            error: 'Unknown target type "' + target + '"',
                            code: 'InputValidationError'
                        });
                    }
                }

                values.targets = targets;

                let existingUserData;
                try {
                    existingUserData = await db.users.collection('users').findOne(
                        {
                            _id: user
                        },
                        {
                            projection: {
                                targets: true
                            }
                        }
                    );
                    existingTargets = (existingUserData.targets || []).map(target => target.value);
                } catch (err) {
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }
            }

            if (!values.name && 'name' in req.params) {
                values.name = '';
            }

            if (!values.pubKey && 'pubKey' in req.params) {
                values.pubKey = '';
            }

            if (values.tags) {
                let tagSeen = new Set();
                let tags = values.tags
                    .map(tag => tag.trim())
                    .filter(tag => {
                        if (tag && !tagSeen.has(tag.toLowerCase())) {
                            tagSeen.add(tag.toLowerCase());
                            return true;
                        }
                        return false;
                    })
                    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                values.tags = tags;
                values.tagsview = tags.map(tag => tag.toLowerCase());
            }

            if (values.fromWhitelist && values.fromWhitelist.length) {
                values.fromWhitelist = Array.from(new Set(values.fromWhitelist.map(address => tools.normalizeAddress(address))));
            }

            try {
                await getKeyInfo(values.pubKey);
            } catch (err) {
                res.status(400);
                return res.json({
                    error: 'PGP key validation failed. ' + err.message,
                    code: 'InputValidationError'
                });
            }

            let updateResponse;
            try {
                updateResponse = await userHandler.update(user, values);
            } catch (err) {
                res.status(500); // TODO: use response code specific status
                return res.json({
                    error: err.message,
                    code: err.code
                });
            }

            let { success, passwordChanged } = updateResponse || {};
            if (passwordChanged && req.accessToken && typeof req.accessToken.update === 'function') {
                try {
                    // update access token data for current session after password change
                    await req.accessToken.update();
                } catch (err) {
                    // ignore
                }
            }

            // compare new forwards against existing ones
            if (targets) {
                for (let target of targets) {
                    if (!existingTargets.includes(target.value)) {
                        // found new forward
                        try {
                            await userHandler.logAuthEvent(user, {
                                action: 'user forward added',
                                result: 'success',
                                target: target.value,
                                protocol: 'API',
                                sess: values.sess,
                                ip: values.ip
                            });
                        } catch (err) {
                            // ignore
                            log.error('API', err);
                        }

                        await publish(db.redis, {
                            ev: FORWARD_ADDED,
                            user,
                            type: 'user',
                            target: target.value
                        });
                    }
                }
            }

            return res.json({
                success
            });
        })
    );

    server.put(
        {
            path: '/users/:user/logout',
            summary: 'Log out User',
            name: 'logoutUser',
            tags: ['Users'],
            validationObjs: {
                requestBody: {
                    reason: Joi.string().empty('').max(128).description('Message to be shown to connected IMAP client'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    user: userId
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
                req.validate(roles.can(req.role).readOwn('users'));
            } else {
                req.validate(roles.can(req.role).readAny('users'));
            }

            let success;
            try {
                success = await userHandler.logout(result.value.user, result.value.reason || 'Logout requested from API');
            } catch (err) {
                res.status(500); // TODO: use response code specific status
                return res.json({
                    error: err.message,
                    code: err.code
                });
            }

            return res.json({
                success
            });
        })
    );

    server.post(
        {
            path: '/users/:user/quota/reset',
            description:
                'This method recalculates quota usage for a User. Normally not needed, only use it if quota numbers are way off. This method is not transactional, so if the user is currently receiving new messages then the resulting value is not exact.',
            summary: 'Recalculate User quota',
            name: 'recalculateQuota',
            tags: ['Users'],
            validationObjs: {
                requestBody: {
                    sess: sessSchema,
                    ip: sessIPSchema
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
                            storageUsed: Joi.number().description('Calculated quota usage for the user').required(),
                            previousStorageUsed: Joi.number().description('Previous storage used').required()
                        }).$_setFlag('objectName', 'RecalculateQuotaResponse')
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
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectId(result.value.user);

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            storageUsed: true
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

            let storageData;
            try {
                // calculate mailbox size by aggregating the size's of all messages
                // NB! Scattered query
                storageData = await db.database
                    .collection('messages')
                    .aggregate([
                        {
                            $match: {
                                user
                            }
                        },
                        {
                            $group: {
                                _id: {
                                    user: '$user'
                                },
                                storageUsed: {
                                    $sum: '$size'
                                }
                            }
                        }
                    ])
                    .toArray();
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let storageUsed = (storageData && storageData[0] && storageData[0].storageUsed) || 0;

            let updateResponse;
            try {
                // update quota counter
                updateResponse = await db.users.collection('users').findOneAndUpdate(
                    {
                        _id: userData._id
                    },
                    {
                        $set: {
                            storageUsed: Number(storageUsed) || 0
                        }
                    },
                    {
                        returnDocument: 'before',
                        projection: {
                            storageUsed: true
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

            if (!updateResponse || !updateResponse.value) {
                res.status(404);
                return res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
            }

            server.loggelf(
                {
                    short_message: '[QUOTA] reset',
                    _mail_action: 'quota',
                    _user: userData._id,
                    _set: Number(storageUsed) || 0,
                    _previous_storage_used: Number(updateResponse.value.storageUsed) || 0,
                    _storage_used: Number(storageUsed) || 0,
                    _storage_diff: Math.abs((Number(updateResponse.value.storageUsed) || 0) - (Number(storageUsed) || 0))
                },
                ['_previous_storage_used', '_storage_used', '_storage_diff', '_set']
            );

            return res.json({
                success: true,
                storageUsed: Number(storageUsed) || 0,
                previousStorageUsed: Number(updateResponse.value.storageUsed) || 0
            });
        })
    );

    server.post(
        {
            path: '/quota/reset',
            description:
                'This method recalculates quota usage for all Users. Normally not needed, only use it if quota numbers are way off. This method is not transactional, so if the user is currently receiving new messages then the resulting value is not exact.',
            summary: 'Recalculate Quota for all Users',
            name: 'recalculateQuotaAllUsers',
            tags: ['Users'],
            validationObjs: {
                requestBody: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            task: Joi.string().required().description('Task ID').$_setFlag('objectName', 'RecalculateQuotaAllUsersResponse')
                        })
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
            req.validate(roles.can(req.role).updateAny('users'));

            let task;
            try {
                task = await taskHandler.add('quota', {});
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
            path: '/data/export',
            tags: ['Export'],
            summary: 'Export data',
            name: 'createExport',
            description:
                'Export data for matching users. Export dump does not include emails, only account structure (user data, password hashes, mailboxes, filters, etc.). A special "export"-role access token is required for exporting and importing.',
            validationObjs: {
                requestBody: {
                    users: Joi.array().single().items(Joi.string().hex().lowercase().length(24).required()).description('An array of User ID values to export'),
                    tags: Joi.array()
                        .single()
                        .items(Joi.string().trim().empty('').max(1024))
                        .description('An array of user tags to export. If set then at least one tag must exist on an user.'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {},
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.binary()
                    }
                }
            },
            responseType: 'application/octet-stream'
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
            req.validate(roles.can(req.role).createAny('export'));

            let exporter = new ExportStream({
                type: 'wildduck_data_export',
                users: result.value.users,
                tags: result.value.tags
            });

            const runUserExport = async (user, exporter) => {
                log.info('Export', `Processing user ${user}`);

                const processCollection = async (client, collection, query) => {
                    let cursor = await db[client].collection(collection).find(query, {
                        raw: true
                    });
                    let entry;
                    let rowcount = 0;
                    while ((entry = await cursor.next())) {
                        exporter.write({ client, collection, entry });
                        rowcount++;
                    }
                    await cursor.close();
                    log.info('Export', `Exported ${rowcount} rows from ${client}.${collection} for user ${user}`);
                };

                await processCollection('users', 'users', { _id: user });
                await processCollection('users', 'addresses', { user });
                await processCollection('users', 'asps', { user });

                await processCollection('database', 'addressregister', { user });
                await processCollection('database', 'autoreplies', { user });
                await processCollection('database', 'filters', { user });
                await processCollection('database', 'mailboxes', { user });
            };

            const runExport = async (query = {}, exporter) => {
                let filter = {};

                if (query.users) {
                    filter._id = { $in: query.users.map(user => new ObjectId(user)) };
                }

                let tagSeen = new Set();

                let tags = (query.tags || [])
                    .map(tag => tag.toLowerCase().trim())
                    .filter(tag => {
                        if (tag && !tagSeen.has(tag)) {
                            tagSeen.add(tag);
                            return true;
                        }
                        return false;
                    });

                if (tags.length) {
                    filter.tagsview = { $in: tags };
                }

                let userIds = await db.users
                    .collection('users')
                    .find(filter, { projection: { _id: true } })
                    .toArray();

                for (let { _id: user } of userIds) {
                    await runUserExport(user, exporter);
                }

                exporter.end();
            };

            res.writeHead(200, {
                'Content-Type': 'application/octet-stream'
            });

            exporter.pipe(res);

            try {
                await new Promise((resolve, reject) => {
                    exporter.on('error', err => {
                        reject(err);
                    });

                    runExport(result.value, exporter).then(resolve).catch(reject);
                });
                log.info('API', `Export completed`);
            } catch (err) {
                log.error('API', `Export failed: ${err.stack}`);
                res.write(`\nExport failed\n${err.message}\n${err.code || 'Error'}\n`);
                res.end();
            }
        })
    );

    server.post(
        {
            path: '/data/import',
            summary: 'Import user data',
            name: 'createImport',
            description:
                'Import data from an export dump. If a database entry already exists, it is not modified. A special "export"-role access token is required for exporting and importing.',
            tags: ['Export'],
            applicationType: 'application/octet-stream',
            validationObjs: {
                requestBody: {},
                pathParams: {},
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            entries: Joi.number().description('How many database entries were found from the export file'),
                            imported: Joi.number().description('How many database entries were imported from the export file'),
                            failed: Joi.number().description('How many database entries were not imported due to some error'),
                            existing: Joi.number().description('How many database existing entries were not imported')
                        }).$_setFlag('objectName', 'CreateImportResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            // permissions check
            req.validate(roles.can(req.role).createAny('import'));

            let result;

            try {
                result = await new Promise((resolve, reject) => {
                    let importer = new ImportStream();

                    importer.once('error', err => {
                        reject(err);
                    });

                    let canImport = false;

                    importer.on('header', header => {
                        canImport = header && header.type === 'wildduck_data_export';
                        if (!canImport) {
                            let err = new Error('Invalid data file');
                            err.code = 'INVALID_DATA';
                            reject(err);
                        }
                    });

                    let reading = false;
                    let ended = false;

                    let result = {
                        entries: 0,
                        imported: 0,
                        failed: 0,
                        existing: 0
                    };

                    importer.on('readable', () => {
                        if (reading) {
                            return;
                        }
                        reading = true;

                        let readNextEntry = () => {
                            let entry = importer.read();
                            if (entry === null) {
                                reading = false;
                                if (ended) {
                                    resolve(result);
                                }
                                return;
                            }
                            if (!canImport) {
                                // flush data
                                return setImmediate(readNextEntry);
                            }

                            result.entries++;

                            if (['database', 'users', 'gridfs', 'senderDb'].includes(entry.client)) {
                                let document = BSON.deserialize(entry.entry);
                                if (!document) {
                                    log.error('Import', 'Can not import empty document client=%s collection=%s', entry.client, entry.collection);
                                    return setImmediate(readNextEntry);
                                }

                                // we do not import data, only account info, so reset all storage info to 0
                                switch (entry.collection) {
                                    case 'users':
                                        document.storageUsed = 0;
                                        break;

                                    case 'mailboxes':
                                        document.uidValidity = Math.floor(Date.now() / 1000);
                                        document.uidNext = 1;
                                        document.modifyIndex = 0;
                                        break;
                                }

                                return db[entry.client].collection(entry.collection).insertOne(document, {}, (err, res) => {
                                    if (err) {
                                        switch (err.code) {
                                            case 11000:
                                                result.existing++;
                                                log.info(
                                                    'Import',
                                                    'resolution=%s client=%s collection=%s _id=%s',
                                                    'existing',
                                                    entry.client,
                                                    entry.collection,
                                                    document._id
                                                );
                                                break;
                                            default:
                                                result.failed++;
                                                log.error(
                                                    'Import',
                                                    'resolution=%s client=%s collection=%s _id=%s error=%s',
                                                    'failed',
                                                    entry.client,
                                                    entry.collection,
                                                    document._id,
                                                    err.message
                                                );
                                        }
                                        return setImmediate(readNextEntry);
                                    }

                                    if (res && res.insertedId) {
                                        result.imported++;
                                        log.info(
                                            'Import',
                                            'resolution=%s client=%s collection=%s _id=%s',
                                            'imported',
                                            entry.client,
                                            entry.collection,
                                            res.insertedId
                                        );
                                    } else {
                                        log.info(
                                            'Import',
                                            'resolution=%s client=%s collection=%s _id=%s',
                                            'skipped',
                                            entry.client,
                                            entry.collection,
                                            document._id
                                        );
                                    }

                                    return setImmediate(readNextEntry);
                                });
                            } else {
                                log.info('Import', 'Can not import document client=%s collection=%s', entry.client, entry.collection);
                            }
                            return setImmediate(readNextEntry);
                        };

                        readNextEntry();
                    });

                    importer.once('end', () => {
                        ended = true;
                        if (reading) {
                            return;
                        }
                        resolve(result);
                    });

                    req.once('error', err => {
                        reject(err);
                    });

                    req.pipe(importer);
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: err.message,
                    code: err.code
                });
            }

            return res.json({
                result
            });
        })
    );

    server.post(
        {
            path: '/users/:user/password/reset',
            summary: 'Reset password for a User',
            name: 'resetUserPassword',
            description: 'This method generates a new temporary password for a User. Additionally it removes all two-factor authentication settings',
            tags: ['Users'],
            validationObjs: {
                requestBody: {
                    validAfter: Joi.date().empty('').allow(false).description('Allow using the generated password not earlier than provided time'),
                    sess: sessSchema,
                    ip: sessIPSchema
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
                            password: Joi.string().required().description('Temporary password'),
                            validAfter: Joi.date().empty('').description('The date password is valid after')
                        }).$_setFlag('objectName', 'ResetUserPasswordResponse')
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
            req.validate(roles.can(req.role).updateAny('users'));

            let user = new ObjectId(result.value.user);

            let password;
            try {
                password = await userHandler.reset(user, result.value);
            } catch (err) {
                res.status(500); // TODO: use response code specific status
                return res.json({
                    error: err.message,
                    code: err.code
                });
            }

            return res.json({
                success: true,
                password,
                validAfter: (result.value && result.value.validAfter) || new Date()
            });
        })
    );

    server.del(
        {
            path: '/users/:user',
            summary: 'Delete a User',
            name: 'deleteUser',
            description:
                'This method deletes user and address entries from DB and schedules a background task to delete messages. You can call this method several times even if the user has already been deleted, in case there are still some pending messages.',
            tags: ['Users'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    deleteAfter: Joi.date()
                        .empty('')
                        .allow(false)
                        .default(false)
                        .description(
                            'Delete user entry from registry but keep all user data until provided date. User account is fully recoverable up to that date.'
                        ),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            code: Joi.string().example('TaskScheduled').description('Task code. Should be TaskScheduled'),
                            user: Joi.string().description('User ID'),
                            addresses: Joi.object({
                                deleted: Joi.number().description('Number of deleted addresses')
                            }),
                            deleteAfter: Joi.date().description('Delete after date'),
                            task: Joi.string().description('Task ID')
                        }).$_setFlag('objectName', 'DeleteUserResponse')
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
            req.validate(roles.can(req.role).deleteAny('users'));

            let user = new ObjectId(result.value.user);

            let deleteResponse;
            try {
                deleteResponse = await userHandler.delete(user, Object.assign({}, result.value));
            } catch (err) {
                res.status(500); // TODO: use response code specific status
                return res.json({
                    error: err.message,
                    code: err.code
                });
            }

            return res.json(
                Object.assign(
                    {
                        success: !!deleteResponse,
                        code: 'TaskScheduled'
                    },
                    deleteResponse || {}
                )
            );
        })
    );

    server.get(
        {
            path: '/users/:user/restore',
            summary: 'Return recovery info for a deleted user',
            name: 'restoreUserInfo',
            tags: ['Users'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            user: Joi.string().description('ID of the deleted User').required(),
                            username: Joi.string().description('Username of the User').required(),
                            storageUsed: Joi.number().description('Calculated quota usage for the user').required(),
                            tags: Joi.array().items(Joi.string()).description('List of tags associated with the User').required(),
                            deleted: Joi.date().description('Datestring of the time the user was deleted').required(),
                            recoverableAddresses: Joi.array().items(Joi.string()).description('List of email addresses that can be restored').required()
                        }).$_setFlag('objectName', 'RecoverInfoResponse')
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
                req.validate(roles.can(req.role).readOwn('users'));
            } else {
                req.validate(roles.can(req.role).readAny('users'));
            }

            let user = new ObjectId(result.value.user);

            let userInfo;
            try {
                userInfo = await userHandler.restoreInfo(user);
            } catch (err) {
                res.status(err.responseCode || 500); // TODO: use response code specific status
                return res.json({
                    error: err.message,
                    code: err.code
                });
            }

            return res.json(
                Object.assign(
                    {
                        success: !!userInfo
                    },
                    userInfo
                )
            );
        })
    );

    server.post(
        {
            path: '/users/:user/restore',
            summary: 'Cancel user deletion task',
            name: 'cancelUserDelete',
            description:
                'Use this endpoint to cancel a timed deletion task scheduled by DELETE /user/{id}. If user data is not yet deleted then the account is fully recovered, except any email addresses that might have been already recycled',
            tags: ['Users'],
            validationObjs: {
                requestBody: {
                    sess: sessSchema,
                    ip: sessIPSchema
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
                            code: Joi.string().required().description('Task status code'),
                            user: Joi.string().description('User ID'),
                            task: Joi.string().description('Existing task id'),
                            addresses: Joi.object({
                                recovered: Joi.number().description('Number of recovered addresses'),
                                main: Joi.string().description('Main address')
                            })
                        }).$_setFlag('objectName', 'CancelUserDeletionResponse')
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
                req.validate(roles.can(req.role).updateOwn('users'));
            } else {
                req.validate(roles.can(req.role).updateAny('users'));
            }

            let user = new ObjectId(result.value.user);

            let task;
            try {
                task = await userHandler.restore(user, Object.assign({}, result.value));
            } catch (err) {
                res.status(500); // TODO: use response code specific status
                return res.json({
                    error: err.message,
                    code: err.code
                });
            }

            return res.json(
                Object.assign(
                    {
                        success: !!task,
                        code: task && task.task ? 'TaskCancelled' : 'RequestProcessed'
                    },
                    task || {}
                )
            );
        })
    );
};

async function getKeyInfo(pubKeyArmored) {
    if (!pubKeyArmored) {
        return false;
    }

    let pubKey = await openpgp.readKey({ armoredKey: tools.prepareArmoredPubKey(pubKeyArmored), config: { tolerant: true } });
    if (!pubKey) {
        throw new Error('Failed to process public key');
    }

    let fingerprint = pubKey.getFingerprint();
    let { name, address } = tools.getPGPUserId(pubKey);

    let ciphertext = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: 'Hello, World!' }),
        encryptionKeys: pubKey, // for encryption
        format: 'armored',
        config: { minRSABits: 1024 }
    });

    if (/^-----BEGIN PGP MESSAGE/.test(ciphertext)) {
        // everything checks out
        return {
            name,
            address,
            fingerprint
        };
    }

    throw new Error('Failed to verify public key');
}
