/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Storing a message can fail after the write happened (a write concern error). The attachment references the
// message took must then stay, or the collector deletes attachments of a message that exists.

const crypto = require('crypto');
const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const db = require('../lib/db');
const MessageHandler = require('../lib/message-handler');

describe('Storing a message whose insert reports an error', function () {
    this.timeout(30000);

    let userId;
    let mailboxId;
    let bucket;

    before(async function () {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
    });

    beforeEach(async function () {
        userId = new ObjectId();
        mailboxId = new ObjectId();
        bucket = `attstore${crypto.randomBytes(4).toString('hex')}`;
        await db.users.collection('users').insertOne({ _id: userId, username: `store-outcome-${userId}`, storageUsed: 0, quota: 0 });
        await db.database
            .collection('mailboxes')
            .insertOne({ _id: mailboxId, user: userId, path: 'INBOX', uidValidity: 1, uidNext: 1, modifyIndex: 0, subscribed: true, flags: [] });
    });

    afterEach(async function () {
        await db.users.collection('users').deleteOne({ _id: userId });
        await db.database.collection('mailboxes').deleteOne({ _id: mailboxId });
        await db.database.collection('messages').deleteMany({ mailbox: mailboxId });
        for (let suffix of ['files', 'chunks']) {
            await db.gridfs
                .collection(`${bucket}.${suffix}`)
                .drop()
                .catch(() => false);
        }
    });

    // a messages collection whose insert fails in the given way
    function handlerWith(insertOne, findOne) {
        let database = Object.create(db.database);
        database.collection = (name, ...args) => {
            let collection = db.database.collection(name, ...args);
            if (name !== 'messages') {
                return collection;
            }
            let wrapped = Object.create(collection);
            wrapped.insertOne = (...insertArgs) => insertOne(collection, ...insertArgs);
            if (findOne) {
                wrapped.findOne = (...findArgs) => findOne(collection, ...findArgs);
            }
            return wrapped;
        };
        return new MessageHandler({ database, users: db.users, gridfs: db.gridfs, redis: db.redis, attachments: { type: 'gridstore', bucket } });
    }

    let writeConcernError = () => Object.assign(new Error('waiting for replication timed out'), { code: 64, name: 'MongoWriteConcernError' });

    function raw() {
        let attachment = crypto.randomBytes(2000).toString('base64').replace(/.{76}/g, '$&\r\n');
        return Buffer.from(
            'From: a@example.com\r\nTo: b@example.com\r\nSubject: outcome\r\nMIME-Version: 1.0\r\n' +
                'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n' +
                '--b\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
                attachment +
                '\r\n--b--\r\n'
        );
    }

    async function attachmentCounters() {
        let file = await db.gridfs.collection(`${bucket}.files`).findOne({});
        return file && file.metadata.c;
    }

    it('keeps the references and reports success when the message was stored anyway', async function () {
        let handler = handlerWith(async (collection, doc, options) => {
            await collection.insertOne(doc, options);
            throw writeConcernError();
        });
        let result = await handler.addAsync({ user: userId, mailbox: mailboxId, raw: raw(), flags: [] });
        expect(result.status).to.be.true;
        expect(await db.database.collection('messages').countDocuments({ mailbox: mailboxId })).to.equal(1);
        expect(await attachmentCounters()).to.equal(1);
    });

    it('releases the references when the message was not stored', async function () {
        let handler = handlerWith(async () => {
            throw new Error('not primary');
        });
        let error = await handler.addAsync({ user: userId, mailbox: mailboxId, raw: raw(), flags: [] }).catch(err => err);
        expect(error.message).to.equal('not primary');
        expect(await attachmentCounters()).to.equal(0);
    });

    it('keeps the references but fails when it can not tell whether the message was stored', async function () {
        let handler = handlerWith(
            async (collection, doc, options) => {
                await collection.insertOne(doc, options);
                throw writeConcernError();
            },
            async () => {
                throw new Error('still unreachable');
            }
        );
        let error = await handler.addAsync({ user: userId, mailbox: mailboxId, raw: raw(), flags: [] }).catch(err => err);
        expect(error.code).to.equal(64);
        expect(await attachmentCounters()).to.equal(1);
    });
});
