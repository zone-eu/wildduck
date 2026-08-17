'use strict';

const ObjectId = require('mongodb').ObjectId;
const { objectIdSchema } = require('../schemas/json-schemas');
const config = require('@zone-eu/wild-config');
const roles = require('../roles');
const { mongopagingFindWrapper } = require('../mongopaging-find-wrapper');

// username or email address (Joi.alternatives of usernameSchema and email)
const usernameOrEmail = {
    wdRequired: true,
    anyOf: [{ $ref: 'wd:username' }, { type: 'string', wdAssert: 'email' }],
    description: 'Username or E-mail address'
};

const require2faResponse = description => ({
    anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'boolean' }],
    description
});

// authlog events echo raw db fields, the documented properties are the known
// ones but the objects stay open
const authlogEventProperties = {
    id: { type: 'string', description: 'ID of the event' },
    action: { type: 'string', description: 'Action identifier' },
    result: { type: 'string', description: 'Did the action succeed' },
    key: { description: 'Event merge key' },
    sess: { description: 'Session identifier for the logs' },
    ip: { description: 'IP address for the logs' },
    created: { description: 'Datestring of the Event time' },
    protocol: { type: 'string', description: 'Protocol that the authentication was made from' },
    requiredScope: { type: 'string', description: 'Scope of the auth' },
    target: { type: 'string', description: 'Target value for the action' },
    asp: { type: 'string', description: 'Application password ID' },
    aname: { type: 'string', description: 'Application password description' },
    temporary: { type: 'boolean', description: 'Whether the action used a temporary credential' },
    filter: { type: 'string', description: 'Filter ID associated with the event' },
    credential: { type: 'string', description: 'WebAuthn credential ID' },
    appId: { type: 'string', description: 'Optional appId which is the URL of the app' },
    require2fa: { description: '2FA requirement detail' },
    last: { description: 'Date of the last update of data' },
    events: { type: 'number', description: 'Number of times same auth log has occurred' },
    source: { type: 'string', description: 'Source of auth. Example: `master` if password auth was used' },
    expires: { description: 'After this date the given auth log document will not be updated and instead a new one will be created' }
};

