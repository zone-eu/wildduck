'use strict';

// REST resources for data a webmail client keeps in WildDuck that is neither mail nor JMAP data:
// preferences now, more resources follow (see lib/webmail/). Documents live in webmail.*
// collections and are removed with the user (lib/webmail/account-data.js).

const ObjectId = require('mongodb').ObjectId;
const roles = require('../roles');
const { WebmailPreferences, PREFERENCES } = require('../webmail/preferences');

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
};
