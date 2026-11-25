/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before: false, after: false */

'use strict';

const supertest = require('supertest');
const chai = require('chai');
const { ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const db = require('../lib/db');
const testClient = require('../imap-core/test/test-client');
const { connect, uniqueName } = require('./api/_helpers');

const expect = chai.expect;
chai.config.includeStack = true;

const server = supertest.agent(`http://127.0.0.1:${config.api.port}`);

// Runs against a server started with ACL disabled, the default configuration of existing
// deployments (the acl-off targets in Gruntfile.js): sharing must leave no trace there
describe('ACL disabled', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    const owner = { username: uniqueName('acloffowner'), password: 'secretpass' };
    const grantee = { username: uniqueName('acloffgrantee'), password: 'secretpass' };
    let ownerInbox;

    const imap = (user, commands) =>
        new Promise(resolve => {
            let cmds = [`T0 LOGIN ${user.username} ${user.password}`, ...commands, 'T9 LOGOUT'];
            testClient({ commands: cmds, secure: true, port: config.imap.port }, resp => resolve(resp.toString()));
        });

    before(async () => {
        for (let user of [owner, grantee]) {
            const response = await server
                .post('/users')
                .send({ username: user.username, password: user.password, address: `${user.username}@example.com` })
                .expect(200);
            user.id = response.body.id;
        }

        const response = await server.get(`/users/${owner.id}/mailboxes`).expect(200);
        ownerInbox = response.body.results.find(mailboxData => mailboxData.path === 'INBOX').id;
    });

    after(async () => {
        for (let user of [owner, grantee]) {
            if (user.id) {
                await server.delete(`/users/${user.id}`).expect(200);
            }
        }
    });

    it('should not advertise the ACL capability', async () => {
        const resp = await imap(owner, ['T1 CAPABILITY']);
        const capabilities = resp.split('\r\n').find(line => line.indexOf('* CAPABILITY ') === 0);
        expect(capabilities.split(' ')).to.not.include('ACL');
        expect(capabilities.split(' ')).to.not.include('RIGHTS=kxte');
    });

    it('should announce the personal namespace only', async () => {
        const resp = await imap(owner, ['T1 NAMESPACE']);
        expect(resp.indexOf('* NAMESPACE (("" "/")) NIL NIL') >= 0).to.be.true;
    });

    it('should refuse the ACL commands', async () => {
        const resp = await imap(owner, ['T1 GETACL INBOX', 'T2 MYRIGHTS INBOX', `T3 SETACL INBOX ${grantee.username} lr`]);
        expect(/^T1 NO /m.test(resp)).to.be.true;
        expect(/^T2 NO /m.test(resp)).to.be.true;
        expect(/^T3 NO /m.test(resp)).to.be.true;
    });

    it('should treat the namespace prefixes as personal folder names', async () => {
        const resp = await imap(owner, ['T1 CREATE "Other Users/notes"', 'T2 SELECT "Other Users/notes"', 'T3 LIST "" "*"']);
        expect(/^T1 OK/m.test(resp)).to.be.true;
        expect(/^T2 OK/m.test(resp)).to.be.true;
        expect(resp.indexOf('"Other Users/notes"') >= 0).to.be.true;
    });

    it('should leave stored grants dormant', async () => {
        // a grant stored while ACL was enabled stays in the database but must not resolve
        await connect();
        await db.database.collection('acls').insertOne({
            type: 'mailbox',
            resource: new ObjectId(ownerInbox),
            owner: new ObjectId(owner.id),
            user: new ObjectId(grantee.id),
            rights: 'lrs',
            subscribed: true,
            created: new Date()
        });

        const resp = await imap(grantee, ['T1 LIST "" "*"', `T2 SELECT "Other Users/${owner.username}/INBOX"`]);
        expect(resp.indexOf(owner.username) < 0).to.be.true;
        expect(/^T2 NO \[NONEXISTENT\]/m.test(resp)).to.be.true;
    });

    it('should PUT /users/{user}/mailboxes/{mailbox}/acl expect failure / ACL disabled', async () => {
        await server.put(`/users/${owner.id}/mailboxes/${ownerInbox}/acl`).send({ identifier: grantee.username, rights: 'lr' }).expect(404);
        await server.get('/domaingroups').expect(404);
    });
});
