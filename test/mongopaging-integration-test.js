/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
/* globals before, after */
'use strict';

const { expect } = require('chai');
const { MongoClient, ObjectId, Long } = require('mongodb');
const config = require('@zone-eu/wild-config');
const { mongopagingFindWrapper } = require('../lib/mongopaging-find-wrapper');

describe('Cursor pagination with the native MongoDB driver', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this
    let client;
    let collection;
    let findCommand;
    const user = new ObjectId();
    const marker = Long.fromString('9007199254740993');
    const rows = Array.from({ length: 5 }, (_, index) => ({
        _id: new ObjectId(),
        user,
        marker,
        idate: new Date('2026-01-01T00:00:00Z'),
        nested: { date: new Date('2026-01-01T00:00:00Z') },
        name: `entry-${index}`,
        metaData: { $oid: 'literal metadata', $date: 'literal date' },
        secret: 'excluded'
    }));

    before(async () => {
        client = await MongoClient.connect(config.dbs.mongo, { serverSelectionTimeoutMS: 2000, monitorCommands: true });
        collection = client.db().collection(`pagination-test-${new ObjectId()}`);
        client.on('commandStarted', event => {
            if (event.commandName === 'find' && event.command.find === collection.collectionName) {
                findCommand = event.command;
            }
        });
        await collection.insertMany([...rows, { _id: new ObjectId(), user: new ObjectId(), name: 'other user' }]);
    });

    after(async () => {
        try {
            if (collection) {
                await collection.drop();
            }
        } finally {
            if (client) {
                await client.close();
            }
        }
    });

    for (const paginatedField of ['_id', 'idate', 'name', 'nested.date']) {
        for (const sortAscending of [true, false]) {
            it(`should traverse ${paginatedField} ${sortAscending ? 'ascending' : 'descending'} and return to the first page`, async () => {
                const options = {
                    query: { user, marker },
                    fields: { _id: true, name: true, metaData: true },
                    findOptions: { maxTimeMS: 1000 },
                    paginatedField,
                    sortAscending,
                    limit: 2
                };
                const expected = sortAscending ? rows : rows.slice().reverse();
                const first = await mongopagingFindWrapper(collection, { ...options });
                expect(first.page).to.equal(1);
                expect(first.previousCursor).to.equal(false);
                expect(first.listing.results.map(row => row._id.toString())).to.deep.equal(expected.slice(0, 2).map(row => row._id.toString()));
                expect(first.listing.results[0]).not.to.have.property('secret');
                expect(first.listing.results[0]._id).to.be.instanceOf(ObjectId);
                expect(first.listing.results[0].metaData).to.deep.equal(rows[0].metaData);
                if (paginatedField === 'idate') {
                    expect(first.listing.results[0].idate).to.be.instanceOf(Date);
                }
                expect(findCommand.maxTimeMS).to.equal(1000);
                expect(findCommand.projection).not.to.have.property('projection');
                expect(findCommand.projection).not.to.have.property('maxTimeMS');

                const second = await mongopagingFindWrapper(collection, { ...options, next: first.nextCursor });
                expect(second.page).to.equal(2);
                expect(second.listing.results.map(row => row._id.toString())).to.deep.equal(expected.slice(2, 4).map(row => row._id.toString()));

                const last = await mongopagingFindWrapper(collection, { ...options, next: second.nextCursor });
                expect(last.page).to.equal(3);
                expect(last.nextCursor).to.equal(false);
                expect(last.listing.results.map(row => row._id.toString())).to.deep.equal(expected.slice(4).map(row => row._id.toString()));

                const previous = await mongopagingFindWrapper(collection, { ...options, previous: second.previousCursor });
                expect(previous.page).to.equal(1);
                expect(previous.previousCursor).to.equal(false);
                expect(previous.listing.results).to.deep.equal(first.listing.results);
            });
        }
    }
});
