/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const ImapNotifier = require('../lib/imap-notifier');

describe('ImapNotifier account counters', () => {
    it('loads tracked keywords without scanning Redis when a mailbox is deleted', async () => {
        const user = new ObjectId();
        const entry = {
            command: 'DELETE',
            user
        };
        const testNotifier = Object.create(ImapNotifier.prototype);

        testNotifier.redis = {
            async smembers(key) {
                expect(key).to.equal(`account-counters:{${user}}:keywords`);
                return ['project', 'čau'];
            }
        };

        await testNotifier.prepareAccountCounterInvalidations([entry]);
        expect(entry.counterKeywords).to.have.members(['project', 'čau']);
        expect(entry.flaggedCounterInvalidated).to.be.true;
    });

    it('tracks changed keywords and advances the account counter version', async () => {
        const user = new ObjectId();
        const operations = [];
        const testNotifier = Object.create(ImapNotifier.prototype);

        testNotifier.redis = {
            async set(key, value, mode, ttl) {
                operations.push(['set', key, value, mode, ttl]);
            },
            multi() {
                return {
                    sadd(key, ...keywords) {
                        operations.push(['sadd', key, keywords]);
                        return this;
                    },
                    expire(key, ttl) {
                        operations.push(['expire', key, ttl]);
                        return this;
                    },
                    async exec() {
                        return [];
                    }
                };
            }
        };

        await testNotifier.updateAccountCounters([
            {
                command: 'FETCH',
                user,
                flags: ['\\Seen', 'current'],
                addedKeywords: ['added'],
                removedKeywords: ['removed']
            }
        ]);

        expect(operations[0]).to.deep.equal(['sadd', `account-counters:{${user}}:keywords`, ['current', 'added', 'removed']]);
        expect(
            operations.some(
                operation =>
                    operation[0] === 'set' && operation[1] === `account-counters:{${user}}:version` && operation[3] === 'EX' && operation[4] > 0
            )
        ).to.be.true;
    });
});
