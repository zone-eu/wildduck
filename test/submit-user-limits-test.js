'use strict';

const { expect } = require('chai');
const { MongoClient, ObjectId } = require('mongodb');
const registerSubmit = require('../lib/api/submit');

describe('Submission user limits', () => {
    async function submit(userLimits, message = {}) {
        const user = { _id: new ObjectId(), address: 'user@example.com', storageUsed: 0, recipients: 100, ...userLimits };
        let route;
        const client = new MongoClient('mongodb://127.0.0.1:27017');
        const db = {
            senderDb: client.db('unused'),
            users: {
                collection() {
                    return {
                        async findOne(query, { projection }) {
                            return Object.fromEntries(Object.entries(user).filter(([key]) => key === '_id' || projection[key]));
                        }
                    };
                }
            }
        };
        const messageHandler = {
            counters: {
                async asyncTTLCounter() {
                    // Reaching this check proves that the per-message recipient check passed.
                    return { success: false, value: 100, ttl: 60 };
                }
            },
            async addAsync() {
                throw new Error('Rejected messages must not be stored');
            }
        };
        const settings = {
            async getMulti() {
                return { 'const:max:storage': 1024 * 1024, 'const:max:recipients': 100, 'const:max:rcpt_to': 2 };
            }
        };
        registerSubmit(db, { route(value) { route = value; } }, messageHandler, {}, settings);
        const req = {
            role: 'root',
            params: {
                user: user._id.toString(),
                to: [{ address: 'to@example.com' }],
                cc: [{ address: 'cc@example.com' }],
                bcc: [{ address: 'bcc@example.com' }],
                text: 'Test message',
                ...message
            },
            validate() {}
        };
        const reply = {
            status: 200,
            code(status) {
                this.status = status;
                return this;
            },
            send(payload) {
                return { status: this.status, ...payload };
            }
        };
        try {
            return await route.handler(req, reply);
        } finally {
            await client.close();
        }
    }

    it('counts To, Cc and Bcc against the user recipient limit', async () => {
        const result = await submit({ maxRecipientsPerMessage: 2 });
        expect(result).to.include({ status: 403, code: 'TooMany' });
    });

    it('uses an explicit user allowance above the deployment default', async () => {
        const result = await submit({ maxRecipientsPerMessage: 3 });
        expect(result).to.include({ status: 403, code: 'RateLimitedError' });
    });

    it('inherits the deployment recipient limit for missing or zero values', async () => {
        expect(await submit({})).to.include({ status: 403, code: 'TooMany' });
        expect(await submit({ maxRecipientsPerMessage: 0 })).to.include({ status: 403, code: 'TooMany' });
    });

});
