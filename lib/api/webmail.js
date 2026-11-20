'use strict';

// REST resources for data a webmail client keeps in WildDuck that is neither mail nor JMAP data:
// preferences, senders allowed to load remote content, recent searches and avatars (see lib/webmail/).
// Documents live in webmail.* collections and are removed with the user (lib/jmap/account-data.js).

const ObjectId = require('mongodb').ObjectId;
const roles = require('../roles');
const { WebmailPreferences, PREFERENCES } = require('../webmail/preferences');
const { WebmailSenders, WebmailSearches } = require('../webmail/lists');
const { WebmailAvatars, AVATAR_KEY, AVATAR_TYPES } = require('../webmail/avatars');
const { objectIdSchema } = require('../schemas/json-schemas');

const preferencesModel = {
    type: 'object',
    additionalProperties: true,
    description: `Stored preferences. Only these keys exist: ${Object.keys(PREFERENCES).join(', ')}`
};

const preferencesResponse = title => ({
    200: {
        description: 'Success',
        model: {
            type: 'object',
            title,
            properties: {
                success: { $ref: 'wd:successRes' },
                preferences: preferencesModel,
                version: { type: 'number', description: 'Schema version of the preferences' },
                // null until the first write, so the field stays typeless
                updated: { description: 'Time of the last change, or null' }
            },
            required: ['success', 'preferences', 'version']
        }
    }
});

