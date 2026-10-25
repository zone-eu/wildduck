/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0, global-require: 0, no-bitwise: 0 */
/* globals BigInt: false */
'use strict';

// RADOS attachment storage: striping into a head and tails, integrity checks and cleanup against an
// in-memory cluster. No Ceph cluster is needed.

const crypto = require('crypto');
const { expect } = require('chai');
const RadosStorage = require('../lib/attachments/rados-storage');
const { normalizeError, LibradosIoctx, LibradosCluster } = require('../lib/attachments/rados-client');
const { FakeRados, FakeCluster, fakeConnect } = require('./attachment-rados-helpers');
const { collect } = require('./attachment-s3-helpers');

const STRIPE = 64 * 1024;

const FSID_A = '5f8e2c1a-7b3d-4e9f-a6c0-d1b2e3f4a5b6';
const FSID_B = '9c1f2d3e-0a1b-4c2d-8e3f-112233445566';

function radosConfig(extra = {}) {
    return { prefix: 'test', stripeSize: STRIPE, clusters: { a: { fsid: FSID_A } }, placement: ['a/mail'], ...extra };
}

/**
 * RadosStorage on one in-memory cluster whose pool `mail` is `rados`
 */
function radosStorage(rados, extra = {}) {
    const cluster = new FakeCluster(FSID_A);
    cluster.ioctxs.set('mail/wildduck', rados);
    return new RadosStorage({ radosConnect: fakeConnect(cluster), options: { rados: radosConfig(extra) } });
}

/**
 * RadosStorage on two in-memory clusters
 */
function twoClusters(extra = {}) {
    const a = new FakeCluster(FSID_A);
    const b = new FakeCluster(FSID_B);
    const storage = new RadosStorage({
        radosConnect: fakeConnect(a, b),
        options: { rados: radosConfig({ clusters: { a: { fsid: FSID_A }, b: { fsid: FSID_B } }, placement: ['a/mail', 'b/mail'], ...extra }) }
    });
    return { a, b, storage };
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest();
}

async function put(storage, body) {
    const id = sha256(body);
    return await storage.put(id, body, body.length, sha256(body));
}

function attachmentData(location) {
    return { length: location.length, metadata: { storage: { version: 1, backend: 'rados', ...location } } };
}

async function read(storage, location, options) {
    return await collect(storage.createReadStream(null, attachmentData(location), options));
}

