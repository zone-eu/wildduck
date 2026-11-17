/* eslint no-unused-expressions: 0 */
/* globals before: false, after: false */
'use strict';

// Catalogue file mailbox.yaml (Mailbox/get, Mailbox/changes, Mailbox/query), plus WDX-010 of wildduck.yaml.

const crypto = require('crypto');
const tls = require('tls');
const config = require('@zone-eu/wild-config');
const Redis = require('ioredis');
const { expect } = require('chai');
const { scenario, api, accounts, seed, fixtures, clock, jmap } = require('../harness');

const { URN } = jmap;

const PROPERTIES = ['id', 'name', 'parentId', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads', 'myRights', 'isSubscribed'];
const COUNTS = ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'];
const RIGHTS = ['mayReadItems', 'mayAddItems', 'mayRemoveItems', 'maySetSeen', 'maySetKeywords', 'mayCreateChild', 'mayRename', 'mayDelete', 'maySubmit'];
const DEFAULT_PATHS = ['INBOX', 'Sent Mail', 'Trash', 'Drafts', 'Junk'];
const ROLE_PATHS = { inbox: 'INBOX', sent: 'Sent Mail', trash: 'Trash', drafts: 'Drafts', junk: 'Junk' };

// ---- setup helpers

/** A new user with the default mailboxes plus `paths` created over IMAP, and a JMAP client */
async function setup(paths = []) {
    const user = await accounts.createUser();
    if (paths.length) {
        await seed.withImap(user, async imap => {
            for (const path of paths) {
                await imap.mailboxCreate(path);
            }
        });
    }
    const client = jmap.forUser(user);
    await client.session();
    return { user, client };
}

/** path -> JMAP mailbox id, from the REST API (hidden mailboxes included) */
async function idsOf(user) {
    const res = await api('GET', `/users/${user.id}/mailboxes?showHidden=true`);
    return Object.fromEntries(res.results.map(mailbox => [mailbox.path, `F${mailbox.id}`]));
}

const restId = jmapId => jmapId.slice(1);

const mget = (client, args = {}) => client.method('Mailbox/get', Object.assign({ ids: null }, args));
const mquery = (client, args = {}) => client.method('Mailbox/query', args);
const mchanges = (client, sinceState, args = {}) => client.method('Mailbox/changes', Object.assign({ sinceState }, args));
const stateOf = async client => (await mget(client, { ids: [] })).state;

/** Runs one call and answers [name, arguments] of its single response */
async function callOne(client, name, args, using) {
    const responses = await client.call([[name, Object.assign({ accountId: true }, args), 'c0']], using);
    expect(responses).to.have.length(1);
    return responses[0];
}

/** Asserts that the call answers an error invocation of `type` */
async function expectError(client, name, args, type, using) {
    const [responseName, responseArgs] = await callOne(client, name, args, using);
    expect(responseName, `${name} ${JSON.stringify(args)}`).to.equal('error');
    expect(responseArgs.type, `${name} ${JSON.stringify(args)}`).to.equal(type);
    expect(responseArgs).to.not.have.property('list');
    expect(responseArgs).to.not.have.property('ids');
    return responseArgs;
}

/** Mailbox objects keyed by id */
async function mailboxesById(client, args = {}) {
    const res = await mget(client, args);
    return Object.fromEntries(res.list.map(mailbox => [mailbox.id, mailbox]));
}

/** The four counts of the mailboxes at `paths`, keyed by path */
async function countsOf(user, client, paths) {
    const ids = await idsOf(user);
    const res = await mget(client, { ids: paths.map(path => ids[path]), properties: COUNTS });
    expect(res.notFound).to.deep.equal([]);
    const byId = Object.fromEntries(res.list.map(mailbox => [mailbox.id, mailbox]));
    return Object.fromEntries(paths.map(path => [path, Object.fromEntries(COUNTS.map(key => [key, byId[ids[path]][key]]))]));
}

// unsorted id sets compare equal
const same = (actual, expected, message) => expect([...actual].sort(), message).to.deep.equal([...expected].sort());

/** The state string of a journal anchor for a user, as the server computes it (lib/jmap/state.js) */
function stateFor(user, anchor) {
    const hex = anchor.toString();
    const checksum = crypto.createHmac('sha256', config.api.accessControl.secret).update(`u${user.id}:${hex}`).digest('hex').slice(0, 8);
    return `${hex}${checksum}`;
}

// ---- seeding helpers

/** Appends messages over IMAP: each item is {path, flags, options} */
async function append(user, items) {
    await seed.withImap(user, async imap => {
        for (const item of items) {
            await imap.append(item.path, await fixtures.buildMessage(item.options || {}), item.flags || []);
        }
    });
}

/** Message options for a thread: the original and replies that reference it */
function thread(subject, count) {
    const tag = crypto.randomBytes(4).toString('hex');
    const ids = Array.from({ length: count }, (value, index) => `<${tag}.${index}@thread.example>`);
    return ids.map((messageId, index) =>
        index ? { subject: `Re: ${subject}`, messageId, inReplyTo: ids[index - 1], references: ids.slice(0, index).join(' ') } : { subject, messageId }
    );
}

/** Runs raw IMAP commands after LOGIN and answers the response text of each */
function rawImap(user, commands) {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port: config.imap.port, rejectUnauthorized: false });
        const all = [`LOGIN "${user.username}" "${user.password}"`, ...commands, 'LOGOUT'];
        const responses = [];
        let buffer = '';
        let step = -1;
        const next = () => {
            step++;
            if (step < all.length) {
                socket.write(`T${step} ${all[step]}\r\n`);
            }
        };
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
            buffer += chunk;
            if (step < 0) {
                if (buffer.includes('\r\n')) {
                    buffer = '';
                    next();
                }
                return;
            }
            if (new RegExp(`^T${step} (OK|NO|BAD)`, 'm').test(buffer)) {
                responses.push(buffer);
                buffer = '';
                next();
            }
        });
        socket.on('close', () => resolve(responses));
        socket.on('error', reject);
    });
}

/** The counts of a mailbox computed from its stored messages */
async function countsFromMessages(mailboxId) {
    const db = await seed.db();
    const docs = await db
        .collection('messages')
        .find({ mailbox: new seed.ObjectId(mailboxId) }, { projection: { flags: true, thread: true } })
        .toArray();
    const present = docs.filter(doc => !doc.flags.includes('\\Deleted'));
    const unread = present.filter(doc => !doc.flags.includes('\\Seen') && !doc.flags.includes('\\Draft'));
    const threads = list => new Set(list.map(doc => doc.thread.toString())).size;
    return { totalEmails: present.length, unreadEmails: unread.length, totalThreads: threads(present), unreadThreads: threads(unread) };
}

