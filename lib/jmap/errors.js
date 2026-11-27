'use strict';

// JMAP errors: request level problems (RFC 8620 3.6.1, sent as RFC 7807 problem details) and method
// level errors (RFC 8620 3.6.2, sent as an "error" invocation in the response).

/** A method level error. `extra` adds properties such as `description` or `properties`. */
class MethodError extends Error {
    constructor(type, extra) {
        super((extra && extra.description) || type);
        this.type = type;
        this.extra = extra || {};
    }

    toResponse() {
        return Object.assign({ type: this.type }, this.extra);
    }
}

/** A request level problem, answered with an HTTP status and a problem details body. */
class RequestProblem extends Error {
    constructor(type, status, detail, extra) {
        super(detail);
        this.type = type;
        this.status = status;
        this.extra = extra || {};
    }

    toResponse() {
        const prefix = this.type.includes(':') ? '' : 'urn:ietf:params:jmap:error:';
        return Object.assign({ type: prefix + this.type, status: this.status, detail: this.message }, this.extra);
    }
}

const invalidArguments = description => new MethodError('invalidArguments', { description });

module.exports = { MethodError, RequestProblem, invalidArguments };
