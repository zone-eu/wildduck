/*eslint no-unused-expressions: 0 */

'use strict';

const chai = require('chai');
const ObjectId = require('mongodb').ObjectId;
const roles = require('../lib/roles');
const mcpTokenRoutes = require('../lib/api/mcp-tokens');
const { compileRouteValidator } = require('../lib/fastify/validation');
const { MCP_TOKEN_ROLES } = require('../lib/mcp-token-handler');
require('../lib/schemas/json-schemas');

const expect = chai.expect;

function getCreateRoute(mcpTokenHandler) {
    const routes = [];
    mcpTokenRoutes(
        {
            route(options) {
                routes.push({
                    spec: { path: options.url, name: options.config.name, validationObjs: options.config.validationObjs },
                    handler: options.handler
                });
            }
        },
        mcpTokenHandler
    );
    return routes.find(route => route.spec.name === 'createMcpToken');
}

function getReply() {
    return {
        statusCode: 200,
        body: null,
        code(statusCode) {
            this.statusCode = statusCode;
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        }
    };
}

function getRequest(route, { user, target = user, role, body = {} }) {
    const params = { user: target.toString(), ...body };
    const result = compileRouteValidator(route.spec.validationObjs)(params);
    expect(result.error, JSON.stringify(result.error)).to.not.exist;
    return {
        params: result.value,
        user: user && user.toString(),
        role,
        validate(permission) {
            if (!permission.granted) {
                const error = new Error('Not enough privileges');
                error.code = 'MissingPrivileges';
                error.responseCode = 403;
                throw error;
            }
        }
    };
}

function expectDenied({ created, reply, error }) {
    expect(error ? error.responseCode : reply.statusCode).to.equal(403);
    expect(error ? error.code : reply.body.code).to.equal('MissingPrivileges');
    expect(created).to.have.length(0);
}

describe('MCP token routes', () => {
    let owner;
    let other;

    beforeEach(() => {
        owner = new ObjectId();
        other = new ObjectId();
    });

    async function attemptCreate({ actor = owner, target = actor, role = 'root', body = {} }) {
        const created = [];
        const route = getCreateRoute({
            async create(userId, values) {
                created.push({ userId: userId.toString(), values });
                return { id: 'token-id', role: values.role };
            }
        });
        const req = getRequest(route, {
            user: actor,
            target,
            role,
            body: { description: 'test token', ...body }
        });
        const reply = getReply();
        let error;
        try {
            await route.handler(req, reply);
        } catch (err) {
            error = err;
        }
        return { created, reply, error };
    }

    it('allows own-account creation of every supported level with createOwn permission', async () => {
        for (const role of ['user', 'manager', 'root', 'webmail']) {
            for (const tokenRole of MCP_TOKEN_ROLES) {
                const result = await attemptCreate({ role, body: { role: tokenRole } });
                expect(result.error).to.not.exist;
                expect(result.reply.body.success).to.equal(true);
                expect(result.created).to.have.length(1);
                expect(result.created[0].userId).to.equal(owner.toString());
                expect(result.created[0].values.role).to.equal(tokenRole);
            }
        }
    });

    it('allows manager foreign-account read tokens, including the default role', async () => {
        const explicit = await attemptCreate({ actor: owner, target: other, role: 'manager', body: { role: 'mcp:read' } });
        expect(explicit.error).to.not.exist;
        expect(explicit.created[0].values.role).to.equal('mcp:read');

        const defaulted = await attemptCreate({ actor: owner, target: other, role: 'manager' });
        expect(defaulted.error).to.not.exist;
        expect(defaulted.created[0].values.role).to.equal('mcp:read');
        expect(defaulted.created[0].userId).to.equal(other.toString());
    });

    it('denies managers foreign-account write roles before creating a token', async () => {
        for (const tokenRole of [...MCP_TOKEN_ROLES].filter(role => role !== 'mcp:read')) {
            const result = await attemptCreate({ actor: owner, target: other, role: 'manager', body: { role: tokenRole } });
            expectDenied(result);
        }
    });

    it('requires createAny for a foreign account even when the requested role is read-only', async () => {
        const result = await attemptCreate({ actor: owner, target: other, role: 'user', body: { role: 'mcp:read' } });
        expectDenied(result);
    });

    it('does not let an MCP credential mint an own-account token', async () => {
        const result = await attemptCreate({ role: 'mcp:write' });
        expectDenied(result);
    });

    it('denies foreign non-read tokens uniformly to root and webmail', async () => {
        for (const role of ['root', 'webmail']) {
            const result = await attemptCreate({ actor: owner, target: other, role, body: { role: 'mcp:write' } });
            expectDenied(result);
        }
    });

    it('uses the real role grants for own and any MCP token creation', () => {
        expect(roles.can('user').createOwn('mcptokens').granted).to.equal(true);
        expect(roles.can('user').createAny('mcptokens').granted).to.equal(false);
        expect(roles.can('manager').createAny('mcptokens').granted).to.equal(true);
    });
});
