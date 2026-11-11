'use strict';

// Extra JMAP service instances started inside the test process, for scenarios that need a
// configuration the shared test server does not have (public base URL, CORS, TLS, a disabled
// service) or that inspect what the service logs. An instance is a second "worker": it shares
// MongoDB and Redis with the test server through lib/db, exactly like the worker processes do.

const net = require('net');
const util = require('util');
const log = require('npmlog');
const config = require('@zone-eu/wild-config');
const db = require('../../../lib/db');
const jmapService = require('../../../jmap');

const start = util.promisify(jmapService.start);
const running = new Set();
let connecting = null;
let records = null;

/** A TCP port nobody listens on right now. */
function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/** Connects lib/db of the test process once; instances take their handles from it. */
async function connect() {
    if (!connecting) {
        connecting = db.connect();
    }
    await connecting;
    return db;
}

/**
 * Starts a JMAP service instance.
 *
 * @param {Function|Object} [overrides] [jmap] options over the test configuration, or a function of the port answering them
 * @param {Object} [hooks] {database, senderDb: functions of the real handle answering the database handle the instance uses}
 * @returns {Promise<{app, port, url: String}|{app: false, port}>} app is false when the options disable the service
 */
async function startInstance(overrides = {}, hooks = {}) {
    await connect();
    const port = await freePort();
    const extra = typeof overrides === 'function' ? overrides(port) : overrides;
    const options = Object.assign({}, config.jmap, { enabled: true, port, host: '127.0.0.1' }, extra);

    const { database, senderDb } = db;
    if (hooks.database) {
        db.database = hooks.database(database);
    }
    if (hooks.senderDb) {
        db.senderDb = hooks.senderDb(senderDb);
    }
    let app;
    try {
        app = await start(options);
    } finally {
        Object.assign(db, { database, senderDb });
    }
    if (app) {
        running.add(app);
    }
    return { app, port, url: `${options.secure ? 'https' : 'http'}://127.0.0.1:${port}` };
}

async function stopInstance(app) {
    if (app && running.delete(app)) {
        await app.close();
    }
}

async function stopAll() {
    await Promise.all([...running].map(stopInstance));
}

/**
 * Starts collecting the npmlog records of the test process (the instances log through it) and
 * silences their console output. Answers the live array of {level, prefix, message} records.
 */
function captureLog() {
    if (!records) {
        records = [];
        log.level = 'silent';
        log.on('log', record => records.push({ level: record.level, prefix: record.prefix, message: record.message }));
    }
    return records;
}

module.exports = { startInstance, stopInstance, stopAll, captureLog, freePort, connect };
