/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before, after */
'use strict';

// Catalogue file contacts.yaml, part 3: ContactCard/set updates and destroys, the register cards,
// ContactCard/changes, ContactCard/copy, push and group cards (CARD-077 to CARD-110, CARD-160 to CARD-176).

const crypto = require('crypto');
const { expect } = require('chai');
const { scenario, seed, jmap } = require('../harness');
const sse = require('../harness/sse');
const instance = require('../harness/instance');
const h = require('./contacts-helpers');

const { REGISTER_ID } = h;
const { call, failsWith, defaultBook, createBook, createCard, getCard, setCards, updateCard, updateFails, cardState, bookState } = h;

after(() => instance.stopAll());

const uuid = () => `urn:uuid:${crypto.randomUUID()}`;

describe('ContactCard update, changes and groups (contacts.yaml)', function () {
    this.timeout(60000);
    let user;
    let c;
    let book;

    before(async () => {
        user = await h.createUser();
        c = user.client;
        book = (await defaultBook(c)).id;
    });

    describe('patches', () => {
        scenario('CARD-077', async () => {
            const card = await createCard(c, { name: { full: 'Old Name' }, emails: { e1: { address: 'old@example.com' } } });
            const res = await updateCard(c, card.id, { 'name/full': 'Changes Test Updated' });
            expect(res.newState).to.not.equal(res.oldState);
            const got = await getCard(c, card.id);
            expect(got.name.full).to.equal('Changes Test Updated');
            expect(got.emails).to.deep.equal({ e1: { address: 'old@example.com' } });
        });

        scenario('CARD-078', async () => {
            const card = await createCard(c, { emails: { e1: { address: 'e1@example.com' } }, phones: { p0: { number: '+1 555 0000' } } });
            await updateCard(c, card.id, {
                'emails/home1': { address: 'home@example.com', contexts: { private: true } },
                'phones/p1': { number: '+1 555 0100' }
            });
            const got = await getCard(c, card.id);
            expect(got.emails).to.deep.equal({ e1: { address: 'e1@example.com' }, home1: { address: 'home@example.com', contexts: { private: true } } });
            expect(got.phones).to.deep.equal({ p0: { number: '+1 555 0000' }, p1: { number: '+1 555 0100' } });
        });

        scenario('CARD-079', async () => {
            const card = await createCard(c, {
                name: {
                    components: [
                        { kind: 'given', value: 'Sarah' },
                        { kind: 'surname', value: 'Johnson' }
                    ]
                }
            });
            await updateCard(c, card.id, { 'name/components/1/value': "O'Connor", 'name/full': "Sarah O'Connor" });
            expect((await getCard(c, card.id)).name).to.deep.equal({
                components: [
                    { kind: 'given', value: 'Sarah' },
                    { kind: 'surname', value: "O'Connor" }
                ],
                full: "Sarah O'Connor"
            });
        });

        scenario('CARD-080', async () => {
            const card = await createCard(c, {
                nicknames: { k1: { name: 'Charlie' } },
                emails: { e1: { address: 'e1@example.com' }, e2: { address: 'e2@example.com' } },
                notes: { n1: { note: 'note' } },
                keywords: { B2B: true, old: true }
            });
            await updateCard(c, card.id, {
                'nicknames/k1': null,
                'nicknames/k2': { name: 'Carlitos' },
                'emails/e2': null,
                notes: null,
                'keywords/old': null,
                'keywords/B2C': true,
                'emails/e1/label': null
            });
            const got = await getCard(c, card.id);
            expect(got.nicknames).to.deep.equal({ k2: { name: 'Carlitos' } });
            expect(got.emails).to.deep.equal({ e1: { address: 'e1@example.com' } });
            expect(got).to.not.have.property('notes');
            expect(got.keywords).to.deep.equal({ B2B: true, B2C: true });
            await updateFails(c, card.id, { 'keywords/B2B': false }, 'invalidProperties', 'keywords/B2B');
        });

        scenario('CARD-081', async () => {
            const card = await createCard(c, {
                name: { full: 'A' },
                emails: { e1: { address: 'e1@example.com' }, e2: { address: 'e2@example.com' } },
                notes: { n1: { note: 'x' } }
            });
            const name = {
                components: [
                    { kind: 'given', value: 'New' },
                    { kind: 'surname', value: 'Person' }
                ],
                isOrdered: true
            };
            await updateCard(c, card.id, { name, emails: { only1: { address: 'only@example.com' } }, notes: { n9: { note: 'replaced' } } });
            const got = await getCard(c, card.id);
            expect(got.name).to.deep.equal(name);
            expect(got.emails).to.deep.equal({ only1: { address: 'only@example.com' } });
            expect(got.notes).to.deep.equal({ n9: { note: 'replaced' } });
        });

        scenario('CARD-082', async () => {
            const card = await createCard(c, { name: { full: 'A' }, emails: { e1: { address: 'a@example.com' } } });
            const state = await cardState(c);
            const before = await getCard(c, card.id);
            const cases = [
                [{ 'emails/e1/address': null }, ['emails/e1/address']],
                [{ 'name/full': null }, ['name', 'name/full']],
                [{ kind: 'bogus' }, ['kind']],
                [{ 'emails/e1/pref': 500 }, ['emails/e1/pref']],
                [{ members: { 'urn:uuid:x': true } }, ['members']]
            ];
            for (const [patch, properties] of cases) {
                const error = await updateFails(c, card.id, patch, 'invalidProperties');
                expect(
                    error.properties.some(property => properties.includes(property)),
                    JSON.stringify(error)
                ).to.be.true;
            }
            expect(await getCard(c, card.id)).to.deep.equal(before);
            expect(await cardState(c)).to.equal(state);
        });

        scenario('CARD-083', async () => {
            const card = await createCard(c, {
                name: {
                    components: [
                        { kind: 'given', value: 'A' },
                        { kind: 'surname', value: 'B' }
                    ]
                }
            });
            const before = await getCard(c, card.id);
            for (const patch of [
                { 'phones/p1/number': '1' },
                { 'name/components/5/value': 'x' },
                { 'name/components/-': { kind: 'given', value: 'x' } },
                { 'name/components/0': null },
                { name: { full: 'x' }, 'name/full': 'y' },
                { 'name//full': 'x' }
            ]) {
                await updateFails(c, card.id, patch, 'invalidPatch');
            }
            expect(await getCard(c, card.id)).to.deep.equal(before);
        });

        scenario('CARD-084', async () => {
            // the emails map exists, so the patch applies and the result is judged (else it is invalidPatch)
            const card = await createCard(c, { name: { full: 'Before' }, emails: { e0: { address: 'e0@example.com' } } });
            await updateFails(c, card.id, { 'name/full': 'After', 'emails/e1': { address: 5 } }, 'invalidProperties', 'emails/e1/address');
            expect((await getCard(c, card.id)).name.full).to.equal('Before');
        });

        scenario('CARD-085', async () => {
            const card = await createCard(c, { relatedTo: { 'a/b~c': { relation: { friend: true } } }, keywords: { 'cost/benefit': true, keep: true } });
            await updateCard(c, card.id, { 'relatedTo/a~1b~0c/relation/colleague': true, 'keywords/cost~1benefit': null });
            const got = await getCard(c, card.id);
            expect(got.relatedTo['a/b~c'].relation).to.deep.equal({ friend: true, colleague: true });
            expect(got.keywords).to.deep.equal({ keep: true });
        });

        scenario('CARD-086', async () => {
            const card = await createCard(c);
            const s = await cardState(c);
            const full = await getCard(c, card.id);
            for (const patch of [{}, full]) {
                const res = await setCards(c, { update: { [card.id]: patch } });
                expect(res.updated).to.have.property(card.id);
            }
            expect(await cardState(c)).to.equal(s);
            expect((await getCard(c, card.id)).updated).to.equal(full.updated);
            const changes = await call(c, 'ContactCard/changes', { sinceState: s });
            expect([...changes.created, ...changes.updated, ...changes.destroyed]).to.deep.equal([]);
        });

        scenario('CARD-087', async () => {
            const res = await setCards(c, { update: { nosuchcard: { 'name/full': 'x' } } });
            expect(res.notUpdated.nosuchcard.type).to.equal('notFound');
        });
    });

    describe('address books of a card', () => {
        scenario('CARD-088', async () => {
            const b1 = await createBook(c);
            const b2 = await createBook(c);
            const card = await createCard(c, { addressBookIds: { [b1]: true } });
            const s = await cardState(c);
            await updateCard(c, card.id, { addressBookIds: { [b2]: true } });
            const got = await getCard(c, card.id);
            expect(got.id).to.equal(card.id);
            expect(got.uid).to.equal(card.uid);
            expect(got.addressBookIds).to.deep.equal({ [b2]: true });
            expect(await h.queryIds(c, { filter: { inAddressBook: b1 } })).to.not.include(card.id);
            expect(await h.queryIds(c, { filter: { inAddressBook: b2 } })).to.include(card.id);
            const changes = await call(c, 'ContactCard/changes', { sinceState: s });
            expect(changes).to.deep.include({ created: [], updated: [card.id], destroyed: [] });
        });

        scenario('CARD-089', async () => {
            const other = await h.createUser();
            const url = await h.startInstance({ maxAddressBooksPerCard: 3 });
            const oc = await h.clientOn(url, other);
            const [b1, b2] = [await createBook(oc), await createBook(oc), await createBook(oc)];
            const card = await createCard(oc, { addressBookIds: { [b1]: true } });
            await updateCard(oc, card.id, { [`addressBookIds/${b2}`]: true });
            expect((await getCard(oc, card.id)).addressBookIds).to.deep.equal({ [b1]: true, [b2]: true });
            await updateCard(oc, card.id, { [`addressBookIds/${b1}`]: null });
            expect((await getCard(oc, card.id)).addressBookIds).to.deep.equal({ [b2]: true });
        });

        scenario('CARD-090', async () => {
            const b1 = await createBook(c);
            const card = await createCard(c, { addressBookIds: { [b1]: true } });
            for (const patch of [
                { [`addressBookIds/${b1}`]: null },
                { addressBookIds: {} },
                { addressBookIds: null },
                { [`addressBookIds/${b1}`]: false },
                { 'addressBookIds/nosuchbook': true }
            ]) {
                await updateFails(c, card.id, patch, 'invalidProperties', 'addressBookIds');
            }
            expect((await getCard(c, card.id)).addressBookIds).to.deep.equal({ [b1]: true });
        });

        scenario('CARD-091', async () => {
            const card = await createCard(c);
            const s = await cardState(c);
            const s2 = (await setCards(jmap.forUser(user), { create: { k: { addressBookIds: { [book]: true } } } })).newState;
            await failsWith(setCards(c, { ifInState: s, update: { [card.id]: { 'name/full': 'Nope' } } }), 'stateMismatch');
            expect((await getCard(c, card.id)).name.full).to.equal('Test Contact');
            const res = await setCards(c, { ifInState: s2, update: { [card.id]: { 'name/full': 'Yes' } } });
            expect(res.oldState).to.equal(s2);
        });

        scenario('CARD-092', async () => {
            const s = await cardState(c);
            const res = await setCards(c, { create: { k: { addressBookIds: { [book]: true } } } });
            expect(res.oldState).to.equal(s);
            expect(res.newState).to.equal(await cardState(c));
            const failing = await setCards(c, { create: { k: { addressBookIds: {} } } });
            expect(failing.newState).to.equal(failing.oldState);
        });

        scenario('CARD-093', async () => {
            const card = await createCard(c, { name: { full: 'A' } });
            const s = await cardState(c);
            const results = await Promise.all([
                setCards(c, { update: { [card.id]: { 'name/full': 'B' } } }),
                setCards(jmap.forUser(user), { update: { [card.id]: { notes: { n1: { note: 'hello' } } } } })
            ]);
            results.forEach(res => expect(res.updated).to.have.property(card.id));
            const got = await getCard(c, card.id);
            expect(got.name.full).to.equal('B');
            expect(got.notes).to.deep.equal({ n1: { note: 'hello' } });
            const changes = await call(c, 'ContactCard/changes', { sinceState: s });
            expect(changes.updated).to.deep.equal([card.id]);
            expect(parseInt(changes.newState.slice(1), 36)).to.be.at.least(parseInt(s.slice(1), 36) + 2);
        });
    });

    describe('destroy', () => {
        scenario('CARD-094', async () => {
            const card = await createCard(c);
            const res = await setCards(c, { destroy: [card.id] });
            expect(res.destroyed).to.deep.equal([card.id]);
            expect(res.newState).to.not.equal(res.oldState);
            expect((await call(c, 'ContactCard/get', { ids: [card.id] })).notFound).to.deep.equal([card.id]);
            expect(await h.queryIds(c, {})).to.not.include(card.id);
        });

        scenario('CARD-095', async () => {
            const card = await createCard(c);
            await setCards(c, { destroy: [card.id] });
            const res = await setCards(c, { destroy: [card.id, 'nosuchcard'] });
            expect(res.notDestroyed[card.id].type).to.equal('notFound');
            expect(res.notDestroyed.nosuchcard.type).to.equal('notFound');
            expect(res.newState).to.equal(res.oldState);
        });

        scenario('CARD-096', async () => {
            const other = await h.createUser();
            const url = await h.startInstance({ maxAddressBooksPerCard: 3 });
            const oc = await h.clientOn(url, other);
            const b1 = await createBook(oc);
            const b2 = await createBook(oc);
            const card = await createCard(oc, { addressBookIds: { [b1]: true, [b2]: true } });
            await setCards(oc, { destroy: [card.id] });
            expect(await h.queryIds(oc, { filter: { inAddressBook: b1 } })).to.deep.equal([]);
            expect(await h.queryIds(oc, { filter: { inAddressBook: b2 } })).to.deep.equal([]);
        });

        scenario('CARD-097', async () => {
            const [x, y] = await h.createCards(c, [{}, {}]);
            const res = await setCards(c, {
                create: { n: { addressBookIds: { [book]: true } } },
                update: { [x]: { 'name/full': 'X' } },
                destroy: [y]
            });
            const changes = await call(c, 'ContactCard/changes', { sinceState: res.oldState });
            expect(changes.created).to.deep.equal([res.created.n.id]);
            expect(changes.updated).to.deep.equal([x]);
            expect(changes.destroyed).to.deep.equal([y]);
            expect(changes.newState).to.equal(res.newState);
        });
    });

    describe('the address register', () => {
        scenario('CARD-098', async () => {
            const other = await h.createUser();
            const address = `jane.roe.${Date.now()}@example.com`;
            await h.registerEntry(other, 'Jane Roe', address);
            const ids = await h.queryIds(other.client, { filter: { inAddressBook: REGISTER_ID } });
            expect(ids).to.have.length(1);
            const card = await getCard(other.client, ids[0]);
            expect(card.addressBookIds).to.deep.equal({ [REGISTER_ID]: true });
            expect(card).to.include({ '@type': 'Card', version: '1.0' });
            expect(card.uid).to.be.a('string');
            expect(card.kind === undefined || card.kind === 'individual').to.be.true;
            expect(card.name).to.deep.equal({ full: 'Jane Roe' });
            expect(Object.values(card.emails).map(email => email.address)).to.deep.equal([address]);
            const again = await getCard(other.client, ids[0]);
            expect(again.uid).to.equal(card.uid);
            expect(await h.queryIds(other.client, { filter: { inAddressBook: REGISTER_ID } })).to.deep.equal(ids);
        });

        scenario('CARD-099', async () => {
            const other = await h.createUser();
            const oc = other.client;
            const s = await cardState(oc);
            const address = `new.person.${Date.now()}@example.net`;
            const boxes = await oc.method('Mailbox/get', {});
            const drafts = boxes.list.find(box => box.role === 'drafts').id;
            const identity = (await oc.method('Identity/get', {}, [jmap.URN.core, jmap.URN.mail, jmap.URN.submission])).list[0].id;
            const responses = await oc.call(
                [
                    [
                        'Email/set',
                        {
                            accountId: oc.accountId,
                            create: {
                                d: {
                                    mailboxIds: { [drafts]: true },
                                    from: [{ email: other.address }],
                                    to: [{ name: 'New Person', email: address }],
                                    subject: 'hello',
                                    bodyValues: { b: { value: 'hi' } },
                                    textBody: [{ partId: 'b', type: 'text/plain' }]
                                }
                            }
                        },
                        'a'
                    ],
                    ['EmailSubmission/set', { accountId: oc.accountId, create: { s: { identityId: identity, emailId: '#d' } } }, 'b']
                ],
                [jmap.URN.core, jmap.URN.mail, jmap.URN.submission]
            );
            expect(responses[1][1].created).to.have.property('s');
            let ids = [];
            for (let i = 0; i < 50 && !ids.length; i++) {
                ids = await h.queryIds(oc, { filter: { inAddressBook: REGISTER_ID, email: address } });
                if (!ids.length) {
                    await h.delay(100);
                }
            }
            expect(ids).to.have.length(1);
            const changes = await h.allChanges(oc, 'ContactCard', s);
            expect(changes.created).to.include(ids[0]);
            expect(changes.newState).to.not.equal(s);
        });

        scenario('CARD-100', async () => {
            const other = await h.createUser();
            const address = `jane.roe.${Date.now()}@example.com`;
            await h.registerEntry(other, 'Jane Roe', address);
            await h.delay(300);
            const [id] = await h.queryIds(other.client, { filter: { inAddressBook: REGISTER_ID } });
            const s = await cardState(other.client);
            await h.api('POST', `/users/${other.id}/submit`, {
                to: [{ name: 'Jane R.', address: address.replace('jane.roe', 'Jane.Roe').replace('example.com', 'Example.com') }],
                subject: 'again',
                text: 'x'
            });
            let changes;
            for (let i = 0; i < 50; i++) {
                changes = await call(other.client, 'ContactCard/changes', { sinceState: s });
                if (changes.updated.length) {
                    break;
                }
                await h.delay(100);
            }
            const ids = await h.queryIds(other.client, { filter: { inAddressBook: REGISTER_ID } });
            expect(ids).to.deep.equal([id]);
            expect(changes.created).to.not.include(id);
            expect(changes.updated).to.include(id);
            expect((await getCard(other.client, id)).name.full).to.equal('Jane R.');
        });

        scenario('CARD-101', async () => {
            const other = await h.createUser();
            const address = `reg101.${Date.now()}@example.com`;
            await h.registerEntry(other, 'Reg', address);
            const [x] = await h.queryIds(other.client, { filter: { inAddressBook: REGISTER_ID } });
            const b = (await defaultBook(other.client)).id;
            for (const patch of [{ 'name/full': 'Edited' }, { addressBookIds: { [b]: true } }, { [`addressBookIds/${b}`]: true }]) {
                await updateFails(other.client, x, patch, 'forbidden');
            }
            const res = await setCards(other.client, { destroy: [x] });
            expect(res.notDestroyed[x].type).to.equal('forbidden');
            const entry = await h.waitRegister(other, address);
            expect(entry.name).to.equal('Reg');
        });

        scenario('CARD-102', async () => {
            const card = await createCard(c);
            for (const patch of [{ addressBookIds: { [REGISTER_ID]: true } }, { [`addressBookIds/${REGISTER_ID}`]: true }]) {
                await updateFails(c, card.id, patch, 'forbidden');
            }
            expect((await getCard(c, card.id)).addressBookIds).to.deep.equal({ [book]: true });
        });

        scenario('CARD-103', async () => {
            const other = await h.createUser();
            await h.registerEntry(other, 'Uid Owner', `uid103.${Date.now()}@example.com`);
            const [id] = await h.queryIds(other.client, { filter: { inAddressBook: REGISTER_ID } });
            const { uid } = await getCard(other.client, id);
            await h.createFails(other.client, { uid }, 'invalidProperties', 'uid');
        });
    });

    describe('ContactCard/changes', () => {
        scenario('CARD-104', async () => {
            const s = await cardState(c);
            const res = await call(c, 'ContactCard/changes', { sinceState: s });
            expect(res).to.deep.include({ accountId: c.accountId, oldState: s, newState: s, hasMoreChanges: false, created: [], updated: [], destroyed: [] });
        });

        scenario('CARD-105', async () => {
            const [x, y] = await h.createCards(c, [{}, {}]);
            const s = await cardState(c);
            const n = await createCard(c);
            await updateCard(c, x, { 'name/full': 'X' });
            await setCards(c, { destroy: [y] });
            const res = await call(c, 'ContactCard/changes', { sinceState: s });
            expect(res).to.deep.include({ created: [n.id], updated: [x], destroyed: [y], hasMoreChanges: false });
            expect(res.newState).to.equal(await cardState(c));
        });

        scenario('CARD-106', async () => {
            const x = await createCard(c);
            const s = await cardState(c);
            for (const value of ['1', '2', '3']) {
                await updateCard(c, x.id, { 'name/full': value });
            }
            const t = await createCard(c);
            await updateCard(c, t.id, { 'name/full': 'T' });
            await setCards(c, { destroy: [t.id] });
            const res = await call(c, 'ContactCard/changes', { sinceState: s });
            expect(res.updated.filter(id => id === x.id)).to.have.length(1);
            expect(res.created).to.not.include(t.id);
            expect(res.updated).to.not.include(t.id);
        });

        scenario('CARD-107', async () => {
            const other = await h.createUser();
            const oc = other.client;
            const s = await cardState(oc);
            const ids = await h.createCards(
                oc,
                Array.from({ length: 25 }, () => ({}))
            );
            for (const id of ids.slice(0, 5)) {
                await updateCard(oc, id, { 'name/full': 'Updated' });
            }
            await setCards(oc, { destroy: ids.slice(20) });
            const all = await h.allChanges(oc, 'ContactCard', s, 7);
            for (const page of all.pages) {
                expect(page.created.length + page.updated.length + page.destroyed.length).to.be.at.most(7);
            }
            // applied in order, the pages give the 20 surviving cards: a card changed after its creation is
            // reported at its last change, on a later page as updated, and the client fetches it then
            const known = new Set();
            for (const page of all.pages) {
                page.created.forEach(id => known.add(id));
                page.updated.forEach(id => known.add(id));
                page.destroyed.forEach(id => known.delete(id));
            }
            expect(all.created.filter(id => all.destroyed.includes(id))).to.deep.equal([]);
            expect([...known].sort()).to.deep.equal(ids.slice(0, 20).sort());
            expect(all.newState).to.equal(await cardState(oc));
        });

        scenario('CARD-108', async () => {
            const card = await createCard(c);
            const s = await cardState(c);
            const future = s.replace(/^o([0-9a-z]+)\./, (all, seq) => `o${(parseInt(seq, 36) + 100).toString(36)}.`);
            for (const sinceState of ['bogus', future]) {
                await failsWith(call(c, 'ContactCard/changes', { sinceState }), 'cannotCalculateChanges');
            }
            // a state older than the retention whose tombstones are purged
            const db = await seed.db();
            const userId = new seed.ObjectId(user.id);
            const stateDoc = await db.collection('jmap.state').findOne({ _id: userId });
            await db.collection('jmap.state').updateOne({ _id: userId }, { $set: { 'seqTime.ContactCard': new Date(Date.now() - 40 * 24 * 3600 * 1000) } });
            const old = await cardState(c);
            await db.collection('jmap.state').updateOne({ _id: userId }, { $set: { 'seqTime.ContactCard': stateDoc.seqTime.ContactCard } });
            await setCards(c, { destroy: [card.id] });
            await db.collection('jmap.changes').deleteMany({ user: userId, type: 'ContactCard' });
            await failsWith(call(c, 'ContactCard/changes', { sinceState: old }), 'cannotCalculateChanges');
        });

        scenario('CARD-109', async () => {
            const b2 = await createBook(c);
            const card = await createCard(c);
            const [s, bs] = [await cardState(c), await bookState(c)];
            await updateCard(c, card.id, { addressBookIds: { [b2]: true } });
            expect(await call(c, 'ContactCard/changes', { sinceState: s })).to.deep.include({ created: [], updated: [card.id], destroyed: [] });
            expect(await call(c, 'AddressBook/changes', { sinceState: bs })).to.deep.include({ created: [], updated: [], destroyed: [] });
        });

        scenario('CARD-110', async () => {
            await createCard(c);
            const s = await cardState(c);
            // another worker: a second service instance on the same databases
            const url = await h.startInstance();
            const other = await h.clientOn(url, user);
            expect(await cardState(other)).to.equal(s);
            // a restart: a fresh instance knows nothing the first one kept in memory
            await instance.stopAll();
            const restarted = await h.clientOn(await h.startInstance(), user);
            expect(await cardState(restarted)).to.equal(s);
            const res = await call(restarted, 'ContactCard/changes', { sinceState: s });
            expect([...res.created, ...res.updated, ...res.destroyed]).to.deep.equal([]);
        });
    });

    describe('ContactCard/copy', () => {
        scenario('CARD-160', async () => {
            const b = await h.createUser();
            const card = await createCard(b.client);
            const s = await cardState(c);
            await failsWith(call(c, 'ContactCard/copy', { fromAccountId: 'nosuchaccount', create: {} }), 'fromAccountNotFound');
            await failsWith(
                call(c, 'ContactCard/copy', { fromAccountId: b.accountId, create: { k: { id: card.id, addressBookIds: { [book]: true } } } }),
                'fromAccountNotFound'
            );
            expect(await cardState(c)).to.equal(s);
            expect(await getCard(b.client, card.id)).to.exist;
        });

        scenario('CARD-161', async () => {
            const b = await h.createUser();
            for (const accountId of [b.accountId, 'nosuchaccount']) {
                await failsWith(call(c, 'ContactCard/copy', { fromAccountId: c.accountId, accountId, create: {} }), 'accountNotFound');
            }
        });

        scenario('CARD-162', async () => {
            const card = await createCard(c);
            const before = (await h.queryIds(c, {})).length;
            await failsWith(
                call(c, 'ContactCard/copy', { fromAccountId: c.accountId, create: { k: { id: card.id, addressBookIds: { [book]: true } } } }),
                'invalidArguments'
            );
            expect(await h.queryIds(c, {})).to.have.length(before);
        });
    });

    describe('push', () => {
        scenario('CARD-163', async () => {
            const other = await h.createUser();
            await defaultBook(other.client);
            const es = await h.openStream(other, 'ContactCard');
            const card = await createCard(other.client);
            await updateCard(other.client, card.id, { 'name/full': 'Pushed' });
            await setCards(other.client, { destroy: [card.id] });
            const state = await cardState(other.client);
            await es.until(() => es.states().some(event => event.json.changed[other.accountId].ContactCard === state), 5000, 'no event with the final state');
            for (const event of es.states()) {
                expect(Object.keys(event.json.changed[other.accountId])).to.deep.equal(['ContactCard']);
            }
            es.close();
        });

        scenario('CARD-164', async () => {
            const other = await h.createUser();
            const card = await createCard(other.client);
            const es = await h.openStream(other, '*');
            await setCards(other.client, { create: { k: { addressBookIds: {} } } });
            await setCards(other.client, { update: { [card.id]: {} } });
            await call(other.client, 'ContactCard/query', {});
            await h.delay(1500);
            expect(es.states()).to.deep.equal([]);
            es.close();
        });

        scenario('CARD-165', async () => {
            const a = await h.createUser();
            const b = await h.createUser();
            await defaultBook(a.client);
            await defaultBook(b.client);
            const imap = await seed.imap(a);
            await imap.mailboxOpen('INBOX');
            const untagged = [];
            imap.on('exists', data => untagged.push(data));
            imap.on('flags', data => untagged.push(data));
            const idle = imap.idle();
            const [esA, esB] = [await h.openStream(a, '*'), await h.openStream(b, '*')];
            await createCard(a.client);
            await esA.next('state', 5000);
            await h.delay(1000);
            expect(esB.states()).to.deep.equal([]);
            expect(untagged).to.deep.equal([]);
            expect(imap.idling).to.equal(true);
            esA.close();
            esB.close();
            await imap.noop().catch(() => false);
            await idle.catch(() => false);
            await imap.logout().catch(() => false);
        });

        scenario('CARD-166', async () => {
            const other = await h.createUser();
            await defaultBook(other.client);
            const es = await h.openStream(other, 'ContactCard');
            await createCard(other.client);
            const first = await es.next('state', 5000);
            es.close();
            await createCard(other.client);
            const state = await cardState(other.client);
            const again = await sse.open(`/jmap/eventsource/?types=ContactCard&closeafter=no&ping=0`, {
                authorization: jmap.basic(other.username, other.password),
                headers: { 'Last-Event-ID': first.id }
            });
            const event = await again.next('state', 3000);
            expect(event.json.changed[other.accountId].ContactCard).to.equal(state);
            again.close();
        });
    });

    describe('groups', () => {
        scenario('CARD-167', async () => {
            const [x, y] = [await createCard(c), await createCard(c)];
            const members = { [x.uid]: true, [y.uid]: true };
            const group = await createCard(c, { kind: 'group', name: { full: 'The Doe Family' }, members });
            expect(await getCard(c, group.id)).to.deep.include({ kind: 'group', members });
            await createCard(c, { kind: 'group', name: { full: 'Empty' } });
            await createCard(c, { kind: 'group', name: { full: 'Empty map' }, members: {} });
        });

        scenario('CARD-168', async () => {
            const cases = [
                [{ members: { u1: true } }, ['members', 'kind']],
                [{ kind: 'org', members: { u1: true } }, ['members', 'kind']],
                [{ kind: 'group', members: { u1: false } }, ['members/u1']],
                [{ kind: 'group', members: ['u1'] }, ['members']]
            ];
            for (const [card, properties] of cases) {
                const error = await h.createFails(c, card, 'invalidProperties');
                expect(
                    error.properties.some(property => properties.includes(property)),
                    JSON.stringify(error)
                ).to.be.true;
            }
            const group = await createCard(c, { kind: 'group', members: { u1: true } });
            await updateFails(c, group.id, { kind: 'individual' }, 'invalidProperties');
        });

        scenario('CARD-169', async () => {
            const x = await createCard(c);
            const members = { [x.uid]: true, 'urn:uuid:00000000-0000-4000-8000-000000000000': true, 'some-foreign-uid@other.example': true };
            const group = await createCard(c, { kind: 'group', members });
            expect((await getCard(c, group.id)).members).to.deep.equal(members);
        });

        scenario('CARD-170', async () => {
            const ux = uuid();
            const uy = uuid();
            await createCard(c, { uid: ux });
            await createCard(c, { uid: uy });
            const group = await createCard(c, { kind: 'group', members: { [ux]: true } });
            const steps = [
                [{ [`members/${uy}`]: true }, [ux, uy]],
                [{ [`members/${ux}`]: null }, [uy]],
                [{ [`members/${ux}`]: true }, [ux, uy]]
            ];
            for (const [patch, expected] of steps) {
                const s = await cardState(c);
                await updateCard(c, group.id, patch);
                expect(Object.keys((await getCard(c, group.id)).members).sort()).to.deep.equal([...expected].sort());
                const changes = await call(c, 'ContactCard/changes', { sinceState: s });
                expect(changes.updated).to.deep.equal([group.id]);
                expect(changes.newState).to.not.equal(s);
            }
        });

        scenario('CARD-171', async () => {
            const up = `urn:uuid:1b4e28ba-2fa1-41d2-883f-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
            const uq = `plainuid-${Date.now()}`;
            await createCard(c, { uid: up });
            await createCard(c, { uid: uq });
            const group = await createCard(c, { kind: 'group', members: { [up]: true, [uq]: true } });
            expect(Object.keys((await getCard(c, group.id)).members)).to.deep.equal([up, uq]);
            await updateCard(c, group.id, { [`members/${uq}`]: null });
            await updateCard(c, group.id, { [`members/${uq}`]: true });
            expect(Object.keys((await getCard(c, group.id)).members).sort()).to.deep.equal([up, uq].sort());
            for (const uid of [up, uq]) {
                expect(await h.queryIds(c, { filter: { hasMember: uid } })).to.deep.equal([group.id]);
            }
        });

        scenario('CARD-172', async () => {
            const ux = uuid();
            const uy = uuid();
            const x = await createCard(c, { uid: ux });
            await createCard(c, { uid: uy });
            const group = await createCard(c, { kind: 'group', members: { [ux]: true, [uy]: true } });
            const s = await cardState(c);
            await setCards(c, { destroy: [x.id] });
            const changes = await call(c, 'ContactCard/changes', { sinceState: s });
            expect(changes.destroyed).to.deep.equal([x.id]);
            expect([...changes.created, ...changes.updated]).to.not.include(group.id);
            expect(Object.keys((await getCard(c, group.id)).members).sort()).to.deep.equal([ux, uy].sort());
            await createCard(c, { uid: ux });
            expect(await h.queryIds(c, { filter: { uid: ux } })).to.have.length(1);
        });

        scenario('CARD-173', async () => {
            const [x, y] = [await createCard(c), await createCard(c)];
            const group = await createCard(c, { kind: 'group', members: { [x.uid]: true, [y.uid]: true } });
            await setCards(c, { destroy: [group.id] });
            expect((await call(c, 'ContactCard/get', { ids: [x.id, y.id] })).list).to.have.length(2);
        });

        scenario('CARD-176', async () => {
            const values = { vCardProps: [['x-custom', {}, 'text', 'value']], emails: { e1: { address: 'v@example.com', vCardParams: { group: 'item1' } } } };
            const card = await createCard(c, values);
            expect(await getCard(c, card.id)).to.deep.include(values);
        });

        scenario('CARD-175', async () => {
            const u1 = uuid();
            const g1 = await createCard(c, { uid: u1, kind: 'group' });
            const g2 = await createCard(c, { kind: 'group', members: { [u1]: true } });
            await updateCard(c, g1.id, { members: { [g2.uid]: true, [u1]: true } });
            expect((await getCard(c, g2.id)).members).to.deep.equal({ [u1]: true });
            expect((await getCard(c, g1.id)).members).to.deep.equal({ [g2.uid]: true, [u1]: true });
        });
    });
});