describe('RADOS attachment storage', function () {
    describe('configuration', function () {
        const config = extra => () => new RadosStorage({ options: { rados: radosConfig(extra) } });

        it('requires a cluster and a prefix', function () {
            expect(config({ clusters: {} })).to.throw(/rados.clusters/);
            expect(config({ prefix: '' })).to.throw(/rados.prefix/);
        });

        it('requires the fsid of every cluster, once', function () {
            expect(config({ clusters: { a: { conf: '/etc/ceph/a.conf' } } })).to.throw(/rados.clusters.a.fsid/);
            expect(config({ clusters: { a: { fsid: 'not-an-fsid' } } })).to.throw(/rados.clusters.a.fsid/);
            expect(config({ clusters: { a: { fsid: FSID_A }, b: { fsid: FSID_A.toUpperCase() } } })).to.throw(/same fsid/);
        });

        it('checks the placement against the clusters and their pools', function () {
            expect(config({ placement: ['x/mail'] })).to.throw(/not in rados.clusters/);
            expect(config({ placement: ['a'] })).to.throw(/Invalid rados.placement/);
            expect(config({ placement: ['a/mail', 'a/mail:2'] })).to.throw(/twice/);
            expect(config({ clusters: { a: { fsid: FSID_A, pools: ['other'] } } })).to.throw(/not in rados.clusters.a.pools/);
        });

        it('reads the placement as a list or a comma separated string, and leaves out targets of weight 0', function () {
            const { storage } = twoClusters({ placement: 'a/mail:3, b/mail:0' });
            expect(storage.targets.map(target => [target.cluster.label, target.pool, target.weight])).to.deep.equal([['a', 'mail', 3]]);
        });

        it('takes settings that arrive as strings from environment variables', function () {
            const storage = new RadosStorage({
                options: {
                    rados: radosConfig({
                        stripeSize: '131072',
                        downTime: '5000',
                        reconnectDelay: '0',
                        writeAttempts: '3',
                        opTimeout: '12',
                        verifyPartialStripes: 'false',
                        clusters: { a: { fsid: FSID_A, pools: 'mail, other' } },
                        placement: 'a/mail:2,a/other'
                    })
                }
            });
            expect(storage.stripeSize).to.equal(131072);
            expect(storage.downTime).to.equal(5000);
            expect(storage.reconnectDelay).to.equal(0);
            expect(storage.writeAttempts).to.equal(3);
            expect(storage.verifyPartialStripes).to.be.false;
            expect(storage.clusters.get('a').config.opTimeout).to.equal(12);
            expect(storage.clusters.get('a').pools).to.deep.equal(['mail', 'other']);
            expect(storage.targets.map(target => [target.pool, target.weight])).to.deep.equal([
                ['mail', 2],
                ['other', 1]
            ]);
            expect(new RadosStorage({ options: { rados: radosConfig({ verifyPartialStripes: 'true' }) } }).verifyPartialStripes).to.be.true;
            expect(() => new RadosStorage({ options: { rados: radosConfig({ downTime: 'soon' }) } })).to.throw(/must be numbers/);
        });

        it('refuses a stripe size below 64 KiB', function () {
            expect(() => radosStorage(new FakeRados(), { stripeSize: 1000 })).to.throw(/stripeSize/);
        });

        it('uses the wildduck namespace, 4 MiB stripes and a 30 s operation timeout by default', function () {
            const storage = new RadosStorage({ options: { rados: { prefix: 'p', clusters: { a: { fsid: FSID_A } } } } });
            expect(storage.namespace).to.equal('wildduck');
            expect(storage.stripeSize).to.equal(4 * 1024 * 1024);
            expect(storage.clusters.get('a').config.opTimeout).to.equal(30);
        });
    });

    describe('clusters', function () {
        it('connects to a cluster once, on first use', async function () {
            const { a, b, storage } = twoClusters();
            expect(a.connects + b.connects).to.equal(0);
            await Promise.all([put(storage, Buffer.from('one')), put(storage, Buffer.from('two')), put(storage, Buffer.from('three'))]);
            expect(a.connects).to.be.at.most(1);
            expect(b.connects).to.be.at.most(1);
        });

        it('refuses a cluster that reports another fsid', async function () {
            const { a, storage } = twoClusters({ placement: ['a/mail'] });
            a.reportedFsid = FSID_B;
            const err = await put(storage, Buffer.from('x')).catch(err => err);
            expect(err.code).to.equal('EFSIDMISMATCH');
            expect(storage.isOutage(err)).to.be.false;
            expect(a.closed).to.equal(1);
            expect(a.size()).to.equal(0);
        });

        it('fails at once for a while after a failed connection, then tries again', async function () {
            const { a, storage } = twoClusters({ placement: ['a/mail'], reconnectDelay: 60 * 1000 });
            a.connectError = 'ETIMEDOUT';
            expect((await put(storage, Buffer.from('x')).catch(err => err)).code).to.equal('ETIMEDOUT');
            expect((await put(storage, Buffer.from('x')).catch(err => err)).message).to.match(/unreachable/);
            expect(a.connects).to.equal(1);
            a.connectError = null;
            storage.clusters.get('a').failedAt = 0;
            await put(storage, Buffer.from('x'));
            expect(a.connects).to.equal(2);
        });

        it('stores the fsid, pool and namespace in the locator', async function () {
            const { storage } = twoClusters({ placement: ['b/mail'] });
            const location = await put(storage, Buffer.from('x'));
            expect(location).to.include({ fsid: FSID_B, pool: 'mail', namespace: 'wildduck' });
        });

        it('reads a payload from any configured cluster, also one that takes no new payloads', async function () {
            const { storage } = twoClusters({ placement: ['b/mail'] });
            const body = crypto.randomBytes(STRIPE + 5);
            const location = await put(storage, body);
            const reader = new RadosStorage({
                radosConnect: storage.connect,
                options: { rados: radosConfig({ clusters: { a: { fsid: FSID_A }, b: { fsid: FSID_B } }, placement: ['a/mail:1', 'b/mail:0'] }) }
            });
            expect((await read(reader, location)).equals(body)).to.be.true;
        });

        it('refuses a payload on a cluster or pool it does not have', async function () {
            const { storage } = twoClusters({ placement: ['b/mail'] });
            const location = await put(storage, Buffer.from('x'));
            const onlyA = radosStorage(new FakeRados());
            expect(onlyA.reaches(location)).to.be.false;
            expect((await read(onlyA, location).catch(err => err)).message).to.match(/does not use/);
            const restricted = twoClusters({ clusters: { a: { fsid: FSID_A }, b: { fsid: FSID_B, pools: ['other'] } }, placement: ['a/mail'] }).storage;
            expect(restricted.reaches(location)).to.be.false;
        });
    });

    describe('placement', function () {
        const ids = Array.from({ length: 4000 }, (v, index) => sha256(Buffer.from(String(index))));

        it('spreads payloads over the targets in proportion to their weight', function () {
            const { storage } = twoClusters({ placement: ['a/mail:3', 'b/mail:1'] });
            const onA = ids.filter(id => storage.order(id)[0].cluster.label === 'a').length;
            expect(onA / ids.length).to.be.within(0.72, 0.78);
        });

        it('puts the same attachment in the same place every time', function () {
            const { storage } = twoClusters();
            for (const id of ids.slice(0, 50)) {
                expect(storage.order(id).map(target => target.name)).to.deep.equal(storage.order(id).map(target => target.name));
            }
        });

        it('only moves the share of a new target when one is added', function () {
            const before = twoClusters({ placement: ['a/mail', 'b/mail'] }).storage;
            const after = twoClusters({ placement: ['a/mail', 'b/mail', 'b/more'] }).storage;
            let moved = 0;
            for (const id of ids) {
                const was = before.order(id)[0].name;
                const is = after.order(id)[0].name;
                if (was !== is) {
                    expect(is).to.equal(`${FSID_B}/more/wildduck`);
                    moved++;
                }
            }
            expect(moved / ids.length).to.be.within(0.28, 0.39);
        });

        it('writes to the next target when the preferred one has an outage, and tries it last for a while', async function () {
            const { a, b, storage } = twoClusters();
            a.connectError = 'ETIMEDOUT';
            const body = ids.map(id => id).find(id => storage.order(sha256(id))[0].cluster.label === 'a');
            const location = await put(storage, body);
            expect(location.fsid).to.equal(FSID_B);
            expect(b.size()).to.equal(1);
            const id = sha256(body);
            expect(storage.order(id)[0].cluster.label).to.equal('b');
        });

        it('does not move on when the preferred target refuses the write', async function () {
            const { a, b, storage } = twoClusters();
            const body = ids.find(id => storage.order(sha256(id))[0].cluster.label === 'a');
            a.pool('mail').fail(() => true, 'EACCES');
            expect((await put(storage, body).catch(err => err)).code).to.equal('EACCES');
            expect(b.size()).to.equal(0);
        });

        it('fails when every target it tries has an outage', async function () {
            const { a, b, storage } = twoClusters();
            a.connectError = 'ETIMEDOUT';
            b.connectError = 'ETIMEDOUT';
            expect((await put(storage, Buffer.from('x')).catch(err => err)).code).to.equal('ETIMEDOUT');
        });
    });

    describe('striping', function () {
        for (const [description, length, stripes] of [
            ['an empty payload as a head only', 0, 1],
            ['a payload smaller than a stripe as a head only', 1000, 1],
            ['a payload of exactly one stripe as a head only', STRIPE, 1],
            ['a payload one byte over a stripe as a head and a tail', STRIPE + 1, 2],
            ['a payload of several stripes as a head and tails', 3 * STRIPE + 17, 4]
        ]) {
            it(`stores ${description}`, async function () {
                const rados = new FakeRados();
                const storage = radosStorage(rados);
                const body = crypto.randomBytes(length);
                const location = await put(storage, body);
                expect(location.stripes).to.equal(stripes);
                expect(rados.objects.size).to.equal(stripes);
                expect((await read(storage, location)).equals(body)).to.be.true;
            });
        }

        it('names tails after their head and writes the head last', async function () {
            const rados = new FakeRados();
            const storage = radosStorage(rados);
            const location = await put(storage, crypto.randomBytes(3 * STRIPE));
            expect(rados.names()).to.deep.equal([location.key, `${location.key}.1`, `${location.key}.2`]);
            const creates = rados.calls.filter(call => call.startsWith('create '));
            expect(creates[creates.length - 1]).to.equal(`create ${location.key}`);
        });

        it('stores checksums, the manifest and the head name in xattrs', async function () {
            const rados = new FakeRados();
            const storage = radosStorage(rados);
            const body = crypto.randomBytes(2 * STRIPE + 5);
            const location = await put(storage, body);
            const head = rados.objects.get(location.key);
            const tail = rados.objects.get(`${location.key}.2`);
            const manifest = JSON.parse(head.xattrs.get(RadosStorage.XATTR_MANIFEST).toString());
            expect(manifest).to.include({ v: 1, length: body.length, stripeSize: STRIPE, sha256: sha256(body).toString('base64') });
            expect(manifest.stripes).to.have.length(3);
            expect(head.xattrs.get(RadosStorage.XATTR_SHA256).equals(sha256(body.subarray(0, STRIPE)))).to.be.true;
            expect(tail.xattrs.get(RadosStorage.XATTR_SHA256).equals(sha256(body.subarray(2 * STRIPE)))).to.be.true;
            expect(tail.xattrs.get(RadosStorage.XATTR_HEAD).toString()).to.equal(location.key);
            expect(tail.xattrs.has(RadosStorage.XATTR_MANIFEST)).to.be.false;
        });

        it('gives every copy of the same payload its own objects', async function () {
            const rados = new FakeRados();
            const storage = radosStorage(rados);
            const body = crypto.randomBytes(STRIPE + 1);
            const first = await put(storage, body);
            const second = await put(storage, body);
            expect(first.key).to.not.equal(second.key);
            expect(rados.objects.size).to.equal(4);
        });

        it('parses head and tail names back into id and stripe', async function () {
            const storage = radosStorage(new FakeRados());
            const id = crypto.randomBytes(32);
            const key = storage.key(id, '0123456789abcdef');
            expect(storage.parseName(key)).to.deep.include({ key, stripe: 0 });
            expect(storage.parseName(`${key}.12`)).to.deep.include({ key, stripe: 12 });
            expect(storage.parseName(`${key}.12`).id.equals(id)).to.be.true;
            for (const name of [`${key}.0`, `${key}.x`, `other/${key}`, key.replace(/\.[0-9a-f]+$/, '.short')]) {
                expect(storage.parseName(name), name).to.be.null;
            }
        });

        it('refuses a checksum that does not match the payload', async function () {
            const storage = radosStorage(new FakeRados());
            const body = Buffer.from('payload');
            const err = await storage.put(sha256(body), body, body.length, sha256(Buffer.from('other'))).catch(err => err);
            expect(err.message).to.match(/checksum/);
        });
    });

    describe('reading', function () {
        let rados;
        let storage;
        let body;
        let location;

        beforeEach(async function () {
            rados = new FakeRados();
            storage = radosStorage(rados);
            body = crypto.randomBytes(3 * STRIPE + 100);
            location = await put(storage, body);
        });

        for (const [description, start, end] of [
            ['inside the head', 10, 20],
            ['inside a tail', STRIPE + 5, STRIPE + 500],
            ['across a stripe boundary', STRIPE - 3, STRIPE + 3],
            ['across several stripes', 100, 3 * STRIPE + 50],
            ['up to the end', 2 * STRIPE, 3 * STRIPE + 100]
        ]) {
            it(`reads a range ${description}`, async function () {
                const data = await collect(storage.openRange(location, start, end));
                expect(data.equals(body.subarray(start, end))).to.be.true;
            });
        }

        it('reads only the stripes a range covers', async function () {
            rados.calls = [];
            await collect(storage.openRange(location, STRIPE + 1, STRIPE + 2));
            expect(rados.calls.filter(call => call.startsWith('read '))).to.deep.equal([`read ${location.key}.1`]);
        });

        it('fails a full stripe that does not match its checksum', async function () {
            rados.objects.get(`${location.key}.1`).data[7] ^= 0xff;
            const err = await read(storage, location).catch(err => err);
            expect(err.code).to.equal('EBADMSG');
        });

        it('serves a corrupted partial stripe unless partial stripes are verified', async function () {
            rados.objects.get(`${location.key}.1`).data[7] ^= 0xff;
            expect((await collect(storage.openRange(location, STRIPE, STRIPE + 10))).length).to.equal(10);
            const strict = radosStorage(rados, { verifyPartialStripes: true });
            expect((await collect(strict.openRange(location, STRIPE, STRIPE + 10)).catch(err => err)).code).to.equal('EBADMSG');
        });

        it('fails a stripe that is shorter than the manifest says', async function () {
            const tail = rados.objects.get(`${location.key}.3`);
            tail.data = tail.data.subarray(0, 10);
            expect((await read(storage, location).catch(err => err)).code).to.equal('EBADMSG');
        });

        it('answers ENOENT for a missing head, so readers serve a placeholder', async function () {
            await rados.remove(location.key);
            expect((await read(storage, location).catch(err => err)).code).to.equal('ENOENT');
        });

        it('answers ENOENT for a head whose manifest was never written', async function () {
            rados.objects.get(location.key).xattrs.delete(RadosStorage.XATTR_MANIFEST);
            expect((await read(storage, location).catch(err => err)).code).to.equal('ENOENT');
        });

        it('refuses a manifest that does not match the catalog locator', async function () {
            const err = await read(storage, { ...location, length: location.length - 1, stripes: 4 }).catch(err => err);
            expect(err.code).to.equal('EBADMSG');
        });

        it('refuses an invalid locator', function () {
            expect(() => storage.createReadStream(null, attachmentData({ ...location, stripes: 9 }))).to.throw(/Invalid RADOS attachment locator/);
        });
    });

    describe('writing failures', function () {
        it('removes the tails it wrote when the head can not be written', async function () {
            const rados = new FakeRados();
            const storage = radosStorage(rados);
            rados.fail((op, oid) => op === 'create' && !/\.\d+$/.test(oid), 'ETIMEDOUT');
            const err = await put(storage, crypto.randomBytes(3 * STRIPE)).catch(err => err);
            expect(err.code).to.equal('ETIMEDOUT');
            expect(rados.objects.size).to.equal(0);
        });

        it('removes the tails it wrote when a tail can not be written, and never writes the head', async function () {
            const rados = new FakeRados();
            const storage = radosStorage(rados, { writeConcurrency: 1 });
            rados.fail((op, oid) => op === 'create' && oid.endsWith('.3'), 'EIO');
            const err = await put(storage, crypto.randomBytes(4 * STRIPE)).catch(err => err);
            expect(err.code).to.equal('EIO');
            expect(rados.objects.size).to.equal(0);
            expect(rados.calls.some(call => /^create [^ ]+\.[0-9a-f]{16}$/.test(call))).to.be.false;
        });

        it('deletes a copy that the catalog declined', async function () {
            const rados = new FakeRados();
            const storage = radosStorage(rados);
            const body = crypto.randomBytes(STRIPE + 1);
            expect(await storage.store(sha256(body), body, body.length, sha256(body), async () => false)).to.be.false;
            expect(rados.objects.size).to.equal(0);
        });

        it('keeps a copy whose catalog outcome is unknown', async function () {
            const rados = new FakeRados();
            const storage = radosStorage(rados);
            const body = crypto.randomBytes(10);
            const commit = async () => {
                throw new Error('connection reset');
            };
            expect((await storage.store(sha256(body), body, body.length, sha256(body), commit).catch(err => err)).message).to.equal('connection reset');
            expect(rados.objects.size).to.equal(1);
        });
    });

    describe('deleting', function () {
        it('removes the head first, then every tail', async function () {
            const rados = new FakeRados();
            const storage = radosStorage(rados);
            const location = await put(storage, crypto.randomBytes(3 * STRIPE));
            rados.calls = [];
            await storage.deletePayload(location);
            expect(rados.objects.size).to.equal(0);
            expect(rados.calls[0]).to.equal(`remove ${location.key}`);
        });

        it('finishes an interrupted deletion when run again', async function () {
            const rados = new FakeRados();
            const storage = radosStorage(rados);
            const location = await put(storage, crypto.randomBytes(3 * STRIPE));
            rados.fail((op, oid) => op === 'remove' && oid.endsWith('.2'), 'ETIMEDOUT', 1);
            expect((await storage.deletePayload(location).catch(err => err)).code).to.equal('ETIMEDOUT');
            expect(rados.names()).to.deep.equal([`${location.key}.2`]);
            await storage.deletePayload(location);
            expect(rados.objects.size).to.equal(0);
        });

        it('tells outages from refusals', function () {
            const storage = radosStorage(new FakeRados());
            for (const code of ['ETIMEDOUT', 'EIO', 'ENOTCONN', 'ESHUTDOWN', 'ENOSPC', undefined]) {
                expect(storage.isOutage({ code }), String(code)).to.be.true;
            }
            for (const code of ['EACCES', 'EPERM', 'EINVAL']) {
                expect(storage.isOutage({ code }), code).to.be.false;
            }
        });
    });

    describe('node-librados client', function () {
        it('turns negative errno numbers into error codes', function () {
            expect(normalizeError({ code: -2 }).code).to.equal('ENOENT');
            expect(normalizeError({ code: -110 }).code).to.equal('ETIMEDOUT');
            // a head without its manifest xattr reads as missing
            expect(normalizeError({ code: -61 }).code).to.equal('ENOENT');
            expect(normalizeError({ code: 'EIO' }).code).to.equal('EIO');
        });

        function fakeIo() {
            const objects = new Map();
            const calls = [];
            const enoent = () => Object.assign(new Error('ENOENT'), { code: -2 });
            return {
                objects,
                calls,
                async stat(oid) {
                    calls.push(`stat ${oid}`);
                    if (!objects.has(oid)) {
                        throw enoent();
                    }
                    return { size: BigInt(objects.get(oid).data.length) };
                },
                async writeFull(oid, data) {
                    calls.push(`writeFull ${oid}`);
                    objects.set(oid, { data, xattrs: {} });
                },
                async setXattr(oid, name, value) {
                    calls.push(`setXattr ${oid} ${name}`);
                    objects.get(oid).xattrs[name] = value;
                },
                async read(oid, length, offset) {
                    expect(length).to.be.a('bigint');
                    expect(offset).to.be.a('bigint');
                    return objects.get(oid).data.subarray(Number(offset), Number(offset + length));
                },
                async remove(oid) {
                    if (!objects.delete(oid)) {
                        throw enoent();
                    }
                }
            };
        }

        it('writes the manifest xattr last, as the commit point of a head', async function () {
            const io = fakeIo();
            const client = new LibradosIoctx(io);
            await client.create('head', Buffer.from('x'), { 'wd.manifest': Buffer.from('{}'), 'wd.sha256': Buffer.alloc(32) });
            expect(io.calls).to.deep.equal(['stat head', 'writeFull head', 'setXattr head wd.sha256', 'setXattr head wd.manifest']);
        });

        it('refuses to create an object that exists', async function () {
            const io = fakeIo();
            const client = new LibradosIoctx(io);
            await client.create('o', Buffer.from('a'), {});
            expect((await client.create('o', Buffer.from('b'), {}).catch(err => err)).code).to.equal('EEXIST');
            expect(io.objects.get('o').data.toString()).to.equal('a');
        });

        it('removes a half-written object', async function () {
            const io = fakeIo();
            io.setXattr = async () => {
                throw Object.assign(new Error('timed out'), { code: -110 });
            };
            const client = new LibradosIoctx(io);
            expect((await client.create('o', Buffer.from('a'), { 'wd.sha256': Buffer.alloc(32) }).catch(err => err)).code).to.equal('ETIMEDOUT');
            expect(io.objects.size).to.equal(0);
        });

        it('checks the fsid in lower case and opens an io context per pool and namespace', async function () {
            const opened = [];
            const cluster = new LibradosCluster({
                fsid: async () => FSID_A.toUpperCase(),
                ioContext: pool => {
                    const io = { setNamespace: namespace => opened.push(`${pool}/${namespace}`) };
                    return io;
                }
            });
            expect(await cluster.fsid()).to.equal(FSID_A);
            const first = await cluster.ioctx('mail', 'wildduck');
            expect(await cluster.ioctx('mail', 'wildduck')).to.equal(first);
            await cluster.ioctx('mail', 'other');
            expect(opened).to.deep.equal(['mail/wildduck', 'mail/other']);
        });

        it('reads with BigInt offsets in the binding argument order', async function () {
            const io = fakeIo();
            const client = new LibradosIoctx(io);
            await client.create('o', Buffer.from('0123456789'), {});
            expect((await client.read('o', 2, 3)).toString()).to.equal('234');
        });
    });
});