module.exports = (db, server, userHandler) => {
    server.route({
        method: 'POST',
        url: '/preauth',
        schema: {
            summary: 'Pre-auth check',
            description: 'Check if an username exists and can be used for authentication',
            tags: ['Authentication']
        },
        config: {
            name: 'preauth',
            validationObjs: {
                requestBody: {
                    username: usernameOrEmail,

                    scope: { type: 'string', minLength: 1, default: 'master', description: 'Required scope. One of master, imap, smtp, pop3' },

                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'PreAuthCheckResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the User' },
                                username: { type: 'string', description: 'Username of authenticated User' },
                                address: { type: 'string', description: 'Default email address of authenticated User' },
                                scope: { type: 'string', description: 'The scope this authentication is valid for' },
                                require2fa: require2faResponse('List of enabled 2FA mechanisms or false if not required')
                            },
                            // address is echoed from the db document and may be absent
                            // for accounts without a default address
                            required: ['success', 'id', 'username', 'scope', 'require2fa']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            let values = req.params;

            let permission = roles.can(req.role).createAny('authentication');

            // permissions check
            req.validate(permission);

            // filter out unallowed fields
            values = permission.filter(values);

            let authData, user;

            try {
                [authData, user] = await userHandler.preAuth(values.username, values.scope);
            } catch (err) {
                let response = {
                    error: err.message,
                    code: err.code || 'AuthFailed'
                };
                if (user) {
                    response.id = user.toString();
                }
                return reply.code(403).send(response);
            }

            if (!authData) {
                let response = {
                    error: 'Authentication failed',
                    code: 'AuthFailed'
                };
                if (user) {
                    response.id = user.toString();
                }
                return reply.code(403).send(response);
            }

            let preAuthResponse = {
                success: true,
                id: authData.user.toString(),
                username: authData.username,
                address: authData.address,
                scope: authData.scope,
                require2fa: authData.require2fa
            };

            return reply.code(200).send(permission.filter(preAuthResponse));
        }
    });

    server.route({
        method: 'POST',
        url: '/authenticate',
        schema: {
            summary: 'Authenticate a User',
            tags: ['Authentication']
        },
        config: {
            name: 'authenticate',
            validationObjs: {
                requestBody: {
                    username: usernameOrEmail,
                    password: { type: 'string', maxLength: 256, minLength: 1, wdRequired: true, description: 'Password' },

                    protocol: { type: 'string', minLength: 1, default: 'API', description: 'Application identifier for security logs' },
                    scope: { type: 'string', minLength: 1, default: 'master', description: 'Required scope. One of master, imap, smtp, pop3' },

                    appId: {
                        type: 'string',
                        minLength: 1,
                        wdEmpty: true,
                        wdValidator: 'uri',
                        description: 'Optional appId which is the URL of the app'
                    },

                    token: {
                        $ref: 'wd:boolean',
                        default: false,
                        description:
                            'If true then generates a temporary access token that is valid for this user. Only available if scope is "master". When using user tokens then you can replace user ID in URLs with "me".'
                    },

                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {},
                // token can be true only if scope is master (Joi scope.when)
                conditions: [
                    {
                        if: { properties: { token: { const: true } }, required: ['token'] },
                        then: { properties: { scope: { const: 'master' } } }
                    }
                ],
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'AuthenticateResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the User' },
                                username: { type: 'string', description: 'Username of authenticated User' },
                                address: { type: 'string', description: 'Default email address of authenticated User' },
                                scope: { type: 'string', description: 'The scope this authentication is valid for' },
                                require2fa: require2faResponse('List of enabled 2FA mechanisms or false if not required'),
                                require2faEnabled: { type: 'boolean', description: 'If true then the account is flagged as requiring 2FA to be enabled' },
                                requirePasswordChange: { type: 'boolean', description: 'Indicates if account password has been reset and should be replaced' },
                                token: {
                                    type: 'string',
                                    description:
                                        'If access token was requested and no WildDuck-verifiable 2FA challenge is required, or strict2fa is disabled, then this is the value to use as access token when making API requests on behalf of logged in user.'
                                },
                                twoFactorNonce: { type: 'string', description: 'Short-lived nonce for completing 2FA authentication' },
                                totpNonce: { type: 'string', description: 'Short-lived nonce for completing TOTP authentication' },
                                passwordPwned: {
                                    type: 'boolean',
                                    description: 'Indicates whether account password has been found in the list of Pwned passwords and should be replaced'
                                }
                            },
                            // ASP-scope authentications omit address and the
                            // 2fa/password flags, the old model over-claimed
                            required: ['success', 'id', 'username', 'scope', 'require2fa']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            let values = req.params;

            let permission = roles.can(req.role).createAny('authentication');

            // permissions check
            req.validate(permission);

            // filter out unallowed fields
            values = permission.filter(values);

            let meta = {
                protocol: values.protocol,
                sess: values.sess,
                ip: values.ip
            };

            if (values.appId) {
                meta.appId = values.appId;
            }

            let authData, user;

            try {
                [authData, user] = await userHandler.asyncAuthenticate(values.username, values.password, values.scope, meta);
            } catch (err) {
                let response = {
                    error: err.message,
                    code: err.code || 'AuthFailed'
                };

                if (user) {
                    response.id = user.toString();
                }

                return reply.code(403).send(response);
            }

            if (!authData) {
                let response = {
                    error: 'Authentication failed',
                    code: 'AuthFailed'
                };
                if (user) {
                    response.id = user.toString();
                }
                return reply.code(403).send(response);
            }

            let authResponse = {
                success: true,
                id: authData.user.toString(),
                username: authData.username,
                address: authData.address,
                scope: authData.scope,
                require2fa: authData.require2fa,
                require2faEnabled: authData.require2faEnabled,
                requirePasswordChange: authData.requirePasswordChange
            };

            if (authData.passwordPwned) {
                authResponse.passwordPwned = authData.passwordPwned;
            }

            if (values.token) {
                try {
                    const pending2faMethods = Array.isArray(authData.require2fa) ? authData.require2fa.filter(method => method !== 'custom') : [];

                    if (config.strict2fa !== false && pending2faMethods.length) {
                        authResponse.twoFactorNonce = await userHandler.generatePending2faNonce(authData.user, {
                            methods: pending2faMethods,
                            tokenRequested: true
                        });

                        if (!authResponse.twoFactorNonce) {
                            let err = new Error('Failed to create 2FA authentication nonce');
                            err.code = 'AuthFailed';
                            throw err;
                        }

                        if (pending2faMethods.includes('totp')) {
                            authResponse.totpNonce = authResponse.twoFactorNonce;
                        }
                    } else {
                        authResponse.token = await userHandler.generateAuthToken(authData.user);
                        if (config.strict2fa === false && pending2faMethods.includes('totp')) {
                            authResponse.totpNonce = await userHandler.generatePending2faNonce(authData.user, {
                                methods: ['totp'],
                                tokenRequested: false
                            });

                            if (!authResponse.totpNonce) {
                                let err = new Error('Failed to create TOTP authentication nonce');
                                err.code = 'AuthFailed';
                                throw err;
                            }
                        }
                    }
                } catch (err) {
                    let response = {
                        error: err.message,
                        code: err.code || 'AuthFailed',
                        id: user.toString()
                    };
                    return reply.code(403).send(response);
                }
            }

            return reply.code(200).send(permission.filter(authResponse));
        }
    });

    server.route({
        method: 'DELETE',
        url: '/authenticate',
        schema: {
            summary: 'Invalidate authentication token',
            description: 'This method invalidates currently used authentication token. If token is not provided then nothing happens',
            tags: ['Authentication']
        },
        config: {
            name: 'invalidateAccessToken',
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
                            title: 'SuccessResponse',
                            properties: { success: { $ref: 'wd:successRes' } },
                            required: ['success']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            if (req.accessToken) {
                try {
                    await db.redis
                        .multi()
                        .del('tn:token:' + req.accessToken.hash)
                        .exec();
                } catch (err) {
                    // ignore
                }
            }

            return reply.send({ success: true });
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/authlog',
        schema: {
            summary: 'List authentication Events',
            tags: ['Authentication']
        },
        config: {
            name: 'getAuthlog',
            validationObjs: {
                requestBody: {},
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: {
                    action: {
                        type: 'string',
                        maxLength: 100,
                        minLength: 1,
                        wdTrim: true,
                        wdLowercase: true,
                        wdEmpty: true,
                        description: 'Limit listing only to values with specific action value'
                    },
                    limit: { $ref: 'wd:pageLimit' },
                    next: { $ref: 'wd:cursor', description: 'Cursor value for next page, retrieved from nextCursor response value' },
                    previous: { $ref: 'wd:cursor', description: 'Cursor value for previous page, retrieved from previousCursor response value' },
                    filterip: { $ref: 'wd:ip', description: 'Limit listing only to values with specific IP address' },

                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetAuthlogResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                action: { type: 'string', description: 'Limit listing only to values with specific action value' },
                                total: { $ref: 'wd:totalRes' },
                                page: { $ref: 'wd:pageRes' },
                                previousCursor: { $ref: 'wd:previousCursorRes' },
                                nextCursor: { $ref: 'wd:nextCursorRes' },
                                results: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        title: 'GetAuthlogResult',
                                        additionalProperties: true,
                                        properties: authlogEventProperties,
                                        required: ['id']
                                    }
                                }
                            },
                            required: ['success', 'total', 'page', 'previousCursor', 'nextCursor', 'results']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).readOwn('authentication'));
            } else {
                req.validate(roles.can(req.role).readAny('authentication'));
            }

            let user = new ObjectId(values.user);
            let limit = values.limit;

            let action = values.action;
            let ip = values.filterip;

            let pageNext = values.next;
            let pagePrevious = values.previous;

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
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!userData) {
                return reply.code(404).send({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
            }

            let filter = { user };
            if (ip) {
                filter.ip = ip;
            }
            if (action) {
                filter.action = action;
            }

            let total = await db.users.collection('authlog').countDocuments(filter);

            let opts = {
                limit,
                query: filter,
                sortAscending: false
            };

            if (pageNext) {
                opts.next = pageNext;
            }
            if (pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listingWrapper;
            try {
                listingWrapper = await mongopagingFindWrapper(db.users.collection('authlog'), opts);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let response = {
                success: true,
                action,
                total,
                page: listingWrapper.page,
                previousCursor: listingWrapper.previousCursor,
                nextCursor: listingWrapper.nextCursor,
                results: (listingWrapper.listing.results || []).map(resultData => {
                    let response = {
                        id: (resultData._id || '').toString()
                    };
                    Object.keys(resultData).forEach(key => {
                        if (!['_id', 'user'].includes(key)) {
                            response[key] = resultData[key];
                        }
                    });
                    return response;
                })
            };

            return reply.send(response);
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/authlog/:event',
        schema: {
            summary: 'Request Event information',
            tags: ['Authentication']
        },
        config: {
            name: 'getAuthlogEvent',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    event: objectIdSchema('ID of the Event', { wdRequired: true })
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetAuthlogEventResponse',
                            additionalProperties: true,
                            properties: Object.assign({ success: { $ref: 'wd:successRes' } }, authlogEventProperties),
                            required: ['success', 'id']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).readOwn('authentication'));
            } else {
                req.validate(roles.can(req.role).readAny('authentication'));
            }

            let user = new ObjectId(values.user);
            let event = new ObjectId(values.event);

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
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!userData) {
                return reply.code(404).send({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
            }

            let filter = { _id: event, user };
            let eventData;
            try {
                eventData = await db.users.collection('authlog').findOne(filter);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!eventData) {
                return reply.code(404).send({
                    error: 'Event was not found',
                    code: 'EventNotFound'
                });
            }

            let response = {
                success: true,
                id: eventData._id.toString()
            };
            Object.keys(eventData).forEach(key => {
                if (!['_id', 'user'].includes(key)) {
                    response[key] = eventData[key];
                }
            });

            return reply.send(response);
        }
    });

    server.route({
        method: 'GET',
        url: '/authenticated',
        schema: {
            summary: 'Validates the user authentication status',
            tags: ['Authentication']
        },
        config: {
            name: 'isUserAuthenticated',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetIsUserAuthenticatedResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                sess: { $ref: 'wd:sess' },
                                ip: { type: 'string', description: 'IP address for the logs' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            let permission = roles.can(req.role).readAny('authentication'); // check if admin
            if (!permission.granted && req.user && ObjectId.isValid(req.user)) {
                // check if user
                permission = roles.can(req.role).readOwn('authentication');
            }

            req.validate(permission);

            let response = {
                success: true
            };

            return reply.send(response);
        }
    });
};
