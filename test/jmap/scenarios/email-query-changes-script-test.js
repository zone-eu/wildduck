/* eslint no-unused-expressions: 0 */
'use strict';

// Catalogue file email-query.yaml: Email/queryChanges over a scripted run of mixed changes, and over a
// large window seeded in the database (phase 4, work package 4.3).

const { expect } = require('chai');
const { scenario, api, seed } = require('../harness');
const { setup, rawMessage, imapIn, query, threadMessages, deliverTo, applyChanges } = require('./email-query-helpers');

const DESC = [{ property: 'receivedAt', isAscending: false }];
const ASC = [{ property: 'receivedAt', isAscending: true }];

/** Where a message with this Email id is stored now: {mailbox, uid, path} */
async function locate(ctx, id) {
    const db = await seed.db();
    const doc = await db
        .collection('messages')
        .find({ user: new seed.ObjectId(ctx.user.id), root: new seed.ObjectId(id.slice(1)) }, { projection: { mailbox: true, uid: true } })
        .sort({ _id: -1 })
        .limit(1)
        .next();
    expect(doc, id).to.exist;
    const path = Object.keys(ctx.boxes).find(name => ctx.boxes[name].id === doc.mailbox.toString() && !name.startsWith('\\'));
    return { mailbox: doc.mailbox.toString(), uid: doc.uid, path };
}

async function onMessage(ctx, id, fn) {
    const { path, uid } = await locate(ctx, id);
    return imapIn(ctx, path, client => fn(client, String(uid)));
}

