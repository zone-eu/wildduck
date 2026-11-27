/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { checkName, MailboxTree } = require('../../../lib/jmap/types/mailbox-set');
const { SetError } = require('../../../lib/jmap/set-errors');

function rejects(name) {
    try {
        checkName(name);
    } catch (err) {
        expect(err).to.be.instanceOf(SetError);
        expect(err.toSetError()).to.deep.include({ type: 'invalidProperties', properties: ['name'] });
        return;
    }
    throw new Error(`${JSON.stringify(name)} was accepted`);
}

const doc = (path, extra = {}) => Object.assign({ _id: new ObjectId(), user: new ObjectId(), path }, extra);
const jmapId = entry => `F${entry._id}`;

describe('JMAP Mailbox/set helpers', () => {
    describe('checkName', () => {
        it('accepts ordinary and Unicode names unchanged', () => {
            for (const name of ['Projects', 'My Folder', ' padded ', 'Entwürfe', '日本語', 'I feel ☺ 😀', '(leading paren']) {
                expect(checkName(name)).to.equal(name);
            }
        });

        it('normalises to NFC', () => {
            expect(checkName('Cafe\u0301')).to.equal('Caf\u00e9');
        });

        it('rejects names that are not strings, blank, or hold control characters or the delimiter', () => {
            for (const name of [undefined, null, 42, {}, '', '   ', '\t', 'a/b', '/a', 'a/', 'a\u0000b', 'a\nb', 'a\u007fb', 'a\u0085b', 'a\u2028b']) {
                rejects(name);
            }
        });

        it('limits the name to 512 UTF-8 octets', () => {
            expect(checkName('x'.repeat(512))).to.have.length(512);
            rejects('x'.repeat(513));
            expect(checkName('日'.repeat(170))).to.have.length(170);
            rejects('日'.repeat(171));
        });
    });

    describe('MailboxTree', () => {
        it('derives parents over missing and hidden ancestors', () => {
            const a = doc('A');
            const hidden = doc('A/H', { hidden: true });
            const deep = doc('A/B/C');
            const underHidden = doc('A/H/X');
            const tree = new MailboxTree([a, hidden, deep, underHidden]);
            const entry = id => tree.visible(jmapId(id));
            expect(tree.parentOf(entry(deep))).to.equal(entry(a));
            expect(tree.nameOf(entry(deep))).to.equal('B/C');
            expect(tree.parentOf(entry(underHidden))).to.equal(entry(a));
            expect(tree.nameOf(entry(underHidden))).to.equal('H/X');
            expect(tree.visible(jmapId(hidden))).to.equal(null);
            expect(tree.visible('malformed')).to.equal(null);
            expect(
                tree
                    .children(entry(a))
                    .map(child => child.path)
                    .sort()
            ).to.deep.equal(['A/B/C', 'A/H/X']);
        });

        it('moves descendants, hidden ones included, on rename', () => {
            const a = doc('A');
            const b = doc('A/B');
            const hidden = doc('A/B/H', { hidden: true });
            const other = doc('AB');
            const tree = new MailboxTree([a, b, hidden, other]);
            tree.rename(tree.visible(jmapId(a)), 'Z');
            expect([...tree.byPath.keys()].sort()).to.deep.equal(['AB', 'Z', 'Z/B', 'Z/B/H']);
            expect(tree.byPath.get('Z/B/H')._id).to.equal(hidden._id);
        });

        it('forgets removed mailboxes', () => {
            const a = doc('A');
            const tree = new MailboxTree([a]);
            tree.remove(tree.visible(jmapId(a)));
            expect(tree.visible(jmapId(a))).to.equal(null);
            expect(tree.byPath.size).to.equal(0);
        });
    });
});
