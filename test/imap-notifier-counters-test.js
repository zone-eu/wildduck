'use strict';

const { expect } = require('chai');
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
});
