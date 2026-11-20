'use strict';

// OAuth clients and grants for a webmail's authorisation server (see lib/webmail/oauth.js). Clients
// are reachable only with a token whose role may manage them (root and webmail); grants follow the
// usual own/any rules of webmail data.

const ObjectId = require('mongodb').ObjectId;
const roles = require('../roles');
const { WebmailOauthClients, WebmailOauthGrants, MAX_REDIRECT_URIS } = require('../webmail/oauth');

const hashSchema = description => ({ type: 'string', pattern: '^[a-f0-9]{64}$', description });
const idSchema = description => ({ type: 'string', pattern: '^[0-9a-f]{24}$', description });

const clientModel = {
    type: 'object',
    title: 'WebmailOauthClient',
    properties: {
        id: { type: 'string', description: 'Client ID' },
        name: { type: 'string', description: 'Name the client registered with' },
        redirectUris: { type: 'array', items: { type: 'string' }, description: 'Allowed redirect URIs' },
        created: { type: 'string', format: 'date-time', description: 'When the client registered' }
    },
    required: ['id', 'name', 'redirectUris', 'created']
};

const grantModel = {
    type: 'object',
    title: 'WebmailOauthGrant',
    properties: {
        id: { type: 'string', description: 'Grant ID' },
        client: { type: 'string', description: 'Client ID' },
        clientName: { type: 'string', description: 'Name of the client when the grant was made' },
        scope: { type: 'string', description: 'Granted scope' },
        mcpToken: { type: 'string', description: 'ID of the MCP token the grant issued' },
        created: { type: 'string', format: 'date-time', description: 'When the user approved the client' },
        updated: { type: 'string', format: 'date-time', description: 'When the tokens were last issued' },
        expires: { type: 'string', format: 'date-time', description: 'When the grant ends' }
    },
    required: ['id', 'client', 'clientName', 'scope', 'mcpToken', 'created', 'updated', 'expires']
};

const response = (title, properties, required) => ({
    200: {
        description: 'Success',
        model: { type: 'object', title, properties: { success: { $ref: 'wd:successRes' }, ...properties }, required: ['success', ...required] }
    }
});

const entryResponse = (title, model) => response(title, model.properties, model.required);
const deletedResponse = title => response(title, { deleted: { type: 'boolean', description: 'Whether the entry existed' } }, ['deleted']);

const tokenFields = {
    mcpToken: { ...idSchema('ID of the MCP token issued for the grant'), wdRequired: true },
    refreshHash: { ...hashSchema('SHA-256 of the refresh token, hex'), wdRequired: true },
    accessHash: { ...hashSchema('SHA-256 of the access token, hex'), wdRequired: true }
};

