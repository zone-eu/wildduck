/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const consts = require('../lib/consts');
const tools = require('../lib/tools');

const createRedis = ({ changeVersionOnFirstStore = false } = {}) => {
    let version = 0;
    let stores = 0;
    const values = new Map();

    return {
        values,
        get stores() {
            return stores;
        },
        async get(key) {
            if (key.endsWith(':version')) {
                return version ? String(version) : null;
            }
            return values.has(key) ? values.get(key) : null;
        },
        async setversionedvalue(versionKey, cacheKey, expectedVersion, value) {
            stores++;
            if (changeVersionOnFirstStore && stores === 1) {
                version++;
            }
            if (String(version) !== expectedVersion) {
                return 0;
            }
            values.set(cacheKey, value);
            return 1;
        },
        multi() {
            return {
                sadd() {
                    return this;
                },
                expire() {
                    return this;
                },
                exec() {
                    return Promise.resolve([]);
                }
            };
        }
    };
};

describe('Account counter tools', () => {
    it('retries a label count when its account version changes during initialization', async () => {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const label = new ObjectId();
        const redis = createRedis({ changeVersionOnFirstStore: true });
        let counts = 0;
        const db = {
            redis,
            database: {
                collection(name) {
                    if (name === 'mailboxes') {
                        return {
                            find() {
                                return {
                                    async toArray() {
                                        return [{ _id: mailbox }];
                                    }
                                };
                            }
                        };
                    }
                    if (name === 'labels') {
                        return {
                            async findOne(query) {
                                expect(query).to.deep.equal({ user, name: 'project', deleting: { $ne: true } });
                                return { _id: label };
                            }
                        };
                    }
                    return {
                        async countDocuments(query, options) {
                            counts++;
                            expect(query).to.deep.equal({ mailbox: { $in: [mailbox] }, labels: label });
                            expect(options.maxTimeMS).to.equal(consts.DB_MAX_TIME_MESSAGES_SEARCH);
                            return 1;
                        }
                    };
                }
            }
        };

        expect(await tools.getLabelCounter(db, user, 'project')).to.equal(1);
        expect(counts).to.equal(2);
        expect(redis.stores).to.equal(2);
    });

    it('lists persistent empty labels without touching messages or Redis', async () => {
        const user = new ObjectId();
        const id = new ObjectId();
        const db = {
            database: {
                collection(name) {
                    expect(name).to.equal('labels');
                    return {
                        find(query) {
                            expect(query).to.deep.equal({ user, deleting: { $ne: true } });
                            return {
                                sort() {
                                    return this;
                                },
                                async toArray() {
                                    return [{ _id: id, name: 'Projects/2026', metaData: { color: 'blue' } }];
                                }
                            };
                        }
                    };
                }
            }
        };

        expect(await tools.getUserLabels(db, user)).to.deep.equal([
            { id: id.toString(), name: 'Projects/2026', metaData: { color: 'blue' } }
        ]);
    });

    it('loads all label counters with one mailbox lookup and one aggregate', async () => {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const labels = [
            { _id: new ObjectId(), name: 'Finance' },
            { _id: new ObjectId(), name: 'Work Projects' }
        ];
        let mailboxLookups = 0;
        let aggregates = 0;
        const db = {
            redis: createRedis(),
            database: {
                collection(name) {
                    if (name === 'labels') {
                        return {
                            find() {
                                return {
                                    sort() {
                                        return this;
                                    },
                                    async toArray() {
                                        return labels;
                                    }
                                };
                            }
                        };
                    }
                    if (name === 'mailboxes') {
                        return {
                            find() {
                                mailboxLookups++;
                                return {
                                    async toArray() {
                                        return [{ _id: mailbox }];
                                    }
                                };
                            }
                        };
                    }
                    expect(name).to.equal('messages');
                    return {
                        aggregate(pipeline, options) {
                            aggregates++;
                            expect(pipeline[0]).to.deep.equal({
                                $match: { mailbox: { $in: [mailbox] }, labels: { $in: labels.map(label => label._id) } }
                            });
                            expect(options.maxTimeMS).to.equal(consts.DB_MAX_TIME_MESSAGES_SEARCH);
                            return {
                                async toArray() {
                                    return [{ _id: labels[0]._id, total: 3, unseen: 2 }];
                                }
                            };
                        }
                    };
                }
            }
        };

        expect(await tools.getUserLabels(db, user, true)).to.deep.equal([
            { id: labels[0]._id.toString(), name: 'Finance', metaData: undefined, total: 3, unseen: 2 },
            { id: labels[1]._id.toString(), name: 'Work Projects', metaData: undefined, total: 0, unseen: 0 }
        ]);
        expect(mailboxLookups).to.equal(1);
        expect(aggregates).to.equal(1);
    });
});
