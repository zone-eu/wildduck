'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { ensureKeywords, expandPaths } = require('../lib/keyword-handler');
const { keywordPathSchema } = require('../lib/schemas/request/keywords-schemas');
const { MAX_KEYWORDS } = require('../lib/consts');

function createDatabase(records = []) {
    return {
        records,
        collection() {
            return {
                find({ user, path }) {
                    return { async toArray() { return records.filter(record => record.user.equals(user) && (!path || path.$in.includes(record.path))); } };
                },
                async insertOne(record) {
                    if (records.some(existing => existing.user.equals(record.user) && (existing.path === record.path || existing.slot === record.slot))) {
                        throw Object.assign(new Error('Duplicate'), { code: 11000 });
                    }
                    records.push(record);
                }
            };
        }
    };
}

describe('Persistent keywords', () => {
    it('expands nested paths while excluding system flags', () => {
        expect(expandPaths(['Projects/čau-😀', 'Projects/čau-😀', '\\Seen', '$Forwarded', '\\Recent', '\\Flagged'])).to.deep.equal([
            'Projects/čau-😀',
            'Projects'
        ]);
        expect(keywordPathSchema.validate('Projects/čau-😀').error).to.equal(undefined);
        for (const path of ['/Projects', 'Projects/', 'Projects//child', '\\Seen']) {
            expect(keywordPathSchema.validate(path).error).to.be.instanceOf(Error);
        }
    });

    it('creates parent paths idempotently without overwriting existing metadata', async () => {
        const user = new ObjectId();
        const db = createDatabase();
        expect(await ensureKeywords(db, user, ['A/B', 'A/B'])).to.deep.equal({ created: ['A/B', 'A'] });
        const first = db.records[0];
        expect(await ensureKeywords(db, user, ['A/B'])).to.deep.equal({ created: [] });
        expect(db.records.map(record => record.path)).to.deep.equal(['A/B', 'A']);
        expect(db.records[0]).to.equal(first);
    });

    it('accepts 256 characters and five levels, rejecting the next character or level', () => {
        for (const path of ['a'.repeat(256), 'a/b/c/d/e']) {
            expect(keywordPathSchema.validate(path).error).to.equal(undefined);
            expect(() => expandPaths([path])).to.not.throw();
        }
        for (const path of ['a'.repeat(257), 'a/b/c/d/e/f']) {
            expect(keywordPathSchema.validate(path).error).to.be.instanceOf(Error);
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
        expect(db.records.length).to.equal(MAX_KEYWORDS - 1);
        await ensureKeywords(db, user, ['last']);
        await ensureKeywords(db, user, ['last']);
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
});
