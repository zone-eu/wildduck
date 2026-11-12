'use strict';

const chai = require('chai');
const roles = require('../lib/roles');
const config = require('@zone-eu/wild-config');

const expect = chai.expect;
const definitions = config.api.roles;

const roleUsers = {
    collection(name) {
        if (name !== 'roles') {
            throw new Error(`Unexpected collection ${name}`);
        }
        return {
            async findOne(query) {
                const roleName = query._id;
                if (!Object.hasOwn(definitions, roleName)) {
                    return null;
                }
                return {
                    _id: roleName,
                    name: roleName,
                    permissions: definitions[roleName],
                    deleted: false,
                    isSystem: true
                };
            }
        };
    }
};

const userContext = (tokenRole, userData = {}) => roles.forUser(tokenRole, userData, roleUsers);

// A message as the listing route builds it, carrying both allowed fields and ones no read-only
// level is granted
const MESSAGE = {
    id: 1,
    mailbox: '507f1f77bcf86cd799439012',
    thread: '507f1f77bcf86cd799439013',
    subject: 'Quarterly invoice',
    idate: '2026-01-01T00:00:00.000Z',
    from: { name: 'Sender', address: 'sender@example.com' },
    to: [{ address: 'alice@example.com' }],
    attachmentsList: [{ id: 'ATT00001', filename: 'invoice.pdf' }],
    contentType: { value: 'multipart/mixed' },
    seen: false,
    user: '507f191e810c19729de860ea',
    metaData: { internal: true },
    headers: { received: 'internal host detail' },
    envelope: { from: 'bounce@example.com' }
};

