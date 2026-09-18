'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { ensureKeywords, expandPaths, getMessageImapFlags } = require('../lib/keyword-handler');
const { keywordSchema } = require('../lib/schemas');
const { MAX_KEYWORDS } = require('../lib/consts');

function createDatabase(records = []) {
    for (const record of records) {
        record._id = record._id || new ObjectId();
    }
    return {
        records,
        collection() {
            return {
                find({ user, path }) {
                    const paths = path?.$in;
                    return {
                        async toArray() {
                            return records.filter(record => record.user.equals(user) && (!paths || paths.includes(record.path)));
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
                            while (used.has(slot) && slot < MAX_KEYWORDS) {
                                slot++;
                            }
                            return [{ count: userRecords.length, slot: slot < MAX_KEYWORDS ? slot : undefined }];
                        }
                    };
                },
                async insertOne(record) {
                    if (records.some(existing => existing.user.equals(record.user) && (existing.path === record.path || existing.slot === record.slot))) {
                        throw Object.assign(new Error('Duplicate'), { code: 11000 });
                    }
                    records.push({ _id: new ObjectId(), ...record });
                }
            };
        }
    };
}

describe('Persistent keywords', () => {
    it('merges stable keyword paths into IMAP flags without duplicates', () => {
        const first = new ObjectId();
        const second = new ObjectId();
        expect(
            getMessageImapFlags(
                { flags: ['\\Seen', 'Legacy', 'projects/web'], keywords: [first, second] },
                new Map([
                    [first.toString(), 'Projects/Web'],
                    [second.toString(), 'Important']
                ])
            )
        ).to.deep.equal(['\\Seen', 'Legacy', 'projects/web', 'Important']);
    });

    it('expands nested paths while excluding system flags', () => {
        expect(expandPaths(['Projects/čau-😀', 'Projects/čau-😀', '\\Seen', '$Forwarded', '\\Recent', '\\Flagged'])).to.deep.equal([
            'Projects/čau-😀',
            'Projects'
        ]);
        expect(keywordSchema.validate('Projects/čau-😀').error).to.equal(undefined);
        for (const path of ['/Projects', 'Projects/', 'Projects//child', '\\Seen']) {
            expect(keywordSchema.validate(path).error).to.be.instanceOf(Error);
        }
    });

    it('creates parent paths idempotently without overwriting existing metadata', async () => {
        const user = new ObjectId();
        const db = createDatabase();
        const created = await ensureKeywords(db, user, ['A/B', 'A/B']);
        expect(created.created).to.deep.equal(['A/B', 'A']);
        expect(created.keywords.map(record => record.path)).to.deep.equal(['A/B']);
        const first = db.records[0];
        const existing = await ensureKeywords(db, user, ['A/B']);
        expect(existing.created).to.deep.equal([]);
        expect(existing.keywords).to.deep.equal([first]);
        expect(db.records.map(record => record.path)).to.deep.equal(['A/B', 'A']);
        expect(db.records[0]).to.equal(first);
    });

    it('accepts 256 characters and five levels, rejecting the next character or level', () => {
        for (const path of ['a'.repeat(256), 'a/b/c/d/e']) {
            expect(keywordSchema.validate(path).error).to.equal(undefined);
            expect(() => expandPaths([path])).to.not.throw();
        }
        for (const path of ['a'.repeat(257), 'a/b/c/d/e/f']) {
            expect(keywordSchema.validate(path).error).to.be.instanceOf(Error);
            expect(() => expandPaths([path])).to.throw();
        }
    });

    it('counts parent paths toward the cap and permits existing labels at capacity', async () => {
        const user = new ObjectId();
        const db = createDatabase(Array.from({ length: MAX_KEYWORDS - 1 }, (_, slot) => ({ user, slot, path: `label-${slot}` })));
        let error;
        try {
            await ensureKeywords(db, user, ['new/child']);
        } catch (err) {
            error = err;
        }
        expect(error.code).to.equal('KeywordLimitExceeded');
        expect(db.records.length).to.equal(MAX_KEYWORDS);
        await ensureKeywords(db, user, ['label-0']);
        expect(db.records.length).to.equal(MAX_KEYWORDS);
        await ensureKeywords(db, new ObjectId(), ['other-user']);
        expect(db.records.length).to.equal(MAX_KEYWORDS + 1);
    });

    it('allows only one concurrent writer to claim the last slot', async () => {
        const user = new ObjectId();
        const db = createDatabase(Array.from({ length: MAX_KEYWORDS - 1 }, (_, slot) => ({ user, slot, path: `label-${slot}` })));
        const results = await Promise.allSettled([ensureKeywords(db, user, ['first']), ensureKeywords(db, user, ['second'])]);
        expect(results.filter(result => result.status === 'fulfilled').length).to.equal(1);
        expect(results.find(result => result.status === 'rejected').reason.code).to.equal('KeywordLimitExceeded');
        expect(db.records.length).to.equal(MAX_KEYWORDS);
    });

    it('rejects assigning a path while it is being deleted', async () => {
        const user = new ObjectId();
        const db = createDatabase([{ user, slot: 0, path: 'Projects', deleting: true }]);
        try {
            await ensureKeywords(db, user, ['Projects']);
            expect.fail('Expected keyword deletion error');
        } catch (err) {
            expect(err.code).to.equal('KeywordDeleting');
            expect(err.responseCode).to.equal(409);
        }
    });

});
