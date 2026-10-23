/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const ImapNotifier = require('../lib/imap-notifier');

describe('ImapNotifier account counters', () => {
    it('loads tracked labels without scanning Redis when a mailbox is deleted', async () => {
        const user = new ObjectId();
        const entry = {
            command: 'DELETE',
            user
        };
        const testNotifier = Object.create(ImapNotifier.prototype);

        testNotifier.redis = {
            async smembers(key) {
                expect(key).to.equal(`account-counters:{${user}}:labels`);
                return ['project', 'čau'];
            }
        };

        await testNotifier.prepareAccountCounterInvalidations([entry]);
        expect(entry.counterLabels).to.have.members(['project', 'čau']);
        expect(entry.flaggedCounterInvalidated).to.be.true;
    });

    it('tracks API labels without treating IMAP flags as labels', async () => {
        const user = new ObjectId();
        const operations = [];
        const testNotifier = Object.create(ImapNotifier.prototype);

        testNotifier.redis = {
            async set(key, value, mode, ttl) {
                operations.push(['set', key, value, mode, ttl]);
            },
            multi() {
                return {
                    sadd(key, ...labels) {
                        operations.push(['sadd', key, labels]);
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
                addedLabels: ['added'],
                removedLabels: ['removed']
            }
        ]);

        expect(operations[0]).to.deep.equal(['sadd', `account-counters:{${user}}:labels`, ['added', 'removed']]);
        expect(
            operations.some(
                operation =>
                    operation[0] === 'set' && operation[1] === `account-counters:{${user}}:version` && operation[3] === 'EX' && operation[4] > 0
            )
        ).to.be.true;
    });

    it('invalidates account counters for mailbox membership and message flag updates', async () => {
        const user = new ObjectId();

        for (const entry of [
            { command: 'EXISTS', user },
            { command: 'EXPUNGE', user },
            { command: 'DELETE', user },
            { command: 'FETCH', user, flags: [] }
        ]) {
            const versions = [];
            const testNotifier = Object.create(ImapNotifier.prototype);
            testNotifier.redis = {
                async set(key, value, mode, ttl) {
                    versions.push({ key, mode, ttl });
                },
                multi() {
                    return {
                        sadd() {
                            return this;
                        },
                        expire() {
                            return this;
                        },
                        async exec() {
                            return [];
                        }
                    };
                }
            };

            await testNotifier.updateAccountCounters([entry]);
            expect(versions).to.have.length(1);
            expect(versions[0].key).to.equal(`account-counters:{${user}}:version`);
            expect(versions[0].mode).to.equal('EX');
            expect(versions[0].ttl).to.be.greaterThan(0);
        }
    });
});
