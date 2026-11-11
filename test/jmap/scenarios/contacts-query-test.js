/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Catalogue file contacts.yaml, part 4: ContactCard/query and ContactCard/queryChanges
// (CARD-111 to CARD-159 and CARD-174).

const crypto = require('crypto');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const Redis = require('ioredis');
const { scenario } = require('../harness');
const instance = require('../harness/instance');
const redisUrl = require('../../../lib/redis-url');
const h = require('./contacts-helpers');

const { REGISTER_ID } = h;
const { call, failsWith, defaultBook, createBook, createCard, createCards, getCard, setCards, updateCard, queryIds } = h;

after(() => instance.stopAll());

const sorted = list => [...list].sort();

/** The fixture cards of the catalogue in a new address book: answers {book, ids: [card1..card4], uids} */
async function fixtureCards(c) {
    const book = await createBook(c);
    const sarah = {
        uid: `urn:uuid:${crypto.randomUUID()}`,
        name: {
            components: [
                { kind: 'given', value: 'Sarah' },
                { kind: 'surname', value: 'Johnson' }
            ]
        },
        nicknames: { k: { name: 'SJ' } },
        organizations: { o: { name: 'Tech Innovations Inc.' } },
        emails: { e: { address: 'sarah.johnson@example.com', label: 'Work mail' } },
        phones: { p: { number: '+1-555-0100', label: 'Desk' } },
        notes: { n: { note: 'Met at the conference in Tallinn' } }
    };
    const carlos = {
        uid: `urn:uuid:${crypto.randomUUID()}`,
        name: {
            components: [
                { kind: 'given', value: 'Carlos' },
                { kind: 'surname', value: 'García' },
                { kind: 'surname2', value: 'López' }
            ]
        },
        nicknames: { k: { name: 'Carlitos' } },
        emails: { e: { address: 'carlos@example.org' } },
        addresses: {
            a: {
                components: [
                    { kind: 'locality', value: 'Madrid' },
                    { kind: 'country', value: 'Spain' }
                ]
            }
        }
    };
    const acme = { kind: 'org', name: { full: 'ACME Corp' }, onlineServices: { g: { service: 'GitHub', user: 'acme-corp' } } };
    const ids = await createCards(c, [sarah, carlos, acme], book);
    const team = await createCard(c, {
        addressBookIds: { [book]: true },
        kind: 'group',
        name: { full: 'Team' },
        members: { [sarah.uid]: true, [carlos.uid]: true }
    });
    return { book, ids: [...ids, team.id], uids: [sarah.uid, carlos.uid] };
}