describe('Roles', () => {
    describe('#getPolicyResponse', () => {
        const userData = { _id: '507f191e810c19729de860ea', role: 'user', permissions: { labels: { create: false } } };
        const policy = { role: userData.role, permissions: userData.permissions };

        it('should use user read grants for any role and preserve own/any scope', () => {
            for (const role of ['root', 'manager', 'api:read']) {
                expect(roles.getPolicyResponse({ role, user: 'another-user' }, userData)).to.deep.equal(policy);
            }
            expect(roles.getPolicyResponse({ role: 'user', user: userData._id }, userData)).to.deep.equal(policy);
            expect(roles.getPolicyResponse({ role: 'user', user: 'another-user' }, userData)).to.deep.equal({});
            expect(roles.getPolicyResponse({ role: 'tokenAuth', user: userData._id }, userData)).to.deep.equal({});
        });

        it('should honor resource restrictions and response field allowlists', async () => {
            const role = await userContext('manager', { permissions: { users: { read: false } } });
            expect(roles.getPolicyResponse({ role, user: userData._id }, userData)).to.deep.equal({});
            expect(roles.getPolicyResponse({ role: 'mcp:read', user: userData._id }, userData)).to.deep.equal({});
        });
    });

    describe('#forUser and restricted grants', () => {
        it('should use the assigned role for user tokens and preserve explicit token roles', async () => {
            expect(String(await userContext('user', { role: 'mcp:read' }))).to.equal('mcp:read');
            expect(String(await userContext('user', {}))).to.equal('user');
            expect(String(await userContext('mcp:read', {}))).to.equal('mcp:read');
        });

        it('should keep restrictions local to each request context', async () => {
            let readOnly = await userContext('user', { role: 'user', permissions: { labels: { create: false, read: true } } });
            let unrestricted = await userContext('user', { role: 'user' });

            expect(roles.can(readOnly).createOwn('labels').granted).to.equal(false);
            expect(roles.can(readOnly).createAny('labels').granted).to.equal(false);
            expect(roles.can(unrestricted).createOwn('labels').granted).to.equal(true);
        });

        it('should deny restricted CRUD operations without falling back to Any grants', async () => {
            let context = await userContext('user', { role: 'user', permissions: { labels: { create: false, read: false, update: false, delete: false } } });

            for (let operation of ['create', 'read', 'update', 'delete']) {
                expect(roles.can(context)[`${operation}Own`]('labels').granted, `${operation}Own`).to.equal(false);
                expect(roles.can(context)[`${operation}Any`]('labels').granted, `${operation}Any`).to.equal(false);
                expect(roles.can('root')[`${operation}Any`]('labels').granted).to.equal(true);
                expect(roles.can('root', { labels: { [operation]: false } })[`${operation}Own`]('labels').granted).to.equal(false);
                expect(roles.can('root', { labels: { [operation]: false } })[`${operation}Any`]('labels').granted).to.equal(false);
            }
        });

        it('should preserve role attributes and keep MCP privileges independent of the assigned role', async () => {
            let context = await userContext('mcp:read', { role: 'root', permissions: { messages: { read: true, create: true } } });
            const permission = roles.can(context).readOwn('messages');
            expect(permission.attributes).to.deep.equal(roles.can('mcp:read').readOwn('messages').attributes);
            expect(permission.filter(MESSAGE)).not.to.have.property('metaData');
            expect(roles.can(context).createOwn('messages').granted).to.equal(false);
            expect(roles.can(await userContext('user', { permissions: null })).readOwn('messages').granted).to.equal(true);
        });

        it('should treat true as no elevation and nullish values as inherited policy', async () => {
            let base = roles.can('user');
            let context = await userContext('user', {
                role: 'user',
                permissions: { labels: { create: true, delete: false } }
            });

            expect(roles.can(context).createAny('labels').granted).to.equal(base.createAny('labels').granted);
            expect(roles.can(context).readOwn('labels').granted).to.equal(base.readOwn('labels').granted);
            expect(roles.can(context).updateOwn('labels').granted).to.equal(base.updateOwn('labels').granted);
            expect(roles.can(context).deleteOwn('labels').granted).to.equal(false);
        });

        it('should reject invalid roles and malformed restrictions', async () => {
            let invalidRole;
            try {
                await userContext('user', { role: new Date() });
            } catch (err) {
                invalidRole = err;
            }
            expect(invalidRole).to.be.an('error');
            for (const userData of [
                { role: 'user', permissions: { messages: { publish: false } } },
                { role: 'user', permissions: { labels: { read: 'false' } } },
                { permissions: new Date() },
                { permissions: { labels: new Date() } }
            ]) {
                let failure;
                try {
                    await userContext('user', userData);
                } catch (err) {
                    failure = err;
                }
                expect(failure).to.be.an('error');
            }
            const unknownResourceRestriction = await userContext('user', { permissions: { unknownResource: { read: false } } });
            expect(roles.can(unknownResourceRestriction).readOwn('labels').granted).to.equal(roles.can('user').readOwn('labels').granted);
            expect(roles.can('user').readOwn('unknownResource').granted).to.equal(false);
        });

        it('should filter label fields through the effective role context', async () => {
            let context = await userContext('user', { role: 'user', permissions: { labels: { read: false } } });
            let permission = roles.can(context).readOwn('labels');
            expect(permission.granted).to.equal(false);
            expect(roles.filterResponseBody(permission, { success: true, labels: [{ id: 'id', name: 'Work' }] }, 'labels').labels).to.deep.equal([{}]);
        });
    });

    describe('#filterFields', () => {
        it('should keep only the fields the level grants', () => {
            let permission = roles.can('mcp:read').readOwn('messages');
            let filtered = roles.filterFields(permission, MESSAGE);

            expect(filtered).to.include({ id: 1, subject: 'Quarterly invoice' });
            expect(filtered.from).to.deep.equal({ name: 'Sender', address: 'sender@example.com' });
            expect(filtered).to.not.have.any.keys('user', 'metaData', 'headers', 'envelope');
        });

        it('should answer exactly what accesscontrol answers, for every resource a read-only level grants', () => {
            let sample = Object.assign({}, MESSAGE, {
                name: 'Alice',
                address: 'alice@example.com',
                path: 'INBOX',
                total: 3,
                unseen: 1,
                limits: { quota: { allowed: 1, used: 0 } },
                modifyIndex: 9,
                encryptMessages: true
            });

            // the fast path exists because accesscontrol normalizes its glob list once per row;
            // it is only correct while it answers what the library would
            for (let resource of ['users', 'addresses', 'mailboxes', 'messages', 'labels']) {
                let permission = roles.can('mcp:read').readOwn(resource);

                expect(roles.filterFields(permission, sample), resource).to.deep.equal(permission.filter(sample));
                expect(roles.filterFields(permission, [sample, MESSAGE]), resource).to.deep.equal(permission.filter([sample, MESSAGE]));
            }
        });

        it('should hand a glob, a negation or a dotted path back to accesscontrol', () => {
            // A loosened guard is how this control would fail silently, so each form that
            // carries glob semantics is checked against a grant that really uses it
            let wildcard = roles.can('user').readOwn('messages');
            expect(wildcard.attributes).to.deep.equal(['*']);

            let negated = roles.can('user').readOwn('addresses');
            expect(negated.attributes).to.deep.equal(['*', '!internalData']);

            let value = { id: 1, internalData: { hidden: true }, nested: { deep: true } };

            expect(roles.filterFields(wildcard, value)).to.deep.equal(wildcard.filter(value));
            expect(roles.filterFields(negated, value)).to.deep.equal(negated.filter(value));
            expect(roles.filterFields(negated, value)).to.not.have.property('internalData');
        });

        it('should read own properties only, as accesscontrol does', () => {
            let permission = roles.can('mcp:read').readOwn('messages');
            let inherited = Object.create({ subject: 'from the prototype' });
            inherited.id = 1;

            // a name that resolves through the prototype chain is not a field of the document,
            // and picking it up would put a value in a response that the document never carried
            expect(roles.filterFields(permission, inherited)).to.deep.equal({ id: 1 });
            expect(roles.filterFields(permission, inherited)).to.deep.equal(permission.filter(inherited));
        });

        it('should leave a value that is not an object alone', () => {
            let permission = roles.can('mcp:read').readOwn('messages');

            expect(roles.filterFields(permission, null)).to.equal(null);
            expect(roles.filterFields(permission, [null, 'text'])).to.deep.equal([null, 'text']);
        });
    });

    describe('#filterResponseBody', () => {
        let permission = () => roles.can('mcp:read').readOwn('messages');

        it('should reduce a plain success body to the granted fields', () => {
            let body = roles.filterResponseBody(permission(), Object.assign({ success: true }, MESSAGE));

            expect(body).to.include({ success: true, id: 1, subject: 'Quarterly invoice' });
            expect(body).to.not.have.any.keys('user', 'metaData', 'headers', 'envelope');
        });

        it('should leave an error body alone even when its error value is falsy', () => {
            // an error reported through an empty message, or through success:false with no error
            // key, must not be rewritten into a success body
            for (let errorBody of [
                { error: '', code: 'X' },
                { error: null, code: 'X' },
                { success: false, code: 'X' }
            ]) {
                let body = roles.filterResponseBody(permission(), errorBody);
                expect(body).to.equal(errorBody);
                expect(body).to.not.have.property('success', true);
            }
        });

        it('should filter only the results of a listing and keep its envelope', () => {
            let listing = { success: true, total: 2, nextCursor: 'abc', results: [MESSAGE, Object.assign({}, MESSAGE, { id: 2 })] };
            let body = roles.filterResponseBody(permission(), listing);

            expect(body).to.include({ success: true, total: 2, nextCursor: 'abc' });
            expect(body.results).to.have.length(2);
            body.results.forEach(result => expect(result).to.not.have.any.keys('user', 'metaData', 'headers'));
        });

        it('should preserve label listings and filter their fields with optional counters', () => {
            let labelPermission = roles.can('mcp:read').readOwn('labels');
            expect(labelPermission.granted).to.equal(true);

            for (let counters of [{}, { total: 3, unseen: 1 }]) {
                let label = { id: 'label-1', name: 'Work', ...counters };
                let listing = { success: true, labels: [{ ...label, metaData: { private: true }, user: MESSAGE.user }] };

                expect(roles.filterResponseBody(labelPermission, listing, 'labels')).to.deep.equal({ success: true, labels: [label] });
                expect(listing.labels[0]).to.have.property('metaData');
            }

            expect(roles.filterResponseBody(labelPermission, { success: true, labels: [] }, 'labels')).to.deep.equal({ success: true, labels: [] });
        });

        it('should not treat a message with labels as a label listing', () => {
            let body = roles.filterResponseBody(permission(), { success: true, ...MESSAGE, labels: ['Work'] });

            expect(body).to.include({ success: true, id: 1, subject: 'Quarterly invoice' });
            expect(body).to.not.have.any.keys('labels', 'user', 'metaData', 'headers', 'envelope');
        });

        it('should leave a value that is not a resource body untouched', () => {
            // a buffer or a stream is not a resource, and picking keys off one would destroy the
            // response; a missing body is nothing to filter
            let buffer = Buffer.from('raw');
            expect(roles.filterResponseBody(permission(), buffer)).to.equal(buffer);
            expect(roles.filterResponseBody(permission(), undefined)).to.equal(undefined);
            expect(roles.filterResponseBody(permission(), null)).to.equal(null);
        });
    });
});
