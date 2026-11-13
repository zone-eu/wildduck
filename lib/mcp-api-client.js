'use strict';

// Reads mail for the MCP service by calling WildDuck's own REST API over the private network,
// forwarding the caller's own bearer token.
//
// The point of the indirection is that an MCP tool call is an ordinary API request: the same
// request validation, the same `roles.can(req.role)` check, the same response schema, the same
// rate limiting and the same audit trail that a REST client gets. There is deliberately no
// second read path into MongoDB that could drift from the one the API serves, and no
// duplicated copy of the message listing and search logic, which is among the most frequently
// patched code in the product.
//
// The extra hop is a keep-alive request to a loopback or private address, which is noise next
// to the Mongo queries it wraps.

const config = require('@zone-eu/wild-config');
const { fetch: fetchCmd, Agent } = require('undici');
const tools = require('./tools');
const consts = require('./consts');

const DEFAULT_TIMEOUT = 30 * 1000;

// Derived from the API's own configuration rather than repeated as a literal, so moving the
// API port cannot leave MCP quietly pointed at whatever else answers on the old one.
function defaultApiUrl() {
    let api = config.api || {};
    return `${api.secure ? 'https' : 'http'}://${api.host && api.host !== '0.0.0.0' ? api.host : '127.0.0.1'}:${api.port || 8080}`;
}

function createError(message, code, responseCode) {
    let err = new Error(message);
    err.code = code;
    err.responseCode = responseCode;
    err.formattedMessage = message;
    return err;
}

// The access level's field allowlist from config/roles.json is applied by the API itself, on
// the way out, so a response has already been stripped by the time it arrives here. Nothing in
// this file filters again: the tool layer builds each result field by field, and a second copy
// of the allowlist would only be a second thing to keep in step with the role.
class McpReader {
    constructor(client, auth, token) {
        this.client = client;
        this.token = token;
        this.role = auth.role;
        this.user = auth.user._id.toString();
    }

    get(path, query) {
        return this.client.get({ token: this.token, path: `/users/${this.user}${path}`, query });
    }

    post(path, body) {
        return this.client.request({ token: this.token, method: 'POST', path: `/users/${this.user}${path}`, body });
    }

    put(path, body) {
        return this.client.request({ token: this.token, method: 'PUT', path: `/users/${this.user}${path}`, body });
    }

    delete(path, query) {
        return this.client.request({ token: this.token, method: 'DELETE', path: `/users/${this.user}${path}`, query });
    }

    download(path, options) {
        return this.client.download({ token: this.token, path: `/users/${this.user}${path}`, ...options });
    }

    listFilters() {
        return this.get('/filters');
    }

    getAutoreply() {
        return this.get('/autoreply');
    }

    createFilter(filter) {
        return this.post('/filters', filter);
    }

    createMailbox(mailbox) {
        return this.post('/mailboxes', mailbox);
    }

    setAutoreply(settings) {
        return this.put('/autoreply', settings);
    }

    async getAccount() {
        let [userData, addresses] = await Promise.all([this.get(''), this.get('/addresses')]);

        // The user record names the main address, and the addresses listing does not: `main`
        // is not a field the access level grants, so reading the flag off that listing would
        // silently find nothing and fall through to here anyway.
        let results = addresses.results || [];
        let primaryAddress = userData.address || '';

        return {
            id: userData.id,
            username: userData.username || '',
            name: userData.name || '',
            primaryAddress,
            aliases: results
                .filter(address => address.address !== primaryAddress)
                // rebuilt rather than passed through, so this is the shape the tool declares
                // and not whatever the addresses route happens to return
                .map(address => ({ address: address.address, name: address.name || undefined })),
            quota: {
                allowed: (userData.limits && userData.limits.quota && userData.limits.quota.allowed) || 0,
                used: (userData.limits && userData.limits.quota && userData.limits.quota.used) || 0
            }
        };
    }

    async listMailboxes(options) {
        options = options || {};
        let response = await this.get('/mailboxes', {
            counters: options.counters !== false,
            sizes: !!options.sizes,
            showHidden: !!options.showHidden
        });

        return response.results || [];
    }

    async listLabels(options) {
        let response = await this.get('/labels', { counters: !!(options && options.counters) });
        return response.labels || [];
    }

    /**
     * Resolves a mailbox by exact path or by id.
     *
     * Goes to the single-mailbox route rather than listing the tree: a user may hold up to
     * MAX_MAILBOXES folders, and every mailbox-scoped tool call resolves one. Path matching is
     * exact, which the API's `resolve` form gives for free; a prefix or fuzzy match would let
     * an agent read a mailbox the user did not name.
     *
     * @param {String} reference Mailbox path or 24 character id.
     * @returns {Promise<Object>} Mailbox.
     */
    async resolveMailbox(reference) {
        reference = (reference || '').toString().trim();
        if (!reference) {
            throw createError('Mailbox is required', 'InputValidationError', 400);
        }

        let isId = tools.isId(reference);

        return await this.get(`/mailboxes/${isId ? reference.toLowerCase() : 'resolve'}`, isId ? {} : { path: reference });
    }

    /**
     * The id of a mailbox named by either a path or an id.
     *
     * A 24 character id needs no lookup: the message routes it is passed to validate it
     * themselves, so resolving it first would spend another API request, and the mailbox route
     * computes counters that a caller after the id alone never reads.
     *
     * @param {String} reference Mailbox path or 24 character id.
     * @returns {Promise<String>} Mailbox id.
     */
    async mailboxId(reference) {
        reference = (reference || '').toString().trim();
        return tools.isId(reference) ? reference.toLowerCase() : (await this.resolveMailbox(reference)).id;
    }

    listing(response) {
        return {
            total: response.total || 0,
            nextCursor: response.nextCursor || null,
            previousCursor: response.previousCursor || null,
            messages: response.results || []
        };
    }

