/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
/* globals before: false */
'use strict';

// Deleting a message releases its attachment references unless the message is archived, also when its
// mailbox is gone: the garbage collector deletes the messages of deleted users and mailboxes that way.

const crypto = require('crypto');
const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const db = require('../lib/db');
const MessageHandler = require('../lib/message-handler');

describe('Deleting a message', function () {
    this.timeout(30000);

    let userId;
    let mailboxId;
    let bucket;
    let handler;

    before(async function () {
        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
    });

    beforeEach(async function () {
        userId = new ObjectId();
        mailboxId = new ObjectId();
        bucket = `attdelete${crypto.randomBytes(4).toString('hex')}`;
        await db.users.collection('users').insertOne({ _id: userId, username: `delete-${userId}`, storageUsed: 0, quota: 0 });
        await db.database
            .collection('mailboxes')
            .insertOne({ _id: mailboxId, user: userId, path: 'INBOX', uidValidity: 1, uidNext: 1, modifyIndex: 0, subscribed: true, flags: [] });
        handler = new MessageHandler({
            database: db.database,
            users: db.users,
            gridfs: db.gridfs,
            redis: db.redis,
            attachments: { type: 'gridstore', bucket }
        });
    });

    afterEach(async function () {
        await db.users.collection('users').deleteOne({ _id: userId });
        await db.database.collection('mailboxes').deleteOne({ _id: mailboxId });
        await db.database.collection('messages').deleteMany({ mailbox: mailboxId });
        await db.database.collection('archived').deleteMany({ mailbox: mailboxId });
        for (let suffix of ['files', 'chunks']) {
            await db.gridfs
                .collection(`${bucket}.${suffix}`)
                .drop()
                .catch(() => false);
        }
    });

    function raw() {
        let attachment = crypto.randomBytes(2000).toString('base64').replace(/.{76}/g, '$&\r\n');
        return Buffer.from(
            'From: a@example.com\r\nTo: b@example.com\r\nSubject: delete\r\nMIME-Version: 1.0\r\n' +
                'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n' +
                '--b\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
                attachment +
                '\r\n--b--\r\n'
        );
    }

    // stores a message with one attachment and returns it as the garbage collector reads it
    async function store() {
        await handler.addAsync({ user: userId, mailbox: mailboxId, raw: raw(), flags: [] });
        let messageData = await db.database.collection('messages').findOne({ mailbox: mailboxId });
        expect(Object.keys(messageData.mimeTree.attachmentMap)).to.have.lengthOf(1);
        expect(await references()).to.deep.equal({ c: 1, m: messageData.magic });
        return messageData;
    }

    async function references() {
        let file = await db.gridfs.collection(`${bucket}.files`).findOne({});
        return file && { c: file.metadata.c, m: file.metadata.m };
    }

    it('releases the attachments of a message in a mailbox', async function () {
        let messageData = await store();
        expect(await handler.delAsync({ messageData, archive: false })).to.be.true;
        expect(await references()).to.deep.equal({ c: 0, m: 0 });
    });

    it('releases the attachments of a message whose mailbox is gone', async function () {
        let messageData = await store();
        // what user-delete and mailbox deletion leave for the garbage collector
        await db.database.collection('mailboxes').deleteOne({ _id: mailboxId });
        expect(await handler.delAsync({ messageData, archive: false })).to.be.true;
        expect(await db.database.collection('messages').countDocuments({ _id: messageData._id })).to.equal(0);
        expect(await references()).to.deep.equal({ c: 0, m: 0 });
    });

    it('keeps the attachments of an archived message whose mailbox is gone', async function () {
        let messageData = await store();
        await db.database.collection('mailboxes').deleteOne({ _id: mailboxId });
        expect(await handler.delAsync({ messageData, archive: true })).to.be.true;
        expect(await db.database.collection('archived').countDocuments({ _id: messageData._id })).to.equal(1);
        expect(await references()).to.deep.equal({ c: 1, m: messageData.magic });
    });

    it('releases nothing when the message was already deleted', async function () {
        let messageData = await store();
        await db.database.collection('mailboxes').deleteOne({ _id: mailboxId });
        expect(await handler.delAsync({ messageData, archive: false })).to.be.true;
        expect(await handler.delAsync({ messageData, archive: false })).to.be.false;
        expect(await references()).to.deep.equal({ c: 0, m: 0 });
    });
});