describe('JMAP Mailbox (mailbox.yaml)', () => {
    describe('Mailbox/get on the default mailboxes', () => {
        let fresh;
        let ids;

        before(async () => {
            fresh = await setup();
            ids = await idsOf(fresh.user);
        });

        scenario('MBX-001', async () => {
            const [name, res] = await callOne(fresh.client, 'Mailbox/get', { ids: null });
            expect(name).to.equal('Mailbox/get');
            expect(res.accountId).to.equal(fresh.client.accountId);
            expect(res.accountId).to.equal(`u${fresh.user.id}`);
            expect(res.state).to.be.a('string').that.is.not.empty;
            expect(res.notFound).to.deep.equal([]);
            expect(res.list).to.have.length(5);
            same(
                res.list.map(mailbox => mailbox.id),
                DEFAULT_PATHS.map(path => ids[path])
            );
        });

        scenario('MBX-003', async () => {
            const other = await setup();
            const otherIds = await idsOf(other.user);
            const session = await fresh.client.session();
            const using = Object.keys(session.capabilities);

            const [, res] = await callOne(fresh.client, 'Mailbox/get', { ids: null }, using);
            same(
                res.list.map(mailbox => mailbox.id),
                DEFAULT_PATHS.map(path => ids[path])
            );
            for (const mailbox of res.list) {
                same(Object.keys(mailbox), PROPERTIES);
            }

            await expectError(fresh.client, 'Mailbox/get', { ids: null, properties: ['name', 'shareWith'] }, 'invalidArguments', using);

            const [, foreign] = await callOne(fresh.client, 'Mailbox/get', { ids: [otherIds.INBOX] }, using);
            expect(foreign.list).to.deep.equal([]);
            expect(foreign.notFound).to.deep.equal([otherIds.INBOX]);
        });

        scenario('MBX-004', async () => {
            const res = await mget(fresh.client, { ids: [ids.INBOX, ids.Trash] });
            same(
                res.list.map(mailbox => mailbox.id),
                [ids.INBOX, ids.Trash]
            );
            expect(res.list).to.have.length(2);
            expect(res.notFound).to.deep.equal([]);
        });

        scenario('MBX-005', async () => {
            const unknown = `F${new seed.ObjectId()}`;
            const res = await mget(fresh.client, { ids: [ids.INBOX, unknown] });
            expect(res.list.map(mailbox => mailbox.id)).to.deep.equal([ids.INBOX]);
            expect(res.notFound).to.deep.equal([unknown]);
        });

        scenario('MBX-006', async () => {
            const res = await mget(fresh.client, { ids: ['abc', '#x', restId(ids.INBOX), `M${restId(ids.INBOX)}`] });
            expect(res.list).to.deep.equal([]);
            expect(res.notFound).to.deep.equal(['abc', '#x', restId(ids.INBOX), `M${restId(ids.INBOX)}`]);
        });

        scenario('MBX-007', async () => {
            const res = await mget(fresh.client, { ids: [] });
            expect(res.list).to.deep.equal([]);
            expect(res.notFound).to.deep.equal([]);
            expect(res.state).to.be.a('string').that.is.not.empty;
        });

        scenario('MBX-008', async () => {
            const first = await mget(fresh.client, { properties: ['name', 'role'] });
            expect(first.list).to.have.length(5);
            for (const mailbox of first.list) {
                same(Object.keys(mailbox), ['id', 'name', 'role']);
            }
            const second = await mget(fresh.client, { properties: ['name'] });
            expect(second.list).to.have.length(5);
            for (const mailbox of second.list) {
                same(Object.keys(mailbox), ['id', 'name']);
            }
        });

        scenario('MBX-009', async () => {
            const res = await mget(fresh.client, { properties: [] });
            expect(res.list).to.have.length(5);
            for (const mailbox of res.list) {
                expect(Object.keys(mailbox)).to.deep.equal(['id']);
            }
        });

        scenario('MBX-010', async () => {
            await expectError(fresh.client, 'Mailbox/get', { ids: null, properties: ['name', 'invalidProperty'] }, 'invalidArguments');
        });

        scenario('MBX-011', async () => {
            const other = await setup();
            for (const accountId of [`u${other.user.id}`, 'uNoSuchAccount']) {
                const res = await fresh.client.request({ using: [URN.core, URN.mail], methodCalls: [['Mailbox/get', { accountId, ids: null }, 'c0']] });
                expect(res.status).to.equal(200);
                const [[name, args]] = res.json.methodResponses;
                expect(name).to.equal('error');
                expect(args.type).to.equal('accountNotFound');
            }
        });

        scenario('MBX-012', async () => {
            await expectError(fresh.client, 'Mailbox/get', { ids: null }, 'unknownMethod', [URN.core]);
        });

        scenario('MBX-013', async () => {
            const session = await fresh.client.session();
            const max = session.capabilities[URN.core].maxObjectsInGet;
            expect(max).to.be.at.least(1500);
            const many = Array.from({ length: max + 1 }, () => `F${new seed.ObjectId()}`);
            await expectError(fresh.client, 'Mailbox/get', { ids: many }, 'requestTooLarge');
            // ids null lists every mailbox, the per user maximum is below maxObjectsInGet
            const res = await mget(fresh.client);
            expect(res.list).to.have.length(5);
        });

        scenario('MBX-017', async () => {
            const res = await mget(fresh.client, { ids: [ids.INBOX] });
            expect(res.list[0].role).to.equal('inbox');
            expect(res.list[0].name).to.equal('INBOX');
            expect(res.list[0].parentId).to.equal(null);
        });

        scenario('MBX-038', async () => {
            const res = await mget(fresh.client, { properties: ['role', 'myRights'] });
            const byRole = Object.fromEntries(res.list.map(mailbox => [mailbox.role, mailbox.myRights]));
            same(Object.keys(byRole), Object.keys(ROLE_PATHS));
            for (const [role, rights] of Object.entries(byRole)) {
                same(Object.keys(rights), RIGHTS);
                for (const right of RIGHTS) {
                    let expected = true;
                    if (right === 'mayDelete' || (right === 'mayRename' && role === 'inbox')) {
                        expected = false;
                    }
                    expect(rights[right], `${role} ${right}`).to.equal(expected);
                }
            }
        });

        scenario('MBX-040', async () => {
            const first = await stateOf(fresh.client);
            await seed.withImap(fresh.user, async imap => {
                await imap.status('INBOX', { messages: true, unseen: true });
                await imap.mailboxOpen('INBOX');
                await imap.fetchAll('1:*', { flags: true }, { uid: true });
            });
            expect(await stateOf(fresh.client)).to.equal(first);
        });

        scenario('MBX-041', async () => {
            const responses = await fresh.client.call([
                ['Mailbox/query', { accountId: true, filter: { hasAnyRole: true } }, 'q'],
                ['Mailbox/get', { accountId: true, '#ids': { resultOf: 'q', name: 'Mailbox/query', path: '/ids' } }, 'g']
            ]);
            expect(responses.map(([name]) => name)).to.deep.equal(['Mailbox/query', 'Mailbox/get']);
            const [, get] = responses[1];
            expect(get.notFound).to.deep.equal([]);
            expect(get.list.map(mailbox => mailbox.id)).to.deep.equal(responses[0][1].ids);
            same(
                get.list.map(mailbox => mailbox.id),
                DEFAULT_PATHS.map(path => ids[path])
            );
        });

        scenario('MBX-072', async () => {
            const state = await stateOf(fresh.client);
            for (const maxChanges of [0, -1, 'ten']) {
                await expectError(fresh.client, 'Mailbox/changes', { sinceState: state, maxChanges }, 'invalidArguments');
            }
        });

        scenario('MBX-073', async () => {
            await expectError(fresh.client, 'Mailbox/changes', {}, 'invalidArguments');
            await expectError(fresh.client, 'Mailbox/changes', { sinceState: null }, 'invalidArguments');
            await expectError(fresh.client, 'Mailbox/changes', { sinceState: 42 }, 'invalidArguments');
        });

        scenario('MBX-074', async () => {
            await expectError(fresh.client, 'Mailbox/changes', { sinceState: 'not-a-state-at-all' }, 'cannotCalculateChanges');
            const future = seed.ObjectId.createFromTime(Math.floor(Date.now() / 1000) + 3600);
            await expectError(fresh.client, 'Mailbox/changes', { sinceState: stateFor(fresh.user, future) }, 'cannotCalculateChanges');
        });

        scenario('MBX-077', async () => {
            const other = await setup();
            const state = await stateOf(fresh.client);
            await expectError(fresh.client, 'Mailbox/changes', { accountId: `u${other.user.id}`, sinceState: state }, 'accountNotFound');
        });

        scenario('MBX-081', async () => {
            for (const filter of [null, {}]) {
                const res = await mquery(fresh.client, { filter });
                same(
                    res.ids,
                    DEFAULT_PATHS.map(path => ids[path])
                );
            }
        });

        scenario('MBX-087', async () => {
            const roles = await mget(fresh.client, { properties: ['role'] });
            for (const role of ['inbox', 'trash']) {
                const res = await mquery(fresh.client, { filter: { role } });
                expect(res.ids).to.have.length(1);
                expect(roles.list.find(mailbox => mailbox.id === res.ids[0]).role).to.equal(role);
            }
        });

        scenario('MBX-089', async () => {
            for (const role of ['archive', 'Inbox', 'nosuchrole']) {
                const res = await mquery(fresh.client, { filter: { role } });
                expect(res.ids, role).to.deep.equal([]);
            }
        });

        scenario('MBX-097', async () => {
            const filters = [
                { role: 42 },
                { hasAnyRole: 'yes' },
                { colour: 'red' },
                { operator: 'XOR', conditions: [{ role: 'inbox' }] },
                { operator: 'AND' },
                'inbox'
            ];
            for (const filter of filters) {
                await expectError(fresh.client, 'Mailbox/query', { filter }, 'invalidArguments');
            }
        });

        scenario('MBX-100', async () => {
            await expectError(fresh.client, 'Mailbox/query', { sort: [{ property: 'totalEmails' }] }, 'unsupportedSort');
            await expectError(fresh.client, 'Mailbox/query', { sort: [{ property: 'name', collation: 'i;nosuch' }] }, 'unsupportedSort');
        });

        describe('paging over the five default mailboxes sorted by name', () => {
            const sort = [{ property: 'name', isAscending: true }];
            let all;

            before(async () => {
                all = (await mquery(fresh.client, { sort })).ids;
                expect(all).to.have.length(5);
            });

            scenario('MBX-107', async () => {
                const res = await mquery(fresh.client, { sort, limit: 2 });
                expect(res.ids).to.deep.equal(all.slice(0, 2));
                expect(res.position).to.equal(0);
                expect(res).to.not.have.property('limit');
            });

            scenario('MBX-108', async () => {
                const res = await mquery(fresh.client, { limit: 0, calculateTotal: true });
                expect(res.ids).to.deep.equal([]);
                expect(res.total).to.equal(5);
                expect(res.queryState).to.be.a('string').that.is.not.empty;
            });

            scenario('MBX-109', async () => {
                await expectError(fresh.client, 'Mailbox/query', { limit: -1 }, 'invalidArguments');
            });

            scenario('MBX-110', async () => {
                const first = await mquery(fresh.client, { sort, position: 2 });
                expect(first.ids).to.deep.equal(all.slice(2));
                expect(first.position).to.equal(2);
                const second = await mquery(fresh.client, { sort, position: 2, limit: 2 });
                expect(second.ids).to.deep.equal([all[2], all[3]]);
            });

            scenario('MBX-111', async () => {
                const first = await mquery(fresh.client, { sort, position: -2 });
                expect(first.ids).to.deep.equal([all[3], all[4]]);
                expect(first.position).to.equal(3);
                const second = await mquery(fresh.client, { sort, position: -50 });
                expect(second.ids).to.deep.equal(all);
                expect(second.position).to.equal(0);
            });

            scenario('MBX-112', async () => {
                const res = await mquery(fresh.client, { sort, position: 100 });
                expect(res.ids).to.deep.equal([]);
            });

            scenario('MBX-113', async () => {
                let res = await mquery(fresh.client, { sort, anchor: all[2], limit: 2 });
                expect(res.ids).to.deep.equal([all[2], all[3]]);
                expect(res.position).to.equal(2);

                res = await mquery(fresh.client, { sort, anchor: all[2], anchorOffset: -1, limit: 2 });
                expect(res.ids).to.deep.equal([all[1], all[2]]);
                expect(res.position).to.equal(1);

                res = await mquery(fresh.client, { sort, anchor: all[1], anchorOffset: -5 });
                expect(res.ids).to.deep.equal(all);
                expect(res.position).to.equal(0);

                res = await mquery(fresh.client, { sort, anchor: all[2], position: 4 });
                expect(res.ids).to.deep.equal(all.slice(2));
                expect(res.position).to.equal(2);
            });
        });

        scenario('MBX-119', async () => {
            const other = await setup();
            await expectError(fresh.client, 'Mailbox/query', { accountId: `u${other.user.id}` }, 'accountNotFound');
        });

        scenario('MBX-118', () => {});
        scenario('MBX-121', () => {});
    });

    describe('Mailbox/get properties', () => {
        scenario('MBX-002', async () => {
            const { client } = await setup(['Projects']);
            const res = await mget(client, { properties: null });
            expect(res.list).to.have.length(6);
            for (const mailbox of res.list) {
                same(Object.keys(mailbox), PROPERTIES);
                expect(mailbox.id).to.be.a('string');
                expect(mailbox.name).to.be.a('string');
                expect(mailbox.parentId === null || typeof mailbox.parentId === 'string').to.be.true;
                expect(mailbox.role === null || typeof mailbox.role === 'string').to.be.true;
                for (const key of ['sortOrder', ...COUNTS]) {
                    expect(Number.isInteger(mailbox[key]) && mailbox[key] >= 0, key).to.be.true;
                }
                expect(mailbox.isSubscribed).to.be.a('boolean');
                same(Object.keys(mailbox.myRights), RIGHTS);
                for (const right of RIGHTS) {
                    expect(mailbox.myRights[right]).to.be.a('boolean');
                }
            }
        });

        scenario('MBX-014', async () => {
            const { user, client } = await setup(['Projects']);
            const ids = await idsOf(user);
            const res = await mget(client, { properties: ['name', 'role'] });
            const roles = Object.fromEntries(res.list.map(mailbox => [mailbox.id, mailbox.role]));
            for (const [role, path] of Object.entries(ROLE_PATHS)) {
                expect(roles[ids[path]], path).to.equal(role);
            }
            expect(roles[ids.Projects]).to.equal(null);

            const listed = await seed.withImap(user, imap => imap.list());
            for (const entry of listed) {
                const expected = entry.specialUse ? entry.specialUse.replace(/^\\/, '').toLowerCase() : entry.path === 'INBOX' ? 'inbox' : null;
                expect(roles[ids[entry.path]], entry.path).to.equal(expected);
            }
        });

        scenario('MBX-015', async () => {
            const created = ['Sent', 'Archive', 'Spam', 'Posteingang'];
            const { user, client } = await setup(created);
            const ids = await idsOf(user);
            const res = await mget(client);
            for (const role of Object.keys(ROLE_PATHS)) {
                expect(
                    res.list.filter(mailbox => mailbox.role === role),
                    role
                ).to.have.length(1);
            }
            for (const path of created) {
                expect(res.list.find(mailbox => mailbox.id === ids[path]).role, path).to.equal(null);
            }
        });

        scenario('MBX-016', async () => {
            const { user, client } = await setup();
            const ids = await idsOf(user);
            await seed.withImap(user, imap => imap.mailboxRename('Sent Mail', 'Sent Items'));
            const res = await mget(client, { ids: [ids['Sent Mail']] });
            expect(res.list).to.have.length(1);
            expect(res.list[0].name).to.equal('Sent Items');
            expect(res.list[0].role).to.equal('sent');
            const all = await mget(client);
            expect(all.list.filter(mailbox => mailbox.role === 'sent').map(mailbox => mailbox.id)).to.deep.equal([ids['Sent Mail']]);
        });

        scenario('MBX-024', async () => {
            const { user, client } = await setup();
            const [, create] = await rawImap(user, ['CREATE "Entw&APw-rfe &Jjo-"']);
            expect(create).to.match(/^T1 OK/m);
            const res = await mget(client, { properties: ['name'] });
            const names = res.list.map(mailbox => mailbox.name);
            expect(names).to.include('Entwürfe ☺');
            expect(names.some(name => name.includes('&'))).to.be.false;
        });

        scenario('MBX-025', async () => {
            const { user, client } = await setup(['foo']);
            await append(user, [{ path: 'foo' }]);
            const ids = await idsOf(user);
            const before = (await mget(client, { ids: [ids.foo] })).list[0];
            expect(before.totalEmails).to.equal(1);

            await seed.withImap(user, imap => imap.mailboxRename('foo', 'bar'));
            const res = await mget(client, { ids: [ids.foo] });
            expect(res.notFound).to.deep.equal([]);
            expect(res.list[0].name).to.equal('bar');
            for (const key of COUNTS) {
                expect(res.list[0][key], key).to.equal(before[key]);
            }
            const all = await mget(client, { properties: ['name'] });
            expect(all.list.map(mailbox => mailbox.name)).to.not.include('foo');
        });

        scenario('MBX-026', async () => {
            const { client } = await setup(['Projects']);
            const res = await mget(client, { properties: ['sortOrder'] });
            expect(res.list).to.have.length(6);
            for (const mailbox of res.list) {
                expect(mailbox.sortOrder).to.equal(0);
            }
        });

        scenario('MBX-027', async () => {
            const { user, client } = await setup(['Sub', 'Unsub']);
            const ids = await idsOf(user);
            const listed = await seed.withImap(user, async imap => {
                await imap.mailboxUnsubscribe('Unsub');
                return imap.list();
            });
            const res = await mget(client, { properties: ['name', 'isSubscribed'] });
            const subscribed = Object.fromEntries(res.list.map(mailbox => [mailbox.id, mailbox.isSubscribed]));
            expect(subscribed[ids.Sub]).to.be.true;
            expect(subscribed[ids.Unsub]).to.be.false;
            for (const path of DEFAULT_PATHS) {
                expect(subscribed[ids[path]], path).to.be.true;
            }
            same(
                Object.keys(subscribed).filter(id => subscribed[id]),
                listed.filter(entry => entry.subscribed).map(entry => ids[entry.path])
            );
        });

        scenario('MBX-037', async () => {
            const { user, client } = await setup(['Projects']);
            const ids = await idsOf(user);
            const res = await mget(client, { ids: [ids.Projects], properties: ['myRights'] });
            same(Object.keys(res.list[0].myRights), RIGHTS);
            for (const right of RIGHTS) {
                expect(res.list[0].myRights[right], right).to.equal(true);
            }
        });

        scenario('MBX-039', async () => {
            const { user, client } = await setup();
            await seed.deliver(user.address, await fixtures.buildMessage());
            const responses = await client.call([
                ['Mailbox/get', { accountId: true, ids: [] }, 'm'],
                ['Email/get', { accountId: true, ids: [] }, 'e'],
                ['Thread/get', { accountId: true, ids: [] }, 't']
            ]);
            expect(responses.map(([name]) => name)).to.deep.equal(['Mailbox/get', 'Email/get', 'Thread/get']);
            const states = responses.map(([, args]) => args.state);
            expect(states[0]).to.be.a('string').that.is.not.empty;
            expect(states[1]).to.equal(states[0]);
            expect(states[2]).to.equal(states[0]);
        });
    });

    describe('Mailbox/get tree derivation', () => {
        scenario('MBX-018', async () => {
            const { user, client } = await setup(['Work', 'Work/Clients', 'Work/Clients/Acme']);
            const ids = await idsOf(user);
            const byId = await mailboxesById(client);
            expect(byId[ids.Work]).to.include({ name: 'Work', parentId: null });
            expect(byId[ids['Work/Clients']]).to.include({ name: 'Clients', parentId: ids.Work });
            expect(byId[ids['Work/Clients/Acme']]).to.include({ name: 'Acme', parentId: ids['Work/Clients'] });
            expect(Object.values(byId).some(mailbox => mailbox.name.includes('/'))).to.be.false;
        });

        scenario('MBX-019', async () => {
            const { user, client } = await setup(['INBOX/Receipts']);
            const ids = await idsOf(user);
            const byId = await mailboxesById(client);
            expect(byId[ids['INBOX/Receipts']]).to.include({ name: 'Receipts', role: null, parentId: ids.INBOX });
            expect(byId[ids.INBOX].role).to.equal('inbox');
        });

        scenario('MBX-020', async () => {
            const { user, client } = await setup(['A', 'A/B/C']);
            const ids = await idsOf(user);
            expect(ids).to.not.have.property('A/B');
            const byId = await mailboxesById(client);
            expect(byId[ids['A/B/C']]).to.include({ name: 'B/C', parentId: ids.A });
            expect(Object.values(byId).some(mailbox => mailbox.name === 'B')).to.be.false;

            const listed = await seed.withImap(user, imap => imap.list());
            const selectable = listed.filter(entry => !entry.flags.has('\\Noselect') && !entry.flags.has('\\NonExistent'));
            same(
                Object.keys(byId),
                selectable.map(entry => ids[entry.path])
            );
        });

        scenario('MBX-021', async () => {
            const { user, client } = await setup(['X/Y/Z']);
            const ids = await idsOf(user);
            expect(ids).to.not.have.property('X');
            const byId = await mailboxesById(client);
            expect(byId[ids['X/Y/Z']]).to.include({ name: 'X/Y/Z', parentId: null });
        });

        scenario('MBX-022', async () => {
            const { user, client } = await setup(['A', 'A/B/C']);
            const s1 = await stateOf(client);
            const before = await idsOf(user);

            await seed.withImap(user, imap => imap.mailboxCreate('A/B'));
            const ids = await idsOf(user);
            const byId = await mailboxesById(client);
            expect(ids['A/B/C']).to.equal(before['A/B/C']);
            expect(byId[ids['A/B/C']]).to.include({ name: 'C', parentId: ids['A/B'] });

            const changes = await mchanges(client, s1);
            expect(changes.created).to.deep.equal([ids['A/B']]);
            expect(changes.updated).to.deep.equal([ids['A/B/C']]);
            expect(changes.destroyed).to.deep.equal([]);
            expect(changes.updatedProperties).to.equal(null);
        });

        scenario('MBX-023', async () => {
            const user = await accounts.createUser();
            const client = jmap.forUser(user);
            const internal = await api('POST', `/users/${user.id}/mailboxes`, { path: 'Internal' });
            const visible = await api('POST', `/users/${user.id}/mailboxes`, { path: 'Internal/Visible' });
            await api('PUT', `/users/${user.id}/mailboxes/${internal.id}`, { hidden: true });

            const all = await mget(client);
            const listed = all.list.map(mailbox => mailbox.id);
            expect(listed).to.not.include(`F${internal.id}`);
            expect(all.list.find(mailbox => mailbox.id === `F${visible.id}`)).to.include({ parentId: null, name: 'Internal/Visible' });

            const res = await mget(client, { ids: [`F${internal.id}`] });
            expect(res.list).to.deep.equal([]);
            expect(res.notFound).to.deep.equal([`F${internal.id}`]);
        });
    });

    describe('Mailbox/get counts', () => {
        scenario('MBX-028', async () => {
            const { user, client } = await setup(['Projects']);
            for (let i = 0; i < 3; i++) {
                await seed.deliver(user.address, await fixtures.buildMessage());
            }
            await append(user, [{ path: 'Projects' }, { path: 'Projects' }]);
            const ids = await idsOf(user);
            const res = await mget(client, { properties: ['totalEmails'] });
            const totals = Object.fromEntries(res.list.map(mailbox => [mailbox.id, mailbox.totalEmails]));
            expect(totals[ids.INBOX]).to.equal(3);
            expect(totals[ids.Projects]).to.equal(2);
            for (const path of ['Sent Mail', 'Trash', 'Drafts', 'Junk']) {
                expect(totals[ids[path]], path).to.equal(0);
            }
            await seed.withImap(user, async imap => {
                for (const path of [...DEFAULT_PATHS, 'Projects']) {
                    expect((await imap.status(path, { messages: true })).messages, path).to.equal(totals[ids[path]]);
                }
            });
        });

        scenario('MBX-029', async () => {
            const { user, client } = await setup();
            for (let i = 0; i < 4; i++) {
                await seed.deliver(user.address, await fixtures.buildMessage());
            }
            const imap = await seed.imap(user);
            await imap.mailboxOpen('INBOX');
            await imap.messageFlagsAdd('1', ['\\Seen']);
            let counts = await countsOf(user, client, ['INBOX']);
            expect(counts.INBOX.totalEmails).to.equal(4);
            expect(counts.INBOX.unreadEmails).to.equal(3);

            await imap.messageFlagsAdd('2', ['\\Seen']);
            counts = await countsOf(user, client, ['INBOX']);
            expect(counts.INBOX.unreadEmails).to.equal(2);

            await imap.messageFlagsRemove('2', ['\\Seen']);
            counts = await countsOf(user, client, ['INBOX']);
            expect(counts.INBOX.unreadEmails).to.equal(3);
            await imap.logout();
        });

        scenario('MBX-030', async () => {
            const { user, client } = await setup();
            await append(user, [
                { path: 'Drafts', flags: ['\\Draft'] },
                { path: 'Drafts', flags: ['\\Draft'] },
                { path: 'Drafts', flags: [] }
            ]);
            const counts = await countsOf(user, client, ['Drafts']);
            expect(counts.Drafts.totalEmails).to.equal(3);
            expect(counts.Drafts.unreadEmails).to.equal(1);
            const status = await seed.withImap(user, imap => imap.status('Drafts', { unseen: true }));
            expect(status.unseen).to.equal(3);
        });

        scenario('MBX-031', async () => {
            const { user, client } = await setup(['Projects']);
            await append(user, [{ path: 'Projects' }, { path: 'Projects' }, { path: 'Projects' }]);
            const imap = await seed.imap(user);
            await imap.mailboxOpen('Projects');
            await imap.messageFlagsAdd('1', ['\\Deleted']);
            let counts = await countsOf(user, client, ['Projects']);
            expect(counts.Projects).to.deep.equal({ totalEmails: 2, unreadEmails: 2, totalThreads: 2, unreadThreads: 2 });
            expect((await imap.status('Projects', { messages: true })).messages).to.equal(3);

            await imap.messageFlagsRemove('1', ['\\Deleted']);
            counts = await countsOf(user, client, ['Projects']);
            expect(counts.Projects).to.deep.equal({ totalEmails: 3, unreadEmails: 3, totalThreads: 3, unreadThreads: 3 });
            await imap.logout();
        });

        scenario('MBX-032', async () => {
            const { user, client } = await setup();
            for (const options of [...thread('Quarterly planning', 3), {}, {}]) {
                await seed.deliver(user.address, await fixtures.buildMessage(options));
            }
            const counts = await countsOf(user, client, ['INBOX']);
            expect(counts.INBOX.totalEmails).to.equal(5);
            expect(counts.INBOX.totalThreads).to.equal(3);
        });

        scenario('MBX-033', async () => {
            const { user, client } = await setup();
            const [original, reply] = thread('Lunch on Friday', 2);
            await seed.deliver(user.address, await fixtures.buildMessage(original));
            await append(user, [{ path: 'Sent Mail', flags: ['\\Seen'], options: reply }]);

            let counts = await countsOf(user, client, ['INBOX', 'Sent Mail']);
            expect(counts.INBOX).to.include({ totalEmails: 1, totalThreads: 1 });
            expect(counts['Sent Mail']).to.include({ totalEmails: 1, totalThreads: 1 });

            await seed.withImap(user, async imap => {
                await imap.mailboxOpen('INBOX');
                await imap.messageMove('1:*', 'Sent Mail');
            });
            counts = await countsOf(user, client, ['INBOX', 'Sent Mail']);
            expect(counts.INBOX.totalThreads).to.equal(0);
            expect(counts['Sent Mail']).to.include({ totalEmails: 2, totalThreads: 1 });
        });

        scenario('MBX-034', async () => {
            const { user, client } = await setup(['a', 'b']);
            const [a, b, c] = thread('Thread one', 3);
            const [d] = thread('Thread two', 1);
            await append(user, [
                { path: 'a', flags: ['\\Seen'], options: a },
                { path: 'a', options: b },
                { path: 'b', flags: ['\\Seen'], options: c },
                { path: 'a', options: d }
            ]);
            const check = counts => {
                for (const value of Object.values(counts)) {
                    expect(value.unreadThreads).to.be.at.most(value.totalThreads);
                    expect(value.unreadThreads).to.be.at.most(value.unreadEmails);
                }
            };
            let counts = await countsOf(user, client, ['a', 'b']);
            expect(counts.a.unreadThreads).to.equal(2);
            expect(counts.b.unreadThreads).to.equal(0);
            check(counts);

            await seed.withImap(user, async imap => {
                await imap.mailboxOpen('a');
                await imap.messageFlagsAdd('2', ['\\Seen']);
            });
            counts = await countsOf(user, client, ['a', 'b']);
            expect(counts.a.unreadThreads).to.equal(1);
            expect(counts.b.unreadThreads).to.equal(0);
            check(counts);
        });

        scenario('MBX-035', async () => {
            const { user, client } = await setup();
            const [first, second] = thread('Whole account', 2);
            await append(user, [
                { path: 'Trash', options: first },
                { path: 'INBOX', flags: ['\\Seen'], options: second }
            ]);
            const counts = await countsOf(user, client, ['Trash', 'INBOX']);
            expect(counts.Trash).to.include({ unreadThreads: 1, totalThreads: 1 });
            expect(counts.INBOX).to.include({ unreadThreads: 0, totalThreads: 1 });
        });

        scenario('MBX-036', async () => {
            const { user, client } = await setup(['Projects']);
            const [x1, x2] = thread('Thread X', 2);
            const [y1, y2] = thread('Thread Y', 2);
            await append(user, [
                { path: 'Projects', flags: ['\\Seen'], options: x1 },
                { path: 'Projects', options: x2 },
                { path: 'Projects', flags: ['\\Seen'], options: y1 },
                { path: 'Projects', options: y2 }
            ]);
            let counts = await countsOf(user, client, ['Projects']);
            expect(counts.Projects).to.deep.equal({ totalEmails: 4, unreadEmails: 2, totalThreads: 2, unreadThreads: 2 });

            await seed.withImap(user, async imap => {
                await imap.mailboxOpen('Projects');
                await imap.messageDelete('1:*');
            });
            counts = await countsOf(user, client, ['Projects']);
            expect(counts.Projects).to.deep.equal({ totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0 });
        });
    });

    describe('Mailbox/changes', () => {
        scenario('MBX-042', async () => {
            const { client } = await setup();
            const s = await stateOf(client);
            const res = await mchanges(client, s);
            expect(res).to.deep.equal({
                accountId: client.accountId,
                oldState: s,
                newState: s,
                hasMoreChanges: false,
                created: [],
                updated: [],
                destroyed: [],
                updatedProperties: null
            });
        });

        scenario('MBX-043', async () => {
            const { user, client } = await setup();
            const s1 = await stateOf(client);
            await seed.withImap(user, imap => imap.mailboxCreate('New'));
            const res = await mchanges(client, s1);
            expect(res.created).to.have.length(1);
            expect(res.updated).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(res.newState).to.not.equal(s1);
            expect(res.newState).to.equal(await stateOf(client));
            const got = await mget(client, { ids: res.created });
            expect(got.list[0].name).to.equal('New');
        });

        scenario('MBX-044', async () => {
            const { user, client } = await setup();
            const s1 = await stateOf(client);
            const created = await api('POST', `/users/${user.id}/mailboxes`, { path: 'Api/Made' });
            const res = await mchanges(client, s1);
            expect(res.created).to.deep.equal([`F${created.id}`]);
            expect(res.updated).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
        });

        scenario('MBX-045', async () => {
            const { user, client } = await setup(['Before']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.withImap(user, imap => imap.mailboxRename('Before', 'After'));
            const res = await mchanges(client, s1);
            expect(res.updated).to.deep.equal([ids.Before]);
            expect(res.created).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(res.updatedProperties).to.equal(null);
        });

        scenario('MBX-046', async () => {
            const { user, client } = await setup(['Before']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await api('PUT', `/users/${user.id}/mailboxes/${restId(ids.Before)}`, { path: 'After' });
            const res = await mchanges(client, s1);
            expect(res.updated).to.deep.equal([ids.Before]);
            expect(res.created).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(res.updatedProperties).to.equal(null);
            const got = await mget(client, { ids: [ids.Before] });
            expect(got.list[0].name).to.equal('After');
        });

        scenario('MBX-047', async () => {
            const { user, client } = await setup(['P', 'P/C1', 'P/C1/C2']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.withImap(user, imap => imap.mailboxRename('P', 'Q'));
            const res = await mchanges(client, s1);
            expect(res.created).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(res.updated).to.include(ids.P);
            for (const id of res.updated) {
                expect([ids.P, ids['P/C1'], ids['P/C1/C2']]).to.include(id);
            }
            const byId = await mailboxesById(client);
            expect(byId[ids.P]).to.include({ name: 'Q', parentId: null });
            expect(byId[ids['P/C1']]).to.include({ name: 'C1', parentId: ids.P });
            expect(byId[ids['P/C1/C2']]).to.include({ name: 'C2', parentId: ids['P/C1'] });
        });

        scenario('MBX-048', async () => {
            const { user, client } = await setup(['Gone']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.withImap(user, imap => imap.mailboxDelete('Gone'));
            const res = await mchanges(client, s1);
            expect(res.destroyed).to.deep.equal([ids.Gone]);
            expect(res.created).to.deep.equal([]);
            expect(res.updated).to.deep.equal([]);
            const got = await mget(client, { ids: [ids.Gone] });
            expect(got.notFound).to.deep.equal([ids.Gone]);
        });

        scenario('MBX-049', async () => {
            const { user, client } = await setup(['Gone']);
            await append(user, [{ path: 'Gone' }, { path: 'Gone' }]);
            const ids = await idsOf(user);
            const emails = (await client.method('Email/query', { filter: { inMailbox: ids.Gone } })).ids;
            expect(emails).to.have.length(2);
            const s1 = await stateOf(client);

            await api('DELETE', `/users/${user.id}/mailboxes/${restId(ids.Gone)}`);
            const res = await mchanges(client, s1);
            expect(res.destroyed).to.deep.equal([ids.Gone]);

            const got = await client.method('Email/get', { ids: emails, properties: ['id'] });
            expect(got.list).to.deep.equal([]);
            same(got.notFound, emails);

            await clock.waitFor(
                async () => {
                    const emailChanges = await client.method('Email/changes', { sinceState: s1 });
                    same(emailChanges.destroyed, emails);
                    return true;
                },
                { timeout: 10000, message: 'Email/changes never listed the Emails of the deleted mailbox' }
            );
        });

        scenario('MBX-050', async () => {
            const { user, client } = await setup(['P', 'P/C']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.withImap(user, imap => imap.mailboxDelete('P'));
            const res = await mchanges(client, s1);
            expect(res.destroyed).to.deep.equal([ids.P]);
            expect(res.updated).to.deep.equal([ids['P/C']]);
            expect(res.created).to.deep.equal([]);
            expect(res.updatedProperties).to.equal(null);
            const got = await mget(client, { ids: [ids['P/C']] });
            expect(got.list[0]).to.include({ parentId: null, name: 'P/C' });
        });

        scenario('MBX-051', async () => {
            const { user, client } = await setup(['Sub']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            const imap = await seed.imap(user);

            await imap.mailboxUnsubscribe('Sub');
            const first = await mchanges(client, s1);
            expect(first.updated).to.deep.equal([ids.Sub]);
            expect(first.updatedProperties).to.equal(null);
            expect(first.newState).to.not.equal(s1);
            expect((await mget(client, { ids: [ids.Sub] })).list[0].isSubscribed).to.be.false;

            await imap.mailboxSubscribe('Sub');
            const second = await mchanges(client, first.newState);
            expect(second.updated).to.deep.equal([ids.Sub]);
            expect(second.updatedProperties).to.equal(null);
            expect(second.newState).to.not.equal(first.newState);
            expect((await mget(client, { ids: [ids.Sub] })).list[0].isSubscribed).to.be.true;
            await imap.logout();
        });

        scenario('MBX-052', async () => {
            const { user, client } = await setup(['Sub']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await api('PUT', `/users/${user.id}/mailboxes/${restId(ids.Sub)}`, { subscribed: false });
            const res = await mchanges(client, s1);
            expect(res.updated).to.deep.equal([ids.Sub]);
            expect(res.updatedProperties).to.equal(null);
            expect((await mget(client, { ids: [ids.Sub] })).list[0].isSubscribed).to.be.false;
        });

        scenario('MBX-053', async () => {
            const { user, client } = await setup(['Internal']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);

            await api('PUT', `/users/${user.id}/mailboxes/${restId(ids.Internal)}`, { hidden: true });
            const first = await mchanges(client, s1);
            expect(first.destroyed).to.deep.equal([ids.Internal]);
            expect(first.created).to.deep.equal([]);
            expect(first.updated).to.deep.equal([]);

            await api('PUT', `/users/${user.id}/mailboxes/${restId(ids.Internal)}`, { hidden: false });
            const second = await mchanges(client, first.newState);
            expect(second.created).to.deep.equal([ids.Internal]);
            expect(second.updated).to.deep.equal([]);
            expect(second.destroyed).to.deep.equal([]);
            expect((await mget(client, { ids: [ids.Internal] })).list).to.have.length(1);
        });

        scenario('MBX-054', async () => {
            const { user, client } = await setup();
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.deliver(user.address, await fixtures.buildMessage());
            const res = await mchanges(client, s1);
            expect(res.updated).to.deep.equal([ids.INBOX]);
            expect(res.created).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(res.updatedProperties).to.be.an('array');
            expect(res.updatedProperties.every(property => COUNTS.includes(property))).to.be.true;
            expect(res.updatedProperties).to.include.members(['totalEmails', 'unreadEmails']);
        });

        scenario('MBX-055', async () => {
            const { user, client } = await setup(['Projects']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await append(user, [{ path: 'Projects', flags: ['\\Seen'] }]);
            const res = await mchanges(client, s1);
            expect(res.updated).to.deep.equal([ids.Projects]);
            expect(res.updatedProperties).to.be.an('array').that.is.not.empty;
            expect(res.updatedProperties.every(property => COUNTS.includes(property))).to.be.true;
            const counts = await countsOf(user, client, ['Projects']);
            expect(counts.Projects).to.include({ totalEmails: 1, unreadEmails: 0 });
        });

        scenario('MBX-056', async () => {
            const { user, client } = await setup();
            await seed.deliver(user.address, await fixtures.buildMessage());
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            const imap = await seed.imap(user);
            await imap.mailboxOpen('INBOX');

            await imap.messageFlagsAdd('1', ['\\Seen']);
            const first = await mchanges(client, s1);
            expect(first.updated).to.deep.equal([ids.INBOX]);
            expect(first.updatedProperties).to.include('unreadEmails');
            expect((await countsOf(user, client, ['INBOX'])).INBOX.unreadEmails).to.equal(0);

            await imap.messageFlagsRemove('1', ['\\Seen']);
            const second = await mchanges(client, first.newState);
            expect(second.updated).to.deep.equal([ids.INBOX]);
            expect(second.updatedProperties).to.include('unreadEmails');
            expect((await countsOf(user, client, ['INBOX'])).INBOX.unreadEmails).to.equal(1);
            await imap.logout();
        });

        scenario('MBX-057', async () => {
            const { user, client } = await setup();
            await seed.deliver(user.address, await fixtures.buildMessage());
            await seed.deliver(user.address, await fixtures.buildMessage());
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            const imap = await seed.imap(user);
            await imap.mailboxOpen('INBOX');

            await imap.messageFlagsAdd('1', ['\\Deleted']);
            const first = await mchanges(client, s1);
            expect(first.updated).to.deep.equal([ids.INBOX]);
            expect(first.updatedProperties).to.be.an('array').that.includes('totalEmails');
            expect((await countsOf(user, client, ['INBOX'])).INBOX.totalEmails).to.equal(1);

            await imap.mailboxClose();
            await imap.logout();
            const second = await mchanges(client, first.newState);
            expect(second.created).to.deep.equal([]);
            expect(second.destroyed).to.deep.equal([]);
            expect(second.updated.filter(id => id !== ids.INBOX)).to.deep.equal([]);
            expect((await countsOf(user, client, ['INBOX'])).INBOX.totalEmails).to.equal(1);
        });

        scenario('MBX-058', async () => {
            const { user, client } = await setup();
            await seed.deliver(user.address, await fixtures.buildMessage());
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.withImap(user, async imap => {
                await imap.mailboxOpen('INBOX');
                await imap.messageMove('1:*', 'Trash');
            });
            const res = await mchanges(client, s1);
            same(res.updated, [ids.INBOX, ids.Trash]);
            expect(res.created).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(res.updatedProperties).to.be.an('array').that.is.not.empty;
            expect(res.updatedProperties.every(property => COUNTS.includes(property))).to.be.true;
            const counts = await countsOf(user, client, ['INBOX', 'Trash']);
            expect(counts.INBOX.totalEmails).to.equal(0);
            expect(counts.Trash.totalEmails).to.equal(1);
        });

        scenario('MBX-059', async () => {
            const { user, client } = await setup(['Projects']);
            await seed.deliver(user.address, await fixtures.buildMessage());
            await seed.deliver(user.address, await fixtures.buildMessage());
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await api('PUT', `/users/${user.id}/mailboxes/${restId(ids.INBOX)}/messages/1`, { moveTo: restId(ids.Projects) });
            await api('DELETE', `/users/${user.id}/mailboxes/${restId(ids.INBOX)}/messages/2`);

            const res = await mchanges(client, s1);
            expect(res.updated).to.include.members([ids.INBOX, ids.Projects]);
            for (const id of res.updated) {
                expect([ids.INBOX, ids.Projects, ids.Trash]).to.include(id);
            }
            expect(res.updatedProperties).to.be.an('array').that.is.not.empty;
            const counts = await countsOf(user, client, ['INBOX', 'Projects', 'Trash']);
            for (const path of ['INBOX', 'Projects', 'Trash']) {
                expect(counts[path], path).to.deep.equal(await countsFromMessages(restId(ids[path])));
            }
            expect(counts.INBOX.totalEmails).to.equal(0);
            expect(counts.Projects.totalEmails).to.equal(1);
        });

        scenario('MBX-060', async () => {
            const { user, client } = await setup(['Projects']);
            await seed.deliver(user.address, await fixtures.buildMessage());
            const ids = await idsOf(user);
            const before = await countsOf(user, client, ['INBOX']);
            const s1 = await stateOf(client);
            await seed.withImap(user, async imap => {
                await imap.mailboxOpen('INBOX');
                await imap.messageCopy('1:*', 'Projects');
            });
            const res = await mchanges(client, s1);
            expect(res.updated).to.include(ids.Projects);
            for (const id of res.updated) {
                expect([ids.INBOX, ids.Projects]).to.include(id);
            }
            expect(res.updatedProperties).to.be.an('array').that.is.not.empty;
            const after = await countsOf(user, client, ['INBOX', 'Projects']);
            expect(after.INBOX).to.deep.equal(before.INBOX);
            expect(after.Projects.totalEmails).to.equal(1);
        });

        scenario('MBX-061', async () => {
            const { user, client } = await setup(['Projects']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.deliver(user.address, await fixtures.buildMessage());
            await seed.withImap(user, imap => imap.mailboxRename('Projects', 'Renamed'));
            const res = await mchanges(client, s1);
            same(res.updated, [ids.INBOX, ids.Projects]);
            expect(res.updatedProperties).to.equal(null);
        });

        scenario('MBX-062', async () => {
            const { user, client } = await setup();
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.deliver(user.address, await fixtures.buildMessage());
            await seed.withImap(user, imap => imap.mailboxCreate('Created'));
            const res = await mchanges(client, s1);
            expect(res.created).to.deep.equal([(await idsOf(user)).Created]);
            expect(res.updated).to.deep.equal([ids.INBOX]);
            expect(res.updatedProperties).to.equal(null);
        });

        const changesThenGet = client => [
            ['Mailbox/changes', { accountId: client.accountId }, 'c'],
            [
                'Mailbox/get',
                {
                    accountId: client.accountId,
                    '#ids': { resultOf: 'c', name: 'Mailbox/changes', path: '/updated' },
                    '#properties': { resultOf: 'c', name: 'Mailbox/changes', path: '/updatedProperties' }
                },
                'g'
            ]
        ];

        scenario('MBX-063', async () => {
            const { user, client } = await setup();
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.deliver(user.address, await fixtures.buildMessage());
            const calls = changesThenGet(client);
            calls[0][1].sinceState = s1;
            const [[, changes], [name, get]] = await client.call(calls);
            expect(name).to.equal('Mailbox/get');
            expect(changes.updatedProperties).to.be.an('array').that.is.not.empty;
            expect(get.list).to.have.length(1);
            expect(get.list[0].id).to.equal(ids.INBOX);
            same(Object.keys(get.list[0]), ['id', ...changes.updatedProperties]);
            expect(get.list[0].totalEmails).to.equal(1);
            expect(get.list[0].unreadEmails).to.equal(1);
        });

        scenario('MBX-064', async () => {
            const { user, client } = await setup(['Projects']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.withImap(user, imap => imap.mailboxRename('Projects', 'Renamed'));
            const calls = changesThenGet(client);
            calls[0][1].sinceState = s1;
            const [[, changes], [name, get]] = await client.call(calls);
            expect(name).to.equal('Mailbox/get');
            expect(changes.updatedProperties).to.equal(null);
            expect(get.list).to.have.length(1);
            expect(get.list[0].id).to.equal(ids.Projects);
            expect(get.list[0].name).to.equal('Renamed');
            same(Object.keys(get.list[0]), PROPERTIES);
        });

        scenario('MBX-065', async () => {
            const { user, client } = await setup();
            await seed.deliver(user.address, await fixtures.buildMessage());
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.withImap(user, async imap => {
                await imap.mailboxOpen('INBOX');
                await imap.messageFlagsAdd('1', ['\\Flagged']);
            });
            const res = await mchanges(client, s1);
            expect(res.created).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(res.newState).to.not.equal(s1);
            if (res.updated.length) {
                expect(res.updated).to.deep.equal([ids.INBOX]);
                expect(res.updatedProperties).to.be.an('array').that.is.not.empty;
            }
        });

        scenario('MBX-066', async () => {
            const { user, client } = await setup(['ToRename', 'ToDelete']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.withImap(user, async imap => {
                await imap.mailboxCreate('New');
                await imap.mailboxRename('ToRename', 'Renamed');
                await imap.mailboxDelete('ToDelete');
            });
            const res = await mchanges(client, s1);
            expect(res.created).to.deep.equal([(await idsOf(user)).New]);
            expect(res.updated).to.deep.equal([ids.ToRename]);
            expect(res.destroyed).to.deep.equal([ids.ToDelete]);
        });

        scenario('MBX-067', async () => {
            const { user, client } = await setup();
            const s1 = await stateOf(client);
            await seed.withImap(user, async imap => {
                await imap.mailboxCreate('Fresh');
                await imap.mailboxRename('Fresh', 'Renamed');
                await imap.append('Renamed', await fixtures.buildMessage());
            });
            const id = (await idsOf(user)).Renamed;
            const res = await mchanges(client, s1);
            expect(res.created).to.deep.equal([id]);
            expect(res.updated).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
        });

        scenario('MBX-068', async () => {
            const { user, client } = await setup();
            const s1 = await stateOf(client);
            await seed.withImap(user, async imap => {
                await imap.mailboxCreate('Ephemeral');
                await imap.mailboxDelete('Ephemeral');
            });
            const res = await mchanges(client, s1);
            expect(res.created).to.deep.equal([]);
            expect(res.updated).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(res.newState).to.not.equal(s1);
        });

        scenario('MBX-069', async () => {
            const { user, client } = await setup(['Doomed']);
            const ids = await idsOf(user);
            const s1 = await stateOf(client);
            await seed.withImap(user, async imap => {
                await imap.mailboxRename('Doomed', 'Renamed');
                await imap.mailboxDelete('Renamed');
            });
            const res = await mchanges(client, s1);
            expect(res.destroyed).to.deep.equal([ids.Doomed]);
            expect(res.created).to.deep.equal([]);
            expect(res.updated).to.deep.equal([]);
        });

        /** Follows newState until hasMoreChanges is false, answers every response */
        async function followChanges(client, sinceState, maxChanges) {
            const responses = [];
            let since = sinceState;
            for (let i = 0; i < 20; i++) {
                const res = await mchanges(client, since, { maxChanges });
                responses.push(res);
                expect(res.oldState).to.equal(since);
                expect(res.newState, 'newState must advance').to.not.equal(since);
                since = res.newState;
                if (!res.hasMoreChanges) {
                    return responses;
                }
            }
            throw new Error('Mailbox/changes did not finish within 20 calls');
        }

        scenario('MBX-070', async () => {
            const { user, client } = await setup();
            const s1 = await stateOf(client);
            const paths = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
            await seed.withImap(user, async imap => {
                for (const path of paths) {
                    await imap.mailboxCreate(path);
                }
            });
            const ids = await idsOf(user);
            const current = await stateOf(client);
            const responses = await followChanges(client, s1, 4);
            for (const res of responses) {
                expect(res.created.length + res.updated.length + res.destroyed.length).to.be.at.most(4);
            }
            expect(responses[0].hasMoreChanges).to.be.true;
            expect(responses[0].newState).to.not.equal(s1);
            expect(responses[0].newState).to.not.equal(current);
            const created = responses.flatMap(res => res.created);
            same(
                created,
                paths.map(path => ids[path])
            );
            expect(new Set(created).size).to.equal(6);
            expect(responses[responses.length - 1].newState).to.equal(current);
        });

        scenario('MBX-071', async () => {
            const { user, client } = await setup(['Dest']);
            await append(user, [{ path: 'INBOX' }]);
            const s1 = await stateOf(client);
            await seed.withImap(user, async imap => {
                await imap.mailboxOpen('INBOX');
                await imap.messageMove('1:*', 'Dest');
                await imap.mailboxCreate('New');
            });
            const ids = await idsOf(user);
            const responses = await followChanges(client, s1, 1);
            const states = new Set([s1]);
            for (const res of responses) {
                expect(res.created.length + res.updated.length + res.destroyed.length).to.be.at.most(1);
                expect(states.has(res.newState), 'a state was returned twice').to.be.false;
                states.add(res.newState);
            }
            same(new Set(responses.flatMap(res => [...res.created, ...res.updated, ...res.destroyed])), [ids.INBOX, ids.Dest, ids.New]);
            expect(responses[responses.length - 1].hasMoreChanges).to.be.false;
        });

        scenario('MBX-075', async () => {
            const { user, client } = await setup();
            // a state taken before the journal retention (three hours by default), then a change
            const db = await seed.db();
            const settings = await db.collection('settings').findOne({ key: 'const:journal:time' });
            const retention = (settings && settings.value) || 3 * 3600 * 1000;
            const s1 = stateFor(user, seed.ObjectId.createFromTime(Math.floor((Date.now() - retention) / 1000) - 3600));
            await seed.withImap(user, imap => imap.mailboxCreate('Late'));
            await expectError(client, 'Mailbox/changes', { sinceState: s1 }, 'cannotCalculateChanges');
        });

        scenario('MBX-076', async () => {
            const { user, client } = await setup();
            await seed.withImap(user, imap => imap.mailboxCreate('Quiet'));
            const db = await seed.db();
            const settings = await db.collection('settings').findOne({ key: 'const:journal:time' });
            const retention = (settings && settings.value) || 3 * 3600 * 1000;

            // the retention passes with no activity: every journal entry of the user has expired and the
            // stored anchor, which state S names, is older than the retention
            const aged = seed.ObjectId.createFromTime(Math.floor((Date.now() - retention) / 1000) - 60);
            const userId = new seed.ObjectId(user.id);
            await db.collection('journal').deleteMany({ user: userId });
            await db.collection('jmap.state').updateOne({ _id: userId }, { $set: { journal: aged, delivery: aged } }, { upsert: true });
            const s = stateFor(user, aged);

            const s2 = await stateOf(client);
            expect(s2).to.not.equal(s);
            await expectError(client, 'Mailbox/changes', { sinceState: s }, 'cannotCalculateChanges');
            const res = await mchanges(client, s2);
            expect(res).to.include({ oldState: s2, newState: s2, hasMoreChanges: false });
            expect(res.created).to.deep.equal([]);
            expect(res.updated).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
            expect(await stateOf(client)).to.equal(s2);
        });

        scenario('MBX-078', async () => {
            const a = await setup();
            const b = await setup();
            const s = await stateOf(a.client);
            await seed.withImap(b.user, imap => imap.mailboxCreate('Elsewhere'));
            await seed.deliver(b.user.address, await fixtures.buildMessage());
            const res = await mchanges(a.client, s);
            expect(res.newState).to.equal(s);
            expect(res.created).to.deep.equal([]);
            expect(res.updated).to.deep.equal([]);
            expect(res.destroyed).to.deep.equal([]);
        });

        scenario('MBX-079', async () => {
            const { user, client } = await setup();
            const s1 = await stateOf(client);
            await seed.withImap(user, imap => imap.mailboxCreate('New'));
            const [[, changes], [, get]] = await client.call([
                ['Mailbox/changes', { accountId: true, sinceState: s1 }, 'c'],
                ['Mailbox/get', { accountId: true, ids: [] }, 'g']
            ]);
            expect(changes.oldState).to.equal(s1);
            expect(changes.newState).to.not.equal(s1);
            expect(changes.newState).to.equal(get.state);
            const again = await mchanges(client, changes.newState);
            expect(again.created).to.deep.equal([]);
            expect(again.updated).to.deep.equal([]);
            expect(again.destroyed).to.deep.equal([]);
        });
    });

    describe('Mailbox/query', () => {
        scenario('MBX-080', async () => {
            const { user, client } = await setup(['Projects']);
            const ids = await idsOf(user);
            const res = await client.method('Mailbox/query', {});
            expect(res.accountId).to.equal(client.accountId);
            expect(res.queryState).to.be.a('string').that.is.not.empty;
            expect(res.canCalculateChanges).to.be.a('boolean');
            expect(res.position).to.equal(0);
            same(
                res.ids,
                [...DEFAULT_PATHS, 'Projects'].map(path => ids[path])
            );
            expect(res).to.not.have.property('total');
            expect(res).to.not.have.property('limit');
        });

        /** A user with exactly the default mailboxes plus `paths`, some unsubscribed over IMAP; answers a query helper */
        async function fixture(paths, unsubscribed = []) {
            const { user, client } = await setup(paths);
            if (unsubscribed.length) {
                await seed.withImap(user, async imap => {
                    for (const path of unsubscribed) {
                        await imap.mailboxUnsubscribe(path);
                    }
                });
            }
            const ids = await idsOf(user);
            const query = async args => (await mquery(client, args)).ids;
            return { client, ids, query, of: list => list.map(path => ids[path]) };
        }

        scenario('MBX-082', async () => {
            const { query, of } = await fixture(['Work', 'Work/Clients']);
            same(await query({ filter: { parentId: null } }), of([...DEFAULT_PATHS, 'Work']));
        });

        scenario('MBX-083', async () => {
            const { ids, query, of } = await fixture(['Work', 'Work/Clients', 'Work/Clients/Acme', 'Work/Admin']);
            same(await query({ filter: { parentId: ids.Work } }), of(['Work/Clients', 'Work/Admin']));
            expect(await query({ filter: { parentId: `F${new seed.ObjectId()}` } })).to.deep.equal([]);
        });

        scenario('MBX-084', async () => {
            const { client, ids, query } = await fixture(['A', 'A/B/C']);
            expect(await query({ filter: { parentId: ids.A } })).to.deep.equal([ids['A/B/C']]);
            const got = await mget(client, { ids: [ids['A/B/C']], properties: ['parentId'] });
            expect(got.list[0].parentId).to.equal(ids.A);
        });

        scenario('MBX-086', async () => {
            const { ids, query } = await fixture(['Projects', 'ARCHIVE 2025', 'Entwürfe']);
            expect(await query({ filter: { name: 'proj' } })).to.deep.equal([ids.Projects]);
            expect(await query({ filter: { name: 'archive' } })).to.deep.equal([ids['ARCHIVE 2025']]);
            expect(await query({ filter: { name: 'entw' } })).to.deep.equal([ids['Entwürfe']]);
        });

        scenario('MBX-092', async () => {
            const { ids, query } = await fixture(['Work', 'Work/Reports', 'Reports', 'Work/Admin']);
            expect(await query({ filter: { parentId: ids.Work, name: 'Rep' } })).to.deep.equal([ids['Work/Reports']]);
        });

        scenario('MBX-093', async () => {
            const { ids, query } = await fixture(['Projects', 'Unsub'], ['Unsub']);
            expect(await query({ filter: { operator: 'AND', conditions: [{ hasAnyRole: false }, { isSubscribed: true }] } })).to.deep.equal([ids.Projects]);
        });

        scenario('MBX-094', async () => {
            const { query, of } = await fixture(['Projects', 'Work']);
            const res = await query({ filter: { operator: 'OR', conditions: [{ role: 'inbox' }, { name: 'Proj' }] } });
            expect(res).to.have.length(2);
            same(res, of(['INBOX', 'Projects']));
        });

        scenario('MBX-095', async () => {
            const { ids, query } = await fixture(['Projects', 'Work']);
            expect(await query({ filter: { operator: 'NOT', conditions: [{ hasAnyRole: true }, { name: 'Work' }] } })).to.deep.equal([ids.Projects]);
        });

        scenario('MBX-096', async () => {
            const { query, of } = await fixture(['Projects', 'Work', 'Work/Clients']);
            const filter = {
                operator: 'AND',
                conditions: [
                    { operator: 'OR', conditions: [{ role: 'inbox' }, { parentId: null }] },
                    { operator: 'NOT', conditions: [{ hasAnyRole: true }] }
                ]
            };
            same(await query({ filter }), of(['Projects', 'Work']));
        });

        scenario('MBX-085', async () => {
            const { user, client } = await setup(['Test Folder A', 'Another Test', 'Tests', 'Tests/Leaf', 'Unrelated']);
            const ids = await idsOf(user);
            same((await mquery(client, { filter: { name: 'Test' } })).ids, [ids['Test Folder A'], ids['Another Test'], ids.Tests]);
        });

        scenario('MBX-088', async () => {
            const { user, client } = await setup(['Projects', 'Work']);
            const ids = await idsOf(user);
            same((await mquery(client, { filter: { role: null } })).ids, [ids.Projects, ids.Work]);
        });

        scenario('MBX-090', async () => {
            const { user, client } = await setup(['Projects']);
            const ids = await idsOf(user);
            const withRole = (await mquery(client, { filter: { hasAnyRole: true } })).ids;
            const without = (await mquery(client, { filter: { hasAnyRole: false } })).ids;
            same(
                withRole,
                DEFAULT_PATHS.map(path => ids[path])
            );
            expect(without).to.deep.equal([ids.Projects]);
            same([...withRole, ...without], Object.values(ids));
        });

        scenario('MBX-091', async () => {
            const { user, client } = await setup(['Unsub']);
            const listed = await seed.withImap(user, async imap => {
                await imap.mailboxUnsubscribe('Unsub');
                return imap.list();
            });
            const ids = await idsOf(user);
            expect((await mquery(client, { filter: { isSubscribed: false } })).ids).to.deep.equal([ids.Unsub]);
            const subscribed = (await mquery(client, { filter: { isSubscribed: true } })).ids;
            same(
                subscribed,
                DEFAULT_PATHS.map(path => ids[path])
            );
            same(
                subscribed,
                listed.filter(entry => entry.subscribed).map(entry => ids[entry.path])
            );
        });

        scenario('MBX-098', async () => {
            const { user, client } = await setup(['Bravo', 'alpha', 'Charlie']);
            const ids = await idsOf(user);
            const expected = [ids.alpha, ids.Bravo, ids.Charlie];
            const filter = { hasAnyRole: false };
            expect((await mquery(client, { filter, sort: [{ property: 'name', isAscending: true }] })).ids).to.deep.equal(expected);
            expect((await mquery(client, { filter, sort: [{ property: 'name', isAscending: false }] })).ids).to.deep.equal([...expected].reverse());
            expect((await mquery(client, { filter, sort: [{ property: 'name' }] })).ids).to.deep.equal(expected);
        });

        /** Sets sortOrder on mailboxes directly in the database (Mailbox/set arrives in phase 2) */
        async function setSortOrder(ids, orders) {
            const db = await seed.db();
            for (const [path, sortOrder] of Object.entries(orders)) {
                await db.collection('mailboxes').updateOne({ _id: new seed.ObjectId(restId(ids[path])) }, { $set: { sortOrder } });
            }
        }

        scenario('MBX-099', async () => {
            const { user, client } = await setup(['A', 'B', 'C', 'D']);
            const ids = await idsOf(user);
            await setSortOrder(ids, { A: 30, B: 10, C: 10, D: 20 });
            const filter = { hasAnyRole: false };
            const first = await mquery(client, {
                filter,
                sort: [
                    { property: 'sortOrder', isAscending: true },
                    { property: 'name', isAscending: true }
                ]
            });
            expect(first.ids).to.deep.equal([ids.B, ids.C, ids.D, ids.A]);
            const second = await mquery(client, { filter, sort: [{ property: 'sortOrder', isAscending: false }] });
            expect(second.ids.slice(0, 2)).to.deep.equal([ids.A, ids.D]);
            same(second.ids.slice(2), [ids.B, ids.C]);
            for (let i = 0; i < 3; i++) {
                expect((await mquery(client, { filter, sort: [{ property: 'sortOrder', isAscending: false }] })).ids).to.deep.equal(second.ids);
            }
        });

        scenario('MBX-101', async () => {
            const { client } = await setup(Array.from({ length: 10 }, (value, index) => `Folder ${index}`));
            const full = (await mquery(client)).ids;
            expect(full).to.have.length(15);
            for (let i = 0; i < 2; i++) {
                expect((await mquery(client)).ids).to.deep.equal(full);
            }
            const first = await mquery(client, { limit: 8, position: 0 });
            const second = await mquery(client, { limit: 8, position: 8 });
            expect([...first.ids, ...second.ids]).to.deep.equal(full);
        });

        scenario('MBX-102', async () => {
            const { user, client } = await setup(['B', 'B/Z', 'B/A', 'A', 'A/M', 'A/M/X']);
            const ids = await idsOf(user);
            const args = { filter: { hasAnyRole: false }, sort: [{ property: 'name', isAscending: true }] };
            const tree = await mquery(client, Object.assign({ sortAsTree: true }, args));
            expect(tree.ids).to.deep.equal([ids.A, ids['A/M'], ids['A/M/X'], ids.B, ids['B/A'], ids['B/Z']]);

            const flat = await mquery(client, Object.assign({ sortAsTree: false }, args));
            same(flat.ids.slice(0, 2), [ids.A, ids['B/A']]);
            expect(flat.ids.slice(2)).to.deep.equal([ids.B, ids['A/M'], ids['A/M/X'], ids['B/Z']]);
            expect((await mquery(client, Object.assign({ sortAsTree: false }, args))).ids).to.deep.equal(flat.ids);
        });

        scenario('MBX-103', async () => {
            const { user, client } = await setup(['P1', 'P1/a', 'P2', 'P2/z']);
            const ids = await idsOf(user);
            await setSortOrder(ids, { P1: 2, P2: 1 });
            const res = await mquery(client, {
                filter: { hasAnyRole: false },
                sort: [
                    { property: 'sortOrder', isAscending: true },
                    { property: 'name', isAscending: true }
                ],
                sortAsTree: true
            });
            expect(res.ids).to.deep.equal([ids.P2, ids['P2/z'], ids.P1, ids['P1/a']]);
        });

        scenario('MBX-104', async () => {
            const { user, client } = await setup(['A', 'A/B/C', 'Z']);
            const ids = await idsOf(user);
            const res = await mquery(client, { filter: { hasAnyRole: false }, sort: [{ property: 'name', isAscending: true }], sortAsTree: true });
            expect(res.ids).to.deep.equal([ids.A, ids['A/B/C'], ids.Z]);
        });

        const subscribedWithoutRole = { operator: 'AND', conditions: [{ isSubscribed: true }, { hasAnyRole: false }] };
        const SUBSCRIPTION_TREE = ['One', 'One/Kid', 'Two', 'Two/Kid', 'Two/Kid/Deep'];

        scenario('MBX-105', async () => {
            const { query, of } = await fixture(SUBSCRIPTION_TREE, ['Two']);
            same(await query({ filter: subscribedWithoutRole, filterAsTree: false }), of(['One', 'One/Kid', 'Two/Kid', 'Two/Kid/Deep']));
            same(await query({ filter: subscribedWithoutRole, filterAsTree: true }), of(['One', 'One/Kid']));
        });

        scenario('MBX-106', async () => {
            const { query, of } = await fixture([...SUBSCRIPTION_TREE, 'Alpha'], ['Two']);
            const res = await query({ filter: subscribedWithoutRole, filterAsTree: true, sortAsTree: true, sort: [{ property: 'name', isAscending: false }] });
            expect(res).to.deep.equal(of(['One', 'One/Kid', 'Alpha']));
        });

        scenario('MBX-114', async () => {
            const { user, client } = await setup(['Projects']);
            const ids = await idsOf(user);
            await expectError(client, 'Mailbox/query', { anchor: `F${new seed.ObjectId()}` }, 'anchorNotFound');
            await expectError(client, 'Mailbox/query', { filter: { hasAnyRole: true }, anchor: ids.Projects }, 'anchorNotFound');
        });

        scenario('MBX-115', async () => {
            const { client } = await setup(['Projects']);
            const first = await mquery(client, { filter: { hasAnyRole: true }, limit: 2, calculateTotal: true });
            expect(first.ids).to.have.length(2);
            expect(first.total).to.equal(5);
            const second = await mquery(client, { filter: { hasAnyRole: true }, limit: 2 });
            expect(second).to.not.have.property('total');
        });

        scenario('MBX-116', async () => {
            const user = await accounts.createUser();
            const client = jmap.forUser(user);
            const hidden = await api('POST', `/users/${user.id}/mailboxes`, { path: 'Concealed', hidden: true });
            expect(hidden.id).to.be.a('string');
            const first = await mquery(client, { calculateTotal: true });
            expect(first.ids).to.have.length(5);
            expect(first.total).to.equal(5);
            expect((await mquery(client, { filter: { name: 'Concealed' } })).ids).to.deep.equal([]);
        });

        scenario('MBX-117', async () => {
            const { user, client } = await setup();
            const sort = [{ property: 'name' }];
            const q1 = await mquery(client, { sort });
            const q2 = await mquery(client, { sort });
            expect(q2.queryState).to.equal(q1.queryState);
            await seed.withImap(user, imap => imap.mailboxCreate('Brand New'));
            const q3 = await mquery(client, { sort });
            expect(q3.queryState).to.not.equal(q1.queryState);
            expect(q3.ids).to.include((await idsOf(user))['Brand New']);
        });

        scenario('MBX-120', async () => {
            const { user, client } = await setup(['Alpha']);
            const ids = await idsOf(user);
            expect((await mquery(client, { filter: { name: 'Alph' } })).ids).to.deep.equal([ids.Alpha]);
            await seed.withImap(user, async imap => {
                await imap.mailboxRename('Alpha', 'Beta');
                await imap.mailboxUnsubscribe('Beta');
            });
            expect((await mquery(client, { filter: { name: 'Alph' } })).ids).to.deep.equal([]);
            expect((await mquery(client, { filter: { name: 'Bet' } })).ids).to.deep.equal([ids.Alpha]);
            expect((await mquery(client, { filter: { isSubscribed: false } })).ids).to.deep.equal([ids.Alpha]);
        });
    });
});

describe('JMAP Mailbox counters across protocols (wildduck.yaml)', () => {
    let redis;

    before(() => {
        redis = new Redis(config.dbs.redis);
    });

    after(async () => {
        await redis.quit();
    });

    scenario('WDX-010', async () => {
        const { user, client } = await setup(['Projects']);
        const ids = await idsOf(user);
        const paths = ['INBOX', 'Projects', 'Trash'];

        // JMAP counts equal the counts computed from the stored messages
        const check = async step => {
            const counts = await countsOf(user, client, paths);
            for (const path of paths) {
                expect(counts[path], `${path} after ${step}`).to.deep.equal(await countsFromMessages(restId(ids[path])));
            }
            return counts;
        };

        const [t1, t1reply] = thread('Cross protocol', 2);
        for (const options of [t1, t1reply, {}]) {
            await seed.deliver(user.address, await fixtures.buildMessage(options));
        }
        await check('delivery');

        const imap = await seed.imap(user);
        await imap.append('Projects', await fixtures.buildMessage(), []);
        await imap.append('Projects', await fixtures.buildMessage(), ['\\Seen']);
        await check('append');

        await imap.mailboxOpen('INBOX');
        await imap.messageFlagsAdd('1', ['\\Seen']);
        await check('IMAP seen');

        await api('PUT', `/users/${user.id}/mailboxes/${restId(ids.INBOX)}/messages/1`, { seen: false });
        await api('PUT', `/users/${user.id}/mailboxes/${restId(ids.INBOX)}/messages/2`, { seen: true });
        await check('REST seen and unseen');

        await imap.messageFlagsAdd('3', ['\\Deleted']);
        await check('IMAP deleted');

        await api('PUT', `/users/${user.id}/mailboxes/${restId(ids.INBOX)}/messages/2`, { deleted: true });
        await check('REST deleted');

        await imap.messageFlagsRemove('2', ['\\Deleted']);
        await check('IMAP undeleted');

        await imap.mailboxClose();
        await check('expunge');

        await imap.mailboxOpen('INBOX');
        await imap.messageMove('1', 'Projects');
        await check('IMAP move');

        await api('PUT', `/users/${user.id}/mailboxes/${restId(ids.Projects)}/messages/1`, { moveTo: restId(ids.INBOX) });
        await api('DELETE', `/users/${user.id}/mailboxes/${restId(ids.Projects)}/messages/2`);
        const before = await check('REST move and delete');
        await imap.logout();

        // the cached counters are flushed: the recount gives the same values
        await redis.del(...paths.map(path => `jmap:mbc:${restId(ids[path])}`));
        const after = await check('cache flush');
        expect(after).to.deep.equal(before);
    });
});
