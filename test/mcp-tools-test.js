'use strict';

const chai = require('chai');
const { z } = require('zod');
const consts = require('../lib/consts');
const { ACTION, TOOL_LEVELS, TOOL_NAMES, annotationsFor, messageBody, registerMcpTools, sliceBody } = require('../lib/mcp-tools');

const expect = chai.expect;

const MAILBOX_ID = '507f1f77bcf86cd799439012';

function createReader(overrides = {}) {
    return {
        role: 'mcp:read',
        async getAccount() {
            return { id: '1', username: 'alice', name: 'Alice', primaryAddress: 'alice@example.com', aliases: [], quota: { allowed: 1, used: 0 } };
        },
        async listMailboxes() {
            return [{ id: MAILBOX_ID, path: 'INBOX', name: 'INBOX', subscribed: true, hidden: false }];
        },
        async resolveMailbox() {
            return { id: MAILBOX_ID, path: 'INBOX' };
        },
        async mailboxId() {
            return MAILBOX_ID;
        },
        async listMessages() {
            return { total: 0, nextCursor: null, messages: [] };
        },
        async searchMessages() {
            return { total: 0, nextCursor: null, messages: [] };
        },
        async getMessage() {
            return { id: 1, mailbox: MAILBOX_ID, thread: 'th', from: null, to: [], cc: [], bcc: [], subject: 's', attachments: [], text: 'body text' };
        },
        ...overrides
    };
}

function register(reader, options = {}) {
    let tools = new Map();
    let server = {
        registerTool(name, config, handler) {
            tools.set(name, { config, handler });
        }
    };
    let registered = registerMcpTools(server, reader, options);
    return { tools, registered };
}

