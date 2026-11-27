/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* globals before: false, after: false */
'use strict';

// The body value budget of one Email/get call (limits.maxBodyValueBytesPerRequest, plan 1.13). Not a
// catalogue scenario: a WildDuck limit checked against an instance with a small budget.

const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const { jmap } = require('../harness');
const { startInstance, stopInstance } = require('../harness/instance');
const { newUser, appendAll } = require('./email-get-helpers');

const text = (subject, body) => `From: a@example.com\r\nTo: b@example.com\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;

describe('Email/get body value budget', function () {
    this.timeout(30000);
    let instance;
    before(async () => {
        instance = await startInstance({ limits: Object.assign({}, config.jmap.limits, { maxBodyValueBytesPerRequest: 300 }) });
    });
    after(() => stopInstance(instance.app));

    it('fills the budget in order and returns later values empty and truncated', async () => {
        const { user } = await newUser();
        const ids = await appendAll(user, [text('one', 'a'.repeat(200)), text('two', 'b'.repeat(200)), text('three', 'c'.repeat(200))]);
        const client = new jmap.JmapClient(jmap.basic(user.username, user.password));
        const res = await client.raw(`${instance.url}/jmap/api/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                using: [jmap.URN.core, jmap.URN.mail],
                methodCalls: [['Email/get', { accountId: `u${user.id}`, ids, properties: ['bodyValues'], fetchTextBodyValues: true }, 'g']]
            })
        });
        const [[, { list }]] = res.json.methodResponses;
        const values = list.map(email => Object.values(email.bodyValues)[0]);
        expect(values[0]).to.include({ isTruncated: false });
        expect(values[0].value.trim()).to.equal('a'.repeat(200));
        // the second value takes what is left of the 300 octets
        expect(values[1].isTruncated).to.be.true;
        expect(Buffer.byteLength(values[1].value)).to.be.at.most(100);
        expect(values[2]).to.deep.equal({ value: '', isEncodingProblem: false, isTruncated: true });
    });
});
