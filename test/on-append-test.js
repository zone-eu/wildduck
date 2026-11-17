/* eslint-env mocha */
/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { ObjectId } = require('mongodb');
const db = require('../lib/db');
const onAppend = require('../lib/handlers/on-append');

describe('APPEND TLS verification results', () => {
    let usersSnapshot;
    let addOptions;
    let append;
    let session;

    beforeEach(() => {
        usersSnapshot = db.users;
        addOptions = null;
        session = {
            id: 'append-tls-test',
            user: { id: new ObjectId(), address: 'user@example.com' },
            remoteAddress: '127.0.0.1'
        };
        db.users = {
            collection(name) {
                expect(name).to.equal('users');
                return {
                    async findOne() {
                        return { _id: session.user.id, storageUsed: 0 };
                    }
                };
            }
        };
        append = onAppend(
            { logger: { debug() {} }, loggelf() {} },
            {
                counters: {
                    async asyncTTLCounter() {
                        return { success: true };
                    }
                },
                async addAsync(options) {
                    addOptions = options;
                    return { status: true, data: { uid: 1 } };
                }
            },
            {
                async getAsync() {
                    return 0;
                }
            }
        );
    });

    afterEach(() => {
        db.users = usersSnapshot;
    });

    const appendMessage = () =>
        new Promise((resolve, reject) => {
            append('INBOX', [], null, Buffer.from('Subject: test\r\n\r\nbody'), session, (err, status, info) => {
                if (err) {
                    return reject(err);
                }
                expect(status).to.be.true;
                expect(info).to.deep.equal({ uid: 1 });
                resolve();
            });
        });

    it('stores a TLS result without implying SPF, DKIM or DMARC verification', async () => {
        session.secure = true;
        await appendMessage();

        expect(addOptions.verificationResults).to.deep.equal({ tls: true });
    });

    it('does not add verification results for a plaintext APPEND', async () => {
        session.secure = false;
        await appendMessage();

        expect(addOptions.verificationResults).to.be.false;
    });

    it('does not assume TLS when the session has no TLS status', async () => {
        await appendMessage();

        expect(addOptions.verificationResults).to.be.false;
    });
});
