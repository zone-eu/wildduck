'use strict';

const chai = require('chai');
const roles = require('../lib/roles');

const expect = chai.expect;

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
            for (let resource of ['users', 'addresses', 'mailboxes', 'messages']) {
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
});
