'use strict';

// Thin JMAP client for the scenario tests, on fetch. Deliberately not a typed client library:
// conformance tests send malformed requests and inspect raw HTTP answers.

const config = require('@zone-eu/wild-config');

const JMAP_URL = process.env.JMAP_URL || `http://127.0.0.1:${(config.jmap && config.jmap.port) || 8091}`;
const URN = {
    core: 'urn:ietf:params:jmap:core',
    mail: 'urn:ietf:params:jmap:mail',
    submission: 'urn:ietf:params:jmap:submission',
    vacationresponse: 'urn:ietf:params:jmap:vacationresponse',
    blob: 'urn:ietf:params:jmap:blob',
    quota: 'urn:ietf:params:jmap:quota',
    contacts: 'urn:ietf:params:jmap:contacts',
    calendars: 'urn:ietf:params:jmap:calendars'
};

const basic = (username, password) => 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

class JmapClient {
    /**
     * @param {String|null} authorization Authorization header value, or null for none
     */
    constructor(authorization) {
        this.authorization = authorization;
        this.accountId = null;
    }

    /** A raw request against the JMAP listener. Answers {status, headers, body, json}. */
    async raw(path, init = {}) {
        const headers = Object.assign({}, this.authorization ? { Authorization: this.authorization } : {}, init.headers);
        const res = await fetch(path.startsWith('http') ? path : JMAP_URL + path, Object.assign({}, init, { headers, redirect: 'follow' }));
        const body = Buffer.from(await res.arrayBuffer());
        let json = null;
        try {
            json = JSON.parse(body.toString());
        } catch {
            // not JSON
        }
        return { status: res.status, headers: res.headers, body, json };
    }

    async session() {
        const res = await this.raw('/.well-known/jmap');
        if (res.status !== 200) {
            throw new Error(`session answered ${res.status}: ${res.body}`);
        }
        this.accountId = Object.keys(res.json.accounts)[0];
        return res.json;
    }

    /** POSTs a Request object, answers the raw result. */
    async request(body, headers) {
        return this.raw('/jmap/api/', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
            body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
        });
    }

    /**
     * Runs method calls and answers the methodResponses. Throws on anything but HTTP 200.
     *
     * @param {Array} methodCalls [name, args, callId] triples; an `accountId` of true is filled in
     * @param {String[]} [using] Capability URNs, core and mail by default
     */
    async call(methodCalls, using = [URN.core, URN.mail]) {
        if (!this.accountId) {
            await this.session();
        }
        const calls = methodCalls.map(([name, args, callId]) => [name, args && args.accountId === true ? Object.assign({}, args, { accountId: this.accountId }) : args, callId]);
        const res = await this.request({ using, methodCalls: calls });
        if (res.status !== 200) {
            throw new Error(`API answered ${res.status}: ${res.body}`);
        }
        return res.json.methodResponses;
    }

    /** Runs one method and answers its arguments; throws with the error type for an error response. */
    async method(name, args = {}, using) {
        const [[responseName, responseArgs]] = await this.call([[name, Object.assign({ accountId: true }, args), 'c0']], using);
        if (responseName === 'error') {
            const err = new Error(`${name} answered ${responseArgs.type}`);
            err.type = responseArgs.type;
            err.response = responseArgs;
            throw err;
        }
        return responseArgs;
    }
}

/** A client authenticated as the user with Basic auth and the account password. */
const forUser = user => new JmapClient(basic(user.username, user.password));

module.exports = { JmapClient, forUser, basic, URN, JMAP_URL };
