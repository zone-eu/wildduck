'use strict';

const chai = require('chai');
const { ObjectId } = require('mongodb');
const McpTokenHandler = require('../lib/mcp-token-handler');
const consts = require('../lib/consts');
const roles = require('../lib/roles');

const expect = chai.expect;

function matchesId(left, right) {
    return left && right && left.toString() === right.toString();
}

class TokenCollection {
    constructor() {
        this.entries = [];
        this.updates = [];
    }

    async insertOne(entry) {
        let _id = new ObjectId();
        this.entries.push({ ...entry, _id });
        return { insertedId: _id };
    }

    async findOne(query) {
        return this.entries.find(entry => (!query.hash || entry.hash === query.hash) && (!query._id || matchesId(entry._id, query._id))) || null;
    }

    async countDocuments(query) {
        return this.entries.filter(entry => matchesId(entry.user, query.user)).length;
    }

    find(query, options) {
        let values = this.entries.filter(entry => matchesId(entry.user, query.user));
        return {
            sort() {
                return this;
            },
            async toArray() {
                return values.map(entry => {
                    let value = { ...entry };
                    if (options && options.projection && options.projection.hash === false) delete value.hash;
                    return value;
                });
            }
        };
    }

    async findOneAndDelete(query) {
        let index = this.entries.findIndex(entry => matchesId(entry._id, query._id) && matchesId(entry.user, query.user));
        if (index < 0) return { value: null };
        let [value] = this.entries.splice(index, 1);
        return { value };
    }

