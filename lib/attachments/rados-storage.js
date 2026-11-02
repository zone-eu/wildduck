'use strict';

const crypto = require('crypto');
const log = require('npmlog');
const { Readable } = require('stream');
const { prepareStoredBody, createReadWindow } = require('./base64-codec');

const DEFAULT_STRIPE_SIZE = 4 * 1024 * 1024;
const DEFAULT_WRITE_CONCURRENCY = 4;
// seconds; librados waits forever by default
const DEFAULT_OP_TIMEOUT = 30;
// placement targets tried for one write: the preferred one, and one more when it has an outage
const DEFAULT_WRITE_ATTEMPTS = 2;
// ms a target that had an outage goes to the back of the line for new writes
const DEFAULT_DOWN_TIME = 30 * 1000;
// ms a cluster that could not be connected to fails at once, instead of every caller waiting for the timeout
const DEFAULT_RECONNECT_DELAY = 10 * 1000;
const MANIFEST_VERSION = 1;
const FSID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// xattrs. Every object carries the SHA-256 of its own bytes, so a scrub can check any object on its own.
// The head also carries the manifest, and every tail names its head, so a tail without one can be found
const XATTR_SHA256 = 'wd.sha256';
const XATTR_MANIFEST = 'wd.manifest';
const XATTR_HEAD = 'wd.head';

// errors that come from the request itself rather than from the cluster, and need fixing instead of a retry
const REFUSALS = new Set(['EACCES', 'EPERM', 'EINVAL', 'ENAMETOOLONG', 'EFBIG', 'E2BIG', 'EEXIST', 'EFSIDMISMATCH']);

/**
 * Number of stripes a payload of `length` bytes takes. An empty payload still has its head
 */
function stripeCount(length, stripeSize) {
    return Math.max(1, Math.ceil(length / stripeSize));
}

/**
 * Runs `task` for every item, at most `concurrency` at a time. All started tasks settle before the
 * first failure is thrown, so nothing is still writing when the caller cleans up
 */
