/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const assert = require('assert');
const chai = require('chai');
const MailboxHandler = require('../lib/mailbox-handler');
const MessageHandler = require('../lib/message-handler');
const ImapNotifier = require('../lib/imap-notifier');
const Maildropper = require('../lib/maildropper');
const { PassThrough, Readable } = require('stream');

const expect = chai.expect;

// The promise variants wrap the callback implementations of the handlers. These
// tests stub the callback methods, so no database is needed
describe('Handler promise wrappers', function () {
    const failure = new Error('expected failure');

    const rejectsWith = (promise, err) => assert.rejects(promise, error => error === err);

    describe('MailboxHandler', () => {
        const handler = Object.create(MailboxHandler.prototype);

        it('updateAsync resolves with the status, mailbox id and update result', async () => {
            const updateResult = { updated: true, changes: { retention: true } };
            handler.update = (user, mailbox, updates, callback) => {
                expect(updates).to.deep.equal({ retention: 10 });
                callback(null, true, mailbox, updateResult);
            };

            expect(await handler.updateAsync('user', 'mailbox', { retention: 10 })).to.deep.equal({ status: true, mailbox: 'mailbox', updateResult });
        });

        it('updateAsync rejects with the callback error', async () => {
            handler.update = (user, mailbox, updates, callback) => callback(failure, 'NONEXISTENT');
            await rejectsWith(handler.updateAsync('user', 'mailbox', {}), failure);
        });

        it('delAsync resolves with the deletion status', async () => {
            handler.del = (user, mailbox, callback) => callback(null, true, mailbox);
            expect(await handler.delAsync('user', 'mailbox')).to.equal(true);
        });

        it('delAsync rejects with the callback error', async () => {
            handler.del = (user, mailbox, callback) => callback(failure, 'CANNOT');
            await rejectsWith(handler.delAsync('user', 'mailbox'), failure);
        });
    });

    describe('MessageHandler', () => {
        const handler = Object.create(MessageHandler.prototype);

        it('putAsync resolves with the put result', async () => {
            handler.put = (messageData, callback) => callback(null, { stored: messageData.id });
            expect(await handler.putAsync({ id: 'message' })).to.deep.equal({ stored: 'message' });
        });

        it('putAsync rejects with the callback error', async () => {
            handler.put = (messageData, callback) => callback(failure);
            await rejectsWith(handler.putAsync({}), failure);
        });

        it('updateAsync resolves with the updated count', async () => {
            handler.update = (user, mailbox, messageQuery, changes, callback) => {
                expect(changes).to.deep.equal({ seen: true });
                callback(null, 3);
            };
            expect(await handler.updateAsync('user', 'mailbox', 1, { seen: true })).to.equal(3);
        });

        it('updateAsync rejects with the callback error', async () => {
            handler.update = (user, mailbox, messageQuery, changes, callback) => callback(failure);
            await rejectsWith(handler.updateAsync('user', 'mailbox', 1, {}), failure);
        });
    });

    describe('ImapNotifier', () => {
        const notifier = Object.create(ImapNotifier.prototype);

        it('addEntriesAsync resolves with the stored entry count', async () => {
            notifier.addEntries = (mailbox, entries, callback) => callback(null, entries.length);
            expect(await notifier.addEntriesAsync('mailbox', [{ command: 'EXISTS' }, { command: 'FETCH' }])).to.equal(2);
        });

        it('addEntriesAsync rejects with the callback error', async () => {
            notifier.addEntries = (mailbox, entries, callback) => callback(failure);
            await rejectsWith(notifier.addEntriesAsync('mailbox', []), failure);
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

        it('pushStream rejects when the message is not accepted', async () => {
            maildrop.push = (options, callback) => {
                setImmediate(() => callback(failure));
                return false;
            };

            await rejectsWith(maildrop.pushStream({ to: [] }, Readable.from(Buffer.from('body'), { objectMode: false })), failure);
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
