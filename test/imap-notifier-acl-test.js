/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const ImapNotifier = require('../lib/imap-notifier');

// notifier over a stubbed acls collection that counts queries and records who was notified
function createNotifier(grants) {
    const notifier = Object.create(ImapNotifier.prototype);
    const queries = { findOne: 0, find: 0 };
    const fired = [];

    notifier._aclOwners = new Map();
    notifier._aclOwnersCleared = Date.now();
    notifier.fire = user => fired.push(user.toString());
    notifier.database = {
        collection() {
            return {
                async findOne(query) {
                    queries.findOne++;
                    return grants.find(aclData => aclData.owner.equals(query.owner)) || null;
                },
                find(query) {
                    queries.find++;
                    const [folder, account] = query.$or;
                    const matched = grants.filter(aclData =>
                        aclData.resource ? aclData.resource.equals(folder.resource) : aclData.owner.equals(account.owner)
                    );
                    return {
                        project() {
                            return this;
                        },
                        async toArray() {
                            return matched;
                        }
                    };
                }
            };
        }
    };

    return { notifier, queries, fired };
}

// fireForMailbox does not wait for the fan-out, the stubbed queries settle within a tick
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('ImapNotifier ACL fan-out', () => {
    it('queries an owner who shares nothing once per cache window', async () => {
        const owner = new ObjectId();
        const mailboxData = { _id: new ObjectId(), user: owner };
        const { notifier, queries, fired } = createNotifier([]);

        notifier.fireForMailbox(mailboxData);
        await settle();
        notifier.fireForMailbox(mailboxData);
        await settle();

        expect(fired).to.deep.equal([owner.toString(), owner.toString()]);
        expect(queries).to.deep.equal({ findOne: 1, find: 0 });

        // once the window has passed the answer is looked up again
        notifier._aclOwnersCleared -= 31 * 1000;
        notifier.fireForMailbox(mailboxData);
        await settle();

        expect(queries).to.deep.equal({ findOne: 2, find: 0 });
    });

    it('notifies the grantees of an owner who shares', async () => {
        const owner = new ObjectId();
        const grantee = new ObjectId();
        const mailboxData = { _id: new ObjectId(), user: owner };
        const { notifier, queries, fired } = createNotifier([{ resource: null, owner, user: grantee }]);

        notifier.fireForMailbox(mailboxData);
        await settle();
        notifier.fireForMailbox(mailboxData);
        await settle();

        expect(fired).to.deep.equal([owner.toString(), grantee.toString(), owner.toString(), grantee.toString()]);
        expect(queries).to.deep.equal({ findOne: 1, find: 2 });
    });
});
