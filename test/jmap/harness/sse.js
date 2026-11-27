'use strict';

// A small Server-Sent Events reader for the event source scenarios: fetch with a streaming body,
// parsed into events ({event, id, data, at}) and comment lines. Every wait is bounded, so a missing
// event fails the test quickly instead of hanging it.

const { JMAP_URL } = require('./client');

const DEFAULT_TIMEOUT = 5000;

class EventStream {
    /**
     * Opens a stream. Answers once the response headers arrived; a response that is not 200 is read
     * to its end and kept in `body`.
     *
     * @param {String} url Absolute URL or path on the JMAP listener
     * @param {Object} [options] {authorization, headers, base (URL of the listener)}
     */
    static async open(url, options = {}) {
        const stream = new EventStream();
        await stream.connect(url, options);
        return stream;
    }

    constructor() {
        this.events = [];
        this.comments = [];
        this.cursor = 0;
        this.ended = false;
        this.endedAt = null;
        this.error = null;
        this.waiters = new Set();
        this.controller = new AbortController();
    }

    async connect(url, options) {
        const headers = Object.assign({}, options.authorization ? { Authorization: options.authorization } : {}, options.headers);
        this.startedAt = Date.now();
        const res = await fetch(url.startsWith('http') ? url : (options.base || JMAP_URL) + url, { headers, signal: this.controller.signal });
        this.status = res.status;
        this.headers = res.headers;
        if (res.status !== 200 || !(res.headers.get('content-type') || '').startsWith('text/event-stream')) {
            this.body = Buffer.from(await res.arrayBuffer());
            this.finish();
            return;
        }
        this.read(res.body.getReader());
    }

    async read(reader) {
        const decoder = new TextDecoder();
        let buffer = '';
        let current = {};
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                let match;
                while ((match = /\r\n|\r|\n/.exec(buffer))) {
                    const line = buffer.slice(0, match.index);
                    buffer = buffer.slice(match.index + match[0].length);
                    current = this.line(line, current);
                }
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                this.error = err;
            }
        }
        this.finish();
    }

    // one line of the stream (https://html.spec.whatwg.org/multipage/server-sent-events.html)
    line(line, current) {
        if (line === '') {
            if (current.data !== undefined || current.event !== undefined) {
                this.events.push(Object.assign({ event: 'message', at: Date.now() }, current));
                this.notify();
            }
            return {};
        }
        if (line.startsWith(':')) {
            this.comments.push({ text: line.slice(1), at: Date.now() });
            this.notify();
            return current;
        }
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') {
            current.data = current.data === undefined ? value : `${current.data}\n${value}`;
        } else if (field === 'event' || field === 'id' || field === 'retry') {
            current[field] = value;
        }
        return current;
    }

    finish() {
        if (!this.ended) {
            this.ended = true;
            this.endedAt = Date.now();
            this.notify();
        }
    }

    notify() {
        for (const waiter of this.waiters) {
            waiter();
        }
    }

    // resolves with check() once it is truthy, rejects with message after timeout
    until(check, timeout, message) {
        return new Promise((resolve, reject) => {
            let timer = null;
            const waiter = () => {
                const value = check();
                if (value) {
                    clearTimeout(timer);
                    this.waiters.delete(waiter);
                    resolve(value);
                }
            };
            timer = setTimeout(() => {
                this.waiters.delete(waiter);
                reject(new Error(message));
            }, timeout);
            this.waiters.add(waiter);
            waiter();
        });
    }

    /** Events named `name` received so far */
    named(name) {
        return this.events.filter(event => event.event === name);
    }

    /** State events received so far, with their data parsed */
    states() {
        return this.named('state').map(parse);
    }

    /**
     * Waits for the next event named `name` after the ones already taken, and takes it. A state event
     * comes back with its data parsed.
     */
    async next(name = 'state', timeout = DEFAULT_TIMEOUT) {
        const event = await this.until(
            () => {
                const index = this.events.findIndex((entry, i) => i >= this.cursor && entry.event === name);
                return index >= 0 ? { index } : this.ended ? { ended: true } : null;
            },
            timeout,
            `no ${name} event within ${timeout} ms`
        );
        if (event.ended) {
            throw new Error(`the stream ended before a ${name} event`);
        }
        this.cursor = event.index + 1;
        return parse(this.events[event.index]);
    }

    /** Waits until no state event arrived for `quiet` ms and answers the newest state event (or null) */
    async settle(quiet = 500, timeout = DEFAULT_TIMEOUT) {
        const deadline = Date.now() + timeout;
        let count = -1;
        while (count !== this.named('state').length) {
            if (Date.now() > deadline) {
                throw new Error(`the stream did not settle within ${timeout} ms`);
            }
            count = this.named('state').length;
            await new Promise(resolve => setTimeout(resolve, quiet));
        }
        this.cursor = this.events.length;
        const states = this.states();
        return states.length ? states[states.length - 1] : null;
    }

    /** Waits for the server to end the response */
    async waitEnd(timeout = DEFAULT_TIMEOUT) {
        await this.until(() => this.ended, timeout, `the stream was not ended within ${timeout} ms`);
        return this.endedAt;
    }

    /** Closes the stream from the client side */
    close() {
        this.controller.abort();
        this.finish();
    }
}

function parse(event) {
    if (event.event === 'state' || event.event === 'ping') {
        return Object.assign({}, event, { json: JSON.parse(event.data) });
    }
    return event;
}

const opened = new Set();

/** Opens a stream that the after hook of the caller closes with closeAll() */
async function open(url, options) {
    const stream = await EventStream.open(url, options);
    opened.add(stream);
    return stream;
}

function closeAll() {
    for (const stream of opened) {
        stream.close();
    }
    opened.clear();
}

module.exports = { EventStream, open, closeAll };