    async updateOne(query, update) {
        this.updates.push({ query, update });
        let entry = this.entries.find(candidate => matchesId(candidate._id, query._id));
        if (!entry) return { modifiedCount: 0 };
        let threshold = query.$or && query.$or[1] && query.$or[1].used && query.$or[1].used.$lte;
        if (!entry.used || (threshold && entry.used <= threshold)) {
            Object.assign(entry, update.$set);
            return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
    }
}

function createFixture(options = {}) {
    let user = {
        _id: new ObjectId(),
        username: 'alice',
        unameview: 'alice',
        address: 'alice@example.com',
        authVersion: 4,
        ...options.user
    };
    let tokens = new TokenCollection();
    let address = { addrview: 'alice@example.com', user: user._id };
    let usersCollection = {
        async findOne(query) {
            if (query._id && matchesId(query._id, user._id)) return user;
            if (query.unameview === user.unameview) return user;
            return null;
        }
    };
    let addressesCollection = {
        async findOne(query) {
            return query.addrview === address.addrview ? address : null;
        }
    };
    let database = {
        collection(name) {
            if (name === 'mcptokens') return tokens;
            if (name === 'users') return usersCollection;
            if (name === 'addresses') return addressesCollection;
            throw new Error(`Unexpected collection ${name}`);
        }
    };
    let authlog = [];
    // Stands in for UserHandler.checkAddress: a username maps to unameview, an address goes
    // through address resolution. The handler must work through this seam, not around it.
    let userHandler = {
        async checkAddress(value) {
            if (!value.includes('@')) {
                return { unameview: value.toLowerCase() };
            }
            return address.addrview === value ? { _id: address.user } : false;
        }
    };
    let handler = new McpTokenHandler({
        users: database,
        userHandler,
        counters: options.counters,
        logSuccessfulAuth: options.logSuccessfulAuth,
        logAuthEvent: async (user, entry) => {
            authlog.push({ user: user && user.toString(), ...entry });
            return true;
        }
    });

    return { user, tokens, database, authlog, handler };
}

async function expectCode(promise, code) {
    let thrown;
    try {
        await promise;
    } catch (err) {
        thrown = err;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect(thrown.code).to.equal(code);
    return thrown;
}

describe('MCP token handler', () => {
    it('uses the application-password management policy without granting management to mcp:read', () => {
        expect(roles.can('root').createAny('mcptokens').granted).to.equal(true);
        expect(roles.can('manager').readAny('mcptokens').granted).to.equal(true);
        expect(roles.can('webmail').deleteAny('mcptokens').granted).to.equal(true);
        expect(roles.can('user').createOwn('mcptokens').granted).to.equal(true);
        expect(roles.can('mcp:read').readOwn('mcptokens').granted).to.equal(false);
        expect(roles.can('mcp:read').createOwn('messages').granted).to.equal(false);
        expect(roles.can('mcp:read').updateOwn('messages').granted).to.equal(false);
        expect(roles.can('mcp:read').deleteOwn('messages').granted).to.equal(false);
    });

    it('creates a dedicated token once and stores only its SHA-256 hash', async () => {
        let fixture = createFixture();
        let created = await fixture.handler.create(fixture.user._id, { description: 'Codex' });

        expect(created.token).to.match(/^wdmcp_\d[a-f0-9]{72}$/);
        expect(created.expires).to.equal(undefined);
        expect(created.role).to.equal('mcp:read');
        expect(created.audience).to.equal('mcp');
        expect(fixture.tokens.entries).to.have.length(1);
        expect(fixture.tokens.entries[0]).not.to.have.property('token');
        expect(fixture.tokens.entries[0].hash).to.equal(McpTokenHandler.hashToken(created.token));
        expect(fixture.tokens.entries[0].hash).not.to.include(created.token);
        expect(fixture.tokens.entries[0].authVersion).to.equal(4);

        let listed = await fixture.handler.list(fixture.user._id);
        expect(listed).to.have.length(1);
        expect(listed[0]).to.include({ id: created.id, description: 'Codex', role: 'mcp:read', audience: 'mcp' });
        expect(listed[0]).not.to.have.any.keys('hash', 'token', 'user', 'authVersion');
    });

    it('requires a description and accepts only future fixed expirations', async () => {
        let fixture = createFixture();
        await expectCode(fixture.handler.create(fixture.user._id, { description: '   ' }), 'InputValidationError');
        await expectCode(fixture.handler.create(fixture.user._id, { description: 'Expired', expires: new Date(Date.now() - 1000) }), 'InputValidationError');

        let expires = new Date(Date.now() + 60 * 1000);
        let created = await fixture.handler.create(fixture.user._id, { description: 'Temporary', expires });
        expect(created.expires.getTime()).to.equal(expires.getTime());
        expect(fixture.tokens.entries[0].expires.getTime()).to.equal(expires.getTime());
    });

    it('reloads the token and user on every authentication and rate-limits last-use writes in MongoDB', async () => {
        let fixture = createFixture();
        let created = await fixture.handler.create(fixture.user._id, { description: 'Client' });
        let first = await fixture.handler.authenticate(created.token);
        let second = await fixture.handler.authenticate(created.token);

        expect(first.user).to.equal(fixture.user);
        expect(second.tokenId.toString()).to.equal(created.id);
        expect(fixture.tokens.entries[0].used).to.be.instanceOf(Date);

        // A token in constant use costs one write, not one per request: the interval is
        // checked against the value the lookup already returned, so the second authentication
        // sends no write command at all rather than one that matches nothing.
        expect(fixture.tokens.updates).to.have.length(1);
        // the query keeps the same condition, because two hops can reach this at once
        expect(fixture.tokens.updates[0].query.$or).to.be.an('array').with.length(2);

        // and once the stored value is old enough, the write is issued again
        fixture.tokens.entries[0].used = new Date(Date.now() - 2 * McpTokenHandler.LAST_USE_UPDATE_INTERVAL);
        await fixture.handler.authenticate(created.token);
        expect(fixture.tokens.updates).to.have.length(2);
    });

    it('immediately rejects revocation, expiration, authVersion changes, and unavailable users', async () => {
        let fixture = createFixture();
        let created = await fixture.handler.create(fixture.user._id, { description: 'Client' });
        await fixture.handler.revoke(fixture.user._id, created.id);
        await expectCode(fixture.handler.authenticate(created.token), 'InvalidMcpToken');

        created = await fixture.handler.create(fixture.user._id, { description: 'Client' });
        fixture.tokens.entries[0].expires = new Date(Date.now() - 1);
        await expectCode(fixture.handler.authenticate(created.token), 'InvalidMcpToken');

        fixture.tokens.entries[0].expires = undefined;
        fixture.user.authVersion++;
        await expectCode(fixture.handler.authenticate(created.token), 'InvalidMcpToken');

        fixture.user.authVersion--;
        fixture.user.disabled = true;
        await expectCode(fixture.handler.authenticate(created.token), 'InvalidMcpToken');
        fixture.user.disabled = false;
        fixture.user.suspended = true;
        await expectCode(fixture.handler.authenticate(created.token), 'InvalidMcpToken');
    });

    it('rejects every non-dedicated token shape', async () => {
        let fixture = createFixture();
        for (let value of [false, '', 'root-token', 'a'.repeat(40), `wdmcp_${'A'.repeat(64)}`, `wdmcp_${'a'.repeat(63)}`]) {
            await expectCode(fixture.handler.authenticate(value), 'InvalidMcpToken');
        }
    });

    it('resolves users by ID, username, or address for CLI use', async () => {
        let fixture = createFixture();
        expect(await fixture.handler.resolveUser(fixture.user._id.toString())).to.equal(fixture.user);
        expect(await fixture.handler.resolveUser('alice')).to.equal(fixture.user);
        expect(await fixture.handler.resolveUser('alice@example.com')).to.equal(fixture.user);
        await expectCode(fixture.handler.resolveUser('missing'), 'UserNotFound');
    });

    it('carries a version marker and a checksum over the version and secret', () => {
        let token = McpTokenHandler.generateToken();

        expect(token).to.match(/^wdmcp_\d[a-f0-9]{72}$/);
        expect(token).to.have.length(79);
        expect(McpTokenHandler.parseToken(token)).to.include({ version: '1' });

        // Fixed vector, so an implementation on either side of the API can be checked against
        // this exact value
        let secret = '3f9a71c4e2b85d06a147fc39e0d2b6581aa4c7e93b05f2d81c6e4a70b93df215';
        expect(McpTokenHandler.tokenChecksum('1', secret)).to.equal('9838c218');
        expect(McpTokenHandler.isToken(`wdmcp_1${secret}9838c218`)).to.equal(true);
    });

    it('rejects a mistyped, truncated or unversioned token', () => {
        let token = McpTokenHandler.generateToken();
        let flip = character => (character === 'a' ? 'b' : 'a');

        // a single altered character anywhere in the secret invalidates the checksum
        expect(McpTokenHandler.isToken(token.slice(0, 10) + flip(token[10]) + token.slice(11))).to.equal(false);
        // a truncated paste no longer matches the shape
        expect(McpTokenHandler.isToken(token.slice(0, -1))).to.equal(false);
        // the pre-version format is not accepted
        expect(McpTokenHandler.isToken(`wdmcp_${'a'.repeat(64)}`)).to.equal(false);
        // an unknown future version is refused rather than guessed at
        expect(McpTokenHandler.isToken(`wdmcp_9${token.slice(7)}`)).to.equal(false);
    });

    it('refuses a malformed credential without touching the database', async () => {
        let fixture = createFixture();
        let lookups = 0;
        fixture.tokens.findOne = async () => {
            lookups++;
            return null;
        };

        await expectCode(fixture.handler.authenticate(`wdmcp_1${'a'.repeat(64)}deadbeef`), 'InvalidMcpToken');
        await expectCode(fixture.handler.authenticate('not-a-token'), 'InvalidMcpToken');

        // The checksum is what keeps an unauthenticated caller from spending a database round
        // trip per request
        expect(lookups).to.equal(0);
    });

    it('counts failures against the calling address and refuses once the budget is spent', async () => {
        let counted = [];
        let counters = {
            async asyncTTLCounter(key, count) {
                if (count) {
                    counted.push(key);
                }
                // budget of two failures, so the third call finds the address already over it
                return { success: counted.length < 2, value: counted.length, ttl: 60 };
            }
        };
        let fixture = createFixture({ counters });

        await expectCode(fixture.handler.authenticate('not-a-token', { ip: '198.51.100.7' }), 'InvalidMcpToken');
        await expectCode(fixture.handler.authenticate('not-a-token', { ip: '198.51.100.7' }), 'InvalidMcpToken');

        expect(counted).to.deep.equal(['mcpauth:198.51.100.7', 'mcpauth:198.51.100.7']);

        // a successful credential is refused too while the address is over budget
        let created = await fixture.handler.create(fixture.user._id, { description: 'Codex' });
        await expectCode(fixture.handler.authenticate(created.token, { ip: '198.51.100.7' }), 'RateLimitedError');
    });

    it('writes both successful and failed authentications to the auth log', async () => {
        let fixture = createFixture();
        let created = await fixture.handler.create(fixture.user._id, { description: 'Codex' });

        await fixture.handler.authenticate(created.token, { ip: '198.51.100.7', sess: 'abc' });
        expect(fixture.authlog.pop()).to.include({
            user: fixture.user._id.toString(),
            result: 'success',
            protocol: 'MCP',
            ip: '198.51.100.7'
        });

        fixture.user.authVersion = 5;
        await expectCode(fixture.handler.authenticate(created.token, { ip: '198.51.100.7' }), 'InvalidMcpToken');
        expect(fixture.authlog.pop()).to.include({ result: 'stale', protocol: 'MCP' });

        // an unknown credential names no user, so there is no account to log it against
        fixture.authlog.length = 0;
        await expectCode(fixture.handler.authenticate(McpTokenHandler.generateToken()), 'InvalidMcpToken');
        expect(fixture.authlog).to.have.length(0);
    });

    it('leaves the success unlogged for a handler that does not face the client', async () => {
        // The API holds one of these to re-check a credential on every request it serves for a
        // tool. The listener that saw the client has already logged that authentication with
        // the client address, so a second entry would name the internal one and cost two
        // awaited round trips on each of those requests.
        let fixture = createFixture({ logSuccessfulAuth: false });
        let created = await fixture.handler.create(fixture.user._id, { description: 'Codex' });
        fixture.authlog.length = 0;

        await fixture.handler.authenticate(created.token);
        expect(fixture.authlog).to.have.length(0);

        // the last-use timestamp still moves, so a credential presented only here is not silent
        expect(fixture.tokens.entries[0].used).to.be.instanceOf(Date);

        // and a failure is still recorded, since nothing upstream has logged one
        fixture.user.suspended = true;
        await expectCode(fixture.handler.authenticate(created.token), 'InvalidMcpToken');
        expect(fixture.authlog.pop()).to.include({ result: 'suspended', protocol: 'MCP' });
    });

    it('reads a bearer credential the same way at both listeners', () => {
        // The API accepts an access token from several carriers and strips `Bearer` as an
        // optional prefix. An MCP token is a bearer credential, so both hops resolve one
        // through here rather than each deciding what the scheme means.
        expect(McpTokenHandler.getBearerToken('Bearer wdmcp_1abc')).to.equal('wdmcp_1abc');
        expect(McpTokenHandler.getBearerToken('bearer wdmcp_1abc')).to.equal('wdmcp_1abc');

        for (let header of ['wdmcp_1abc', 'Basic wdmcp_1abc', 'Bearer ', '', undefined, ['Bearer wdmcp_1abc']]) {
            expect(McpTokenHandler.getBearerToken(header), JSON.stringify(header)).to.equal(false);
        }
    });

    it('refuses a token when the user has the mcp scope disabled', async () => {
        let fixture = createFixture({ user: { disabledScopes: ['mcp'] } });
        let created = await fixture.handler.create(fixture.user._id, { description: 'Codex' });

        await expectCode(fixture.handler.authenticate(created.token), 'InvalidMcpToken');
        expect(fixture.authlog.pop()).to.include({ result: 'scope_disabled' });
    });

    it('stores the access level and refuses one that is not defined', async () => {
        let fixture = createFixture();

        let created = await fixture.handler.create(fixture.user._id, { description: 'Codex', role: 'mcp:read' });
        expect(created.role).to.equal('mcp:read');
        expect(fixture.tokens.entries[0].tokenVersion).to.equal('1');

        await expectCode(fixture.handler.create(fixture.user._id, { description: 'Codex', role: 'mcp:full' }), 'InputValidationError');

        // the level on the record is what authentication resolves, not a constant
        let authenticated = await fixture.handler.authenticate(created.token);
        expect(authenticated.role).to.equal('mcp:read');
    });

    it('caps how many tokens one user may hold', async () => {
        let fixture = createFixture();

        for (let index = 0; index < consts.MAX_MCP_TOKEN_COUNT; index++) {
            await fixture.handler.create(fixture.user._id, { description: `Agent ${index}` });
        }

        // every token is a live read credential for the whole mailbox, so the set is bounded
        let err = await expectCode(fixture.handler.create(fixture.user._id, { description: 'One too many' }), 'TooMany');
        expect(err.responseCode).to.equal(403);
        expect(err.details).to.deep.equal({ count: consts.MAX_MCP_TOKEN_COUNT, allowed: consts.MAX_MCP_TOKEN_COUNT });
        expect(fixture.tokens.entries).to.have.length(consts.MAX_MCP_TOKEN_COUNT);

        // and revoking one makes room again
        await fixture.handler.revoke(fixture.user._id, fixture.tokens.entries[0]._id);
        await fixture.handler.create(fixture.user._id, { description: 'Replacement' });
        expect(fixture.tokens.entries).to.have.length(consts.MAX_MCP_TOKEN_COUNT);
    });

    it('records minting and revoking in the auth log', async () => {
        let fixture = createFixture();

        let created = await fixture.handler.create(fixture.user._id, { description: 'Codex', sess: 'sess-1', ip: '198.51.100.7' });
        expect(fixture.authlog.pop()).to.include({
            user: fixture.user._id.toString(),
            action: 'create mcp token',
            aname: 'Codex',
            result: 'success',
            protocol: 'mcp',
            sess: 'sess-1',
            ip: '198.51.100.7'
        });

        await fixture.handler.revoke(fixture.user._id, created.id, { sess: 'sess-2', ip: '198.51.100.8' });
        expect(fixture.authlog.pop()).to.include({
            user: fixture.user._id.toString(),
            action: 'delete mcp token',
            aname: 'Codex',
            result: 'success',
            protocol: 'mcp',
            sess: 'sess-2',
            ip: '198.51.100.8'
        });

        // a revocation that deleted nothing is an error, and logs nothing
        fixture.authlog.length = 0;
        await expectCode(fixture.handler.revoke(fixture.user._id, created.id), 'McpTokenNotFound');
        expect(fixture.authlog).to.have.length(0);
    });

    it('does not restore tokens retired by a suspension', async () => {
        let fixture = createFixture();
        let created = await fixture.handler.create(fixture.user._id, { description: 'Codex' });

        // UserHandler bumps authVersion when an account is suspended and does not lower it on
        // release, so a suspension permanently retires the tokens that existed before it. The
        // user has to mint new ones, which is deliberate for a long-lived agent credential.
        fixture.user.suspended = true;
        fixture.user.authVersion++;
        await expectCode(fixture.handler.authenticate(created.token), 'InvalidMcpToken');

        fixture.user.suspended = false;
        await expectCode(fixture.handler.authenticate(created.token), 'InvalidMcpToken');
        expect(fixture.authlog.pop()).to.include({ result: 'stale' });

        let reminted = await fixture.handler.create(fixture.user._id, { description: 'Codex again' });
        expect((await fixture.handler.authenticate(reminted.token)).role).to.equal('mcp:read');
    });

    it('does not expose database failures as invalid credentials', async () => {
        let fixture = createFixture();
        fixture.tokens.findOne = async () => {
            throw new Error('database endpoint and secret detail');
        };
        let err = await expectCode(fixture.handler.authenticate(McpTokenHandler.generateToken()), 'InternalDatabaseError');
        expect(err.responseCode).to.equal(500);
        expect(err.formattedMessage).to.equal('Database Error');
    });
});
