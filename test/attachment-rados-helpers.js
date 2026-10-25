'use strict';

/**
 * In-memory stand-in for the RadosStorage client interface (see lib/attachments/rados-storage.js), with
 * fault injection. Errors carry string codes, as rados-client.js normalizes them
 */
class FakeRados {
    constructor() {
        this.objects = new Map();
        this.faults = [];
        this.calls = [];
    }

    /**
     * Makes matching calls fail with `code`. `match` gets `(op, oid)`; `times` limits how often
     */
    fail(match, code, times = Infinity) {
        this.faults.push({ match, code, times });
    }

    check(op, oid) {
        this.calls.push(`${op} ${oid}`);
        for (const fault of this.faults) {
            if (fault.times > 0 && fault.match(op, oid)) {
                fault.times--;
                throw Object.assign(new Error(`injected ${fault.code} on ${op} ${oid}`), { code: fault.code });
            }
        }
    }

    missing(oid) {
        return Object.assign(new Error(`${oid}: No such file or directory`), { code: 'ENOENT' });
    }

    async create(oid, data, xattrs) {
        this.check('create', oid);
        if (this.objects.has(oid)) {
            throw Object.assign(new Error(`${oid} exists`), { code: 'EEXIST' });
        }
        this.objects.set(oid, { data: Buffer.from(data), xattrs: new Map(Object.entries(xattrs).map(([name, value]) => [name, Buffer.from(value)])) });
    }

    async read(oid, offset, length) {
        this.check('read', oid);
        const object = this.objects.get(oid);
        if (!object) {
            throw this.missing(oid);
        }
        return Buffer.from(object.data.subarray(offset, offset + length));
    }

    async getXattr(oid, name) {
        this.check('getXattr', oid);
        const object = this.objects.get(oid);
        if (!object || !object.xattrs.has(name)) {
            throw this.missing(oid);
        }
        return Buffer.from(object.xattrs.get(name));
    }

    async remove(oid) {
        this.check('remove', oid);
        if (!this.objects.delete(oid)) {
            throw this.missing(oid);
        }
    }

    names() {
        return [...this.objects.keys()].sort();
    }
}

/**
 * In-memory cluster: an fsid and a FakeRados per pool and namespace
 */
class FakeCluster {
    constructor(fsid) {
        this.fsidValue = fsid;
        // what fsid() answers, to test a ceph.conf that points to the wrong cluster
        this.reportedFsid = fsid;
        this.ioctxs = new Map();
        this.connects = 0;
        this.connectError = null;
        this.closed = 0;
    }

    pool(pool, namespace = 'wildduck') {
        const name = `${pool}/${namespace}`;
        if (!this.ioctxs.has(name)) {
            this.ioctxs.set(name, new FakeRados());
        }
        return this.ioctxs.get(name);
    }

    async fsid() {
        return this.reportedFsid;
    }

    async ioctx(pool, namespace) {
        return this.pool(pool, namespace);
    }

    async close() {
        this.closed++;
    }

    /**
     * Number of objects in every pool
     */
    size() {
        return [...this.ioctxs.values()].reduce((sum, rados) => sum + rados.objects.size, 0);
    }
}

/**
 * `radosConnect` option for RadosStorage that hands out the FakeCluster with the configured fsid
 */
function fakeConnect(...clusters) {
    return async config => {
        const cluster = clusters.find(cluster => cluster.fsidValue === config.fsid);
        if (!cluster) {
            throw Object.assign(new Error(`no cluster ${config.fsid}`), { code: 'ETIMEDOUT' });
        }
        cluster.connects++;
        cluster.lastConfig = config;
        if (cluster.connectError) {
            throw Object.assign(new Error(`connect failed: ${cluster.connectError}`), { code: cluster.connectError });
        }
        return cluster;
    };
}

module.exports = { FakeRados, FakeCluster, fakeConnect };
