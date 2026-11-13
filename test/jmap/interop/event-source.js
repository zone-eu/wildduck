'use strict';

// A minimal WHATWG EventSource for the interop tests. jmap-jam opens its push connection with the
// global EventSource, which Node does not provide without a flag and which cannot send an
// Authorization header. This one stands in for a browser that holds the credentials: it adds the
// header it was created with, parses the stream as the HTML standard describes and dispatches every
// named event (state, ping) to its listeners. It does not reconnect: a test that loses the stream
// fails instead of waiting.

class AuthorizedEventSource extends EventTarget {
    /**
     * Answers an EventSource class whose instances send `authorization` with the request.
     *
     * @param {String} authorization Authorization header value
     */
    static withAuthorization(authorization) {
        return class extends AuthorizedEventSource {
            constructor(url) {
                super(url, authorization);
            }
        };
    }

    constructor(url, authorization) {
        super();
        this.url = String(url);
        this.readyState = 0;
        this.controller = new AbortController();
        this.connect(authorization).catch(err => this.fail(err));
    }

    async connect(authorization) {
        const res = await fetch(this.url, {
            headers: { Accept: 'text/event-stream', Authorization: authorization },
            signal: this.controller.signal
        });
        if (res.status !== 200 || !(res.headers.get('content-type') || '').startsWith('text/event-stream')) {
            await res.arrayBuffer();
            throw new Error(`event source answered ${res.status}`);
        }
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));

        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        let buffer = '';
        let current = {};
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            let match;
            while ((match = /\r\n|\r|\n/.exec(buffer))) {
                current = this.line(buffer.slice(0, match.index), current);
                buffer = buffer.slice(match.index + match[0].length);
            }
        }
        this.fail(new Error('the server ended the stream'));
    }

    // one line of the stream (https://html.spec.whatwg.org/multipage/server-sent-events.html)
    line(line, current) {
        if (line === '') {
            if (current.data !== undefined) {
                this.dispatchEvent(new MessageEvent(current.event || 'message', { data: current.data, lastEventId: current.id || '' }));
            }
            return {};
        }
        if (line.startsWith(':')) {
            return current;
        }
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') {
            current.data = current.data === undefined ? value : `${current.data}\n${value}`;
        } else if (field === 'event' || field === 'id') {
            current[field] = value;
        }
        return current;
    }

    fail(err) {
        if (this.readyState === 2) {
            return;
        }
        this.readyState = 2;
        if (err.name !== 'AbortError') {
            this.error = err;
            this.dispatchEvent(new Event('error'));
        }
    }

    close() {
        this.readyState = 2;
        this.controller.abort();
    }
}

module.exports = { AuthorizedEventSource };