    async listMessages({ mailbox, limit, order, next, previous, unseen }) {
        return this.listing(await this.get(`/mailboxes/${mailbox}/messages`, { limit, order, next, previous, unseen }));
    }

    async searchMessages(query) {
        return this.listing(await this.get('/search', query));
    }

    async getMessage({ mailbox, message }) {
        return await this.get(`/mailboxes/${mailbox}/messages/${message}`, {
            // Reading over MCP must never mark mail as seen: an agent looking at a mailbox is
            // not the user reading it, and silently clearing unread counts is destructive.
            markAsSeen: false
        });
    }
}

class McpApiClient {
    constructor(options) {
        options = options || {};
        this.apiUrl = (options.apiUrl || defaultApiUrl()).toString().replace(/\/+$/, '');
        this.timeout = Number(options.timeout) || DEFAULT_TIMEOUT;
        this.agent = new Agent({ connect: { timeout: this.timeout }, keepAliveTimeout: 30 * 1000 });
        this.fetch = options.fetch || fetchCmd;
    }

    /**
     * Issues one API request as the caller.
     *
     * @param {Object} opts Request options.
     * @param {String} opts.token Caller's bearer credential, forwarded unchanged.
     * @param {String} opts.path API path.
     * @param {Object} [opts.query] Query parameters; undefined values are dropped.
     * @returns {Promise<Object>} Parsed response body.
     */
    async get({ token, path, query }) {
        return this.request({ token, method: 'GET', path, query });
    }

    async request({ token, method, path, query, body }) {
        let url = new URL(this.apiUrl + path);
        for (let [key, value] of Object.entries(query || {})) {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, value.toString());
            }
        }

        let res;
        try {
            let headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
            let request = {
                method,
                headers,
                redirect: 'error',
                dispatcher: this.agent,
                signal: AbortSignal.timeout(this.timeout)
            };
            if (body !== undefined) {
                headers['Content-Type'] = 'application/json';
                request.body = JSON.stringify(body);
            }
            res = await this.fetch(url, request);
        } catch (err) {
            throw createError('Mail service is unavailable', 'ApiUnavailable', 503);
        }

        let responseBody;
        try {
            responseBody = await res.json();
        } catch (err) {
            throw createError('Mail service returned an unreadable response', 'ApiUnavailable', 503);
        }

        if (!res.ok || !responseBody || responseBody.error) {
            // The API's own status and error code are carried through, so a 404 for a missing
            // mailbox stays a 404 rather than becoming an opaque failure.
            throw createError(
                (responseBody && responseBody.error) || 'Mail service request failed',
                (responseBody && responseBody.code) || 'ApiRequestFailed',
                res.status || 500
            );
        }

        return responseBody;
    }

    // The REST download routes stream their payloads. Read only one bounded byte window and
    // cancel the remaining stream, including on error, so attachments never accumulate in memory.
    async download({ token, path, offset = 0, maxBytes = consts.MCP_MAX_DOWNLOAD_BYTES }) {
        if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > consts.MAX_ALLOWED_MESSAGE_SIZE ||
            !Number.isSafeInteger(maxBytes) ||
            maxBytes < 1 ||
            maxBytes > consts.MCP_MAX_DOWNLOAD_BYTES
        ) {
            throw createError('Invalid download window', 'InputValidationError', 400);
        }

        let stream;

        try {
            const response = await this.fetch(new URL(this.apiUrl + path), {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
                redirect: 'error',
                dispatcher: this.agent,
                signal: AbortSignal.timeout(this.timeout)
            });

            if (!response.ok) {
                const error = await response.json();
                throw createError(error.error || 'Download failed', error.code || 'ApiRequestFailed', response.status);
            }

            stream = response.body.getReader();

            let skipped = 0;
            let length = 0;
            let chunks = [];
            let ended = false;

            while (length <= maxBytes) {
                const { done, value } = await stream.read();

                if (done) {
                    ended = true;
                    break;
                }

                const start = Math.min(value.length, Math.max(0, offset - skipped));
                skipped += value.length;

                const chunk = Buffer.from(value.subarray(start, start + maxBytes + 1 - length));

                if (chunk.length) {
                    chunks.push(chunk);
                    length += chunk.length;
                }
            }

            const bytes = Buffer.concat(chunks, length);
            const returnedBytes = Math.min(length, maxBytes);
            const contentLength = response.headers.get('content-length');
            const totalBytes = contentLength !== null && /^\d+$/.test(contentLength) ? Number(contentLength) : undefined;

            if (totalBytes !== undefined && (skipped > totalBytes || (ended && skipped !== totalBytes))) {
                throw createError('Download does not match its declared length', 'ApiUnavailable', 503);
            }

            return {
                data: bytes.subarray(0, returnedBytes).toString('base64'),
                encoding: 'base64',
                offset,
                returnedBytes,
                hasMore: length > maxBytes,
                totalBytes,
                contentType: response.headers.get('content-type') || 'application/octet-stream'
            };
        } catch (err) {
            if (err.responseCode) {
                throw err;
            }

            throw createError('Mail service download is unavailable', 'ApiUnavailable', 503);
        } finally {
            if (stream) {
                await stream.cancel().catch(() => false);
            }
        }
    }

    /**
     * Binds the client to one authenticated caller. Every tool reads through a bound client,
     * so no tool can name a user other than the one its token belongs to.
     *
     * @param {Object} auth Result of McpTokenHandler.authenticate().
     * @param {String} token Caller's bearer credential.
     * @returns {Object} Reader bound to that user.
     */
    bind(auth, token) {
        return new McpReader(this, auth, token);
    }
}

module.exports = McpApiClient;
module.exports.McpReader = McpReader;
