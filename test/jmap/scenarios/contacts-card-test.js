/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Catalogue file contacts.yaml, part 2: ContactCard/get and ContactCard/set creates, JSContact
// validation (RFC 9553) and media (CARD-001 to CARD-076).

const crypto = require('crypto');
const { expect } = require('chai');
const StorageHandler = require('../../../lib/storage-handler');
const { scenario, seed, jmap } = require('../harness');
const instance = require('../harness/instance');
const h = require('./contacts-helpers');

const { ID, REGISTER_ID, PNG, JPEG, PDF, USING_BLOB } = h;
const { call, failsWith, defaultBook, createBook, createCard, createFails, tryCreate, getCard, setCards } = h;

after(() => instance.stopAll());

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const UUID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Creates a card, answers it as ContactCard/get returns it */
async function roundTrip(c, values, book) {
    const res = await tryCreate(c, values, book);
    expect(res.created, JSON.stringify(res.notCreated)).to.have.property('k');
    return getCard(c, res.created.k.id);
}

/** Expects each card of the list to fail with invalidProperties naming its property */
async function invalid(c, cases) {
    for (const [card, property] of cases) {
        await createFails(c, card, 'invalidProperties', property);
    }
}

describe('ContactCard set and get (contacts.yaml)', function () {
    this.timeout(60000);
    let user;
    let c;
    let book;

    before(async () => {
        user = await h.createUser();
        c = user.client;
        book = (await defaultBook(c)).id;
    });

    describe('create and get', () => {
        scenario('CARD-001', async () => {
            const res = await setCards(c, {
                create: { c1: { '@type': 'Card', version: '1.0', addressBookIds: { [book]: true }, name: { full: 'Test Contact' } } }
            });
            const created = res.created.c1;
            expect(created.id).to.match(ID);
            expect(Object.keys(created).sort()).to.deep.equal(['created', 'id', 'uid', 'updated']);
            expect(res.newState).to.not.equal(res.oldState);
            expect((await getCard(c, created.id)).name).to.deep.equal({ full: 'Test Contact' });
        });

        scenario('CARD-002', async () => {
            const name = {
                components: [
                    { kind: 'given', value: 'Joe' },
                    { kind: 'surname', value: 'Bloggs' }
                ],
                isOrdered: true
            };
            const emails = { e1: { address: 'joe.bloggs@example.com', contexts: { private: true } } };
            const created = await createCard(c, { '@type': 'Card', version: '1.0', name, emails });
            const res = await call(c, 'ContactCard/get', { ids: [created.id] });
            const card = res.list[0];
            expect(Object.keys(card).sort()).to.deep.equal(['@type', 'addressBookIds', 'created', 'emails', 'id', 'name', 'uid', 'updated', 'version']);
            expect(card.addressBookIds).to.deep.equal({ [book]: true });
            expect(card).to.deep.include({ '@type': 'Card', version: '1.0', name, emails });
            expect(res.notFound).to.deep.equal([]);
            expect(res.state).to.be.a('string');
        });

        scenario('CARD-003', async () => {
            const card = await createCard(c);
            const res = await call(c, 'ContactCard/get', { ids: [card.id, 'nosuchcard', book] });
            expect(res.list.map(entry => entry.id)).to.deep.equal([card.id]);
            expect(res.notFound).to.deep.equal(['nosuchcard', book]);
        });

        scenario('CARD-004', async () => {
            const other = await h.createUser();
            const b2 = await createBook(other.client);
            await h.createCards(other.client, [{}, {}]);
            await h.createCards(other.client, [{}], b2);
            await h.registerEntry(other, 'Reg One', `one.${Date.now()}@example.com`);
            await h.registerEntry(other, 'Reg Two', `two.${Date.now()}@example.com`);
            const withNull = await call(other.client, 'ContactCard/get', { ids: null });
            const without = await other.client.method('ContactCard/get', {}, h.USING);
            expect(withNull.list).to.have.length(5);
            expect(withNull.list.filter(card => card.addressBookIds[REGISTER_ID])).to.have.length(2);
            expect(without.list.map(card => card.id).sort()).to.deep.equal(withNull.list.map(card => card.id).sort());
            const empty = await call(other.client, 'ContactCard/get', { ids: [] });
            expect(empty.list).to.deep.equal([]);
            expect(empty.notFound).to.deep.equal([]);
            expect(empty.state).to.be.a('string');
        });

        scenario('CARD-005', async () => {
            const card = await createCard(c, {
                name: { full: 'Props' },
                emails: { e: { address: 'p@example.com' } },
                phones: { p: { number: '1' } },
                notes: { n: { note: 'x' } }
            });
            const first = await getCard(c, card.id, ['name', 'emails']);
            expect(Object.keys(first).sort()).to.deep.equal(['emails', 'id', 'name']);
            expect(Object.keys(await getCard(c, card.id, ['addressBookIds'])).sort()).to.deep.equal(['addressBookIds', 'id']);
            const third = await getCard(c, card.id, ['uid', 'nosuchproperty']);
            expect(Object.keys(third).sort()).to.deep.equal(['id', 'uid']);
            await failsWith(call(c, 'ContactCard/get', { ids: [card.id], properties: [5] }), 'invalidArguments');
            await failsWith(call(c, 'ContactCard/get', { ids: [card.id], properties: ['name/full'] }), 'invalidArguments');
        });

        scenario('CARD-006', async () => {
            const card = await createCard(c, { 'example.com:customer': { tier: 2 } });
            expect(await getCard(c, card.id, ['example.com:customer'])).to.deep.equal({ id: card.id, 'example.com:customer': { tier: 2 } });
        });

        scenario('CARD-007', async () => {
            const other = await h.createUser();
            const url = await h.startInstance({}, { maxObjectsInGet: 3 });
            const oc = await h.clientOn(url, other);
            await h.createCards(oc, [{}, {}, {}, {}]);
            // N = 3 and the account has N + 1 cards
            const ids = (await call(oc, 'ContactCard/query', {})).ids;
            expect(ids).to.have.length(4);
            await failsWith(call(oc, 'ContactCard/get', { ids }), 'requestTooLarge');
            await failsWith(call(oc, 'ContactCard/get', { ids: null }), 'requestTooLarge');
        });

        scenario('CARD-008', async () => {
            const res = await tryCreate(c, { name: { full: 'Simple Contact' } }, book);
            expect(res.created.k).to.include({ '@type': 'Card', version: '1.0' });
            expect(res.created.k).to.have.keys('id', '@type', 'version', 'uid', 'created', 'updated');
            const card = await getCard(c, res.created.k.id);
            expect(card).to.include({ '@type': 'Card', version: '1.0' });
        });

        scenario('CARD-009', async () => {
            await invalid(c, [
                [{ '@type': 'card' }, '@type'],
                [{ '@type': 'Contact' }, '@type'],
                [{ version: '2.0' }, 'version'],
                [{ version: '1' }, 'version'],
                [{ version: 1.0 }, 'version']
            ]);
        });

        scenario('CARD-010', async () => {
            const res = await setCards(c, { create: { a: { addressBookIds: { [book]: true } }, b: { addressBookIds: { [book]: true } } } });
            const [a, b] = [res.created.a, res.created.b];
            expect(a.uid).to.match(UUID);
            expect(b.uid).to.match(UUID);
            expect(a.uid).to.not.equal(b.uid);
            expect((await getCard(c, a.id)).uid).to.equal(a.uid);
        });

        scenario('CARD-011', async () => {
            const suffix = Date.now().toString(16).padStart(12, '0').slice(-12);
            for (const uid of [
                `urn:uuid:f81d4fae-7dec-11d0-a765-${suffix}`,
                `F81D4FAE-7DEC-11D0-A765-${suffix.toUpperCase()}`,
                `free text id / with spaces ${suffix}`
            ]) {
                const res = await tryCreate(c, { uid }, book);
                expect(res.created.k).to.not.have.property('uid');
                expect((await getCard(c, res.created.k.id)).uid).to.equal(uid);
            }
        });

        scenario('CARD-012', async () => {
            const uid = 'urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
            const owner = await h.createUser();
            const b2 = await createBook(owner.client);
            const ownerBook = (await defaultBook(owner.client)).id;
            const existing = await createCard(owner.client, { uid, name: { full: 'Original' } });
            await createFails(owner.client, { uid }, 'invalidProperties', 'uid', ownerBook);
            await createFails(owner.client, { uid }, 'invalidProperties', 'uid', b2);
            expect((await getCard(owner.client, existing.id)).name.full).to.equal('Original');
        });

        scenario('CARD-013', async () => {
            const uid = `urn:uuid:${crypto.randomUUID()}`;
            const res = await setCards(c, { create: { a: { addressBookIds: { [book]: true }, uid }, b: { addressBookIds: { [book]: true }, uid } } });
            expect(Object.keys(res.created)).to.have.length(1);
            const failed = Object.values(res.notCreated);
            expect(failed).to.have.length(1);
            expect(failed[0]).to.deep.include({ type: 'invalidProperties', properties: ['uid'] });
            expect(await h.queryIds(c, { filter: { uid } })).to.have.length(1);
            // two parallel requests: the unique index lets one win
            const uid2 = `urn:uuid:${crypto.randomUUID()}`;
            const results = await Promise.all([tryCreate(c, { uid: uid2 }, book), tryCreate(jmap.forUser(user), { uid: uid2 }, book)]);
            expect(results.filter(result => result.created)).to.have.length(1);
            expect(await h.queryIds(c, { filter: { uid: uid2 } })).to.have.length(1);
        });

        scenario('CARD-014', async () => {
            const uid = 'urn:uuid:11111111-2222-4333-8444-555555555555';
            const a = await h.createUser();
            const b = await h.createUser();
            await createCard(a.client, { uid });
            const res = await tryCreate(b.client, { uid });
            expect(res.created).to.have.property('k');
        });

        scenario('CARD-015', async () => {
            const uid = `urn:uuid:${crypto.randomUUID()}`;
            const first = await createCard(c, { uid });
            await setCards(c, { destroy: [first.id] });
            const second = await createCard(c, { uid });
            expect(second.id).to.not.equal(first.id);
        });

        scenario('CARD-016', async () => {
            const uid = `urn:uuid:aaaaaaaa-bbbb-4ccc-8ddd-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
            const card = await createCard(c, { uid });
            await h.updateCard(c, card.id, { uid });
            for (const patch of [{ uid: 'urn:uuid:other' }, { uid: uid.slice(9) }, { uid: null }]) {
                await h.updateFails(c, card.id, patch, 'invalidProperties', 'uid');
            }
        });

        scenario('CARD-017', async () => {
            await createFails(c, { id: 'mychoice' }, 'invalidProperties', 'id');
            const card = await createCard(c);
            await h.updateFails(c, card.id, { id: 'other' }, 'invalidProperties', 'id');
            await h.updateCard(c, card.id, { id: card.id });
        });
    });

    describe('address books of a card', () => {
        scenario('CARD-018', async () => {
            const cases = [{ name: { full: 'x' } }, { addressBookIds: null }, { addressBookIds: {} }, { addressBookIds: [book] }];
            for (const card of cases) {
                const res = await setCards(c, { create: { k: card } });
                expect(res.notCreated.k).to.deep.include({ type: 'invalidProperties', properties: ['addressBookIds'] });
            }
        });

        scenario('CARD-019', async () => {
            for (const value of [false, null, 1, 'true']) {
                const res = await setCards(c, { create: { k: { addressBookIds: { [book]: value } } } });
                expect(res.notCreated.k).to.deep.include({ type: 'invalidProperties', properties: ['addressBookIds'] });
            }
        });

        scenario('CARD-020', async () => {
            const before = (await h.books(c)).length;
            for (const ids of [{ nosuchbook: true }, { [book]: true, nosuchbook: true }, { '#nope': true }]) {
                const res = await setCards(c, { create: { k: { addressBookIds: ids } } });
                expect(res.notCreated.k).to.deep.include({ type: 'invalidProperties', properties: ['addressBookIds'] });
            }
            expect(await h.books(c)).to.have.length(before);
        });

        scenario('CARD-021', async () => {
            const other = await h.createUser();
            const url = await h.startInstance({ maxAddressBooksPerCard: 2 });
            const oc = await h.clientOn(url, other);
            const session = (await oc.raw('/.well-known/jmap')).json;
            const max = session.accounts[oc.accountId].accountCapabilities[jmap.URN.contacts].maxAddressBooksPerCard;
            expect(max).to.equal(2);
            const ids = [await createBook(oc), await createBook(oc), await createBook(oc)];
            const res = await setCards(oc, { create: { k: { addressBookIds: { [ids[0]]: true, [ids[1]]: true } } } });
            expect((await getCard(oc, res.created.k.id)).addressBookIds).to.deep.equal({ [ids[0]]: true, [ids[1]]: true });
            const over = await setCards(oc, { create: { k: { addressBookIds: Object.fromEntries(ids.map(id => [id, true])) } } });
            expect(over.notCreated.k).to.deep.include({ type: 'invalidProperties', properties: ['addressBookIds'] });
            // the shared test server advertises the plan default of one
            const own = (await c.session()).accounts[c.accountId].accountCapabilities[jmap.URN.contacts].maxAddressBooksPerCard;
            expect(own).to.equal(1);
            const b2 = await createBook(c);
            const twice = await setCards(c, { create: { k: { addressBookIds: { [book]: true, [b2]: true } } } });
            expect(twice.notCreated.k).to.deep.include({ type: 'invalidProperties', properties: ['addressBookIds'] });
        });

        scenario('CARD-022', async () => {
            const other = await h.createUser();
            const address = `reg22.${Date.now()}@example.com`;
            await h.registerEntry(other, 'Reg', address);
            const ob = (await defaultBook(other.client)).id;
            for (const ids of [{ [REGISTER_ID]: true }, { [ob]: true, [REGISTER_ID]: true }]) {
                const res = await setCards(other.client, { create: { k: { addressBookIds: ids } } });
                expect(res.notCreated.k.type).to.equal('forbidden');
            }
            const list = await h.api('GET', `/users/${other.id}/addressregister?query=reg22`);
            expect(list.results).to.have.length(1);
        });
    });

    describe('JSContact validation', () => {
        scenario('CARD-023', async () => {
            for (const kind of ['individual', 'group', 'org', 'location', 'device', 'application', 'example.com:robot']) {
                expect((await roundTrip(c, { kind }, book)).kind).to.equal(kind);
            }
            expect(await roundTrip(c, {}, book)).to.not.have.property('kind');
            await invalid(c, [
                [{ kind: 'Individual' }, 'kind'],
                [{ kind: 'person' }, 'kind'],
                [{ kind: 5 }, 'kind']
            ]);
        });

        scenario('CARD-024', async () => {
            expect((await roundTrip(c, { created: '2024-01-02T03:04:05Z' }, book)).created).to.equal('2024-01-02T03:04:05Z');
            await invalid(c, [
                [{ created: '2024-01-02T03:04:05+02:00' }, 'created'],
                [{ created: '2024-01-02' }, 'created'],
                [{ created: '2024-01-02t03:04:05z' }, 'created'],
                [{ created: '2024-01-02T03:04:05.000Z' }, 'created']
            ]);
        });

        scenario('CARD-025', async () => {
            const before = Date.now();
            const card = await createCard(c);
            expect(card.created).to.match(UTC);
            expect(Math.abs(new Date(card.created).getTime() - before)).to.be.below(5000);
            await h.delay(1100);
            await h.updateCard(c, card.id, { 'name/full': 'Later' });
            expect((await getCard(c, card.id)).created).to.equal(card.created);
        });

        scenario('CARD-026', async () => {
            const card = await createCard(c);
            await h.delay(1100);
            const res = await h.updateCard(c, card.id, { 'name/full': 'Changed' });
            const updated = res.updated[card.id].updated;
            expect(updated).to.match(UTC);
            expect(new Date(updated).getTime()).to.be.above(new Date(card.updated).getTime());
            expect((await getCard(c, card.id)).updated).to.equal(updated);
            const noop = await h.updateCard(c, card.id, { 'name/full': 'Changed' });
            expect(noop.updated[card.id]).to.equal(null);
            expect((await getCard(c, card.id)).updated).to.equal(updated);
        });

        scenario('CARD-027', async () => {
            const values = {
                language: 'de-AT',
                prodId: 'ACME Contacts 1.0',
                preferredLanguages: { l1: { language: 'en', pref: 1, contexts: { work: true } } }
            };
            expect(await roundTrip(c, values, book)).to.deep.include(values);
            expect(await roundTrip(c, {}, book)).to.not.have.property('prodId');
            await invalid(c, [
                [{ prodId: '' }, 'prodId'],
                [{ preferredLanguages: { l1: {} } }, 'preferredLanguages/l1/language'],
                [{ language: 7 }, 'language']
            ]);
        });

        scenario('CARD-028', async () => {
            const name = {
                components: [
                    { kind: 'title', value: 'Dr.' },
                    { kind: 'given', value: 'Diego' },
                    { kind: 'given2', value: 'María' },
                    { kind: 'surname', value: 'Rivera' },
                    { kind: 'surname2', value: 'Barrientos' },
                    { kind: 'generation', value: 'Jr.' },
                    { kind: 'credential', value: 'PhD' }
                ],
                isOrdered: true,
                defaultSeparator: ' ',
                sortAs: { surname: 'Rivera Barrientos', given: 'Diego' },
                full: 'Dr. Diego Rivera Barrientos'
            };
            expect((await roundTrip(c, { name }, book)).name).to.deep.equal(name);
        });

        scenario('CARD-029', async () => {
            for (const name of [{}, { isOrdered: true }, { components: [] }, { components: [{ kind: 'separator', value: '-' }], isOrdered: true }]) {
                const error = await createFails(c, { name }, 'invalidProperties');
                expect(error.properties.some(property => property === 'name' || property === 'name/components')).to.be.true;
            }
        });

        scenario('CARD-030', async () => {
            await invalid(c, [
                [
                    {
                        name: {
                            components: [
                                { kind: 'given', value: 'A' },
                                { kind: 'middle', value: 'B' }
                            ]
                        }
                    },
                    'name/components/1/kind'
                ],
                [{ name: { components: [{ kind: 'given' }] } }, 'name/components/0/value'],
                [{ name: { components: [{ value: 'A' }] } }, 'name/components/0/kind']
            ]);
            const vendor = await roundTrip(
                c,
                {
                    name: {
                        components: [
                            { kind: 'example.com:foo', value: 'A' },
                            { kind: 'given', value: 'B' }
                        ]
                    }
                },
                book
            );
            expect(vendor.name.components[0].kind).to.equal('example.com:foo');
        });

        scenario('CARD-031', async () => {
            await invalid(c, [
                [{ name: 'John Doe' }, 'name'],
                [{ name: { full: 5 } }, 'name/full'],
                [{ name: { components: { given: 'John' } } }, 'name/components'],
                [{ name: { full: 'x', isOrdered: 'yes' } }, 'name/isOrdered'],
                [{ name: { '@type': 'NameComponent', full: 'x' } }, 'name/@type']
            ]);
        });

        scenario('CARD-032', async () => {
            const given = { kind: 'given', value: 'A' };
            const cases = [
                { components: [given, { kind: 'separator', value: '-' }, { kind: 'surname', value: 'B' }], isOrdered: false },
                { components: [given], defaultSeparator: ' ' },
                { full: 'A B', defaultSeparator: ' ' },
                { components: [given], sortAs: { surname: 'X' } },
                { full: 'A', sortAs: { given: 'A' } }
            ];
            for (const name of cases) {
                const error = await createFails(c, { name }, 'invalidProperties');
                expect(
                    error.properties.some(property => /^name\/(components\/\d+\/kind|defaultSeparator|sortAs)$/.test(property)),
                    JSON.stringify(error)
                ).to.be.true;
            }
        });

        scenario('CARD-033', async () => {
            const component = { kind: 'given', value: 'John', phonetic: '/d͡ʒɑn/' };
            const name = { components: [component], phoneticSystem: 'ipa' };
            expect((await roundTrip(c, { name }, book)).name).to.deep.equal(name);
            await invalid(c, [
                [{ name: { components: [component] } }, 'name/components/0/phonetic'],
                [{ name: { components: [component], phoneticSystem: 'klingon' } }, 'name/phoneticSystem']
            ]);
        });

        scenario('CARD-034', async () => {
            const card = await roundTrip(c, { futureProp: { x: 1 }, name: { full: 'A', futureThing: true } }, book);
            expect(card.futureProp).to.deep.equal({ x: 1 });
            expect(card.name.futureThing).to.equal(true);
            await invalid(c, [
                [{ extra: 'x' }, 'extra'],
                [{ name: { full: 'A', extra: 'x' } }, 'name/extra'],
                [{ Name: { full: 'A' } }, 'Name']
            ]);
            const error = await createFails(c, { emails: { e: { Address: 'a@example.com' } } }, 'invalidProperties');
            expect(error.properties.some(property => property.startsWith('emails/e'))).to.be.true;
        });

        scenario('CARD-035', async () => {
            const values = {
                'example.com:customFlag': true,
                name: { full: 'Vendor', 'example.com:rank': { any: ['json', 1, null] } },
                emails: { e1: { address: 'v@example.com', 'example.com:verified': 'yes' } }
            };
            const card = await roundTrip(c, values, book);
            expect(card).to.deep.include(values);
            await h.updateCard(c, card.id, { notes: { n: { note: 'unrelated' } } });
            expect(await getCard(c, card.id)).to.deep.include(values);
        });

        scenario('CARD-036', async () => {
            await invalid(c, [
                [{ 'example.com:a/b': 1 }, 'example.com:a~1b'],
                [{ 'example.com:a~b': 1 }, 'example.com:a~0b'],
                [{ ':noprefix': 1 }, ':noprefix'],
                [{ 'not a name': 1 }, 'not a name']
            ]);
        });

        scenario('CARD-037', async () => {
            const nicknames = { k1: { name: 'Johnny', contexts: { private: true }, pref: 1 }, k2: { name: 'Joe' } };
            expect((await roundTrip(c, { nicknames }, book)).nicknames).to.deep.equal(nicknames);
            await invalid(c, [
                [{ nicknames: { k1: {} } }, 'nicknames/k1/name'],
                [{ nicknames: { k1: { name: 'x', pref: 0 } } }, 'nicknames/k1/pref'],
                [{ nicknames: { k1: { name: 'x', pref: 101 } } }, 'nicknames/k1/pref'],
                [{ nicknames: ['Johnny'] }, 'nicknames']
            ]);
        });

        scenario('CARD-038', async () => {
            const cases = [
                [{ emails: { 'e 1': { address: 'a@example.com' } } }, 'emails'],
                [{ phones: { '': { number: '1' } } }, 'phones'],
                [{ nicknames: { 'a/b': { name: 'x' } } }, 'nicknames'],
                [{ notes: { ['n'.repeat(256)]: { note: 'x' } } }, 'notes']
            ];
            for (const [card, map] of cases) {
                const error = await createFails(c, card, 'invalidProperties');
                expect(error.properties.some(property => property === map || property.startsWith(`${map}/`))).to.be.true;
            }
        });

        scenario('CARD-039', async () => {
            const organizations = {
                o1: {
                    name: 'ABC, Inc.',
                    units: [{ name: 'North American Division' }, { name: 'Marketing', sortAs: 'MKT' }],
                    sortAs: 'ABC',
                    contexts: { work: true }
                },
                o2: { units: [{ name: 'Choir' }] }
            };
            expect((await roundTrip(c, { organizations }, book)).organizations).to.deep.equal(organizations);
            await invalid(c, [
                [{ organizations: { o1: {} } }, 'organizations/o1'],
                [{ organizations: { o1: { name: 'X', units: [] } } }, 'organizations/o1/units'],
                [{ organizations: { o1: { units: [{}] } } }, 'organizations/o1/units/0/name']
            ]);
        });

        scenario('CARD-040', async () => {
            const values = {
                organizations: { o1: { name: 'ACME' } },
                titles: { t1: { name: 'Research Scientist', kind: 'title', organizationId: 'o1' }, t2: { name: 'Project Lead', kind: 'role' } }
            };
            expect(await roundTrip(c, values, book)).to.deep.include(values);
            expect((await roundTrip(c, { titles: { t1: { name: 'X', organizationId: 'o9' } } }, book)).titles.t1.organizationId).to.equal('o9');
            await invalid(c, [
                [{ titles: { t1: { kind: 'role' } } }, 'titles/t1/name'],
                [{ titles: { t1: { name: 'x', kind: 'boss' } } }, 'titles/t1/kind']
            ]);
        });

        scenario('CARD-041', async () => {
            const speakToAs = { grammaticalGender: 'neuter', pronouns: { k1: { pronouns: 'they/them', pref: 2 }, k2: { pronouns: 'xe/xir', pref: 1 } } };
            expect((await roundTrip(c, { speakToAs }, book)).speakToAs).to.deep.equal(speakToAs);
            await invalid(c, [
                [{ speakToAs: {} }, 'speakToAs'],
                [{ speakToAs: { grammaticalGender: 'female' } }, 'speakToAs/grammaticalGender'],
                [{ speakToAs: { pronouns: { k1: {} } } }, 'speakToAs/pronouns/k1/pronouns']
            ]);
        });

        scenario('CARD-042', async () => {
            const emails = {
                e1: { address: 'jqpublic@xyz.example.com', contexts: { work: true }, pref: 1, label: 'Office' },
                e2: { address: 'jane_doe@example.com' }
            };
            expect((await roundTrip(c, { emails }, book)).emails).to.deep.equal(emails);
            expect((await roundTrip(c, { emails: { u: { address: 'jüri@bücher.example' } } }, book)).emails.u.address).to.equal('jüri@bücher.example');
            await invalid(c, [
                [{ emails: { e1: {} } }, 'emails/e1/address'],
                [{ emails: { e1: { address: 5 } } }, 'emails/e1/address'],
                [{ emails: { e1: { address: 'a@example.com', contexts: { work: false } } } }, 'emails/e1/contexts/work'],
                [{ emails: { e1: { address: 'a@example.com', contexts: { Work: true } } } }, 'emails/e1/contexts/Work'],
                [{ emails: { e1: { address: 'not an address' } } }, 'emails/e1/address']
            ]);
        });

        scenario('CARD-043', async () => {
            const phones = {
                p1: { number: 'tel:+1-555-555-5555;ext=5555', features: { voice: true, mobile: true }, contexts: { work: true }, pref: 1 },
                p2: { number: '+33 01 23 45 67', label: 'Paris' }
            };
            expect((await roundTrip(c, { phones }, book)).phones).to.deep.equal(phones);
            await invalid(c, [
                [{ phones: { p1: {} } }, 'phones/p1/number'],
                [{ phones: { p1: { number: '1', features: { cell: true } } } }, 'phones/p1/features/cell'],
                [{ phones: { p1: { number: '1', features: { voice: false } } } }, 'phones/p1/features/voice']
            ]);
        });

        scenario('CARD-044', async () => {
            const onlineServices = {
                x1: { uri: 'xmpp:alice@example.com' },
                x2: { service: 'Mastodon', user: '@alice@example2.com', uri: 'https://example2.com/@alice' },
                x3: { service: 'GitHub', user: 'alice', label: 'code' }
            };
            expect((await roundTrip(c, { onlineServices }, book)).onlineServices).to.deep.equal(onlineServices);
            await invalid(c, [
                [{ onlineServices: { x1: { service: 'Mastodon' } } }, 'onlineServices/x1'],
                [{ onlineServices: { x1: { uri: 'not a uri' } } }, 'onlineServices/x1/uri']
            ]);
        });

        scenario('CARD-045', async () => {
            const addresses = {
                k23: {
                    contexts: { work: true, billing: true },
                    components: [
                        { kind: 'number', value: '54321' },
                        { kind: 'separator', value: ' ' },
                        { kind: 'name', value: 'Oak St' },
                        { kind: 'locality', value: 'Reston' },
                        { kind: 'region', value: 'VA' },
                        { kind: 'separator', value: ' ' },
                        { kind: 'postcode', value: '20190' },
                        { kind: 'country', value: 'USA' }
                    ],
                    countryCode: 'US',
                    defaultSeparator: ', ',
                    isOrdered: true,
                    coordinates: 'geo:38.96,-77.34',
                    timeZone: 'America/New_York',
                    pref: 1
                },
                k24: { full: '2 rue de la Paix, Paris' }
            };
            expect((await roundTrip(c, { addresses }, book)).addresses).to.deep.equal(addresses);
        });

        scenario('CARD-046', async () => {
            await invalid(c, [
                [{ addresses: { a: {} } }, 'addresses/a'],
                [{ addresses: { a: { contexts: { work: true } } } }, 'addresses/a'],
                [{ addresses: { a: { components: [{ kind: 'streetAddress', value: '1 Main St' }] } } }, 'addresses/a/components/0/kind'],
                [{ addresses: { a: { components: [{ kind: 'separator', value: ',' }], isOrdered: true } } }, 'addresses/a/components'],
                [{ addresses: { a: { components: [{ kind: 'locality', value: 'X' }], defaultSeparator: ', ' } } }, 'addresses/a/defaultSeparator'],
                [{ addresses: { a: { full: 'x', countryCode: 'USA' } } }, 'addresses/a/countryCode'],
                [{ addresses: { a: { full: 'x', timeZone: 'Mars/Olympus' } } }, 'addresses/a/timeZone'],
                [{ addresses: { a: { full: 'x', contexts: { shipping: true } } } }, 'addresses/a/contexts/shipping']
            ]);
        });

        scenario('CARD-047', async () => {
            const anniversaries = {
                k8: { kind: 'birth', date: { year: 1953, month: 4, day: 15 } },
                k9: {
                    kind: 'death',
                    date: { '@type': 'Timestamp', utc: '2019-10-15T23:10:00Z' },
                    place: { full: '4445 Tree Street, New England, ND 58647, USA' }
                },
                k10: { kind: 'wedding', date: { month: 6, day: 2 } },
                k11: { kind: 'birth', date: { year: 1980 } }
            };
            expect((await roundTrip(c, { anniversaries }, book)).anniversaries).to.deep.equal(anniversaries);
        });

        scenario('CARD-048', async () => {
            await invalid(c, [
                [{ anniversaries: { a: { date: { year: 2000 } } } }, 'anniversaries/a/kind'],
                [{ anniversaries: { a: { kind: 'graduation', date: { year: 2000 } } } }, 'anniversaries/a/kind'],
                [{ anniversaries: { a: { kind: 'birth' } } }, 'anniversaries/a/date'],
                [{ anniversaries: { a: { kind: 'birth', date: { month: 13, year: 2000 } } } }, 'anniversaries/a/date/month'],
                [{ anniversaries: { a: { kind: 'birth', date: { day: 5 } } } }, 'anniversaries/a/date/day'],
                [{ anniversaries: { a: { kind: 'birth', date: { month: 5 } } } }, 'anniversaries/a/date/month'],
                [{ anniversaries: { a: { kind: 'birth', date: { utc: '2019-10-15T23:10:00Z' } } } }, 'anniversaries/a/date'],
                [{ anniversaries: { a: { kind: 'birth', date: '1953-04-15' } } }, 'anniversaries/a/date']
            ]);
        });

        scenario('CARD-049', async () => {
            const notes = {
                n1: { note: 'Open office hours are 1600 to 1715 EST, Mon-Fri', created: '2022-11-23T15:01:32Z', author: { name: 'John' } },
                n2: { note: 'multi\nline text with tab\t and unicode ✓' }
            };
            expect((await roundTrip(c, { notes }, book)).notes).to.deep.equal(notes);
            await invalid(c, [
                [{ notes: { n1: {} } }, 'notes/n1/note'],
                [{ notes: { n1: { note: 'x', author: {} } } }, 'notes/n1/author'],
                [{ notes: 'plain text' }, 'notes']
            ]);
        });

        scenario('CARD-050', async () => {
            const keywords = { internet: true, IETF: true, B2B: true, 'with space': true };
            expect((await roundTrip(c, { keywords }, book)).keywords).to.deep.equal(keywords);
            await invalid(c, [
                [{ keywords: { x: false } }, 'keywords/x'],
                [{ keywords: ['x'] }, 'keywords'],
                [{ keywords: { x: 1 } }, 'keywords/x']
            ]);
        });

        scenario('CARD-051', async () => {
            const personalInfo = {
                pi1: { kind: 'expertise', value: 'chemistry', level: 'high', listAs: 1 },
                pi2: { kind: 'hobby', value: 'reading', level: 'high', label: 'weekends' },
                pi3: { kind: 'interest', value: 'r&b music', level: 'medium' }
            };
            expect((await roundTrip(c, { personalInfo }, book)).personalInfo).to.deep.equal(personalInfo);
            await invalid(c, [
                [{ personalInfo: { p: { kind: 'hobby' } } }, 'personalInfo/p/value'],
                [{ personalInfo: { p: { kind: 'skill', value: 'x' } } }, 'personalInfo/p/kind'],
                [{ personalInfo: { p: { kind: 'hobby', value: 'x', level: 'extreme' } } }, 'personalInfo/p/level'],
                [{ personalInfo: { p: { kind: 'hobby', value: 'x', listAs: 0 } } }, 'personalInfo/p/listAs']
            ]);
        });

        scenario('CARD-052', async () => {
            const values = {
                calendars: {
                    c1: { kind: 'calendar', uri: 'webcal://calendar.example.com/calA.ics' },
                    c2: { kind: 'freeBusy', uri: 'https://calendar.example.com/busy/project-a', mediaType: 'text/calendar' }
                },
                schedulingAddresses: { s1: { uri: 'mailto:janedoe@example.com', pref: 1 } }
            };
            expect(await roundTrip(c, values, book)).to.deep.include(values);
            await invalid(c, [
                [{ calendars: { c1: { uri: 'webcal://x.example/a.ics' } } }, 'calendars/c1/kind'],
                [{ calendars: { c1: { kind: 'calendar' } } }, 'calendars/c1/uri'],
                [{ schedulingAddresses: { s1: {} } }, 'schedulingAddresses/s1/uri']
            ]);
        });

        scenario('CARD-053', async () => {
            const values = {
                cryptoKeys: { k1: { uri: 'https://www.example.com/keys/jdoe.cer' }, k2: { uri: 'data:application/pgp-keys;base64,LS0tLS1CRUdJTg==' } },
                directories: {
                    d1: { kind: 'entry', uri: 'https://dir.example.com/addrbook/jdoe/Jean%20Dupont.vcf' },
                    d2: { kind: 'directory', uri: 'ldap://ldap.example/o=Example%20Tech,ou=Engineering', pref: 1, listAs: 1 }
                },
                links: { l1: { kind: 'contact', uri: 'mailto:contact@example.com', pref: 1 }, l2: { uri: 'https://example.com/about' } }
            };
            expect(await roundTrip(c, values, book)).to.deep.include(values);
            await invalid(c, [
                [{ directories: { d1: { uri: 'https://x.example/' } } }, 'directories/d1/kind'],
                [{ directories: { d1: { kind: 'entry', uri: 'https://x.example/', listAs: 0 } } }, 'directories/d1/listAs'],
                [{ links: { l1: { kind: 'homepage', uri: 'https://x.example/' } } }, 'links/l1/kind'],
                [{ cryptoKeys: { k1: {} } }, 'cryptoKeys/k1/uri']
            ]);
        });

        scenario('CARD-054', async () => {
            const relatedTo = {
                'urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6': { relation: { friend: true } },
                '8cacdfb7d1ffdb59@example.com': { relation: {} },
                'no-such-card': { relation: { spouse: true, emergency: true } }
            };
            expect((await roundTrip(c, { relatedTo }, book)).relatedTo).to.deep.equal(relatedTo);
            await invalid(c, [
                [{ relatedTo: { u: { relation: { bestie: true } } } }, 'relatedTo/u/relation/bestie'],
                [{ relatedTo: { u: { relation: { friend: false } } } }, 'relatedTo/u/relation/friend'],
                [{ relatedTo: { u: 'friend' } }, 'relatedTo/u']
            ]);
        });

        scenario('CARD-055', async () => {
            const values = {
                language: 'en',
                name: {
                    components: [
                        { kind: 'title', value: 'Mr.' },
                        { kind: 'given', value: 'Ivan' },
                        { kind: 'surname', value: 'Vasiliev' }
                    ]
                },
                titles: { t1: { name: 'Shrimp Man' } },
                localizations: {
                    'uk-Cyrl': {
                        name: {
                            components: [
                                { kind: 'title', value: 'г-н' },
                                { kind: 'given', value: 'Иван' },
                                { kind: 'surname', value: 'Васильев' }
                            ]
                        }
                    },
                    de: { 'titles/t1/name': 'Garnelenmann' }
                }
            };
            expect(await roundTrip(c, values, book)).to.deep.include(values);
        });

        scenario('CARD-056', async () => {
            const titles = { t1: { name: 'Boss' } };
            const cases = [
                [{ 'titles/t1/name': 5 }, ['localizations/de/titles~1t1~1name', 'localizations/de/titles/t1/name']],
                [{ 'titles/t1': { kind: 'role' } }, null],
                [{ 'localizations/fr': {} }, ['localizations/de/localizations~1fr', 'localizations/de/localizations/fr']],
                [{ 'name/full': 'x', name: { full: 'y' } }, null],
                ['Deutsch', ['localizations/de']],
                [{ 'titles/t9/name/foo': 'x' }, null]
            ];
            for (const [patch, expected] of cases) {
                const error = await createFails(c, { titles, localizations: { de: patch } }, 'invalidProperties');
                expect(
                    error.properties.every(property => property.startsWith('localizations/de')),
                    JSON.stringify(error)
                ).to.be.true;
                if (expected) {
                    expect(
                        error.properties.some(property => expected.includes(property)),
                        JSON.stringify(error)
                    ).to.be.true;
                }
            }
        });

        scenario('CARD-057', async () => {
            const error = await createFails(c, { kind: 'nonsense', emails: { e1: {} }, phones: { p1: { number: 5 } } }, 'invalidProperties', [
                'kind',
                'emails/e1/address',
                'phones/p1/number'
            ]);
            if (error.description !== undefined) {
                expect(error.description).to.be.a('string');
            }
        });

        scenario('CARD-058', async () => {
            const res = await setCards(c, {
                create: { a: 'string', b: [], c: { addressBookIds: { [book]: true }, name: { full: 'N' }, emails: null, notes: null } }
            });
            expect(res.notCreated.a.type).to.equal('invalidProperties');
            expect(res.notCreated.b.type).to.equal('invalidProperties');
            const card = await getCard(c, res.created.c.id);
            expect(card).to.not.have.any.keys('emails', 'notes');
        });

        scenario('CARD-059', async () => {
            const full = 'Zoë 日本語 🦆 עברית';
            const note = 'line one\r\nline two\nline\tthree';
            const card = await roundTrip(c, { name: { full }, notes: { n: { note } } }, book);
            expect(card.name.full).to.equal(full);
            expect(card.notes.n.note).to.equal(note);
            await createFails(c, { nicknames: { k1: { name: 'bell\u0007name' } } }, 'invalidProperties', 'nicknames/k1/name');
        });
    });

    describe('media', () => {
        scenario('CARD-060', async () => {
            const media = {
                res45: { kind: 'sound', uri: 'https://www.example.com/sound.ogg', mediaType: 'audio/ogg' },
                res47: { kind: 'logo', uri: 'https://www.example.com/pub/logos/abccorp.jpg' },
                res1: { kind: 'photo', uri: 'https://www.example.com/pub/photos/jqpublic.gif', pref: 1 }
            };
            expect((await roundTrip(c, { media }, book)).media).to.deep.equal(media);
        });

        scenario('CARD-061', async () => {
            await invalid(c, [
                [{ media: { m: { uri: 'https://x.example/a.png' } } }, 'media/m/kind'],
                [{ media: { m: { kind: 'avatar', uri: 'https://x.example/a.png' } } }, 'media/m/kind'],
                [{ media: { m: { kind: 'photo' } } }, 'media/m/uri'],
                [{ media: { m: { kind: 'photo', uri: 'not a uri' } } }, 'media/m/uri']
            ]);
        });

        scenario('CARD-062', async () => {
            const res = await tryCreate(c, { media: { p1: { kind: 'photo', uri: h.dataUri(PNG, 'image/png') } } }, book);
            expect(res.created.k.media.p1).to.include({ kind: 'photo', mediaType: 'image/png' });
            const card = await getCard(c, res.created.k.id);
            expect(card.media.p1).to.have.keys('kind', 'blobId', 'mediaType');
            expect(card.media.p1).to.include({ kind: 'photo', mediaType: 'image/png' });
            const download = await h.download(c, card.media.p1.blobId, 'p.png', 'image/png');
            expect(download.status).to.equal(200);
            expect(download.body.equals(PNG)).to.be.true;
        });

        scenario('CARD-063', async () => {
            for (const uri of ['data:image/png;base64,###notbase64###', 'data:;base64,', h.dataUri(Buffer.from('just some plain text'), 'image/png')]) {
                await createFails(c, { media: { p1: { kind: 'photo', uri } } }, 'invalidProperties', 'media/p1/uri');
            }
        });

        scenario('CARD-064', async () => {
            const uploaded = await h.upload(c, JPEG, 'image/jpeg');
            const res = await tryCreate(c, { media: { p1: { kind: 'photo', blobId: uploaded.blobId } } }, book);
            const card = await getCard(c, res.created.k.id);
            expect(card.media.p1).to.have.keys('kind', 'blobId', 'mediaType');
            expect(card.media.p1.mediaType).to.equal('image/jpeg');
            const download = await h.download(c, card.media.p1.blobId, 'p.jpg', 'image/jpeg');
            expect(download.status).to.equal(200);
            expect(download.headers.get('content-type')).to.match(/^image\/jpeg/);
            expect(download.body.equals(JPEG)).to.be.true;
        });

        scenario('CARD-065', async () => {
            const blobs = [
                await h.upload(c, PDF, 'application/pdf'),
                await h.upload(c, Buffer.from('plain text'), 'image/png'),
                await h.upload(c, Buffer.alloc(0), 'image/png')
            ];
            for (const blob of blobs) {
                await createFails(c, { media: { p1: { kind: 'photo', blobId: blob.blobId } } }, 'invalidProperties', 'media/p1/blobId');
            }
        });

        scenario('CARD-066', async () => {
            const other = await h.createUser();
            const foreign = await h.upload(other.client, PNG, 'image/png');
            await seed.deliver(user.address, Buffer.from(`From: a@example.com\r\nTo: ${user.address}\r\nSubject: blob\r\n\r\nhello\r\n`));
            const email = (await c.method('Email/query', { limit: 1 })).ids[0];
            const emailBlob = (await c.method('Email/get', { ids: [email], properties: ['blobId'] })).list[0].blobId;
            for (const blobId of ['Gnosuchblob', foreign.blobId, emailBlob]) {
                const res = await tryCreate(c, { media: { p1: { kind: 'photo', blobId } } }, book);
                expect(['invalidProperties', 'blobNotFound']).to.include(res.notCreated.k.type);
                if (res.notCreated.k.type === 'invalidProperties') {
                    expect(res.notCreated.k.properties).to.deep.equal(['media/p1/blobId']);
                }
            }
        });

        scenario('CARD-067', async () => {
            const uploaded = await h.upload(c, PNG, 'image/png');
            const error = await createFails(
                c,
                { media: { p1: { kind: 'photo', blobId: uploaded.blobId, uri: 'https://example.com/p.jpg' } } },
                'invalidProperties'
            );
            expect(error.properties.some(property => property.startsWith('media/p1'))).to.be.true;
        });

        scenario('CARD-068', async () => {
            const uploaded = await h.upload(c, PNG, 'image/png');
            const card = await roundTrip(c, { media: { p1: { kind: 'photo', blobId: uploaded.blobId } } }, book);
            const blobId = card.media.p1.blobId;
            // the upload expires and is removed
            const db = await seed.db();
            const files = db.collection('storage.files');
            await files.updateOne({ _id: new seed.ObjectId(uploaded.blobId.slice(2)) }, { $set: { 'metadata.expires': new Date(Date.now() - 1000) } });
            await new StorageHandler({ database: db, gridfs: db }).removeExpiredUploads();
            expect((await h.download(c, blobId, 'p.png')).status).to.equal(200);
            await setCards(c, { destroy: [card.id] });
            expect((await h.download(c, blobId, 'p.png')).status).to.equal(404);
        });

        scenario('CARD-069', async () => {
            const x = await h.upload(c, PNG, 'image/png');
            const y = await h.upload(c, JPEG, 'image/jpeg');
            const card = await roundTrip(c, { media: { p1: { kind: 'photo', blobId: x.blobId } } }, book);
            await h.updateCard(c, card.id, { 'media/p1/blobId': y.blobId });
            const changed = await getCard(c, card.id);
            expect(changed.media.p1.mediaType).to.equal('image/jpeg');
            expect((await h.download(c, changed.media.p1.blobId, 'y.jpg')).body.equals(JPEG)).to.be.true;
            await h.updateCard(c, card.id, { 'media/p1': null });
            const removed = await getCard(c, card.id);
            expect(!removed.media || !removed.media.p1).to.be.true;
            expect((await h.download(c, changed.media.p1.blobId, 'y.jpg')).status).to.equal(404);
        });

        scenario('CARD-070', async () => {
            const a = await roundTrip(c, { media: { p1: { kind: 'photo', uri: h.dataUri(PNG, 'image/png') } } }, book);
            const p = a.media.p1.blobId;
            const b = await roundTrip(c, { media: { p1: { kind: 'photo', blobId: p } } }, book);
            expect(b.media.p1.blobId).to.equal(p);
            await setCards(c, { destroy: [a.id] });
            const download = await h.download(c, b.media.p1.blobId, 'p.png');
            expect(download.status).to.equal(200);
            expect(download.body.equals(PNG)).to.be.true;
        });

        scenario('CARD-071', async () => {
            const card = await roundTrip(c, { media: { p1: { kind: 'photo', uri: h.dataUri(PNG, 'image/png') } } }, book);
            const p = card.media.p1.blobId;
            const res = await call(c, 'Blob/lookup', { typeNames: ['ContactCard'], ids: [p, 'Gunknownblob'] }, USING_BLOB);
            expect(res.list.find(entry => entry.id === p).matchedIds).to.deep.equal({ ContactCard: [card.id] });
            // an unknown blob is listed with no matches (BLOB-081), not in notFound
            expect(res.list.find(entry => entry.id === 'Gunknownblob').matchedIds).to.deep.equal({ ContactCard: [] });
            expect((await getCard(c, card.id)).id).to.equal(card.id);
            const session = await c.session();
            expect(session.accounts[c.accountId].accountCapabilities[jmap.URN.blob].supportedTypeNames).to.include('ContactCard');
        });

        scenario('CARD-072', async () => {
            const card = await roundTrip(c, { media: { p1: { kind: 'photo', uri: h.dataUri(PNG, 'image/png') } } }, book);
            const p = card.media.p1.blobId;
            await failsWith(call(c, 'Blob/lookup', { typeNames: ['AddressBook'], ids: [p] }, USING_BLOB), 'unknownDataType');
            await failsWith(call(c, 'Blob/lookup', { typeNames: ['ContactCard'], ids: [p] }, [jmap.URN.core, jmap.URN.blob]), 'unknownDataType');
        });

        scenario('CARD-073', async () => {
            const card = await roundTrip(c, { media: { p1: { kind: 'photo', uri: h.dataUri(PNG, 'image/png') } } }, book);
            const p = card.media.p1.blobId;
            const download = await h.download(c, p, 'avatar.png', 'image/png');
            expect(download.status).to.equal(200);
            expect(download.body.equals(PNG)).to.be.true;
            const blob = (await call(c, 'Blob/get', { ids: [p], properties: ['data:asBase64', 'size'] }, USING_BLOB)).list[0];
            expect(Buffer.from(blob['data:asBase64'], 'base64').equals(PNG)).to.be.true;
            expect(blob.size).to.equal(PNG.length);
            const other = await h.createUser();
            const foreign = await other.client.raw(`/jmap/download/${c.accountId}/${p}/avatar.png?type=image/png`);
            expect(foreign.status).to.equal(404);
        });

        scenario('CARD-074', async () => {
            const limit = 256 * 1024;
            const big = 'x'.repeat(limit + 10);
            const res = await tryCreate(c, { notes: { n: { note: big } } }, book);
            expect(res.notCreated.k.type).to.equal('tooLarge');
            const small = await createCard(c, { name: { full: 'Small' } });
            const update = await setCards(c, { update: { [small.id]: { notes: { n: { note: big } } } } });
            expect(update.notUpdated[small.id].type).to.equal('tooLarge');
            expect(await getCard(c, small.id)).to.not.have.property('notes');
        });

        scenario('CARD-075', async () => {
            const other = await h.createUser();
            const url = await h.startInstance({ maxCards: 3 });
            const oc = await h.clientOn(url, other);
            const ids = await h.createCards(oc, [{}, {}, {}]);
            const res = await tryCreate(oc, {});
            expect(res.notCreated.k.type).to.equal('overQuota');
            await setCards(oc, { destroy: [ids[0]] });
            expect((await tryCreate(oc, {})).created).to.have.property('k');
        });

        scenario('CARD-076', async () => {
            const other = await h.createUser();
            const url = await h.startInstance({}, { maxSizeUpload: 1024 });
            const oc = await h.clientOn(url, other);
            const session = (await oc.raw('/.well-known/jmap')).json;
            const max = session.capabilities[jmap.URN.core].maxSizeUpload;
            const content = Buffer.concat([PNG, Buffer.alloc(max + 10)]);
            const db = await seed.db();
            const before = await db.collection('contacts.media').countDocuments({ user: new seed.ObjectId(other.id) });
            const res = await tryCreate(oc, { media: { p1: { kind: 'photo', uri: h.dataUri(content, 'image/png') } } });
            expect(res.notCreated.k.type).to.equal('tooLarge');
            expect(await db.collection('contacts.media').countDocuments({ user: new seed.ObjectId(other.id) })).to.equal(before);
        });
    });
});