async function eachLimit(items, concurrency, task) {
    let next = 0;
    let failure = null;
    const worker = async () => {
        while (next < items.length && !failure) {
            const item = items[next++];
            try {
                await task(item);
            } catch (err) {
                failure = failure || err;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    if (failure) {
        throw failure;
    }
}

// Settings that only come from APPCONF_ environment variables arrive as strings, since the config
// files do not declare them and wild-config can not tell their type

function numberOption(value, fallback) {
    return value === undefined || value === null || value === '' ? fallback : Number(value);
}

function booleanOption(value) {
    return typeof value === 'string' ? !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase()) : !!value;
}

function listOption(value) {
    return []
        .concat(value || [])
        .flatMap(entry => String(entry).split(','))
        .map(entry => entry.trim())
        .filter(entry => entry);
}

function errorCode(err) {
    return (err && (err.code || (typeof err.errno === 'string' ? err.errno : null))) || null;
}

/**
 * Placement targets from `rados.placement`: `"<cluster>/<pool>"` or `"<cluster>/<pool>:<weight>"`, as an
 * array or a comma separated string. A target with weight 0 takes no new payloads but stays readable
 */
function parsePlacement(placement, clusters, namespace) {
    const targets = [];
    for (const entry of listOption(placement)) {
        const match = /^([^/:]+)\/([^/:]+)(?::([0-9]+(?:\.[0-9]+)?))?$/.exec(entry);
        if (!match) {
            throw new Error(`Invalid rados.placement entry "${entry}", expected "<cluster>/<pool>:<weight>"`);
        }
        const cluster = clusters.get(match[1]);
        if (!cluster) {
            throw new Error(`rados.placement entry "${entry}" names a cluster that is not in rados.clusters`);
        }
        if (cluster.pools && !cluster.pools.includes(match[2])) {
            throw new Error(`rados.placement entry "${entry}" names a pool that is not in rados.clusters.${cluster.label}.pools`);
        }
        const name = `${cluster.fsid}/${match[2]}/${namespace}`;
        if (targets.some(target => target.name === name)) {
            throw new Error(`rados.placement lists ${match[1]}/${match[2]} twice`);
        }
        targets.push({ cluster, pool: match[2], namespace, weight: match[3] === undefined ? 1 : Number(match[3]), name, downUntil: 0 });
    }
    return targets.filter(target => target.weight > 0);
}

/**
 * Stores attachment payloads directly in RADOS pools, on one or more Ceph clusters. Every payload lives in
 * one pool of one cluster, and its catalog record names both by cluster fsid and pool name, so records on
 * several clusters coexist, and a payload can be moved to another cluster by copying its objects and
 * pointing the record at the copy (see relocate() in AttachmentStorage).
 *
 * New payloads are spread over the placement targets by weighted rendezvous hashing of the attachment id,
 * the way MongoDB spreads documents over shards: every target gets a share in proportion to its weight,
 * and adding or removing a target only moves the share that target gains or loses. A write that hits an
 * outage moves on to the next target in line, so one cluster being down does not stop deliveries.
 *
 * A payload is striped the way RGW stripes objects: a head object with the first stripe and the manifest,
 * and tail objects with the rest. Payloads are written once and never modified (a new copy gets a new
 * name), so there is no partial update to guard against. The head is written last, so a head only exists
 * once every tail does, and readers never see a half-written payload. Deletion removes the head first, so
 * a payload stops being readable at once, and then the tails. Tails of an upload that died before its head
 * was written are left for a sweep that looks for tails whose head does not exist.
 *
 * librados is reached through a small interface (see rados-client.js), which keeps the native binding
 * replaceable and lets tests run against in-memory clusters. `connect(clusterConfig)` resolves to a
 * cluster with `fsid()`, `ioctx(pool, namespace)` and `close()`; an io context has:
 *
 *   create(oid, data, xattrs)  exclusive create + write_full + setxattrs, EEXIST if present
 *   read(oid, offset, length)  Buffer of up to `length` bytes
 *   getXattr(oid, name)        Buffer, ENOENT when the object or the xattr does not exist
 *   remove(oid)                ENOENT when the object does not exist
 */
class RadosStorage {
    constructor(options) {
        const config = (options.options && options.options.rados) || {};
        this.namespace = config.namespace === undefined ? 'wildduck' : String(config.namespace);
        this.prefix = (config.prefix || '').replace(/^\/+|\/+$/g, '');
        this.decodeBase64 = !!(options.options && options.options.decodeBase64);
        this.stripeSize = Number(config.stripeSize) || DEFAULT_STRIPE_SIZE;
        if (!Number.isSafeInteger(this.stripeSize) || this.stripeSize < 64 * 1024) {
            throw new Error('rados.stripeSize must be an integer of at least 64 KiB');
        }
        this.writeConcurrency = Number(config.writeConcurrency) || DEFAULT_WRITE_CONCURRENCY;
        this.writeAttempts = Number(config.writeAttempts) || DEFAULT_WRITE_ATTEMPTS;
        this.downTime = numberOption(config.downTime, DEFAULT_DOWN_TIME);
        this.reconnectDelay = numberOption(config.reconnectDelay, DEFAULT_RECONNECT_DELAY);
        if (![this.writeAttempts, this.downTime, this.reconnectDelay].every(value => Number.isFinite(value) && value >= 0)) {
            throw new Error('rados.writeAttempts, rados.downTime and rados.reconnectDelay must be numbers');
        }
        // full stripes are always checked against the manifest. A partial stripe can only be checked by
        // reading all of it, which an IMAP partial FETCH of a few bytes should not have to pay for
        this.verifyPartialStripes = booleanOption(config.verifyPartialStripes);

        // required lazily, so processes that never use RADOS do not need the native binding
        // eslint-disable-next-line global-require
        this.connect = options.radosConnect || (clusterConfig => require('./rados-client').connect(clusterConfig));

        // clusters by label (the key in rados.clusters) and by fsid (what catalog records name)
        this.clusters = new Map();
        this.byFsid = new Map();
        for (const [label, clusterConfig] of Object.entries(config.clusters || {})) {
            const fsid = String((clusterConfig && clusterConfig.fsid) || '').toLowerCase();
            if (!FSID.test(fsid)) {
                throw new Error(`rados.clusters.${label}.fsid must be the fsid of the cluster`);
            }
            if (this.byFsid.has(fsid)) {
                throw new Error(`rados.clusters.${label} has the same fsid as rados.clusters.${this.byFsid.get(fsid).label}`);
            }
            const cluster = {
                label,
                fsid,
                config: {
                    ...clusterConfig,
                    opTimeout: numberOption(clusterConfig.opTimeout, numberOption(config.opTimeout, DEFAULT_OP_TIMEOUT)),
                    fsid
                },
                // pools this process may read, all of them when not listed
                pools: clusterConfig.pools ? listOption(clusterConfig.pools) : null,
                client: null,
                connecting: null,
                failure: null,
                failedAt: 0
            };
            this.clusters.set(label, cluster);
            this.byFsid.set(fsid, cluster);
        }
        if (!this.clusters.size || !this.prefix) {
            throw new Error('RADOS attachments require at least one cluster in rados.clusters and a nonempty rados.prefix');
        }
        this.targets = parsePlacement(config.placement, this.clusters, this.namespace);
    }

    /**
     * Connection to a cluster, made on first use. The cluster must report the configured fsid, so a wrong
     * ceph.conf can never send payloads to a cluster the catalog records do not name. A failed connection
     * fails at once for reconnectDelay, then the next call tries again
     */
    async clusterClient(cluster) {
        if (cluster.client) {
            return cluster.client;
        }
        if (!cluster.connecting) {
            if (cluster.failure && Date.now() - cluster.failedAt < this.reconnectDelay) {
                throw Object.assign(new Error(`RADOS cluster ${cluster.label} is unreachable: ${cluster.failure.message}`), { code: cluster.failure.code });
            }
            cluster.connecting = (async () => {
                const client = await this.connect(cluster.config);
                let fsid;
                try {
                    fsid = String(await client.fsid()).toLowerCase();
                } catch (err) {
                    await Promise.resolve(client.close && client.close()).catch(() => false);
                    throw err;
                }
                if (fsid !== cluster.fsid) {
                    await Promise.resolve(client.close && client.close()).catch(() => false);
                    throw Object.assign(new Error(`RADOS cluster ${cluster.label} reports fsid ${fsid}, configured is ${cluster.fsid}`), {
                        code: 'EFSIDMISMATCH'
                    });
                }
                return client;
            })().then(
                client => {
                    cluster.client = client;
                    cluster.connecting = null;
                    cluster.failure = null;
                    return client;
                },
                err => {
                    cluster.connecting = null;
                    cluster.failure = err;
                    cluster.failedAt = Date.now();
                    log.error('RadosStorage', 'Connecting to RADOS cluster %s (%s) failed: %s', cluster.label, cluster.fsid, err.message);
                    throw err;
                }
            );
        }
        return await cluster.connecting;
    }

    async ioctx(cluster, pool, namespace) {
        return await (await this.clusterClient(cluster)).ioctx(pool, namespace);
    }

    /**
     * The io context holding the payload of a locator
     */
    async ioctxOf(location) {
        const cluster = this.byFsid.get(location.fsid);
        if (!cluster || !this.reaches(location)) {
            throw new Error(`RADOS attachment is stored in ${location.fsid}/${location.pool}, which this process does not use`);
        }
        return await this.ioctx(cluster, location.pool, location.namespace);
    }

    async close() {
        for (const cluster of this.clusters.values()) {
            const client = cluster.client;
            cluster.client = null;
            if (client && client.close) {
                await client.close().catch(() => false);
            }
        }
    }

    /**
     * Placement targets in the order a new payload of this attachment tries them: by weighted rendezvous
     * hash, targets that recently had an outage last
     */
    order(id) {
        const now = Date.now();
        return this.targets
            .map(target => {
                const hash = crypto.createHash('sha256').update(target.name).update(id).digest();
                // uniform in (0, 1); -weight / ln(u) is highest for a target with a probability in proportion to its weight
                const u = (hash.readUIntBE(0, 6) + 1) / (2 ** 48 + 1);
                return { target, down: target.downUntil > now, score: -target.weight / Math.log(u) };
            })
            .sort((a, b) => a.down - b.down || b.score - a.score)
            .map(entry => entry.target);
    }

    /**
     * Target for an explicit `"<cluster>/<pool>"`, also one that is not in the placement (relocation)
     */
    target(spec) {
        const targets = parsePlacement([`${spec}:1`], this.clusters, this.namespace);
        return this.targets.find(target => target.name === targets[0].name) || targets[0];
    }

    /**
     * Object name of the head of one stored copy. Every upload gets its own generation, so a name is
     * written once: writers racing on the same hash never overwrite each other, and deleting an old copy
     * can never remove a newer one. Readers always take the name from the catalog record
     */
    key(id, generation) {
        const hex = id.toString('hex');
        return `${this.prefix}/attachments/v1/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}.${generation}`;
    }

    /**
     * Object name of a stripe. Stripe 0 is the head itself
     */
    stripeName(key, index) {
        return index ? `${key}.${index}` : key;
    }

    /**
     * Attachment id and stripe of an object name written under this prefix
     *
     * @returns {Object|null} `{ id, key, stripe }`, or null when the name is not an attachment object
     */
    parseName(name) {
        const base = `${this.prefix}/attachments/v1/`;
        const match =
            name.startsWith(base) && /^([0-9a-f]{2})\/([0-9a-f]{2})\/(\1\2[0-9a-f]{60})\.([0-9a-f]{16})(?:\.([1-9][0-9]*))?$/.exec(name.slice(base.length));
        if (!match) {
            return null;
        }
        return {
            id: Buffer.from(match[3], 'hex'),
            key: name.slice(0, base.length + match[0].length - (match[5] ? match[5].length + 1 : 0)),
            stripe: match[5] ? Number(match[5]) : 0
        };
    }

    prepare(attachment) {
        const { data, metadata } = prepareStoredBody(attachment, { decodeBase64: this.decodeBase64 });
        return { body: data, metadata: { ...metadata, m: attachment.magic, c: 1, cu: new Date() } };
    }

    /**
     * Writes one copy of a payload to the first placement target that takes it
     *
     * @param {Buffer} id Attachment id
     * @param {Buffer} body Stored bytes
     * @param {Number} length Number of stored bytes
     * @param {Buffer} checksum SHA-256 of the stored bytes
     * @param {Array} [targets] Targets to try instead of the placement, see target()
     * @returns {Object} Locator `{ fsid, pool, namespace, key, length, stripeSize, stripes }`
     */
    async put(id, body, length, checksum, targets) {
        if (!Buffer.isBuffer(body) || body.length !== length) {
            throw new Error('RADOS attachments need the whole payload as a Buffer of the given length');
        }
        // RADOS has no equivalent of the S3 checksum header, so the checksum is checked here and then stored
        // with the data for readers and scrubs to check against
        const digest = crypto.createHash('sha256').update(body).digest();
        if (!checksum || !digest.equals(checksum)) {
            throw new Error('RADOS attachment checksum does not match its payload');
        }
        const candidates = targets || this.order(id).slice(0, this.writeAttempts);
        if (!candidates.length) {
            throw new Error('RADOS attachments have no placement target to write to, see rados.placement');
        }
        let failure;
        for (const target of candidates) {
            try {
                return await this.write(target, id, body, length, digest);
            } catch (err) {
                failure = err;
                if (!this.isOutage(err)) {
                    throw err;
                }
                target.downUntil = Date.now() + this.downTime;
                log.warn('RadosStorage', 'Writing attachment %s to %s/%s failed: %s', id.toString('hex'), target.cluster.label, target.pool, err.message);
            }
        }
        throw failure;
    }

    /**
     * Writes one copy of a payload to one target: the tails first, then the head with the manifest
     */
    async write(target, id, body, length, digest) {
        const ioctx = await this.ioctx(target.cluster, target.pool, target.namespace);
        const key = this.key(id, crypto.randomBytes(8).toString('hex'));
        const stripes = stripeCount(length, this.stripeSize);
        const stripeData = index => body.subarray(index * this.stripeSize, Math.min(length, (index + 1) * this.stripeSize));
        const stripeHashes = Array.from({ length: stripes }, (v, index) => crypto.createHash('sha256').update(stripeData(index)).digest());

        const manifest = {
            v: MANIFEST_VERSION,
            length,
            stripeSize: this.stripeSize,
            sha256: digest.toString('base64'),
            stripes: stripeHashes.map(hash => hash.toString('base64'))
        };

        const written = [];
        try {
            const tails = Array.from({ length: stripes - 1 }, (v, index) => index + 1);
            await eachLimit(tails, this.writeConcurrency, async index => {
                const name = this.stripeName(key, index);
                await ioctx.create(name, stripeData(index), {
                    [XATTR_SHA256]: stripeHashes[index],
                    [XATTR_HEAD]: Buffer.from(key)
                });
                written.push(name);
            });
            // the commit point of the payload: once the head exists, so does every tail
            await ioctx.create(key, stripeData(0), {
                [XATTR_SHA256]: stripeHashes[0],
                [XATTR_MANIFEST]: Buffer.from(JSON.stringify(manifest))
            });
        } catch (err) {
            // best effort, a sweep finds whatever is left
            await eachLimit(written, this.writeConcurrency, name => ioctx.remove(name).catch(() => false)).catch(() => false);
            throw err;
        }

        return { fsid: target.cluster.fsid, pool: target.pool, namespace: target.namespace, key, length, stripeSize: this.stripeSize, stripes };
    }

    /**
     * Writes a new copy and lets `commit` point a catalog record at it, with the same contract as
     * S3Storage.store(): a copy that `commit` definitely did not reference is deleted again, a copy
     * whose outcome is unknown is kept
     */
    async store(id, body, length, checksum, commit, targets) {
        const location = await this.put(id, body, length, checksum, targets);
        let committed;
        try {
            committed = await commit(location);
        } catch (err) {
            if (err.code === 11000) {
                await this.deletePayload(location).catch(() => false);
            }
            throw err;
        }
        if (!committed) {
            await this.deletePayload(location).catch(() => false);
            return false;
        }
        return location;
    }

    /**
     * True when `location` is a well-formed locator of this backend for a payload of `length` bytes
     */
    validLocation(location) {
        return (
            location.version === 1 &&
            typeof location.fsid === 'string' &&
            FSID.test(location.fsid) &&
            typeof location.pool === 'string' &&
            location.pool &&
            typeof location.namespace === 'string' &&
            typeof location.key === 'string' &&
            location.key &&
            Number.isSafeInteger(location.length) &&
            location.length >= 0 &&
            Number.isSafeInteger(location.stripeSize) &&
            location.stripeSize > 0 &&
            location.stripes === stripeCount(location.length, location.stripeSize)
        );
    }

    /**
     * True when this process has the cluster and may read the pool of `location`. A record on a cluster
     * this process does not know is refused rather than read from the wrong place
     */
    reaches(location) {
        const cluster = this.byFsid.get(location.fsid);
        return !!cluster && (!cluster.pools || cluster.pools.includes(location.pool));
    }

    /**
     * What fails together: an outage of one cluster leaves the other clusters usable
     */
    domain(location) {
        return `rados:${location.fsid}`;
    }

    /**
     * True when two locators name the same objects
     */
    sameObject(a, b) {
        return a.fsid === b.fsid && a.pool === b.pool && a.namespace === b.namespace && a.key === b.key;
    }

    createReadStream(id, attachmentData, options) {
        const location = attachmentData.metadata.storage;
        if (!location || location.backend !== 'rados' || !this.validLocation(location)) {
            throw new Error('Invalid RADOS attachment locator');
        }
        return createReadWindow((start, end) => this.openRange(location, start, end), attachmentData, options);
    }

    /**
     * Stream of bytes [start, end) of a payload. Stripes are read one at a time as the reader takes data,
     * so a slow IMAP client holds at most one stripe in memory and no librados operation stays open
     */
    openRange(location, start, end) {
        if (start >= end) {
            return Readable.from([]);
        }
        const storage = this;
        return Readable.from(
            (async function* () {
                const ioctx = await storage.ioctxOf(location);
                const manifest = await storage.readManifest(ioctx, location);
                const size = location.stripeSize;
                for (let index = Math.floor(start / size); index * size < end; index++) {
                    const stripeStart = index * size;
                    const stripeEnd = Math.min(location.length, stripeStart + size);
                    const from = Math.max(start, stripeStart);
                    const to = Math.min(end, stripeEnd);
                    const whole = from === stripeStart && to === stripeEnd;
                    const verify = whole || storage.verifyPartialStripes;
                    // a checked partial stripe is read whole and cut down afterwards
                    const readFrom = verify ? stripeStart : from;
                    const readTo = verify ? stripeEnd : to;
                    const data = await ioctx.read(storage.stripeName(location.key, index), readFrom - stripeStart, readTo - readFrom);
                    if (data.length !== readTo - readFrom) {
                        throw Object.assign(new Error(`RADOS attachment stripe ${index} is ${data.length} bytes, expected ${readTo - readFrom}`), {
                            code: 'EBADMSG'
                        });
                    }
                    if (verify && !crypto.createHash('sha256').update(data).digest().equals(Buffer.from(manifest.stripes[index], 'base64'))) {
                        throw Object.assign(new Error(`RADOS attachment stripe ${index} fails its checksum`), { code: 'EBADMSG' });
                    }
                    yield verify ? data.subarray(from - readFrom, to - readFrom) : data;
                }
            })(),
            { objectMode: false }
        );
    }

    /**
     * The manifest of a head, checked against the catalog locator. A missing head answers ENOENT, which
     * readers serve as a placeholder like a missing GridFS file or S3 object
     */
    async readManifest(ioctx, location) {
        let raw;
        try {
            raw = await ioctx.getXattr(location.key, XATTR_MANIFEST);
        } catch (err) {
            if (this.isMissing(err)) {
                err.code = 'ENOENT';
            }
            throw err;
        }
        let manifest;
        try {
            manifest = JSON.parse(raw.toString());
        } catch (err) {
            throw Object.assign(new Error('RADOS attachment manifest is not valid JSON'), { code: 'EBADMSG' });
        }
        if (
            !manifest ||
            manifest.v !== MANIFEST_VERSION ||
            manifest.length !== location.length ||
            manifest.stripeSize !== location.stripeSize ||
            !Array.isArray(manifest.stripes) ||
            manifest.stripes.length !== location.stripes
        ) {
            throw Object.assign(new Error('RADOS attachment manifest does not match its catalog record'), { code: 'EBADMSG' });
        }
        return manifest;
    }

    /**
     * Deletes a copy: the head first, so it stops being readable, then the tails. Objects that are
     * already gone count as deleted, so an interrupted deletion can simply run again
     */
    async deletePayload(location) {
        const ioctx = await this.ioctxOf(location);
        const ignoreMissing = err => {
            if (!this.isMissing(err)) {
                throw err;
            }
        };
        await ioctx.remove(location.key).catch(ignoreMissing);
        const tails = Array.from({ length: location.stripes - 1 }, (v, index) => this.stripeName(location.key, index + 1));
        await eachLimit(tails, this.writeConcurrency, name => ioctx.remove(name).catch(ignoreMissing));
    }

    isMissing(err) {
        return errorCode(err) === 'ENOENT';
    }

    /**
     * True for a failure that may go away by itself (timeouts, lost connections, a full or degraded
     * cluster), false when the request was refused and needs fixing (no access, a wrong cluster)
     */
    isOutage(err) {
        return !REFUSALS.has(errorCode(err));
    }
}

RadosStorage.XATTR_SHA256 = XATTR_SHA256;
RadosStorage.XATTR_MANIFEST = XATTR_MANIFEST;
RadosStorage.XATTR_HEAD = XATTR_HEAD;

module.exports = RadosStorage;
