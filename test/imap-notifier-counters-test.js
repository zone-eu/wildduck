/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const ImapNotifier = require('../lib/imap-notifier');

describe('ImapNotifier custom counters', () => {
    const notifier = Object.create(ImapNotifier.prototype);

    it('counts a keyword added while a message becomes unseen once', () => {
        const deltas = notifier.collectKeywordDeltas([
            {
                command: 'FETCH',
                flags: ['$Label'],
                addedKeywords: ['$Label'],
                unseenChange: true
            }
        ]);

        expect(deltas.get('$Label')).to.deep.equal({ total: 1, unseen: 1 });
    });

    it('removes the old unseen keyword count when a message becomes seen', () => {
        const deltas = notifier.collectKeywordDeltas([
            {
                command: 'FETCH',
                flags: ['\\Seen'],
                removedKeywords: ['$Label'],
                unseenChange: true
            }
        ]);

        expect(deltas.get('$Label')).to.deep.equal({ total: -1, unseen: -1 });
    });

    it('counts a flag added while a message becomes unseen once', () => {
        const delta = notifier.collectFlaggedDelta([
            {
                command: 'FETCH',
                flags: ['\\Flagged'],
                flaggedChangedTo: true,
                unseenChange: true
            }
        ]);

        expect(delta).to.deep.equal({ total: 1, unseen: 1 });
    });

    it('removes the old unseen flag count when a message becomes seen', () => {
        const delta = notifier.collectFlaggedDelta([
            {
                command: 'FETCH',
                flags: ['\\Seen'],
                flaggedChangedTo: false,
                unseenChange: true
            }
        ]);

        expect(delta).to.deep.equal({ total: -1, unseen: -1 });
    });

    it('records and invalidates cached account counters when a mailbox is deleted', async () => {
        const user = new ObjectId();
        const userKey = user.toString();
        const entry = {
            command: 'DELETE',
            user
        };
        const deleted = [];
        const testNotifier = Object.create(ImapNotifier.prototype);

        testNotifier.redis = {
            async scan(cursor, command, pattern) {
                expect(cursor).to.equal('0');
                expect(command).to.equal('MATCH');

                if (pattern === `kw:total:${userKey}:*`) {
                    return ['0', [`kw:total:${userKey}:project`, `kw:total:${userKey}:čau`]];
                }
                expect(pattern).to.equal(`kw:unseen:${userKey}:*`);
                return ['0', [`kw:unseen:${userKey}:project`]];
            },
            async del(...keys) {
                deleted.push(keys);
            }
        };

        await testNotifier.prepareAccountCounterInvalidations([entry]);
        expect(entry.counterKeywords).to.have.members(['project', 'čau']);
        expect(entry.flaggedCounterInvalidated).to.be.true;

        await testNotifier.updateKeywordCounters([entry]);
        await testNotifier.updateFlaggedCounters([entry]);

        expect(deleted[0]).to.have.members([
            `kw:total:${userKey}:project`,
            `kw:unseen:${userKey}:project`,
            `kw:total:${userKey}:čau`,
            `kw:unseen:${userKey}:čau`
        ]);
        expect(deleted[1]).to.deep.equal([`fl:total:${userKey}`, `fl:unseen:${userKey}`]);
    });
});
