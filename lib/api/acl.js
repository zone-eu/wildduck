'use strict';

const ObjectId = require('mongodb').ObjectId;
const roles = require('../roles');
const acl = require('../acl');
const { objectIdSchema } = require('../schemas/json-schemas');

const granteeId = objectIdSchema('Grantee user ID', { wdRequired: true });
const rightsSchema = {
    type: 'string',
    minLength: 1,
    maxLength: 16,
    pattern: '^[lrswipkxteacd]+$',
    description: 'RFC 4314 rights characters granted to the user, lowercase only'
};

const mailboxAclResult = {
    type: 'object',
    title: 'GetMailboxAclResult',
    properties: {
        user: { type: 'string', description: 'Grantee user ID' },
        username: { type: 'string', description: 'Grantee username' },
        rights: { type: 'string', description: 'RFC 4314 rights characters' },
        subscribed: { type: 'boolean', description: 'Grantee subscription status for this mailbox' },
        created: { type: 'string', format: 'date-time', description: 'Time the entry was created' }
    },
    required: ['user', 'username', 'rights', 'subscribed']
};

module.exports = (db, server, notifier, loggelf) => {
    loggelf = typeof loggelf === 'function' ? loggelf : () => false;
    const loadMailboxData = async (reply, values) => {
        let user = new ObjectId(values.user);
        let mailbox = new ObjectId(values.mailbox);

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
            reply.code(500).send({
                error: 'MongoDB Error: ' + err.message,
                code: 'InternalDatabaseError'
            });
            return false;
        }
        if (!userData) {
            reply.code(404).send({
                error: 'This user does not exist',
                code: 'UserNotFound'
            });
            return false;
        }

        let mailboxData;
        try {
            mailboxData = await db.database.collection('mailboxes').findOne({
                _id: mailbox,
                user
            });
        } catch (err) {
            reply.code(500).send({
                error: 'MongoDB Error: ' + err.message,
                code: 'InternalDatabaseError'
            });
            return false;
        }
        if (!mailboxData) {
            reply.code(404).send({
                error: 'This mailbox does not exist',
                code: 'NoSuchMailbox'
            });
            return false;
        }

        return mailboxData;
    };

    const loadUserData = async (reply, values) => {
        let user = new ObjectId(values.user);

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
            reply.code(500).send({
                error: 'MongoDB Error: ' + err.message,
                code: 'InternalDatabaseError'
            });
            return false;
        }
        if (!userData) {
            reply.code(404).send({
                error: 'This user does not exist',
                code: 'UserNotFound'
            });
            return false;
        }

        return userData;
    };

    server.route({
        method: 'GET',
        url: '/users/:user/acl',
        schema: {
            summary: 'List ACL entries of all Mailboxes of a User',
            description: 'Lists every grant the user has given on their mailboxes.',
            tags: ['ACL']
        },
        config: {
            name: 'getUserAcl',
            validationObjs: {
                requestBody: {},
                pathParams: {
                    user: { $ref: 'wd:userId' }
                },
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetUserAclResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                results: {
                                    type: 'array',
                                    description: 'ACL entries of the mailboxes of this user',
                                    items: {
                                        type: 'object',
                                        title: 'GetUserAclResult',
                                        properties: {
                                            mailbox: { type: 'string', description: 'Mailbox ID' },
                                            path: { type: 'string', description: 'Mailbox path' },
                                            user: { type: 'string', description: 'Grantee user ID' },
                                            username: { type: 'string', description: 'Grantee username' },
                                            rights: { type: 'string', description: 'RFC 4314 rights characters' },
                                            subscribed: { type: 'boolean', description: 'Grantee subscription status for this mailbox' },
                                            created: { type: 'string', format: 'date-time', description: 'Time the entry was created' }
                                        },
                                        required: ['mailbox', 'path', 'user', 'username', 'rights', 'subscribed']
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
                req.validate(roles.can(req.role).readOwn('acl'));
            } else {
                req.validate(roles.can(req.role).readAny('acl'));
            }

            let userData = await loadUserData(reply, values);
            if (!userData) {
                return reply;
            }

            let grants;
            try {
                grants = await acl.asyncListOwnerGrants(userData._id);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return reply.send({
                success: true,
                results: grants.map(aclData => ({
                    mailbox: aclData.mailbox.toString(),
                    path: aclData.path,
                    user: aclData.user.toString(),
                    username: aclData.username,
                    rights: aclData.rights,
                    subscribed: aclData.subscribed,
                    created: aclData.created
                }))
            });
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/acl/shared',
        schema: {
            summary: 'List Mailboxes shared with a User',
            description: 'Lists every mailbox other users have granted to the user, with the rights held and the path in the shared namespace.',
            tags: ['ACL']
        },
        config: {
            name: 'getUserSharedMailboxes',
            validationObjs: {
                requestBody: {},
                pathParams: {
                    user: { $ref: 'wd:userId' }
                },
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetUserSharedMailboxesResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                results: {
                                    type: 'array',
                                    description: 'Mailboxes and accounts shared with this user',
                                    items: {
                                        type: 'object',
                                        title: 'GetUserSharedMailboxesResult',
                                        properties: {
                                            mailbox: { type: ['string', 'null'], description: 'Mailbox ID, or null for an account wide grant' },
                                            account: { type: 'boolean', description: 'True for an account wide grant covering every mailbox of the owner' },
                                            path: { type: 'string', description: 'Path in the shared namespace (the account node for an account wide grant)' },
                                            owner: { type: 'string', description: 'Owner user ID' },
                                            ownerName: { type: 'string', description: 'Owner username' },
                                            rights: { type: 'string', description: 'RFC 4314 rights characters held by the user' },
                                            subscribed: {
                                                type: 'boolean',
                                                description: 'Subscription status of the user for this mailbox, not set for an account wide grant'
                                            },
                                            created: { type: 'string', format: 'date-time', description: 'Time the entry was created' }
                                        },
                                        required: ['mailbox', 'path', 'owner', 'ownerName', 'rights']
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
                req.validate(roles.can(req.role).readOwn('acl'));
            } else {
                req.validate(roles.can(req.role).readAny('acl'));
            }

            let userData = await loadUserData(reply, values);
            if (!userData) {
                return reply;
            }

            let entries;
            let accountEntries;
            try {
                entries = await acl.asyncGetSharedEntries(userData._id);
                accountEntries = await acl.asyncGetGranteeAccountGrants(userData._id);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return reply.send({
                success: true,
                results: entries
                    .map(({ aclData, mailboxData, ownerData }) => ({
                        mailbox: mailboxData._id.toString(),
                        account: false,
                        path: acl.formatPath(acl.ownerNamespace(ownerData), ownerData.username, mailboxData.path),
                        owner: ownerData._id.toString(),
                        ownerName: ownerData.username,
                        rights: acl.normalizeRights(aclData.rights),
                        subscribed: aclData.subscribed !== false,
                        created: aclData.created
                    }))
                    .concat(
                        accountEntries.map(({ aclData, ownerData }) => ({
                            mailbox: null,
                            account: true,
                            path: acl.formatQuotaRoot(acl.ownerNamespace(ownerData), ownerData.username),
                            owner: ownerData._id.toString(),
                            ownerName: ownerData.username,
                            rights: acl.normalizeRights(aclData.rights),
                            created: aclData.created
                        }))
                    )
            });
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/mailboxes/:mailbox/acl',
        schema: {
            summary: 'List ACL entries of a Mailbox',
            description: 'Lists the users this mailbox is shared with and the rights each of them holds.',
            tags: ['ACL']
        },
        config: {
            name: 'getMailboxAcl',
            validationObjs: {
                requestBody: {},
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    mailbox: { $ref: 'wd:mailboxId' }
                },
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetMailboxAclResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                results: { type: 'array', description: 'ACL entries of this mailbox', items: mailboxAclResult }
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
                req.validate(roles.can(req.role).readOwn('acl'));
            } else {
                req.validate(roles.can(req.role).readAny('acl'));
            }

            let mailboxData = await loadMailboxData(reply, values);
            if (!mailboxData) {
                return reply;
            }

            let grants;
            try {
                grants = await acl.asyncListGrants(mailboxData._id);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return reply.send({
                success: true,
                results: grants.map(aclData => ({
                    user: aclData.user.toString(),
                    username: aclData.username,
                    rights: aclData.rights,
                    subscribed: aclData.subscribed,
                    created: aclData.created
                }))
            });
        }
    });

    server.route({
        method: 'PUT',
        url: '/users/:user/mailboxes/:mailbox/acl',
        schema: {
            summary: 'Set ACL entry for a Mailbox',
            description: 'Creates or updates the rights another user of this server holds for the mailbox. Rights are replaced, not merged.',
            tags: ['ACL']
        },
        config: {
            name: 'updateMailboxAcl',
            validationObjs: {
                requestBody: {
                    identifier: { type: 'string', minLength: 1, maxLength: 256, wdRequired: true, description: 'Username of the user the rights are granted to' },
                    rights: { ...rightsSchema, wdRequired: true }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    mailbox: { $ref: 'wd:mailboxId' }
                },
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'UpdateMailboxAclResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'Grantee user ID' }
                            },
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
                req.validate(roles.can(req.role).updateOwn('acl'));
            } else {
                req.validate(roles.can(req.role).updateAny('acl'));
            }

            let mailboxData = await loadMailboxData(reply, values);
            if (!mailboxData) {
                return reply;
            }

            let granteeData;
            try {
                granteeData = await acl.asyncResolveIdentifier(values.identifier, { grantee: true });
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!granteeData) {
                return reply.code(404).send({
                    error: 'This identifier does not exist',
                    code: 'UserNotFound'
                });
            }

            if (granteeData._id.toString() === mailboxData.user.toString()) {
                return reply.code(400).send({
                    error: 'Can not modify the rights of the mailbox owner',
                    code: 'InvalidGrantee'
                });
            }

            let sameTenant;
            try {
                sameTenant = await acl.asyncCheckTenantScope(mailboxData.user, granteeData);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!sameTenant) {
                // respond exactly like for an unknown identifier
                return reply.code(404).send({
                    error: 'This identifier does not exist',
                    code: 'UserNotFound'
                });
            }

            let rights;
            try {
                // effective rights, so narrowing a folder covered only by an account grant counts as a revocation
                let previousRights = await acl.asyncGetMailboxRights(mailboxData, granteeData._id);

                rights = acl.normalizeRights(values.rights);
                await acl.asyncSetGrant(mailboxData, granteeData, rights);

                if (notifier && previousRights.split('').some(right => rights.indexOf(right) < 0)) {
                    // rights were revoked: kick active sessions of the grantee from the mailbox
                    notifier.fire(granteeData._id, {
                        command: 'DROP',
                        mailbox: mailboxData._id
                    });
                }
            } catch (err) {
                if (err.code === 'AclLimitReached') {
                    return reply.code(400).send({
                        error: err.message,
                        code: err.code
                    });
                }
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            loggelf({
                short_message: '[ACLUPDATE] +',
                _mail_action: 'acl_update',
                _owner: mailboxData.user.toString(),
                _mailbox: mailboxData._id.toString(),
                _mailbox_path: mailboxData.path,
                _grantee: granteeData._id.toString(),
                _rights: rights,
                _sess: values.sess,
                _ip: values.ip,
                _source: 'api'
            });

            return reply.send({
                success: true,
                id: granteeData._id.toString()
            });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/mailboxes/:mailbox/acl/:grantee',
        schema: {
            summary: 'Delete ACL entry of a Mailbox',
            description: 'Removes all rights the grantee holds for this mailbox.',
            tags: ['ACL']
        },
        config: {
            name: 'deleteMailboxAcl',
            validationObjs: {
                requestBody: {},
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    mailbox: { $ref: 'wd:mailboxId' },
                    grantee: granteeId
                },
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'DeleteMailboxAclResponse',
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
                req.validate(roles.can(req.role).deleteOwn('acl'));
            } else {
                req.validate(roles.can(req.role).deleteAny('acl'));
            }

            let mailboxData = await loadMailboxData(reply, values);
            if (!mailboxData) {
                return reply;
            }

            let grantee = new ObjectId(values.grantee);

            let removed;
            try {
                removed = await acl.asyncDeleteGrant(mailboxData._id, grantee);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (removed.removed) {
                if (notifier) {
                    // kick active sessions of the grantee from the mailbox
                    notifier.fire(grantee, {
                        command: 'DROP',
                        mailbox: mailboxData._id
                    });
                }

                loggelf({
                    short_message: '[ACLUPDATE] -',
                    _mail_action: 'acl_delete',
                    _owner: mailboxData.user.toString(),
                    _mailbox: mailboxData._id.toString(),
                    _mailbox_path: mailboxData.path,
                    _grantee: grantee.toString(),
                    _sess: values.sess,
                    _ip: values.ip,
                    _source: 'api'
                });
            }

            return reply.send({
                success: true
            });
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/acl/account',
        schema: {
            summary: 'List account wide ACL entries',
            description:
                'Lists the account wide grants on this account. Each grant gives the grantee access to every mailbox of the account unless a mailbox grant narrows a specific folder.',
            tags: ['ACL']
        },
        config: {
            name: 'getAccountAcl',
            validationObjs: {
                requestBody: {},
                pathParams: {
                    user: { $ref: 'wd:userId' }
                },
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetAccountAclResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                results: {
                                    type: 'array',
                                    description: 'Account wide ACL entries of this account',
                                    items: {
                                        type: 'object',
                                        title: 'GetAccountAclResult',
                                        properties: {
                                            user: { type: 'string', description: 'Grantee user ID' },
                                            username: { type: 'string', description: 'Grantee username' },
                                            rights: { type: 'string', description: 'RFC 4314 rights characters' },
                                            created: { type: 'string', format: 'date-time', description: 'Time the entry was created' }
                                        },
                                        required: ['user', 'username', 'rights']
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
                req.validate(roles.can(req.role).readOwn('acl'));
            } else {
                req.validate(roles.can(req.role).readAny('acl'));
            }

            let userData = await loadUserData(reply, values);
            if (!userData) {
                return reply;
            }

            let grants;
            try {
                grants = await acl.asyncListAccountGrants(userData._id);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return reply.send({
                success: true,
                results: grants.map(aclData => ({
                    user: aclData.user.toString(),
                    username: aclData.username,
                    rights: aclData.rights,
                    created: aclData.created
                }))
            });
        }
    });

    server.route({
        method: 'PUT',
        url: '/users/:user/acl/account',
        schema: {
            summary: 'Set account wide ACL entry',
            description:
                'Creates or updates the account wide rights another user of this server holds for this account. This is how access to a shared (team) account, which can not log in to grant itself, is bootstrapped. Rights are replaced, not merged.',
            tags: ['ACL']
        },
        config: {
            name: 'updateAccountAcl',
            validationObjs: {
                requestBody: {
                    identifier: { type: 'string', minLength: 1, maxLength: 256, wdRequired: true, description: 'Username of the user the rights are granted to' },
                    rights: { ...rightsSchema, wdRequired: true }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' }
                },
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'UpdateAccountAclResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'Grantee user ID' }
                            },
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
                req.validate(roles.can(req.role).updateOwn('acl'));
            } else {
                req.validate(roles.can(req.role).updateAny('acl'));
            }

            let userData = await loadUserData(reply, values);
            if (!userData) {
                return reply;
            }

            let granteeData;
            try {
                granteeData = await acl.asyncResolveIdentifier(values.identifier, { grantee: true });
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!granteeData) {
                return reply.code(404).send({
                    error: 'This identifier does not exist',
                    code: 'UserNotFound'
                });
            }

            if (granteeData._id.toString() === userData._id.toString()) {
                return reply.code(400).send({
                    error: 'Can not modify the rights of the account owner',
                    code: 'InvalidGrantee'
                });
            }

            let sameTenant;
            try {
                sameTenant = await acl.asyncCheckTenantScope(userData._id, granteeData);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!sameTenant) {
                // respond exactly like for an unknown identifier
                return reply.code(404).send({
                    error: 'This identifier does not exist',
                    code: 'UserNotFound'
                });
            }

            let rights;
            try {
                let aclData = await acl.asyncGetAccountGrant(userData._id, granteeData._id);
                let previousRights = acl.normalizeRights((aclData && aclData.rights) || '');

                rights = acl.normalizeRights(values.rights);
                await acl.asyncSetAccountGrant({ _id: userData._id }, granteeData, rights);

                if (notifier && previousRights.split('').some(right => rights.indexOf(right) < 0)) {
                    // account wide rights were revoked: kick the grantee from every mailbox of the owner
                    let mailboxIds = await acl.asyncGetOwnerMailboxIds(userData._id);
                    for (let mailboxId of mailboxIds) {
                        notifier.fire(granteeData._id, {
                            command: 'DROP',
                            mailbox: mailboxId
                        });
                    }
                }
            } catch (err) {
                if (err.code === 'AclLimitReached') {
                    return reply.code(400).send({
                        error: err.message,
                        code: err.code
                    });
                }
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            loggelf({
                short_message: '[ACLUPDATE] +',
                _mail_action: 'acl_update',
                _acl_scope: 'account',
                _owner: userData._id.toString(),
                _grantee: granteeData._id.toString(),
                _rights: rights,
                _sess: values.sess,
                _ip: values.ip,
                _source: 'api'
            });

            return reply.send({
                success: true,
                id: granteeData._id.toString()
            });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/acl/account/:grantee',
        schema: {
            summary: 'Delete account wide ACL entry',
            description: 'Removes the account wide rights the grantee holds for this account. Mailbox grants of the grantee are not affected.',
            tags: ['ACL']
        },
        config: {
            name: 'deleteAccountAcl',
            validationObjs: {
                requestBody: {},
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    grantee: granteeId
                },
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'DeleteAccountAclResponse',
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
                req.validate(roles.can(req.role).deleteOwn('acl'));
            } else {
                req.validate(roles.can(req.role).deleteAny('acl'));
            }

            let userData = await loadUserData(reply, values);
            if (!userData) {
                return reply;
            }

            let grantee = new ObjectId(values.grantee);

            let removed;
            try {
                removed = await acl.asyncDeleteAccountGrant(userData._id, grantee);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (removed.removed) {
                if (notifier) {
                    let mailboxIds = await acl.asyncGetOwnerMailboxIds(userData._id);
                    for (let mailboxId of mailboxIds) {
                        notifier.fire(grantee, {
                            command: 'DROP',
                            mailbox: mailboxId
                        });
                    }
                }

                loggelf({
                    short_message: '[ACLUPDATE] -',
                    _mail_action: 'acl_delete',
                    _acl_scope: 'account',
                    _owner: userData._id.toString(),
                    _grantee: grantee.toString(),
                    _sess: values.sess,
                    _ip: values.ip,
                    _source: 'api'
                });
            }

            return reply.send({
                success: true
            });
        }
    });
};
