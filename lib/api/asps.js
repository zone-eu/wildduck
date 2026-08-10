'use strict';

const config = require('@zone-eu/wild-config');
const { objectIdSchema } = require('../schemas/json-schemas');
const ObjectId = require('mongodb').ObjectId;
const mobileconfig = require('@zone-eu/mobileconfig');
const { randomUUID: uuid } = require('crypto');
const consts = require('../consts');
const certs = require('../certs').get('api.mobileconfig');
const tools = require('../tools');
const roles = require('../roles');
const util = require('util');

const aspIdParam = objectIdSchema('ID of the Application Password', { wdRequired: true });

const scopesSchema = required => {
    const schema = {
        type: 'array',
        items: {
            type: 'string',
            enum: [...consts.SCOPES, '*']
        },
        uniqueItems: true,
        // Joi required at least one item (.items(...required())); an empty list
        // would store a password that can never authenticate, because
        // user-handler rejects an ASP whose scopes match nothing
        minItems: 1,
        wdSplitCsv: true,
        description: 'List of scopes this Password applies to. Special scope "*" indicates that this password can be used for any scope except "master"'
    };
    if (!required) {
        schema.default = ['*'];
    }
    return schema;
};

const lastUseResponse = {
    type: 'object',
    title: 'LastUse',
    description: 'Information about last use',
    properties: {
        time: { description: 'Datestring of last use or not present if password has not been used' },
        event: { description: 'Event ID of the security log for the last authentication' }
    }
};

const aspResultProperties = {
    id: { type: 'string', description: 'ID of the Application Password' },
    description: { type: 'string', description: 'Description' },
    scopes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Allowed scopes for the Application Password'
    },
    lastUse: lastUseResponse,
    created: { type: 'string', format: 'date-time', description: 'Datestring' },
    expires: { description: 'Application password expires after the given date' }
};

