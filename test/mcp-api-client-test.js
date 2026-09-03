'use strict';

const chai = require('chai');
const McpApiClient = require('../lib/mcp-api-client');
const { filterFields } = require('../lib/mcp-api-client');

const expect = chai.expect;

const USER_ID = '507f191e810c19729de860ea';
const MAILBOX_ID = '507f1f77bcf86cd799439012';
const TOKEN = 'wdmcp_13f9a71c4e2b85d06a147fc39e0d2b6581aa4c7e93b05f2d81c6e4a70b93df2159838c218';

function createClient(responder) {
    let calls = [];
    let client = new McpApiClient({
        apiUrl: 'http://127.0.0.1:8080',
        fetch: async (url, options) => {
            calls.push({ url: url.toString(), headers: options.headers });
            let { status = 200, body = { success: true } } = (await responder(url, options)) || {};
            return { ok: status < 400, status, json: async () => body };
        }
    });
    let reader = client.bind({ user: { _id: USER_ID }, role: 'mcp:read' }, TOKEN);
    return { client, reader, calls };
}

async function expectCode(promise, code) {
    let thrown;
    try {
        await promise;
    } catch (err) {
        thrown = err;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect(thrown.code).to.equal(code);
    return thrown;
}

describe('MCP API client', () => {
    it('forwards the caller credential and scopes every path to that user', async () => {
        let { reader, calls } = createClient(async () => ({ body: { success: true, results: [] } }));

        await reader.listMailboxes();

        expect(calls[0].headers.Authorization).to.equal(`Bearer ${TOKEN}`);
        expect(calls[0].url).to.include(`/users/${USER_ID}/mailboxes`);
    });

    it('reads messages from the mailbox scoped route and never marks them seen', async () => {
        let { reader, calls } = createClient(async () => ({ body: { success: true, id: 7, mailbox: MAILBOX_ID, thread: 't', subject: 'hi' } }));

        await reader.getMessage({ mailbox: MAILBOX_ID, message: 7 });

        expect(calls[0].url).to.include(`/users/${USER_ID}/mailboxes/${MAILBOX_ID}/messages/7`);
        // an agent looking at a mailbox is not the user reading it
        expect(calls[0].url).to.include('markAsSeen=false');
    });

    it('drops empty query values instead of sending them as blanks', async () => {
        let { reader, calls } = createClient(async () => ({ body: { success: true, results: [] } }));

        await reader.listMessages({ mailbox: MAILBOX_ID, limit: 20, order: 'desc', next: undefined, unseen: undefined });

        expect(calls[0].url).to.include('limit=20');
        expect(calls[0].url).to.include('order=desc');
        expect(calls[0].url).to.not.include('next=');
        expect(calls[0].url).to.not.include('unseen=');
    });

    it('applies the access level field allowlist from config/roles.json', async () => {
        let { reader } = createClient(async () => ({
            body: {
                success: true,
                total: 1,
                results: [{ id: 1, mailbox: MAILBOX_ID, thread: 'th', subject: 'hi', user: 'LEAK', outbound: 'LEAK', metaData: 'LEAK' }]
            }
        }));

        let result = await reader.listMessages({ mailbox: MAILBOX_ID });

        expect(result.messages[0]).to.include({ id: 1, subject: 'hi' });
        expect(result.messages[0]).to.not.have.any.keys('user', 'outbound', 'metaData');
    });

    it('refuses a resource the access level cannot read at all', () => {
        expect(() => filterFields('mcp:read', 'filters', { id: 1 })).to.throw(/privileges/i);
        expect(filterFields('mcp:read', 'mailboxes', { id: 'a', path: 'INBOX', secret: 'LEAK' })).to.deep.equal({ id: 'a', path: 'INBOX' });
    });

    it('carries the API status and error code through instead of flattening them', async () => {
        let { reader } = createClient(async () => ({ status: 404, body: { error: 'This mailbox does not exist', code: 'NoSuchMailbox' } }));

        let err = await expectCode(reader.listMessages({ mailbox: MAILBOX_ID }), 'NoSuchMailbox');
        expect(err.responseCode).to.equal(404);
    });

    it('reports a transport failure as an unavailable service, not a bad request', async () => {
        let client = new McpApiClient({
            fetch: async () => {
                throw new Error('ECONNREFUSED 127.0.0.1:8080');
            }
        });
        let reader = client.bind({ user: { _id: USER_ID }, role: 'mcp:read' }, TOKEN);

        let err = await expectCode(reader.listMailboxes(), 'ApiUnavailable');
        // the internal address must not travel back to the caller
        expect(err.message).to.not.include('127.0.0.1');
    });

    it('resolves a mailbox with one lookup rather than listing the whole tree', async () => {
        let { reader, calls } = createClient(async url => {
            let path = new URL(url).searchParams.get('path');
            if (path && path !== 'INBOX') {
                return { status: 404, body: { error: 'This mailbox does not exist', code: 'NoSuchMailbox' } };
            }
            return { body: { success: true, id: MAILBOX_ID, path: 'INBOX', specialUse: null, secret: 'LEAK' } };
        });

        // a path goes to the resolve form, which matches exactly
        expect((await reader.resolveMailbox('INBOX')).id).to.equal(MAILBOX_ID);
        expect(calls[0].url).to.include('/mailboxes/resolve');
        expect(calls[0].url).to.include('path=INBOX');

        // an id addresses the mailbox directly, with no path parameter
        expect((await reader.resolveMailbox(MAILBOX_ID)).id).to.equal(MAILBOX_ID);
        expect(calls[1].url).to.include(`/mailboxes/${MAILBOX_ID}`);
        expect(calls[1].url).to.not.include('path=');

        // one request per resolution, not a listing of every folder the user has
        expect(calls).to.have.length(2);

        // the access level's field allowlist applies here too
        expect(await reader.resolveMailbox('INBOX')).to.not.have.property('secret');

        // a prefix must not resolve, or an agent could read a mailbox the user did not name
        await expectCode(reader.resolveMailbox('INB'), 'NoSuchMailbox');
        await expectCode(reader.resolveMailbox(''), 'InputValidationError');
    });

    it('builds the account view from the user and address listings', async () => {
        let { reader } = createClient(async url => {
            if (url.toString().includes('/addresses')) {
                return {
                    body: {
                        success: true,
                        results: [
                            { id: 'a1', address: 'alice@example.com', main: true },
                            { id: 'a2', address: 'alias@example.com', main: false }
                        ]
                    }
                };
            }
            return {
                body: {
                    success: true,
                    id: USER_ID,
                    username: 'alice',
                    name: 'Alice',
                    address: 'alice@example.com',
                    limits: { quota: { allowed: 100, used: 10 } }
                }
            };
        });

        let account = await reader.getAccount();

        expect(account).to.include({ id: USER_ID, username: 'alice', primaryAddress: 'alice@example.com' });
        expect(account.quota).to.deep.equal({ allowed: 100, used: 10 });
        expect(account.aliases.map(entry => entry.address)).to.deep.equal(['alias@example.com']);
    });
});
