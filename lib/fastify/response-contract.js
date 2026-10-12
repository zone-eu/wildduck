'use strict';

/**
 * Response contract check for the API routes.
 *
 * A route's response model is compiled into a fast-json-stringify serializer.
 * That serializer silently drops every key the model does not declare and
 * coerces values to the declared type: null becomes "" / 0 / false / {} / [],
 * a number becomes a string and the other way round. A model that does not
 * match what the handler returns therefore changes responses without any
 * error, and only a test that happens to assert on the affected field notices.
 *
 * The check compares what the serializer produced with what plain
 * JSON.stringify makes of the same payload. Any difference is something the
 * model changed silently. Only the location and the kind of the difference
 * are recorded, never the values, so nothing from a response body leaks into
 * the report.
 */

// array indexes are folded into [] so one finding per field is reported,
// not one per list entry
const joinPath = (path, key) => (typeof key === 'number' ? `${path}[]` : path ? `${path}.${key}` : key);

const describeType = value => {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    return typeof value;
};

/**
 * Lists the differences between the expected (plain JSON) and the actual
 * (serialized) form of a response body.
 *
 * @param {*} expected JSON.parse(JSON.stringify(payload))
 * @param {*} actual JSON.parse(serialized payload)
 * @returns {Array<{path: String, kind: String, expected?: String, actual?: String}>}
 */
function diffResponse(expected, actual, path = '', out = []) {
    if (expected === actual) {
        return out;
    }

    const bothObjects = expected && actual && typeof expected === 'object' && typeof actual === 'object' && Array.isArray(expected) === Array.isArray(actual);

    if (!bothObjects) {
        out.push({ path: path || '(body)', kind: 'changed', expected: describeType(expected), actual: describeType(actual) });
        return out;
    }

    if (Array.isArray(expected)) {
        if (expected.length !== actual.length) {
            out.push({ path: path || '(body)', kind: 'length' });
        }
        const len = Math.min(expected.length, actual.length);
        for (let i = 0; i < len; i++) {
            diffResponse(expected[i], actual[i], joinPath(path, i), out);
        }
        return out;
    }

    for (const key of Object.keys(expected)) {
        if (!Object.hasOwn(actual, key)) {
            out.push({ path: joinPath(path, key), kind: 'dropped' });
        } else {
            diffResponse(expected[key], actual[key], joinPath(path, key), out);
        }
    }
    for (const key of Object.keys(actual)) {
        if (!Object.hasOwn(expected, key)) {
            out.push({ path: joinPath(path, key), kind: 'added' });
        }
    }
    return out;
}

/**
 * Error replies from route handlers follow the documented {error, code}
 * contract. Returns the finding for a body that does not, or null.
 */
function checkErrorBody(statusCode, body) {
    if (statusCode < 400 || !body || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    // health answers its own documented {success, version, message} shape
    if (body.success === false && 'message' in body) {
        return null;
    }
    if (typeof body.error !== 'string' || !body.error) {
        return { path: 'error', kind: 'error-body', expected: 'string', actual: describeType(body.error) };
    }
    if (typeof body.code !== 'string' || !body.code) {
        return { path: 'code', kind: 'error-body', expected: 'string', actual: describeType(body.code) };
    }
    return null;
}

/**
 * Adds the contract check to an app. Every JSON reply of a documented route
 * (one that declares validationObjs) is checked and each finding is handed to
 * onViolation together with the route and the status code.
 *
 * @param {Object} app Fastify instance, before the routes are registered
 * @param {Function} onViolation Called with {method, route, statusCode, path, kind, expected?, actual?}
 */
function attachResponseContractCheck(app, onViolation) {
    app.addHook('onSend', async (request, reply, payload) => {
        const routeConfig = request.routeOptions && request.routeOptions.config;
        if (!routeConfig || !routeConfig.validationObjs || typeof payload !== 'string') {
            return payload;
        }

        const body = reply.wdResponseBody;
        if (!body || typeof body !== 'object') {
            return payload;
        }

        const report = finding =>
            onViolation({
                method: request.method,
                route: request.routeOptions.url,
                statusCode: reply.statusCode,
                ...finding
            });

        let actual;
        try {
            actual = JSON.parse(payload);
        } catch {
            report({ path: '(body)', kind: 'invalid-json' });
            return payload;
        }

        for (const finding of diffResponse(JSON.parse(JSON.stringify(body)), actual)) {
            report(finding);
        }

        // errors raised before a handler ran (access token, body parsing) use
        // the documented {code, message} infra shape instead
        const errorFinding = request.wdValidated && checkErrorBody(reply.statusCode, actual);
        if (errorFinding) {
            report(errorFinding);
        }

        return payload;
    });
}

/**
 * Collects findings, one entry per distinct route, status, path and kind.
 */
function createViolationLog() {
    const entries = new Map();
    return {
        record(finding) {
            const key = [finding.method, finding.route, finding.statusCode, finding.path, finding.kind].join(' ');
            const entry = entries.get(key);
            if (entry) {
                entry.count++;
            } else {
                entries.set(key, { ...finding, count: 1 });
            }
        },
        list() {
            return [...entries.values()];
        },
        clear() {
            entries.clear();
        }
    };
}

module.exports = { attachResponseContractCheck, createViolationLog };