module.exports = (db, server, userHandler) => {
    const mobileconfigGetSignedConfig = util.promisify(mobileconfig.getSignedConfig.bind(mobileconfig));

    server.route({
        method: 'GET',
        url: '/users/:user/asps',
        schema: {
            summary: 'List Application Passwords',
            tags: ['ApplicationPasswords']
        },
        config: {
            name: 'getASPs',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    showAll: { $ref: 'wd:boolean', default: false, description: 'If not true then skips entries with a TTL set' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: { user: { $ref: 'wd:userId' } },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetASPsResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                results: {
                                    type: 'array',
                                    description: 'Event listing',
                                    items: {
                                        type: 'object',
                                        title: 'GetASPsResult',
                                        properties: aspResultProperties,
                                        // description/created are echoed from the db document and
                                        // may be absent on legacy records
                                        required: ['id', 'scopes', 'lastUse']
                                    }
                                }
                            },
                            required: ['success', 'results']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).readOwn('asps'));
            } else {
                req.validate(roles.can(req.role).readAny('asps'));
            }

            let user = new ObjectId(values.user);
            let showAll = values.showAll;

            let userData;

            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            address: true
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

            let asps;
            try {
                asps = await db.users
                    .collection('asps')
                    .find({
                        user
                    })
                    .sort({ _id: 1 })
                    .toArray();
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!asps) {
                asps = [];
            }

            return reply.send({
                success: true,

                results: asps
                    .filter(asp => {
                        if (showAll) {
                            return true;
                        }
                        if (asp.ttl) {
                            return false;
                        }
                        return true;
                    })
                    .map(asp => ({
                        id: asp._id.toString(),
                        description: asp.description,
                        scopes: asp.scopes.includes('*') ? [...consts.SCOPES] : asp.scopes,
                        lastUse: {
                            time: asp.used || undefined,
                            event: asp.authEvent || undefined
                        },
                        expires: asp.expires,
                        created: asp.created
                    }))
            });
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/asps/:asp',
        schema: {
            summary: 'Request ASP information',
            tags: ['ApplicationPasswords']
        },
        config: {
            name: 'getASP',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: { user: { $ref: 'wd:userId' }, asp: aspIdParam },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetASPResponse',
                            properties: Object.assign({ success: { $ref: 'wd:successRes' } }, aspResultProperties),
                            // description/created are echoed from the db document and
                            // may be absent on legacy records
                            required: ['success', 'id', 'scopes', 'lastUse']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).readOwn('asps'));
            } else {
                req.validate(roles.can(req.role).readAny('asps'));
            }

            let user = new ObjectId(values.user);
            let asp = new ObjectId(values.asp);

            let aspData;

            try {
                aspData = await db.users.collection('asps').findOne({
                    _id: asp,
                    user
                });
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!aspData) {
                return reply.code(404).send({
                    error: 'Invalid or unknown ASP key',
                    code: 'AspNotFound'
                });
            }

            return reply.send({
                success: true,
                id: aspData._id.toString(),
                description: aspData.description,
                scopes: aspData.scopes.includes('*') ? [...consts.SCOPES] : aspData.scopes,
                lastUse: {
                    time: aspData.used || undefined,
                    event: aspData.authEvent || undefined
                },
                expires: aspData.expires,
                created: aspData.created
            });
        }
    });

    server.route({
        method: 'POST',
        url: '/users/:user/asps',
        schema: {
            summary: 'Create new Application Password',
            tags: ['ApplicationPasswords']
        },
        config: {
            name: 'createASP',
            validationObjs: {
                requestBody: {
                    description: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdTrim: true,
                        wdRequired: true,
                        description: 'Description for the Application Password entry'
                    },
                    scopes: scopesSchema(false),
                    address: {
                        type: 'string',
                        wdEmpty: true,
                        wdValidator: 'email',
                        description:
                            'E-mail address to be used as the account address in mobileconfig file. Must be one of the listed identity addresses of the user. Defaults to the main address of the user'
                    },
                    password: {
                        type: 'string',
                        wdEmpty: true,
                        pattern: '^[a-z]{16}$',
                        description: 'Optional pregenerated password. Must be 16 characters, latin letters only.'
                    },
                    generateMobileconfig: {
                        $ref: 'wd:boolean',
                        default: false,
                        description: 'If true then result contains a mobileconfig formatted file with account config'
                    },
                    ttl: {
                        type: 'number',
                        wdType: 'number',
                        wdEmpty: [0, ''],
                        description: 'TTL in seconds for this password. Every time password is used, TTL is reset to this value'
                    },
                    protocol: { type: 'string', minLength: 1, default: 'API', description: 'Application identifier for security logs' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: { user: { $ref: 'wd:userId' } },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'CreateASPResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Application Password' },
                                password: {
                                    type: 'string',
                                    description:
                                        'Application Specific Password. Generated password is whitespace agnostic, so it could be displayed to the client as "abcd efgh ijkl mnop" instead of "abcdefghijklmnop"'
                                },
                                mobileconfig: {
                                    type: 'string',
                                    description:
                                        'Base64 encoded mobileconfig file. Present when generateMobileconfig is true. Generated profile file should be sent to the client with Content-Type value of application/x-apple-aspen-config.'
                                },
                                name: { type: 'string', description: 'Account name. Present when generateMobileconfig is true.' },
                                address: {
                                    type: 'string',
                                    description:
                                        'Account address or the address specified in params of this endpoint. Present when generateMobileconfig is true.'
                                }
                            },
                            required: ['success', 'id', 'password']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).createOwn('asps'));
            } else {
                req.validate(roles.can(req.role).createAny('asps'));
            }

            let user = new ObjectId(values.user);
            let generateMobileconfig = values.generateMobileconfig;
            let scopes = values.scopes || ['*'];
            let description = values.description;

            if (scopes.includes('*')) {
                scopes = ['*'];
            }

            if (generateMobileconfig && !scopes.includes('*') && ((!scopes.includes('imap') && !scopes.includes('pop3')) || !scopes.includes('smtp'))) {
                return reply.code(400).send({
                    error: 'Profile file requires either imap or pop3 and smtp scopes',
                    code: 'InvalidAuthScope'
                });
            }

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            username: true,
                            name: true,
                            address: true
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

            let accountType;
            let accountHost;
            let accountPort;
            let accountSecure;
            let accountAddress;
            let accountName;

            if (values.address) {
                let addressData;
                try {
                    addressData = await db.users.collection('addresses').findOne({
                        addrview: tools.normalizeAddress(values.address, false, {
                            removeLabel: true,
                            removeDots: true
                        })
                    });
                } catch (err) {
                    return reply.code(500).send({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }

                if (!addressData || !addressData.user || !addressData.user.equals(userData._id)) {
                    return reply.code(404).send({
                        error: 'Invalid or unknown address',
                        code: 'AddressNotFound'
                    });
                }

                accountName = addressData.name || userData.name || '';
                accountAddress = addressData.address;
            } else {
                accountName = userData.name || '';
                accountAddress = userData.address;
            }

            let asp = await userHandler.generateASP(user, values);

            if (!generateMobileconfig) {
                return reply.send({
                    success: true,
                    id: asp.id,
                    password: asp.password
                });
            }

            let profileOpts = {};
            Object.keys(config.api.mobileconfig || {}).forEach(key => {
                profileOpts[key] = (config.api.mobileconfig[key] || '')
                    .toString()
                    .replace(/\{email\}/g, accountAddress)
                    .replace(/\{name\}/g, accountName)
                    .trim();
            });

            if (scopes.includes('*') || scopes.includes('imap')) {
                // prefer IMAP
                accountType = 'EmailTypeIMAP';
                accountHost = config.imap.setup.hostname;
                accountPort = config.imap.setup.port || config.imap.port;
                accountSecure = !!config.imap.setup.secure;
            } else {
                accountType = 'EmailTypePOP';
                accountHost = config.pop3.setup.hostname;
                accountPort = config.pop3.setup.port || config.pop3.port;
                accountSecure = !!config.pop3.setup.secure;
            }

            let profile = await mobileconfigGetSignedConfig(
                {
                    PayloadType: 'Configuration',
                    PayloadVersion: 1,
                    PayloadIdentifier: profileOpts.identifier + '.' + userData._id,
                    PayloadUUID: uuid(),
                    PayloadDisplayName: description || profileOpts.displayName,
                    PayloadDescription: profileOpts.displayDescription,
                    PayloadOrganization: profileOpts.organization || 'WildDuck Mail Server',

                    PayloadContent: [
                        {
                            PayloadType: 'com.apple.mail.managed',
                            PayloadVersion: 1,
                            PayloadIdentifier: profileOpts.identifier + '.' + userData._id,
                            PayloadUUID: uuid(),
                            PayloadDisplayName: 'Email Account',
                            PayloadDescription: 'Configures email account',
                            PayloadOrganization: profileOpts.organization || 'WildDuck Mail Server',

                            EmailAccountDescription: profileOpts.accountDescription,
                            EmailAccountName: accountName,
                            EmailAccountType: accountType,
                            EmailAddress: accountAddress,
                            IncomingMailServerAuthentication: 'EmailAuthPassword',
                            IncomingMailServerHostName: accountHost,
                            IncomingMailServerPortNumber: accountPort,
                            IncomingMailServerUseSSL: accountSecure,
                            IncomingMailServerUsername: accountAddress,
                            IncomingPassword: asp.password,
                            OutgoingPasswordSameAsIncomingPassword: true,
                            OutgoingMailServerAuthentication: 'EmailAuthPassword',
                            OutgoingMailServerHostName: config.smtp.setup.hostname,
                            OutgoingMailServerPortNumber: config.smtp.setup.port || config.smtp.port,
                            OutgoingMailServerUseSSL: 'secure' in config.smtp.setup ? !!config.smtp.setup.secure : config.smtp.secure,
                            OutgoingMailServerUsername: accountAddress,
                            PreventMove: false,
                            PreventAppSheet: false,
                            SMIMEEnabled: false,
                            allowMailDrop: true
                        }
                    ]
                },
                certs
            );

            return reply.send({
                success: true,
                id: asp.id,
                name: accountName,
                address: accountAddress,
                password: asp.password,
                mobileconfig: profile.toString('base64')
            });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/asps/:asp',
        schema: {
            summary: 'Delete an Application Password',
            tags: ['ApplicationPasswords']
        },
        config: {
            name: 'deleteASP',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    protocol: { type: 'string', minLength: 1, default: 'API', description: 'Application identifier for security logs' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: { user: { $ref: 'wd:userId' }, asp: aspIdParam },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SuccessResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' }
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
                req.validate(roles.can(req.role).deleteOwn('asps'));
            } else {
                req.validate(roles.can(req.role).deleteAny('asps'));
            }

            let user = new ObjectId(values.user);
            let asp = new ObjectId(values.asp);

            await userHandler.deleteASP(user, asp, values);

            return reply.send({
                success: true
            });
        }
    });
};