module.exports = (db, server, mcpTokenHandler) => {
    const clients = new WebmailOauthClients(db);
    const grants = new WebmailOauthGrants(db, { clients, mcpTokenHandler });

    const checkGrants = (req, action) => {
        const own = req.user && req.user === req.params.user;
        req.validate(roles.can(req.role)[`${action}${own ? 'Own' : 'Any'}`]('webmaildata'));
    };

    // --- clients ---

    server.route({
        method: 'POST',
        url: '/webmail/oauth/clients',
        schema: {
            summary: 'Register an OAuth client',
            description:
                'Registers a public OAuth client (RFC 7591, as relayed by the webmail). Redirect URIs must be https, or http on localhost. A client that never gets a grant is removed after a week.',
            tags: ['Webmail']
        },
        config: {
            name: 'createWebmailOauthClient',
            validationObjs: {
                pathParams: {},
                queryParams: {},
                requestBody: {
                    name: { type: 'string', minLength: 1, maxLength: 128, wdRequired: true, description: 'Client name shown to users' },
                    redirectUris: {
                        type: 'array',
                        minItems: 1,
                        maxItems: MAX_REDIRECT_URIS,
                        items: { type: 'string', maxLength: 512 },
                        wdRequired: true,
                        description: 'Redirect URIs'
                    },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: entryResponse('CreateWebmailOauthClientResponse', clientModel)
            }
        },
        async handler(req, reply) {
            req.validate(roles.can(req.role).createAny('webmailoauth'));
            const client = await clients.create({ name: req.params.name, redirectUris: req.params.redirectUris });
            return reply.send({ success: true, ...client });
        }
    });

    server.route({
        method: 'GET',
        url: '/webmail/oauth/clients/:client',
        schema: {
            summary: 'Get an OAuth client',
            description: 'Returns a registered client: its name and allowed redirect URIs.',
            tags: ['Webmail']
        },
        config: {
            name: 'getWebmailOauthClient',
            validationObjs: {
                pathParams: { client: { ...idSchema('Client ID'), wdRequired: true } },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: entryResponse('GetWebmailOauthClientResponse', clientModel)
            }
        },
        async handler(req, reply) {
            req.validate(roles.can(req.role).readAny('webmailoauth'));
            const client = await clients.get(req.params.client);
            if (!client) {
                return reply.code(404).send({ error: 'No such client', code: 'ClientNotFound' });
            }
            return reply.send({ success: true, ...client });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/webmail/oauth/clients/:client',
        schema: { summary: 'Remove an OAuth client', description: 'Grants already made stay until revoked.', tags: ['Webmail'] },
        config: {
            name: 'deleteWebmailOauthClient',
            validationObjs: {
                pathParams: { client: { ...idSchema('Client ID'), wdRequired: true } },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: deletedResponse('DeleteWebmailOauthClientResponse')
            }
        },
        async handler(req, reply) {
            req.validate(roles.can(req.role).deleteAny('webmailoauth'));
            return reply.send({ success: true, deleted: await clients.remove(req.params.client) });
        }
    });

    // --- grants ---

    server.route({
        method: 'GET',
        url: '/users/:user/webmail/oauth/grants',
        schema: {
            summary: 'List OAuth grants',
            description: "The user's connected OAuth clients. With a token hash, only the grant holding that token.",
            tags: ['Webmail']
        },
        config: {
            name: 'getWebmailOauthGrants',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: {
                    refreshHash: hashSchema('SHA-256 of a refresh token, hex'),
                    accessHash: hashSchema('SHA-256 of an access token, hex'),
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                requestBody: {},
                response: response('GetWebmailOauthGrantsResponse', { results: { type: 'array', items: grantModel } }, ['results'])
            }
        },
        async handler(req, reply) {
            checkGrants(req, 'read');
            const results = await grants.list(new ObjectId(req.params.user), {
                refreshHash: req.params.refreshHash,
                accessHash: req.params.accessHash
            });
            return reply.send({ success: true, results });
        }
    });

    server.route({
        method: 'POST',
        url: '/users/:user/webmail/oauth/grants',
        schema: {
            summary: 'Store an OAuth grant',
            description: 'Records a client the user approved, with the MCP token it issued and hashes of its tokens.',
            tags: ['Webmail']
        },
        config: {
            name: 'createWebmailOauthGrant',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' } },
                queryParams: {},
                requestBody: {
                    client: { ...idSchema('Client ID'), wdRequired: true },
                    scope: { type: 'string', minLength: 1, maxLength: 256, wdRequired: true, description: 'Granted scope' },
                    expires: { type: 'string', format: 'date-time', wdRequired: true, description: 'When the grant ends' },
                    ...tokenFields,
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                response: entryResponse('CreateWebmailOauthGrantResponse', grantModel)
            }
        },
        async handler(req, reply) {
            checkGrants(req, 'create');
            const grant = await grants.create(new ObjectId(req.params.user), req.params);
            return reply.send({ success: true, ...grant });
        }
    });

    server.route({
        method: 'PUT',
        url: '/users/:user/webmail/oauth/grants/:grant',
        schema: {
            summary: 'Rotate the tokens of an OAuth grant',
            description: 'Stores the new MCP token and token hashes of a refresh and revokes the previous MCP token.',
            tags: ['Webmail']
        },
        config: {
            name: 'rotateWebmailOauthGrant',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' }, grant: { ...idSchema('Grant ID'), wdRequired: true } },
                queryParams: {},
                requestBody: { ...tokenFields, sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                response: entryResponse('RotateWebmailOauthGrantResponse', grantModel)
            }
        },
        async handler(req, reply) {
            checkGrants(req, 'update');
            const grant = await grants.rotate(new ObjectId(req.params.user), req.params.grant, req.params);
            if (!grant) {
                return reply.code(404).send({ error: 'No such grant', code: 'GrantNotFound' });
            }
            return reply.send({ success: true, ...grant });
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/webmail/oauth/grants/:grant',
        schema: {
            summary: 'Disconnect an OAuth client',
            description: 'Removes the grant and revokes the MCP token it issued.',
            tags: ['Webmail']
        },
        config: {
            name: 'deleteWebmailOauthGrant',
            validationObjs: {
                pathParams: { user: { $ref: 'wd:userId' }, grant: { ...idSchema('Grant ID'), wdRequired: true } },
                queryParams: { sess: { $ref: 'wd:sess' }, ip: { $ref: 'wd:ip' } },
                requestBody: {},
                response: deletedResponse('DeleteWebmailOauthGrantResponse')
            }
        },
        async handler(req, reply) {
            checkGrants(req, 'delete');
            return reply.send({ success: true, deleted: await grants.remove(new ObjectId(req.params.user), req.params.grant) });
        }
    });
};
