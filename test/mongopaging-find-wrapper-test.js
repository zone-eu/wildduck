/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const { mongopagingAggregateWrapper } = require('../lib/mongopaging-find-wrapper');

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
