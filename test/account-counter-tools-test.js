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
        const keyword = new ObjectId();
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
                    if (name === 'keywords') {
                        return {
                            async findOne(query) {
                                expect(query).to.deep.equal({ user, path: 'project', deleting: { $ne: true } });
                                return { _id: keyword };
                            }
                        };
                    }
                    return {
                        async countDocuments(query, options) {
                            counts++;
                            expect(query).to.deep.equal({ mailbox: { $in: [mailbox] }, keywords: keyword });
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

    it('lists persistent empty keyword paths without touching messages or Redis', async () => {
        const user = new ObjectId();
        const id = new ObjectId();
        const db = {
            database: {
                collection(name) {
                    expect(name).to.equal('keywords');
                    return {
                        find(query) {
                            expect(query).to.deep.equal({ user, deleting: { $ne: true } });
                            return {
                                sort() {
                                    return this;
                                },
                                async toArray() {
                                    return [{ _id: id, path: 'Projects/2026' }];
                                }
                            };
                        }
                    };
                }
            }
        };

        expect(await tools.getUserKeywords(db, user)).to.deep.equal([
            { id: id.toString(), keyword: '2026', path: 'Projects/2026' }
        ]);
    });
});