module.exports = (db, server) => {
    const preferences = new WebmailPreferences(db);

    server.route({
        method: 'GET',
        url: '/users/:user/webmail/preferences',
        schema: {
            summary: 'Get webmail preferences',
            description: 'Returns the preferences a webmail client stored for the user. Keys that were never set are left out.',
            tags: ['Webmail']
        },
        config: {
            name: 'getWebmailPreferences',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: preferencesResponse('GetWebmailPreferencesResponse')
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).readOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).readAny('webmaildata'));
            }
            const result = await preferences.get(new ObjectId(req.params.user));
            return reply.send({ success: true, ...result });
        }
    });

    server.route({
        method: 'PUT',
        url: '/users/:user/webmail/preferences',
        schema: {
            summary: 'Update webmail preferences',
            description:
                'Merges the given keys into the stored preferences. A key set to null is removed, so the client default applies. Unknown keys and values of the wrong type are refused.',
            tags: ['Webmail']
        },
        config: {
            name: 'updateWebmailPreferences',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: {},
                requestBody: {
                    preferences: Object.assign({ wdRequired: true }, preferencesModel),
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: preferencesResponse('UpdateWebmailPreferencesResponse')
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).updateOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).updateAny('webmaildata'));
            }
            const result = await preferences.update(new ObjectId(req.params.user), req.params.preferences);
            return reply.send({ success: true, ...result });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/webmail/preferences',
        schema: {
            summary: 'Reset webmail preferences',
            description: 'Removes every stored preference of the user.',
            tags: ['Webmail']
        },
        config: {
            name: 'resetWebmailPreferences',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'ResetWebmailPreferencesResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                deleted: { type: 'boolean', description: 'Whether stored preferences existed' }
                            },
                            required: ['success', 'deleted']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).deleteOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).deleteAny('webmaildata'));
            }
            const deleted = await preferences.reset(new ObjectId(req.params.user));
            return reply.send({ success: true, deleted });
        }
    });

    const senders = new WebmailSenders(db);
    const searches = new WebmailSearches(db);

    const senderModel = {
        type: 'object',
        title: 'WebmailSender',
        properties: {
            id: { type: 'string', description: 'ID of the entry' },
            address: { type: 'string', description: 'Sender address, lowercase' },
            created: { type: 'string', format: 'date-time', description: 'When the sender was added' }
        },
        required: ['id', 'address', 'created']
    };

    const searchModel = {
        type: 'object',
        title: 'WebmailSearch',
        properties: {
            id: { type: 'string', description: 'ID of the entry' },
            query: { type: 'string', description: 'The search as the user typed it' },
            used: { type: 'string', format: 'date-time', description: 'When the search was last run' }
        },
        required: ['id', 'query', 'used']
    };

    const listResponse = (title, item) => ({
        200: {
            description: 'Success',
            model: {
                type: 'object',
                title,
                properties: { success: { $ref: 'wd:successRes' }, results: { type: 'array', items: item } },
                required: ['success', 'results']
            }
        }
    });

    const entryResponse = (title, item) => ({
        200: {
            description: 'Success',
            model: {
                type: 'object',
                title,
                properties: { success: { $ref: 'wd:successRes' }, ...item.properties },
                required: ['success', ...item.required]
            }
        }
    });

    const deletedResponse = title => ({
        200: {
            description: 'Success',
            model: {
                type: 'object',
                title,
                properties: { success: { $ref: 'wd:successRes' }, deleted: { type: 'boolean', description: 'Whether the entry existed' } },
                required: ['success', 'deleted']
            }
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/webmail/senders',
        schema: {
            summary: 'List senders allowed to load remote content',
            description: 'Senders whose messages may load remote images and other remote content in a webmail client.',
            tags: ['Webmail']
        },
        config: {
            name: 'getWebmailSenders',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: listResponse('GetWebmailSendersResponse', senderModel)
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).readOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).readAny('webmaildata'));
            }
            return reply.send({ success: true, results: await senders.list(new ObjectId(req.params.user)) });
        }
    });

    server.route({
        method: 'POST',
        url: '/users/:user/webmail/senders',
        schema: {
            summary: 'Allow remote content from a sender',
            description: 'Adds a sender address to the list. Adding an address that is listed already changes nothing.',
            tags: ['Webmail']
        },
        config: {
            name: 'addWebmailSender',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: {},
                requestBody: {
                    address: { type: 'string', minLength: 3, maxLength: 254, wdRequired: true, description: 'Sender address' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: entryResponse('AddWebmailSenderResponse', senderModel)
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).createOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).createAny('webmaildata'));
            }
            const entry = await senders.add(new ObjectId(req.params.user), req.params.address);
            return reply.send({ success: true, ...entry });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/webmail/senders/:address',
        schema: {
            summary: 'Stop allowing remote content from a sender',
            description: 'Removes a sender address from the list.',
            tags: ['Webmail']
        },
        config: {
            name: 'deleteWebmailSender',
            validationObjs: {
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    address: { type: 'string', minLength: 3, maxLength: 254, wdRequired: true, description: 'Sender address' }
                },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: deletedResponse('DeleteWebmailSenderResponse')
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).deleteOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).deleteAny('webmaildata'));
            }
            const deleted = await senders.remove(new ObjectId(req.params.user), req.params.address);
            return reply.send({ success: true, deleted });
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/webmail/searches',
        schema: {
            summary: 'List recent searches',
            description: 'The most recent searches of the user, newest first.',
            tags: ['Webmail']
        },
        config: {
            name: 'getWebmailSearches',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: listResponse('GetWebmailSearchesResponse', searchModel)
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).readOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).readAny('webmaildata'));
            }
            return reply.send({ success: true, results: await searches.list(new ObjectId(req.params.user)) });
        }
    });

    server.route({
        method: 'POST',
        url: '/users/:user/webmail/searches',
        schema: {
            summary: 'Remember a search',
            description: 'Adds a search to the recent list, or moves it to the top. Only the newest few are kept.',
            tags: ['Webmail']
        },
        config: {
            name: 'addWebmailSearch',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: {},
                requestBody: {
                    query: { type: 'string', minLength: 1, maxLength: 512, wdRequired: true, description: 'The search as typed' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: entryResponse('AddWebmailSearchResponse', searchModel)
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).createOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).createAny('webmaildata'));
            }
            const entry = await searches.add(new ObjectId(req.params.user), req.params.query);
            return reply.send({ success: true, ...entry });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/webmail/searches/:search',
        schema: {
            summary: 'Forget a recent search',
            description: 'Removes one search from the recent list.',
            tags: ['Webmail']
        },
        config: {
            name: 'deleteWebmailSearch',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' }, search: objectIdSchema('ID of the search', { wdRequired: true }) },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: deletedResponse('DeleteWebmailSearchResponse')
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).deleteOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).deleteAny('webmaildata'));
            }
            const deleted = await searches.remove(new ObjectId(req.params.user), new ObjectId(req.params.search));
            return reply.send({ success: true, deleted });
        }
    });

    const avatars = new WebmailAvatars(db);
    const avatarKey = { type: 'string', pattern: AVATAR_KEY.source, wdRequired: true, description: '"self" or "group:<id>"' };

    server.route({
        method: 'GET',
        url: '/users/:user/webmail/avatars/:key',
        schema: {
            summary: 'Get an avatar',
            description: 'Returns the stored picture as an image, or 404 when there is none (the client then shows initials).',
            tags: ['Webmail']
        },
        config: {
            name: 'getWebmailAvatar',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' }, key: avatarKey },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: {
                    200: { description: 'The image (PNG, JPEG, WebP or GIF)', model: { type: 'string', format: 'binary' } }
                }
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).readOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).readAny('webmaildata'));
            }
            const avatar = await avatars.get(new ObjectId(req.params.user), req.params.key);
            if (!avatar) {
                return reply.code(404).send({ error: 'No avatar', code: 'AvatarNotFound' });
            }
            return reply
                .header('Content-Type', avatar.contentType)
                .header('Last-Modified', avatar.updated.toUTCString())
                .header('X-Content-Type-Options', 'nosniff')
                .send(avatar.data);
        }
    });

    server.route({
        method: 'PUT',
        url: '/users/:user/webmail/avatars/:key',
        schema: {
            summary: 'Set an avatar',
            description: 'Stores a picture of at most 256 kB. The bytes must match the content type.',
            tags: ['Webmail']
        },
        config: {
            name: 'setWebmailAvatar',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' }, key: avatarKey },
                queryParams: {},
                requestBody: {
                    contentType: {
                        type: 'string',
                        enum: AVATAR_TYPES,
                        wdRequired: true,
                        description: 'Type of the image'
                    },
                    content: { type: 'string', maxLength: 400000, wdRequired: true, description: 'The image, base64 encoded' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SetWebmailAvatarResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                contentType: { type: 'string', description: 'Type of the image' },
                                size: { type: 'number', description: 'Size in bytes' },
                                updated: { type: 'string', format: 'date-time', description: 'Time of the change' }
                            },
                            required: ['success', 'contentType', 'size', 'updated']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).updateOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).updateAny('webmaildata'));
            }
            const result = await avatars.set(new ObjectId(req.params.user), req.params.key, req.params.contentType, req.params.content);
            return reply.send({ success: true, contentType: result.contentType, size: result.size, updated: result.updated.toISOString() });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/webmail/avatars/:key',
        schema: {
            summary: 'Remove an avatar',
            description: 'Removes the picture; the client shows initials again.',
            tags: ['Webmail']
        },
        config: {
            name: 'deleteWebmailAvatar',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' }, key: avatarKey },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: deletedResponse('DeleteWebmailAvatarResponse')
            }
        },
        async handler(req, reply) {
            if (req.user && req.user === req.params.user) {
                req.validate(roles.can(req.role).deleteOwn('webmaildata'));
            } else {
                req.validate(roles.can(req.role).deleteAny('webmaildata'));
            }
            const deleted = await avatars.remove(new ObjectId(req.params.user), req.params.key);
            return reply.send({ success: true, deleted });
        }
    });
};
