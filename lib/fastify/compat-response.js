'use strict';

const { Writable } = require('stream');

/**
 * Restify-compatible response facade over a Fastify reply.
 *
 * Two modes:
 *  - reply mode: res.json()/res.send() go through Fastify's reply (JSON
 *    serialization, onSend hooks, content-type defaults)
 *  - raw mode: entered on writeHead()/write()/end()/pipe targets. The reply is
 *    hijacked and everything is delegated to the underlying Node response so
 *    handlers can stream (attachment downloads, exports, SSE). Headers
 *    accumulated on the reply (CORS and handler-set) are flushed to the raw
 *    response on first write.
 *
 * Extends Writable so `stream.pipe(res)` gets correct backpressure and event
 * semantics without reimplementing the stream contract.
 */
class CompatResponse extends Writable {
    constructor(reply) {
        super();
        this._reply = reply;
        this._statusCode = null;
        this._rawStarted = false;
    }

    // ---- reply mode API ----

    get socket() {
        return this._reply.raw.socket;
    }

    get statusCode() {
        return this._statusCode || this._reply.statusCode;
    }

    set statusCode(code) {
        this.status(code);
    }

    status(code) {
        this._statusCode = code;
        if (!this._rawStarted) {
            this._reply.code(code);
        }
        return this;
    }

    charSet(charset) {
        // restify only appended "; charset=..." to the JSON content type when
        // the handler explicitly called res.charSet(); replicate exactly
        this._charset = charset;
        return this;
    }

    setHeader(key, value) {
        if (this._rawStarted) {
            this._reply.raw.setHeader(key, value);
        } else {
            this._reply.header(key, value);
        }
        return this;
    }

    bypassResponseSchema() {
        // error bodies produced by tools.responseWrapper keep whatever status
        // was already set (including 200 on legacy crash paths) and must not
        // go through the fast-json-stringify response schema
        if (!this._reply.sent && !this._rawStarted) {
            this._reply.serializer(payload => JSON.stringify(payload));
        }
    }

    json(body) {
        if (this._reply.sent) {
            return body;
        }
        // stash the body object for the Gelf logging hook (the restify
        // implementation logged from within its JSON formatter)
        this._reply.wdResponseBody = body;
        // fastify force-appends charset to bare application/json during send,
        // so the exact restify content type is applied in an onSend hook
        this._reply.wdContentType = this._charset ? `application/json; charset=${this._charset}` : 'application/json';
        this._reply.send(body);
        return body;
    }

    send(body) {
        if (this._reply.sent) {
            return body;
        }
        if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
            return this.json(body);
        }
        if (typeof body === 'string' && !this._reply.getHeader('content-type')) {
            this._reply.header('content-type', 'text/plain; charset=utf-8');
        }
        this._reply.send(body);
        return body;
    }

    redirect(code, url, next) {
        if (typeof code === 'string') {
            next = url;
            url = code;
            code = 302;
        }
        this._reply.redirect(url, code);
        if (typeof next === 'function') {
            next();
        }
    }

    // ---- raw mode ----

    writeHead(statusCode, headers) {
        this._statusCode = statusCode;
        this._ensureRaw(headers);
        return this;
    }

    _ensureRaw(extraHeaders) {
        if (this._rawStarted) {
            return;
        }
        this._rawStarted = true;
        const reply = this._reply;
        reply.hijack();
        // headers accumulated on the reply (CORS middleware, res.setHeader)
        // must survive the switch to the raw response
        const headers = Object.assign({}, reply.getHeaders(), extraHeaders || {});
        for (const key of Object.keys(headers)) {
            if (headers[key] !== undefined) {
                reply.raw.setHeader(key, headers[key]);
            }
        }
        reply.raw.writeHead(this._statusCode || 200);
    }

    _write(chunk, encoding, callback) {
        this._ensureRaw();
        if (!this._reply.raw.write(chunk, encoding)) {
            return this._reply.raw.once('drain', callback);
        }
        return callback();
    }

    _final(callback) {
        this._ensureRaw();
        this._reply.raw.end();
        callback();
    }

    flush() {
        // some SSE implementations call res.flush() when compression is on
        if (this._rawStarted && typeof this._reply.raw.flush === 'function') {
            this._reply.raw.flush();
        }
    }
}

module.exports = CompatResponse;
