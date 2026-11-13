'use strict';

const { expect } = require('chai');
const { z } = require('zod');
const registerMessageTools = require('../lib/mcp-message-tools');

const MAILBOX = '507f1f77bcf86cd799439012';
const LABEL = '507f1f77bcf86cd799439013';
const QUEUE = '1234567890abcdef12';
const ACTION = { READ: 'read', WRITE: 'write', DESTRUCTIVE: 'destructive', SEND: 'send' };

function setup() {
    const tools = new Map();
    const calls = [];
    const reader = {
        async mailboxId(reference) {
            calls.push(['mailboxId', reference]);

            return MAILBOX;
        }
    };

    for (const method of ['get', 'post', 'put', 'delete', 'download']) {
        reader[method] = async (...args) => {
            calls.push([method, ...args]);

            return method === 'download'
                ? { encoding: 'base64', data: 'AAE=', contentType: 'application/octet-stream', offset: args[1].offset, returnedBytes: 2, hasMore: true }
                : { success: true };
        };
    }

    registerMessageTools({
        tool(name, action, config, handler) {
            tools.set(name, { action, config, handler });
        },
        run: async (name, action) => action(),
        reader,
        z,
        ACTION,
        mailboxRef: z.string().min(1).max(1024),
        uidRef: z.number().int().positive()
    });

    const invoke = (name, values) => {
        const tool = tools.get(name);

        return tool.handler(tool.config.inputSchema.parse(values));
    };

    return { tools, calls, invoke };
}

