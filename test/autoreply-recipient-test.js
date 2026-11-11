/* eslint no-unused-expressions: 0 */
'use strict';

// The autoreply recipient check (RFC 3834 2): a personal responder answers only mail that names the user
// in a recipient header. Runs against an in memory stand in of the users database.

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { Headers } = require('@zone-eu/mailsplit');
const { isExplicitRecipient } = require('../lib/autoreply');

const user = new ObjectId();

function fakeDb(data) {
    const queries = [];
    const collection = name => ({
        find(query) {
            queries.push(name);
            const docs =
                name === 'addresses'
                    ? (data.addresses || []).filter(address => address.user.equals(query.user))
                    : (data.aliases || []).filter(alias => query.alias.$in.includes(alias.alias));
            return { toArray: async () => docs };
        },
        async findOne(query) {
            queries.push(name);
            return (data.users || []).find(entry => entry._id.equals(query._id)) || null;
        }
    });
    return { users: { collection }, queries };
}

const headersOf = lines => new Headers(Buffer.from(lines.join('\r\n') + '\r\n\r\n'));

async function check(to, data = {}, userData = { _id: user, fromWhitelist: [] }) {
    const db = fakeDb(data);
    const result = await isExplicitRecipient({ db, userData, recipient: 'delivered@example.com' }, headersOf([`To: ${to}`, 'Subject: test']));
    return { result, queries: db.queries };
}

describe('Autoreply recipient check', () => {
    const own = [
        { user, addrview: 'johndoe@example.com' },
        { user, addrview: 'sales*@shop.example' },
        { user, addrview: '*@catchall.example' }
    ];
    const aliases = [{ alias: 'alias.example', domain: 'example.com' }];

    it('answers the delivery address without a lookup', async () => {
        const { result, queries } = await check('Delivered <delivered@example.com>', { addresses: own });
        expect(result).to.be.true;
        expect(queries).to.deep.equal([]);
    });

    it('finds the user addresses, also in their dotted and labelled forms and through wildcards', async () => {
        expect((await check('john.doe+tag@example.com', { addresses: own })).result).to.be.true;
        expect((await check('sales-team@shop.example', { addresses: own })).result).to.be.true;
        expect((await check('anyone@catchall.example', { addresses: own })).result).to.be.true;
        expect((await check('someone@example.com', { addresses: own })).result).to.be.false;
    });

    it('finds the addresses of an alias domain', async () => {
        expect((await check('johndoe@alias.example', { addresses: own, aliases })).result).to.be.true;
        expect((await check('other@alias.example', { addresses: own, aliases })).result).to.be.false;
    });

    it('reads the addresses of the user only, not of other users', async () => {
        const other = [{ user: new ObjectId(), addrview: 'johndoe@example.com' }];
        expect((await check('johndoe@example.com', { addresses: other })).result).to.be.false;
    });

    it('accepts the fromWhitelist of the delivery user data without reading the user', async () => {
        const { result, queries } = await check('list@lists.example', {}, { _id: user, fromWhitelist: ['*@lists.example'] });
        expect(result).to.be.true;
        expect(queries).to.deep.equal([]);
    });

    it('reads the fromWhitelist when the user data does not carry it', async () => {
        const { result, queries } = await check('list@lists.example', { users: [{ _id: user, fromWhitelist: ['list@lists.example'] }] }, { _id: user });
        expect(result).to.be.true;
        expect(queries).to.deep.equal(['users']);
    });
});
