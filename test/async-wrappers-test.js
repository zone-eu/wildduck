/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const assert = require('assert');
const chai = require('chai');
const MailboxHandler = require('../lib/mailbox-handler');
const MessageHandler = require('../lib/message-handler');
const ImapNotifier = require('../lib/imap-notifier');
const Maildropper = require('../lib/maildropper');
const UserCache = require('../lib/user-cache');
const { PassThrough, Readable } = require('stream');

const expect = chai.expect;

// The handlers are implemented with async methods, the callback methods wrap them for
// the callers that still use callbacks (IMAP command handlers, the delivery plugins).
// These tests stub the async methods, so no database is needed
describe('Handler callback wrappers', function () {
    const failure = new Error('expected failure');

    const rejectsWith = (promise, err) => assert.rejects(promise, error => error === err);

    // calls a node style method and resolves with the callback arguments
    const callbackArgs = (fn, ...args) => new Promise(resolve => fn(...args, (...result) => resolve(result)));

    describe('MailboxHandler', () => {
        const handler = Object.create(MailboxHandler.prototype);

        it('update() reports the status, mailbox id and update result', async () => {
            const updateResult = { updated: true, changes: { retention: true } };
            handler.updateAsync = async (user, mailbox, updates) => {
                expect(updates).to.deep.equal({ retention: 10 });
                return { status: true, mailbox, updateResult };
            };

            expect(await callbackArgs(handler.update.bind(handler), 'user', 'mailbox', { retention: 10 })).to.deep.equal([null, true, 'mailbox', updateResult]);
        });

        it('update() reports the error', async () => {
            handler.updateAsync = async () => {
                throw failure;
            };
            expect(await callbackArgs(handler.update.bind(handler), 'user', 'mailbox', {})).to.deep.equal([failure]);
        });

        it('del() reports the status and the mailbox id', async () => {
            handler.delAsync = async () => true;
            expect(await callbackArgs(handler.del.bind(handler), 'user', 'mailbox')).to.deep.equal([null, true, 'mailbox']);
        });

        it('rename() reports the status, mailbox id and update result', async () => {
            handler.renameAsync = async (user, mailbox, newname) => ({ status: true, mailbox, updateResult: { updated: true, changes: {}, path: newname } });
            expect(await callbackArgs(handler.rename.bind(handler), 'user', 'mailbox', 'new/path', false)).to.deep.equal([
                null,
                true,
                'mailbox',
                { updated: true, changes: {}, path: 'new/path' }
            ]);
        });
    });

    describe('MessageHandler', () => {
        const handler = Object.create(MessageHandler.prototype);

        it('put() reports the stored location', async () => {
            handler.putAsync = async messageData => ({ mailbox: 'mailbox', message: messageData.id, uid: 1 });
            expect(await callbackArgs(handler.put.bind(handler), { id: 'message' })).to.deep.equal([null, { mailbox: 'mailbox', message: 'message', uid: 1 }]);
        });

        it('put() reports the error', async () => {
            handler.putAsync = async () => {
                throw failure;
            };
            expect(await callbackArgs(handler.put.bind(handler), {})).to.deep.equal([failure]);
        });

        it('update() reports the updated count', async () => {
            handler.updateAsync = async (user, mailbox, messageQuery, changes) => {
                expect(changes).to.deep.equal({ seen: true });
                return 3;
            };
            expect(await callbackArgs(handler.update.bind(handler), 'user', 'mailbox', 1, { seen: true })).to.deep.equal([null, 3]);
        });

        it('flagReferencedMessage() ignores an unknown action', async () => {
            expect(await handler.flagReferencedMessage('user', { action: 'bounce', mailbox: 'mailbox', id: 1 })).to.be.false;
            expect(await handler.flagReferencedMessage('user', null)).to.be.false;
        });
    });

    describe('ImapNotifier', () => {
        const notifier = Object.create(ImapNotifier.prototype);

        it('addEntries() reports the stored entry count', async () => {
            notifier.addEntriesAsync = async (mailbox, entries) => entries.length;
            expect(await callbackArgs(notifier.addEntries.bind(notifier), 'mailbox', [{ command: 'EXISTS' }, { command: 'FETCH' }])).to.deep.equal([null, 2]);
        });

        it('addEntries() reports the error', async () => {
            notifier.addEntriesAsync = async () => {
                throw failure;
            };
            expect(await callbackArgs(notifier.addEntries.bind(notifier), 'mailbox', [])).to.deep.equal([failure]);
        });

        it('addEntriesAsync() resolves with false when there is nothing to store', async () => {
            const real = Object.create(ImapNotifier.prototype);
            expect(await real.addEntriesAsync('mailbox', [])).to.be.false;
            expect(await real.addEntriesAsync('mailbox', null)).to.be.false;
        });
    });

    describe('UserCache', () => {
        const cache = Object.create(UserCache.prototype);

        it('get() reports the cached value', async () => {
            cache.getAsync = async (user, key) => (key === 'quota' ? 1024 : undefined);
            expect(await callbackArgs(cache.get.bind(cache), 'user', 'quota', 0)).to.deep.equal([null, 1024]);
        });

        it('getAsync() falls back to a system setting', async () => {
            const real = Object.create(UserCache.prototype);
            real.redis = { hget: async () => null };
            real.users = { collection: () => ({ findOne: async () => ({ _id: 'user' }) }) };
            real.settingsHandler = { get: async key => (key === 'const:max:storage' ? 2048 : undefined) };
            expect(await real.getAsync('user', 'quota', { setting: 'const:max:storage' })).to.equal(2048);
            expect(await real.getAsync('user', 'quota', 512)).to.equal(512);
        });

        it('getAsync() caches a stored value', async () => {
            const real = Object.create(UserCache.prototype);
            let stored;
            real.redis = {
                hget: async () => null,
                multi: () => ({
                    hset: (key, field, value) => {
                        stored = { key, field, value };
                        return { expire: () => ({ exec: async () => [] }) };
                    }
                })
            };
            real.users = { collection: () => ({ findOne: async () => ({ _id: 'user', quota: 4096 }) }) };
            expect(await real.getAsync('user', 'quota', 0)).to.equal(4096);
            expect(stored).to.deep.equal({ key: 'cached:user', field: 'quota', value: 4096 });
        });
    });

    describe('Maildropper', () => {
        const maildrop = Object.create(Maildropper.prototype);

        it('pushStream pipes the source into the queue stream and resolves with the envelope', async () => {
            let received = [];
            let pushOptions;

            maildrop.push = (options, callback) => {
                pushOptions = options;
                let message = new PassThrough();
                message.on('data', chunk => received.push(chunk));
                message.on('end', () => callback(null, { id: 'queue-id', to: options.to }));
                return message;
            };

            const envelope = await maildrop.pushStream(
                { to: ['recipient@example.com'] },
                Readable.from(Buffer.from('Subject: test\r\n\r\nbody'), { objectMode: false })
            );

            expect(pushOptions.to).to.deep.equal(['recipient@example.com']);
            expect(envelope).to.deep.equal({ id: 'queue-id', to: ['recipient@example.com'] });
            expect(Buffer.concat(received).toString()).to.equal('Subject: test\r\n\r\nbody');
        });

        it('pushStream accepts a Buffer source', async () => {
            let received = [];
            maildrop.push = (options, callback) => {
                let message = new PassThrough();
                message.on('data', chunk => received.push(chunk));
                message.on('end', () => callback(null, { id: 'queue-id' }));
                return message;
            };

            expect(await maildrop.pushStream({ to: ['recipient@example.com'] }, Buffer.from('body'))).to.deep.equal({ id: 'queue-id' });
            expect(Buffer.concat(received).toString()).to.equal('body');
        });

        it('pushStream rejects with a normalised error when the message is not accepted', async () => {
            maildrop.push = (options, callback) => {
                let err = new Error('rejected by plugin');
                err.name = 'SMTPReject';
                setImmediate(() => callback(err));
                return false;
            };

            let err = await maildrop.pushStream({ to: [] }, Buffer.from('body')).catch(error => error);
            expect(err.message).to.equal('rejected by plugin');
            expect(err.code).to.equal('MessageRejected');
            expect(err.responseCode).to.equal(500);
        });

        it('pushStream keeps the code and status of the push error', async () => {
            maildrop.push = (options, callback) => {
                let err = new Error('No valid recipients');
                err.code = 'ENORECIPIENTS';
                err.responseCode = 400;
                setImmediate(() => callback(err));
                return false;
            };

            let err = await maildrop.pushStream({ to: [] }, Buffer.from('body')).catch(error => error);
            expect(err.code).to.equal('ENORECIPIENTS');
            expect(err.responseCode).to.equal(400);
        });

        it('pushStream forwards source stream errors to the queue stream', async () => {
            let message = new PassThrough();
            maildrop.push = (options, callback) => {
                message.once('error', err => callback(err));
                return message;
            };

            let source = new PassThrough();
            let pending = maildrop.pushStream({ to: ['recipient@example.com'] }, source);
            source.write('partial');
            source.destroy(failure);

            await rejectsWith(pending, failure);
        });
    });
});
