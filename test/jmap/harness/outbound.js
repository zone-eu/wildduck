'use strict';

// The outbound queue of the test server (the zone-queue collection and the mail GridFS bucket in the
// sender database) and a stand in for ZoneMTA: the test environment runs no MTA, so scenarios that
// need a delivery let `deliver()` do what the MTA does. It locks the due entries of a message,
// rebuilds the message from the stored header list and body exactly as ZoneMTA does, optionally DKIM
// signs it like zonemta-wildduck, hands it to the recipient over LMTP and removes the entries and the
// stored message.

const config = require('@zone-eu/wild-config');
const { MongoClient, GridFSBucket } = require('mongodb');
const { Headers } = require('@zone-eu/mailsplit');
const { dkimSign } = require('mailauth');
const seed = require('./seed');

let client = null;
let separate = null;

/** The sender database of the test server (config dbs.sender: a database name on the main connection, or a URL) */
async function senderDb() {
    const sender = config.dbs.sender;
    if (sender && /[:/]/.test(sender)) {
        if (!separate) {
            separate = await MongoClient.connect(sender, { serverSelectionTimeoutMS: 5000 });
        }
        return separate.db();
    }
    if (!client) {
        client = await MongoClient.connect(config.dbs.mongo, { serverSelectionTimeoutMS: 5000 });
    }
    return sender ? client.db(sender) : client.db(config.dbs.dbname);
}

const queue = async () => (await senderDb()).collection(config.sender.collection);
const files = async () => (await senderDb()).collection(`${config.sender.gfs}.files`);

/** The queue entries of a queued message, in delivery order */
async function entries(queueId) {
    return (await queue()).find({ id: queueId }).sort({ seq: 1 }).toArray();
}

/** Every queue entry for a recipient address (compared case insensitively) */
async function entriesFor(recipient) {
    return (await queue()).find({ recipient: new RegExp(`^${recipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).toArray();
}

/** The GridFS entry of a queued message (metadata.data is the stored envelope), or null */
async function file(queueId) {
    return (await files()).findOne({ filename: `message ${queueId}` });
}

/** The queued message as the MTA would send it: the stored header list followed by the stored body */
async function message(queueId) {
    const entry = await file(queueId);
    if (!entry) {
        return null;
    }
    const bucket = new GridFSBucket(await senderDb(), { bucketName: config.sender.gfs });
    const chunks = [];
    for await (const chunk of bucket.openDownloadStream(entry._id)) {
        chunks.push(chunk);
    }
    const headers = new Headers(entry.metadata.data.headers);
    return Buffer.concat([headers.build(), Buffer.concat(chunks)]);
}

/** Marks queue entries of a message as locked by the MTA (all, or the one with the given seq) */
async function lock(queueId, seq) {
    await (await queue()).updateMany(Object.assign({ id: queueId }, seq ? { seq } : {}), { $set: { locked: true, lockTime: Date.now() } });
}

/** Releases the locks of a message's queue entries, as the MTA does after a deferred attempt */
async function unlock(queueId) {
    await (await queue()).updateMany({ id: queueId }, { $set: { locked: false, lockTime: 0 } });
}

/** Removes queue entries of a message as the MTA does after delivery (all, or the one with the given seq) */
async function remove(queueId, seq) {
    const collection = await queue();
    await collection.deleteMany(Object.assign({ id: queueId }, seq ? { seq } : {}));
    if (!(await collection.countDocuments({ id: queueId }))) {
        const entry = await file(queueId);
        if (entry) {
            await new GridFSBucket(await senderDb(), { bucketName: config.sender.gfs }).delete(entry._id);
        }
    }
}

/**
 * Delivers the due entries of a queued message over LMTP. A recipient this server does not host counts
 * as handed over to a remote MX: its entry is removed and it is not in the answer.
 *
 * @param {String} queueId
 * @param {Object} [options] {force: deliver entries that are not due yet, dkim: {signingDomain, selector, privateKey}}
 * @returns {Promise<String[]>} the local recipients delivered to
 */
async function deliver(queueId, options = {}) {
    const collection = await queue();
    const due = (await entries(queueId)).filter(entry => !entry.locked && (options.force || new Date(entry.queued) <= new Date()));
    if (!due.length) {
        return [];
    }
    await collection.updateMany({ _id: { $in: due.map(entry => entry._id) } }, { $set: { locked: true, lockTime: Date.now() } });
    let raw = await message(queueId);
    const envelope = (await file(queueId)).metadata.data;
    if (options.dkim) {
        const signed = await dkimSign(raw, { canonicalization: 'relaxed/relaxed', signatureData: [Object.assign({ algorithm: 'rsa-sha256' }, options.dkim)] });
        raw = Buffer.concat([Buffer.from(signed.signatures), raw]);
    }
    const delivered = [];
    for (const entry of due) {
        const local = await seed.deliver(entry.recipient, raw, envelope.from || 'sender@example.net').then(
            () => true,
            err => (/Unknown recipient/i.test(err.message) ? false : Promise.reject(err))
        );
        await collection.deleteOne({ _id: entry._id });
        if (local) {
            delivered.push(entry.recipient);
        }
    }
    if (!(await collection.countDocuments({ id: queueId }))) {
        await remove(queueId);
    }
    return delivered;
}

async function close() {
    for (const connection of [client, separate]) {
        if (connection) {
            await connection.close();
        }
    }
    client = null;
    separate = null;
}

module.exports = { senderDb, entries, entriesFor, file, message, lock, unlock, remove, deliver, close };
