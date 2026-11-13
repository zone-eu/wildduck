/* eslint no-unused-expressions: 0 */
/* global before, after */
'use strict';

// Catalogue file email-query.yaml: text and body conditions answered by OpenSearch for accounts with the
// indexing feature (phase 4, work package 4.6).
//
// Needs an OpenSearch (or Elasticsearch) node at [elasticsearch] url. The scenario starts a JMAP instance in
// the test process with the search enabled and indexes the messages with the indexer's own job, so the
// shared test server keeps its configuration. Without a reachable node the scenario is skipped, unless
// JMAP_REQUIRE_OPENSEARCH is set (CI), where it fails instead.

const crypto = require('crypto');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const { scenario, seed, jmap } = require('../harness');
const { setup, rawMessage, append } = require('./email-query-helpers');
const { startInstance, stopInstance, connect } = require('../harness/instance');
const { indexingJob } = require('../../../indexer');
const { getClient } = require('../../../lib/elasticsearch');
const { ensureIndex } = require('../../../lib/ensure-es-index');

/** Filler text without the searched words, `size` characters long */
const filler = size => 'orchard basket ladder '.repeat(Math.ceil(size / 22)).slice(0, size);

async function reachable(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        return res.status < 500;
    } catch {
        return false;
    }
}

describe('Email/query full body search through OpenSearch (email-query.yaml)', function () {
    this.timeout(120000); // eslint-disable-line no-invalid-this

    let original;
    let instance;
    let db;
    let available = false;

    before(async function () {
        const url = config.elasticsearch && config.elasticsearch.url;
        available = !!url && (await reachable(url));
        if (!available) {
            if (process.env.JMAP_REQUIRE_OPENSEARCH) {
                throw new Error(`OpenSearch is not reachable at ${url}`);
            }
            this.skip(); // eslint-disable-line no-invalid-this
        }
        original = config.elasticsearch;
        config.elasticsearch = Object.assign({}, original, { enabled: true, index: `wildduck-jmap-test-${crypto.randomBytes(4).toString('hex')}` });
        await ensureIndex(getClient(), config.elasticsearch.index);
        db = await connect();
        instance = await startInstance();
    });

    after(async () => {
        if (!available) {
            return;
        }
        await stopInstance(instance.app);
        await getClient().indices.delete({ index: config.elasticsearch.index });
        config.elasticsearch = original;
    });

    /** Email/query on the instance with search enabled */
    async function idsAt(ctx, filter) {
        const res = await fetch(`${instance.url}/jmap/api`, {
            method: 'POST',
            headers: { Authorization: jmap.basic(ctx.user.username, ctx.user.password), 'Content-Type': 'application/json' },
            body: JSON.stringify({ using: [jmap.URN.core, jmap.URN.mail], methodCalls: [['Email/query', { accountId: `u${ctx.user.id}`, filter }, 'q']] })
        });
        expect(res.status).to.equal(200);
        const [[name, response]] = (await res.json()).methodResponses;
        expect(name, JSON.stringify(response)).to.equal('Email/query');
        return response.ids;
    }

    scenario('EQRY-065', async () => {
        const ctx = await setup();
        const [, e2, e3] = await append(ctx, [
            { raw: rawMessage({ subject: 'Short 065', body: 'nothing to find here' }) },
            { raw: rawMessage({ subject: 'Fruit 065', body: `${filler(4 * 1024)}\npersimmon\n` }) },
            { raw: rawMessage({ subject: 'Long 065', body: `${filler(200 * 1024)}\nlychee\n` }) }
        ]);

        // without the indexing feature the stored beginning of the text is searched (phase 1 behaviour)
        expect(await idsAt(ctx, { body: 'persimmon' })).to.deep.equal([]);

        await db.redis.sadd('feature:indexing', ctx.user.id);
        try {
            const messages = await db.database
                .collection('messages')
                .find({ user: new seed.ObjectId(ctx.user.id) }, { projection: { _id: true, mailbox: true, uid: true, modseq: true } })
                .toArray();
            const job = indexingJob(getClient());
            for (const message of messages) {
                await job({
                    data: { action: 'new', message: message._id.toString(), mailbox: message.mailbox.toString(), uid: message.uid, modseq: message.modseq }
                });
            }
            // the indexer has caught up
            await getClient().indices.refresh({ index: config.elasticsearch.index });

            expect(await idsAt(ctx, { text: 'persimmon' })).to.deep.equal([e2.id]);
            expect(await idsAt(ctx, { body: 'persimmon' })).to.deep.equal([e2.id]);
            expect(await idsAt(ctx, { body: 'lychee' })).to.deep.equal([e3.id]);
            // other conditions still apply, and every term has to match
            expect(await idsAt(ctx, { body: 'persimmon', inMailbox: ctx.mailbox('\\Trash') })).to.deep.equal([]);
            expect(await idsAt(ctx, { body: 'persimmon lychee' })).to.deep.equal([]);
        } finally {
            await db.redis.srem('feature:indexing', ctx.user.id);
        }
    });
});