describe('Email/queryChanges against recorded results (email-query.yaml)', function () {
    this.timeout(300000); // eslint-disable-line no-invalid-this

    scenario('EQRY-180', async () => {
        const ctx = await setup(['Work']);
        const inbox = ctx.mailbox('INBOX');
        const variants = [
            { filter: null },
            { filter: { inMailbox: inbox }, sort: ASC },
            { filter: { hasKeyword: '$flagged' }, sort: DESC },
            { sort: [{ property: 'hasKeyword', keyword: '$seen', isAscending: false }, ...ASC] },
            { filter: { inMailbox: inbox }, sort: DESC, collapseThreads: true }
        ];
        const [a1, a2, a3] = threadMessages('a180', 3);
        const [b1] = threadMessages('b180', 1);
        const [c1] = threadMessages('c180', 1);
        const [d1] = threadMessages('d180', 1);
        const id = {};
        const flags = (name, add, list) =>
            onMessage(ctx, id[name], (client, uid) => client[add ? 'messageFlagsAdd' : 'messageFlagsRemove'](uid, list, { uid: true }));
        const move = (name, path) => onMessage(ctx, id[name], (client, uid) => client.messageMove(uid, ctx.boxes[path].path, { uid: true }));
        const restDelete = async name => {
            const { mailbox, uid } = await locate(ctx, id[name]);
            await api('DELETE', `/users/${ctx.user.id}/mailboxes/${mailbox}/messages/${uid}`);
        };
        const update = (name, patch) => ctx.client.method('Email/set', { update: { [id[name]]: patch } });

        const steps = [
            async () => (id.a1 = await deliverTo(ctx, a1)),
            async () => (id.b1 = await deliverTo(ctx, b1)),
            () => flags('a1', true, ['\\Flagged']),
            async () => (id.a2 = await deliverTo(ctx, a2)),
            () => flags('b1', true, ['\\Seen']),
            () => move('b1', 'Work'),
            () => onMessage(ctx, id.a1, (client, uid) => client.messageCopy(uid, ctx.boxes.Work.path, { uid: true })),
            async () => (id.c1 = await deliverTo(ctx, c1)),
            () => flags('a2', true, ['\\Deleted']),
            () => flags('a2', false, ['\\Deleted']),
            () => update('c1', { 'keywords/$flagged': true }),
            () => restDelete('b1'),
            async () => {
                await flags('a1', true, ['\\Deleted']);
                await onMessage(ctx, id.a1, (client, uid) => client.messageDelete(uid, { uid: true }));
            },
            async () => (id.a3 = await deliverTo(ctx, a3)),
            () => update('a3', { mailboxIds: { [ctx.mailbox('Work')]: true } }),
            () => flags('a2', true, ['\\Seen', '\\Flagged']),
            async () => (id.d1 = await deliverTo(ctx, d1)),
            () => move('c1', 'Work'),
            () => move('c1', 'INBOX'),
            () => restDelete('d1'),
            () => update('a2', { 'keywords/$flagged': null }),
            async () => (id.e1 = await deliverTo(ctx, rawMessage({ subject: 'Last 180', messageId: `<e180.${Date.now()}@test.example>` })))
        ];

        // recorded[v][j]: the result and state of variant v after step j
        const recorded = variants.map(() => []);
        let checked = 0;
        const record = async () => {
            for (const [v, args] of variants.entries()) {
                const res = await query(ctx, args);
                const j = recorded[v].push({ ids: res.ids, state: res.queryState }) - 1;
                for (let i = 0; i < j; i++) {
                    const changed = await ctx.client.method('Email/queryChanges', Object.assign({ sinceQueryState: recorded[v][i].state }, args));
                    const label = `variant ${v} from step ${i} to ${j}`;
                    expect(changed.newQueryState, label).to.equal(res.queryState);
                    expect(applyChanges(recorded[v][i].ids, changed), label).to.deep.equal(res.ids);
                    checked++;
                }
            }
        };
        await record();
        for (const step of steps) {
            await step();
            await record();
        }
        expect(checked).to.equal((variants.length * steps.length * (steps.length + 1)) / 2);
    });

    scenario('EQRY-197', async () => {
        const COUNT = 50000;
        const CHANGED = 2000;
        const ctx = await setup(['Large']);
        const db = await seed.db();
        const owner = new seed.ObjectId(ctx.user.id);
        const mailbox = new seed.ObjectId(ctx.boxes.Large.id);
        const base = Date.UTC(2023, 0, 1);
        let uid = 0;
        const docs = index => {
            const _id = new seed.ObjectId();
            const date = new Date(base + index * 1000);
            uid++;
            return {
                _id,
                root: _id,
                user: owner,
                mailbox,
                uid,
                modseq: 1,
                thread: new seed.ObjectId(),
                idate: date,
                hdate: date,
                size: 1000,
                flags: [],
                unseen: true,
                flagged: false,
                draft: false,
                undeleted: true,
                searchable: true,
                headers: [{ key: 'subject', value: `bulk ${index}` }],
                ha: false,
                subject: `bulk ${index}`,
                copied: false
            };
        };
        const insert = async (from, to) => {
            const inserted = [];
            for (let start = from; start < to; start += 10000) {
                const batch = Array.from({ length: Math.min(10000, to - start) }, (item, k) => docs(start + k));
                await db.collection('messages').insertMany(batch, { ordered: false });
                inserted.push(...batch);
            }
            return inserted;
        };
        const seeded = await insert(0, COUNT);

        const args = { filter: { inMailbox: ctx.mailbox('Large') }, sort: DESC };
        const before = await query(ctx, args);
        expect(before.ids).to.have.lengthOf(1000);

        // 2000 new messages and 2000 of the oldest removed, journalled as the handlers would
        const added = await insert(COUNT, COUNT + CHANGED);
        const removed = seeded.slice(0, CHANGED);
        await db.collection('messages').deleteMany({ _id: { $in: removed.map(doc => doc._id) } });
        const entry = (command, doc) => ({ command, user: owner, mailbox, message: doc._id, root: doc._id, uid: doc.uid, modseq: 2, thread: doc.thread });
        await db
            .collection('journal')
            .insertMany([...added.map(doc => entry('EXISTS', doc)), ...removed.map(doc => entry('EXPUNGE', doc))], { ordered: false });

        const started = Date.now();
        const res = await ctx.client.method('Email/queryChanges', Object.assign({ sinceQueryState: before.queryState, maxChanges: null }, args));
        expect(Date.now() - started).to.be.below(9000);
        const current = (await query(ctx, Object.assign({ limit: 1000 }, args))).ids;
        const patched = applyChanges(before.ids, res);
        // the client held the first 1000 results: after the changes it holds the beginning of the new list
        expect(patched.length).to.be.at.least(1000);
        expect(patched.slice(0, 1000)).to.deep.equal(current);
        expect(res.added.map(item => item.id)).to.include.members(added.map(doc => `M${doc._id}`));

        const err = await ctx.client
            .method('Email/queryChanges', Object.assign({ sinceQueryState: before.queryState, maxChanges: 500 }, args))
            .catch(error => error);
        expect(err.type).to.equal('tooManyChanges');
    });
});
