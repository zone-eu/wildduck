'use strict';

const chai = require('chai');
const { z } = require('zod');
const { registerResourceTools } = require('../lib/mcp-resource-tools');

const expect = chai.expect;
const ID = '507f1f77bcf86cd799439012';

function setup() {
    const registered = new Map();
    const calls = [];

    const reader = {
        async mailboxId(reference) {
            calls.push(['mailboxId', reference]);
            return ID;
        },
        async get(path, query) {
            calls.push(['get', path, query]);
            return { success: true };
        },
        async post(path, body) {
            calls.push(['post', path, body]);
            return { success: true };
        },
        async put(path, body) {
            calls.push(['put', path, body]);
            return { success: true };
        },
        async delete(path, query) {
            calls.push(['delete', path, query]);
            return { success: true };
        }
    };

    const tool = (name, action, config, handler) => registered.set(name, { action, config, handler });
    const run = (name, fn) => fn();

    registerResourceTools({
        tool,
        run,
        reader,
        z,
        ACTION: { READ: 'read', WRITE: 'write', DESTRUCTIVE: 'destructive' },
        mailboxRef: z.string(),
        maxResults: 100,
        defaultResults: 20
    });
    return { registered, calls };
}

describe('MCP resource tools', () => {
    it('registers only strict schemas and bounded output contracts', () => {
        const { registered } = setup();

        expect(Array.from(registered.keys())).to.deep.equal([
            'get_mailbox',
            'update_mailbox',
            'delete_mailbox',
            'get_filter',
            'update_filter',
            'delete_filter',
            'get_label',
            'create_label',
            'rename_label',
            'delete_label',
            'get_label_counters',
            'get_flag_counters',
            'get_flagged_counter',
            'delete_autoreply',
            'list_addresses',
            'get_address',
            'create_address',
            'update_address',
            'delete_address',
            'list_address_register',
            'update_address_register_entry'
        ]);
        for (const { config } of registered.values()) {
            expect(config.inputSchema.safeParse({ unexpected: true }).success).to.equal(false);
            expect(config.outputSchema.safeParse({ success: true, id: ID }).success).to.equal(true);
        }

        expect(
            registered.get('update_filter').config.inputSchema.safeParse({ filter: ID, action: { targets: ['https://bad.example'] } }).success
        ).to.equal(false);
    });

    it('resolves mailbox references and uses only bound resource paths', async () => {
        const { registered, calls } = setup();
        await registered.get('get_mailbox').handler({ mailbox: 'INBOX' });

        expect(calls).to.deep.equal([['mailboxId', 'INBOX'], ['get', `/mailboxes/${ID}`, {}]]);
    });

    it('omits unspecified update fields and restricts address register updates', async () => {
        const { registered, calls } = setup();

        await registered.get('update_mailbox').handler({ mailbox: 'INBOX', subscribed: false });
        await registered.get('update_filter').handler({ filter: ID, disabled: true });

        expect(calls).to.deep.equal([
            ['mailboxId', 'INBOX'],
            ['put', `/mailboxes/${ID}`, { subscribed: false }],
            ['put', `/filters/${ID}`, { disabled: true }]
        ]);

        expect(registered.get('update_address_register_entry').config.inputSchema.safeParse({ id: ID, disabled: true }).success).to.equal(true);
        expect(
            registered.get('update_address_register_entry').config.inputSchema.safeParse({ id: ID, disabled: true, address: 'a@b.c' }).success
        ).to.equal(false);
    });

    it('uses the API-required address register search and bounded limit default', () => {
        const schema = setup().registered.get('list_address_register').config.inputSchema;
        const parsed = schema.parse({ query: 'alice' });

        expect(parsed.limit).to.equal(20);
        expect(schema.safeParse({ query: 'alice', limit: 101 }).success).to.equal(false);
        expect(schema.safeParse({ query: '' }).success).to.equal(true);
    });

    it('looks up label counters by name and defaults searchable counts', () => {
        const { registered, calls } = setup();
        const schema = registered.get('get_label_counters').config.inputSchema;
        const parsed = schema.parse({ label: ' Important ' });
        expect(parsed.searchable).to.equal(true);
        expect(schema.safeParse({ label: '.' }).success).to.equal(false);
        return registered.get('get_label_counters').handler(parsed).then(() => {
            expect(calls).to.deep.equal([['get', '/label-counters/%20Important%20', { searchable: true }]]);
        });
    });

    it('preserves label names exactly for create and rename', async () => {
        const { registered, calls } = setup();
        const createArgs = registered.get('create_label').config.inputSchema.parse({ name: ' Important ' });
        const renameArgs = registered.get('rename_label').config.inputSchema.parse({ label: ID, name: ' Important ' });
        expect(createArgs.name).to.equal(' Important ');
        expect(renameArgs.name).to.equal(' Important ');

        await registered.get('create_label').handler(createArgs);
        await registered.get('rename_label').handler(renameArgs);

        expect(calls).to.deep.equal([
            ['post', '/labels', { name: ' Important ' }],
            ['put', `/labels/${ID}`, { name: ' Important ' }]
        ]);
    });
});
