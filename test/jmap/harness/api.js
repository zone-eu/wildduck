'use strict';

// Minimal client for the WildDuck REST API of the running test server, used for seeding.

const config = require('@zone-eu/wild-config');

const API_URL = process.env.WILDDUCK_API_URL || `http://127.0.0.1:${config.api.port}`;

/**
 * Calls the REST API and returns the parsed JSON body.
 * Throws on a non 2xx status unless `expect` names the status the caller wants.
 *
 * @param {String} method HTTP method
 * @param {String} path Path starting with /
 * @param {Object} [body] JSON body
 * @param {Object} [options] {expect: Number, headers: Object}
 */
async function api(method, path, body, options = {}) {
    const res = await fetch(API_URL + path, {
        method,
        headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, options.headers),
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }

    const ok = options.expect ? res.status === options.expect : res.ok;
    if (!ok) {
        const err = new Error(`${method} ${path} answered ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
        err.status = res.status;
        err.body = data;
        throw err;
    }
    return data;
}

module.exports = { api, API_URL };
