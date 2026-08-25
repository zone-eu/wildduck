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
    pattern: '^[lrswipkxteacdLRSWIPKXTEACD]+$',
    description: 'RFC 4314 rights characters granted to the user'
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

module.exports = (db, server) => {
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
                granteeData = await acl.asyncResolveIdentifier(values.identifier);
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

            try {
                await acl.asyncSetGrant(mailboxData, granteeData, values.rights);
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

            try {
                await acl.asyncDeleteGrant(mailboxData._id, new ObjectId(values.grantee));
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return reply.send({
                success: true
            });
        }
    });
};
