'use strict';

const chai = require('chai');
const { ObjectId } = require('mongodb');
const McpTokenHandler = require('../lib/mcp-token-handler');
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

    async deleteOne(query) {
        let index = this.entries.findIndex(entry => matchesId(entry._id, query._id) && matchesId(entry.user, query.user));
        if (index < 0) return { deletedCount: 0 };
        this.entries.splice(index, 1);
        return { deletedCount: 1 };
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

function createFixture() {
    let user = {
        _id: new ObjectId(),
        username: 'alice',
        unameview: 'alice',
        address: 'alice@example.com',
        authVersion: 4
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
    return { user, tokens, database, handler: new McpTokenHandler({ users: database }) };
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

        expect(created.token).to.match(/^wdmcp_[a-f0-9]{64}$/);
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
        await expectCode(
            fixture.handler.create(fixture.user._id, { description: 'Expired', expires: new Date(Date.now() - 1000) }),
            'InputValidationError'
        );

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
        expect(fixture.tokens.updates).to.have.length(2);
        expect(fixture.tokens.updates[0].query.$or).to.be.an('array').with.length(2);
        expect(fixture.tokens.entries[0].used).to.be.instanceOf(Date);
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

    it('does not expose database failures as invalid credentials', async () => {
        let fixture = createFixture();
        fixture.tokens.findOne = async () => {
            throw new Error('database endpoint and secret detail');
        };
        let err = await expectCode(fixture.handler.authenticate(`wdmcp_${'b'.repeat(64)}`), 'InternalDatabaseError');
        expect(err.responseCode).to.equal(500);
        expect(err.formattedMessage).to.equal('Database Error');
    });
});
