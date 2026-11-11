/* eslint no-unused-expressions: 0 */
'use strict';

// Catalogue file wildduck.yaml: backend prerequisites (WDP), service wiring (WDS) and cross
// protocol invariants (WDX).

const { expect } = require('chai');
const { scenario, api, API_URL, accounts, seed, fixtures, clock } = require('../harness');
const { resolveRoots, repairUserRoots, ensureUserRoots, findDuplicateRoots, rootsChecked } = require('../../../lib/message-roots');
const MailboxHandler = require('../../../lib/mailbox-handler');
const { ensureIndex } = require('../../../lib/index-ttl');
const { journalAnchors } = require('../../../lib/journal-state');
const crypto = require('crypto');
const { Readable } = require('stream');
const StorageHandler = require('../../../lib/storage-handler');
const consts = require('../../../lib/consts');

// Records mailbox setting changes in place of ImapNotifier for handler level checks
const ImapNotifierStub = {
    entries: [],
    async journalMailboxUpdate(mailboxData, changes) {
        ImapNotifierStub.entries.push({ mailbox: mailboxData._id, changes });
    }
};

const DOC_FIELDS = { projection: { _id: true, root: true, mailbox: true, uid: true, subject: true } };

// The stored message documents of a user (or of the archive), once there are `count` of them
async function messageDocs(user, count, collection = 'messages') {
    const db = await seed.db();
    return clock.waitFor(
        async () => {
            const docs = await db
                .collection(collection)
                .find({ user: new seed.ObjectId(user.id) }, DOC_FIELDS)
                .toArray();
            return docs.length === count && docs;
        },
        { message: `expected ${count} documents in ${collection}` }
    );
}

const rootOf = doc => doc.root.toString();

// A raw message document for database level scenarios; only the fields the root logic reads
function rawDoc(user, fields = {}) {
    const _id = fields._id || new seed.ObjectId();
    return Object.assign({ _id, user, mailbox: new seed.ObjectId(), uid: 1 }, fields);
}

// Journal entries of a user that describe messages, oldest first
async function journal(user, filter = {}) {
    const db = await seed.db();
    return db
        .collection('journal')
        .find(Object.assign({ user: new seed.ObjectId(user.id), message: { $exists: true } }, filter))
        .sort({ _id: 1 })
        .toArray();
}

// Index names used anywhere in the winning plan of an explain() result
function planIndexes(explain) {
    const names = new Set();
    const walk = stage => {
        if (stage && typeof stage === 'object') {
            if (stage.indexName) {
                names.add(stage.indexName);
            }
            Object.values(stage).forEach(walk);
        }
    };
    walk(explain.queryPlanner.winningPlan);
    return names;
}

// A user with one message in INBOX and a second mailbox, plus the stored document of the message
async function userWithMessage() {
    const user = await accounts.createUser();
    await api('POST', `/users/${user.id}/mailboxes`, { path: 'Archive' });
    const boxes = await accounts.mailboxes(user);
    await seed.deliver(user.address, await fixtures.buildMessage());
    const [doc] = await messageDocs(user, 1);
    return { user, boxes, doc };
}

