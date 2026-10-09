'use strict';

// A test user with one record of each kind the API manages, created through
// an in-process app (see _inprocess.js), for tests that generate requests for
// every route. Not a test file itself, the mocha glob only picks up *-test.js.

const crypto = require('crypto');
const { generateSelfSignedPair, createRoleToken, deleteRoleToken } = require('./_helpers');

// JSON call, as root unless a token is given; fails loudly, a fixture that
// can not be created would silently turn every later request into a 404
const call = async (app, method, url, body, token) => {
    const headers = token ? { 'x-access-token': token } : {};
    const res = await app.inject({
        method,
        url,
        headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
        ...(body ? { payload: JSON.stringify(body) } : {})
    });
    if (res.statusCode >= 300) {
        throw new Error(`Fixture ${method} ${url} failed with ${res.statusCode}: ${res.body.slice(0, 200)}`);
    }
    return res.json();
};

/**
 * Creates the fixture user and its records.
 *
 * @param {Object} app In-process app
 * @param {String} tag Unique part of names and domains
 * @returns {Promise<Object>} {runId, domain, email, ids, path, cleanup}; ids and path as expected by _route-requests.js
 */
async function createFixtures(app, tag) {
    const runId = `${tag}${crypto.randomBytes(3).toString('hex')}`;
    const domain = `fuzz${runId}.org`;
    const email = `fuzz${runId}@${domain}`;
    const username = `fuzz${runId}`;

    const user = (await call(app, 'POST', '/users', { username, password: `pass-${runId}`, address: email, name: 'Fuzz User' })).id;

    const mailboxes = (await call(app, 'GET', `/users/${user}/mailboxes`)).results;
    const inbox = mailboxes.find(entry => entry.path === 'INBOX').id;

    const message = (
        await call(app, 'POST', `/users/${user}/mailboxes/${inbox}/messages`, {
            from: { address: `sender@${domain}` },
            to: [{ address: email }],
            subject: `Fuzz ${runId}`,
            text: 'Fuzz body',
            attachments: [{ filename: 'fuzz.txt', content: Buffer.from('fuzz attachment').toString('base64'), contentType: 'text/plain' }]
        })
    ).message.id;

    const address = (await call(app, 'GET', `/users/${user}/addresses`)).results[0].id;
    const filter = (await call(app, 'POST', `/users/${user}/filters`, { name: 'Fuzz', query: { subject: 'fuzz' }, action: { seen: true } })).id;
    const asp = (await call(app, 'POST', `/users/${user}/asps`, { description: 'Fuzz', scopes: ['imap'] })).id;
    const file = (await call(app, 'POST', `/users/${user}/storage`, { filename: 'fuzz.txt', contentType: 'text/plain', content: 'fuzz file' })).id;
    const label = (await call(app, 'POST', `/users/${user}/labels`, { name: `Label ${runId}` })).id;
    const queueId = (
        await call(app, 'POST', `/users/${user}/submit`, {
            to: [{ address: `rcpt@${domain}` }],
            subject: 'Fuzz',
            text: 'Fuzz',
            sendTime: new Date(Date.now() + 3600 * 1000).toISOString()
        })
    ).message.queueId;

    const domainListing = (await call(app, 'POST', `/domainaccess/${username}/allow`, { domain })).id;
    const alias = `alias${runId}.org`;
    const domainAlias = (await call(app, 'POST', '/domainaliases', { alias, domain })).id;
    const dkim = (await call(app, 'POST', '/dkim', { domain, selector: 'fuzz' })).id;
    const servername = `mail.${domain}`;
    const { keyPem, certPem } = generateSelfSignedPair(servername);
    const cert = (await call(app, 'POST', '/certs', { servername, privateKey: keyPem, cert: certPem })).id;
    // audits belong to the audit role, root holds no audit grants
    const auditToken = await createRoleToken('audit');
    const audit = (await call(app, 'POST', '/audit', { user, expires: new Date(Date.now() + 3600 * 1000).toISOString() }, auditToken.accessToken)).id;
    await deleteRoleToken(auditToken.tokenHash);

    const ids = { user, mailbox: inbox, filter, asp, file, audit };
    const path = {
        user,
        mailbox: inbox,
        message,
        attachment: 'ATT00001',
        address,
        filter,
        asp,
        file,
        label,
        queueId,
        tag: username,
        domain,
        alias: domainAlias,
        dkim,
        cert,
        servername,
        audit,
        username,
        key: 'const:max:storage'
    };

    const cleanup = async () => {
        // the user goes last, the domain level records first
        for (const url of [
            `/certs/${cert}`,
            `/dkim/${dkim}`,
            `/domainaliases/${domainAlias}`,
            `/domainaccess/${domainListing}`,
            `/users/${user}/outbound/${queueId}`
        ]) {
            await app.inject({ method: 'DELETE', url });
        }
        await app.inject({ method: 'DELETE', url: `/users/${user}` });
    };

    return { runId, domain, email, username, ids, path, cleanup };
}

module.exports = { createFixtures };
