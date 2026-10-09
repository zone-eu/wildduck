/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const { expect } = require('chai');
const { ObjectId, BSON } = require('mongodb');
const { mongopagingFindWrapper, mongopagingAggregateWrapper } = require('../lib/mongopaging-find-wrapper');

describe('mongopagingFindWrapper', function () {
    for (const paginatedField of ['_id', 'idate', 'filename']) {
        it(`should use driver-compatible BSON for next and previous ${paginatedField} cursors`, async function () {
            const rows = [
                { _id: new ObjectId(), idate: new Date('2026-01-03T00:00:00.000Z'), filename: 'a.txt' },
                { _id: new ObjectId(), idate: new Date('2026-01-02T00:00:00.000Z'), filename: 'b.txt' }
            ];
            let reads = 0;
            let queryOptions;
            let projection;
            const collection = {
                find(query, options) {
                    // Exercise the same BSON serialization boundary as the native driver.
                    BSON.serialize(query);
                    reads++;
                    queryOptions = options;
                    return {
                        project(fields) {
                            projection = fields;
                            return this;
                        },
                        sort() {
                            return this;
                        },
                        limit() {
                            return this;
                        },
                        async toArray() {
                            return rows.slice();
                        }
                    };
                }
            };
            const options = { limit: 1, paginatedField, fields: { _id: true, [paginatedField]: true }, maxTimeMS: 1000 };
            const first = await mongopagingFindWrapper(collection, options);
            const nextOptions = { ...options, next: first.nextCursor };
            const second = await mongopagingFindWrapper(collection, nextOptions);
            const previous = await mongopagingFindWrapper(collection, { ...options, previous: second.previousCursor });

            expect(first.nextCursor).to.be.a('string');
            expect(second.previousCursor).to.be.a('string');
            expect(nextOptions.next).to.equal(first.nextCursor);
            expect(options.fields).to.deep.equal({ _id: true, [paginatedField]: true });
            expect(queryOptions).to.deep.equal({ maxTimeMS: 1000 });
            expect(projection).to.deep.equal({ _id: 1, [paginatedField]: 1 });
            for (const listing of [first, second, previous]) {
                expect(listing.listing.results[0]._id).to.be.instanceOf(ObjectId);
                expect(listing.listing.results[0]).to.have.property(paginatedField);
            }
            expect(previous.page).to.equal(1);
            expect(reads).to.equal(3);
        });
    }
});

describe('mongopagingAggregateWrapper', function () {
    it('should return an exact total and a limited page from one faceted aggregation', async function () {
        const rows = [
            { _id: new ObjectId(), idate: new Date('2026-01-03T00:00:00.000Z') },
            { _id: new ObjectId(), idate: new Date('2026-01-02T00:00:00.000Z') },
            { _id: new ObjectId(), idate: new Date('2026-01-01T00:00:00.000Z') }
        ];
        let executedPipeline;

        const collection = {
            aggregate(pipeline) {
                executedPipeline = pipeline;
                return {
                    async toArray() {
                        return [{ total: [{ value: 17 }], results: rows }];
                    }
                };
            }
        };

        const response = await mongopagingAggregateWrapper(collection, {
            pipeline: [{ $match: { searchable: true } }, { $group: { _id: '$thread' } }],
            limit: 2,
            paginatedField: 'idate',
            includeTotal: true
        });

        expect(executedPipeline).to.have.length(3);
        expect(executedPipeline[2]).to.deep.equal({
            $facet: {
                total: [{ $count: 'value' }],
                results: [{ $sort: { idate: -1, _id: -1 } }, { $limit: 3 }]
            }
        });
        expect(response.total).to.equal(17);
        expect(response.listing.results).to.deep.equal(rows.slice(0, 2));
        expect(response.nextCursor).to.be.a('string');
    });

    it('should preserve the existing aggregation pipeline when a total is not requested', async function () {
        const row = { _id: new ObjectId() };
        let executedPipeline;

        const collection = {
            aggregate(pipeline) {
                executedPipeline = pipeline;
                return {
                    async toArray() {
                        return [row];
                    }
                };
            }
        };

        const response = await mongopagingAggregateWrapper(collection, {
            pipeline: [{ $match: { searchable: true } }],
            limit: 2,
            paginatedField: '_id'
        });

        expect(executedPipeline).to.deep.equal([
            { $match: { searchable: true } },
            { $sort: { _id: -1 } },
            { $limit: 3 }
        ]);
        expect(response).to.not.have.property('total');
        expect(response.listing.results).to.deep.equal([row]);
    });
});
