'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { ensureLabels, getRequestedNames, getMessageImapFlags, resolveImapLabels } = require('../lib/label-handler');
const { labelSchema } = require('../lib/schemas');
const { MAX_LABELS } = require('../lib/consts');

function createDatabase(records = []) {
    for (const record of records) {
        record._id = record._id || new ObjectId();
    }
    return {
        records,
        collection() {
            return {
                find({ user, name }) {
                    const names = name?.$in;
                    return {
                        async toArray() {
                            return records.filter(record => record.user.equals(user) && (!names || names.includes(record.name)));
                        }
                    };
                },
                aggregate(pipeline) {
                    const user = pipeline[0].$match.user;
                    return {
                        async toArray() {
                            const userRecords = records.filter(record => record.user.equals(user));
                            if (!userRecords.length) {
                                return [];
                            }
                            const used = new Set(userRecords.map(record => record.slot));
                            let slot = 0;
                            while (used.has(slot) && slot < MAX_LABELS) {
                                slot++;
                            }
                            return [{ count: userRecords.length, slot: slot < MAX_LABELS ? slot : undefined }];
                        }
                    };
                },
                async insertOne(record) {
                    if (records.some(existing => existing.user.equals(record.user) && (existing.name === record.name || existing.slot === record.slot))) {
                        throw Object.assign(new Error('Duplicate'), { code: 11000 });
                    }
                    records.push({ _id: new ObjectId(), ...record });
                }
            };
        }
    };
}

describe('Persistent labels', () => {
    it('exposes stable label ids as IMAP flags without duplicates', () => {
        const first = new ObjectId();
        const second = new ObjectId();
        expect(
            getMessageImapFlags(
                { flags: ['\\Seen', 'Legacy', 'projects/web'], labels: [first, second] },
                new Map([
                    [first.toString(), 'Projects/Web'],
                    [second.toString(), 'Important']
                ])
            )
        ).to.deep.equal(['\\Seen', 'Legacy', 'projects/web', `$wdlabel$${first}`, `$wdlabel$${second}`]);
    });

    it('treats slash as a literal part of a single label name', () => {
        expect(getRequestedNames(['Projects/čau-😀', 'Projects/čau-😀', '\\Seen', '$Forwarded', '\\Recent', '\\Flagged'])).to.deep.equal(['Projects/čau-😀']);
        expect(labelSchema.validate('Projects/čau-😀').error).to.equal(undefined);
        for (const name of ['\\Seen', '$wdlabel$123']) {
            expect(labelSchema.validate(name).error).to.be.instanceOf(Error);
        }
    });

    it('creates one label idempotently without overwriting existing metadata', async () => {
        const user = new ObjectId();
        const db = createDatabase();
        const created = await ensureLabels(db, user, ['A/B', 'A/B'], { metaData: { color: '#123' } });
        expect(created.created).to.deep.equal(['A/B']);
        expect(created.labels.map(record => record.name)).to.deep.equal(['A/B']);
        const first = db.records[0];
        const existing = await ensureLabels(db, user, ['A/B'], { metaData: { color: '#456' } });
        expect(existing.created).to.deep.equal([]);
        expect(existing.labels).to.deep.equal([first]);
        expect(db.records.map(record => record.name)).to.deep.equal(['A/B']);
        expect(first.metaData).to.deep.equal({ color: '#123' });
        expect(db.records[0]).to.equal(first);
    });

    it('accepts 256 characters with no hierarchy depth limit', () => {
        for (const name of ['a'.repeat(256), 'a/b/c/d/e/f']) {
            expect(labelSchema.validate(name).error).to.equal(undefined);
            expect(() => getRequestedNames([name])).to.not.throw();
        }
        for (const name of ['a'.repeat(257)]) {
            expect(labelSchema.validate(name).error).to.be.instanceOf(Error);
            expect(() => getRequestedNames([name])).to.throw();
        }
    });

    it('enforces the cap and permits existing labels at capacity', async () => {
        const user = new ObjectId();
        const db = createDatabase(Array.from({ length: MAX_LABELS }, (_, slot) => ({ user, slot, name: `label-${slot}` })));
        let error;
        try {
            await ensureLabels(db, user, ['new/child']);
        } catch (err) {
            error = err;
        }
        expect(error.code).to.equal('LabelLimitExceeded');
        expect(db.records.length).to.equal(MAX_LABELS);
        await ensureLabels(db, user, ['label-0']);
        expect(db.records.length).to.equal(MAX_LABELS);
        await ensureLabels(db, new ObjectId(), ['other-user']);
        expect(db.records.length).to.equal(MAX_LABELS + 1);
    });

    it('allows only one concurrent writer to claim the last slot', async () => {
        const user = new ObjectId();
        const db = createDatabase(Array.from({ length: MAX_LABELS - 1 }, (_, slot) => ({ user, slot, name: `label-${slot}` })));
        const results = await Promise.allSettled([ensureLabels(db, user, ['first']), ensureLabels(db, user, ['second'])]);
        expect(results.filter(result => result.status === 'fulfilled').length).to.equal(1);
        expect(results.find(result => result.status === 'rejected').reason.code).to.equal('LabelLimitExceeded');
        expect(db.records.length).to.equal(MAX_LABELS);
    });

    it('rejects assigning a name while it is being deleted', async () => {
        const user = new ObjectId();
        const db = createDatabase([{ user, slot: 0, name: 'Projects', deleting: true }]);
        try {
            await ensureLabels(db, user, ['Projects']);
            expect.fail('Expected label deletion error');
        } catch (err) {
            expect(err.code).to.equal('LabelDeleting');
            expect(err.responseCode).to.equal(409);
        }
    });

    it('stores only valid labels owned by the user and keeps other IMAP flags', () => {
        const valid = new ObjectId();
        const foreign = new ObjectId();
        const resolved = resolveImapLabels(
            [`$wdlabel$${valid}`, `$wdlabel$${foreign}`, '$wdlabel$invalid', '$label1', 'Ordinary'],
            [{ _id: valid, name: 'Valid' }]
        );
        expect(resolved.labels.map(id => id.toString())).to.deep.equal([valid.toString()]);
        expect(resolved.flags).to.deep.equal([`$wdlabel$${foreign}`, '$wdlabel$invalid', '$label1', 'Ordinary']);
    });

});
