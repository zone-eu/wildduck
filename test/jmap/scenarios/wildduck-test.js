/* eslint no-unused-expressions: 0 */
'use strict';

// Catalogue file wildduck.yaml: backend prerequisites (WDP), service wiring (WDS) and cross
// protocol invariants (WDX).

const { expect } = require('chai');
const { scenario, api, accounts, seed, fixtures, clock } = require('../harness');

const DOC_FIELDS = { projection: { _id: true, root: true, mailbox: true, uid: true, subject: true } };

// The stored message documents of a user (or of the archive), once there are `count` of them
async function messageDocs(user, count, collection = 'messages') {
    const db = await seed.db();
    return clock.waitFor(
        async () => {
            const docs = await db
                .collection(collection)
                .find({ user: new seed.ObjectId(user.id) }, DOC_FIELDS)
                .toArray();
            return docs.length === count && docs;
        },
        { message: `expected ${count} documents in ${collection}` }
    );
}

const rootOf = doc => doc.root.toString();

describe('JMAP backend prerequisites (wildduck.yaml)', () => {
    describe('stable Email ids', () => {
        scenario('WDP-001', async () => {
            const user = await accounts.createUser();
            const boxes = await accounts.mailboxes(user);

            await Promise.all([
                fixtures.buildMessage({ subject: 'delivered over LMTP' }).then(raw => seed.deliver(user.address, raw)),
                fixtures.buildMessage({ subject: 'appended over IMAP' }).then(raw => seed.withImap(user, client => client.append('INBOX', raw))),
                api('POST', `/users/${user.id}/mailboxes/${boxes.INBOX.id}/messages`, { subject: 'uploaded through the API', text: 'Hello' })
            ]);

            const docs = await messageDocs(user, 3);
            for (const doc of docs) {
                expect(doc.root, `root of ${doc._id}`).to.exist;
                expect(rootOf(doc)).to.equal(doc._id.toString());
            }
            expect(new Set(docs.map(rootOf)).size).to.equal(3);
        });
    });
});
