'use strict';

const crypto = require('crypto');
const log = require('npmlog');
const config = require('@zone-eu/wild-config');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const errors = require('../errors');
const openpgp = require('openpgp');
const BSON = require('bson');
const consts = require('../consts');
const roles = require('../roles');
const imapTools = require('../../imap-core/lib/imap-tools');
const TaskHandler = require('../task-handler');
const { publish, FORWARD_ADDED } = require('../events');
const { ExportStream, ImportStream } = require('../export');
const { GetUsersResult } = require('../schemas/response/users-schemas');
const { mongopagingFindWrapper } = require('../mongopaging-find-wrapper');
const SMIMEEncryptor = require('@zone-eu/smime-js');

const FEATURE_FLAGS = ['indexing'];
const DATA_IMPORT_EXPORT_COLLECTIONS = Object.freeze({
    users: Object.freeze(['users', 'addresses', 'asps']),
    database: Object.freeze(['addressregister', 'autoreplies', 'filters', 'mailboxes'])
});

const userId = { $ref: 'wd:userId' };
const sessSchema = { $ref: 'wd:sess' };
const sessIPSchema = { $ref: 'wd:ip' };
const usernameSchema = { $ref: 'wd:username' };
const nextPageCursorSchema = { $ref: 'wd:cursor', description: 'Cursor value for next page, retrieved from nextCursor response value' };
const previousPageCursorSchema = { $ref: 'wd:cursor', description: 'Cursor value for previous page, retrieved from previousCursor response value' };

const nonNegativeInteger = (description, defaultValue) => {
    const schema = { type: 'number', minimum: 0, wdType: 'number', description };
    if (defaultValue !== undefined) {
        schema.default = defaultValue;
    }
    return schema;
};

const forwardTargetsSchema = description => ({
    type: 'array',
    items: {
        type: 'string',
        anyOf: [{ wdAssert: 'email' }, { wdAssert: 'webhookUrl' }]
    },
    description
});

const mtaRelaySchema = description => ({ type: 'string', wdValidator: 'smtpUrl', description });

const tagListSchema = description => ({
    type: 'array',
    items: { type: 'string', maxLength: 128, minLength: 1, wdTrim: true },
    description
});

const pubKeySchema = {
    type: 'string',
    pattern: '^-----BEGIN PGP PUBLIC KEY BLOCK-----',
    wdTrim: true,
    wdEmpty: true,
    description: 'Public PGP key for the User that is used for encryption. Use empty string to remove the key'
};

const smimeCertsSchema = description => ({
    type: 'array',
    maxItems: 16,
    items: { type: 'string', pattern: '^-----BEGIN CERTIFICATE-----', minLength: 1, wdTrim: true },
    description
});

const disabledScopesSchema = description => ({
    type: 'array',
    items: { type: 'string', enum: [...consts.SCOPES] },
    uniqueItems: true,
    description
});

const featureFlagsSchema = description => ({
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(FEATURE_FLAGS.map(flag => [flag, { $ref: 'wd:boolean', default: false }])),
    description
});

// Joi.string().max(256).allow(false, ''): a password string, empty string or
// literal false to disable password usage
const passwordSchema = description => ({
    anyOf: [{ type: 'string', maxLength: 256 }, { const: false }],
    description
});

const metaDataOptional = description => ({ $ref: 'wd:metaData', description });



