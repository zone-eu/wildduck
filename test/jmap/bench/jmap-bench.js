/* eslint no-console: 0 */
'use strict';

// End to end benchmark of the JMAP service on a large account, through the real HTTP service of a
// running WildDuck server (work package F.3, docs/jmap/performance.md).
//
// Seeds one account with MESSAGES messages in MAILBOXES mailboxes directly in MongoDB (cloned from
// messages uploaded through the REST API, so the documents are real), makes about 10,000 journal
// entries with one flag update through the REST API, then times Email/get, Email/query, Email/changes,
// Mailbox/get and Thread/get. Every operation is also run once with the MongoDB profiler on, and the
// queries it made are listed with the index used and the keys and documents examined. The last part
// opens STREAMS EventSource connections for STREAM_USERS users, delivers messages and measures the
// delivery latency, the server memory per connection and the MongoDB and Redis work per change.
//
// Run it against a server of its own, on a database that may be thrown away (it enables the profiler
// and leaves the seeded accounts in place):
//
//   NODE_ENV=test APPCONF_dbs_dbname=... node server.js &
//   NODE_ENV=test APPCONF_dbs_dbname=... node test/jmap/bench/jmap-bench.js [requests|eventsource|all]
//
// The server should use the production values of [jmap.changes] (the test configuration sets
// safetyWindow, maxChanges and retentionCacheTime for the scenario tests), for example with
// APPCONF_jmap_changes_safetyWindow=2000 APPCONF_jmap_changes_maxChanges=1500 APPCONF_jmap_changes_retentionCacheTime=60.

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('@zone-eu/wild-config');
const { MongoClient, ObjectId } = require('mongodb');
const Redis = require('ioredis');
const redisUrl = require('../../../lib/redis-url');

const MESSAGES = Number(process.env.MESSAGES) || 100000;
const MAILBOXES = Number(process.env.MAILBOXES) || 500;
const ROUNDS = Number(process.env.ROUNDS) || 30;
const STREAMS = Number(process.env.STREAMS) || 1000;
const STREAM_USERS = Number(process.env.STREAM_USERS) || 100;
const DELIVERIES = Number(process.env.DELIVERIES) || 200;
const FLAG_UPDATES = Number(process.env.FLAG_UPDATES) || 10000;
const API = `http://127.0.0.1:${config.api.port}`;
const JMAP = `http://127.0.0.1:${config.jmap.port}`;
const PASSWORD = 'Jm4pBench-Secret';
const URNS = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
const METADATA = ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'sentAt', 'from', 'to', 'subject', 'hasAttachment', 'preview'];

let database;
let redis;

// ---------------------------------------------------------------------------------------------------
// helpers

async function api(method, path, body, contentType = 'application/json') {
    const res = await fetch(API + path, {
        method,
        headers: body ? { 'Content-Type': contentType } : {},
        body: body ? (contentType === 'application/json' ? JSON.stringify(body) : body) : undefined
    });
    const json = await res.json();
    if (!res.ok || json.error) {
        throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
}

const basic = username => 'Basic ' + Buffer.from(`${username}:${PASSWORD}`).toString('base64');

async function jmap(account, methodCalls) {
    const res = await fetch(`${JMAP}/jmap/api/`, {
        method: 'POST',
        headers: { Authorization: account.authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            using: URNS,
            methodCalls: methodCalls.map(([name, args], i) => [name, Object.assign({ accountId: account.accountId }, args), `c${i}`])
        })
    });
    const json = await res.json();
    if (res.status !== 200) {
        throw new Error(`JMAP ${res.status} ${JSON.stringify(json)}`);
    }
    for (const [name, args] of json.methodResponses) {
        if (name === 'error') {
            throw new Error(`JMAP method error ${JSON.stringify(args)}`);
        }
    }
    return json.methodResponses.map(response => response[1]);
}