describe('ContactCard/query (contacts.yaml)', function () {
    this.timeout(60000);
    let c;
    let fixture;
    // a user with the four fixture cards only (no register cards)
    let fx;

    before(async () => {
        const user = await h.createUser();
        c = user.client;
        await defaultBook(c);
        const other = await h.createUser();
        fx = other.client;
        fixture = await fixtureCards(fx);
    });

    const [s, ca, ac, te] = [0, 1, 2, 3];
    const ids = (...indexes) => sorted(indexes.map(index => fixture.ids[index]));
    const q = async filter => sorted(await queryIds(fx, { filter }));

    describe('filters', () => {
        scenario('CARD-111', async () => {
            const first = await call(fx, 'ContactCard/query', {});
            expect(sorted(first.ids)).to.deep.equal(ids(s, ca, ac, te));
            expect(first.position).to.equal(0);
            expect(first.queryState).to.be.a('string');
            expect(first.canCalculateChanges).to.equal(true);
            expect(first).to.not.have.property('total');
            for (const filter of [{}, null]) {
                const res = await call(fx, 'ContactCard/query', { filter });
                expect(res.ids).to.deep.equal(first.ids);
            }
        });

        scenario('CARD-112', async () => {
            const other = await h.createUser();
            const url = await h.startInstance({ maxAddressBooksPerCard: 3 });
            const oc = await h.clientOn(url, other);
            const [b1, b2, b3] = [await createBook(oc), await createBook(oc), await createBook(oc)];
            const [one, shared] = await createCards(oc, [{}, { addressBookIds: { [b1]: true, [b2]: true } }], b1);
            const [own] = await createCards(oc, [{}], b2);
            expect(sorted(await queryIds(oc, { filter: { inAddressBook: b1 } }))).to.deep.equal(sorted([one, shared]));
            expect(sorted(await queryIds(oc, { filter: { inAddressBook: b2 } }))).to.deep.equal(sorted([own, shared]));
            const empty = await call(oc, 'ContactCard/query', { filter: { inAddressBook: b3 } });
            expect(empty.ids).to.deep.equal([]);
            expect(empty.position).to.equal(0);
        });

        scenario('CARD-113', async () => {
            const res = await call(c, 'ContactCard/query', { filter: { inAddressBook: 'nosuchbook' }, calculateTotal: true });
            expect(res.ids).to.deep.equal([]);
            expect(res.total).to.equal(0);
        });

        scenario('CARD-114', async () => {
            const suffix = crypto.randomBytes(4).toString('hex');
            const uid1 = `urn:uuid:f81d4fae-7dec-11d0-a765-0000${suffix}`;
            const uid2 = `XXX-UID-1-${suffix}`;
            const [a, b] = await createCards(c, [{ uid: uid1 }, { uid: uid2 }]);
            expect(await queryIds(c, { filter: { uid: uid1 } })).to.deep.equal([a]);
            expect(await queryIds(c, { filter: { uid: uid2 } })).to.deep.equal([b]);
            for (const uid of [uid1.slice(9), uid1.toUpperCase(), uid2.slice(0, -2)]) {
                expect(await queryIds(c, { filter: { uid } })).to.deep.equal([]);
            }
        });

        scenario('CARD-115', async () => {
            expect(await q({ kind: 'individual' })).to.deep.equal(ids(s, ca));
            expect(await q({ kind: 'org' })).to.deep.equal(ids(ac));
            expect(await q({ kind: 'group' })).to.deep.equal(ids(te));
            expect(await q({ kind: 'Group' })).to.deep.equal([]);
            expect(await q({ kind: 'location' })).to.deep.equal([]);
        });

        scenario('CARD-116', async () => {
            expect(await q({ hasMember: fixture.uids[0] })).to.deep.equal(ids(te));
            expect(await q({ hasMember: fixture.ids[s] })).to.deep.equal([]);
            expect(await q({ hasMember: 'urn:uuid:unknown' })).to.deep.equal([]);
            expect(await q({ kind: 'group', hasMember: fixture.uids[1] })).to.deep.equal(ids(te));
        });

        scenario('CARD-117', async () => {
            const other = await h.createUser();
            const [c1, c2, c3] = await createCards(other.client, [
                { created: '2026-01-01T00:00:00Z' },
                { created: '2026-01-02T00:00:00Z' },
                { created: '2026-01-03T00:00:00Z' }
            ]);
            const oq = async filter => sorted(await queryIds(other.client, { filter }));
            expect(await oq({ createdBefore: '2026-01-03T00:00:00Z' })).to.deep.equal(sorted([c1, c2]));
            expect(await oq({ createdAfter: '2026-01-03T00:00:00Z' })).to.deep.equal([c3]);
            expect(await oq({ createdAfter: '2026-01-02T00:00:00Z', createdBefore: '2026-01-03T00:00:00Z' })).to.deep.equal([c2]);
            expect(await oq({ createdBefore: '2026-01-01T00:00:00Z' })).to.deep.equal([]);
        });

        scenario('CARD-118', async () => {
            const other = await h.createUser();
            const [c1, c2] = await createCards(other.client, [{}, {}]);
            await h.delay(1100);
            const res = await updateCard(other.client, c2, { 'name/full': 'Later' });
            const t2 = res.updated[c2].updated;
            const oq = async filter => sorted(await queryIds(other.client, { filter }));
            expect(await oq({ updatedBefore: t2 })).to.deep.equal([c1]);
            expect(await oq({ updatedAfter: t2 })).to.deep.equal([c2]);
            const plus = new Date(new Date(t2).getTime() + 1000).toISOString().replace('.000Z', 'Z');
            expect(await oq({ updatedAfter: plus })).to.deep.equal([]);
        });

        scenario('CARD-119', async () => {
            for (const filter of [
                { createdBefore: '2026-01-03' },
                { updatedAfter: 'yesterday' },
                { createdAfter: 1767225600 },
                { createdAfter: '2026-01-03T00:00:00+02:00' }
            ]) {
                await failsWith(call(c, 'ContactCard/query', { filter }), 'invalidArguments');
            }
        });

        scenario('CARD-120', async () => {
            expect(await q({ name: 'sarah' })).to.deep.equal(ids(s));
            expect(await q({ name: 'Johnson' })).to.deep.equal(ids(s));
            expect(await q({ name: 'López' })).to.deep.equal(ids(ca));
            expect(await q({ name: 'ACME' })).to.deep.equal(ids(ac));
            expect(await q({ name: 'Tallinn' })).to.deep.equal([]);
        });

        scenario('CARD-121', async () => {
            expect(await q({ 'name/given': 'Carlos' })).to.deep.equal(ids(ca));
            expect(await q({ 'name/given': 'García' })).to.deep.equal([]);
            expect(await q({ 'name/surname': 'García' })).to.deep.equal(ids(ca));
            expect(await q({ 'name/surname': 'López' })).to.deep.equal([]);
            expect(await q({ 'name/surname2': 'López' })).to.deep.equal(ids(ca));
            expect(await q({ 'name/surname2': 'García' })).to.deep.equal([]);
            expect(await q({ 'name/given': 'Carlos', 'name/surname': 'Johnson' })).to.deep.equal([]);
            expect(await q({ 'name/given': 'ACME' })).to.deep.equal([]);
        });

        scenario('CARD-122', async () => {
            expect(await q({ nickname: 'carlitos' })).to.deep.equal(ids(ca));
            expect(await q({ nickname: 'SJ' })).to.deep.equal(ids(s));
            expect(await q({ nickname: 'Sarah' })).to.deep.equal([]);
        });

        scenario('CARD-123', async () => {
            expect(await q({ organization: 'innovations' })).to.deep.equal(ids(s));
            expect(await q({ organization: 'Tech Innovations' })).to.deep.equal(ids(s));
            expect(await q({ organization: 'ACME' })).to.deep.equal([]);
        });

        scenario('CARD-124', async () => {
            expect(await q({ email: 'sarah.johnson@example.com' })).to.deep.equal(ids(s));
            expect(await q({ email: 'SARAH.JOHNSON@EXAMPLE.COM' })).to.deep.equal(ids(s));
            expect(await q({ email: 'example.org' })).to.deep.equal(ids(ca));
            expect(await q({ email: 'Work mail' })).to.deep.equal(ids(s));
            expect(await q({ email: 'nobody@example.com' })).to.deep.equal([]);
        });

        scenario('CARD-125', async () => {
            expect(await q({ phone: '+1-555-0100' })).to.deep.equal(ids(s));
            expect(await q({ phone: 'Desk' })).to.deep.equal(ids(s));
            expect(await q({ phone: '999' })).to.deep.equal([]);
        });

        scenario('CARD-126', async () => {
            const [mastodon] = await createCards(fx, [
                { onlineServices: { x1: { service: 'Mastodon', user: '@alice@example2.com', uri: 'https://example2.com/@alice', label: 'fediverse' } } }
            ]);
            try {
                for (const value of ['mastodon', '@alice@example2.com', 'https://example2.com/@alice', 'fediverse']) {
                    expect(await q({ onlineService: value }), value).to.deep.equal([mastodon]);
                }
                expect(await q({ onlineService: 'github' })).to.deep.equal(ids(ac));
                expect(await q({ onlineService: 'gitlab' })).to.deep.equal([]);
            } finally {
                await setCards(fx, { destroy: [mastodon] });
            }
        });

        scenario('CARD-127', async () => {
            const other = await h.createUser();
            const [first, second] = await createCards(other.client, [
                {
                    addresses: {
                        a1: {
                            components: [
                                { kind: 'name', value: 'Oak St' },
                                { kind: 'locality', value: 'Reston' },
                                { kind: 'region', value: 'VA' },
                                { kind: 'postcode', value: '20190' },
                                { kind: 'country', value: 'USA' }
                            ]
                        }
                    }
                },
                { addresses: { a1: { full: '2 rue de la Paix, 75002 Paris' } } }
            ]);
            const oq = async address => queryIds(other.client, { filter: { address } });
            expect(await oq('reston')).to.deep.equal([first]);
            expect(await oq('20190')).to.deep.equal([first]);
            expect(await oq('Paris')).to.deep.equal([second]);
            expect(await oq('rue de la Paix')).to.deep.equal([second]);
            expect(await oq('Berlin')).to.deep.equal([]);
        });

        scenario('CARD-128', async () => {
            const other = await h.createUser();
            const [cats, hats] = await createCards(other.client, [{ notes: { n: { note: 'cats and dogs' } } }, { notes: { n: { note: 'hats and bats' } } }]);
            const [plain] = await createCards(other.client, [{}]);
            const oq = async filter => sorted(await queryIds(other.client, { filter }));
            expect(await oq({ note: 'cats' })).to.deep.equal([cats]);
            expect(await oq({ note: 'cats dogs' })).to.deep.equal([cats]);
            expect(await oq({ note: 'cats bats' })).to.deep.equal([]);
            expect(await oq({ note: 'and' })).to.deep.equal(sorted([cats, hats]));
            expect(await oq({ operator: 'NOT', conditions: [{ note: 'cats dogs' }] })).to.deep.equal(sorted([hats, plain]));
        });

        scenario('CARD-129', async () => {
            for (const text of ['Sarah', 'tallinn', 'innovations', '+1-555-0100']) {
                expect(await q({ text }), text).to.deep.equal(ids(s));
            }
            for (const text of ['carlos@example.org', 'Madrid']) {
                expect(await q({ text }), text).to.deep.equal(ids(ca));
            }
            expect(await q({ text: 'acme-corp' })).to.deep.equal(ids(ac));
            expect(await q({ text: 'zebra' })).to.deep.equal([]);
        });

        scenario('CARD-130', async () => {
            expect(await q({ name: 'JOHNSON' })).to.deep.equal(ids(s));
            expect(await q({ note: 'CONFERENCE' })).to.deep.equal(ids(s));
            expect(await q({ text: 'garcía' })).to.deep.equal(ids(ca));
            expect(await q({ text: 'GARCÍA' })).to.deep.equal(ids(ca));
        });

        scenario('CARD-131', async () => {
            expect(await q({ text: 'sarah tallinn' })).to.deep.equal(ids(s));
            expect(await q({ text: 'tallinn   sarah' })).to.deep.equal(ids(s));
            expect(await q({ text: 'sarah madrid' })).to.deep.equal([]);
            expect(await q({ name: 'johnson sarah' })).to.deep.equal(ids(s));
        });

        scenario('CARD-132', async () => {
            const other = await h.createUser();
            const [first, second] = await createCards(other.client, [{ notes: { n: { note: 'cats and dogs' } } }, { notes: { n: { note: 'dogs and cats' } } }]);
            const oq = async note => queryIds(other.client, { filter: { note } });
            expect(await oq('"cats and dogs"')).to.deep.equal([first]);
            expect(await oq("'dogs and cats'")).to.deep.equal([second]);
            expect(await oq('"cats dogs"')).to.deep.equal([]);
            expect(await oq('"and dogs" cats')).to.deep.equal([first]);
        });

        scenario('CARD-133', async () => {
            const other = await h.createUser();
            const [card] = await createCards(other.client, [{ notes: { n: { note: 'She said "hello" at O\'Brien\'s; path C:\\temp.' } } }]);
            for (const note of ['"said \\"hello\\""', "'O\\'Brien\\'s'", '"C:\\\\temp"', '"hello']) {
                expect(await queryIds(other.client, { filter: { note } }), note).to.deep.equal([card]);
            }
        });

        scenario('CARD-134', async () => {
            for (const filter of [{ text: '' }, { name: '   ' }, { note: '' }]) {
                expect(await q(filter)).to.deep.equal(ids(s, ca, ac, te));
            }
        });

        scenario('CARD-135', async () => {
            const other = await h.createUser();
            const [rich, plain] = await createCards(other.client, [
                { notes: { n: { note: 'price is 5.00 (approx) [draft] a+b* $ref' } } },
                { notes: { n: { note: 'plain' } } }
            ]);
            for (const note of ['.*', '(approx)', 'a+b*', '$ref', '$where', '{"$ne": 1}']) {
                const found = await queryIds(other.client, { filter: { note } });
                expect(found.includes(plain), note).to.be.false;
                expect(found.length <= 1).to.be.true;
            }
            expect(await queryIds(other.client, { filter: { note: '(approx)' } })).to.deep.equal([rich]);
            await failsWith(call(other.client, 'ContactCard/query', { filter: { note: { $ne: 'x' } } }), 'invalidArguments');
        });

        scenario('CARD-136', async () => {
            const base = { inAddressBook: fixture.book, text: 'Sarah', uid: fixture.uids[0] };
            expect(await q(Object.assign({ email: 'sarah.johnson@example.com' }, base))).to.deep.equal(ids(s));
            expect(await q(Object.assign({ email: 'carlos@example.org' }, base))).to.deep.equal([]);
        });

        scenario('CARD-137', async () => {
            expect(await q({ operator: 'OR', conditions: [{ 'name/given': 'Sarah' }, { 'name/given': 'Carlos' }] })).to.deep.equal(ids(s, ca));
            expect(await q({ operator: 'AND', conditions: [{ kind: 'individual' }, { email: 'example.org' }] })).to.deep.equal(ids(ca));
            expect(await q({ operator: 'NOT', conditions: [{ kind: 'individual' }, { kind: 'group' }] })).to.deep.equal(ids(ac));
            expect(
                await q({
                    operator: 'AND',
                    conditions: [
                        { inAddressBook: fixture.book },
                        { operator: 'NOT', conditions: [{ operator: 'OR', conditions: [{ name: 'Sarah' }, { kind: 'org' }] }] }
                    ]
                })
            ).to.deep.equal(ids(ca, te));
            expect(await q({ operator: 'AND', conditions: [] })).to.deep.equal(ids(s, ca, ac, te));
        });

        scenario('CARD-138', async () => {
            for (const filter of [{ inCardGroup: ['x'] }, { isFavourite: true }]) {
                const err = await call(c, 'ContactCard/query', { filter }).then(
                    () => null,
                    error => error
                );
                expect(['unsupportedFilter', 'invalidArguments']).to.include(err && err.type);
            }
            for (const filter of [{ kind: 5 }, { hasMember: ['a'] }, { operator: 'XOR', conditions: [] }, { operator: 'AND' }]) {
                await failsWith(call(c, 'ContactCard/query', { filter }), 'invalidArguments');
            }
        });
    });

    describe('sorting and paging', () => {
        let dated;
        before(async () => {
            const other = await h.createUser();
            dated = { c: other.client };
            dated.ids = await createCards(other.client, [
                { created: '2026-01-01T00:00:00Z' },
                { created: '2026-01-02T00:00:00Z' },
                { created: '2026-01-03T00:00:00Z' },
                { created: '2026-01-04T00:00:00Z' }
            ]);
        });
        const byCreated = [{ property: 'created' }];

        scenario('CARD-139', async () => {
            const three = dated.ids.slice(0, 3);
            const filter = { createdBefore: '2026-01-04T00:00:00Z' };
            expect(await queryIds(dated.c, { filter, sort: [{ property: 'created' }] })).to.deep.equal(three);
            expect(await queryIds(dated.c, { filter, sort: [{ property: 'created', isAscending: true }] })).to.deep.equal(three);
            expect(await queryIds(dated.c, { filter, sort: [{ property: 'created', isAscending: false }] })).to.deep.equal([...three].reverse());
        });

        scenario('CARD-140', async () => {
            const other = await h.createUser();
            const created = [];
            for (let i = 0; i < 3; i++) {
                created.push((await createCard(other.client)).id);
                await h.delay(1100);
            }
            await updateCard(other.client, created[0], { 'name/full': 'Last change' });
            expect(await queryIds(other.client, { sort: [{ property: 'updated', isAscending: false }] })).to.deep.equal([created[0], created[2], created[1]]);
        });

        scenario('CARD-141', async () => {
            const other = await h.createUser();
            const person = (given, surname, surname2) => ({
                name: {
                    components: [
                        { kind: 'given', value: given },
                        { kind: 'surname', value: surname },
                        ...(surname2 ? [{ kind: 'surname2', value: surname2 }] : [])
                    ]
                }
            });
            const [zoe, adam, mia] = await createCards(other.client, [person('Zoe', 'Adams'), person('adam', 'Young', 'Ruiz'), person('Mia', 'brown', 'Alba')]);
            const sortBy = sort => queryIds(other.client, { filter: { kind: 'individual' }, sort });
            expect(await sortBy([{ property: 'name/given' }])).to.deep.equal([adam, mia, zoe]);
            expect(await sortBy([{ property: 'name/surname' }])).to.deep.equal([zoe, mia, adam]);
            expect(await sortBy([{ property: 'name/surname2', isAscending: false }])).to.deep.equal([adam, mia, zoe]);
        });

        scenario('CARD-142', async () => {
            const other = await h.createUser();
            const [x, y] = await createCards(other.client, [
                {
                    name: {
                        components: [
                            { kind: 'given', value: 'Mary' },
                            { kind: 'given', value: 'Ann' },
                            { kind: 'surname', value: 'Zed' }
                        ]
                    }
                },
                {
                    name: {
                        components: [
                            { kind: 'given', value: 'Nora' },
                            { kind: 'surname', value: 'Abel' }
                        ]
                    }
                }
            ]);
            expect(await queryIds(other.client, { sort: [{ property: 'name/given' }] })).to.deep.equal([x, y]);
        });

        scenario('CARD-143', async () => {
            const other = await h.createUser();
            const [x, y, z] = await createCards(other.client, [
                { name: { components: [{ kind: 'surname', value: 'van Gogh' }], sortAs: { surname: 'Gogh' } } },
                { name: { components: [{ kind: 'surname', value: 'Hals' }] } },
                { name: { components: [{ kind: 'surname', value: 'Monet' }] } }
            ]);
            expect(await queryIds(other.client, { sort: [{ property: 'name/surname' }] })).to.deep.equal([x, y, z]);
        });

        scenario('CARD-144', async () => {
            const other = await h.createUser();
            const person = (given, surname, day) => ({
                created: `2026-01-0${day}T00:00:00Z`,
                name: {
                    components: [
                        { kind: 'given', value: given },
                        { kind: 'surname', value: surname }
                    ]
                }
            });
            const [annLee, annKim, bobKim] = await createCards(other.client, [person('Ann', 'Lee', 3), person('Ann', 'Kim', 1), person('Bob', 'Kim', 2)]);
            const sort = [{ property: 'name/given' }, { property: 'created', isAscending: false }];
            expect(await queryIds(other.client, { sort })).to.deep.equal([annLee, annKim, bobKim]);
            const tied = await createCards(other.client, [person('Cy', 'Tie', 5), person('Cy', 'Tie', 5)]);
            const first = await queryIds(other.client, { sort });
            expect(await queryIds(other.client, { sort })).to.deep.equal(first);
            expect(first.slice(3).sort()).to.deep.equal(sorted(tied));
        });

        scenario('CARD-145', async () => {
            for (const sort of [
                [{ property: 'organization' }],
                [{ property: 'uid' }],
                [{ property: 'name' }],
                [{ property: 'created' }, { property: 'nonsense' }],
                [{ property: 'created', collation: 'i;nonsense' }]
            ]) {
                await failsWith(call(c, 'ContactCard/query', { sort }), 'unsupportedSort');
            }
        });

        scenario('CARD-146', async () => {
            const [c1, c2, c3, c4] = dated.ids;
            const query = args => call(dated.c, 'ContactCard/query', Object.assign({ sort: byCreated }, args));
            const a = await query({ limit: 2 });
            expect(a.ids).to.deep.equal([c1, c2]);
            expect(a.position).to.equal(0);
            const b = await query({ position: 2, limit: 2 });
            expect(b.ids).to.deep.equal([c3, c4]);
            expect(b.position).to.equal(2);
            const far = await query({ position: 10 });
            expect(far.ids).to.deep.equal([]);
            expect([4, 10]).to.include(far.position);
            const none = await query({ limit: 0, calculateTotal: true });
            expect(none.ids).to.deep.equal([]);
            expect(none.total).to.equal(4);
        });

        scenario('CARD-147', async () => {
            const [, , c3, c4] = dated.ids;
            const tail = await call(dated.c, 'ContactCard/query', { sort: byCreated, position: -2, limit: 2 });
            expect(tail.ids).to.deep.equal([c3, c4]);
            expect(tail.position).to.equal(2);
            const all = await call(dated.c, 'ContactCard/query', { sort: byCreated, position: -10 });
            expect(all.ids).to.deep.equal(dated.ids);
            expect(all.position).to.equal(0);
        });

        scenario('CARD-148', async () => {
            const [c1, c2, c3, c4] = dated.ids;
            const query = args => call(dated.c, 'ContactCard/query', Object.assign({ sort: byCreated }, args));
            const a = await query({ anchor: c3, anchorOffset: -1, limit: 2 });
            expect(a.ids).to.deep.equal([c2, c3]);
            expect(a.position).to.equal(1);
            const b = await query({ anchor: c2 });
            expect(b.ids[0]).to.equal(c2);
            expect(b.position).to.equal(1);
            const d = await query({ anchor: c1, anchorOffset: -5, limit: 2 });
            expect(d.ids).to.deep.equal([c1, c2]);
            expect(d.position).to.equal(0);
            await failsWith(query({ anchor: 'nosuchcard' }), 'anchorNotFound');
            await failsWith(query({ anchor: c4, filter: { createdBefore: '2026-01-04T00:00:00Z' } }), 'anchorNotFound');
        });

        scenario('CARD-149', async () => {
            const withTotal = await call(fx, 'ContactCard/query', { filter: { kind: 'individual' }, limit: 1, calculateTotal: true });
            expect(withTotal.ids).to.have.length(1);
            expect(withTotal.total).to.equal(2);
            const without = await call(fx, 'ContactCard/query', { filter: { kind: 'individual' }, limit: 1 });
            expect(without).to.not.have.property('total');
        });

        scenario('CARD-150', async () => {
            const other = await h.createUser();
            const url = await h.startInstance({}, { maxObjectsInGet: 5 });
            const oc = await h.clientOn(url, other);
            await createCards(
                oc,
                Array.from({ length: 7 }, () => ({}))
            );
            const res = await call(oc, 'ContactCard/query', { limit: 1005 });
            expect(res.ids).to.have.length(5);
            expect(res.limit).to.equal(5);
            await failsWith(call(oc, 'ContactCard/query', { limit: -1 }), 'invalidArguments');
        });

        scenario('CARD-151', async () => {
            const other = await h.createUser();
            await createCards(other.client, [{}]);
            const first = await call(other.client, 'ContactCard/query', {});
            expect((await call(other.client, 'ContactCard/query', {})).queryState).to.equal(first.queryState);
            await createBook(other.client);
            expect((await call(other.client, 'ContactCard/query', {})).queryState).to.equal(first.queryState);
            await createCards(other.client, [{}]);
            expect((await call(other.client, 'ContactCard/query', {})).queryState).to.not.equal(first.queryState);
        });

        scenario('CARD-152', async () => {
            const responses = await h.calls(fx, [
                ['ContactCard/query', { accountId: fx.accountId, filter: { kind: 'group' } }, 'q'],
                [
                    'ContactCard/get',
                    { accountId: fx.accountId, '#ids': { resultOf: 'q', name: 'ContactCard/query', path: '/ids' }, properties: ['name', 'members'] },
                    'g'
                ]
            ]);
            const list = responses[1][1].list;
            expect(list).to.have.length(1);
            expect(list[0]).to.deep.equal({ id: fixture.ids[te], name: { full: 'Team' }, members: { [fixture.uids[0]]: true, [fixture.uids[1]]: true } });
        });
    });

    describe('ContactCard/queryChanges', () => {
        scenario('CARD-153', async () => {
            const book = (await defaultBook(c)).id;
            for (const args of [
                { filter: { inAddressBook: book }, sort: [{ property: 'created' }] },
                { filter: { text: 'x' } },
                { sort: [{ property: 'name/surname' }] }
            ]) {
                expect((await call(c, 'ContactCard/query', args)).canCalculateChanges).to.equal(true);
            }
        });

        scenario('CARD-154', async () => {
            const args = { filter: { inAddressBook: fixture.book }, sort: [{ property: 'created' }] };
            const { queryState } = await call(fx, 'ContactCard/query', args);
            const res = await call(fx, 'ContactCard/queryChanges', Object.assign({ sinceQueryState: queryState }, args));
            expect(res).to.deep.include({ oldQueryState: queryState, newQueryState: queryState, removed: [], added: [] });
        });

        scenario('CARD-155', async () => {
            const other = await h.createUser();
            const oc = other.client;
            const b = await createBook(oc);
            const b2 = await createBook(oc);
            const args = { filter: { inAddressBook: b }, sort: [{ property: 'created' }] };
            const [c1] = await createCards(oc, [{ created: '2026-01-01T00:00:00Z' }], b);
            const { queryState } = await call(oc, 'ContactCard/query', args);
            const [c2] = await createCards(oc, [{ created: '2026-01-02T00:00:00Z' }], b);
            const [c3] = await createCards(oc, [{}], b2);
            const res = await call(oc, 'ContactCard/queryChanges', Object.assign({ sinceQueryState: queryState, calculateTotal: true }, args));
            expect(res.added).to.deep.equal([{ id: c2, index: 1 }]);
            expect(res.removed).to.not.include(c1);
            expect(JSON.stringify(res)).to.not.include(c3);
            expect(res.total).to.equal(2);
            expect(res.newQueryState).to.not.equal(queryState);
        });

        scenario('CARD-156', async () => {
            const other = await h.createUser();
            const oc = other.client;
            const b1 = await createBook(oc);
            const b2 = await createBook(oc);
            const [c1, c2, c3] = await createCards(oc, [{}, {}, {}], b1);
            const args = { filter: { inAddressBook: b1 } };
            const { queryState } = await call(oc, 'ContactCard/query', args);
            await setCards(oc, { destroy: [c1], update: { [c2]: { addressBookIds: { [b2]: true } } } });
            const res = await call(oc, 'ContactCard/queryChanges', Object.assign({ sinceQueryState: queryState }, args));
            expect(res.removed).to.include.members([c1, c2]);
            const added = res.added.map(item => item.id);
            expect(added).to.not.include.members([c1, c2]);
            expect(res.removed.includes(c3)).to.equal(added.includes(c3));
        });

        scenario('CARD-157', async () => {
            const other = await h.createUser();
            const oc = other.client;
            const surname = value => ({ name: { components: [{ kind: 'surname', value }] } });
            const [adams, brown, young] = await createCards(oc, [surname('Adams'), surname('Brown'), surname('Young')]);
            const args = { sort: [{ property: 'name/surname' }] };
            const first = await call(oc, 'ContactCard/query', args);
            expect(first.ids).to.deep.equal([adams, brown, young]);
            await updateCard(oc, adams, { 'name/components/0/value': 'Zimmer' });
            const res = await call(oc, 'ContactCard/queryChanges', Object.assign({ sinceQueryState: first.queryState }, args));
            expect(res.removed).to.include(adams);
            expect(res.added).to.deep.include({ id: adams, index: 2 });
            const list = first.ids.filter(id => !res.removed.includes(id));
            for (const item of res.added) {
                list.splice(item.index, 0, item.id);
            }
            expect(list).to.deep.equal([brown, young, adams]);
        });

        scenario('CARD-158', async () => {
            const other = await h.createUser();
            const oc = other.client;
            const [first] = await createCards(oc, [{ created: '2020-01-01T00:00:00Z' }]);
            const args = { sort: [{ property: 'created' }] };
            const { queryState } = await call(oc, 'ContactCard/query', args);
            const ids = await createCards(
                oc,
                Array.from({ length: 10 }, () => ({}))
            );
            await failsWith(call(oc, 'ContactCard/queryChanges', Object.assign({ sinceQueryState: queryState, maxChanges: 3 }, args)), 'tooManyChanges');
            const res = await call(oc, 'ContactCard/queryChanges', Object.assign({ sinceQueryState: queryState, upToId: first }, args));
            // the new cards sort after upToId, so they may be left out; nothing before it changed
            expect(res.removed).to.deep.equal([]);
            res.added.forEach(item => expect(ids).to.include(item.id));
        });

        scenario('CARD-159', async () => {
            await failsWith(call(c, 'ContactCard/queryChanges', { sinceQueryState: 'bogus' }), 'cannotCalculateChanges');
            // a state whose cached result list is gone (expired)
            const { queryState } = await call(c, 'ContactCard/query', {});
            const redis = new Redis(typeof config.dbs.redis === 'string' ? redisUrl(config.dbs.redis) : config.dbs.redis);
            try {
                // the cached lists of a user are fields of one hash, keyed by query state
                const accountId = (await call(c, 'ContactCard/get', { ids: [] })).accountId;
                expect(await redis.hdel(`jmap:qc:${accountId.slice(1)}`, queryState)).to.equal(1);
            } finally {
                redis.disconnect();
            }
            await failsWith(call(c, 'ContactCard/queryChanges', { sinceQueryState: queryState }), 'cannotCalculateChanges');
        });

        scenario('CARD-174', async () => {
            const other = await h.createUser();
            const url = await h.startInstance({ maxAddressBooksPerCard: 3 });
            const oc = await h.clientOn(url, other);
            const b1 = await createBook(oc);
            const b2 = await createBook(oc);
            const ux = `urn:uuid:${crypto.randomUUID()}`;
            const uy = `urn:uuid:${crypto.randomUUID()}`;
            const [x] = await createCards(oc, [{ uid: ux }], b1);
            const [y] = await createCards(oc, [{ uid: uy }], b2);
            const group = await createCard(oc, {
                addressBookIds: { [b1]: true },
                kind: 'group',
                members: { [ux]: true, [uy]: true, 'urn:uuid:missing': true }
            });
            const members = Object.keys((await getCard(oc, group.id)).members);
            const resolved = {};
            for (const uid of members) {
                resolved[uid] = await queryIds(oc, { filter: { uid } });
            }
            expect(resolved).to.deep.equal({ [ux]: [x], [uy]: [y], 'urn:uuid:missing': [] });
            const either = await queryIds(oc, { filter: { operator: 'OR', conditions: members.map(uid => ({ uid })) } });
            expect(sorted(either)).to.deep.equal(sorted([x, y]));
        });
    });

    describe('register cards in queries', () => {
        it('register cards match the filters of their name and address', async () => {
            const user = await h.createUser();
            const address = `query.reg.${Date.now()}@example.com`;
            await h.registerEntry(user, 'Query Register', address);
            const [id] = await queryIds(user.client, { filter: { inAddressBook: REGISTER_ID } });
            expect(await queryIds(user.client, { filter: { email: address } })).to.deep.equal([id]);
            expect(await queryIds(user.client, { filter: { name: 'register' } })).to.deep.equal([id]);
            expect(await queryIds(user.client, { filter: { kind: 'individual' } })).to.include(id);
        });
    });
});