module.exports = (db, server, userHandler, settingsHandler) => {
    const taskHandler = new TaskHandler({ database: db.database });

    server.get(
        {
            name: 'getUsers',
            path: '/users',
            summary: 'List registered Users',
            tags: ['Users'],
            jsonSchema: true,
            allowUnknown: true,
            validationObjs: {
                pathParams: {},
                requestBody: {},
                queryParams: {
                    query: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdLowercase: true,
                        wdEmpty: true,
                        description: 'Partial match of username or default email address'
                    },
                    forward: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdLowercase: true,
                        wdEmpty: true,
                        description: 'Partial match of a forward email address or URL'
                    },
                    tags: {
                        type: 'string',
                        maxLength: 1024,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        description: 'Comma separated list of tags. The User must have at least one to be set'
                    },
                    requiredTags: {
                        type: 'string',
                        maxLength: 1024,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        description: 'Comma separated list of tags. The User must have all listed tags to be set'
                    },
                    metaData: { $ref: 'wd:boolean', description: 'If true, then includes metaData in the response' },
                    internalData: { $ref: 'wd:boolean', description: 'If true, then includes internalData in the response. Not shown for user-role tokens.' },
                    limit: { $ref: 'wd:pageLimit' },
                    next: nextPageCursorSchema,
                    previous: previousPageCursorSchema,
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetUsersResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                total: { $ref: 'wd:totalRes' },
                                page: { $ref: 'wd:pageRes' },
                                previousCursor: { $ref: 'wd:previousCursorRes' },
                                nextCursor: { $ref: 'wd:nextCursorRes' },
                                query: { type: 'string', description: 'Partial match of username or default email address' },
                                results: { type: 'array', items: GetUsersResult, description: 'User listing' }
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
            }
            if (pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listingWrapper;
            try {
                listingWrapper = await mongopagingFindWrapper(db.users.collection('users'), opts);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let settings = await settingsHandler.getMulti(['const:max:storage']);

            let response = {
                success: true,
                query,
                total,
                page: listingWrapper.page,
                previousCursor: listingWrapper.previousCursor,
                nextCursor: listingWrapper.nextCursor,
                results: (listingWrapper.listing.results || []).map(userData => {
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
            jsonSchema: true,
            validationObjs: {
                requestBody: {
                    username: Object.assign({}, usernameSchema, {
                        wdRequired: true,
                        description: 'Username of the User. Dots are allowed but informational only ("user.name" is the same as "username").'
                    }),
                    password: Object.assign(
                        passwordSchema(
                            'Password for the account. Set to boolean false to disable password usage for the master scope, Application Specific Passwords would still be allowed'
                        ),
                        { wdRequired: true }
                    ),
                    hashedPassword: {
                        $ref: 'wd:boolean',
                        default: false,
                        description:
                            'If true then password is already hashed, so store as is. Supported hashes: pbkdf2, bcrypt ($2a, $2y, $2b), md5 ($1), sha512 ($6), sha256 ($5), argon2 ($argon2d, $argon2i, $argon2id). Stored hashes are rehashed to pbkdf2 on first successful password check.'
                    },
                    allowUnsafe: {
                        $ref: 'wd:boolean',
                        default: true,
                        description:
                            'If false then validates provided passwords against Have I Been Pwned API. Experimental, so validation is disabled by default but will be enabled automatically in some future version of WildDuck.'
                    },

                    address: { type: 'string', wdValidator: 'email', description: 'Default email address for the User (autogenerated if not set)' },
                    emptyAddress: {
                        $ref: 'wd:boolean',
                        default: false,
                        description:
                            'If true then do not autogenerate missing email address for the User. Only needed if you want to create a user account that does not have any email address associated'
                    },

                    language: { type: 'string', maxLength: 20, minLength: 1, wdEmpty: true, description: 'Language code for the User' },

                    retention: nonNegativeInteger('Default retention time (in ms). Set to 0 to disable', 0),

                    name: { type: 'string', maxLength: 256, minLength: 1, description: 'Name of the User' },
                    targets: forwardTargetsSchema(
                        'An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to'
                    ),

                    mtaRelay: mtaRelaySchema(
                        'An address of an SMTP MTA relay. The value should be a relay url. If specified uses the this relay as the outbound MTA.'
                    ),

                    spamLevel: {
                        type: 'number',
                        minimum: 0,
                        maximum: 100,
                        default: 50,
                        wdType: 'number',
                        description: 'Relative scale for detecting spam. 0 means that everything is spam, 100 means that nothing is spam'
                    },

                    quota: nonNegativeInteger('Allowed quota of the user in bytes', 0),
                    recipients: nonNegativeInteger('How many messages per 24 hour can be sent', 0),
                    forwards: nonNegativeInteger('How many messages per 24 hour can be forwarded', 0),

                    filters: nonNegativeInteger('How many filters are allowed for this account', 0),

                    requirePasswordChange: {
                        $ref: 'wd:boolean',
                        default: false,
                        description: 'If true then requires the user to change password, useful if password for the account was autogenerated'
                    },
                    require2faEnabled: { $ref: 'wd:boolean', default: false, description: 'If true then the account is flagged as requiring 2FA to be enabled' },

                    imapMaxUpload: nonNegativeInteger('How many bytes can be uploaded via IMAP during 24 hour', 0),
                    imapMaxDownload: nonNegativeInteger('How many bytes can be downloaded via IMAP during 24 hour', 0),
                    pop3MaxDownload: nonNegativeInteger('How many bytes can be downloaded via POP3 during 24 hour', 0),
                    pop3MaxMessages: nonNegativeInteger('How many latest messages to list in POP3 session', 0),
                    imapMaxConnections: nonNegativeInteger('How many parallel IMAP connections are allowed', 0),
                    receivedMax: nonNegativeInteger('How many messages can be received from MX during 60 seconds', 0),

                    fromWhitelist: tagListSchema('A list of additional email addresses this user can send mail from. Wildcard is allowed.'),

                    tags: tagListSchema('A list of tags associated with this user'),
                    addTagsToAddress: { $ref: 'wd:boolean', default: false, description: 'If true then autogenerated address gets the same tags as the user' },

                    uploadSentMessages: {
                        $ref: 'wd:boolean',
                        default: false,
                        description:
                            'If true then all messages sent through MSA are also uploaded to the Sent Mail folder. Might cause duplicates with some email clients, so disabled by default.'
                    },

                    mailboxes: {
                        type: 'object',
                        title: 'Mailboxes',
                        additionalProperties: false,
                        description: 'Optional names for special mailboxes',
                        properties: {
                            sent: { type: 'string', minLength: 1, wdEmpty: true, not: { pattern: '/{2,}|/$' } },
                            trash: { type: 'string', minLength: 1, wdEmpty: true, not: { pattern: '/{2,}|/$' } },
                            junk: { type: 'string', minLength: 1, wdEmpty: true, not: { pattern: '/{2,}|/$' } },
                            drafts: { type: 'string', minLength: 1, wdEmpty: true, not: { pattern: '/{2,}|/$' } }
                        }
                    },

                    disabledScopes: Object.assign(disabledScopesSchema('List of scopes that are disabled for this user ("imap", "pop3", "smtp")'), {
                        default: []
                    }),

                    metaData: metaDataOptional('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataOptional(
                        'Optional metadata for internal use, must be an object or JSON formatted string of an object. Not available for user-role tokens'
                    ),

                    pubKey: pubKeySchema,
                    smimeCerts: Object.assign(
                        smimeCertsSchema(
                            'S/MIME recipient certificates (PEM). Messages are encrypted for all listed certificates. Mutually exclusive with PGP (pubKey).'
                        ),
                        { default: [] }
                    ),
                    smimeCipher: {
                        type: 'string',
                        enum: [...SMIMEEncryptor.CIPHERS],
                        default: consts.SMIME_DEFAULT_CIPHER,
                        description: 'S/MIME content encryption cipher.'
                    },
                    smimeKeyTransport: {
                        type: 'string',
                        enum: [...SMIMEEncryptor.RSA_KEY_TRANSPORTS],
                        default: consts.SMIME_DEFAULT_RSA_KEY_TRANSPORT,
                        description: 'S/MIME RSA key transport algorithm.'
                    },
                    encryptMessages: { $ref: 'wd:boolean', default: false, description: 'If true then received messages are encrypted' },
                    encryptForwarded: { $ref: 'wd:boolean', default: false, description: 'If true then forwarded messages are encrypted' },

                    featureFlags: featureFlagsSchema('Feature flags to specify'),

                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {},
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'CreateUserResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the User' }
                            },
                            required: ['success', 'id']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            if (result.value.password && !result.value.hashedPassword && !result.value.allowUnsafe) {
                try {
                    const { count } = await tools.checkPwnedPassword(result.value.password);
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
            let mtaRelay = values.mtaRelay;

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

            if (mtaRelay && /^smtps?:/i.test(mtaRelay)) {
                mtaRelay = {
                    id: new ObjectId(),
                    type: 'relay',
                    value: mtaRelay // current mtaRelay string value
                };
                values.mtaRelay = mtaRelay;
            }

            if ('pubKey' in req.rawParams && !values.pubKey) {
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

            if (values.pubKey && values.smimeCerts && values.smimeCerts.length) {
                res.status(400);
                return res.json({
                    error: 'pubKey (PGP) and smimeCerts are mutually exclusive',
                    code: 'InputValidationError'
                });
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

            try {
                getCertInfo(values.smimeCerts);
            } catch (err) {
                res.status(400);
                return res.json({
                    error: 'S/MIME certificate validation failed. ' + err.message,
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
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    username: Object.assign({}, usernameSchema, {
                        wdRequired: true,
                        description:
                            'Username of the User. Alphanumeric value. Must start with a letter, dots are allowed but informational only ("user.name" is the same as "username")'
                    })
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'ResolveIdForUsernameResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'Unique ID (24 byte hex)', examples: ['609d201236d1d936948f23b1'] }
                            },
                            required: ['success', 'id']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
            jsonSchema: true,
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
                        model: {
                            type: 'object',
                            title: 'GetUserResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'Users unique ID (24 byte hex)' },
                                username: { type: 'string', description: 'Username of the User' },
                                name: { type: 'string', description: 'Name of the User' },
                                address: { type: 'string', description: 'Main email address of the User' },
                                retention: { description: 'Default retention time (in ms). Not present if not enabled' },
                                enabled2fa: { type: 'array', items: { type: 'string' }, description: 'List of enabled 2FA methods' },
                                autoreply: {
                                    type: 'boolean',
                                    description: 'Is autoreply enabled or not (start time may still be in the future or end time in the past)'
                                },
                                encryptMessages: { type: 'boolean', description: 'If true then received messages are encrypted' },
                                encryptForwarded: { type: 'boolean', description: 'If true then forwarded messages are encrypted' },
                                pubKey: { type: 'string', description: 'Public PGP key for the User that is used for encryption' },
                                keyInfo: { description: 'Information about public key or false if key is not available' },
                                smimeCerts: { type: 'array', items: { type: 'string' }, description: 'S/MIME recipient certificates (PEM)' },
                                smimeCipher: { type: 'string', description: 'S/MIME content encryption cipher' },
                                smimeKeyTransport: { type: 'string', description: 'S/MIME RSA key transport algorithm' },
                                smimeCertInfo: {
                                    type: 'array',
                                    description: 'Information about S/MIME certificates or empty array if not available',
                                    items: {
                                        type: 'object',
                                        title: 'SmimeCertInfoItem',
                                        additionalProperties: true,
                                        properties: {
                                            subject: { type: 'string', description: 'Certificate subject CN' },
                                            serial: { type: 'string', description: 'Certificate serial number' },
                                            fingerprint: { type: 'string', description: 'SHA-256 fingerprint of the certificate' }
                                        }
                                    }
                                },
                                metaData: { description: 'Custom metadata object set for this user' },
                                internalData: { description: 'Custom internal metadata object set for this user. Not available for user-role tokens' },
                                targets: { type: 'array', items: { type: 'string' }, description: 'List of forwarding targets' },
                                mtaRelay: { description: 'MTA Relay url' },
                                spamLevel: {
                                    type: 'number',
                                    description: 'Relative scale for detecting spam. 0 means that everything is spam, 100 means that nothing is spam'
                                },
                                limits: { type: 'object', additionalProperties: true, description: 'Account limits and usage' },
                                tags: { type: 'array', items: { type: 'string' }, description: 'List of tags associated with the User' },
                                fromWhitelist: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'A list of additional email addresses this user can send mail from. Wildcard is allowed.'
                                },
                                disabledScopes: { type: 'array', items: { type: 'string' }, description: 'Disabled scopes for this user' },
                                hasPasswordSet: { type: 'boolean', description: 'If true then the User has a password set and can authenticate' },
                                activated: { type: 'boolean', description: 'Is the account activated' },
                                disabled: { type: 'boolean', description: 'If true then the user can not authenticate or receive any new mail' },
                                suspended: { type: 'boolean', description: 'If true then the user can not authenticate' },
                                lastPwnedCheck: { description: 'Date when the last check of password against the Pwned passwords list was done' },
                                passwordPwned: { type: 'boolean', description: 'Specifies whether the user password has been found in Pwned passwords list' },
                                require2faEnabled: { type: 'boolean', description: 'If true then the account is flagged as requiring 2FA to be enabled' },
                                requirePasswordChange: {
                                    type: 'boolean',
                                    description: 'Indicates if account password has been reset and should be replaced'
                                }
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

            let smimeCertInfo = [];
            try {
                smimeCertInfo = getCertInfo(userData.smimeCerts);
            } catch (err) {
                errors.notify(err, { userId: user, source: 'smime' });
            }

            return res.json(
                permission.filter({
                    success: true,
                    id: user.toString(),

                    username: userData.username,
                    name: userData.name,

                    address: userData.address,

                    language: userData.language,
                    retention: userData.retention || undefined,

                    enabled2fa: tools.getEnabled2fa(userData.enabled2fa),
                    autoreply: !!userData.autoreply,

                    encryptMessages: userData.encryptMessages,
                    encryptForwarded: userData.encryptForwarded,
                    pubKey: userData.pubKey,
                    smimeCerts: userData.smimeCerts || [],
                    smimeCipher: userData.smimeCipher || consts.SMIME_DEFAULT_CIPHER,
                    smimeKeyTransport: userData.smimeKeyTransport || consts.SMIME_DEFAULT_RSA_KEY_TRANSPORT,
                    spamLevel: userData.spamLevel,
                    keyInfo,
                    smimeCertInfo,

                    metaData: tools.formatMetaData(userData.metaData),
                    internalData: tools.formatMetaData(userData.internalData),

                    targets: []
                        .concat(userData.targets || [])
                        .map(target => target.value)
                        .filter(target => target),

                    mtaRelay: userData.mtaRelay?.value || undefined,

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
                    suspended: !!userData.suspended,
                    lastPwnedCheck: userData.lastPwnedCheck,
                    passwordPwned: !!userData.passwordPwned,
                    require2faEnabled: !!userData.require2faEnabled,
                    requirePasswordChange: !!userData.requirePasswordChange
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
            jsonSchema: true,
            validationObjs: {
                requestBody: {
                    existingPassword: {
                        type: 'string',
                        maxLength: 256,
                        minLength: 1,
                        wdEmpty: true,
                        description: 'Validates against account password before applying any changes.'
                    },

                    password: passwordSchema(
                        'New password for the account. Set to boolean false to disable password usage for the master scope, Application Specific Passwords would still be allowed'
                    ),
                    hashedPassword: {
                        $ref: 'wd:boolean',
                        default: false,
                        description:
                            'If true then password is already hashed, so store as is. Supported hashes: pbkdf2, bcrypt ($2a, $2y, $2b), md5 ($1), sha512 ($6), sha256 ($5), argon2 ($argon2d, $argon2i, $argon2id). Stored hashes are rehashed to pbkdf2 on first successful password check.'
                    },
                    allowUnsafe: {
                        $ref: 'wd:boolean',
                        default: true,
                        description:
                            'If false then validates provided passwords against Have I Been Pwned API. Experimental, so validation is disabled by default but will be enabled automatically in some future version of WildDuck.'
                    },

                    language: { type: 'string', maxLength: 20, minLength: 1, wdEmpty: true, description: 'Language code for the User' },

                    name: { type: 'string', maxLength: 256, minLength: 1, wdEmpty: true, description: 'Name of the User' },
                    targets: forwardTargetsSchema(
                        'An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to'
                    ),

                    mtaRelay: mtaRelaySchema(
                        'An address of an SMTP MTA relay. The value should be a relay url. If specified uses the this relay as the outbound MTA.'
                    ),

                    spamLevel: {
                        type: 'number',
                        minimum: 0,
                        maximum: 100,
                        wdType: 'number',
                        description: 'Relative scale for detecting spam. 0 means that everything is spam, 100 means that nothing is spam'
                    },

                    uploadSentMessages: {
                        $ref: 'wd:boolean',
                        default: false,
                        description:
                            'If true then all messages sent through MSA are also uploaded to the Sent Mail folder. Might cause duplicates with some email clients, so disabled by default.'
                    },

                    fromWhitelist: tagListSchema('A list of additional email addresses this user can send mail from. Wildcard is allowed.'),

                    metaData: metaDataOptional('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataOptional(
                        'Optional internal metadata, must be an object or JSON formatted string of an object. Not available for user-role tokens'
                    ),

                    pubKey: pubKeySchema,
                    smimeCerts: smimeCertsSchema(
                        'S/MIME recipient certificates (PEM). Messages are encrypted for all listed certificates. Mutually exclusive with PGP (pubKey). Use empty array to remove.'
                    ),
                    smimeCipher: { type: 'string', enum: [...SMIMEEncryptor.CIPHERS], description: 'S/MIME content encryption cipher' },
                    smimeKeyTransport: {
                        type: 'string',
                        enum: [...SMIMEEncryptor.RSA_KEY_TRANSPORTS],
                        description: 'S/MIME RSA key transport algorithm'
                    },
                    encryptMessages: { $ref: 'wd:boolean', description: 'If true then received messages are encrypted' },
                    encryptForwarded: { $ref: 'wd:boolean', description: 'If true then forwarded messages are encrypted' },
                    retention: nonNegativeInteger('Default retention time (in ms). Set to 0 to disable'),

                    quota: nonNegativeInteger('Allowed quota of the user in bytes'),
                    recipients: nonNegativeInteger('How many messages per 24 hour can be sent'),
                    forwards: nonNegativeInteger('How many messages per 24 hour can be forwarded'),

                    filters: nonNegativeInteger('How many filters are allowed for this account'),

                    imapMaxUpload: nonNegativeInteger('How many bytes can be uploaded via IMAP during 24 hour'),
                    imapMaxDownload: nonNegativeInteger('How many bytes can be downloaded via IMAP during 24 hour'),
                    pop3MaxDownload: nonNegativeInteger('How many bytes can be downloaded via POP3 during 24 hour'),
                    pop3MaxMessages: nonNegativeInteger('How many latest messages to list in POP3 session'),
                    imapMaxConnections: nonNegativeInteger('How many parallel IMAP connections are allowed'),

                    receivedMax: nonNegativeInteger('How many messages can be received from MX during 60 seconds'),

                    disable2fa: { $ref: 'wd:boolean', description: 'If true, then disables 2FA for this user' },
                    require2faEnabled: { $ref: 'wd:boolean', description: 'If true then the account is flagged as requiring 2FA to be enabled' },

                    tags: tagListSchema('A list of tags associated with this user'),

                    disabledScopes: disabledScopesSchema('List of scopes that are disabled for this user ("imap", "pop3", "smtp")'),

                    disabled: { $ref: 'wd:boolean', description: 'If true then disables user account (can not login, can not receive messages)' },

                    featureFlags: featureFlagsSchema('Enabled feature flags'),

                    suspended: { $ref: 'wd:boolean', description: 'If true then disables authentication' },

                    protocol: { type: 'string', minLength: 1, default: 'API', description: 'Application identifier for security logs' },
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
                    const { count } = await tools.checkPwnedPassword(values.password);
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
            let mtaRelay = values.mtaRelay;

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

            if (mtaRelay && /^smtps?:/i.test(mtaRelay)) {
                mtaRelay = {
                    id: new ObjectId(),
                    type: 'relay',
                    value: mtaRelay // current mtaRelay string value
                };
                values.mtaRelay = mtaRelay;
            }

            if (!values.name && 'name' in req.params) {
                values.name = '';
            }

            if (!values.pubKey && 'pubKey' in req.params) {
                values.pubKey = '';
            }

            // Enforce mutual exclusivity: setting one clears the other
            if (values.pubKey) {
                values.smimeCerts = [];
                values.smimeCipher = consts.SMIME_DEFAULT_CIPHER;
                values.smimeKeyTransport = consts.SMIME_DEFAULT_RSA_KEY_TRANSPORT;
            } else if (values.smimeCerts && values.smimeCerts.length) {
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

            try {
                getCertInfo(values.smimeCerts);
            } catch (err) {
                res.status(400);
                return res.json({
                    error: 'S/MIME certificate validation failed. ' + err.message,
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
            jsonSchema: true,
            validationObjs: {
                requestBody: {
                    reason: { type: 'string', maxLength: 128, minLength: 1, wdEmpty: true, description: 'Message to be shown to connected IMAP client' },
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
            jsonSchema: true,
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
                        model: {
                            type: 'object',
                            title: 'RecalculateQuotaResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                storageUsed: { type: 'number', description: 'Calculated quota usage for the user' },
                                previousStorageUsed: { type: 'number', description: 'Previous storage used' }
                            },
                            required: ['success', 'storageUsed', 'previousStorageUsed']
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
            jsonSchema: true,
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
                        model: {
                            type: 'object',
                            title: 'RecalculateQuotaAllUsersResponse',
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
            jsonSchema: true,
            validationObjs: {
                requestBody: {
                    users: {
                        type: 'array',
                        wdSingle: true,
                        items: { type: 'string', pattern: '^[0-9a-f]{24}$', minLength: 24, maxLength: 24, wdLowercase: true },
                        description: 'An array of User ID values to export'
                    },
                    tags: {
                        type: 'array',
                        wdSingle: true,
                        items: { type: 'string', maxLength: 1024, minLength: 1, wdTrim: true, wdEmpty: true },
                        description: 'An array of user tags to export. If set then at least one tag must exist on an user.'
                    },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {},
                queryParams: {},
                response: {
                    200: {
                        description: 'Success'
                    }
                }
            },
            responseType: 'application/octet-stream'
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
            jsonSchema: true,
            // the restify-era handler ran no validation at all
            allowUnknown: true,
            validationObjs: {
                requestBody: {},
                pathParams: {},
                queryParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'CreateImportResponse',
                            additionalProperties: true,
                            properties: {
                                entries: { type: 'number', description: 'How many database entries were found from the export file' },
                                imported: { type: 'number', description: 'How many database entries were imported from the export file' },
                                failed: { type: 'number', description: 'How many database entries were not imported due to some error' },
                                existing: { type: 'number', description: 'How many database existing entries were not imported' }
                            }
                        }
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

                            if (
                                Object.hasOwn(DATA_IMPORT_EXPORT_COLLECTIONS, entry.client) &&
                                DATA_IMPORT_EXPORT_COLLECTIONS[entry.client].includes(entry.collection)
                            ) {
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
                                        document.modifyIndex = 1;
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
                                result.failed++;
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
            jsonSchema: true,
            validationObjs: {
                requestBody: {
                    validAfter: {
                        wdEmpty: true,
                        anyOf: [{ wdType: 'date', wdInstanceof: 'Date' }, { const: false }],
                        description: 'Allow using the generated password not earlier than provided time'
                    },
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
                        model: {
                            type: 'object',
                            title: 'ResetUserPasswordResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                password: { type: 'string', description: 'Temporary password' },
                                validAfter: { description: 'The date password is valid after' }
                            },
                            required: ['success', 'password']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    deleteAfter: {
                        wdEmpty: true,
                        default: false,
                        anyOf: [{ wdType: 'date', wdInstanceof: 'Date' }, { const: false }],
                        description:
                            'Delete user entry from registry but keep all user data until provided date. User account is fully recoverable up to that date.'
                    },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'DeleteUserResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                code: { type: 'string', description: 'Task code. Should be TaskScheduled', examples: ['TaskScheduled'] },
                                user: { type: 'string', description: 'User ID' },
                                addresses: {
                                    type: 'object',
                                    additionalProperties: true,
                                    properties: {
                                        deleted: { type: 'number', description: 'Number of deleted addresses' }
                                    }
                                },
                                deleteAfter: { description: 'Delete after date' },
                                task: { type: 'string', description: 'Task ID' }
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
            jsonSchema: true,
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
                        model: {
                            type: 'object',
                            title: 'RecoverInfoResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                user: { type: 'string', description: 'ID of the deleted User' },
                                username: { type: 'string', description: 'Username of the User' },
                                storageUsed: { type: 'number', description: 'Calculated quota usage for the user' },
                                tags: { type: 'array', items: { type: 'string' }, description: 'List of tags associated with the User' },
                                deleted: { description: 'Datestring of the time the user was deleted' },
                                recoverableAddresses: { type: 'array', items: { type: 'string' }, description: 'List of email addresses that can be restored' }
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
            jsonSchema: true,
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
                        model: {
                            type: 'object',
                            title: 'CancelUserDeletionResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                code: { type: 'string', description: 'Task status code' },
                                user: { type: 'string', description: 'User ID' },
                                task: { type: 'string', description: 'Existing task id' },
                                addresses: {
                                    type: 'object',
                                    additionalProperties: true,
                                    properties: {
                                        recovered: { type: 'number', description: 'Number of recovered addresses' },
                                        main: { type: 'string', description: 'Main address' }
                                    }
                                }
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
        config: { minRSABits: 2048 }
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

function getCertInfo(certs) {
    if (!certs || !certs.length) {
        return [];
    }

    let results = [];
    for (let i = 0; i < certs.length; i++) {
        let cert;
        try {
            cert = new crypto.X509Certificate(certs[i]);
        } catch (err) {
            throw new Error(`Certificate #${i + 1}: ${err.message}`);
        }

        try {
            SMIMEEncryptor.validateCertKey(certs[i]);
        } catch (err) {
            throw new Error(`Certificate #${i + 1}: ${err.message}`);
        }

        results.push({
            subject: cert.subject,
            serial: cert.serialNumber,
            fingerprint: cert.fingerprint256
        });
    }

    return results;
}