async function createUser(prefix) {
    const username = `${prefix}${crypto.randomBytes(5).toString('hex')}`;
    const res = await api('POST', '/users', { username, password: PASSWORD, address: `${username}@example.com`, name: username });
    const account = { id: res.id, user: new ObjectId(res.id), username, authorization: basic(username) };
    const session = await (await fetch(`${JMAP}/.well-known/jmap`, { headers: { Authorization: account.authorization } })).json();
    account.accountId = Object.keys(session.accounts)[0];
    return account;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const ms = value => `${value.toFixed(1)} ms`;
const results = [];

async function time(label, fn, rounds = ROUNDS) {
    await fn(-1); // warm up: connections, auth cache, query plans
    const samples = [];
    for (let i = 0; i < rounds; i++) {
        const started = process.hrtime.bigint();
        await fn(i);
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const row = { label, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
    results.push(row);
    console.log(`${label.padEnd(64)} p50 ${ms(row.p50).padStart(10)}  p95 ${ms(row.p95).padStart(10)}`);
    return row;
}

// The MongoDB profiler of the server database records every operation with its plan summary and the
// keys and documents examined: the same numbers as an explain of each query, for every query an
// operation makes. Operations are grouped by collection, kind and plan.
async function startProfiler() {
    await database.command({ profile: 0 });
    await database
        .collection('system.profile')
        .drop()
        .catch(() => false);
    await database.createCollection('system.profile', { capped: true, size: 256 * 1024 * 1024 });
    await database.command({ profile: 2 });
    return new Date();
}

async function stopProfiler(since) {
    await database.command({ profile: 0 });
    const entries = await database
        .collection('system.profile')
        // webhooks lookups come from the webhooks worker handling the events of earlier changes
        .find({ ts: { $gte: since }, ns: { $not: /\.(system\.|webhooks$)/ } })
        .toArray();
    const groups = new Map();
    for (const entry of entries) {
        const kind = entry.op === 'command' ? Object.keys(entry.command || {})[0] : entry.op;
        const key = `${entry.ns.split('.').slice(1).join('.')} ${kind} ${entry.planSummary || '-'}`;
        const group = groups.get(key) || { key, count: 0, keys: 0, docs: 0, returned: 0, maxKeys: 0, maxDocs: 0, millis: 0 };
        group.count++;
        group.keys += entry.keysExamined || 0;
        group.docs += entry.docsExamined || 0;
        group.returned += entry.nreturned || entry.nMatched || 0;
        group.maxKeys = Math.max(group.maxKeys, entry.keysExamined || 0);
        group.maxDocs = Math.max(group.maxDocs, entry.docsExamined || 0);
        group.millis += entry.millis || 0;
        groups.set(key, group);
    }
    return { total: entries.length, groups: [...groups.values()].sort((a, b) => b.keys + b.docs - (a.keys + a.docs)) };
}

async function profile(label, fn) {
    const since = await startProfiler();
    await fn();
    const { total, groups } = await stopProfiler(since);
    const row = results.find(item => item.label === label);
    if (row) {
        row.profile = groups;
    }
    console.log(`  ${total} operations:`);
    for (const group of groups) {
        const scan = /COLLSCAN/.test(group.key) ? '  <-- COLLSCAN' : '';
        console.log(
            `    ${String(group.count).padStart(4)}x ${group.key}  keys ${group.keys} docs ${group.docs} returned ${group.returned} (max per op keys ${group.maxKeys} docs ${group.maxDocs})${scan}`
        );
    }
    return groups;
}

async function measure(label, fn, rounds) {
    await time(label, fn, rounds);
    await profile(label, () => fn(0));
}

// ---------------------------------------------------------------------------------------------------
// seeding

function messageSource(n, kind) {
    const header = [
        `From: Sender ${n} <sender${n % 300}@example.com>`,
        'To: Bench <bench@example.com>',
        `Subject: Bench message template ${kind}`,
        `Message-ID: <template-${kind}-${n}@example.com>`,
        'Date: Mon, 9 Nov 2026 10:00:00 +0000',
        'MIME-Version: 1.0'
    ];
    const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore'.split(' ');
    const paragraph = size => Array.from({ length: size }, (v, i) => words[(i * 7 + n) % words.length]).join(' ');
    if (kind === 'alternative') {
        return [
            ...header,
            'Content-Type: multipart/alternative; boundary="b1"',
            '',
            '--b1',
            'Content-Type: text/plain; charset=utf-8',
            '',
            paragraph(300),
            '--b1',
            'Content-Type: text/html; charset=utf-8',
            '',
            `<html><body><p>${paragraph(300)}</p></body></html>`,
            '--b1--',
            ''
        ].join('\r\n');
    }
    return [...header, 'Content-Type: text/plain; charset=utf-8', '', paragraph(kind === 'long' ? 1200 : 40), ''].join('\r\n');
}

async function seedAccount() {
    const started = Date.now();
    const account = await createUser('bench');
    const listed = await api('GET', `/users/${account.id}/mailboxes`);
    const inbox = listed.results.find(mailbox => mailbox.path === 'INBOX');

    // three real messages as templates: short plain text, multipart/alternative, long plain text
    const templates = [];
    for (const [i, kind] of ['short', 'alternative', 'long'].entries()) {
        const res = await api('POST', `/users/${account.id}/mailboxes/${inbox.id}/messages`, messageSource(i, kind), 'message/rfc822');
        templates.push(await database.collection('messages').findOne({ mailbox: new ObjectId(inbox.id), uid: res.message.id }));
    }
    await database.collection('messages').deleteMany({ user: account.user });
    await database.collection('journal').deleteMany({ user: account.user });

    const inboxDoc = await database.collection('mailboxes').findOne({ _id: new ObjectId(inbox.id) });
    const extra = Array.from({ length: Math.max(0, MAILBOXES - listed.results.length) }, (v, i) => ({
        _id: new ObjectId(),
        user: account.user,
        path: `Bench/Folder ${String(i + 1).padStart(3, '0')}`,
        specialUse: null,
        uidValidity: inboxDoc.uidValidity,
        uidNext: 1,
        modifyIndex: 0,
        subscribed: true,
        flags: [],
        retention: 0
    }));
    if (extra.length) {
        await database.collection('mailboxes').insertMany(extra);
    }
    const mailboxes = listed.results.map(mailbox => ({ _id: new ObjectId(mailbox.id), path: mailbox.path })).concat(extra);
    const others = mailboxes.filter(mailbox => mailbox.path !== 'INBOX');
    const state = new Map(mailboxes.map(mailbox => [mailbox._id.toString(), { uid: 0, thread: null }]));

    // every fifth message goes to INBOX, the rest round robin over the other mailboxes; three
    // consecutive messages of a mailbox share a thread; received dates span two years
    const span = 2 * 365 * 24 * 3600 * 1000;
    const begin = Date.now() - span;
    const threads = [];
    let batch = [];
    const flush = async () => {
        if (batch.length) {
            await database.collection('messages').insertMany(batch, { ordered: false });
            batch = [];
        }
        if (threads.length) {
            await database.collection('threads').insertMany(threads.splice(0), { ordered: false });
        }
    };
    for (let i = 0; i < MESSAGES; i++) {
        const mailbox = i % 5 === 0 ? mailboxes.find(item => item.path === 'INBOX') : others[i % others.length];
        const mailboxState = state.get(mailbox._id.toString());
        const uid = ++mailboxState.uid;
        if ((uid - 1) % 3 === 0) {
            mailboxState.thread = new ObjectId();
            threads.push({
                _id: mailboxState.thread,
                user: account.user,
                ids: [crypto.randomBytes(20).toString('base64').slice(0, 27)],
                subject: 'Bench',
                updated: new Date()
            });
        }
        const template = templates[i % templates.length];
        const _id = new ObjectId();
        const idate = new Date(begin + Math.floor((i * span) / MESSAGES));
        const unseen = i % 10 < 3;
        const flagged = i % 20 === 0;
        const flags = [].concat(unseen ? [] : ['\\Seen'], flagged ? ['\\Flagged'] : []);
        batch.push(
            Object.assign({}, template, {
                _id,
                root: _id,
                user: account.user,
                mailbox: mailbox._id,
                uid,
                modseq: uid + 1,
                idate,
                hdate: idate,
                thread: mailboxState.thread,
                flags,
                unseen,
                flagged,
                msgid: `<bench-${i}@example.com>`,
                // a word on 1% of the messages, for the text filter
                text: `${template.text} benchword${i % 100}`
            })
        );
        if (batch.length >= 5000) {
            await flush();
        }
    }
    await flush();
    await database.collection('mailboxes').bulkWrite(
        mailboxes.map(mailbox => {
            const { uid } = state.get(mailbox._id.toString());
            return { updateOne: { filter: { _id: mailbox._id }, update: { $set: { uidNext: uid + 1, modifyIndex: uid + 1 } } } };
        })
    );
    await database.collection('users').updateOne({ _id: account.user }, { $set: { storageUsed: MESSAGES * 4096 } });
    account.inbox = mailboxes.find(item => item.path === 'INBOX')._id.toString();
    account.inboxId = `F${account.inbox}`;
    account.folderId = `F${others[others.length - 1]._id}`;
    account.mailboxCount = mailboxes.length;
    console.log(`seeded ${MESSAGES} messages, ${mailboxes.length} mailboxes for ${account.username} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    return account;
}

// ---------------------------------------------------------------------------------------------------
// request benchmarks

async function requestBenchmarks() {
    const account = await seedAccount();
    const ids = (
        await database
            .collection('messages')
            .find({ user: account.user }, { projection: { _id: 1 } })
            .toArray()
    ).map(doc => `M${doc._id}`);
    const sample = n => Array.from({ length: n }, () => ids[Math.floor(Math.random() * ids.length)]);

    // the first request of an account checks that every message has a root (one time migration)
    let started = Date.now();
    await jmap(account, [['Email/get', { ids: sample(1), properties: ['id'] }]]);
    console.log(`first request of the account (root check of ${MESSAGES} messages): ${Date.now() - started} ms`);

    // about FLAG_UPDATES journal entries, written by the REST API like any other client change
    const [{ state: beforeFlags }] = await jmap(account, [['Email/get', { ids: [], properties: ['id'] }]]);
    started = Date.now();
    await api('PUT', `/users/${account.id}/mailboxes/${account.inbox}/messages`, { message: `1:${FLAG_UPDATES}`, flagged: true });
    const journalEntries = await database.collection('journal').countDocuments({ user: account.user });
    console.log(`flag update through the REST API: ${journalEntries} journal entries in ${Date.now() - started} ms`);

    console.log('\nEmail/get');
    for (const n of [50, 500]) {
        await measure(`Email/get ${n} ids, metadata`, () => jmap(account, [['Email/get', { ids: sample(n), properties: METADATA }]]));
        await measure(`Email/get ${n} ids, default properties and all bodyValues`, () =>
            jmap(account, [['Email/get', { ids: sample(n), fetchAllBodyValues: true, maxBodyValueBytes: 4096 }]])
        );
    }

    console.log('\nEmail/query');
    const sort = [{ property: 'receivedAt', isAscending: false }];
    const query = args => () => jmap(account, [['Email/query', Object.assign({ sort, limit: 50 }, args)]]);
    await measure('Email/query account, receivedAt, position 0', query({}));
    await measure('Email/query account, receivedAt, position 500', query({ position: 500 }));
    await measure('Email/query account, receivedAt, position 5000', query({ position: 5000 }));
    await measure('Email/query account, receivedAt, calculateTotal', query({ calculateTotal: true }));
    for (const position of [2000, 50000]) {
        const [anchorPage] = await jmap(account, [['Email/query', { sort, position, limit: 1 }]]);
        await measure(`Email/query account, anchor at position ${position}`, query({ anchor: anchorPage.ids[0], anchorOffset: -10 }));
    }
    await measure('Email/query inMailbox INBOX (20%), position 0', query({ filter: { inMailbox: account.inboxId } }));
    await measure(
        'Email/query inMailbox INBOX, position 5000, calculateTotal',
        query({ filter: { inMailbox: account.inboxId }, position: 5000, calculateTotal: true })
    );
    await measure('Email/query inMailbox small folder', query({ filter: { inMailbox: account.folderId } }));
    await measure('Email/query text filter (1% of messages)', query({ filter: { text: 'benchword7' } }));
    await measure('Email/query text filter in INBOX', query({ filter: { text: 'benchword10', inMailbox: account.inboxId } }));
    await measure('Email/query account, collapseThreads', query({ collapseThreads: true }));
    await measure('Email/query inMailbox INBOX, collapseThreads', query({ filter: { inMailbox: account.inboxId }, collapseThreads: true }));

    console.log('\nEmail/changes');
    for (const maxChanges of [50, 500]) {
        await measure(`Email/changes over ${journalEntries} entries, maxChanges ${maxChanges}, first page`, () =>
            jmap(account, [['Email/changes', { sinceState: beforeFlags, maxChanges }]])
        );
    }
    // a client catching up: pages until hasMoreChanges is false
    const walk = async () => {
        let since = beforeFlags;
        let ids = 0;
        for (let page = 1; page <= 200; page++) {
            const [res] = await jmap(account, [['Email/changes', { sinceState: since, maxChanges: 500 }]]);
            ids += res.created.length + res.updated.length + res.destroyed.length;
            if (!res.hasMoreChanges) {
                return { page, ids, done: true };
            }
            since = res.newState;
        }
        return { page: 200, ids, done: false };
    };
    const pages = await walk();
    console.log(`Email/changes paging with maxChanges 500: ${pages.done ? 'done' : 'NOT done'} after ${pages.page} pages, ${pages.ids} ids reported`);
    if (pages.done) {
        await measure(`Email/changes over ${journalEntries} entries, maxChanges 500, all pages`, walk, Math.min(ROUNDS, 5));
    }

    console.log('\nMailbox/get');
    const countKeys = (
        await database
            .collection('mailboxes')
            .find({ user: account.user }, { projection: { _id: 1 } })
            .toArray()
    ).map(doc => `jmap:mbc:${doc._id}`);
    await measure(`Mailbox/get all ${account.mailboxCount} mailboxes with counts, cold`, async () => {
        await redis.del(...countKeys);
        await jmap(account, [['Mailbox/get', { ids: null }]]);
    });
    await measure(`Mailbox/get all ${account.mailboxCount} mailboxes with counts, cached`, () => jmap(account, [['Mailbox/get', { ids: null }]]));

    console.log('\nThread/get');
    await measure('Thread/get 50 threads', async () => {
        const [emails] = await jmap(account, [['Email/get', { ids: sample(50), properties: ['threadId'] }]]);
        await jmap(account, [['Thread/get', { ids: emails.list.map(email => email.threadId) }]]);
    });
    await measure('Email/query + Thread/get by back reference, 50 threads', () =>
        jmap(account, [
            ['Email/query', { sort, collapseThreads: true, limit: 50 }],
            ['Email/get', { '#ids': { resultOf: 'c0', name: 'Email/query', path: '/ids' }, properties: ['threadId'] }],
            ['Thread/get', { '#ids': { resultOf: 'c1', name: 'Email/get', path: '/list/*/threadId' } }]
        ])
    );
    return account;
}

// ---------------------------------------------------------------------------------------------------
// EventSource fan out

function openStream(account, types) {
    return new Promise((resolve, reject) => {
        const stream = { account, events: [], waiters: [] };
        const req = http.get(
            `${JMAP}/jmap/eventsource/?types=${types}&closeafter=no&ping=0`,
            { headers: { Authorization: account.authorization, Accept: 'text/event-stream' }, agent: false },
            res => {
                if (res.statusCode !== 200) {
                    reject(new Error(`event source answered ${res.statusCode}`));
                    res.resume();
                    return;
                }
                let buffer = '';
                res.setEncoding('utf8');
                res.on('data', chunk => {
                    buffer += chunk;
                    let end;
                    while ((end = buffer.indexOf('\n\n')) >= 0) {
                        const block = buffer.slice(0, end);
                        buffer = buffer.slice(end + 2);
                        if (block.startsWith(': connected')) {
                            resolve(stream);
                        } else if (block.includes('event: state')) {
                            stream.events.push(process.hrtime.bigint());
                            stream.waiters.splice(0).forEach(waiter => waiter());
                        }
                    }
                });
            }
        );
        req.on('error', reject);
        stream.close = () => req.destroy();
    });
}

const nextEvent = (stream, seen) => (stream.events.length > seen ? Promise.resolve() : new Promise(resolve => stream.waiters.push(resolve)));

// resident memory and used heap of the server process, from its Prometheus metrics; the lowest of a few
// samples, so a garbage collection in between does not count as memory in use
async function serverMemory() {
    const samples = [];
    for (let i = 0; i < 5; i++) {
        const text = await (await fetch(`http://127.0.0.1:${config.metrics.port}/metrics`)).text();
        const value = name => Number((new RegExp(`^${name} (\\d+)`, 'm').exec(text) || [])[1]);
        samples.push({ rss: value('process_resident_memory_bytes'), heap: value('nodejs_heap_size_used_bytes') });
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return { rss: Math.min(...samples.map(sample => sample.rss)), heap: Math.min(...samples.map(sample => sample.heap)) };
}

// Redis commands sent to the server's Redis database while fn runs, from MONITOR
async function redisCommands(fn) {
    const db = (config.dbs.redis && typeof config.dbs.redis === 'string' ? redisUrl(config.dbs.redis).db : config.dbs.redis.db) || 0;
    const monitor = spawn('redis-cli', ['-h', redis.options.host, '-p', String(redis.options.port), 'monitor']);
    const counts = new Map();
    let rest = '';
    monitor.stdout.on('data', chunk => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) {
            const match = /^\S+ \[(\d+) [^\]]+\] "([^"]+)"/.exec(line);
            if (match && Number(match[1]) === db) {
                const command = match[2].toLowerCase();
                counts.set(command, (counts.get(command) || 0) + 1);
            }
        }
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    await fn();
    await new Promise(resolve => setTimeout(resolve, 500));
    monitor.kill();
    return counts;
}

async function deliver(accounts, onDelivered) {
    const latencies = [];
    for (let i = 0; i < DELIVERIES; i++) {
        const account = accounts[i % accounts.length];
        const started = process.hrtime.bigint();
        const before = (account.streams || []).map(stream => stream.events.length);
        await api('POST', `/users/${account.id}/mailboxes/${account.inbox}/messages`, messageSource(i, 'short'), 'message/rfc822');
        if (onDelivered) {
            await Promise.all(account.streams.map((stream, j) => nextEvent(stream, before[j])));
            latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
        }
    }
    return latencies.sort((a, b) => a - b);
}

async function measureDeliveries(label, accounts, withStreams) {
    let latencies;
    const since = await startProfiler();
    const commands = await redisCommands(async () => {
        latencies = await deliver(accounts, withStreams);
        // let the last notifications settle
        await new Promise(resolve => setTimeout(resolve, 1500));
    });
    const { total, groups } = await stopProfiler(since);
    const redisTotal = [...commands.values()].reduce((a, b) => a + b, 0);
    console.log(`${label}: ${(total / DELIVERIES).toFixed(1)} MongoDB operations and ${(redisTotal / DELIVERIES).toFixed(1)} Redis commands per delivery`);
    return { total, groups, commands, redisTotal, latencies };
}

async function eventSourceBenchmark() {
    console.log(`\nEventSource: ${STREAMS} streams for ${STREAM_USERS} users, ${DELIVERIES} deliveries`);
    const accounts = [];
    for (let i = 0; i < STREAM_USERS; i++) {
        const account = await createUser('es');
        const listed = await api('GET', `/users/${account.id}/mailboxes`);
        account.inbox = listed.results.find(mailbox => mailbox.path === 'INBOX').id;
        accounts.push(account);
    }

    // background work of earlier changes (webhook events, the task queue) settles first
    await new Promise(resolve => setTimeout(resolve, 5000));
    const baseline = await measureDeliveries('deliveries without streams', accounts, false);
    const results = {};
    for (const types of ['*', 'Email,Mailbox,Thread']) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const before = await serverMemory();
        const perUser = Math.ceil(STREAMS / STREAM_USERS);
        const openStarted = Date.now();
        for (const account of accounts) {
            account.streams = await Promise.all(Array.from({ length: perUser }, () => openStream(account, encodeURIComponent(types))));
        }
        const openTime = Date.now() - openStarted;
        await new Promise(resolve => setTimeout(resolve, 3000));
        const after = await serverMemory();
        const streams = accounts.length * perUser;
        const mb = value => `${(value / 1048576).toFixed(0)} MB`;
        const perStream = (a, b) => `${((b - a) / streams / 1024).toFixed(1)} kB`;
        console.log(
            `types=${types}: opened ${streams} streams in ${openTime} ms; server RSS ${mb(before.rss)} -> ${mb(after.rss)} (${perStream(before.rss, after.rss)} per stream), heap used ${mb(before.heap)} -> ${mb(after.heap)} (${perStream(before.heap, after.heap)} per stream)`
        );
        const run = await measureDeliveries(`deliveries with ${streams} streams (types=${types})`, accounts, true);
        const extraMongo = (run.total - baseline.total) / DELIVERIES;
        const extraRedis = (run.redisTotal - baseline.redisTotal) / DELIVERIES;
        console.log(
            `  delivery to event on all ${perUser} streams of the user: p50 ${ms(percentile(run.latencies, 0.5))} p95 ${ms(percentile(run.latencies, 0.95))}; stream work per change: ${extraMongo.toFixed(1)} MongoDB operations, ${extraRedis.toFixed(1)} Redis commands`
        );
        for (const group of run.groups) {
            console.log(
                `    ${String(group.count).padStart(6)}x ${group.key}  keys ${group.keys} docs ${group.docs} (max per op keys ${group.maxKeys} docs ${group.maxDocs})`
            );
        }
        console.log(
            `    redis: ${[...run.commands.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([command, count]) => `${command} ${count}`)
                .join(', ')}`
        );
        results[types] = { before, after, run, extraMongo, extraRedis };
        for (const account of accounts) {
            account.streams.forEach(stream => stream.close());
            account.streams = [];
        }
    }
    console.log(
        `    redis without streams: ${[...baseline.commands.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([command, count]) => `${command} ${count}`)
            .join(', ')}`
    );
    return results;
}

// ---------------------------------------------------------------------------------------------------

async function main() {
    const what = process.argv[2] || 'all';
    const client = await MongoClient.connect(config.dbs.mongo);
    database = client.db(config.dbs.dbname);
    redis = new Redis(typeof config.dbs.redis === 'string' ? redisUrl(config.dbs.redis) : config.dbs.redis);
    console.log(`server ${JMAP}, database ${config.dbs.dbname}, ${MESSAGES} messages, ${MAILBOXES} mailboxes, ${ROUNDS} rounds`);
    if (what === 'all' || what === 'requests') {
        await requestBenchmarks();
    }
    if (what === 'all' || what === 'eventsource') {
        await eventSourceBenchmark();
    }
    await database.command({ profile: 0 });
    await client.close();
    redis.disconnect();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