describe('MCP message operations', () => {
    it('resolves mailbox paths through the bound reader and dispatches distinct update endpoints', async () => {
        const { invoke, calls } = setup();

        await invoke('update_message', { mailbox: 'Projects/Invoices', message: 12, seen: true, addLabels: [LABEL] });
        await invoke('update_messages', { mailbox: 'INBOX', message: '12:20', flagged: false });

        expect(calls).to.deep.equal([
            ['mailboxId', 'Projects/Invoices'],
            ['put', `/mailboxes/${MAILBOX}/messages/12`, { seen: true, addLabels: [LABEL] }],
            ['mailboxId', 'INBOX'],
            ['put', `/mailboxes/${MAILBOX}/messages`, { message: '12:20', flagged: false }]
        ]);
    });

    it('rejects another account, unsafe selectors, conflicting label changes and unknown updates', () => {
        const { tools } = setup();
        const single = tools.get('update_message').config.inputSchema;
        const bulk = tools.get('update_messages').config.inputSchema;
        const valid = { mailbox: 'INBOX', message: 1 };

        for (const invalid of [
            { ...valid, user: LABEL },
            { ...valid, labels: [], addLabels: [LABEL] },
            { ...valid, removeLabels: [LABEL], labels: [] },
            { ...valid, send: true },
            { ...valid, moveTo: '../../users' },
            { ...valid, message: '../submit' }
        ]) {
            expect(single.safeParse(invalid).success).to.equal(false);
        }

        expect(bulk.safeParse({ mailbox: 'INBOX', message: '1:*/submit' }).success).to.equal(false);
        expect(bulk.safeParse({ mailbox: 'INBOX', message: '1,2,3', labels: [] }).success).to.equal(true);
        expect(single.safeParse({ ...valid, addLabels: ['Invoices 2027'] }).success).to.equal(true);
    });

    it('passes explicit search actions without allowing combined deletion actions', async () => {
        const { invoke, tools, calls } = setup();
        const args = { search: { mailbox: MAILBOX, seen: true, subject: 'Invoices' }, action: { moveTo: LABEL, seen: false } };

        await invoke('apply_message_search', args);

        expect(calls).to.deep.equal([['post', '/search', { ...args.search, action: args.action }]]);

        const schema = tools.get('apply_message_search').config.inputSchema;

        expect(schema.safeParse({ search: {}, action: {} }).success).to.equal(false);
        expect(schema.safeParse({ search: {}, action: { delete: true, seen: true } }).success).to.equal(false);
        expect(schema.safeParse({ search: { seen: false }, action: { delete: true } }).success).to.equal(false);
        expect(schema.safeParse({ search: {}, action: { delete: true } }).success).to.equal(true);
    });

    it('uses query parameters for deletion and marks destructive operations', async () => {
        const { invoke, tools, calls } = setup();

        await invoke('delete_message', { mailbox: 'INBOX', message: 5, updateThread: true });
        await invoke('empty_mailbox', { mailbox: 'Trash', async: true, skipArchive: false });

        expect(calls.filter(call => call[0] === 'delete')).to.deep.equal([
            ['delete', `/mailboxes/${MAILBOX}/messages/5`, { updateThread: true }],
            ['delete', `/mailboxes/${MAILBOX}/messages`, { async: true, skipArchive: false }]
        ]);
        expect(tools.get('delete_message').action).to.equal(ACTION.DESTRUCTIVE);
        expect(tools.get('empty_mailbox').action).to.equal(ACTION.DESTRUCTIVE);
    });

    it('creates a draft without sending and supports binary attachments and replacement', async () => {
        const { invoke, tools, calls } = setup();
        const args = {
            mailbox: 'Drafts',
            to: [{ address: 'alice@example.com' }],
            text: 'Draft text',
            attachments: [{ filename: 'binary.dat', content: 'AAE=', encoding: 'base64' }],
            replacePrevious: { id: 9 }
        };

        await invoke('create_draft', args);

        const { mailbox, ...body } = args;

        expect(calls[1]).to.deep.equal(['post', `/mailboxes/${MAILBOX}/messages`, { ...body, draft: true }]);
        expect(calls[0]).to.deep.equal(['mailboxId', mailbox]);

        const schema = tools.get('create_draft').config.inputSchema;

        expect(schema.safeParse({ ...args, draft: false }).success).to.equal(false);
        expect(schema.safeParse({ ...args, files: [LABEL] }).success).to.equal(false);
        expect(schema.safeParse({ ...args, raw: 'invalid base64' }).success).to.equal(false);
        expect(schema.safeParse({ ...args, reference: { mailbox: '../users', id: 1, action: 'reply' } }).success).to.equal(false);
        expect(schema.safeParse({ ...args, headers: [{ key: 'X-Header\r\nTo', value: 'oops' }] }).success).to.equal(false);
    });

    it('uploads raw messages without a submission route or forced draft flag', async () => {
        const { invoke, calls } = setup();

        await invoke('upload_message', { mailbox: 'INBOX', raw: 'AAE=', draft: false });

        expect(calls[1]).to.deep.equal(['post', `/mailboxes/${MAILBOX}/messages`, { raw: 'AAE=', draft: false }]);
    });

    it('marks submission, forwarding and delivery rescheduling as sends', async () => {
        const { invoke, tools, calls } = setup();
        const sendTime = '2027-01-01T10:00:00Z';

        await invoke('send_draft', { mailbox: 'Drafts', message: 3, sendTime });
        await invoke('forward_message', { mailbox: 'INBOX', message: 7, addresses: ['alice@example.com'] });
        await invoke('update_outbound_message', { queueId: QUEUE, sendTime });

        expect(calls.filter(call => call[0] !== 'mailboxId')).to.deep.equal([
            ['post', `/mailboxes/${MAILBOX}/messages/3/submit`, { sendTime }],
            ['post', `/mailboxes/${MAILBOX}/messages/7/forward`, { addresses: ['alice@example.com'] }],
            ['put', `/outbound/${QUEUE}`, { sendTime }]
        ]);

        for (const name of ['send_draft', 'forward_message', 'update_outbound_message']) {
            expect(tools.get(name).action).to.equal(ACTION.SEND);
        }

        expect(tools.get('send_draft').config.inputSchema.safeParse({ mailbox: 'Drafts', message: 3, deleteFiles: true }).success).to.equal(false);
        expect(tools.get('update_outbound_message').config.inputSchema.safeParse({ queueId: '../../submit', sendTime }).success).to.equal(false);
    });

    it('cancels a queued message without sending', async () => {
        const { invoke, tools, calls } = setup();

        await invoke('cancel_outbound_message', { queueId: QUEUE });

        expect(calls).to.deep.equal([['delete', `/outbound/${QUEUE}`]]);
        expect(tools.get('cancel_outbound_message').action).to.equal(ACTION.DESTRUCTIVE);
    });

    it('downloads bounded source and attachment byte windows with explicit binary output', async () => {
        const { invoke, tools, calls } = setup();

        const downloaded = await invoke('download_attachment', { mailbox: 'INBOX', message: 4, attachment: 'ATT1', offset: 5, maxBytes: 2 });

        expect(calls[1]).to.deep.equal(['download', `/mailboxes/${MAILBOX}/messages/4/attachments/ATT1`, { offset: 5, maxBytes: 2 }]);
        expect(tools.get('download_attachment').config.outputSchema.safeParse(downloaded).success).to.equal(true);
        expect(downloaded.data).to.equal('AAE=');

        await invoke('get_message_source', { mailbox: 'INBOX', message: 4 });

        expect(calls[3]).to.deep.equal(['download', `/mailboxes/${MAILBOX}/messages/4/message.eml`, { offset: 0, maxBytes: 65536 }]);
        expect(tools.get('get_message_source').action).to.equal(ACTION.READ);

        const schema = tools.get('download_attachment').config.inputSchema;

        for (const changes of [{ attachment: '../submit' }, { offset: -1 }, { maxBytes: 65537 }, { maxBytes: 0 }, { user: LABEL }]) {
            expect(schema.safeParse({ mailbox: 'INBOX', message: 4, attachment: 'ATT1', ...changes }).success).to.equal(false);
        }
    });
});
