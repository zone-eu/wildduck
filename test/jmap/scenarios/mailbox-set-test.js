/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
'use strict';

// Catalogue file mailbox.yaml, phase 2: Mailbox/set (RFC 8621 2.5).

const tls = require('tls');
const config = require('@zone-eu/wild-config');
const { expect } = require('chai');
const { scenario, api, accounts, seed, fixtures, jmap } = require('../harness');

const { URN } = jmap;

const RIGHTS = ['mayReadItems', 'mayAddItems', 'mayRemoveItems', 'maySetSeen', 'maySetKeywords', 'mayCreateChild', 'mayRename', 'mayDelete', 'maySubmit'];
const ALL_RIGHTS = Object.fromEntries(RIGHTS.map(right => [right, true]));
const COUNTS = ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'];

// ---- helpers

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

/** REST paths of the user's mailboxes */
const pathsOf = async user => Object.keys(await idsOf(user));

const mset = (client, args) => client.method('Mailbox/set', args);
const mget = (client, args = {}) => client.method('Mailbox/get', Object.assign({ ids: null }, args));
const stateOf = async client => (await mget(client, { ids: [] })).state;

/** Mailbox objects keyed by id */
async function byId(client, args = {}) {
    const res = await mget(client, args);
    return Object.fromEntries(res.list.map(mailbox => [mailbox.id, mailbox]));
}

async function one(client, id) {
    const res = await mget(client, { ids: [id] });
    expect(res.notFound, `Mailbox/get ${id}`).to.deep.equal([]);
    return res.list[0];
}

/** Creates mailboxes over JMAP, `specs` maps creation id to the object; answers creation id -> id */
async function create(client, specs) {
    const res = await mset(client, { create: specs });
    expect(res.notCreated, JSON.stringify(res.notCreated)).to.equal(null);
    return Object.fromEntries(Object.entries(res.created).map(([key, value]) => [key, value.id]));
}

/** Asserts that a single SetError of `type` is in `map` under `key`, with `properties` if given */
function expectSetError(map, key, type, properties) {
    expect(map, `${key} expected ${type}`).to.be.an('object');
    expect(map[key], `${key} expected ${type}`).to.be.an('object');
    expect(map[key].type, `${key}: ${JSON.stringify(map[key])}`).to.equal(type);
    if (properties) {
        expect([...map[key].properties].sort(), `${key} properties`).to.deep.equal([...properties].sort());
    }
}

/** Runs one call and answers [name, arguments] of its single response */
async function callOne(client, name, args) {
    const responses = await client.call([[name, Object.assign({ accountId: true }, args), 'c0']]);
    expect(responses).to.have.length(1);
    return responses[0];
}

async function expectError(client, args, type) {
    const [name, res] = await callOne(client, 'Mailbox/set', args);
    expect(name, JSON.stringify(res)).to.equal('error');
    expect(res.type).to.equal(type);
    return res;
}

/** Raw LSUB "" "*": the subscribed paths, without the \Noselect placeholders of unsubscribed parents (RFC 3501 6.3.9) */
function lsub(user) {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ host: '127.0.0.1', port: config.imap.port, rejectUnauthorized: false });
        let buffer = '';
        let step = 0;
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
            buffer += chunk;
            if (step === 0 && buffer.includes('\r\n')) {
                step = 1;
                socket.write(`L1 LOGIN "${user.username}" "${user.password}"\r\n`);
            } else if (step === 1 && /^L1 OK/m.test(buffer)) {
                step = 2;
                buffer = '';
                socket.write('L2 LSUB "" "*"\r\n');
            } else if (step === 2 && /^L2 (OK|NO|BAD)/m.test(buffer)) {
                step = 3;
                const paths = [];
                for (const line of buffer.split('\r\n')) {
                    const match = /^\* LSUB \(([^)]*)\) "\/" "?(.*?)"?$/.exec(line);
                    if (match && !/\\Noselect/i.test(match[1])) {
                        paths.push(match[2]);
                    }
                }
                socket.end('L3 LOGOUT\r\n');
                resolve(paths);
            }
        });
        socket.on('error', reject);
    });
}

/** IMAP LIST and LSUB of a user: {listed: [paths], subscribed: [paths], entries: path -> LIST entry} */
async function imapList(user) {
    const entries = await seed.withImap(user, imap => imap.list());
    return {
        listed: entries.map(entry => entry.path),
        subscribed: await lsub(user),
        entries: Object.fromEntries(entries.map(entry => [entry.path, entry]))
    };
}

/** Appends messages over IMAP to `path` */
async function append(user, path, count = 1, flags = []) {
    await seed.withImap(user, async imap => {
        for (let i = 0; i < count; i++) {
            await imap.append(path, await fixtures.buildMessage(), flags);
        }
    });
}

/** Email ids in a mailbox */
async function emailsIn(client, mailboxId) {
    return (await client.method('Email/query', { filter: { inMailbox: mailboxId } })).ids;
}

const hiddenMailbox = async (user, path) => `F${(await api('POST', `/users/${user.id}/mailboxes`, { path, hidden: true })).id}`;

const FOREIGN = {};
async function foreignMailboxId() {
    if (!FOREIGN.id) {
        const other = await setup(['Foreign']);
        FOREIGN.id = (await idsOf(other.user)).Foreign;
    }
    return FOREIGN.id;
}

async function mailCapability(client) {
    const session = await client.session();
    return session.accounts[client.accountId].accountCapabilities[URN.mail];
}

