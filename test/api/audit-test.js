/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
/* globals before: false, after: false */

'use strict';

const crypto = require('crypto');
const util = require('util');
const supertest = require('supertest');
const chai = require('chai');
const { ObjectId } = require('mongodb');

const config = require('@zone-eu/wild-config');
const db = require('../../lib/db');
const AuditHandler = require('../../lib/audit-handler');
const MessageHandler = require('../../lib/message-handler');
const auditTask = util.promisify(require('../../lib/tasks/audit'));

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

describe('Audit API tests', function () {
    this.timeout(20000); // eslint-disable-line no-invalid-this

    let auditHandler;
    let messageHandler;
    let auditAccessToken;
    let auditTokenHash;
    const createdUsers = [];
    const createdAudits = [];

    const connectDatabase = async () => {
        if (db.database && db.redis) {
            return;
        }

        await new Promise((resolve, reject) => db.connect(err => (err ? reject(err) : resolve())));
    };

    const uniqueUsername = prefix => `${prefix}${Date.now()}${Math.random().toString(16).slice(2)}`;

    const createRoleToken = async role => {
        const accessToken = crypto.randomBytes(20).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');
        const tokenData = {
            user: 'root',
            role,
            ttl: 3600,
            created: Date.now().toString()
        };

        tokenData.s = crypto
            .createHmac('sha256', config.api.accessControl.secret)
            .update(
                JSON.stringify({
                    token: accessToken,
                    user: tokenData.user,
                    role: tokenData.role
                })
            )
            .digest('hex');

        await db.redis.multi().hmset(`tn:token:${tokenHash}`, tokenData).expire(`tn:token:${tokenHash}`, Number(tokenData.ttl)).exec();

        return {
            accessToken,
            tokenHash
        };
    };

    const createUser = async prefix => {
        const username = uniqueUsername(prefix);
        const response = await server
            .post('/users')
            .send({
                username,
                password: 'secretvalue',
                address: `${username}@example.com`,
                name: 'audit test user'
            })
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.exist;

        createdUsers.push(response.body.id);

        return response.body.id;
    };

    const getMailbox = async (user, path) => {
        const response = await server.get(`/users/${user}/mailboxes`).expect(200);
        const mailbox = response.body.results.find(entry => entry.path === path);

        expect(mailbox).to.exist;

        return mailbox;
    };

    const createMailbox = async (user, path) => {
        const response = await server.post(`/users/${user}/mailboxes`).send({ path, hidden: false, retention: 0 }).expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.exist;

        const mailboxData = await db.database.collection('mailboxes').findOne({
            _id: new ObjectId(response.body.id)
        });

        expect(mailboxData).to.exist;

        return {
            id: response.body.id,
            path: mailboxData.path
        };
    };

    const createMessage = async (user, mailbox, subject, options) => {
        const response = await server
            .post(`/users/${user}/mailboxes/${mailbox}/messages`)
            .send(
                Object.assign(
                    {
                        draft: false,
                        from: { name: 'Audit Sender', address: 'audit.sender@example.com' },
                        to: [{ name: 'Audit Recipient', address: 'audit.recipient@example.com' }],
                        subject,
                        text: `Body for ${subject}`,
                        date: new Date().toISOString()
                    },
                    options || {}
                )
            )
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.message).to.exist;

        return response.body.message;
    };

    const createAudit = async (user, options) => {
        const response = await server
            .post('/audit')
            .set('X-Access-Token', auditAccessToken)
            .send(
                Object.assign(
                    {
                        user,
                        expires: new Date(Date.now() + 60 * 60 * 1000).toISOString()
                    },
                    options || {}
                )
            )
            .expect(200);

        expect(response.body.success).to.be.true;
        expect(response.body.id).to.exist;

        createdAudits.push(response.body.id);

        return response.body.id;
    };

    const runQueuedAuditTask = async audit => {
        const auditObjectId = new ObjectId(audit);
        const taskData = await db.database.collection('tasks').findOne({
            task: 'audit',
            'data.audit': auditObjectId
        });

        expect(taskData).to.exist;

        const result = await auditTask(
            {
                _id: taskData._id
            },
            taskData.data,
            {
                auditHandler,
                messageHandler
            }
        );

        expect(result).to.be.true;

        await db.database.collection('tasks').deleteOne({
            _id: taskData._id
        });
    };

    const getAuditFiles = async audit =>
        await db.gridfs
            .collection('audit.files')
            .find({
                'metadata.audit': new ObjectId(audit)
            })
            .sort({
                'metadata.subject': 1
            })
            .toArray();

    const getAuditInfo = async audit => await server.get(`/audit/${audit}`).set('X-Access-Token', auditAccessToken).expect(200);

    const expectAuditSubjects = (files, subjects) => {
        expect(files.map(fileData => fileData.metadata.subject).sort()).to.deep.equal(subjects.slice().sort());
    };

    before(async () => {
        await connectDatabase();

        auditHandler = new AuditHandler({
            database: db.database,
            users: db.users,
            gridfs: db.gridfs,
            bucket: 'audit'
        });

        messageHandler = new MessageHandler({
            database: db.database,
            users: db.users,
            redis: db.redis,
            gridfs: db.gridfs,
            attachments: config.attachments
        });

        const tokenData = await createRoleToken('audit');
        auditAccessToken = tokenData.accessToken;
        auditTokenHash = tokenData.tokenHash;
    });

    after(async () => {
        if (!auditTokenHash || !db.redis) {
            return;
        }

        await db.redis.del(`tn:token:${auditTokenHash}`);
    });

    afterEach(async () => {
        while (createdAudits.length) {
            const audit = new ObjectId(createdAudits.pop());

            await db.database.collection('tasks').deleteMany({
                task: 'audit',
                'data.audit': audit
            });

            const auditData = await db.database.collection('audits').findOne({
                _id: audit
            });

            if (auditData) {
                await auditHandler.removeAudit(auditData);
                await db.database.collection('audits').deleteOne({
                    _id: audit
                });
            }
        }

        while (createdUsers.length) {
            const user = createdUsers.pop();
            const response = await server.delete(`/users/${user}`).expect(200);
            expect(response.body.success).to.be.true;
        }
    });

    it('should POST /audit expect success / import existing messages', async () => {
        const user = await createUser('auditgeneral');
        const inbox = await getMailbox(user, 'INBOX');
        const customMailbox = await createMailbox(user, '/audit-general');

        await createMessage(user, inbox.id, 'Audit general live one');
        await createMessage(user, customMailbox.id, 'Audit general live two');

        const audit = await createAudit(user, {
            notes: 'general audit import',
            meta: {
                case: 'general'
            }
        });

        await runQueuedAuditTask(audit);

        const auditInfoResponse = await getAuditInfo(audit);
        expect(auditInfoResponse.body.success).to.be.true;
        expect(auditInfoResponse.body.user).to.equal(user);
        expect(auditInfoResponse.body.notes).to.equal('general audit import');
        expect(auditInfoResponse.body.meta).to.deep.equal({ case: 'general' });
        expect(auditInfoResponse.body.audited).to.equal(2);
        expect(auditInfoResponse.body.import).to.deep.include({
            status: 'imported',
            copied: 2,
            failed: 0
        });

        const files = await getAuditFiles(audit);

        expect(files).to.have.length(2);
        expectAuditSubjects(files, ['Audit general live one', 'Audit general live two']);
        expect(files.every(fileData => fileData.metadata.imported)).to.be.true;
        expect(files.map(fileData => fileData.metadata.mailboxPath).sort()).to.deep.equal([customMailbox.path, inbox.path].sort());
    });

    it('should POST /audit expect success / import retained deleted messages', async () => {
        const user = await createUser('auditdeleted');
        const inbox = await getMailbox(user, 'INBOX');
        const message = await createMessage(user, inbox.id, 'Audit archived deleted message');

        await server.delete(`/users/${user}/mailboxes/${inbox.id}/messages/${message.id}`).expect(200);

        const liveMessage = await db.database.collection('messages').findOne({
            mailbox: new ObjectId(inbox.id),
            uid: message.id
        });

        expect(liveMessage).to.not.exist;

        const archivedMessage = await db.database.collection('archived').findOne({
            user: new ObjectId(user),
            uid: message.id
        });

        expect(archivedMessage).to.exist;
        expect(archivedMessage.subject).to.equal('Audit archived deleted message');

        const audit = await createAudit(user);

        await runQueuedAuditTask(audit);

        const auditInfoResponse = await getAuditInfo(audit);
        expect(auditInfoResponse.body.success).to.be.true;
        expect(auditInfoResponse.body.audited).to.equal(1);
        expect(auditInfoResponse.body.import).to.deep.include({
            status: 'imported',
            copied: 1,
            failed: 0
        });

        const files = await getAuditFiles(audit);

        expect(files).to.have.length(1);
        expectAuditSubjects(files, ['Audit archived deleted message']);
        expect(files[0].metadata.imported).to.be.true;
        expect(files[0].metadata.mailboxPath).to.equal(inbox.path);
    });

    it('should POST /audit expect success / audit messages uploaded after import', async () => {
        const user = await createUser('auditactive');
        const inbox = await getMailbox(user, 'INBOX');
        const audit = await createAudit(user);

        await runQueuedAuditTask(audit);

        const initialAuditInfoResponse = await getAuditInfo(audit);
        expect(initialAuditInfoResponse.body.success).to.be.true;
        expect(initialAuditInfoResponse.body.audited).to.equal(0);
        expect(initialAuditInfoResponse.body.import).to.deep.include({
            status: 'imported',
            copied: 0,
            failed: 0
        });

        await createMessage(user, inbox.id, 'Audit active new message');

        const auditInfoResponse = await getAuditInfo(audit);
        expect(auditInfoResponse.body.success).to.be.true;
        expect(auditInfoResponse.body.audited).to.equal(1);
        expect(auditInfoResponse.body.import).to.deep.include({
            status: 'imported',
            copied: 0,
            failed: 0
        });

        const files = await getAuditFiles(audit);

        expect(files).to.have.length(1);
        expectAuditSubjects(files, ['Audit active new message']);
        expect(files[0].metadata).to.not.have.property('imported');
        expect(files[0].metadata.mailboxPath).to.equal(inbox.path);
    });
});