describe('MCP tools', () => {
    it('derives annotations per action rather than sharing one read-only constant', () => {
        expect(annotationsFor(ACTION.READ)).to.deep.equal({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        expect(annotationsFor(ACTION.DESTRUCTIVE)).to.include({ readOnlyHint: false, destructiveHint: true });
        // sending is the only action that reaches anyone outside the mailbox
        expect(annotationsFor(ACTION.SEND)).to.include({ openWorldHint: true, idempotentHint: false });
        expect(annotationsFor(ACTION.WRITE)).to.include({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    });

    it('registers every read tool for the read level and marks them all read-only', () => {
        let { tools, registered } = register(createReader());

        expect(registered).to.have.members(TOOL_NAMES.slice());
        for (let [, tool] of tools) {
            expect(tool.config.annotations.readOnlyHint).to.equal(true);
            expect(tool.config.annotations.destructiveHint).to.equal(false);
        }
    });

    it('shows a level only the tools it can actually call', () => {
        // an access level that unlocks nothing is advertised nothing, rather than a catalog of
        // calls that would only ever answer 403
        let { registered } = register(createReader({ role: 'mcp:nonexistent' }));
        expect(registered).to.deep.equal([]);

        for (let name of TOOL_NAMES) {
            expect(TOOL_LEVELS[name], `${name} declares no levels`).to.include('mcp:read');
        }
    });

    it('never exposes an argument that could name another user or account', () => {
        let { tools } = register(createReader());

        for (let [name, tool] of tools) {
            let shape = tool.config.inputSchema instanceof z.ZodObject ? Object.keys(tool.config.inputSchema.shape) : [];
            for (let forbidden of ['user', 'users', 'account', 'userId', 'accountId']) {
                expect(shape, `${name} exposes ${forbidden}`).to.not.include(forbidden);
            }
        }
    });

    it('caps the advertised page size at the hard ceiling, whatever the configuration asks', () => {
        let { tools } = register(createReader(), { maxResults: 5000 });
        let limit = tools.get('list_messages').config.inputSchema.shape.limit;

        expect(limit.safeParse(consts.MCP_MAX_RESULTS).success).to.equal(true);
        expect(limit.safeParse(consts.MCP_MAX_RESULTS + 1).success).to.equal(false);
    });

    it('applies a lowered page size to the default as well as to the maximum', () => {
        let { tools } = register(createReader(), { maxResults: 5 });

        // zod does not check a default against the field's own maximum, so a default left at 20
        // would advertise a page size of 5 and then quietly ask the API for 20 on every call
        // that names no limit, which is the call an agent actually makes
        for (let name of ['list_messages', 'search_messages']) {
            let schema = tools.get(name).config.inputSchema;
            expect(schema.parse({ mailbox: 'INBOX' }).limit, name).to.equal(5);
            expect(schema.safeParse({ mailbox: 'INBOX', limit: 6 }).success, name).to.equal(false);
        }
    });

    it('declares the search state filters as flags, since the API has no negative form', async () => {
        let queries = [];
        let { tools } = register(
            createReader({
                async searchMessages(query) {
                    queries.push(query);
                    return { total: 0, nextCursor: null, messages: [] };
                }
            })
        );
        let schema = tools.get('search_messages').config.inputSchema;
        let search = args => tools.get('search_messages').handler(schema.parse(args));

        // The REST route matches on a true value and ignores anything else, so a false value
        // here would look like a negative filter and hand back the whole mailbox instead
        for (let flag of ['has_attachments', 'flagged', 'searchable']) {
            expect(schema.safeParse({ [flag]: true }).success, flag).to.equal(true);
            expect(schema.safeParse({ [flag]: false }).success, flag).to.equal(false);
        }

        // read state is the one filter with a form for each side, so it stays a real boolean
        // and false means read rather than unfiltered
        await search({ unseen: true });
        expect(queries.pop()).to.include({ unseen: true, seen: undefined });
        await search({ unseen: false });
        expect(queries.pop()).to.include({ unseen: undefined, seen: true });
        await search({ query: 'invoice' });
        expect(queries.pop()).to.include({ unseen: undefined, seen: undefined });
    });

    it('spends the rate limit budget before doing any work', async () => {
        let calls = 0;
        let { tools } = register(createReader(), {
            async checkLimit() {
                calls++;
                let err = new Error('Too many MCP tool calls, retry later');
                err.code = 'RateLimitedError';
                throw err;
            }
        });

        let result = await tools.get('get_account').handler({});

        expect(calls).to.equal(1);
        expect(result.isError).to.equal(true);
        expect(result.content[0].text).to.include('RateLimitedError');
    });

    it('reports an unexpected failure without leaking its detail', async () => {
        let { tools } = register(
            createReader({
                async getAccount() {
                    throw new Error('mongodb://user:password@primary/db timed out');
                }
            })
        );

        let result = await tools.get('get_account').handler({});

        expect(result.isError).to.equal(true);
        expect(result.content[0].text).to.equal('InternalError: Unable to read mail data');
        expect(result.content[0].text).to.not.include('password');
    });

    it('windows a body and says when there is more to read', () => {
        expect(sliceBody('abcdef', 0, 3)).to.deep.equal({ available: true, content: 'abc', offset: 0, totalLength: 6, returnedLength: 3, hasMore: true });
        expect(sliceBody('abcdef', 3, 3)).to.include({ content: 'def', offset: 3, hasMore: false });
        // an offset past the end is clamped rather than throwing
        expect(sliceBody('abcdef', 99, 3)).to.include({ content: '', offset: 6, hasMore: false });
        expect(sliceBody(undefined, 0, 3)).to.include({ available: false, content: '', hasMore: false });
    });

    it('sanitizes html bodies and returns only the requested parts', () => {
        let message = { text: 'plain', html: ['<p>rich</p><script>steal()</script>'] };

        expect(messageBody(message, 'text', 0, 100))
            .to.have.property('text')
            .that.includes({ content: 'plain' });
        expect(messageBody(message, 'text', 0, 100)).to.not.have.property('html');

        let html = messageBody(message, 'html', 0, 100).html;
        expect(html.content).to.include('rich');
        expect(html.content).to.not.include('steal');

        expect(messageBody(message, 'both', 0, 100)).to.have.all.keys('text', 'html');
    });

    it('caps a body window at the hard ceiling', async () => {
        let long = 'x'.repeat(consts.MCP_MAX_BODY_CHARS + 500);
        let { tools } = register(
            createReader({
                async getMessage() {
                    return { id: 1, mailbox: MAILBOX_ID, thread: 'th', from: null, to: [], cc: [], bcc: [], subject: 's', attachments: [], text: long };
                }
            }),
            { maxBodyChars: 10 * consts.MCP_MAX_BODY_CHARS }
        );

        let result = await tools.get('get_message').handler({ mailbox: 'INBOX', uid: 1, body_format: 'text' });

        expect(result.structuredContent.body.text.returnedLength).to.equal(consts.MCP_MAX_BODY_CHARS);
        expect(result.structuredContent.body.text.hasMore).to.equal(true);
    });

    it('reads the rest of a long body through get_message_text', async () => {
        let long = 'abcdefghij'.repeat(10);
        let { tools } = register(
            createReader({
                async getMessage() {
                    return { id: 1, mailbox: MAILBOX_ID, thread: 'th', from: null, to: [], cc: [], bcc: [], subject: 's', attachments: [], text: long };
                }
            })
        );

        let result = await tools.get('get_message_text').handler({ mailbox: 'INBOX', uid: 1, body_format: 'text', offset: 90, length: 10 });

        expect(result.structuredContent.body.text.content).to.equal(long.slice(90, 100));
        expect(result.structuredContent.body.text.hasMore).to.equal(false);
    });
});