describe('JMAP Mailbox/set (mailbox.yaml)', function () {
    this.timeout(120000);

    describe('create', () => {
        scenario('MBX-132', async () => {
            const { client } = await setup();
            const res = await mset(client, { create: { a: { name: 'Projects' } } });
            expect(res.notCreated).to.equal(null);
            const created = res.created.a;
            expect(created.id).to.match(/^F[0-9a-f]{24}$/);
            expect(created).to.deep.include({
                parentId: null,
                role: null,
                sortOrder: 0,
                totalEmails: 0,
                unreadEmails: 0,
                totalThreads: 0,
                unreadThreads: 0,
                isSubscribed: true
            });
            expect(created.myRights).to.deep.equal(ALL_RIGHTS);
            expect((await one(client, created.id)).name).to.equal('Projects');
        });

        scenario('MBX-133', async () => {
            const { user, client } = await setup();
            const { a } = await create(client, { a: { name: 'Projects' } });
            const raw = await seed.withImap(user, async imap => {
                const entries = await imap.list();
                const box = await imap.mailboxOpen('Projects');
                const exists = box.exists;
                await imap.append('Projects', await fixtures.buildMessage());
                return { entries, exists };
            });
            const entry = raw.entries.find(item => item.path === 'Projects');
            expect(entry, 'LIST').to.exist;
            expect(entry.delimiter).to.equal('/');
            expect(entry.subscribed, 'LSUB').to.be.true;
            expect(raw.exists).to.equal(0);
            expect((await one(client, a)).totalEmails).to.equal(1);
        });

        scenario('MBX-134', async () => {
            const { user, client } = await setup();
            const { work } = await create(client, { work: { name: 'Work' } });
            const { a } = await create(client, { a: { name: 'Clients', parentId: work } });
            const mailbox = await one(client, a);
            expect(mailbox.name).to.equal('Clients');
            expect(mailbox.parentId).to.equal(work);
            expect((await imapList(user)).listed).to.include('Work/Clients');
        });

        scenario('MBX-135', async () => {
            const { client } = await setup();
            const { work } = await create(client, { work: { name: 'Work' } });
            const res = await mset(client, { create: { a: { name: 'Admin', parentId: work, role: null, sortOrder: 7, isSubscribed: false } } });
            const created = res.created.a;
            expect(Object.keys(created).sort()).to.deep.equal(['id', 'myRights', ...COUNTS].sort());
            const mailbox = await one(client, created.id);
            expect(mailbox).to.deep.include({ name: 'Admin', parentId: work, role: null, sortOrder: 7, isSubscribed: false });
        });

        scenario('MBX-136', async () => {
            const { user, client } = await setup();
            const ids = await idsOf(user);
            const res = await mset(client, { create: { r: { name: 'Receipts', parentId: ids.INBOX }, o: { name: 'Old', parentId: ids.Trash } } });
            expect(res.notCreated).to.equal(null);
            expect(res.created.r.role).to.equal(null);
            expect(res.created.o.role).to.equal(null);
            const listed = (await imapList(user)).listed;
            expect(listed).to.include.members(['INBOX/Receipts', 'Trash/Old']);
        });

        scenario('MBX-137', async () => {
            const { user, client } = await setup();
            const res = await mset(client, { create: { c: { name: 'C', parentId: '#b' }, b: { name: 'B', parentId: '#a' }, a: { name: 'A' } } });
            expect(res.notCreated).to.equal(null);
            const all = await byId(client);
            expect(all[res.created.b.id].parentId).to.equal(res.created.a.id);
            expect(all[res.created.c.id].parentId).to.equal(res.created.b.id);
            expect((await imapList(user)).listed).to.include.members(['A', 'A/B', 'A/B/C']);
        });

        scenario('MBX-138', async () => {
            const { client } = await setup();
            const responses = await client.call([
                ['Mailbox/set', { accountId: true, create: { a: { name: 'A' } } }, '0'],
                ['Mailbox/set', { accountId: true, create: { b: { name: 'B', parentId: '#a' } } }, '1'],
                ['Mailbox/get', { accountId: true, ids: ['#a', '#b'] }, '2']
            ]);
            expect(responses[0][1].created.a).to.exist;
            expect(responses[1][1].created.b).to.exist;
            const list = responses[2][1].list;
            expect(list).to.have.length(2);
            const a = list.find(mailbox => mailbox.name === 'A');
            const b = list.find(mailbox => mailbox.name === 'B');
            expect(b.parentId).to.equal(a.id);
        });

        scenario('MBX-139', async () => {
            const { client } = await setup();
            const res = await mset(client, { create: { x: { name: 'X', parentId: '#nosuch' }, y: { name: 'Y' } } });
            expectSetError(res.notCreated, 'x', 'invalidProperties', ['parentId']);
            expect(res.created.y).to.exist;
            const empty = await mset(client, { create: { z: { name: 'Z', parentId: '#' } } });
            expectSetError(empty.notCreated, 'z', 'invalidProperties', ['parentId']);
        });

        scenario('MBX-140', async () => {
            const { user, client } = await setup();
            const before = await pathsOf(user);
            const res = await mset(client, { create: { p: { name: '' }, c: { name: 'Child', parentId: '#p' } } });
            expect(res.created).to.equal(null);
            expectSetError(res.notCreated, 'p', 'invalidProperties', ['name']);
            expectSetError(res.notCreated, 'c', 'invalidProperties', ['parentId']);
            expect(await pathsOf(user)).to.deep.equal(before);
        });

        scenario('MBX-141', async () => {
            const { client } = await setup();
            const state = await stateOf(client);
            const res = await mset(client, {
                create: { a: { name: 'A', parentId: '#c' }, b: { name: 'B', parentId: '#a' }, c: { name: 'C', parentId: '#b' } }
            });
            expect(res.created).to.equal(null);
            for (const key of ['a', 'b', 'c']) {
                expectSetError(res.notCreated, key, 'invalidProperties', ['parentId']);
            }
            expect(res.newState).to.equal(state);
            expect(await stateOf(client)).to.equal(state);
        });

        scenario('MBX-142', async () => {
            const { user, client } = await setup();
            const hidden = await hiddenMailbox(user, 'Hidden');
            const foreign = await foreignMailboxId();
            const res = await mset(client, {
                create: {
                    unknown: { name: 'U', parentId: 'F000000000000000000000000' },
                    malformed: { name: 'M', parentId: 'not-an-id' },
                    hidden: { name: 'H', parentId: hidden },
                    foreign: { name: 'O', parentId: foreign }
                }
            });
            expect(res.created).to.equal(null);
            for (const key of ['unknown', 'malformed', 'hidden', 'foreign']) {
                expectSetError(res.notCreated, key, 'invalidProperties', ['parentId']);
            }
        });

        scenario('MBX-143', async () => {
            const { user, client } = await setup();
            const before = await pathsOf(user);
            const res = await mset(client, { create: { a: {}, b: { name: '' }, c: { name: null }, d: { name: 42 } } });
            expect(res.created).to.equal(null);
            for (const key of ['a', 'b', 'c', 'd']) {
                expectSetError(res.notCreated, key, 'invalidProperties', ['name']);
            }
            expect(await pathsOf(user)).to.deep.equal(before);
        });

        scenario('MBX-144', async () => {
            const { client } = await setup();
            const res = await mset(client, { create: { blank: { name: '   ' }, inner: { name: 'My Folder' } } });
            expectSetError(res.notCreated, 'blank', 'invalidProperties', ['name']);
            expect((await one(client, res.created.inner.id)).name).to.equal('My Folder');
        });

        scenario('MBX-145', async () => {
            const { user, client } = await setup();
            const res = await mset(client, { create: { a: { name: 'a/b' }, b: { name: '/a' }, c: { name: 'a/' } } });
            expect(res.created).to.equal(null);
            for (const key of ['a', 'b', 'c']) {
                expectSetError(res.notCreated, key, 'invalidProperties', ['name']);
            }
            const listed = (await imapList(user)).listed;
            expect(listed).to.not.include('a');
            expect(listed).to.not.include('a/b');
        });

        scenario('MBX-146', async () => {
            const { client } = await setup();
            const res = await mset(client, { create: { nul: { name: 'a\u0000b' }, lf: { name: 'a\nb' }, del: { name: 'a\u007fb' } } });
            expect(res.created).to.equal(null);
            for (const key of ['nul', 'lf', 'del']) {
                expectSetError(res.notCreated, key, 'invalidProperties', ['name']);
            }
        });

        scenario('MBX-147', async () => {
            const { client } = await setup();
            const max = (await mailCapability(client)).maxSizeMailboxName;
            expect(max).to.be.at.least(100);
            const res = await mset(client, { create: { exact: { name: 'x'.repeat(max) }, over: { name: 'y'.repeat(max + 1) } } });
            expect((await one(client, res.created.exact.id)).name).to.equal('x'.repeat(max));
            expectSetError(res.notCreated, 'over', 'invalidProperties', ['name']);
        });

        scenario('MBX-148', async () => {
            const { user, client } = await setup();
            const max = (await mailCapability(client)).maxSizeMailboxName;
            const fits = '日'.repeat(Math.floor(max / 3));
            const over = '本'.repeat(Math.floor(max / 3) + 1);
            expect(Buffer.byteLength(fits)).to.be.at.most(max);
            expect(Buffer.byteLength(over)).to.be.above(max);
            const res = await mset(client, { create: { fits: { name: fits }, over: { name: over } } });
            expect(res.created.fits).to.exist;
            expectSetError(res.notCreated, 'over', 'invalidProperties', ['name']);
            const opened = await seed.withImap(user, imap => imap.mailboxOpen(fits));
            expect(opened.path).to.equal(fits);
        });

        scenario('MBX-149', async () => {
            const { user, client } = await setup();
            const names = ['Entwürfe', '日本語', 'I feel ☺ 😀'];
            const ids = await create(client, Object.fromEntries(names.map((name, index) => [`n${index}`, { name }])));
            const all = await byId(client);
            names.forEach((name, index) => expect(all[ids[`n${index}`]].name).to.equal(name));
            const { listed } = await imapList(user);
            expect(listed).to.include.members(names);
            await seed.withImap(user, async imap => {
                for (const name of names) {
                    expect((await imap.mailboxOpen(name)).path).to.equal(name);
                }
            });
        });

        scenario('MBX-150', async () => {
            const { client } = await setup();
            const decomposed = 'Cafe\u0301';
            const composed = 'Caf\u00e9';
            const { a } = await create(client, { a: { name: decomposed } });
            expect((await one(client, a)).name).to.equal(composed);
            const res = await mset(client, { create: { b: { name: composed } } });
            expectSetError(res.notCreated, 'b', 'invalidProperties', ['name']);
        });

        scenario('MBX-151', async () => {
            const { user, client } = await setup(['Dup', 'Work', 'Work/Dup2']);
            const ids = await idsOf(user);
            const before = await byId(client);
            const res = await mset(client, { create: { top: { name: 'Dup' }, child: { name: 'Dup2', parentId: ids.Work } } });
            expect(res.created).to.equal(null);
            expectSetError(res.notCreated, 'top', 'invalidProperties', ['name']);
            expectSetError(res.notCreated, 'child', 'invalidProperties', ['name']);
            expect(await byId(client)).to.deep.equal(before);
        });

        scenario('MBX-152', async () => {
            const { client } = await setup();
            const res = await mset(client, { create: { a: { name: 'Twin' }, b: { name: 'Twin' } } });
            expect(Object.keys(res.created)).to.have.length(1);
            expect(Object.keys(res.notCreated)).to.have.length(1);
            const failed = Object.keys(res.notCreated)[0];
            expectSetError(res.notCreated, failed, 'invalidProperties', ['name']);
            const query = await client.method('Mailbox/query', { filter: { name: 'Twin' } });
            expect(query.ids).to.have.length(1);
        });

        scenario('MBX-153', async () => {
            const { client } = await setup();
            const { a, b } = await create(client, { a: { name: 'A' }, b: { name: 'B' } });
            const res = await mset(client, {
                create: { top: { name: 'Reports' }, underA: { name: 'Reports', parentId: a }, underB: { name: 'Reports', parentId: b } }
            });
            expect(res.notCreated).to.equal(null);
            expect(new Set(Object.values(res.created).map(item => item.id)).size).to.equal(3);
        });

        scenario('MBX-154', async () => {
            const { user, client } = await setup(['projects']);
            const res = await mset(client, { create: { p: { name: 'Projects' }, lower: { name: 'inbox' }, mixed: { name: 'Inbox' } } });
            expect(res.created.p).to.exist;
            expectSetError(res.notCreated, 'lower', 'invalidProperties', ['name']);
            expectSetError(res.notCreated, 'mixed', 'invalidProperties', ['name']);
            expect((await imapList(user)).listed).to.include.members(['projects', 'Projects']);
        });

        scenario('MBX-155', async () => {
            const { client } = await setup();
            const res = await mset(client, {
                create: {
                    a: { name: 'Archive', role: 'archive' },
                    b: { name: 'Trash2', role: 'trash' },
                    c: { name: 'X', role: 'Trash' },
                    d: { name: 'Y', role: 'nosuchrole' },
                    e: { name: 'Plain', role: null }
                }
            });
            for (const key of ['a', 'b', 'c', 'd']) {
                expectSetError(res.notCreated, key, 'invalidProperties', ['role']);
            }
            expect(Object.keys(res.created)).to.deep.equal(['e']);
            expect((await one(client, res.created.e.id)).role).to.equal(null);
        });

        scenario('MBX-156', async () => {
            const { user, client } = await setup();
            const before = await pathsOf(user);
            const values = { id: 'Fabc', totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: ALL_RIGHTS };
            for (const [property, value] of Object.entries(values)) {
                const res = await mset(client, { create: { a: { name: `With ${property}`, [property]: value } } });
                expect(res.created, property).to.equal(null);
                expectSetError(res.notCreated, 'a', 'invalidProperties', [property]);
            }
            expect(await pathsOf(user)).to.deep.equal(before);
        });

        scenario('MBX-157', async () => {
            const { client } = await setup();
            const res = await mset(client, {
                create: {
                    a: { name: 'A', colour: 'red' },
                    b: { name: 'B', isSubscribed: 'yes' },
                    c: { name: 'C', parentId: 5 },
                    d: { name: 'D', shareWith: {} }
                }
            });
            expect(res.created).to.equal(null);
            expectSetError(res.notCreated, 'a', 'invalidProperties', ['colour']);
            expectSetError(res.notCreated, 'b', 'invalidProperties', ['isSubscribed']);
            expectSetError(res.notCreated, 'c', 'invalidProperties', ['parentId']);
            expectSetError(res.notCreated, 'd', 'invalidProperties', ['shareWith']);
        });

        scenario('MBX-158', async () => {
            const { client } = await setup();
            const res = await mset(client, {
                create: {
                    max: { name: 'Max', sortOrder: 2147483647 },
                    negative: { name: 'N', sortOrder: -1 },
                    over: { name: 'O', sortOrder: 2147483648 },
                    fraction: { name: 'F', sortOrder: 1.5 },
                    string: { name: 'S', sortOrder: '3' }
                }
            });
            expect(Object.keys(res.created)).to.deep.equal(['max']);
            expect((await one(client, res.created.max.id)).sortOrder).to.equal(2147483647);
            for (const key of ['negative', 'over', 'fraction', 'string']) {
                expectSetError(res.notCreated, key, 'invalidProperties', ['sortOrder']);
            }
        });

        scenario('MBX-159', async () => {
            const { user, client } = await setup();
            const { quiet, loud } = await create(client, { quiet: { name: 'Quiet', isSubscribed: false }, loud: { name: 'Loud' } });
            const all = await byId(client);
            expect(all[quiet].isSubscribed).to.be.false;
            expect(all[loud].isSubscribed).to.be.true;
            const { listed, subscribed } = await imapList(user);
            expect(listed).to.include.members(['Quiet', 'Loud']);
            expect(subscribed).to.include('Loud');
            expect(subscribed).to.not.include('Quiet');
        });

        scenario('MBX-160', async () => {
            const { client } = await setup();
            const res = await mset(client, { create: { ok: { name: 'Good' }, bad: {} } });
            expect(Object.keys(res.created)).to.deep.equal(['ok']);
            expect(Object.keys(res.notCreated)).to.deep.equal(['bad']);
            expectSetError(res.notCreated, 'bad', 'invalidProperties');
            expect(res.newState).to.not.equal(res.oldState);
        });

        scenario('MBX-161', async () => {
            const { user, client } = await setup();
            const max = (await mailCapability(client)).maxMailboxDepth;
            expect(max).to.equal(128);
            const chain = Array.from({ length: max }, (value, index) => Array.from({ length: index + 1 }, () => 'd').join('/'));
            await seed.withImap(user, async imap => {
                for (const path of chain) {
                    await imap.mailboxCreate(path);
                }
            });
            const ids = await idsOf(user);
            const deepest = ids[chain[chain.length - 1]];
            const before = (await pathsOf(user)).length;
            const res = await mset(client, { create: { a: { name: 'Deeper', parentId: deepest } } });
            expectSetError(res.notCreated, 'a', 'invalidProperties', ['parentId']);
            expect((await pathsOf(user)).length).to.equal(before);
            const sibling = await mset(client, { create: { s: { name: 'Sibling', parentId: ids[chain[chain.length - 2]] } } });
            expect(sibling.created.s).to.exist;
        });

        scenario('MBX-162', async () => {
            const { user, client } = await setup();
            const db = await seed.db();
            const userId = new seed.ObjectId(user.id);
            const existing = await db.collection('mailboxes').countDocuments({ user: userId });
            const docs = Array.from({ length: 1500 - existing }, (value, index) => ({
                user: userId,
                path: `Bulk ${index}`,
                uidValidity: Math.floor(Date.now() / 1000),
                uidNext: 1,
                modifyIndex: 0,
                subscribed: true,
                flags: [],
                retention: 0
            }));
            await db.collection('mailboxes').insertMany(docs);
            expect(await db.collection('mailboxes').countDocuments({ user: userId })).to.equal(1500);

            const res = await mset(client, { create: { a: { name: 'One Too Many' } } });
            expectSetError(res.notCreated, 'a', 'overQuota');
            expect(await db.collection('mailboxes').countDocuments({ user: userId })).to.equal(1500);

            const victim = `F${docs[0]._id}`;
            const destroyed = await mset(client, { destroy: [victim] });
            expect(destroyed.destroyed).to.deep.equal([victim]);
            const retry = await mset(client, { create: { a: { name: 'One Too Many' } } });
            expect(retry.created.a).to.exist;
        });

        scenario('MBX-163', async () => {
            const { user, client } = await setup(['A', 'A/B/C']);
            const ids = await idsOf(user);
            const state = await stateOf(client);
            const orphan = await one(client, ids['A/B/C']);
            expect(orphan).to.deep.include({ name: 'B/C', parentId: ids.A });
            const { b } = await create(client, { b: { name: 'B', parentId: ids.A } });
            expect(await one(client, ids['A/B/C'])).to.deep.include({ id: ids['A/B/C'], name: 'C', parentId: b });
            const changes = await client.method('Mailbox/changes', { sinceState: state });
            expect(changes.updated).to.include(ids['A/B/C']);
            expect(changes.created).to.include(b);
        });
    });

    describe('update', () => {
        scenario('MBX-164', async () => {
            const { user, client } = await setup(['Before Rename']);
            await append(user, 'Before Rename');
            const id = (await idsOf(user))['Before Rename'];
            const before = await one(client, id);
            const emails = await emailsIn(client, id);
            const res = await mset(client, { update: { [id]: { name: 'After Rename' } } });
            expect(res.updated).to.have.property(id);
            expect(res.updated[id] === null || typeof res.updated[id] === 'object').to.be.true;
            expect(res.notUpdated).to.equal(null);
            const after = await one(client, id);
            expect(after.name).to.equal('After Rename');
            for (const count of COUNTS) {
                expect(after[count], count).to.equal(before[count]);
            }
            const { listed } = await imapList(user);
            expect(listed).to.include('After Rename');
            expect(listed).to.not.include('Before Rename');
            expect(await emailsIn(client, id)).to.deep.equal(emails);
            const status = await seed.withImap(user, imap => imap.status('After Rename', { messages: true }));
            expect(status.messages).to.equal(1);
        });

        scenario('MBX-165', async () => {
            const { user, client } = await setup();
            const { p, c, d } = await create(client, { p: { name: 'P' }, c: { name: 'C', parentId: '#p' }, d: { name: 'D', parentId: '#c' } });
            const res = await mset(client, { update: { [p]: { name: 'Q' } } });
            expect(res.updated).to.have.property(p);
            const { listed } = await imapList(user);
            expect(listed).to.include.members(['Q', 'Q/C', 'Q/C/D']);
            expect(listed.filter(path => path === 'P' || path.startsWith('P/'))).to.deep.equal([]);
            const all = await byId(client);
            expect(all[p].name).to.equal('Q');
            expect(all[c]).to.deep.include({ name: 'C', parentId: p });
            expect(all[d]).to.deep.include({ name: 'D', parentId: c });
        });

        scenario('MBX-166', async () => {
            const { client } = await setup();
            const { one: first, two } = await create(client, { one: { name: 'One' }, two: { name: 'Two' } });
            const state = await stateOf(client);
            const res = await mset(client, { update: { [first]: { name: 'Two' } } });
            expectSetError(res.notUpdated, first, 'invalidProperties', ['name']);
            const all = await byId(client);
            expect(all[first].name).to.equal('One');
            expect(all[two].name).to.equal('Two');
            expect(res.newState).to.equal(state);
            expect(await stateOf(client)).to.equal(state);
        });

        scenario('MBX-167', async () => {
            const { client } = await setup();
            const { p, same } = await create(client, { p: { name: 'P' }, same: { name: 'Same', parentId: '#p' } });
            const before = await one(client, same);
            for (const patch of [{ name: 'Same' }, { parentId: p }, {}]) {
                const res = await mset(client, { update: { [same]: patch } });
                expect(res.updated, JSON.stringify(patch)).to.have.property(same);
                expect(res.notUpdated).to.equal(null);
            }
            expect(await one(client, same)).to.deep.equal(before);
        });

        scenario('MBX-168', async () => {
            const { user, client } = await setup();
            const { a: x, b: y } = await create(client, { a: { name: 'A' }, b: { name: 'B' } });
            const res = await mset(client, { update: { [x]: { name: 'B' }, [y]: { name: 'A' } } });
            const all = await byId(client);
            if (res.updated && res.updated[x] !== undefined && res.updated[y] !== undefined) {
                expect(all[x].name).to.equal('B');
                expect(all[y].name).to.equal('A');
            } else {
                expectSetError(res.notUpdated, x, 'invalidProperties', ['name']);
                expectSetError(res.notUpdated, y, 'invalidProperties', ['name']);
                expect(all[x].name).to.equal('A');
                expect(all[y].name).to.equal('B');
            }
            const paths = await pathsOf(user);
            expect(paths.filter(path => path === 'A')).to.have.length(1);
            expect(paths.filter(path => path === 'B')).to.have.length(1);
        });

        scenario('MBX-169', async () => {
            const { client } = await setup();
            const max = (await mailCapability(client)).maxSizeMailboxName;
            const { v } = await create(client, { v: { name: 'Valid' } });
            for (const name of ['', '   ', 'a/b', 'x'.repeat(max + 1), null]) {
                const res = await mset(client, { update: { [v]: { name } } });
                expectSetError(res.notUpdated, v, 'invalidProperties', ['name']);
            }
            expect((await one(client, v)).name).to.equal('Valid');
        });

        scenario('MBX-170', async () => {
            const { user, client } = await setup();
            const { r } = await create(client, { r: { name: 'reports' } });
            const res = await mset(client, { update: { [r]: { name: 'Reports' } } });
            expect(res.updated).to.have.property(r);
            expect((await one(client, r)).name).to.equal('Reports');
            const { listed } = await imapList(user);
            expect(listed).to.include('Reports');
            expect(listed).to.not.include('reports');
        });

        scenario('MBX-171', async () => {
            const { user, client } = await setup(['Movable', 'Target']);
            await append(user, 'Movable');
            const ids = await idsOf(user);
            const emails = await emailsIn(client, ids.Movable);
            expect(emails).to.have.length(1);
            const res = await mset(client, { update: { [ids.Movable]: { parentId: ids.Target } } });
            expect(res.updated).to.have.property(ids.Movable);
            expect(await one(client, ids.Movable)).to.deep.include({ name: 'Movable', parentId: ids.Target });
            const { listed } = await imapList(user);
            expect(listed).to.include('Target/Movable');
            expect(listed).to.not.include('Movable');
            expect(await emailsIn(client, ids.Movable)).to.deep.equal(emails);
        });

        scenario('MBX-172', async () => {
            const { user, client } = await setup(['Work', 'Work/Clients']);
            const id = (await idsOf(user))['Work/Clients'];
            await mset(client, { update: { [id]: { parentId: null } } });
            expect(await one(client, id)).to.deep.include({ name: 'Clients', parentId: null });
            const { listed } = await imapList(user);
            expect(listed).to.include('Clients');
            expect(listed).to.not.include('Work/Clients');
        });

        scenario('MBX-173', async () => {
            const { user, client } = await setup(['Work', 'Work/Clients', 'Archive2']);
            const ids = await idsOf(user);
            const id = ids['Work/Clients'];
            let res = await mset(client, { update: { [id]: { name: 'Customers', parentId: ids.Archive2 } } });
            expect(res.updated).to.have.property(id);
            expect((await imapList(user)).listed).to.include('Archive2/Customers');
            res = await mset(client, { update: { [id]: { name: 'Top', parentId: null } } });
            expect(res.updated).to.have.property(id);
            expect((await imapList(user)).listed).to.include('Top');
            expect((await idsOf(user)).Top).to.equal(id);
        });

        scenario('MBX-174', async () => {
            const { user, client } = await setup(['A', 'A/B', 'A/B/C', 'Z']);
            const ids = await idsOf(user);
            await mset(client, { update: { [ids['A/B']]: { parentId: ids.Z } } });
            const { listed } = await imapList(user);
            expect(listed).to.include.members(['Z/B', 'Z/B/C']);
            expect(listed.filter(path => path.startsWith('A/'))).to.deep.equal([]);
            const after = await idsOf(user);
            expect(after['Z/B']).to.equal(ids['A/B']);
            expect(after['Z/B/C']).to.equal(ids['A/B/C']);
            expect((await one(client, ids['A/B/C'])).parentId).to.equal(ids['A/B']);
        });

        scenario('MBX-175', async () => {
            const { user, client } = await setup(['A', 'A/Dup', 'Dup', 'B', 'B/Other']);
            const ids = await idsOf(user);
            const before = await pathsOf(user);
            let res = await mset(client, { update: { [ids.Dup]: { parentId: ids.A } } });
            expectSetError(res.notUpdated, ids.Dup, 'invalidProperties');
            expect(res.notUpdated[ids.Dup].properties).to.include('parentId');
            res = await mset(client, { update: { [ids.Dup]: { name: 'Other', parentId: ids.B } } });
            expectSetError(res.notUpdated, ids.Dup, 'invalidProperties');
            expect(res.notUpdated[ids.Dup].properties.every(property => ['name', 'parentId'].includes(property))).to.be.true;
            expect(await pathsOf(user)).to.deep.equal(before);
        });

        scenario('MBX-176', async () => {
            const { client } = await setup();
            const { x } = await create(client, { x: { name: 'Self' } });
            const res = await mset(client, { update: { [x]: { parentId: x } } });
            expectSetError(res.notUpdated, x, 'invalidProperties', ['parentId']);
        });

        scenario('MBX-177', async () => {
            const { user, client } = await setup(['A', 'A/B', 'A/B/C']);
            const ids = await idsOf(user);
            for (const target of [ids['A/B'], ids['A/B/C']]) {
                const res = await mset(client, { update: { [ids.A]: { parentId: target } } });
                expectSetError(res.notUpdated, ids.A, 'invalidProperties', ['parentId']);
            }
            const res = await mset(client, { update: { [ids.A]: { parentId: ids['A/B/C'] }, [ids['A/B/C']]: { parentId: null } } });
            expect(res.updated || {}).to.have.property(ids['A/B/C']);
            // the tree is consistent: three mailboxes, each reachable from the top without a loop
            const all = await byId(client);
            const mine = [ids.A, ids['A/B'], ids['A/B/C']];
            for (const id of mine) {
                const seen = new Set();
                let current = all[id];
                while (current) {
                    expect(seen.has(current.id), 'loop').to.be.false;
                    seen.add(current.id);
                    current = current.parentId ? all[current.parentId] : null;
                }
            }
            const paths = (await imapList(user)).listed;
            const after = await idsOf(user);
            expect(mine.every(id => Object.values(after).includes(id))).to.be.true;
            expect(paths.length).to.equal(Object.keys(after).length);
        });

        scenario('MBX-178', async () => {
            const { client } = await setup();
            const { a, b } = await create(client, { a: { name: 'A' }, b: { name: 'B' } });
            await mset(client, { destroy: [a] });
            for (const parentId of [a, 'F0123456789abcdef01234567', 42]) {
                const res = await mset(client, { update: { [b]: { parentId } } });
                expectSetError(res.notUpdated, b, 'invalidProperties', ['parentId']);
            }
        });

        scenario('MBX-179', async () => {
            const { client } = await setup();
            const { x } = await create(client, { x: { name: 'Child' } });
            let res = await mset(client, { create: { p: { name: 'NewParent' } }, update: { [x]: { parentId: '#p' } } });
            expect(res.updated).to.have.property(x);
            expect((await one(client, x)).parentId).to.equal(res.created.p.id);
            res = await mset(client, { update: { [x]: { parentId: '#nosuch' } } });
            expectSetError(res.notUpdated, x, 'invalidProperties', ['parentId']);
            res = await mset(client, { create: { p2: { name: 'Fresh' } }, update: { '#p2': { name: 'Renamed' } } });
            const fresh = res.created.p2.id;
            expect(res.updated).to.have.property(fresh);
            expect((await one(client, fresh)).name).to.equal('Renamed');
        });

        scenario('MBX-180', async () => {
            const { user, client } = await setup();
            const chain = Array.from({ length: 127 }, (value, index) => Array.from({ length: index + 1 }, () => 'e').join('/'));
            await seed.withImap(user, async imap => {
                for (const path of [...chain, 'T', 'T/U']) {
                    await imap.mailboxCreate(path);
                }
            });
            const ids = await idsOf(user);
            const res = await mset(client, { update: { [ids.T]: { parentId: ids[chain[chain.length - 1]] } } });
            expectSetError(res.notUpdated, ids.T, 'invalidProperties', ['parentId']);
            const after = await idsOf(user);
            expect(after.T).to.equal(ids.T);
            expect(after['T/U']).to.equal(ids['T/U']);
        });

        scenario('MBX-181', async () => {
            const { user, client } = await setup(['A', 'A/B/C']);
            const ids = await idsOf(user);
            const id = ids['A/B/C'];
            const noop = await mset(client, { update: { [id]: { name: 'B/C' } } });
            expect(noop.updated).to.have.property(id);
            const res = await mset(client, { update: { [id]: { name: 'D' } } });
            expect(res.updated).to.have.property(id);
            expect(await one(client, id)).to.deep.include({ name: 'D', parentId: ids.A });
            const { listed } = await imapList(user);
            expect(listed).to.include('A/D');
            expect(listed).to.not.include('A/B/C');
        });

        scenario('MBX-182', async () => {
            const { client } = await setup();
            const { s } = await create(client, { s: { name: 'Sort Order Test' } });
            expect((await one(client, s)).sortOrder).to.equal(0);
            const state = await stateOf(client);
            let res = await mset(client, { update: { [s]: { sortOrder: 42 } } });
            expect(res.updated).to.have.property(s);
            expect((await one(client, s)).sortOrder).to.equal(42);
            const query = await client.method('Mailbox/query', { sort: [{ property: 'sortOrder' }] });
            expect(query.ids[query.ids.length - 1]).to.equal(s);
            const changes = await client.method('Mailbox/changes', { sinceState: state });
            expect(changes.updated).to.include(s);
            expect(changes.updatedProperties).to.equal(null);
            res = await mset(client, { update: { [s]: { sortOrder: -1 } } });
            expectSetError(res.notUpdated, s, 'invalidProperties', ['sortOrder']);
            expect((await one(client, s)).sortOrder).to.equal(42);
        });

        scenario('MBX-183', async () => {
            const { user, client } = await setup();
            const { s } = await create(client, { s: { name: 'Sorted', sortOrder: 5 } });
            await seed.withImap(user, async imap => {
                await imap.mailboxRename('Sorted', 'Sorted Renamed');
                await imap.append('Sorted Renamed', await fixtures.buildMessage());
            });
            const mailbox = await one(client, s);
            expect(mailbox.name).to.equal('Sorted Renamed');
            expect(mailbox.sortOrder).to.equal(5);
        });

        scenario('MBX-184', async () => {
            const { user, client } = await setup();
            const { n } = await create(client, { n: { name: 'News' } });
            await mset(client, { update: { [n]: { isSubscribed: false } } });
            expect((await one(client, n)).isSubscribed).to.be.false;
            let imap = await imapList(user);
            expect(imap.listed).to.include('News');
            expect(imap.subscribed).to.not.include('News');
            await mset(client, { update: { [n]: { isSubscribed: true } } });
            expect((await one(client, n)).isSubscribed).to.be.true;
            imap = await imapList(user);
            expect(imap.subscribed).to.include('News');
        });

        scenario('MBX-185', async () => {
            const { client } = await setup();
            const { s } = await create(client, { s: { name: 'Subscribed' } });
            for (const value of ['invalid', null]) {
                const res = await mset(client, { update: { [s]: { isSubscribed: value } } });
                expectSetError(res.notUpdated, s, 'invalidProperties', ['isSubscribed']);
            }
            expect((await one(client, s)).isSubscribed).to.be.true;
        });

        scenario('MBX-186', async () => {
            const { user, client } = await setup();
            const { p, c } = await create(client, { p: { name: 'P', isSubscribed: false }, c: { name: 'C', parentId: '#p', isSubscribed: false } });
            let res = await mset(client, { update: { [c]: { isSubscribed: true } } });
            expect(Object.keys(res.updated)).to.deep.equal([c]);
            let all = await byId(client);
            expect(all[p].isSubscribed).to.be.false;
            expect(all[c].isSubscribed).to.be.true;
            let imap = await imapList(user);
            expect(imap.subscribed).to.include('P/C');
            expect(imap.subscribed).to.not.include('P');

            await mset(client, { update: { [p]: { isSubscribed: true } } });
            res = await mset(client, { update: { [p]: { isSubscribed: false } } });
            expect(Object.keys(res.updated)).to.deep.equal([p]);
            all = await byId(client);
            expect(all[p].isSubscribed).to.be.false;
            expect(all[c].isSubscribed).to.be.true;
            imap = await imapList(user);
            expect(imap.subscribed).to.include('P/C');
            expect(imap.subscribed).to.not.include('P');
        });

        scenario('MBX-187', async () => {
            const { user, client } = await setup();
            const { p, c } = await create(client, { p: { name: 'P', isSubscribed: false }, c: { name: 'C', parentId: '#p' } });
            await mset(client, { update: { [p]: { name: 'Q' } } });
            const all = await byId(client);
            expect(all[p]).to.deep.include({ name: 'Q', isSubscribed: false });
            expect(all[c].isSubscribed).to.be.true;
            const { subscribed } = await imapList(user);
            expect(subscribed).to.include('Q/C');
            expect(subscribed).to.not.include('P/C');
            expect(subscribed).to.not.include('Q');
        });

        scenario('MBX-188', async () => {
            const { user, client } = await setup(['Plain']);
            const ids = await idsOf(user);
            const rolesBefore = Object.fromEntries((await mget(client)).list.map(mailbox => [mailbox.id, mailbox.role]));
            const specialBefore = (await imapList(user)).entries;
            for (const [id, role] of [
                [ids.Plain, 'archive'],
                [ids.Plain, 'trash'],
                [ids.Trash, null],
                [ids['Sent Mail'], 'drafts']
            ]) {
                const res = await mset(client, { update: { [id]: { role } } });
                expectSetError(res.notUpdated, id, 'invalidProperties', ['role']);
            }
            const rolesAfter = Object.fromEntries((await mget(client)).list.map(mailbox => [mailbox.id, mailbox.role]));
            expect(rolesAfter).to.deep.equal(rolesBefore);
            const specialAfter = (await imapList(user)).entries;
            for (const path of Object.keys(specialBefore)) {
                expect(specialAfter[path].specialUse, path).to.equal(specialBefore[path].specialUse);
            }
        });

        scenario('MBX-189', async () => {
            const { user, client } = await setup(['Plain']);
            const ids = await idsOf(user);
            const before = await byId(client);
            const res = await mset(client, { update: { [ids.Trash]: { role: 'trash', sortOrder: 3 }, [ids.Plain]: { role: null, sortOrder: 4 } } });
            expect(res.notUpdated).to.equal(null);
            expect(Object.keys(res.updated).sort()).to.deep.equal([ids.Trash, ids.Plain].sort());
            const after = await byId(client);
            expect(after[ids.Trash]).to.deep.equal(Object.assign({}, before[ids.Trash], { sortOrder: 3 }));
            expect(after[ids.Plain]).to.deep.equal(Object.assign({}, before[ids.Plain], { sortOrder: 4 }));
        });

        scenario('MBX-190', async () => {
            const { user, client } = await setup(['Work']);
            const ids = await idsOf(user);
            for (const patch of [{ name: 'Posteingang' }, { parentId: ids.Work }]) {
                const res = await mset(client, { update: { [ids.INBOX]: patch } });
                expectSetError(res.notUpdated, ids.INBOX, 'forbidden');
            }
            const { listed } = await imapList(user);
            expect(listed).to.include('INBOX');
            expect(listed.filter(path => /inbox/i.test(path))).to.deep.equal(['INBOX']);
            expect((await idsOf(user)).INBOX).to.equal(ids.INBOX);
        });

        scenario('MBX-191', async () => {
            const { user, client } = await setup(['Work']);
            const ids = await idsOf(user);
            const res = await mset(client, {
                update: { [ids['Sent Mail']]: { name: 'Outbox' }, [ids.Trash]: { parentId: ids.Work }, [ids.INBOX]: { name: 'Inbox2' } }
            });
            expect(Object.keys(res.updated).sort()).to.deep.equal([ids['Sent Mail'], ids.Trash].sort());
            expectSetError(res.notUpdated, ids.INBOX, 'forbidden');
            const all = await byId(client);
            expect(all[ids['Sent Mail']]).to.deep.include({ name: 'Outbox', role: 'sent' });
            expect(all[ids.Trash]).to.deep.include({ name: 'Trash', role: 'trash', parentId: ids.Work });
            const { entries } = await imapList(user);
            expect(entries.Outbox.specialUse).to.equal('\\Sent');
            expect(entries['Work/Trash'].specialUse).to.equal('\\Trash');
        });

        scenario('MBX-192', async () => {
            const { user, client } = await setup();
            const ids = await idsOf(user);
            const res = await mset(client, { update: { [ids.INBOX]: { sortOrder: 1 }, [ids.Junk]: { sortOrder: 9, isSubscribed: false } } });
            expect(res.notUpdated).to.equal(null);
            const all = await byId(client);
            expect(all[ids.INBOX].sortOrder).to.equal(1);
            expect(all[ids.Junk]).to.deep.include({ sortOrder: 9, isSubscribed: false });
            expect((await imapList(user)).subscribed).to.not.include('Junk');
        });

        scenario('MBX-193', async () => {
            const { client } = await setup();
            const { m } = await create(client, { m: { name: 'Counted' } });
            const before = await one(client, m);
            expect(before.totalEmails).to.equal(0);
            for (const [patch, property] of [
                [{ totalEmails: 5 }, 'totalEmails'],
                [{ unreadEmails: 5 }, 'unreadEmails'],
                [{ totalThreads: 5 }, 'totalThreads'],
                [{ unreadThreads: 5 }, 'unreadThreads'],
                [{ myRights: { mayDelete: false } }, 'myRights'],
                [{ 'myRights/mayRename': false }, 'myRights'],
                [{ id: 'other' }, 'id']
            ]) {
                const res = await mset(client, { update: { [m]: patch } });
                expectSetError(res.notUpdated, m, 'invalidProperties', [property]);
            }
            expect(await one(client, m)).to.deep.equal(before);
        });

        scenario('MBX-194', async () => {
            const { client } = await setup();
            const { m } = await create(client, { m: { name: 'Whole' } });
            const object = await one(client, m);
            const res = await mset(client, { update: { [m]: Object.assign({}, object, { name: 'Whole Renamed' }) } });
            expect(res.notUpdated).to.equal(null);
            expect(res.updated).to.have.property(m);
            expect(await one(client, m)).to.deep.equal(Object.assign({}, object, { name: 'Whole Renamed' }));
        });

        scenario('MBX-195', async () => {
            const { client } = await setup();
            const { x } = await create(client, { x: { name: 'Patched' } });
            const before = await one(client, x);
            for (const [patch, type, properties] of [
                [{ colour: 'red' }, 'invalidProperties', ['colour']],
                [{ '/name': 'x' }, 'invalidPatch'],
                [{ '': 'x' }, 'invalidPatch'],
                [{ 'name/first': 'x' }, 'invalidPatch'],
                [{ shareWith: {} }, 'invalidProperties', ['shareWith']]
            ]) {
                const res = await mset(client, { update: { [x]: patch } });
                expectSetError(res.notUpdated, x, type, properties);
            }
            expect(await one(client, x)).to.deep.equal(before);
        });

        scenario('MBX-196', async () => {
            const { user, client } = await setup();
            const { x } = await create(client, { x: { name: 'Untouched' } });
            const before = await pathsOf(user);
            await expectError(client, { update: { [x]: 'invalid' } }, 'invalidArguments');
            await expectError(client, { update: [] }, 'invalidArguments');
            await expectError(client, { create: 'invalid' }, 'invalidArguments');
            expect(await pathsOf(user)).to.deep.equal(before);
        });

        scenario('MBX-197', async () => {
            const { user, client } = await setup();
            const hidden = await hiddenMailbox(user, 'Hidden');
            const foreign = await foreignMailboxId();
            const targets = ['F0123456789abcdef01234567', 'malformed', hidden, foreign];
            const res = await mset(client, { update: Object.fromEntries(targets.map(id => [id, { name: 'x' }])) });
            for (const id of targets) {
                expectSetError(res.notUpdated, id, 'notFound');
            }
            expect(res.updated).to.equal(null);
        });

        scenario('MBX-198', async () => {
            const { user, client } = await setup();
            const ids = await idsOf(user);
            const { a, b } = await create(client, { a: { name: 'A' }, b: { name: 'B' } });
            const res = await mset(client, { update: { [a]: { name: 'A2' }, [b]: { name: 'x/y' }, [ids.INBOX]: { name: 'Nope' } } });
            expect(Object.keys(res.updated)).to.deep.equal([a]);
            expectSetError(res.notUpdated, b, 'invalidProperties', ['name']);
            expectSetError(res.notUpdated, ids.INBOX, 'forbidden');
            expect(res.newState).to.not.equal(res.oldState);
        });
    });

    describe('destroy', () => {
        scenario('MBX-199', async () => {
            const { user, client } = await setup();
            const { x } = await create(client, { x: { name: 'Destroy Me' } });
            const state = await stateOf(client);
            const res = await mset(client, { destroy: [x] });
            expect(res.destroyed).to.deep.equal([x]);
            expect(res.notDestroyed).to.equal(null);
            expect((await mget(client, { ids: [x] })).notFound).to.deep.equal([x]);
            expect((await client.method('Mailbox/changes', { sinceState: state })).destroyed).to.deep.equal([x]);
            const { listed, subscribed } = await imapList(user);
            expect(listed).to.not.include('Destroy Me');
            expect(subscribed).to.not.include('Destroy Me');
        });

        scenario('MBX-200', async () => {
            const { client } = await setup();
            const ids = Object.values(await create(client, { a: { name: 'A' }, b: { name: 'B' }, c: { name: 'C' } }));
            const res = await mset(client, { destroy: ids });
            expect([...res.destroyed].sort()).to.deep.equal([...ids].sort());
            const remaining = Object.keys(await byId(client));
            expect(remaining.filter(id => ids.includes(id))).to.deep.equal([]);
        });

        scenario('MBX-201', async () => {
            const { user, client } = await setup();
            const { x } = await create(client, { x: { name: 'Gone' } });
            await mset(client, { destroy: [x] });
            const hidden = await hiddenMailbox(user, 'Hidden');
            const foreign = await foreignMailboxId();
            const state = await stateOf(client);
            const targets = [x, hidden, foreign, 'invalid', '#nosuch'];
            const res = await mset(client, { destroy: targets });
            expect(res.destroyed).to.equal(null);
            expect(Object.keys(res.notDestroyed).sort()).to.deep.equal([...targets].sort());
            for (const id of targets) {
                expectSetError(res.notDestroyed, id, 'notFound');
            }
            expect(res.newState).to.equal(state);
        });

        scenario('MBX-202', async () => {
            const { user, client } = await setup(['Parent', 'Parent/Child']);
            const ids = await idsOf(user);
            for (const extra of [{}, { onDestroyRemoveEmails: true }]) {
                const res = await mset(client, Object.assign({ destroy: [ids.Parent] }, extra));
                expectSetError(res.notDestroyed, ids.Parent, 'mailboxHasChild');
            }
            expect(Object.keys(await byId(client))).to.include.members([ids.Parent, ids['Parent/Child']]);
            expect((await imapList(user)).listed).to.include.members(['Parent', 'Parent/Child']);
        });

        scenario('MBX-203', async () => {
            const { user, client } = await setup(['A', 'A/B/C']);
            const ids = await idsOf(user);
            const res = await mset(client, { destroy: [ids.A] });
            expectSetError(res.notDestroyed, ids.A, 'mailboxHasChild');
        });

        scenario('MBX-204', async () => {
            const { client } = await setup();
            const { a, b, c } = await create(client, { a: { name: 'A' }, b: { name: 'B', parentId: '#a' }, c: { name: 'C', parentId: '#b' } });
            const res = await mset(client, { destroy: [a, b, c] });
            expect(res.notDestroyed).to.equal(null);
            expect([...res.destroyed].sort()).to.deep.equal([a, b, c].sort());
        });

        scenario('MBX-205', async () => {
            const { user, client } = await setup(['Full']);
            await append(user, 'Full');
            const id = (await idsOf(user)).Full;
            for (const extra of [{}, { onDestroyRemoveEmails: false }]) {
                const res = await mset(client, Object.assign({ destroy: [id] }, extra));
                expectSetError(res.notDestroyed, id, 'mailboxHasEmail');
            }
            expect((await one(client, id)).totalEmails).to.equal(1);
            expect(await emailsIn(client, id)).to.have.length(1);
        });

        scenario('MBX-206', async () => {
            const { user, client } = await setup(['Full']);
            const subject = `Destroyed thread ${Date.now()}`;
            await seed.withImap(user, async imap => {
                await imap.append('Full', await fixtures.buildMessage({ subject, messageId: `<t1.${Date.now()}@example.com>` }));
            });
            const ids = await idsOf(user);
            const [first] = await emailsIn(client, ids.Full);
            const { list } = await client.method('Email/get', { ids: [first], properties: ['messageId', 'threadId'] });
            await seed.withImap(user, async imap => {
                await imap.append(
                    'Full',
                    await fixtures.buildMessage({
                        subject: `Re: ${subject}`,
                        inReplyTo: list[0].messageId[0] && `<${list[0].messageId[0]}>`,
                        references: `<${list[0].messageId[0]}>`
                    })
                );
            });
            const emails = await emailsIn(client, ids.Full);
            expect(emails).to.have.length(2);
            const threads = (await client.method('Email/get', { ids: emails, properties: ['threadId'] })).list.map(email => email.threadId);
            expect(new Set(threads).size).to.equal(1);
            const state = await stateOf(client);

            const res = await mset(client, { destroy: [ids.Full], onDestroyRemoveEmails: true });
            expect(res.destroyed).to.deep.equal([ids.Full]);
            expect((await client.method('Email/get', { ids: emails })).notFound.sort()).to.deep.equal([...emails].sort());
            const changes = await client.method('Email/changes', { sinceState: state });
            expect(changes.destroyed).to.include.members(emails);
            expect((await client.method('Thread/get', { ids: [threads[0]] })).notFound).to.deep.equal([threads[0]]);
            expect((await imapList(user)).listed).to.not.include('Full');
        });

        scenario('MBX-207', async () => {
            const { user, client } = await setup(['Flagged']);
            await append(user, 'Flagged', 1, ['\\Deleted']);
            const id = (await idsOf(user)).Flagged;
            expect((await one(client, id)).totalEmails).to.equal(0);
            const res = await mset(client, { destroy: [id] });
            expect(res.destroyed).to.deep.equal([id]);
            const db = await seed.db();
            const left = await db
                .collection('messages')
                .find({ mailbox: new seed.ObjectId(id.slice(1)) })
                .toArray();
            // the message waits for the garbage collector, marked for immediate expiry
            expect(left.every(message => message.exp === true && message.rdate <= Date.now())).to.be.true;
        });

        scenario('MBX-208', async () => {
            const { user, client } = await setup();
            const ids = await idsOf(user);
            const targets = ['INBOX', 'Sent Mail', 'Trash', 'Drafts', 'Junk'].map(path => ids[path]);
            const res = await mset(client, { destroy: targets, onDestroyRemoveEmails: true });
            expect(res.destroyed).to.equal(null);
            for (const id of targets) {
                expectSetError(res.notDestroyed, id, 'forbidden');
            }
            const all = await byId(client);
            for (const id of targets) {
                expect(all[id].myRights.mayDelete).to.be.false;
            }
        });

        scenario('MBX-209', async () => {
            const { user, client } = await setup();
            const res = await mset(client, { create: { t: { name: 'Temp' } }, destroy: ['#t'] });
            expect(res.created.t).to.exist;
            expect(res.destroyed).to.deep.equal([res.created.t.id]);
            expect(await pathsOf(user)).to.not.include('Temp');
        });

        scenario('MBX-210', async () => {
            const { user, client } = await setup();
            const { a: x } = await create(client, { a: { name: 'A' } });
            const state = await stateOf(client);
            const res = await mset(client, { create: { n: { name: 'A' } }, destroy: [x] });
            expect(res.destroyed).to.deep.equal([x]);
            expect(res.created.n.id).to.not.equal(x);
            expect((await pathsOf(user)).filter(path => path === 'A')).to.have.length(1);
            const changes = await client.method('Mailbox/changes', { sinceState: state });
            expect(changes.destroyed).to.deep.equal([x]);
            expect(changes.created).to.deep.equal([res.created.n.id]);
        });

        scenario('MBX-211', async () => {
            const { user, client } = await setup();
            const { a: x, b: y } = await create(client, { a: { name: 'A' }, b: { name: 'B', parentId: '#a' } });
            const res = await mset(client, { create: { n: { name: 'A' } }, update: { [y]: { parentId: '#n' } }, destroy: [x] });
            const all = await byId(client);
            const paths = await pathsOf(user);
            if (res.destroyed && res.destroyed.includes(x)) {
                // preferred outcome: the new A holds B
                expect(res.created.n).to.exist;
                expect(all[y]).to.deep.include({ name: 'B', parentId: res.created.n.id });
            } else {
                // otherwise the original tree is intact
                expect(all[x]).to.deep.include({ name: 'A', parentId: null });
                expect(all[y]).to.deep.include({ name: 'B', parentId: x });
                expect(paths).to.include.members(['A', 'A/B']);
            }
            expect(all[y], 'B is never lost').to.exist;
        });

        scenario('MBX-212', async () => {
            const { client } = await setup();
            const { c: x } = await create(client, { c: { name: 'Cycle', isSubscribed: false, sortOrder: 9 } });
            await mset(client, { destroy: [x] });
            const { c } = await create(client, { c: { name: 'Cycle' } });
            expect(c).to.not.equal(x);
            expect(await one(client, c)).to.deep.include({ isSubscribed: true, sortOrder: 0 });
            expect((await mget(client, { ids: [x] })).notFound).to.deep.equal([x]);
        });

        scenario('MBX-213', async () => {
            const { user, client } = await setup(['E', 'F']);
            await append(user, 'F');
            const ids = await idsOf(user);
            const res = await mset(client, { destroy: [ids.E, ids.F, ids.INBOX] });
            expect(res.destroyed).to.deep.equal([ids.E]);
            expectSetError(res.notDestroyed, ids.F, 'mailboxHasEmail');
            expectSetError(res.notDestroyed, ids.INBOX, 'forbidden');
        });
    });

    describe('state, ifInState and limits', () => {
        scenario('MBX-214', async () => {
            const { client } = await setup();
            const state = await stateOf(client);
            const responses = await client.call([
                ['Mailbox/set', { accountId: true, create: { a: { name: 'Bracketed' } } }, '0'],
                ['Mailbox/get', { accountId: true, ids: [] }, '1']
            ]);
            const set = responses[0][1];
            expect(set.oldState).to.equal(state);
            expect(set.newState).to.not.equal(state);
            expect(set.newState).to.equal(responses[1][1].state);
            const changes = await client.method('Mailbox/changes', { sinceState: state });
            expect(changes.created).to.deep.equal([set.created.a.id]);
            expect(changes.updated).to.deep.equal([]);
            expect(changes.destroyed).to.deep.equal([]);
        });

        scenario('MBX-215', async () => {
            const { client } = await setup();
            const state = await stateOf(client);
            const nulls = ['created', 'updated', 'destroyed', 'notCreated', 'notUpdated', 'notDestroyed'];
            for (const args of [{}, { create: {}, update: {}, destroy: [] }]) {
                const res = await mset(client, args);
                expect(res.oldState).to.equal(state);
                expect(res.newState).to.equal(state);
                for (const key of nulls) {
                    expect(res[key], key).to.equal(null);
                }
            }
            const res = await mset(client, { create: { bad: { name: '' } } });
            expect(res.oldState).to.equal(state);
            expect(res.newState).to.equal(state);
            expectSetError(res.notCreated, 'bad', 'invalidProperties', ['name']);
            for (const key of nulls.filter(key => key !== 'notCreated')) {
                expect(res[key], key).to.equal(null);
            }
        });

        scenario('MBX-216', async () => {
            const { client } = await setup();
            const state = await stateOf(client);
            const res = await mset(client, { ifInState: state, create: { a: { name: 'Guarded' } } });
            expect(res.created.a).to.exist;
            expect(res.oldState).to.equal(state);
        });

        scenario('MBX-217', async () => {
            const { user, client } = await setup(['Existing']);
            const s1 = await stateOf(client);
            await seed.withImap(user, imap => imap.mailboxCreate('Made Over IMAP'));
            const ids = await idsOf(user);
            const s2 = await stateOf(client);
            expect(s2).to.not.equal(s1);
            const before = await pathsOf(user);
            await expectError(
                client,
                { ifInState: s1, create: { a: { name: 'Nope' } }, update: { [ids.Existing]: { name: 'Renamed' } }, destroy: [ids['Made Over IMAP']] },
                'stateMismatch'
            );
            await expectError(client, { ifInState: 'garbage', create: { a: { name: 'Nope' } } }, 'stateMismatch');
            expect(await pathsOf(user)).to.deep.equal(before);
            expect(await stateOf(client)).to.equal(s2);
        });

        scenario('MBX-218', async () => {
            const { user, client } = await setup(['Unrelated']);
            const id = (await idsOf(user)).Unrelated;
            const s1 = await stateOf(client);
            await seed.deliver(user.address, await fixtures.buildMessage({ to: user.address }));
            await expectError(client, { ifInState: s1, update: { [id]: { name: 'Renamed' } } }, 'stateMismatch');
            const changes = await client.method('Mailbox/changes', { sinceState: s1 });
            const res = await mset(client, { ifInState: changes.newState, update: { [id]: { name: 'Renamed' } } });
            expect(res.updated).to.have.property(id);
        });

        scenario('MBX-219', async () => {
            const a = await setup();
            const b = await setup();
            await b.client.session();
            const before = await pathsOf(b.user);
            const [name, res] = await callOne(a.client, 'Mailbox/set', { accountId: b.client.accountId, create: { x: { name: 'Intruder' } } });
            expect(name).to.equal('error');
            expect(res.type).to.equal('accountNotFound');
            expect(await pathsOf(b.user)).to.deep.equal(before);
        });

        scenario('MBX-220', async () => {
            const { user, client } = await setup();
            const max = (await client.session()).capabilities[URN.core].maxObjectsInSet;
            const before = await pathsOf(user);
            const destroy = Array.from({ length: max - 1 }, (value, index) => `F${String(index).padStart(24, '0')}`);
            await expectError(client, { create: { a: { name: 'A' } }, update: { [destroy[0]]: { name: 'x' } }, destroy }, 'requestTooLarge');
            expect(await pathsOf(user)).to.deep.equal(before);
        });

        scenario('MBX-221', async () => {
            const { user, client } = await setup(['R', 'D']);
            const ids = await idsOf(user);
            const state = await stateOf(client);
            const res = await mset(client, {
                create: { n: { name: 'N' } },
                update: { [ids.R]: { name: 'R2' }, [ids.INBOX]: { isSubscribed: false } },
                destroy: [ids.D]
            });
            const changes = await client.method('Mailbox/changes', { sinceState: state });
            expect(changes.created).to.deep.equal([res.created.n.id]);
            expect([...changes.updated].sort()).to.deep.equal([ids.R, ids.INBOX].sort());
            expect(changes.destroyed).to.deep.equal([ids.D]);
            expect(changes.updatedProperties).to.equal(null);
        });

        scenario('MBX-222', async () => {
            const { user, client } = await setup(['Other', 'Gone', 'Quiet']);
            const ids = await idsOf(user);
            const imap = await seed.imap(user);
            try {
                await imap.mailboxOpen('INBOX');
                await mset(client, {
                    create: { n: { name: 'New' } },
                    update: { [ids.Other]: { name: 'Other2' }, [ids.Quiet]: { isSubscribed: false } },
                    destroy: [ids.Gone]
                });
                await imap.noop();
                const entries = await imap.list();
                const listed = entries.map(entry => entry.path);
                const subscribed = entries.filter(entry => entry.subscribed).map(entry => entry.path);
                expect(listed).to.include.members(['New', 'Other2', 'Quiet']);
                expect(listed).to.not.include('Other');
                expect(listed).to.not.include('Gone');
                expect(subscribed).to.include.members(['New', 'Other2']);
                expect(subscribed).to.not.include('Quiet');
                expect((await imap.mailboxOpen('Other2')).path).to.equal('Other2');
                let failed = false;
                await imap.mailboxOpen('Gone').catch(() => {
                    failed = true;
                });
                expect(failed, 'SELECT Gone fails').to.be.true;
            } finally {
                await imap.logout().catch(() => imap.close());
            }
        });

        scenario('MBX-223', async () => {
            const instance = require('../harness/instance'); // eslint-disable-line global-require
            const { user } = await setup();
            const { app, url } = await instance.startInstance({ changes: Object.assign({}, config.jmap.changes, { scanLimit: 5 }) });
            try {
                const client = jmap.forUser(user);
                const raw = client.raw.bind(client);
                client.raw = (path, init) => raw(path.startsWith('http') ? path : url + path, init);
                const since = await stateOf(client);
                await seed.withImap(user, async imap => {
                    for (let i = 0; i < 6; i++) {
                        await imap.append('INBOX', Buffer.from(`From: a@example.com\r\nSubject: scan ${i}\r\n\r\nHello\r\n`));
                    }
                });
                const late = (await mset(client, { create: { late: { name: 'Late' } } })).created.late.id;
                const current = await stateOf(client);
                const pages = [];
                let state = since;
                for (let i = 0; i < 10; i++) {
                    const page = await client.method('Mailbox/changes', { sinceState: state });
                    pages.push(page);
                    state = page.newState;
                    if (!page.hasMoreChanges) {
                        break;
                    }
                }
                expect(pages[0].hasMoreChanges).to.equal(true);
                expect(pages[0].newState).to.not.equal(current);
                expect(pages[pages.length - 1].hasMoreChanges).to.equal(false);
                expect(pages.flatMap(page => page.created)).to.include(late);
            } finally {
                await instance.stopInstance(app);
            }
        });
    });
});