describe('JMAP backend prerequisites (wildduck.yaml)', () => {
    describe('stable Email ids', () => {
        scenario('WDP-001', async () => {
            const user = await accounts.createUser();
            const boxes = await accounts.mailboxes(user);

            await Promise.all([
                fixtures.buildMessage({ subject: 'delivered over LMTP' }).then(raw => seed.deliver(user.address, raw)),
                fixtures.buildMessage({ subject: 'appended over IMAP' }).then(raw => seed.withImap(user, client => client.append('INBOX', raw))),
                api('POST', `/users/${user.id}/mailboxes/${boxes.INBOX.id}/messages`, { subject: 'uploaded through the API', text: 'Hello' })
            ]);

            const docs = await messageDocs(user, 3);
            for (const doc of docs) {
                expect(doc.root, `root of ${doc._id}`).to.exist;
                expect(doc.root.toString()).to.equal(doc._id.toString());
            }
            expect(new Set(docs.map(rootOf)).size).to.equal(3);
        });

        scenario('WDP-002', async () => {
            const { user, doc } = await userWithMessage();

            await seed.withImap(user, async client => {
                await client.mailboxOpen('INBOX');
                await client.messageMove('1:*', 'Archive');
                const [moved] = await messageDocs(user, 1);
                expect(moved._id.toString()).to.not.equal(doc._id.toString());
                expect(rootOf(moved)).to.equal(rootOf(doc));

                await client.mailboxOpen('Archive');
                await client.messageMove('1:*', 'INBOX');
            });

            const [back] = await messageDocs(user, 1);
            expect(back.mailbox.toString()).to.equal(doc.mailbox.toString());
            expect(back.uid).to.not.equal(doc.uid);
            expect(rootOf(back)).to.equal(rootOf(doc));
        });

        scenario('WDP-003', async () => {
            const { user, boxes } = await userWithMessage();
            await seed.deliver(user.address, await fixtures.buildMessage());
            await seed.deliver(user.address, await fixtures.buildMessage());
            const before = await messageDocs(user, 3);

            // one message alone, then the rest as a uid range
            await api('PUT', `/users/${user.id}/mailboxes/${boxes.INBOX.id}/messages`, { message: '1', moveTo: boxes.Archive.id });
            await api('PUT', `/users/${user.id}/mailboxes/${boxes.INBOX.id}/messages`, { message: '1:*', moveTo: boxes.Archive.id });

            const after = await messageDocs(user, 3);
            expect(after.every(moved => moved.mailbox.toString() === boxes.Archive.id)).to.be.true;
            expect(after.map(rootOf).sort()).to.deep.equal(before.map(rootOf).sort());
        });

        scenario('WDP-004', async () => {
            const { user, doc } = await userWithMessage();

            await seed.withImap(user, async client => {
                await client.mailboxOpen('INBOX');
                await client.messageCopy('1:*', 'Archive');
                await client.mailboxOpen('Archive');
                await client.messageCopy('1:*', 'Archive');
            });

            const docs = await messageDocs(user, 3);
            const original = docs.find(entry => entry._id.toString() === doc._id.toString());
            expect(rootOf(original)).to.equal(rootOf(doc));
            for (const copy of docs.filter(entry => entry !== original)) {
                expect(rootOf(copy)).to.equal(copy._id.toString());
            }
            expect(new Set(docs.map(rootOf)).size).to.equal(3);

            // the journal links each copy to the root it was copied from
            const [first, second] = await journal(user, { command: 'EXISTS', origin: 'copy' });
            expect(first.sourceRoot.toString()).to.equal(rootOf(doc));
            expect(second.sourceRoot.toString()).to.equal(first.root.toString());
        });

        scenario('WDP-005', async () => {
            const { user, boxes, doc } = await userWithMessage();

            await api('DELETE', `/users/${user.id}/mailboxes/${boxes.INBOX.id}/messages/${doc.uid}`);
            const [archived] = await messageDocs(user, 1, 'archived');
            expect(rootOf(archived)).to.equal(rootOf(doc));

            await api('POST', `/users/${user.id}/archived/messages/${archived._id}/restore`, {});
            const [restored] = await messageDocs(user, 1);
            expect(rootOf(restored)).to.equal(rootOf(doc));
        });

        scenario('WDP-006', async () => {
            const db = await seed.db();
            const user = new seed.ObjectId();
            const root = new seed.ObjectId();
            const older = rawDoc(user, { _id: root, root });
            const newer = rawDoc(user, { root, uid: 1 });
            await db.collection('messages').insertMany([older, newer]);
            try {
                const found = await resolveRoots(db.collection('messages'), user, [root]);
                expect([...found.keys()]).to.deep.equal([root.toString()]);
                expect(found.get(root.toString())._id.toString()).to.equal(newer._id.toString());
            } finally {
                await db.collection('messages').deleteMany({ user });
            }
        });

        scenario('WDP-009', async () => {
            const db = await seed.db();
            const user = new seed.ObjectId();
            const legacy = { _id: new seed.ObjectId(), user, mailbox: new seed.ObjectId(), uid: 1 };
            const current = { _id: new seed.ObjectId(), user, mailbox: legacy.mailbox, uid: 2 };
            current.root = current._id;
            await db.collection('messages').insertMany([legacy, current]);
            try {
                const roots = [legacy._id, current._id];
                const found = await resolveRoots(db.collection('messages'), user, roots);
                expect([...found.keys()].sort()).to.deep.equal(roots.map(String).sort());

                // once the migration has run for a user the legacy branch is not needed
                const migrated = await resolveRoots(db.collection('messages'), user, roots, { legacy: false });
                expect([...migrated.keys()]).to.deep.equal([current._id.toString()]);

                // another user's id never resolves
                const foreign = await resolveRoots(db.collection('messages'), new seed.ObjectId(), roots);
                expect(foreign.size).to.equal(0);
            } finally {
                await db.collection('messages').deleteMany({ user });
            }
        });

        scenario('WDP-012', async () => {
            const { user, doc } = await userWithMessage();
            const db = await seed.db();
            await db.collection('messages').updateOne({ _id: doc._id, mailbox: doc.mailbox, uid: doc.uid }, { $unset: { root: true } });

            await seed.withImap(user, async client => {
                await client.mailboxOpen('INBOX');
                await client.messageMove('1:*', 'Archive');
            });

            const [moved] = await messageDocs(user, 1);
            expect(moved._id.toString()).to.not.equal(doc._id.toString());
            expect(rootOf(moved)).to.equal(doc._id.toString());
        });

        scenario('WDP-013', async () => {
            const db = await seed.db();
            const user = new seed.ObjectId();
            const mailboxes = [new seed.ObjectId(), new seed.ObjectId(), new seed.ObjectId()];
            const docs = Array.from({ length: 300 }, (value, uid) =>
                rawDoc(user, { uid, mailbox: mailboxes[uid % 3], idate: new Date(Date.now() - uid * 60000), undeleted: true, thread: user })
            );
            await db.collection('messages').insertMany(docs);
            try {
                const explain = await db.collection('messages').find({ user, undeleted: true }).sort({ idate: -1, _id: -1 }).limit(50).explain();
                expect([...planIndexes(explain)]).to.include('user_idate');
                expect(JSON.stringify(explain.queryPlanner.winningPlan)).to.not.include('"stage":"SORT"');
            } finally {
                await db.collection('messages').deleteMany({ user });
            }
        });

        scenario('WDP-007', async () => {
            const db = await seed.db();
            const user = new seed.ObjectId();
            const mailbox = new seed.ObjectId();
            const keep = new seed.ObjectId();
            const docs = [
                { _id: new seed.ObjectId(), user, mailbox, uid: 1 },
                { _id: new seed.ObjectId(), user, mailbox, uid: 2 },
                { _id: new seed.ObjectId(), user, mailbox, uid: 3, root: keep }
            ];
            const archived = { _id: new seed.ObjectId(), user, mailbox, uid: 4 };
            await db.collection('messages').insertMany(docs);
            await db.collection('archived').insertOne(archived);
            try {
                expect(await repairUserRoots(db, user, { settleMs: 0 })).to.deep.equal({ filled: 3, separated: 0 });

                const stored = await db.collection('messages').find({ user }).sort({ uid: 1 }).toArray();
                expect(stored.map(rootOf)).to.deep.equal([docs[0]._id.toString(), docs[1]._id.toString(), keep.toString()]);
                expect(rootOf(await db.collection('archived').findOne({ _id: archived._id }))).to.equal(archived._id.toString());

                // running it again changes nothing
                expect(await repairUserRoots(db, user, { settleMs: 0 })).to.deep.equal({ filled: 0, separated: 0 });
            } finally {
                await db.collection('messages').deleteMany({ user });
                await db.collection('archived').deleteMany({ user });
            }
        });

        scenario('WDP-008', async () => {
            const db = await seed.db();
            const user = new seed.ObjectId();
            const root = new seed.ObjectId();
            const original = rawDoc(user, { _id: root, root });
            const copies = [rawDoc(user, { root, uid: 1 }), rawDoc(user, { root, uid: 2 })];
            await db.collection('messages').insertMany([original, ...copies]);
            try {
                expect(await rootsChecked(db, user)).to.be.false;
                const result = await ensureUserRoots(db, user, { settleMs: 20 });
                expect(result).to.deep.equal({ repaired: true, filled: 0, separated: 2 });

                const stored = await db.collection('messages').find({ user }).toArray();
                for (const doc of stored) {
                    expect(rootOf(doc)).to.equal(doc._id.toString());
                }
                expect(await rootsChecked(db, user)).to.be.true;

                // a second call is a no-op, and so is a repair that is interrupted and run again
                expect(await ensureUserRoots(db, user)).to.deep.equal({ repaired: false });
                expect(await repairUserRoots(db, user, { settleMs: 0 })).to.deep.equal({ filled: 0, separated: 0 });
            } finally {
                await db.collection('messages').deleteMany({ user });
                await db.collection('jmapstate').deleteOne({ _id: user });
            }
        });

        scenario('WDP-011', async () => {
            const db = await seed.db();
            const shared = new seed.ObjectId();
            const clean = new seed.ObjectId();
            const root = new seed.ObjectId();
            await db.collection('messages').insertMany([
                { _id: root, root, user: shared, mailbox: new seed.ObjectId(), uid: 1 },
                { _id: new seed.ObjectId(), root, user: shared, mailbox: new seed.ObjectId(), uid: 1 },
                { _id: new seed.ObjectId(), root: new seed.ObjectId(), user: clean, mailbox: new seed.ObjectId(), uid: 1 }
            ]);
            try {
                const groups = await findDuplicateRoots(db.collection('messages'), shared);
                expect(groups).to.have.length(1);
                expect(groups[0].root.toString()).to.equal(root.toString());
                expect(groups[0].docs[0]._id.toString()).to.equal(root.toString());
                expect(await findDuplicateRoots(db.collection('messages'), clean)).to.deep.equal([]);
            } finally {
                await db.collection('messages').deleteMany({ user: { $in: [shared, clean] } });
            }
        });

        scenario('WDP-010', async () => {
            const db = await seed.db();
            const user = new seed.ObjectId();
            // a user with many messages, looking up two of them: the planner has to prefer the selective index
            const docs = Array.from({ length: 200 }, (value, uid) => {
                const _id = new seed.ObjectId();
                return { _id, root: _id, user, mailbox: user, uid, thread: user };
            });
            const roots = [docs[10].root, docs[150].root];
            for (const name of ['messages', 'archived']) {
                await db.collection(name).insertMany(docs.map(doc => Object.assign({}, doc)));
                const index = (await db.collection(name).indexes()).find(entry => entry.name === 'by_root');
                expect(index, `by_root on ${name}`).to.exist;
                expect(index.key).to.deep.equal({ root: 1 });
                expect(index.unique).to.not.be.true;

                const explain = await db
                    .collection(name)
                    .find({ user, root: { $in: roots, $exists: true } })
                    .explain();
                expect([...planIndexes(explain)], `plan on ${name}`).to.include('by_root');
                await db.collection(name).deleteMany({ user });
            }
        });
    });

    describe('change journal', () => {
        scenario('WDP-020', async () => {
            const { user, boxes, doc } = await userWithMessage();

            await seed.withImap(user, async client => {
                await client.mailboxOpen('INBOX');
                await client.messageFlagsAdd('1', ['\\Flagged']);
                await client.messageCopy('1', 'Archive');
                await client.messageMove('1', 'Archive');
            });
            await api('PUT', `/users/${user.id}/mailboxes/${boxes.Archive.id}/messages`, { message: '1:*', seen: true });
            const stored = await messageDocs(user, 2);
            await api('DELETE', `/users/${user.id}/mailboxes/${boxes.Archive.id}/messages/${stored[0].uid}`);

            const db = await seed.db();
            const roots = new Map(stored.map(entry => [entry._id.toString(), rootOf(entry)]));
            roots.set(doc._id.toString(), rootOf(doc));
            const entries = await journal(user);
            const commands = new Set(entries.map(entry => entry.command));
            expect([...commands].sort()).to.deep.equal(['EXISTS', 'EXPUNGE', 'FETCH']);
            for (const entry of entries) {
                expect(entry.root, `${entry.command} entry of ${entry.message}`).to.exist;
                const known = roots.get(entry.message.toString());
                if (known) {
                    expect(entry.root.toString()).to.equal(known);
                }
            }
            // the archived message keeps the root its journal entries name
            const archived = await db.collection('archived').findOne({ user: new seed.ObjectId(user.id) });
            expect(entries.some(entry => entry.command === 'EXPUNGE' && entry.root.toString() === rootOf(archived))).to.be.true;
        });

        scenario('WDP-021', async () => {
            const { user, boxes, doc } = await userWithMessage();

            await seed.withImap(user, async client => {
                await client.mailboxOpen('INBOX');
                await client.messageMove('1', 'Archive');
            });

            const entries = await journal(user, { command: { $in: ['EXISTS', 'EXPUNGE'] } });
            const expunge = entries.find(entry => entry.command === 'EXPUNGE');
            const exists = entries.filter(entry => entry.command === 'EXISTS').pop();
            expect(expunge.mailbox.toString()).to.equal(boxes.INBOX.id);
            expect(exists.mailbox.toString()).to.equal(boxes.Archive.id);
            expect(expunge.root.toString()).to.equal(rootOf(doc));
            expect(exists.root.toString()).to.equal(rootOf(doc));
            expect(exists.message.toString()).to.not.equal(expunge.message.toString());
        });

        scenario('WDP-022', async () => {
            const { user, boxes, doc } = await userWithMessage();

            await seed.withImap(user, async client => {
                await client.append('INBOX', await fixtures.buildMessage());
                await client.mailboxOpen('INBOX');
                await client.messageCopy('1', 'Archive');
                await client.messageMove('1', 'Archive');
            });
            await api('POST', `/users/${user.id}/mailboxes/${boxes.INBOX.id}/messages`, { subject: 'uploaded', text: 'Hello' });
            const moved = (await messageDocs(user, 4)).find(entry => rootOf(entry) === rootOf(doc));
            await api('DELETE', `/users/${user.id}/mailboxes/${boxes.Archive.id}/messages/${moved.uid}`);
            const db = await seed.db();
            const archived = await db.collection('archived').findOne({ _id: moved._id });
            await api('POST', `/users/${user.id}/archived/messages/${archived._id}/restore`, {});
            await messageDocs(user, 4);

            const origins = (await journal(user, { command: 'EXISTS' })).map(entry => entry.origin);
            expect(origins).to.have.members(['lmtp', 'imap', 'copy', 'move', 'api', 'restore']);
        });

        scenario('WDP-027', async () => {
            const { user, doc } = await userWithMessage();
            const [first] = await journal(user);

            // replay after the first entry, the way a reconnecting client asks for it
            await seed.withImap(user, async client => {
                await client.mailboxOpen('INBOX');
                await client.messageFlagsAdd('1', ['\\Seen']);
            });
            const controller = new AbortController();
            const res = await fetch(`${API_URL}/users/${user.id}/updates`, { headers: { 'Last-Event-ID': first._id.toString() }, signal: controller.signal });
            expect(res.status).to.equal(200);
            const reader = res.body.getReader();
            let text = '';
            try {
                await clock.waitFor(async () => {
                    const { value } = await reader.read();
                    text += Buffer.from(value || []).toString();
                    return /"command": "FETCH"/.test(text);
                });
            } finally {
                controller.abort();
            }

            const event = text.split('\n\n').find(block => /"command": "FETCH"/.test(block));
            const data = JSON.parse(
                event
                    .split('\n')
                    .filter(line => line.startsWith('data: '))
                    .map(line => line.slice(6))
                    .join('\n')
            );
            expect(data.message).to.equal(doc._id.toString());
            expect(data.root).to.equal(rootOf(doc));
            expect(event).to.match(/^id: [0-9a-f]{24}$/m);
        });

        scenario('WDP-023', async () => {
            const { user, boxes } = await userWithMessage();
            const archive = boxes.Archive.id;
            const settingEntries = () =>
                seed.db().then(db =>
                    db
                        .collection('journal')
                        .find({ user: new seed.ObjectId(user.id), command: 'MAILBOX_UPDATE' })
                        .sort({ _id: 1 })
                        .toArray()
                );
            await seed.withImap(user, async client => {
                await client.mailboxUnsubscribe('Archive');
                await client.mailboxSubscribe('Archive');
            });
            await api('PUT', `/users/${user.id}/mailboxes/${archive}`, { retention: 3600 * 1000, hidden: true });

            // MailboxHandler.updateAsync is also how the JMAP service will store sortOrder
            const db = await seed.db();
            const handler = new MailboxHandler({ database: db, notifier: ImapNotifierStub });
            ImapNotifierStub.entries.length = 0;
            await handler.updateAsync(new seed.ObjectId(user.id), new seed.ObjectId(archive), { sortOrder: 5 });
            await handler.updateAsync(new seed.ObjectId(user.id), new seed.ObjectId(archive), { sortOrder: 5 });
            expect(ImapNotifierStub.entries).to.have.length(1);
            expect(ImapNotifierStub.entries[0].changes).to.deep.equal(['sortOrder']);

            const entries = await settingEntries();
            expect(entries.map(entry => entry.changes)).to.deep.equal([['subscribed'], ['subscribed'], ['retention', 'hidden']]);
            for (const entry of entries) {
                expect(entry.mailbox.toString()).to.equal(archive);
            }

            // a no-op update writes nothing
            await api('PUT', `/users/${user.id}/mailboxes/${archive}`, { hidden: true });
            await seed.withImap(user, client => client.mailboxSubscribe('INBOX'));
            expect(await settingEntries()).to.have.length(3);

            // settings changed together with a rename are journaled too
            const projects = await api('POST', `/users/${user.id}/mailboxes`, { path: 'Projects' });
            await api('PUT', `/users/${user.id}/mailboxes/${projects.id}`, { path: 'Projects 2026', retention: 7200 * 1000 });
            const renamed = (await settingEntries()).pop();
            expect(renamed.mailbox.toString()).to.equal(projects.id);
            expect(renamed.changes).to.deep.equal(['retention']);
        });

        scenario('WDP-024', async () => {
            const db = await seed.db();
            const ttlOf = async name => (await db.collection(name).indexes()).find(index => index.name === 'journal_autoexpire').expireAfterSeconds;

            // the test server set up the real journal index with the default
            expect(await ttlOf('journal')).to.equal(consts.JOURNAL_TIME / 1000);

            const probe = `journal_ttl_probe_${Date.now()}`;
            const entry = {
                collection: probe,
                ttlSetting: 'const:journal:time',
                index: { name: 'journal_autoexpire', expireAfterSeconds: 10800, key: { created: 1 } }
            };
            const setting = value => ({ get: async () => value });
            try {
                expect(await ensureIndex(db, entry, setting(consts.JOURNAL_TIME))).to.deep.equal({ created: true, ttlChanged: false });
                expect(await ttlOf(probe)).to.equal(10800);

                // an existing index with the old expiry is changed in place
                expect(await ensureIndex(db, entry, setting(7 * 24 * 3600 * 1000))).to.deep.equal({ created: false, ttlChanged: true });
                expect(await ttlOf(probe)).to.equal(7 * 24 * 3600);

                // the same value again changes nothing
                expect(await ensureIndex(db, entry, setting(7 * 24 * 3600 * 1000))).to.deep.equal({ created: false, ttlChanged: false });
            } finally {
                await db.collection(probe).drop();
            }
        });

        scenario('WDP-025', async () => {
            const { user, boxes } = await userWithMessage();
            const id = new seed.ObjectId(user.id);
            const db = await seed.db();

            await seed.withImap(user, async client => {
                await client.mailboxOpen('INBOX');
                await client.messageFlagsAdd('1', ['\\Seen']);
                await client.messageCopy('1', 'Archive');
            });
            await api('PUT', `/users/${user.id}/mailboxes/${boxes.Archive.id}/messages`, { message: '1:*', flagged: true });

            const newest = (await journal(user)).pop();
            const anchors = await journalAnchors(db, id);
            expect(anchors.journal.toString()).to.equal(newest._id.toString());
            const state = await db.collection('jmapstate').findOne({ _id: id });
            expect(state.journal.toString()).to.equal(newest._id.toString());

            // an entry committed late by another process with a smaller id does not move the anchor back
            const older = seed.ObjectId.createFromTime(Math.floor(newest._id.getTimestamp().getTime() / 1000) - 1);
            await db
                .collection('journal')
                .insertOne({ _id: older, user: id, command: 'FETCH', mailbox: new seed.ObjectId(boxes.INBOX.id), created: new Date() });
            expect((await journalAnchors(db, id)).journal.toString()).to.equal(newest._id.toString());

            // the delivery anchor is the newest entry that added an Email (the copy), not the later flag change
            const copy = (await journal(user, { command: 'EXISTS', origin: 'copy' })).pop();
            expect(anchors.delivery.toString()).to.equal(copy._id.toString());
        });

        scenario('WDP-026', async () => {
            const { user } = await userWithMessage();
            const id = new seed.ObjectId(user.id);
            const db = await seed.db();

            const before = await journalAnchors(db, id);
            // the journal entries expire
            await db.collection('journal').deleteMany({ user: id });
            const after = await journalAnchors(db, id);
            expect(after.journal.toString()).to.equal(before.journal.toString());
            expect(after.delivery.toString()).to.equal(before.delivery.toString());

            // once the anchor is older than the retention, with nothing newer, a fresh one is minted
            const minted = await journalAnchors(db, id, { retention: 1 });
            expect(minted.journal.toString()).to.not.equal(before.journal.toString());
        });

        scenario('WDP-028', async () => {
            const { user, boxes } = await userWithMessage();
            const client = await seed.imap(user);
            try {
                await client.mailboxOpen('INBOX');
                let exists = 0;
                client.on('exists', () => exists++);

                // a mailbox setting change on the selected mailbox while the session idles
                await api('PUT', `/users/${user.id}/mailboxes/${boxes.INBOX.id}`, { subscribed: false });
                await client.noop();
                expect(client.usable).to.be.true;
                expect(exists).to.equal(0);

                // the session still follows ordinary changes
                await seed.deliver(user.address, await fixtures.buildMessage());
                await clock.waitFor(async () => {
                    await client.noop();
                    return exists > 0;
                });
            } finally {
                await client.logout();
            }
        });
    });

    describe('temporary uploads', () => {
        const storage = async () => {
            const db = await seed.db();
            return new StorageHandler({ database: db, gridfs: db });
        };
        const past = () => new Date(Date.now() - 1000);
        const future = () => new Date(Date.now() + 24 * 3600 * 1000);
        const exists = async (db, id) => !!(await db.collection('storage.files').findOne({ _id: id }));

        scenario('WDP-040', async () => {
            const db = await seed.db();
            const handler = await storage();
            const user = new seed.ObjectId();
            const expiring = await handler.add(user, { filename: 'a.txt', content: Buffer.from('temporary'), expires: past() });
            const permanent = await handler.add(user, { filename: 'b.txt', content: Buffer.from('permanent') });
            const pending = await handler.add(user, { filename: 'c.txt', content: Buffer.from('not yet'), expires: future() });
            try {
                await handler.removeExpiredUploads();
                expect(await exists(db, expiring)).to.be.false;
                expect(await db.collection('storage.chunks').countDocuments({ files_id: expiring })).to.equal(0);
                expect(await exists(db, permanent)).to.be.true;
                expect(await exists(db, pending)).to.be.true;
            } finally {
                await db.collection('storage.files').deleteMany({ 'metadata.user': user });
            }
        });

        scenario('WDP-041', async () => {
            const db = await seed.db();
            const handler = await storage();
            const { user, boxes } = await userWithMessage();
            const owner = new seed.ObjectId(user.id);
            const content = Buffer.from('attachment that outlives its upload');
            const file = await handler.add(owner, { filename: 'note.txt', contentType: 'text/plain', content, expires: past() });

            // temporary uploads are not storage files: the REST storage API does not list or serve them
            const listing = await api('GET', `/users/${user.id}/storage`);
            expect(listing.results.map(entry => entry.id)).to.not.include(file.toString());
            expect((await fetch(`${API_URL}/users/${user.id}/storage/${file}`)).status).to.equal(404);

            // consumed into a message the way the JMAP service stores it: the content is copied into the message
            const upload = await handler.get(owner, file, { temporary: true });
            const draft = await api('POST', `/users/${user.id}/mailboxes/${boxes.Drafts.id}/messages`, {
                subject: 'draft',
                text: 'see attached',
                draft: true,
                attachments: [{ filename: upload.filename, contentType: upload.contentType, encoding: 'base64', content: upload.content.toString('base64') }]
            });
            await handler.removeExpiredUploads();
            expect(await exists(db, file)).to.be.false;

            const message = await api('GET', `/users/${user.id}/mailboxes/${boxes.Drafts.id}/messages/${draft.message.id}`);
            const attachment = message.attachments.find(entry => entry.filename === 'note.txt');
            const res = await fetch(`${API_URL}/users/${user.id}/mailboxes/${boxes.Drafts.id}/messages/${draft.message.id}/attachments/${attachment.id}`);
            expect(res.status).to.equal(200);
            expect(Buffer.from(await res.arrayBuffer()).equals(content)).to.be.true;
        });

        scenario('WDP-042', async () => {
            const handler = await storage();
            const user = new seed.ObjectId();
            const size = 30 * 1024 * 1024;
            const chunk = crypto.randomBytes(1024 * 1024);
            const source = Readable.from(Array.from({ length: size / chunk.length }, () => chunk));
            const id = await handler.add(user, { filename: 'large.bin', content: source, expires: future() });
            try {
                const { fileData, stream } = await handler.openStream(user, id, { temporary: true });
                expect(fileData.length).to.equal(size);
                const hash = crypto.createHash('sha256');
                let reads = 0;
                for await (const part of stream) {
                    hash.update(part);
                    reads++;
                }
                const expected = crypto.createHash('sha256');
                for (let i = 0; i < size / chunk.length; i++) {
                    expected.update(chunk);
                }
                expect(hash.digest('hex')).to.equal(expected.digest('hex'));
                // delivered in GridFS chunks, not as one buffer
                expect(reads).to.be.above(100);

                // another user can not open it
                let error;
                await handler.openStream(new seed.ObjectId(), id, { temporary: true }).catch(err => (error = err));
                expect(error && error.code).to.equal('FileNotFound');
            } finally {
                await handler.delete(user, id, { temporary: true });
            }
        });

        scenario('WDP-043', async () => {
            const db = await seed.db();
            const handler = await storage();
            const { user } = await userWithMessage();
            const owner = new seed.ObjectId(user.id);
            const quota = 1000;
            const used = async () => (await api('GET', `/users/${user.id}`)).limits.quota.used;
            const before = await used();

            const first = await handler.add(owner, { content: Buffer.alloc(400), expires: future(), quota, size: 400 });
            const second = await handler.add(owner, { content: Buffer.alloc(400), expires: future(), quota, size: 400 });
            const permanent = await handler.add(owner, { content: Buffer.alloc(5000) });

            // the third does not fit: the oldest temporary upload makes room, permanent files do not count
            const third = await handler.add(owner, { content: Buffer.alloc(400), expires: future(), quota, size: 400 });
            expect(await exists(db, first)).to.be.false;
            expect(await exists(db, second)).to.be.true;
            expect(await exists(db, third)).to.be.true;
            expect(await exists(db, permanent)).to.be.true;

            // a file larger than the whole quota is refused
            let error;
            await handler.add(owner, { content: Buffer.alloc(2000), expires: future(), quota, size: 2000 }).catch(err => (error = err));
            expect(error && error.code).to.equal('OverQuota');

            // mail delivery is unaffected and uploads do not count against the mail quota
            expect(await used()).to.equal(before);
            await seed.deliver(user.address, await fixtures.buildMessage());
            await messageDocs(user, 2);
        });
    });

    describe('authentication scope', () => {
        // POST /authenticate with a required scope, as the JMAP service will authenticate Basic credentials
        const authenticate = (user, password, scope) => api('POST', '/authenticate', { username: user.username, password, scope }).catch(err => err);

        scenario('WDP-050', async () => {
            const user = await accounts.createUser();
            const [jmap, imap, any] = await Promise.all([
                accounts.createAsp(user, ['jmap']),
                accounts.createAsp(user, ['imap']),
                accounts.createAsp(user, ['*'])
            ]);

            expect(await authenticate(user, jmap, 'jmap')).to.include({ success: true, scope: 'jmap' });
            expect(await authenticate(user, any, 'jmap')).to.include({ success: true, scope: 'jmap' });
            const refused = await authenticate(user, imap, 'jmap');
            expect(refused).to.be.instanceOf(Error);
            expect(refused.status).to.equal(403);

            const log = await api('GET', `/users/${user.id}/authlog?limit=20`);
            expect(log.results.some(entry => entry.requiredScope === 'jmap' || entry.scope === 'jmap')).to.be.true;
        });

        scenario('WDP-051', async () => {
            const user = await accounts.createUser();
            const asp = await accounts.createAsp(user, ['*']);
            expect(await authenticate(user, user.password, 'jmap')).to.include({ success: true });

            await api('PUT', `/users/${user.id}`, { disabledScopes: ['jmap'] });
            for (const password of [user.password, asp]) {
                const refused = await authenticate(user, password, 'jmap');
                expect(refused, 'jmap scope disabled').to.be.instanceOf(Error);
                expect(refused.status).to.equal(403);
            }
            // other scopes keep working
            expect(await authenticate(user, asp, 'imap')).to.include({ success: true });
        });
    });
});
