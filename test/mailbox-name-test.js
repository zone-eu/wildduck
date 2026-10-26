'use strict';

const assert = require('assert');
const MailboxHandler = require('../lib/mailbox-handler');
const UserHandler = require('../lib/user-handler');
const createCommand = require('../imap-core/lib/commands/create');
const renameCommand = require('../imap-core/lib/commands/rename');
const imapTools = require('../imap-core/lib/imap-tools');

describe('Mailbox name sanitization', () => {
    function createHandler(existingPath) {
        const entries = [];
        const journals = [];
        const handler = Object.create(MailboxHandler.prototype);
        handler.users = { collection: () => ({ findOne: async () => ({ retention: 0 }) }) };
        handler.database = {
            collection: () => ({
                findOne: async query => (query.path === existingPath ? { path: existingPath } : null),
                countDocuments: async () => 0,
                insertOne: async entry => {
                    entries.push(entry);
                    return { insertedId: entry._id };
                }
            })
        };
        handler.settingsHandler = { get: async () => 100 };
        handler.notifier = {
            addEntriesAsync: async (mailbox, entry) => journals.push(entry),
            fire: () => false
        };
        return { handler, entries, journals };
    }

    it('sanitizes direct creation before storage and notifications', async () => {
        const { handler, entries, journals } = createHandler();
        await handler.createAsync('user', 'Parent/Ch\r\ni\tld\u0085\u2028\u2029', {});
        assert.strictEqual(entries[0].path, 'Parent/Child');
        assert.strictEqual(journals[0].path, 'Parent/Child');
    });

    it('checks create collisions using the sanitized path', async () => {
        const { handler, entries } = createHandler('Taken');
        await assert.rejects(handler.createAsync('user', 'Ta\r\nken', {}), { code: 'ALREADYEXISTS' });
        assert.strictEqual(entries.length, 0);
    });

    it('rejects empty names and empty hierarchy components after sanitization', async () => {
        const { handler, entries } = createHandler();
        for (const path of ['\r\n\t\u0085\u2028\u2029', 'Parent/\r/Child']) {
            await assert.rejects(handler.createAsync('user', path, {}), { code: 'CANNOT', responseCode: 400 });
            await assert.rejects(handler.renameAsync('user', 'mailbox', path, {}), { code: 'CANNOT', responseCode: 400 });
            await assert.rejects(handler.updateAsync('user', 'mailbox', { path }), { code: 'CANNOT', responseCode: 400 });
        }
        assert.strictEqual(entries.length, 0);
    });

    it('checks rename collisions using the sanitized path', async () => {
        const { handler } = createHandler();
        handler.database.collection = () => ({
            findOne: async query => (query._id ? { path: 'Original', user: 'user' } : query.path === 'Taken' ? { path: 'Taken' } : null)
        });
        await assert.rejects(handler.renameAsync('user', 'mailbox', 'Ta\rken', {}), { code: 'ALREADYEXISTS' });
    });

    it('passes the sanitized rename path to parent and child updates', async () => {
        const { handler } = createHandler();
        const children = [];
        handler.database.collection = () => ({ findOne: async query => (query._id ? { path: 'Original', user: 'user' } : null) });
        handler.resolveRenamedChildren = async (mailbox, path) => {
            assert.strictEqual(path, 'Parent/Child');
            return children;
        };
        handler.renameMailboxEntry = async (mailbox, path) => {
            assert.strictEqual(path, 'Parent/Child');
            return { status: true };
        };
        handler.renameChildren = async value => assert.strictEqual(value, children);
        assert.deepStrictEqual(await handler.renameAsync('user', 'mailbox', 'Parent/Ch\ni\u009fld', {}), { status: true });
    });

    it('treats an update to the same sanitized path as unchanged', async () => {
        const { handler } = createHandler();
        handler.database.collection = () => ({ findOne: async () => ({ path: 'Original' }) });
        const result = await handler.updateAsync('user', 'mailbox', { path: 'Ori\rginal' });
        assert.strictEqual(result.updateResult.updated, false);
    });

    it('sanitizes default mailbox names for library callers', () => {
        const handler = Object.create(UserHandler.prototype);
        const mailboxes = handler.getMailboxes('en', { '\\Sent': 'Se\r\nnt', '\\Trash': '\t\u0085' });
        assert.strictEqual(mailboxes.find(mailbox => mailbox.specialUse === '\\Sent').path, 'Sent');
        assert.strictEqual(mailboxes.find(mailbox => mailbox.specialUse === '\\Trash').path, 'Trash');
    });

    for (const utf8 of [true, false]) {
        for (const command of [createCommand, renameCommand]) {
            it(`rejects a control-only ${command === createCommand ? 'CREATE' : 'RENAME'} name in ${utf8 ? 'UTF-8' : 'modified UTF-7'} mode`, async () => {
                const value = utf8 ? '\u0085\u2028' : imapTools.utf7encode('\u0085\u2028');
                const attributes = [{ value: Buffer.from(value).toString('binary') }];
                if (command === renameCommand) {
                    attributes.unshift({ value: 'Original' });
                }
                const connection = {
                    acceptUTF8Enabled: utf8,
                    _server: {
                        onCreate: () => assert.fail('must not create an empty mailbox'),
                        onRename: () => assert.fail('must not rename to an empty mailbox')
                    }
                };
                const response = await new Promise((resolve, reject) => {
                    command.handler.call(connection, { attributes }, (err, result) => (err ? reject(err) : resolve(result)));
                });
                assert.strictEqual(response.response, 'NO');
                assert.strictEqual(response.code, 'CANNOT');
            });
        }
    }
});
