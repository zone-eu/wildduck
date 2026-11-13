/* eslint-env mocha */
/* eslint no-unused-expressions: 0 */

'use strict';

const { expect } = require('chai');
const McpApiClient = require('../lib/mcp-api-client');
const consts = require('../lib/consts');

describe('MCP binary downloads', () => {
    function fixture(chunks, headers = {}) {
        const calls = [];
        let cancelled = false;

        const client = new McpApiClient({
            fetch: async (url, options) => {
                calls.push({ url: url.toString(), ...options });

                let index = 0;

                return new Response(
                    new ReadableStream({
                        pull(controller) {
                            if (index < chunks.length) {
                                controller.enqueue(Buffer.from(chunks[index++]));
                            } else {
                                controller.close();
                            }
                        },
                        cancel() {
                            cancelled = true;
                        }
                    }),
                    { headers }
                );
            }
        });

        const reader = client.bind({ user: { _id: '507f191e810c19729de860ea' }, role: 'mcp:read' }, 'test-bearer');

        return { reader, client, calls, cancelled: () => cancelled };
    }

    it('returns exact binary windows and cancels a stream with unread content', async () => {
        const { reader, calls, cancelled } = fixture(
            [[0, 1], [2, 255, 4, 5], [6, 7]],
            { 'content-type': 'application/pdf', 'content-length': '8' }
        );

        const result = await reader.download('/mailboxes/id/messages/1/attachments/ATT00001', { offset: 1, maxBytes: 3 });

        expect(Buffer.from(result.data, 'base64')).to.deep.equal(Buffer.from([1, 2, 255]));
        expect(result).to.include({ offset: 1, returnedBytes: 3, hasMore: true, totalBytes: 8, contentType: 'application/pdf' });
        expect(cancelled()).to.equal(true);
        expect(calls[0].url).to.include('/users/507f191e810c19729de860ea/mailboxes/');
        expect(calls[0].headers.Authorization).to.equal('Bearer test-bearer');
        expect(calls[0].redirect).to.equal('error');
    });

    it('reconstructs bytes across windows without corrupting multibyte or binary content', async () => {
        const bytes = Buffer.from([0, 255, 0xe2, 0x82, 0xac, 13, 10]);
        const { reader } = fixture([bytes]);

        const first = await reader.download('/mailboxes/id/messages/1/message.eml', { maxBytes: 4 });
        const last = await reader.download('/mailboxes/id/messages/1/message.eml', { offset: 4, maxBytes: 4 });

        expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(last.data, 'base64')])).to.deep.equal(bytes);
        expect(last.hasMore).to.equal(false);
    });

    it('rejects unbounded windows before making an HTTP request', async () => {
        const { reader, calls } = fixture([]);

        for (const options of [{ offset: -1 }, { maxBytes: consts.MCP_MAX_DOWNLOAD_BYTES + 1 }, { maxBytes: 0 }]) {
            try {
                await reader.download('/mailboxes/id/messages/1/attachments/ATT1', options);
                throw new Error('Expected failure');
            } catch (err) {
                expect(err.code).to.equal('InputValidationError');
            }
        }

        expect(calls).to.have.length(0);
    });

    it('preserves HTTP errors and rejects truncated or overlong streams', async () => {
        const client = new McpApiClient({
            fetch: async () => new Response(JSON.stringify({ error: 'Missing attachment', code: 'MessageNotFound' }), { status: 404 })
        });

        try {
            await client.download({ token: 'test', path: '/attachment' });
            throw new Error('Expected failure');
        } catch (err) {
            expect(err.code).to.equal('MessageNotFound');
            expect(err.responseCode).to.equal(404);
        }

        for (const [declared, maxBytes] of [['100', 100], ['3', 1]]) {
            const { reader } = fixture(['short'], { 'content-length': declared });

            try {
                await reader.download('/attachment', { maxBytes });
                throw new Error('Expected failure');
            } catch (err) {
                expect(err.code).to.equal('ApiUnavailable');
            }
        }
    });
});
