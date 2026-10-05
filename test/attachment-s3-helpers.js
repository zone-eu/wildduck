'use strict';

const crypto = require('crypto');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');
const { setTimeout: delay } = require('timers/promises');
const { MongoClient, ObjectId } = require('mongodb');
const Redis = require('ioredis');
const yaml = require('js-yaml');
const supertest = require('supertest');
const { ImapFlow } = require('imapflow');
const config = require('@zone-eu/wild-config');
const { S3Client, CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const AttachmentStorage = require('../lib/attachment-storage');

const root = path.resolve(__dirname, '..');

async function collect(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function binaryParser(res, callback) {
    collect(res).then(body => callback(null, body), callback);
}

async function freePort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    return port;
}

async function emptyBucket(client, bucket) {
    // Delete the first page repeatedly so cleanup also works with more than 1,000 objects.
    let page;
    do {
        page = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        for (const object of page.Contents || []) {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
        }
    } while (page.Contents?.length);
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

async function objectExists(client, bucket, key) {
    try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (err) {
        if (err.$metadata?.httpStatusCode === 404) {
            return false;
        }
        throw err;
    }
}

// The collector only deletes GridFS chunks old enough to not belong to a new upload. Chunk age is the
// timestamp of the chunk id, so a test that expects chunks to be collected gives them old ids
async function ageChunks(chunks, filesId, time = new Date(0)) {
    for (const chunk of await chunks.find({ files_id: filesId }).toArray()) {
        await chunks.deleteOne({ _id: chunk._id });
        await chunks.insertOne({ ...chunk, _id: objectIdAt(time) });
    }
}

// the indexes indexes.yaml gives the attachment bucket, for tests that use buckets of their own. The unique
// chunk index matters: without it chunks of the same position can coexist, which production never allows
async function createAttachmentIndexes(gridfs, bucket) {
    await gridfs.collection(`${bucket}.files`).createIndex({ 'metadata.c': 1, 'metadata.m': 1, 'metadata.cu': 1 }, { name: 'related_attachments_cu' });
    await gridfs.collection(`${bucket}.chunks`).createIndex({ files_id: 1, n: 1 }, { name: 'files_id_1_n_1', unique: true });
}

// mulberry32: a small seeded generator, so randomized tests can be replayed from their seed
function prng(seed) {
    let state = seed >>> 0; // eslint-disable-line no-bitwise
    let next = () => {
        /* eslint-disable no-bitwise */
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        /* eslint-enable no-bitwise */
    };
    return {
        next,
        int: (min, max) => min + Math.floor(next() * (max - min + 1)),
        chance: p => next() < p,
        pick: list => list[Math.floor(next() * list.length)],
        bytes: length => Buffer.from(Array.from({ length }, () => Math.floor(next() * 256)))
    };
}

// a seed from the environment, or a random one; a value that is not a number is an error, not seed 0
function seedFrom(name) {
    if (!process.env[name]) {
        return crypto.randomInt(2 ** 31);
    }
    const seed = Number(process.env[name]);
    if (!Number.isInteger(seed)) {
        throw new Error(`${name} must be an integer`);
    }
    return seed;
}

// a unique ObjectId that carries the given time, as an id created back then would
function objectIdAt(time) {
    const id = Buffer.from(new ObjectId().id);
    id.writeUInt32BE(Math.floor(time.getTime() / 1000), 0);
    return new ObjectId(id);
}

class S3TestEnvironment {
    constructor(endpoint) {
        this.nonce = crypto.randomBytes(6).toString('hex');
        this.bucket = `wildduck-protocol-${this.nonce}`;
        this.endpoint = endpoint;
        this.client = new S3Client({
            region: 'us-east-1',
            endpoint,
            forcePathStyle: true,
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
        });
        this.servers = [];
    }

    async start() {
        this.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wildduck-s3-test-'));
        this.mongo = new MongoClient(config.dbs.mongo, { serverSelectionTimeoutMS: 5000 });
        await this.mongo.connect();
        this.redis = new Redis(config.dbs.redis);
        await this.redis.ping();
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.bucketCreated = true;
    }

    async createServer(type) {
        const fixture = new TestServer(this, type); // eslint-disable-line no-use-before-define
        this.servers.push(fixture);
        await fixture.start();
        return fixture;
    }

    async close() {
        try {
            for (const fixture of this.servers) {
                await fixture.stop();
                // Only databases generated by this environment are dropped.
                await fixture.database.dropDatabase();
            }
            if (this.bucketCreated) {
                await emptyBucket(this.client, this.bucket);
            }
        } finally {
            await this.mongo?.close();
            this.redis?.disconnect();
            this.client.destroy();
            if (this.directory) {
                await fs.rm(this.directory, { recursive: true, force: true });
            }
        }
    }
}

class TestServer {
    constructor(environment, type) {
        this.environment = environment;
        this.type = type;
        this.databaseName = `wildduck_s3_test_${environment.nonce}_${type}`;
        this.database = environment.mongo.db(this.databaseName);
        this.configPath = path.join(environment.directory, `${type}.json`);
        this.logs = '';
        this.connections = new Set();
        this.userSequence = 0;
    }

    async start() {
        const definitions = yaml.load(await fs.readFile(path.join(root, 'indexes.yaml'), 'utf8'));
        for (const definition of definitions.indexes) {
            await this.database.collection(definition.collection).createIndexes([definition.index]);
        }
        this.apiPort = await freePort();
        this.imapPort = await freePort();
        const s3 = {
            bucket: this.environment.bucket,
            prefix: this.databaseName,
            endpoint: this.environment.endpoint,
            region: 'us-east-1',
            forcePathStyle: true,
            // small enough that leaked S3 connections show up quickly
            maxSockets: 4
        };
        await fs.writeFile(
            this.configPath,
            JSON.stringify({
                processes: 1,
                dbs: { mongo: config.dbs.mongo, dbname: this.databaseName, gridfs: this.databaseName, users: this.databaseName, sender: this.databaseName },
                attachments: { type: this.type, bucket: 'attachments', decodeBase64: true, s3 },
                api: { enabled: true, host: '127.0.0.1', port: this.apiPort, secure: false, accessToken: false, accessControl: { enabled: false } },
                imap: { enabled: true, host: '127.0.0.1', port: this.imapPort, secure: false, disableSTARTTLS: true },
                pop3: { enabled: false },
                lmtp: { enabled: false },
                metrics: { enabled: false },
                mcp: { enabled: false },
                acme: { enabled: false },
                tasks: { enabled: false },
                webhooks: { enabled: false },
                elasticsearch: { enabled: false, indexer: { enabled: false } },
                pwned: { enabled: false },
                plugins: { conf: Object.fromEntries(Object.keys(config.plugins.conf || {}).map(name => [name, { enabled: false }])) },
                log: { level: 'error', skipFetchLog: true }
            })
        );
        this.storage = new AttachmentStorage({
            gridfs: this.database,
            redis: this.environment.redis,
            s3Client: this.environment.client,
            options: { type: this.type, bucket: 'attachments', decodeBase64: true, s3 }
        });
        // Override the Mongo URI's default database as well as every secondary database.
        const overrides = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
        const mongoUrl = new URL(overrides.dbs.mongo);
        mongoUrl.pathname = `/${this.databaseName}`;
        overrides.dbs.mongo = mongoUrl.toString();
        await fs.writeFile(this.configPath, JSON.stringify(overrides));
        this.process = spawn(process.execPath, [path.join(root, 'server.js'), `--config=${this.configPath}`], {
            cwd: root,
            env: { ...process.env, NODE_ENV: 'test', NODE_CONFIG_PATH: this.configPath, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const capture = chunk => {
            this.logs = (this.logs + chunk.toString()).slice(-16000);
        };
        this.process.stdout.on('data', capture);
        this.process.stderr.on('data', capture);
        this.api = supertest(`http://127.0.0.1:${this.apiPort}`);
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline && this.process.exitCode === null) {
            try {
                await this.api.get('/users').timeout({ response: 500, deadline: 1000 }).expect(200);
                return;
            } catch (err) {
                await delay(100);
            }
        }
        throw new Error(`Isolated ${this.type} server did not start: ${this.logs}`);
    }

    async createUser() {
        const username = `att_${this.environment.nonce}_${this.type}_${++this.userSequence}`;
        const password = 'attachment-test-password';
        const response = await this.api
            .post('/users')
            .send({ username, password, address: `${username}@example.test`, name: 'Attachment test' })
            .expect(200);
        const user = response.body.id;
        const mailboxes = await this.api.get(`/users/${user}/mailboxes`).expect(200);
        const inbox = mailboxes.body.results.find(mailbox => mailbox.path === 'INBOX');
        return { user, username, password, inbox: inbox.id };
    }

    async connectImap(account) {
        const client = new ImapFlow({
            host: '127.0.0.1',
            port: this.imapPort,
            secure: false,
            doSTARTTLS: false,
            auth: { user: account.username, pass: account.password },
            logger: false,
            socketTimeout: 30000
        });
        client.on('error', () => {});
        this.connections.add(client);
        await client.connect();
        await client.mailboxOpen('INBOX');
        return client;
    }

    async disconnectImap() {
        for (const client of this.connections) {
            try {
                if (client.usable) {
                    await client.logout();
                }
            } finally {
                client.close();
            }
        }
        this.connections.clear();
    }

    async restart(type = this.type) {
        await this.stop();
        this.type = type;
        this.logs = '';
        // Keep the database and S3 prefix while changing the preferred write backend.
        await this.start();
    }

    async stop() {
        await this.disconnectImap();
        if (!this.process || this.process.exitCode !== null) {
            return;
        }
        const exited = once(this.process, 'exit');
        this.process.kill('SIGTERM');
        const timer = setTimeout(() => this.process.kill('SIGKILL'), 5000);
        try {
            await exited;
        } finally {
            clearTimeout(timer);
        }
    }
}

module.exports = { S3TestEnvironment, collect, binaryParser, emptyBucket, objectExists, ageChunks, objectIdAt, prng, seedFrom, createAttachmentIndexes };
