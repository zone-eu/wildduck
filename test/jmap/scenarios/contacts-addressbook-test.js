/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global after */
'use strict';

// Catalogue file contacts.yaml, part 1: the contacts capability and AddressBook (ABK, RFC 9610 2).

const { expect } = require('chai');
const { scenario, seed, fixtures, jmap } = require('../harness');
const instance = require('../harness/instance');
const h = require('./contacts-helpers');

const { USING, ID, REGISTER_ID } = h;
const { call, failsWith, setBooks, books, defaultBook, bookState, cardState, createBook, createCard } = h;

after(() => instance.stopAll());

const ALL_METHODS = [
    'AddressBook/get',
    'AddressBook/changes',
    'AddressBook/set',
    'ContactCard/get',
    'ContactCard/changes',
    'ContactCard/query',
    'ContactCard/queryChanges',
    'ContactCard/set',
    'ContactCard/copy'
];
const RIGHTS_ALL = { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true };

describe('AddressBook (contacts.yaml)', function () {
    this.timeout(60000);

    describe('session and request', () => {
        scenario('ABK-001', async () => {
            const user = await h.createUser();
            const session = await user.client.session();
            expect(session.capabilities[jmap.URN.contacts]).to.deep.equal({});
            expect(session.primaryAccounts[jmap.URN.contacts]).to.equal(user.accountId);
        });

        scenario('ABK-002', async () => {
            const user = await h.createUser();
            const session = await user.client.session();
            const capability = session.accounts[user.accountId].accountCapabilities[jmap.URN.contacts];
            expect(Object.keys(capability).sort()).to.deep.equal(['maxAddressBooksPerCard', 'mayCreateAddressBook']);
            expect(
                capability.maxAddressBooksPerCard === null || (Number.isInteger(capability.maxAddressBooksPerCard) && capability.maxAddressBooksPerCard >= 1)
            ).to.be.true;
            expect(capability.mayCreateAddressBook).to.equal(true);
        });

        scenario('ABK-003', async () => {
            const user = await h.createUser();
            const responses = await user.client.call(
                ALL_METHODS.map((name, index) => [name, { accountId: user.accountId }, `c${index}`]),
                [jmap.URN.core]
            );
            expect(responses).to.have.length(ALL_METHODS.length);
            responses.forEach((response, index) => expect(response).to.deep.equal(['error', { type: 'unknownMethod' }, `c${index}`]));
            const db = await seed.db();
            expect(await db.collection('addressbooks').countDocuments({ user: new seed.ObjectId(user.id) })).to.equal(0);
        });

        scenario('ABK-004', async () => {
            const user = await h.createUser();
            const names = ['AddressBook/query', 'AddressBook/queryChanges', 'AddressBook/copy', 'ContactCard/parse'];
            const responses = await h.calls(
                user.client,
                names.map((name, index) => [name, { accountId: user.accountId }, `c${index}`])
            );
            responses.forEach(response => expect(response[1].type).to.equal('unknownMethod'));
        });

        scenario('ABK-005', async () => {
            const a = await h.createUser();
            const b = await h.createUser();
            const before = await bookState(b.client);
            const args = {
                'AddressBook/get': {},
                'AddressBook/changes': { sinceState: before },
                'AddressBook/set': { create: { x: { name: 'X' } } },
                'ContactCard/get': {},
                'ContactCard/changes': { sinceState: before },
                'ContactCard/query': {},
                'ContactCard/queryChanges': { sinceQueryState: 'q' },
                'ContactCard/set': { create: { x: { name: { full: 'X' } } } }
            };
            for (const accountId of ['nosuchaccount', b.accountId]) {
                const responses = await h.calls(
                    a.client,
                    Object.entries(args).map(([name, extra], index) => [name, Object.assign({ accountId }, extra), `c${index}`])
                );
                for (const response of responses) {
                    expect(response[0]).to.equal('error');
                    expect(response[1]).to.deep.equal({ type: 'accountNotFound' });
                }
            }
            expect(await bookState(b.client)).to.equal(before);
        });
    });

    describe('AddressBook/get', () => {
        scenario('ABK-006', async () => {
            const user = await h.createUser();
            const first = await h.getBooks(user.client, { ids: null });
            const writable = first.list.filter(book => book.myRights.mayWrite);
            expect(writable).to.have.length(1);
            const book = writable[0];
            expect(book.isDefault).to.equal(true);
            expect(book.name).to.be.a('string').and.not.empty;
            expect(book).to.include({ description: null, sortOrder: 0, isSubscribed: true, shareWith: null });
            expect(first.notFound).to.deep.equal([]);
            expect(first.state).to.be.a('string');
            const second = await h.getBooks(user.client, { ids: null });
            expect(second.list.find(entry => entry.isDefault).id).to.equal(book.id);
            expect(second.state).to.equal(first.state);
        });

        scenario('ABK-007', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client, { name: 'Friends', description: 'People I know', sortOrder: 3 });
            const { list } = await h.getBooks(user.client, { ids: [id] });
            expect(Object.keys(list[0]).sort()).to.deep.equal(['description', 'id', 'isDefault', 'isSubscribed', 'myRights', 'name', 'shareWith', 'sortOrder']);
            expect(list[0]).to.deep.include({
                name: 'Friends',
                description: 'People I know',
                sortOrder: 3,
                isDefault: false,
                isSubscribed: true,
                shareWith: null
            });
            expect(Object.keys(list[0].myRights).sort()).to.deep.equal(['mayDelete', 'mayRead', 'mayShare', 'mayWrite']);
            Object.values(list[0].myRights).forEach(value => expect(value).to.be.a('boolean'));
        });

        scenario('ABK-008', async () => {
            const user = await h.createUser();
            await createBook(user.client);
            await createBook(user.client);
            const withNull = await h.getBooks(user.client, { ids: null });
            const without = await user.client.method('AddressBook/get', {}, USING);
            expect(withNull.list).to.have.length(4);
            expect(withNull.list.map(book => book.id)).to.deep.equal(without.list.map(book => book.id));
            expect(withNull.list.map(book => book.id)).to.include(REGISTER_ID);
            expect(withNull.notFound).to.deep.equal([]);
            expect(without.accountId).to.equal(user.accountId);
            expect(withNull.state).to.equal(without.state);
        });

        scenario('ABK-009', async () => {
            const user = await h.createUser();
            // ten parallel requests are more than the default maxConcurrentRequests
            const url = await h.startInstance({}, { maxConcurrentRequests: 16 });
            const clients = await Promise.all(Array.from({ length: 10 }, () => h.clientOn(url, user)));
            const results = await Promise.all(clients.map(c => c.method('AddressBook/get', {}, USING)));
            const ids = new Set(results.map(result => result.list.find(book => book.isDefault).id));
            expect(ids.size).to.equal(1);
            const final = await books(user.client);
            expect(final.filter(book => book.isDefault)).to.have.length(1);
            expect(final.filter(book => book.myRights.mayWrite)).to.have.length(1);
        });

        scenario('ABK-010', async () => {
            const user = await h.createUser();
            const c = user.client;
            const original = (await defaultBook(c)).id;
            const ids = [await createBook(c), await createBook(c), await createBook(c)];
            const check = async () => {
                const list = await books(c);
                expect(list.filter(book => book.isDefault).map(book => book.id)).to.deep.equal([original]);
            };
            await createBook(c);
            await check();
            await setBooks(c, { update: { [ids[0]]: { name: 'Renamed' } } });
            await check();
            await setBooks(c, { destroy: [ids[1]] });
            await check();
        });

        scenario('ABK-011', async () => {
            const user = await h.createUser();
            const id = (await defaultBook(user.client)).id;
            const res = await h.getBooks(user.client, { ids: [id, 'nosuchbook'] });
            expect(res.list.map(book => book.id)).to.deep.equal([id]);
            expect(res.notFound).to.deep.equal(['nosuchbook']);
            const empty = await h.getBooks(user.client, { ids: [] });
            expect(empty.list).to.deep.equal([]);
            expect(empty.notFound).to.deep.equal([]);
            expect(empty.state).to.be.a('string');
        });

        scenario('ABK-012', async () => {
            const user = await h.createUser();
            const res = await h.getBooks(user.client, { properties: ['name', 'isDefault'] });
            res.list.forEach(book => expect(Object.keys(book).sort()).to.deep.equal(['id', 'isDefault', 'name']));
            await failsWith(h.getBooks(user.client, { properties: ['nosuchproperty'] }), 'invalidArguments');
        });

        scenario('ABK-013', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const { list } = await h.getBooks(user.client, { properties: ['myRights', 'isDefault'] });
            expect(list.find(book => book.isDefault).myRights).to.deep.equal({ mayRead: true, mayWrite: true, mayShare: true, mayDelete: false });
            expect(list.find(book => book.id === id).myRights).to.deep.equal(RIGHTS_ALL);
        });

        scenario('ABK-014', async () => {
            const user = await h.createUser();
            await h.registerEntry(user, 'Jane Roe', `jane.${Date.now()}@example.com`);
            const first = await books(user.client);
            const second = await books(user.client);
            const register = first.find(book => book.id === REGISTER_ID);
            expect(register).to.deep.equal({
                id: REGISTER_ID,
                name: register.name,
                description: null,
                sortOrder: 0,
                isDefault: false,
                isSubscribed: true,
                shareWith: null,
                myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false }
            });
            expect(register.name).to.be.a('string').and.not.empty;
            expect(second.find(book => book.id === REGISTER_ID)).to.deep.equal(register);
            expect(first.find(book => book.isDefault)).to.exist;
        });

        scenario('ABK-015', async () => {
            const user = await h.createUser();
            await createBook(user.client);
            const { list } = await h.getBooks(user.client, { properties: ['shareWith'] });
            expect(list).to.have.length(3);
            list.forEach(book => expect(book).to.have.property('shareWith', null));
        });

        scenario('ABK-016', async () => {
            const user = await h.createUser();
            const session = await user.client.session();
            const max = session.capabilities[jmap.URN.core].maxObjectsInGet;
            const ids = Array.from({ length: max + 1 }, (_, index) => `A${index}`);
            await failsWith(h.getBooks(user.client, { ids }), 'requestTooLarge');
        });
    });

    describe('AddressBook/set create', () => {
        scenario('ABK-017', async () => {
            const user = await h.createUser();
            const res = await setBooks(user.client, { create: { k1: { name: 'Work' } } });
            const created = res.created.k1;
            expect(created.id).to.match(ID);
            expect(created).to.deep.equal({
                id: created.id,
                description: null,
                sortOrder: 0,
                isDefault: false,
                isSubscribed: true,
                shareWith: null,
                myRights: RIGHTS_ALL
            });
            expect(res.oldState).to.be.a('string');
            expect(res.newState).to.be.a('string').and.not.equal(res.oldState);
            expect((await h.getBooks(user.client, { ids: [created.id] })).list[0].name).to.equal('Work');
        });

        scenario('ABK-018', async () => {
            const user = await h.createUser();
            const values = { name: 'Suppliers', description: 'Vendors and couriers', sortOrder: 7, isSubscribed: false };
            const id = await createBook(user.client, values);
            const book = (await h.getBooks(user.client, { ids: [id] })).list[0];
            expect(book).to.deep.include(Object.assign({ isDefault: false }, values));
        });

        scenario('ABK-019', async () => {
            const user = await h.createUser();
            const res = await setBooks(user.client, { create: { a: { name: 'Twins' }, b: { name: 'Twins' } } });
            const ids = [res.created.a.id, res.created.b.id];
            expect(ids[0]).to.not.equal(ids[1]);
            ids.forEach(id => expect(id).to.match(ID));
            expect((await h.getBooks(user.client, { ids })).list).to.have.length(2);
        });

        scenario('ABK-020', async () => {
            const user = await h.createUser();
            await defaultBook(user.client);
            const res = await setBooks(user.client, { create: { a: { name: '' }, b: {}, c: { name: null } } });
            expect(res.created).to.equal(null);
            for (const key of ['a', 'b', 'c']) {
                expect(res.notCreated[key]).to.include({ type: 'invalidProperties' });
                expect(res.notCreated[key].properties).to.deep.equal(['name']);
            }
            expect(res.newState).to.equal(res.oldState);
        });

        scenario('ABK-021', async () => {
            const user = await h.createUser();
            const long255 = 'a'.repeat(255);
            const res = await setBooks(user.client, {
                create: { a: { name: long255 }, b: { name: 'a'.repeat(256) }, c: { name: 'ő'.repeat(0) + '日'.repeat(86) } }
            });
            expect((await h.getBooks(user.client, { ids: [res.created.a.id] })).list[0].name).to.equal(long255);
            for (const key of ['b', 'c']) {
                expect(res.notCreated[key]).to.deep.include({ type: 'invalidProperties', properties: ['name'] });
            }
        });

        scenario('ABK-022', async () => {
            const user = await h.createUser();
            const res = await setBooks(user.client, { create: { a: { name: 42 }, b: { name: ['a'] }, c: { name: { a: true } } } });
            for (const key of ['a', 'b', 'c']) {
                expect(res.notCreated[key]).to.deep.include({ type: 'invalidProperties', properties: ['name'] });
            }
        });

        scenario('ABK-023', async () => {
            const user = await h.createUser();
            const create = { a: -1, b: 2147483648, c: 1.5, d: '3', e: 2147483647 };
            const res = await setBooks(user.client, {
                create: Object.fromEntries(Object.entries(create).map(([key, sortOrder]) => [key, { name: key, sortOrder }]))
            });
            for (const key of ['a', 'b', 'c', 'd']) {
                expect(res.notCreated[key]).to.deep.include({ type: 'invalidProperties', properties: ['sortOrder'] });
            }
            expect((await h.getBooks(user.client, { ids: [res.created.e.id] })).list[0].sortOrder).to.equal(2147483647);
        });

        scenario('ABK-024', async () => {
            const user = await h.createUser();
            const text = 'Long text with unicode: Tõnu, 日本';
            const res = await setBooks(user.client, {
                create: { a: { name: 'a', description: text }, b: { name: 'b', description: null }, c: { name: 'c', description: 5 } }
            });
            const list = (await h.getBooks(user.client, { ids: [res.created.a.id, res.created.b.id] })).list;
            expect(list[0].description).to.equal(text);
            expect(list[1].description).to.equal(null);
            expect(res.notCreated.c).to.deep.include({ type: 'invalidProperties', properties: ['description'] });
        });

        scenario('ABK-025', async () => {
            const user = await h.createUser();
            const extra = {
                id: { id: 'abc' },
                isDefault: { isDefault: true },
                myRights: { myRights: RIGHTS_ALL },
                shareWith: { shareWith: { someone: { mayRead: true } } }
            };
            const res = await setBooks(user.client, {
                create: Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, Object.assign({ name: key }, value)]))
            });
            for (const key of Object.keys(extra)) {
                expect(res.notCreated[key]).to.deep.include({ type: 'invalidProperties', properties: [key] });
            }
            expect((await books(user.client)).filter(book => book.isDefault)).to.have.length(1);
        });

        scenario('ABK-026', async () => {
            const user = await h.createUser();
            const res = await setBooks(user.client, { create: { k1: { name: 'X', colour: 'red' } } });
            expect(res.notCreated.k1).to.deep.include({ type: 'invalidProperties', properties: ['colour'] });
        });

        scenario('ABK-027', async () => {
            const user = await h.createUser();
            const responses = await h.calls(user.client, [
                ['AddressBook/set', { accountId: user.accountId, create: { book: { name: 'Refs' } } }, 'a'],
                ['ContactCard/set', { accountId: user.accountId, create: { c: { addressBookIds: { '#book': true }, name: { full: 'Ref Test' } } } }, 'b'],
                ['AddressBook/get', { accountId: user.accountId, ids: ['#book'] }, 'c']
            ]);
            const bookId = responses[0][1].created.book.id;
            const card = await h.getCard(user.client, responses[1][1].created.c.id);
            expect(card.addressBookIds).to.deep.equal({ [bookId]: true });
            expect(responses[2][1].list.map(book => book.id)).to.deep.equal([bookId]);
            // createdIds is in the response only when the request had it
            const raw = await user.client.request({ using: USING, methodCalls: [['AddressBook/get', { accountId: user.accountId, ids: [] }, 'a']] });
            expect(raw.json).to.not.have.property('createdIds');
            const withIds = await user.client.request({
                using: USING,
                methodCalls: [['AddressBook/set', { accountId: user.accountId, create: { x: { name: 'X' } } }, 'a']],
                createdIds: {}
            });
            expect(withIds.json.createdIds).to.have.property('x');
        });

        scenario('ABK-028', async () => {
            const user = await h.createUser();
            await defaultBook(user.client);
            const res = await setBooks(user.client, { create: { good: { name: 'Good' }, bad: { name: '' } } });
            expect(res.created).to.have.property('good');
            expect(res.notCreated.bad.type).to.equal('invalidProperties');
            expect(res.newState).to.not.equal(res.oldState);
            const changes = await call(user.client, 'AddressBook/changes', { sinceState: res.oldState });
            expect(changes.created).to.deep.equal([res.created.good.id]);
        });
    });

    describe('AddressBook/set update', () => {
        scenario('ABK-029', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client, { name: 'Old' });
            const res = await setBooks(user.client, { update: { [id]: { name: 'New' } } });
            expect(res.updated).to.deep.equal({ [id]: null });
            expect(res.notUpdated === null || !(id in res.notUpdated)).to.be.true;
            expect((await h.getBooks(user.client, { ids: [id] })).list[0].name).to.equal('New');
            expect(res.newState).to.not.equal(res.oldState);
        });

        scenario('ABK-030', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client, { name: 'Defaults' });
            await setBooks(user.client, { update: { [id]: { description: 'Updated text', sortOrder: 2, isSubscribed: false } } });
            expect((await h.getBooks(user.client, { ids: [id] })).list[0]).to.deep.include({
                name: 'Defaults',
                description: 'Updated text',
                sortOrder: 2,
                isSubscribed: false
            });
        });

        scenario('ABK-031', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client, { name: 'Keep', sortOrder: 5, description: 'Keep me', isSubscribed: false });
            await setBooks(user.client, { update: { [id]: { name: 'Renamed' } } });
            expect((await h.getBooks(user.client, { ids: [id] })).list[0]).to.deep.include({
                name: 'Renamed',
                sortOrder: 5,
                description: 'Keep me',
                isSubscribed: false
            });
        });

        scenario('ABK-032', async () => {
            const user = await h.createUser();
            const id = (await defaultBook(user.client)).id;
            const res = await setBooks(user.client, { update: { [id]: { name: 'Personal', sortOrder: 1, description: 'Mine' } } });
            expect(res.updated).to.have.property(id);
            const book = (await h.getBooks(user.client, { ids: [id] })).list[0];
            expect(book).to.deep.include({ name: 'Personal', sortOrder: 1, description: 'Mine', isDefault: true });
            expect(book.myRights.mayDelete).to.equal(false);
        });

        scenario('ABK-033', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const card = await createCard(user.client, { addressBookIds: { [id]: true } });
            for (const value of [false, true]) {
                const res = await setBooks(user.client, { update: { [id]: { isSubscribed: value } } });
                expect(res.updated).to.have.property(id);
                expect((await h.getBooks(user.client, { ids: [id] })).list[0].isSubscribed).to.equal(value);
                expect(await h.getCard(user.client, card.id)).to.exist;
                expect(await h.queryIds(user.client, { filter: { inAddressBook: id } })).to.deep.equal([card.id]);
            }
        });

        scenario('ABK-034', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client, { name: 'Stable', sortOrder: 4 });
            const state = await bookState(user.client);
            const patches = [
                [{ name: '' }, 'name'],
                [{ name: 'a'.repeat(256) }, 'name'],
                [{ sortOrder: -1 }, 'sortOrder'],
                [{ name: 'Fine', sortOrder: 'x' }, 'sortOrder']
            ];
            for (const [patch, property] of patches) {
                const res = await setBooks(user.client, { update: { [id]: patch } });
                expect(res.notUpdated[id]).to.deep.include({ type: 'invalidProperties', properties: [property] });
            }
            expect((await h.getBooks(user.client, { ids: [id] })).list[0]).to.deep.include({ name: 'Stable', sortOrder: 4 });
            expect(await bookState(user.client)).to.equal(state);
        });

        scenario('ABK-035', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const patches = [
                [{ id: 'other' }, 'id'],
                [{ isDefault: true }, 'isDefault'],
                [{ myRights: { mayRead: false, mayWrite: true, mayShare: true, mayDelete: true } }, 'myRights'],
                [{ 'myRights/mayWrite': false }, 'myRights']
            ];
            for (const [patch, property] of patches) {
                const res = await setBooks(user.client, { update: { [id]: patch } });
                expect(res.notUpdated[id]).to.deep.include({ type: 'invalidProperties', properties: [property] });
            }
            const whole = (await h.getBooks(user.client, { ids: [id] })).list[0];
            const res = await setBooks(user.client, { update: { [id]: whole } });
            expect(res.updated).to.have.property(id);
        });

        scenario('ABK-036', async () => {
            const user = await h.createUser();
            await defaultBook(user.client);
            const res = await setBooks(user.client, { update: { notarealid: { name: 'Ghost' } } });
            expect(res.notUpdated.notarealid.type).to.equal('notFound');
            expect(res.updated).to.equal(null);
            expect(res.newState).to.equal(res.oldState);
        });

        scenario('ABK-037', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client, { name: 'Patchy' });
            for (const patch of [{ 'name/foo': 'x' }, { '/name': 'x' }]) {
                const res = await setBooks(user.client, { update: { [id]: patch } });
                expect(res.notUpdated[id].type).to.equal('invalidPatch');
            }
            const res = await setBooks(user.client, { update: { [id]: { myRights: RIGHTS_ALL, 'myRights/mayRead': true } } });
            expect(['invalidPatch', 'invalidProperties']).to.include(res.notUpdated[id].type);
            expect((await h.getBooks(user.client, { ids: [id] })).list[0].name).to.equal('Patchy');
        });

        scenario('ABK-038', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            for (const patch of [
                { shareWith: { someprincipal: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false } } },
                { 'shareWith/someprincipal': { mayRead: true } }
            ]) {
                const res = await setBooks(user.client, { update: { [id]: patch } });
                expect(res.notUpdated[id]).to.deep.include({ type: 'invalidProperties', properties: ['shareWith'] });
            }
            const res = await setBooks(user.client, { update: { [id]: { shareWith: null } } });
            expect(res.updated).to.have.property(id);
            expect(res.newState).to.equal(res.oldState);
            expect((await h.getBooks(user.client, { ids: [id] })).list[0].shareWith).to.equal(null);
        });

        scenario('ABK-039', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const s = await bookState(user.client);
            const other = jmap.forUser(user);
            const renamed = await other.method('AddressBook/set', { update: { [id]: { name: 'By other' } } }, USING);
            const s2 = renamed.newState;
            await failsWith(setBooks(user.client, { ifInState: s, create: { x: { name: 'X' } } }), 'stateMismatch');
            expect((await books(user.client)).some(book => book.name === 'X')).to.be.false;
            const res = await setBooks(user.client, { ifInState: s2, create: { x: { name: 'X' } } });
            expect(res.oldState).to.equal(s2);
            expect(res.created).to.have.property('x');
        });

        scenario('ABK-040', async () => {
            const user = await h.createUser();
            const s = await bookState(user.client);
            const res = await setBooks(user.client, { create: { x: { name: 'X' } } });
            expect(res.oldState).to.equal(s);
            expect(res.newState).to.equal(await bookState(user.client));
            const empty = await setBooks(user.client, { create: {}, update: {}, destroy: [] });
            expect(empty.newState).to.equal(empty.oldState);
        });

        scenario('ABK-041', async () => {
            const user = await h.createUser();
            const session = await user.client.session();
            const max = session.capabilities[jmap.URN.core].maxObjectsInSet;
            const create = Object.fromEntries(Array.from({ length: max + 1 }, (_, index) => [`k${index}`, { name: `B${index}` }]));
            await failsWith(setBooks(user.client, { create }), 'requestTooLarge');
            expect(await books(user.client)).to.have.length(2);
        });
    });

    describe('AddressBook/set destroy', () => {
        scenario('ABK-042', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const res = await setBooks(user.client, { destroy: [id] });
            expect(res.destroyed).to.deep.equal([id]);
            expect(res.notDestroyed === null || !(id in res.notDestroyed)).to.be.true;
            expect(res.newState).to.not.equal(res.oldState);
            expect((await h.getBooks(user.client, { ids: [id] })).notFound).to.deep.equal([id]);
        });

        scenario('ABK-043', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const card = await createCard(user.client, { addressBookIds: { [id]: true } });
            const states = [await bookState(user.client), await cardState(user.client)];
            for (const args of [{ destroy: [id] }, { destroy: [id], onDestroyRemoveContents: false }]) {
                const res = await setBooks(user.client, args);
                expect(res.notDestroyed[id].type).to.equal('addressBookHasContents');
                expect(res.destroyed).to.equal(null);
            }
            expect((await h.getBooks(user.client, { ids: [id] })).list).to.have.length(1);
            expect(await h.getCard(user.client, card.id)).to.exist;
            expect([await bookState(user.client), await cardState(user.client)]).to.deep.equal(states);
        });

        scenario('ABK-044', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const ids = await h.createCards(user.client, [{ name: { full: 'One' } }, { name: { full: 'Two' } }], id);
            const [bookBefore, cardBefore] = [await bookState(user.client), await cardState(user.client)];
            const res = await setBooks(user.client, { destroy: [id], onDestroyRemoveContents: true });
            expect(res.destroyed).to.deep.equal([id]);
            expect((await call(user.client, 'ContactCard/get', { ids })).notFound.sort()).to.deep.equal([...ids].sort());
            expect((await call(user.client, 'ContactCard/changes', { sinceState: cardBefore })).destroyed.sort()).to.deep.equal([...ids].sort());
            expect((await call(user.client, 'AddressBook/changes', { sinceState: bookBefore })).destroyed).to.deep.equal([id]);
        });

        scenario('ABK-045', async () => {
            const user = await h.createUser();
            const url = await h.startInstance({ maxAddressBooksPerCard: 3 });
            const c = await h.clientOn(url, user);
            const b1 = await createBook(c);
            const b2 = await createBook(c);
            const [x, y] = await h.createCards(c, [{ addressBookIds: { [b1]: true, [b2]: true } }, {}], b1);
            const before = await cardState(c);
            const res = await setBooks(c, { destroy: [b1], onDestroyRemoveContents: true });
            expect(res.destroyed).to.deep.equal([b1]);
            const got = await call(c, 'ContactCard/get', { ids: [x, y] });
            expect(got.list.map(card => card.id)).to.deep.equal([x]);
            expect(got.list[0].addressBookIds).to.deep.equal({ [b2]: true });
            expect(got.notFound).to.deep.equal([y]);
            const changes = await call(c, 'ContactCard/changes', { sinceState: before });
            expect(changes.updated).to.deep.equal([x]);
            expect(changes.destroyed).to.deep.equal([y]);
        });

        scenario('ABK-046', async () => {
            const user = await h.createUser();
            const id = (await defaultBook(user.client)).id;
            await createBook(user.client);
            for (const args of [{ destroy: [id] }, { destroy: [id], onDestroyRemoveContents: true }]) {
                const res = await setBooks(user.client, args);
                expect(res.notDestroyed[id].type).to.equal('forbidden');
            }
            expect((await h.getBooks(user.client, { ids: [id] })).list[0].isDefault).to.equal(true);
        });

        scenario('ABK-047', async () => {
            const user = await h.createUser();
            await defaultBook(user.client);
            const res = await setBooks(user.client, { destroy: ['notarealid'] });
            expect(res.notDestroyed.notarealid.type).to.equal('notFound');
            expect(res.newState).to.equal(res.oldState);
        });

        scenario('ABK-048', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            await setBooks(user.client, { destroy: [id] });
            const res = await setBooks(user.client, { destroy: [id] });
            expect(res.notDestroyed[id].type).to.equal('notFound');
            expect(res.newState).to.equal(res.oldState);
        });

        scenario('ABK-049', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const res = await setBooks(user.client, { update: { [id]: { name: 'Doomed' } }, destroy: [id] });
            expect(res.destroyed).to.deep.equal([id]);
            const updated = !!(res.updated && id in res.updated);
            const notUpdated = !!(res.notUpdated && id in res.notUpdated);
            expect(updated && notUpdated).to.be.false;
            if (notUpdated) {
                expect(res.notUpdated[id].type).to.equal('willDestroy');
            }
        });

        scenario('ABK-050', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const before = await bookState(user.client);
            await setBooks(user.client, { destroy: [id] });
            const res = await setBooks(user.client, { create: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`k${n}`, { name: `N${n}` }])) });
            const ids = Object.values(res.created).map(created => created.id);
            expect(ids).to.not.include(id);
            const changes = await call(user.client, 'AddressBook/changes', { sinceState: before });
            expect(changes.destroyed).to.deep.equal([id]);
            expect(changes.created).to.not.include(id);
        });
    });

    describe('the register address book', () => {
        scenario('ABK-051', async () => {
            const user = await h.createUser();
            const register = (await books(user.client)).find(book => book.id === REGISTER_ID);
            const state = await bookState(user.client);
            for (const patch of [{ name: 'Mine now' }, { sortOrder: 9 }, { isSubscribed: false }]) {
                const res = await setBooks(user.client, { update: { [REGISTER_ID]: patch } });
                expect(res.notUpdated[REGISTER_ID].type).to.equal('forbidden');
            }
            expect((await books(user.client)).find(book => book.id === REGISTER_ID)).to.deep.equal(register);
            expect(await bookState(user.client)).to.equal(state);
        });

        scenario('ABK-052', async () => {
            const user = await h.createUser();
            const address = `reg.${Date.now()}@example.com`;
            await h.registerEntry(user, 'Reg Entry', address);
            for (const args of [{ destroy: [REGISTER_ID] }, { destroy: [REGISTER_ID], onDestroyRemoveContents: true }]) {
                const res = await setBooks(user.client, args);
                expect(res.notDestroyed[REGISTER_ID].type).to.equal('forbidden');
            }
            const entry = await h.waitRegister(user, address);
            expect(entry.address).to.equal(address);
        });

        scenario('ABK-053', async () => {
            const user = await h.createUser();
            const current = (await defaultBook(user.client)).id;
            const res = await setBooks(user.client, { onSuccessSetIsDefault: REGISTER_ID });
            expect(res.updated === null || !Object.keys(res.updated).length).to.be.true;
            expect(res.newState).to.equal(res.oldState);
            expect((await defaultBook(user.client)).id).to.equal(current);
        });
    });

    describe('onSuccessSetIsDefault', () => {
        scenario('ABK-054', async () => {
            const user = await h.createUser();
            const d = (await defaultBook(user.client)).id;
            const b = await createBook(user.client);
            const res = await setBooks(user.client, { onSuccessSetIsDefault: b });
            expect(res.updated[b]).to.deep.include({ isDefault: true });
            expect(res.updated[b].myRights.mayDelete).to.equal(false);
            expect(res.updated[d]).to.deep.include({ isDefault: false });
            expect(res.updated[d].myRights.mayDelete).to.equal(true);
            expect(res.newState).to.not.equal(res.oldState);
            expect((await books(user.client)).filter(book => book.isDefault).map(book => book.id)).to.deep.equal([b]);
        });

        scenario('ABK-055', async () => {
            const user = await h.createUser();
            const d = (await defaultBook(user.client)).id;
            const res = await setBooks(user.client, { create: { k1: { name: 'Fresh' } }, onSuccessSetIsDefault: '#k1' });
            expect(res.created.k1.isDefault).to.equal(true);
            expect(res.updated[d]).to.deep.include({ isDefault: false });
            expect((await books(user.client)).filter(book => book.isDefault).map(book => book.id)).to.deep.equal([res.created.k1.id]);
            // a creation id of an earlier AddressBook/set in the same request
            const responses = await h.calls(user.client, [
                ['AddressBook/set', { accountId: user.accountId, create: { k2: { name: 'Earlier' } } }, 'a'],
                ['AddressBook/set', { accountId: user.accountId, onSuccessSetIsDefault: '#k2' }, 'b']
            ]);
            const k2 = responses[0][1].created.k2.id;
            expect(responses[1][1].updated[k2]).to.deep.include({ isDefault: true });
            expect((await defaultBook(user.client)).id).to.equal(k2);
        });

        scenario('ABK-056', async () => {
            const user = await h.createUser();
            const d = (await defaultBook(user.client)).id;
            const b = await createBook(user.client);
            const res = await setBooks(user.client, { create: { bad: { name: '' } }, onSuccessSetIsDefault: b });
            expect(res.notCreated).to.have.property('bad');
            expect(res.updated === null || !(b in res.updated)).to.be.true;
            expect((await defaultBook(user.client)).id).to.equal(d);
        });

        scenario('ABK-057', async () => {
            const user = await h.createUser();
            const d = (await defaultBook(user.client)).id;
            for (const target of ['nosuchbook', '#nocreation']) {
                const res = await setBooks(user.client, { onSuccessSetIsDefault: target });
                expect(res.notUpdated).to.equal(null);
                expect(res.newState).to.equal(res.oldState);
            }
            expect((await defaultBook(user.client)).id).to.equal(d);
        });

        scenario('ABK-058', async () => {
            const user = await h.createUser();
            const d = (await defaultBook(user.client)).id;
            for (const target of [d, null]) {
                const res = await setBooks(user.client, { onSuccessSetIsDefault: target });
                expect(res.updated === null || !Object.keys(res.updated).length).to.be.true;
                expect(res.newState).to.equal(res.oldState);
                const changes = await call(user.client, 'AddressBook/changes', { sinceState: res.oldState });
                expect([...changes.created, ...changes.updated, ...changes.destroyed]).to.deep.equal([]);
            }
        });

        scenario('ABK-059', async () => {
            const user = await h.createUser();
            const d = (await defaultBook(user.client)).id;
            const b = await createBook(user.client);
            const res = await setBooks(user.client, { update: { [b]: { name: 'Main', sortOrder: 2 } }, onSuccessSetIsDefault: b });
            expect(Object.keys(res.updated).sort()).to.deep.equal([b, d].sort());
            expect(res.updated[b].isDefault).to.equal(true);
            expect(res.updated[d].isDefault).to.equal(false);
            expect(res.notUpdated).to.equal(null);
            const book = (await h.getBooks(user.client, { ids: [b] })).list[0];
            expect(book).to.deep.include({ name: 'Main', isDefault: true });
        });

        scenario('ABK-060', async () => {
            const user = await h.createUser();
            const d = (await defaultBook(user.client)).id;
            const b = await createBook(user.client);
            await setBooks(user.client, { onSuccessSetIsDefault: b });
            const book = (await h.getBooks(user.client, { ids: [d] })).list[0];
            expect(book.myRights.mayDelete).to.equal(true);
            expect(book.isDefault).to.equal(false);
            const res = await setBooks(user.client, { destroy: [d] });
            expect(res.destroyed).to.deep.equal([d]);
            expect((await defaultBook(user.client)).id).to.equal(b);
        });

        scenario('ABK-061', async () => {
            const user = await h.createUser();
            const d = (await defaultBook(user.client)).id;
            const b = await createBook(user.client);
            const res = await setBooks(user.client, { destroy: [d], onSuccessSetIsDefault: b });
            expect(res.notDestroyed[d].type).to.equal('forbidden');
            expect((await defaultBook(user.client)).id).to.equal(d);
        });
    });

    describe('AddressBook/changes', () => {
        scenario('ABK-062', async () => {
            const user = await h.createUser();
            const s = await bookState(user.client);
            const res = await call(user.client, 'AddressBook/changes', { sinceState: s });
            expect(res).to.deep.include({ oldState: s, newState: s, hasMoreChanges: false, created: [], updated: [], destroyed: [] });
        });

        scenario('ABK-063', async () => {
            const user = await h.createUser();
            const s = await bookState(user.client);
            const id = await createBook(user.client);
            const res = await call(user.client, 'AddressBook/changes', { sinceState: s });
            expect(res).to.deep.include({ created: [id], updated: [], destroyed: [] });
            expect(res.newState).to.not.equal(s);
            expect(res.newState).to.equal(await bookState(user.client));
        });

        scenario('ABK-064', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const s = await bookState(user.client);
            await setBooks(user.client, { update: { [id]: { name: 'Renamed' } } });
            const res = await call(user.client, 'AddressBook/changes', { sinceState: s });
            expect(res).to.deep.include({ created: [], updated: [id], destroyed: [] });
            expect(res.newState).to.not.equal(s);
        });

        scenario('ABK-065', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const s = await bookState(user.client);
            await setBooks(user.client, { destroy: [id] });
            const res = await call(user.client, 'AddressBook/changes', { sinceState: s });
            expect(res).to.deep.include({ created: [], updated: [], destroyed: [id] });
            expect(res.newState).to.not.equal(s);
        });

        scenario('ABK-066', async () => {
            const user = await h.createUser();
            const s = await bookState(user.client);
            const id = await createBook(user.client);
            await setBooks(user.client, { update: { [id]: { name: 'Again' } } });
            await setBooks(user.client, { destroy: [id] });
            const res = await call(user.client, 'AddressBook/changes', { sinceState: s });
            expect(res.created).to.not.include(id);
            expect(res.updated).to.not.include(id);
            expect(res.newState).to.equal(await bookState(user.client));
        });

        scenario('ABK-067', async () => {
            const user = await h.createUser();
            const s = await bookState(user.client);
            const id = await createBook(user.client);
            await setBooks(user.client, { update: { [id]: { name: 'One' } } });
            await setBooks(user.client, { update: { [id]: { name: 'Two' } } });
            const res = await call(user.client, 'AddressBook/changes', { sinceState: s });
            expect(res.created).to.deep.equal([id]);
            expect(res.updated).to.not.include(id);
        });

        scenario('ABK-068', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const s = await bookState(user.client);
            await setBooks(user.client, { update: { [id]: { name: 'One' } } });
            await setBooks(user.client, { destroy: [id] });
            const res = await call(user.client, 'AddressBook/changes', { sinceState: s });
            expect(res.destroyed).to.deep.equal([id]);
            expect(res.updated).to.not.include(id);
        });

        scenario('ABK-069', async () => {
            const user = await h.createUser();
            const d = (await defaultBook(user.client)).id;
            const b = await createBook(user.client);
            const s = await bookState(user.client);
            await setBooks(user.client, { onSuccessSetIsDefault: b });
            const res = await call(user.client, 'AddressBook/changes', { sinceState: s });
            expect([...res.updated].sort()).to.deep.equal([b, d].sort());
        });

        scenario('ABK-070', async () => {
            const user = await h.createUser();
            const s = await bookState(user.client);
            const res = await setBooks(user.client, { create: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`k${n}`, { name: `N${n}` }])) });
            const ids = Object.values(res.created).map(created => created.id);
            const all = await h.allChanges(user.client, 'AddressBook', s, 2);
            const final = all.pages[all.pages.length - 1].newState;
            for (const page of all.pages) {
                expect(page.created.length + page.updated.length + page.destroyed.length).to.be.at.most(2);
                if (page !== all.pages[all.pages.length - 1]) {
                    expect(page.hasMoreChanges).to.equal(true);
                    expect(page.newState).to.not.equal(final);
                }
            }
            expect([...all.created].sort()).to.deep.equal([...ids].sort());
        });

        scenario('ABK-071', async () => {
            const user = await h.createUser();
            const s = await bookState(user.client);
            for (const maxChanges of [0, -1, '5']) {
                await failsWith(call(user.client, 'AddressBook/changes', { sinceState: s, maxChanges }), 'invalidArguments');
            }
        });

        scenario('ABK-072', async () => {
            const user = await h.createUser();
            const s = await bookState(user.client);
            // a well formed state with a higher sequence: the checksum names the sequence, so it is not valid either
            const future = s.replace(/^o([0-9a-z]+)\./, (all, seq) => `o${(parseInt(seq, 36) + 100).toString(36)}.`);
            for (const sinceState of ['nonsense', future]) {
                await failsWith(call(user.client, 'AddressBook/changes', { sinceState }), 'cannotCalculateChanges');
            }
            const err = await call(user.client, 'AddressBook/changes', { sinceState: '' }).then(
                () => null,
                error => error
            );
            expect(err, 'an empty sinceState is an error').to.not.equal(null);
            expect(['cannotCalculateChanges', 'invalidArguments']).to.include(err.type);
        });

        scenario('ABK-073', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            const db = await seed.db();
            const userId = new seed.ObjectId(user.id);
            // a state from 40 days ago: back date the time of the current sequence
            const stateDoc = await db.collection('jmapstate').findOne({ _id: userId });
            await db.collection('jmapstate').updateOne({ _id: userId }, { $set: { 'seqTime.AddressBook': new Date(Date.now() - 40 * 24 * 3600 * 1000) } });
            const old = await bookState(user.client);
            await db.collection('jmapstate').updateOne({ _id: userId }, { $set: { 'seqTime.AddressBook': stateDoc.seqTime.AddressBook } });
            await setBooks(user.client, { destroy: [id] });
            // the tombstone is purged
            await db.collection('jmapchanges').deleteMany({ user: userId, type: 'AddressBook' });
            const current = await bookState(user.client);
            await failsWith(call(user.client, 'AddressBook/changes', { sinceState: old }), 'cannotCalculateChanges');
            const after = await call(user.client, 'AddressBook/changes', { sinceState: current });
            expect(after.created.length + after.updated.length + after.destroyed.length).to.equal(0);
            expect(await bookState(user.client)).to.equal(current);
        });

        scenario('ABK-074', async () => {
            const user = await h.createUser();
            const s = await bookState(user.client);
            const card = await createCard(user.client);
            await h.updateCard(user.client, card.id, { 'name/full': 'Changed' });
            await h.setCards(user.client, { destroy: [card.id] });
            expect(await bookState(user.client)).to.equal(s);
            const res = await call(user.client, 'AddressBook/changes', { sinceState: s });
            expect([...res.created, ...res.updated, ...res.destroyed]).to.deep.equal([]);
        });

        scenario('ABK-075', async () => {
            const user = await h.createUser();
            const s = await bookState(user.client);
            const t = await cardState(user.client);
            // the sender is an automatic one (Auto-Submitted), which the address register does not record
            const raw = await fixtures.buildMessage({ to: user.address, headers: { 'Auto-Submitted': 'auto-generated' } });
            await seed.deliver(user.address, raw);
            await seed.withImap(user, async client => {
                await client.mailboxOpen('INBOX');
                await client.messageFlagsAdd('1:*', ['\\Seen']);
            });
            await user.client.method('Mailbox/set', { create: { m: { name: 'Contacts test' } } });
            expect(await bookState(user.client)).to.equal(s);
            expect(await cardState(user.client)).to.equal(t);
            for (const [type, state] of [
                ['AddressBook', s],
                ['ContactCard', t]
            ]) {
                const res = await call(user.client, `${type}/changes`, { sinceState: state });
                expect([...res.created, ...res.updated, ...res.destroyed]).to.deep.equal([]);
            }
        });
    });

    describe('push', () => {
        scenario('ABK-076', async () => {
            const user = await h.createUser();
            await defaultBook(user.client);
            const es = await h.openStream(user, 'AddressBook');
            const res = await setBooks(user.client, { create: { x: { name: 'Pushed' } } });
            const event = await es.until(
                () => es.events.find(e => e.event === 'state' && JSON.parse(e.data).changed[user.accountId].AddressBook === res.newState),
                5000
            );
            const changed = JSON.parse(event.data).changed[user.accountId];
            expect(changed.AddressBook).to.equal(res.newState);
            expect(changed).to.not.have.any.keys('ContactCard', 'Email', 'Mailbox');
            es.close();
        });

        scenario('ABK-077', async () => {
            const user = await h.createUser();
            await defaultBook(user.client);
            const es = await h.openStream(user, 'Email,Mailbox');
            const id = await createBook(user.client);
            await setBooks(user.client, { update: { [id]: { name: 'Renamed' } } });
            await h.delay(1500);
            const quiet = es.events.filter(e => e.event === 'state').length;
            await seed.deliver(user.address, await fixtures.buildMessage({ to: user.address }));
            const event = await es.next('state', 5000);
            expect(es.events.filter(e => e.event === 'state').length).to.equal(quiet + 1);
            expect(JSON.parse(event.data).changed[user.accountId]).to.not.have.property('AddressBook');
            es.close();
        });

        scenario('ABK-078', async () => {
            const user = await h.createUser();
            const id = await createBook(user.client);
            await h.createCards(user.client, [{}, {}], id);
            const es = await h.openStream(user, 'AddressBook,ContactCard');
            await setBooks(user.client, { destroy: [id], onDestroyRemoveContents: true });
            const states = { AddressBook: await bookState(user.client), ContactCard: await cardState(user.client) };
            await es.until(() => {
                const seen = {};
                for (const e of es.events.filter(entry => entry.event === 'state')) {
                    Object.assign(seen, JSON.parse(e.data).changed[user.accountId]);
                }
                return seen.AddressBook === states.AddressBook && seen.ContactCard === states.ContactCard;
            }, 5000);
            es.close();
        });
    });
});
