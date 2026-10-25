/* globals BigInt: false */
'use strict';

const os = require('os');

// errno number -> name ('ENOENT'), for bindings that report the number only
const ERRNO_NAMES = new Map(Object.entries(os.constants.errno).map(([name, value]) => [value, name]));

/**
 * Gives an error from the binding a string `code` such as 'ENOENT', as Node's own errors have
 */
function normalizeError(err) {
    if (err && typeof err.code === 'number') {
        const name = ERRNO_NAMES.get(Math.abs(err.code));
        err.radosCode = err.code;
        err.code = name || `ERRNO_${Math.abs(err.code)}`;
    }
    // a missing xattr means the head was never completed, which readers treat like a missing object
    if (err && err.code === 'ENODATA') {
        err.code = 'ENOENT';
    }
    return err;
}

function wrap(promise) {
    return promise.catch(err => {
        throw normalizeError(err);
    });
}

/**
 * One io context (pool + namespace) on top of node-librados (https://github.com/SourceRegistry/node-librados).
 *
 * node-librados has no compound write operations and no aio: every call is a blocking librados call on
 * the libuv threadpool, so UV_THREADPOOL_SIZE bounds the number of RADOS operations in flight. Without a
 * write op, create() can not write the data and the xattrs atomically, nor create exclusively. It falls
 * back to an existence check, write_full, and the xattrs one at a time with the manifest last: the
 * manifest xattr, not the object, is then the commit point of a head, and a head without one reads as
 * missing. A purpose-built binding would do rados_write_op_create(EXCLUSIVE) + rados_write_op_write_full
 * + rados_write_op_setxattr in one rados_aio_write_op_operate()
 */
class LibradosIoctx {
    constructor(io) {
        this.io = io;
    }

    async create(oid, data, xattrs) {
        const exists = await wrap(this.io.stat(oid)).then(
            () => true,
            err => {
                if (err.code === 'ENOENT') {
                    return false;
                }
                throw err;
            }
        );
        if (exists) {
            throw Object.assign(new Error(`RADOS object ${oid} already exists`), { code: 'EEXIST' });
        }
        try {
            await wrap(this.io.writeFull(oid, data));
            // the manifest goes last, see above
            const names = Object.keys(xattrs).sort((a, b) => (a === 'wd.manifest') - (b === 'wd.manifest'));
            for (const name of names) {
                await wrap(this.io.setXattr(oid, name, xattrs[name]));
            }
        } catch (err) {
            await this.remove(oid).catch(() => false);
            throw err;
        }
    }

    async read(oid, offset, length) {
        return await wrap(this.io.read(oid, BigInt(length), BigInt(offset)));
    }

    async getXattr(oid, name) {
        return await wrap(this.io.getXattr(oid, name));
    }

    async remove(oid) {
        await wrap(this.io.remove(oid));
    }

    async close() {
        await this.io.close?.();
    }
}

/**
 * Connection to one cluster, with an io context per pool and namespace. The namespace of an io context
 * is set once and never changed: node-librados changes it without locking out operations in flight
 */
class LibradosCluster {
    constructor(cluster) {
        this.cluster = cluster;
        this.ioctxs = new Map();
    }

    async fsid() {
        return String(await wrap(this.cluster.fsid())).toLowerCase();
    }

    async ioctx(pool, namespace) {
        const name = `${pool}\0${namespace}`;
        if (!this.ioctxs.has(name)) {
            let io;
            try {
                io = this.cluster.ioContext(pool);
            } catch (err) {
                throw normalizeError(err);
            }
            io.setNamespace(namespace);
            this.ioctxs.set(name, new LibradosIoctx(io));
        }
        return this.ioctxs.get(name);
    }

    async close() {
        for (const ioctx of this.ioctxs.values()) {
            await ioctx.close().catch(() => false);
        }
        this.ioctxs.clear();
        await this.cluster.close?.();
    }
}

/**
 * Connects to one cluster. Settings come from the cluster's own ceph.conf, or from monHost and key when
 * there is none, never from CEPH_ARGS: with several clusters in one process an environment variable would
 * apply to all of them
 *
 * @param {Object} config `{ clusterName, user, conf, keyring, monHost, key, opTimeout }`
 * @returns {LibradosCluster}
 */
async function connect(config) {
    let librados;
    try {
        // eslint-disable-next-line global-require
        librados = require('node-librados');
    } catch (err) {
        throw new Error('RADOS attachments need the node-librados package, which is not installed: ' + err.message);
    }
    const settings = {};
    if (config.monHost) {
        settings.mon_host = config.monHost;
    }
    if (config.keyring) {
        settings.keyring = config.keyring;
    }
    if (config.key) {
        settings.key = config.key;
    }
    if (config.opTimeout) {
        // librados waits forever by default, which would hang a delivery or a FETCH on a stuck PG
        settings.rados_osd_op_timeout = String(config.opTimeout);
        settings.rados_mon_op_timeout = String(config.opTimeout);
        settings.client_mount_timeout = String(config.opTimeout);
    }
    let cluster;
    try {
        cluster = await librados.Cluster.connect({
            clusterName: config.clusterName || 'ceph',
            userName: config.user || 'client.wildduck',
            // without a ceph.conf, mon_host and the key are set directly
            configFile: config.conf || (config.monHost ? false : '/etc/ceph/ceph.conf'),
            parseEnvironment: false,
            config: settings
        });
    } catch (err) {
        throw normalizeError(err);
    }
    return new LibradosCluster(cluster);
}

module.exports = { connect, normalizeError, LibradosCluster, LibradosIoctx };
