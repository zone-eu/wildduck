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
    it('retries a keyword count when its account version changes during initialization', async () => {
        const user = new ObjectId();
        const mailbox = new ObjectId();
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
                    return {
                        async countDocuments(query, options) {
                            counts++;
                            expect(query).to.deep.equal({ mailbox: { $in: [mailbox] }, flags: 'project' });
                            expect(options.maxTimeMS).to.equal(consts.DB_MAX_TIME_MESSAGES_SEARCH);
                            return 1;
                        }
                    };
                }
            }
        };

        expect(await tools.getKeywordCounter(db, user, 'project')).to.equal(1);
        expect(counts).to.equal(2);
        expect(redis.stores).to.equal(2);
    });

    it('targets current mailboxes and treats reserved flags as literals when listing keywords', async () => {
        const user = new ObjectId();
        const mailbox = new ObjectId();
        const redis = createRedis();
        let aggregation;
        let aggregationOptions;
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
                    return {
                        aggregate(pipeline, options) {
                            aggregation = pipeline;
                            aggregationOptions = options;
                            return {
                            async toArray() {
                                return aggregation[3].$group.total
                                    ? [{ keyword: 'project', total: 2, unseen: 1 }]
                                    : [{ keyword: 'project' }];
                                }
                            };
                        }
                    };
                }
            }
        };

        expect(await tools.getUserKeywords(db, user)).to.deep.equal([{ keyword: 'project', total: 2, unseen: 1 }]);
        expect(aggregation[0]).to.deep.equal({ $match: { mailbox: { $in: [mailbox] } } });
        expect(aggregation[1].$project.flags.$filter.cond.$not.$in[1]).to.deep.equal({ $literal: [...consts.SYSTEM_FLAGS] });
        expect(aggregationOptions).to.deep.equal({ allowDiskUse: false, maxTimeMS: consts.DB_MAX_TIME_MESSAGES_SEARCH });

        expect(await tools.getUserKeywords(db, user, false)).to.deep.equal([{ keyword: 'project' }]);
        expect(aggregation[3]).to.deep.equal({ $group: { _id: '$flags' } });
    });
});
