/* eslint no-unused-expressions: 0 */
/* globals before, after */
'use strict';

const { expect } = require('chai');
const { MongoClient } = require('mongodb');
const config = require('@zone-eu/wild-config');
const { SettingsHandler } = require('../lib/settings-handler');
const TaskHandler = require('../lib/task-handler');

describe('MongoDB find-and-modify result metadata compatibility', function () {
    this.timeout(10000); // eslint-disable-line no-invalid-this

    let client;
    let database;
    let wrappedDatabase;
    let settingsHandler;
    let taskHandler;
    const collectionNames = new Set();
    const collectionPrefix = `compat_${process.pid}_${Math.random().toString(16).slice(2)}`;

    before(async () => {
        client = await MongoClient.connect(config.dbs.mongo, { serverSelectionTimeoutMS: 2000 });
        database = client.db(config.dbs.dbname);
        wrappedDatabase = {
            collection(name) {
                const prefixedName = `${collectionPrefix}_${name}`;
                collectionNames.add(prefixedName);
                return database.collection(prefixedName);
            }
        };
        settingsHandler = new SettingsHandler({ db: wrappedDatabase });
        taskHandler = new TaskHandler({ database: wrappedDatabase });
    });

    after(async () => {
        if (database) {
            for (const name of collectionNames) {
                await database.collection(name).drop().catch(err => {
                    if (err.codeName !== 'NamespaceNotFound') {
                        throw err;
                    }
                });
            }
        }
        if (client) {
            await client.close();
        }
    });

    it('returns the stored setting value after an upsert', async () => {
        const value = { enabled: true, limit: 23 };
        const result = await settingsHandler.set(`${collectionPrefix}:setting`, value);

        expect(result).to.equal(JSON.stringify(value));
        expect(await settingsHandler.get(`${collectionPrefix}:setting`)).to.deep.equal(value);
    });

    it('reports task creation and reuse and retrieves the task with getNext', async () => {
        const matchQuery = { key: collectionPrefix };
        const data = { ...matchQuery, payload: 'metadata-check' };
        const created = await taskHandler.ensure(`${collectionPrefix}:task`, matchQuery, data);
        const existing = await taskHandler.ensure(`${collectionPrefix}:task`, matchQuery, data);

        expect(created.existing).to.equal(false);
        expect(existing.existing).to.equal(true);
        expect(existing.task).to.deep.equal(created.task);

        const next = await taskHandler.getNext();
        expect(next.data).to.deep.equal(data);
        expect(next.task._id).to.deep.equal(created.task);
        await taskHandler.release(next.task, true);
    });
});
