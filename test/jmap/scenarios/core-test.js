/* eslint no-unused-expressions: 0 */
/* globals before: false, after: false */
'use strict';

// Catalogue file core.yaml: session, authentication, the request envelope, Core/echo and result references.

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const Redis = require('ioredis');
const speakeasy = require('speakeasy');
const { scenario, api, API_URL, accounts, seed, fixtures, clock, jmap } = require('../harness');
const instance = require('../harness/instance');
const redisUrl = require('../../../lib/redis-url');

const { JmapClient, forUser, basic, URN, JMAP_URL } = jmap;
const ERROR = 'urn:ietf:params:jmap:error:';
const SESSION_KEYS = ['capabilities', 'accounts', 'primaryAccounts', 'username', 'apiUrl', 'downloadUrl', 'uploadUrl', 'eventSourceUrl', 'state'];
// contacts and calendars are advertised from phases 5 and 6 (ABK-001, CAL-001)
const NOT_IMPLEMENTED = ['urn:ietf:params:jmap:websocket', 'urn:ietf:params:jmap:mdn', 'urn:ietf:params:jmap:principals'];

let redis;
const redisClient = () => {
    if (!redis) {
        redis = new Redis(typeof config.dbs.redis === 'string' ? redisUrl(config.dbs.redis) : config.dbs.redis);
    }
    return redis;
};
after(async () => {
    await instance.stopAll();
    if (redis) {
        redis.disconnect();
    }
});

// asserts an RFC 7807 problem details answer
function expectProblem(res, status, type) {
    expect(res.status, res.body.toString()).to.equal(status);
    expect(res.headers.get('content-type')).to.match(/^application\/problem\+json/);
    expect(res.json).to.be.an('object');
    expect(res.json.status).to.equal(status);
    if (type) {
        expect(res.json.type).to.equal(type.includes(':') ? type : ERROR + type);
    } else {
        expect(res.json.type).to.be.a('string');
    }
    expect(res.json).to.not.have.property('methodResponses');
    return res.json;
}

const expectChallenge = res => {
    expect(res.status).to.equal(401);
    const challenge = res.headers.get('www-authenticate') || '';
    expect(challenge).to.match(/\bBasic\b/);
    expect(challenge).to.match(/\bBearer\b/);
};

const echo = (args, callId = 'c1') => ({ using: [URN.core], methodCalls: [['Core/echo', args, callId]] });
const bearer = token => new JmapClient(`Bearer ${token}`);

// an http request with full control over headers and body writes; answers the request object and a promise of {status, headers, body}
function rawRequest(url, options) {
    const req = http.request(url, options);
    const response = new Promise((resolve, reject) => {
        req.on('response', res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
    response.catch(() => false);
    return { req, response };
}

// a Core/echo body of exactly `size` octets
function paddedEcho(size) {
    const skeleton = JSON.stringify(echo({ pad: '' }));
    return Buffer.from(JSON.stringify(echo({ pad: 'x'.repeat(size - Buffer.byteLength(skeleton)) })));
}

describe('JMAP core (core.yaml)', () => {
    let user;
    let client;
    let session;
    let other;

    before(async () => {
        // in process instances log through npmlog; keep their lines out of the test output
        instance.captureLog();
        user = await accounts.createUser();
        other = await accounts.createUser();
        client = forUser(user);
        session = await client.session();
    });

    describe('Session', () => {
        scenario('CORE-001', async () => {
            const res = await client.raw('/.well-known/jmap');
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type')).to.match(/^application\/json/);
            expect(res.json).to.be.an('object');
            expect(res.json).to.include.all.keys(SESSION_KEYS);
        });

        scenario('CORE-002', async () => {
            const res = await new JmapClient(null).raw('/.well-known/jmap');
            expectChallenge(res);
            for (const key of SESSION_KEYS) {
                expect(res.json || {}).to.not.have.property(key);
            }
        });

        scenario('CORE-003', async () => {
            for (const key of ['capabilities', 'accounts', 'primaryAccounts']) {
                expect(session[key], key).to.be.an('object');
            }
            for (const key of ['username', 'apiUrl', 'downloadUrl', 'uploadUrl', 'eventSourceUrl', 'state']) {
                expect(session[key], key).to.be.a('string');
            }
            expect(session.state).to.not.equal('');
        });

        scenario('CORE-004', async () => {
            const core = session.capabilities[URN.core];
            for (const key of [
                'maxSizeUpload',
                'maxConcurrentUpload',
                'maxSizeRequest',
                'maxConcurrentRequests',
                'maxCallsInRequest',
                'maxObjectsInGet',
                'maxObjectsInSet'
            ]) {
                expect(Number.isInteger(core[key]) && core[key] >= 0, key).to.be.true;
                expect(core[key], key).to.equal(config.jmap.limits[key]);
            }
            expect(core.collationAlgorithms).to.be.an('array');
            expect(core.collationAlgorithms.every(value => typeof value === 'string')).to.be.true;
        });

        scenario('CORE-005', async () => {
            const core = session.capabilities[URN.core];
            expect(core.maxConcurrentUpload).to.be.at.least(4);
            expect(core.maxSizeRequest).to.be.at.least(10000000);
            expect(core.maxConcurrentRequests).to.be.at.least(4);
            expect(core.maxCallsInRequest).to.be.at.least(16);
            expect(core.maxObjectsInGet).to.be.at.least(500);
            expect(core.maxObjectsInSet).to.be.at.least(500);
            expect(core.maxSizeUpload).to.equal(config.jmap.limits.maxSizeUpload);
            const mail = session.accounts[client.accountId].accountCapabilities[URN.mail];
            expect(core.maxSizeUpload).to.be.at.least(mail.maxSizeAttachmentsPerEmail);
        });

        scenario('CORE-006', async () => {
            const { collationAlgorithms } = session.capabilities[URN.core];
            for (const collation of collationAlgorithms) {
                // RFC 4790 registry identifiers
                expect(collation).to.match(/^i;[a-z0-9-]+$/);
            }
            const unlisted = 'i;octet-fake';
            expect(collationAlgorithms).to.not.include(unlisted);
            const err = await client.method('Email/query', { sort: [{ property: 'subject', collation: unlisted }] }).catch(e => e);
            expect(err.type).to.equal('unsupportedSort');
        });

        scenario('CORE-007', async () => {
            expect(session.capabilities[URN.mail]).to.deep.equal({});
        });

        scenario('CORE-008', async () => {
            const res = await client.raw('/.well-known/jmap');
            const ids = Object.keys(res.json.accounts);
            expect(ids).to.deep.equal([`u${user.id}`]);
            const account = res.json.accounts[ids[0]];
            expect(account.name).to.equal(user.address);
            expect(account.isPersonal).to.be.true;
            expect(account.isReadOnly).to.be.false;
            expect(account.accountCapabilities).to.be.an('object');
            expect(res.body.toString()).to.not.include(other.id);
        });

        scenario('CORE-009', async () => {
            const [accountId] = Object.keys(session.accounts);
            expect(accountId).to.equal(`u${user.id}`);
            expect(accountId).to.match(/^u[0-9a-f]{24}$/);
            expect(Buffer.byteLength(accountId)).to.equal(25);
            expect(accountId).to.match(/^[A-Za-z][A-Za-z0-9_-]*$/);
        });

        scenario('CORE-010', async () => {
            const mail = session.accounts[client.accountId].accountCapabilities[URN.mail];
            expect(mail.maxMailboxesPerEmail).to.equal(1);
            expect(mail.maxMailboxDepth).to.equal(128);
            expect(Number.isInteger(mail.maxSizeMailboxName) && mail.maxSizeMailboxName >= 100).to.be.true;
            expect(Number.isInteger(mail.maxSizeAttachmentsPerEmail) && mail.maxSizeAttachmentsPerEmail > 0).to.be.true;
            expect(mail.maxSizeAttachmentsPerEmail).to.be.at.most(64 * 1024 * 1024);
            expect(mail.mayCreateTopLevelMailbox).to.be.true;
            expect(mail.emailQuerySortOptions).to.be.an('array');
            expect(mail.emailQuerySortOptions.every(value => typeof value === 'string')).to.be.true;
        });

        scenario('CORE-011', async () => {});

        scenario('CORE-015', async () => {
            const accountCapabilities = session.accounts[client.accountId].accountCapabilities;
            for (const urn of Object.keys(accountCapabilities)) {
                expect(session.capabilities).to.have.property(urn);
            }
            for (const urn of NOT_IMPLEMENTED) {
                expect(session.capabilities, urn).to.not.have.property(urn);
            }
            // every advertised URN is accepted in using
            const res = await client.request({ using: Object.keys(session.capabilities), methodCalls: [] });
            expect(res.status).to.equal(200);
        });

        scenario('CORE-016', async () => {
            const accountCapabilities = session.accounts[client.accountId].accountCapabilities;
            expect(session.primaryAccounts[URN.mail]).to.equal(client.accountId);
            for (const [urn, accountId] of Object.entries(session.primaryAccounts)) {
                expect(accountCapabilities, urn).to.have.property(urn);
                expect(accountId).to.equal(client.accountId);
            }
            expect(session.primaryAccounts).to.not.have.property(URN.core);
        });

        scenario('CORE-017', async () => {
            const address = `other${crypto.randomBytes(4).toString('hex')}@example.com`;
            const named = await accounts.createUser({ address });
            expect(address.split('@')[0]).to.not.equal(named.username);
            for (const login of [named.username, address]) {
                const res = await new JmapClient(basic(login, named.password)).raw('/.well-known/jmap');
                expect(res.status).to.equal(200);
                expect(res.json.username).to.equal(named.username);
                expect(res.json.accounts[`u${named.id}`].name).to.equal(address);
            }
        });

        scenario('CORE-018', async () => {
            const { app, port } = await instance.startInstance(port => ({ baseUrl: `http://localhost:${port}` }));
            const base = `http://localhost:${port}`;
            const res = await new JmapClient(client.authorization).raw(`http://127.0.0.1:${port}/.well-known/jmap`, {
                headers: { Host: 'attacker.example', 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'https' }
            });
            expect(res.status).to.equal(200);
            for (const key of ['apiUrl', 'downloadUrl', 'uploadUrl', 'eventSourceUrl']) {
                expect(res.json[key].startsWith(`${base}/`), key).to.be.true;
            }
            const echoed = await client.raw(res.json.apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(echo({ a: 1 }))
            });
            expect(echoed.status).to.equal(200);
            expect(echoed.json.methodResponses).to.deep.equal([['Core/echo', { a: 1 }, 'c1']]);
            await instance.stopInstance(app);
        });

        scenario('CORE-019', async () => {
            const url = session.downloadUrl;
            for (const variable of ['{accountId}', '{blobId}', '{name}', '{type}']) {
                expect(url).to.include(variable);
            }
            // level 1: only {name} expressions, no operators
            const expressions = url.match(/\{[^}]*\}/g);
            expect(expressions.every(expression => /^\{[A-Za-z]+\}$/.test(expression))).to.be.true;
            const [, query] = url.split('?');
            expect(query).to.include('{type}');
        });

        scenario('CORE-020', async () => {
            expect(session.uploadUrl).to.be.a('string');
            expect(session.uploadUrl.match(/\{[^}]*\}/g)).to.deep.equal(['{accountId}']);
        });

        scenario('CORE-021', async () => {
            for (const variable of ['{types}', '{closeafter}', '{ping}']) {
                expect(session.eventSourceUrl).to.include(variable);
            }
        });

        scenario('CORE-022', async () => {
            const owner = await accounts.createUser();
            const ownerClient = forUser(owner);
            const { state } = await ownerClient.session();
            await seed.deliver(owner.address, await fixtures.buildMessage({ to: owner.address }));
            await seed.withImap(owner, async imap => {
                await imap.mailboxOpen('INBOX');
                await clock.waitFor(async () => (await imap.status('INBOX', { messages: true })).messages === 1);
                await imap.messageFlagsAdd('1:*', ['\\Seen']);
            });
            expect((await ownerClient.session()).state).to.equal(state);
            const token = await accounts.createToken(owner);
            expect((await bearer(token).session()).state).to.equal(state);
        });

        scenario('CORE-023', async () => {
            const owner = await accounts.createUser();
            const ownerClient = forUser(owner);
            const before = (await ownerClient.session()).state;
            const address = `renamed${crypto.randomBytes(4).toString('hex')}@example.com`;
            await api('POST', `/users/${owner.id}/addresses`, { address, main: true });
            const changed = await ownerClient.session();
            expect(changed.accounts[`u${owner.id}`].name).to.equal(address);
            expect(changed.state).to.not.equal(before);
            const res = await ownerClient.request(echo({}));
            expect(res.json.sessionState).to.equal(changed.state);
        });

        scenario('CORE-024', async () => {
            const res = await client.raw('/.well-known/jmap');
            const cacheControl = res.headers.get('cache-control') || '';
            for (const directive of ['no-cache', 'no-store', 'must-revalidate']) {
                expect(cacheControl).to.include(directive);
            }
            expect(res.headers.get('etag')).to.be.null;
            expect(res.headers.get('last-modified')).to.be.null;
            const conditional = await client.raw('/.well-known/jmap', {
                headers: { 'If-None-Match': '*', 'If-Modified-Since': new Date(Date.now() + 3600 * 1000).toUTCString() }
            });
            expect(conditional.status).to.equal(200);
        });

        scenario('CORE-025', async () => {
            const res = await client.raw('/.well-known/jmap/');
            expect(res.status).to.equal(200);
            expect(res.json).to.deep.equal(await client.session());
        });

        scenario('CORE-026', async () => {
            for (const method of ['POST', 'PUT', 'DELETE']) {
                const res = await client.raw('/.well-known/jmap', { method });
                expect(res.status, method).to.equal(405);
                expect(res.headers.get('allow')).to.match(/\bGET\b/);
                expect(res.json || {}).to.not.have.property('capabilities');
                expect(res.json || {}).to.not.have.property('accounts');
            }
        });

        scenario('CORE-027', async () => {
            const { app, port } = await instance.startInstance({ enabled: false });
            expect(app).to.be.false;
            const before = await redisClient().get(`auth_user:${user.id}`);
            for (const [path, init] of [
                ['/.well-known/jmap', {}],
                ['/jmap/api/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(echo({})) }]
            ]) {
                const res = await client.raw(`http://127.0.0.1:${port}${path}`, init).catch(err => err);
                // nothing listens: the connection is refused
                expect(res).to.be.an('error');
            }
            expect(await redisClient().get(`auth_user:${user.id}`)).to.equal(before);
        });
    });

    describe('Auth', () => {
        scenario('CORE-028', async () => {
            const token = await accounts.createToken(user);
            const tokenClient = bearer(token);
            const res = await tokenClient.request(echo({ hello: true }));
            expect(res.status).to.equal(200);
            expect(res.json.methodResponses).to.deep.equal([['Core/echo', { hello: true }, 'c1']]);
            expect(Object.keys((await tokenClient.session()).accounts)).to.deep.equal([`u${user.id}`]);
        });

        scenario('CORE-029', async () => {
            for (const token of [crypto.randomBytes(30).toString('base64url').slice(0, 40), '']) {
                const res = await new JmapClient(`Bearer ${token}`).request(echo({ hello: true }));
                expectChallenge(res);
                expectProblem(res, 401);
            }
        });

        scenario('CORE-030', async () => {
            const token = await accounts.createToken(user);
            expect((await bearer(token).request(echo({}))).status).to.equal(200);
            await api('DELETE', '/authenticate', null, { headers: { 'X-Access-Token': token } });
            expect((await bearer(token).request(echo({}))).status).to.equal(401);
        });

        // A token record for the user written straight to Redis, signed like UserHandler.setAuthToken signs,
        // with `fields` over those of a token POST /authenticate issued (null removes a field)
        async function craftedToken(owner, fields) {
            const issued = await accounts.createToken(owner);
            const record = await redisClient().hgetall(`tn:token:${crypto.createHash('sha256').update(issued).digest('hex')}`);
            const data = Object.assign({}, record, fields);
            Object.keys(data)
                .filter(key => data[key] === null)
                .forEach(key => delete data[key]);
            const token = crypto.randomBytes(20).toString('hex');
            const signed = { token, user: data.user, authVersion: Number(data.authVersion) || 0, role: data.role };
            for (const key of ['mfaRequired', 'mfaVerified', 'passwordChangeRequired'].filter(key => key in data)) {
                signed[key] = data[key];
            }
            data.s = crypto.createHmac('sha256', config.api.accessControl.secret).update(JSON.stringify(signed)).digest('hex');
            const key = `tn:token:${crypto.createHash('sha256').update(token).digest('hex')}`;
            await redisClient().multi().hset(key, data).expire(key, 3600).exec();
            return { issued, token };
        }

        // the session resource and an API request are both refused with the challenges
        async function expectRefusedToken(token) {
            const sessionRes = await bearer(token).raw('/.well-known/jmap');
            expectChallenge(sessionRes);
            expect(sessionRes.json || {}).to.not.have.property('accounts');
            expectChallenge(await bearer(token).request(echo({})));
        }

        scenario('CORE-140', async () => {
            const owner = await accounts.createUser();
            const { issued, token } = await craftedToken(owner, { role: 'api:read' });
            expect((await bearer(issued).raw('/.well-known/jmap')).status).to.equal(200);
            expect((await bearer(issued).request(echo({}))).status).to.equal(200);
            await expectRefusedToken(token);
        });

        scenario('CORE-141', async () => {
            const owner = await accounts.createUser();
            const legacy = { mfaRequired: null, mfaVerified: null, passwordChangeRequired: null };
            const { token } = await craftedToken(owner, legacy);
            const { token: endless } = await craftedToken(owner, Object.assign({ ttl: null }, legacy));
            // the REST API still takes the token
            const me = await fetch(`${API_URL}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
            expect(me.status).to.equal(200);
            await expectRefusedToken(token);
            await expectRefusedToken(endless);
        });

        scenario('CORE-031', async () => {
            for (const login of [user.username, user.address]) {
                const res = await new JmapClient(basic(login, user.password)).request(echo({}));
                expect(res.status, login).to.equal(200);
            }
        });

        // a user with TOTP enabled
        async function userWith2fa() {
            const owner = await accounts.createUser();
            const { seed: secret } = await api('POST', `/users/${owner.id}/2fa/totp/setup`, { issuer: 'JMAP scenario' });
            await api('POST', `/users/${owner.id}/2fa/totp/enable`, { token: speakeasy.totp({ secret, encoding: 'base32' }) });
            return owner;
        }

        scenario('CORE-032', async () => {
            const owner = await userWith2fa();
            const res = await forUser(owner).request(echo({}));
            expectChallenge(res);
            // counted like any other failed login
            expect(Number(await redisClient().get(`auth_user:${owner.id}`))).to.equal(1);
        });

        scenario('CORE-033', async () => {
            const owner = await userWith2fa();
            const password = await accounts.createAsp(owner, ['jmap']);
            const res = await new JmapClient(basic(owner.username, password)).request(echo({}));
            expect(res.status).to.equal(200);
        });

        scenario('CORE-034', async () => {
            const password = await accounts.createAsp(user, ['*']);
            expect((await new JmapClient(basic(user.username, password)).request(echo({}))).status).to.equal(200);
        });

        scenario('CORE-035', async () => {
            const owner = await accounts.createUser();
            const password = await accounts.createAsp(owner, ['imap', 'smtp']);
            expect((await new JmapClient(basic(owner.username, password)).request(echo({}))).status).to.equal(401);
            await seed.withImap({ username: owner.username, password }, async imap => {
                expect(imap.authenticated).to.be.ok;
            });
        });

        scenario('CORE-036', async () => {
            const owner = await accounts.createUser();
            const wrong = await new JmapClient(basic(owner.username, 'not the password')).request(echo({}));
            const unknown = await new JmapClient(basic(`nobody${crypto.randomBytes(6).toString('hex')}`, 'not the password')).request(echo({}));
            expect(wrong.status).to.equal(401);
            expect(unknown.status).to.equal(wrong.status);
            const headers = res => Object.fromEntries([...res.headers].filter(([name]) => !['date'].includes(name)));
            expect(headers(unknown)).to.deep.equal(headers(wrong));
            expect(unknown.body.toString()).to.equal(wrong.body.toString());
        });

        scenario('CORE-037', async () => {
            for (const flag of ['disabled', 'suspended']) {
                const owner = await accounts.createUser();
                const token = await accounts.createToken(owner);
                await api('PUT', `/users/${owner.id}`, { [flag]: true });
                for (const credential of [forUser(owner), bearer(token)]) {
                    const sessionRes = await credential.raw('/.well-known/jmap');
                    expect(sessionRes.status, flag).to.equal(401);
                    expect(sessionRes.json || {}).to.not.have.property('accounts');
                    const apiRes = await credential.request(echo({ probe: true }));
                    expect(apiRes.status, flag).to.equal(401);
                    expect(apiRes.json || {}).to.not.have.property('methodResponses');
                }
            }
        });

        scenario('CORE-038', async () => {
            const owner = await accounts.createUser();
            const asp = await accounts.createAsp(owner, ['*']);
            const token = await accounts.createToken(owner);
            await api('PUT', `/users/${owner.id}`, { disabledScopes: ['jmap'] });
            for (const credential of [forUser(owner), new JmapClient(basic(owner.username, asp)), bearer(token)]) {
                expect((await credential.request(echo({}))).status).to.equal(401);
            }
            for (const password of [owner.password, asp]) {
                await seed.withImap({ username: owner.username, password }, async imap => expect(imap.authenticated).to.be.ok);
            }
        });

        // ends the failure window of a user at once, in place of waiting 120 seconds
        const expireWindow = async owner => {
            await redisClient().pexpire(`auth_user:${owner.id}`, 1);
            await clock.waitFor(async () => !(await redisClient().exists(`auth_user:${owner.id}`)));
        };

        scenario('CORE-039', async () => {
            const owner = await accounts.createUser();
            for (let i = 0; i < 12; i++) {
                expect((await new JmapClient(basic(owner.username, `wrong-${i}`)).request(echo({}))).status, `attempt ${i + 1}`).to.equal(401);
            }
            const locked = await forUser(owner).request(echo({}));
            expectProblem(locked, 429, 'limit');
            await expireWindow(owner);
            expect((await forUser(owner).request(echo({}))).status).to.equal(200);
        });

        scenario('CORE-040', async () => {
            const owner = await accounts.createUser();
            for (let i = 0; i < 6; i++) {
                const err = await seed.imap({ username: owner.username, password: `wrong-${i}` }).catch(e => e);
                expect(err).to.be.an('error');
                expect((await new JmapClient(basic(owner.username, `wrong-${i}`)).request(echo({}))).status).to.equal(401);
            }
            expectProblem(await forUser(owner).request(echo({})), 429, 'limit');
            const err = await seed.imap(owner).catch(e => e);
            expect(err).to.be.an('error');
            expect(err.responseStatus).to.equal('NO');
            expect(err.serverResponseCode).to.equal('RATELIMITEDERROR');
        });

        scenario('CORE-041', async () => {
            const owner = await accounts.createUser();
            expect((await forUser(owner).request(echo({}))).status).to.equal(200);
            for (let i = 0; i < 12; i++) {
                expect((await new JmapClient(basic(owner.username, `wrong-${i}`)).request(echo({}))).status).to.equal(401);
            }
            // every wrong attempt was evaluated and counted
            expect(Number(await redisClient().get(`auth_user:${owner.id}`))).to.equal(12);
            expectProblem(await forUser(owner).request(echo({})), 429, 'limit');
        });

        scenario('CORE-042', async () => {
            const owner = await accounts.createUser();
            expect((await forUser(owner).request(echo({}))).status).to.equal(200);
            const changed = 'Changed-' + crypto.randomBytes(8).toString('hex');
            await api('PUT', `/users/${owner.id}`, { password: changed });
            expect((await forUser(owner).request(echo({}))).status).to.equal(401);
            expect((await new JmapClient(basic(owner.username, changed)).request(echo({}))).status).to.equal(200);
        });

        scenario('CORE-043', async () => {
            const owner = await accounts.createUser();
            const password = await accounts.createAsp(owner, ['jmap']);
            const aspClient = new JmapClient(basic(owner.username, password));
            expect((await aspClient.request(echo({}))).status).to.equal(200);
            const { results } = await api('GET', `/users/${owner.id}/asps`);
            await api('DELETE', `/users/${owner.id}/asps/${results[0].id}`);
            expect((await aspClient.request(echo({}))).status).to.equal(401);
        });

        scenario('CORE-044', async () => {
            for (const change of [{ disabled: true }, { disabledScopes: ['jmap'] }]) {
                const owner = await accounts.createUser();
                const token = await accounts.createToken(owner);
                const credentials = [forUser(owner), bearer(token)];
                for (const credential of credentials) {
                    expect((await credential.request(echo({}))).status).to.equal(200);
                }
                await api('PUT', `/users/${owner.id}`, change);
                for (const credential of credentials) {
                    expect((await credential.request(echo({}))).status, JSON.stringify(change)).to.equal(401);
                }
            }
        });

        scenario('CORE-045', async () => {
            const res = await new JmapClient(null).request(echo({ hello: true }));
            expectChallenge(res);
            expectProblem(res, 401);
        });

        scenario('CORE-046', async () => {
            const b64 = value => Buffer.from(value).toString('base64');
            const values = [
                'Basic',
                'Basic !!!not*base64%%%',
                `Basic ${b64(user.username + user.password)}`,
                `Basic ${b64(':' + user.password)}`,
                `Digest ${b64(user.username + ':' + user.password)}`,
                `Basic ${'A'.repeat(10 * 1024)}`
            ];
            for (const value of values) {
                const res = await new JmapClient(value).request(echo({}));
                expect(res.status < 500, value.slice(0, 40)).to.be.true;
                if (value.length > 10000) {
                    expect(res.status).to.be.oneOf([400, 401]);
                } else {
                    expect(res.status, value.slice(0, 40)).to.equal(401);
                }
                expectProblem(res, res.status);
            }
        });

        scenario('CORE-047', async () => {
            const token = await accounts.createToken(user);
            const credential = Buffer.from(`${user.username}:${user.password}`).toString('base64');
            for (const value of [`bAsIc ${credential}`, `BASIC ${credential}`, `bearer ${token}`]) {
                expect((await new JmapClient(value).request(echo({}))).status, value.split(' ')[0]).to.equal(200);
            }
        });

        scenario('CORE-048', async () => {
            const tag = crypto.randomBytes(4).toString('hex');
            const password = `pa:ss wörd ✓ ${tag} %41`;
            const users = [
                await accounts.createUser({ address: `plus${tag}+tagged@example.com` }),
                await accounts.createUser({ address: `per${tag}%cent@example.com` }),
                await accounts.createUser({ password })
            ];
            for (const owner of users) {
                expect((await new JmapClient(basic(owner.address, owner.password)).request(echo({}))).status, owner.address).to.equal(200);
            }
            expect((await new JmapClient(basic(users[2].username, password)).request(echo({}))).status).to.equal(200);
        });

        scenario('CORE-049', async () => {
            const token = await accounts.createToken(user);
            const body = JSON.stringify(echo({ executed: true }));
            const { req, response } = rawRequest(`${JMAP_URL}/jmap/api/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    Authorization: [basic(user.username, user.password), `Bearer ${token}`]
                }
            });
            req.end(body);
            const res = await response;
            expect(res.status).to.equal(400);
            expect(res.headers['content-type']).to.match(/^application\/problem\+json/);
            const problem = JSON.parse(res.body);
            expect(problem.status).to.equal(400);
            expect(problem).to.not.have.property('methodResponses');
        });

        scenario('CORE-050', async () => {
            const owner = await accounts.createUser();
            await seed.deliver(owner.address, await fixtures.buildMessage({ to: owner.address }));
            const ownerClient = forUser(owner);
            const { ids } = await clock.waitFor(async () => {
                const result = await ownerClient.method('Email/query', {});
                return result.ids.length && result;
            });
            const { list } = await ownerClient.method('Email/get', { ids, properties: ['blobId'] });
            const anonymous = new JmapClient(null);
            const accountId = `u${owner.id}`;
            const requests = [
                ['/.well-known/jmap', {}],
                ['/jmap/api/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(echo({})) }],
                [`/jmap/upload/${accountId}/`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'upload' }],
                [`/jmap/download/${accountId}/${list[0].blobId}/message.eml?type=message/rfc822`, {}],
                [`/jmap/download/${accountId}/Bm${'0'.repeat(24)}/missing.eml?type=message/rfc822`, {}],
                ['/jmap/eventsource/?types=*&closeafter=state&ping=0', {}]
            ];
            for (const [path, init] of requests) {
                const res = await anonymous.raw(path, init);
                expect(res.status, path).to.equal(401);
                expectChallenge(res);
            }
        });

        scenario('CORE-051', async () => {
            const token = await accounts.createToken(user);
            const anonymous = new JmapClient(null);
            const init = headers => ({
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
                body: JSON.stringify(echo({}))
            });
            expect((await anonymous.raw(`/jmap/api/?accessToken=${token}`, init())).status).to.equal(401);
            expect((await anonymous.raw('/jmap/api/', init({ 'X-Access-Token': token }))).status).to.equal(401);
        });

        scenario('CORE-052', async () => {
            // the test configuration has no master token, so an instance is started with one
            const previous = config.api.accessToken;
            const masterToken = crypto.randomBytes(20).toString('hex');
            config.api.accessToken = masterToken;
            try {
                const started = await instance.startInstance();
                const res = await bearer(masterToken).raw(`${started.url}/.well-known/jmap`);
                expectChallenge(res);
                expectProblem(res, 401);
                expect(res.json).to.not.have.property('accounts');
                await instance.stopInstance(started.app);
            } finally {
                config.api.accessToken = previous;
            }
        });
    });

    describe('Request', () => {
        scenario('CORE-053', async () => {
            const res = await client.request(echo({ hello: true }));
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type')).to.match(/^application\/json/);
            expect(res.json.methodResponses).to.deep.equal([['Core/echo', { hello: true }, 'c1']]);
            expect(res.json.sessionState).to.be.a('string');
            expect(res.json).to.not.have.property('createdIds');
        });

        scenario('CORE-054', async () => {
            const callIds = ['first', '', 'with spaces # and ümlaut ✓ 𝄞'];
            const res = await client.request({ using: [URN.core], methodCalls: callIds.map(callId => ['Core/echo', {}, callId]) });
            expect(res.json.methodResponses.map(entry => entry[2])).to.deep.equal(callIds);
        });

        scenario('CORE-055', async () => {
            const responses = await client.call([
                ['Mailbox/get', { accountId: true, ids: [] }, 'call1'],
                ['Core/echo', {}, 'call2'],
                ['Fake/nonexistent', {}, 'call3']
            ]);
            expect(responses.map(entry => [entry[0], entry[2]])).to.deep.equal([
                ['Mailbox/get', 'call1'],
                ['Core/echo', 'call2'],
                ['error', 'call3']
            ]);
            expect(responses[2][1].type).to.equal('unknownMethod');
        });

        scenario('CORE-056', async () => {
            const responses = await client.call([
                ['Mailbox/get', { accountId: true, ids: 'not-an-array' }, 'a'],
                ['Mailbox/get', { accountId: true, ids: null }, 'b']
            ]);
            expect(responses[0][0]).to.equal('error');
            expect(responses[0][1].type).to.equal('invalidArguments');
            expect(responses[1][0]).to.equal('Mailbox/get');
            expect(responses[1][1].list).to.be.an('array').that.is.not.empty;
        });

        scenario('CORE-058', async () => {
            const { state } = await client.session();
            const ok = await client.request(echo({}));
            expect(ok.json.sessionState).to.equal(state);
            const failing = await client.request({
                using: [URN.core, URN.mail],
                methodCalls: [
                    ['Fake/method', {}, 'a'],
                    ['Mailbox/get', {}, 'b']
                ]
            });
            expect(failing.json.methodResponses.every(entry => entry[0] === 'error')).to.be.true;
            expect(failing.json.sessionState).to.equal(state);
        });

        scenario('CORE-059', async () => {
            const res = await client.request({ using: [URN.core], methodCalls: [] });
            expect(res.status).to.equal(200);
            expect(res.json.methodResponses).to.deep.equal([]);
            expect(res.json.sessionState).to.be.a('string');
        });

        scenario('CORE-060', async () => {
            const res = await client.request({ using: Object.keys(session.capabilities), methodCalls: [['Core/echo', { x: 1 }, 'c']] });
            expect(res.status).to.equal(200);
            expect(res.json.methodResponses).to.deep.equal([['Core/echo', { x: 1 }, 'c']]);
        });

        scenario('CORE-061', async () => {
            const responses = await client.call(
                [
                    ['Mailbox/get', { accountId: true }, 'a'],
                    ['Email/query', { accountId: true }, 'b']
                ],
                [URN.core]
            );
            expect(responses).to.deep.equal([
                ['error', { type: 'unknownMethod' }, 'a'],
                ['error', { type: 'unknownMethod' }, 'b']
            ]);
        });

        scenario('CORE-062', async () => {
            for (const using of [[], [URN.mail]]) {
                const res = await client.request({ using, methodCalls: [['Core/echo', {}, 'c']] });
                expect(res.status).to.equal(200);
                expect(res.json.methodResponses[0][0]).to.equal('error');
                expect(res.json.methodResponses[0][1].type).to.equal('unknownMethod');
            }
        });

        scenario('CORE-063', async () => {
            const res = await client.request(Object.assign(echo({ a: 1 }), { futureThing: { nested: true } }));
            expect(res.status).to.equal(200);
            expect(res.json.methodResponses).to.deep.equal([['Core/echo', { a: 1 }, 'c1']]);
            expect(res.json).to.not.have.property('futureThing');
        });

        scenario('CORE-064', async () => {
            const res = await client.request({
                using: [URN.core, URN.mail],
                methodCalls: [
                    ['Fake/method', {}, 'a'],
                    ['Mailbox/get', {}, 'b'],
                    ['Mailbox/get', { accountId: 'unknown-account' }, 'c']
                ]
            });
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type')).to.match(/^application\/json/);
            expect(res.json.methodResponses.map(entry => entry[0])).to.deep.equal(['error', 'error', 'error']);
            expect(res.json.methodResponses.map(entry => entry[1].type)).to.deep.equal(['unknownMethod', 'invalidArguments', 'accountNotFound']);
            expect(res.json).to.not.have.property('status');
        });

        scenario('CORE-067', async () => {
            const { list } = await client.method('Mailbox/get', { ids: null, properties: ['id'] });
            const mailboxId = list[0].id;
            const res = await client.request({
                using: [URN.core, URN.mail],
                createdIds: { k1: mailboxId },
                methodCalls: [['Mailbox/get', { accountId: client.accountId, ids: ['#k1'], properties: ['id'] }, 'a']]
            });
            expect(res.json.methodResponses[0][0]).to.equal('Mailbox/get');
            expect(res.json.methodResponses[0][1].list.map(mailbox => mailbox.id)).to.deep.equal([mailboxId]);
            expect(res.json.createdIds.k1).to.equal(mailboxId);
        });

        scenario('CORE-069', async () => {
            for (const createdIds of ['bogus', { k1: 42 }]) {
                const res = await client.request(Object.assign(echo({ executed: true }), { createdIds }));
                expectProblem(res, 400, 'notRequest');
            }
        });

        scenario('CORE-073', async () => {
            const result = await client.method('Mailbox/get', { ids: ['#nosuch'] });
            expect(result.list).to.deep.equal([]);
            expect(result.notFound).to.deep.equal(['#nosuch']);
        });

        scenario('CORE-074', async () => {
            const valid = JSON.stringify(echo({ hello: true }));
            for (const body of ['this is not json', valid.slice(0, Math.floor(valid.length / 2)), '']) {
                const res = await client.request(body);
                expectProblem(res, 400, 'notJSON');
            }
        });

        scenario('CORE-075', async () => {
            const body = JSON.stringify(echo({ hello: true }));
            const textPlain = await client.raw('/jmap/api/', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
            expectProblem(textPlain, 400, 'notJSON');
            // fetch adds a content type for string bodies, so the request without one is sent as raw bytes
            const none = await client.raw('/jmap/api/', { method: 'POST', body: Buffer.from(body) });
            expectProblem(none, 400, 'notJSON');
        });

        scenario('CORE-076', async () => {
            for (const type of ['application/json; charset=utf-8', 'APPLICATION/JSON']) {
                const res = await client.request(echo({ hello: true }), { 'Content-Type': type });
                expect(res.status, type).to.equal(200);
                expect(res.json.methodResponses).to.deep.equal([['Core/echo', { hello: true }, 'c1']]);
            }
        });

        scenario('CORE-077', async () => {
            const bodies = [{ foo: 'bar' }, [], 'a string', null, { using: [URN.core] }, { methodCalls: [] }];
            for (const body of bodies) {
                const res = await client.request(JSON.stringify(body));
                expectProblem(res, 400, 'notRequest');
            }
        });

        scenario('CORE-078', async () => {
            const bodies = [
                { using: [URN.core], methodCalls: 'Core/echo' },
                { using: [URN.core], methodCalls: { a: ['Core/echo', {}, 'c'] } },
                { using: URN.core, methodCalls: [] },
                { using: [URN.core, 42], methodCalls: [] }
            ];
            for (const body of bodies) {
                expectProblem(await client.request(body), 400, 'notRequest');
            }
        });

        scenario('CORE-079', async () => {
            const bad = [
                ['Core/echo', {}],
                ['Core/echo', {}, 'c', 'extra'],
                { name: 'Core/echo' },
                [42, {}, 'c'],
                ['Core/echo', [], 'c'],
                ['Core/echo', {}, 42]
            ];
            for (const entry of bad) {
                const res = await client.request({ using: [URN.core], methodCalls: [['Core/echo', { executed: true }, 'ok'], entry] });
                expectProblem(res, 400, 'notRequest');
            }
        });

        scenario('CORE-080', async () => {
            const res = await client.request({ using: [URN.core, 'urn:fake:nonexistent'], methodCalls: [['Core/echo', {}, 'c']] });
            const problem = expectProblem(res, 400, 'unknownCapability');
            expect(problem.detail).to.include('urn:fake:nonexistent');
        });

        scenario('CORE-081', async () => {
            const mdn = 'urn:ietf:params:jmap:mdn';
            for (const urn of NOT_IMPLEMENTED) {
                expect(session.capabilities).to.not.have.property(urn);
            }
            const res = await client.request({ using: [URN.core, URN.mail, mdn], methodCalls: [['Mailbox/get', { accountId: client.accountId }, 'c']] });
            expectProblem(res, 400, 'unknownCapability');
        });

        scenario('CORE-082', async () => {
            const { maxCallsInRequest } = session.capabilities[URN.core];
            const responses = [
                await client.request('{not json'),
                await client.request({ foo: 1 }),
                await client.request({ using: ['urn:fake:x'], methodCalls: [] }),
                await client.request({ using: [URN.core], methodCalls: Array.from({ length: maxCallsInRequest + 1 }, (v, i) => ['Core/echo', {}, `c${i}`]) })
            ];
            for (const res of responses) {
                expect(res.status).to.be.within(400, 499);
                const problem = expectProblem(res, res.status);
                expect(Number.isInteger(problem.status)).to.be.true;
                for (const key of ['title', 'detail']) {
                    if (key in problem) {
                        expect(problem[key]).to.be.a('string');
                    }
                }
            }
        });

        scenario('CORE-083', async () => {
            const { maxSizeRequest } = session.capabilities[URN.core];
            const body = paddedEcho(maxSizeRequest + 1);
            const res = await client.request(body);
            const problem = expectProblem(res, 413, 'limit');
            expect(problem.limit).to.equal('maxSizeRequest');

            // chunked, without Content-Length: the limit is crossed while reading
            const { req, response } = rawRequest(`${JMAP_URL}/jmap/api/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: client.authorization, 'Transfer-Encoding': 'chunked' }
            });
            for (let offset = 0; offset < body.length; offset += 1024 * 1024) {
                req.write(body.subarray(offset, offset + 1024 * 1024));
            }
            req.end();
            const chunked = await response;
            expect(chunked.status).to.equal(413);
            const chunkedProblem = JSON.parse(chunked.body);
            expect(chunkedProblem.type).to.equal(ERROR + 'limit');
            expect(chunkedProblem.limit).to.equal('maxSizeRequest');
        });

        scenario('CORE-084', async () => {
            const { maxSizeRequest } = session.capabilities[URN.core];
            const body = paddedEcho(maxSizeRequest);
            expect(body.length).to.equal(maxSizeRequest);
            const res = await client.request(body);
            expect(res.status).to.equal(200);
            expect(res.json.methodResponses).to.deep.equal(JSON.parse(body).methodCalls);
        });

        scenario('CORE-085', async () => {
            const { maxCallsInRequest } = session.capabilities[URN.core];
            const calls = count => Array.from({ length: count }, (v, i) => ['Core/echo', { i }, `c${i}`]);
            const ok = await client.request({ using: [URN.core], methodCalls: calls(maxCallsInRequest) });
            expect(ok.status).to.equal(200);
            expect(ok.json.methodResponses).to.have.length(maxCallsInRequest);
            const over = await client.request({ using: [URN.core], methodCalls: calls(maxCallsInRequest + 1) });
            const problem = expectProblem(over, 400, 'limit');
            expect(problem.limit).to.equal('maxCallsInRequest');
        });

        describe('concurrency', () => {
            // API requests whose bodies are never finished: each holds a slot until finished or aborted
            const held = [];
            const hold = owner => {
                const body = Buffer.from(JSON.stringify(echo({ held: true })));
                const entry = rawRequest(`${JMAP_URL}/jmap/api/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Authorization: basic(owner.username, owner.password) }
                });
                entry.req.write(body.subarray(0, 10));
                entry.finish = () => entry.req.end(body.subarray(10));
                held.push(entry);
                return entry;
            };
            const slots = owner => redisClient().get(`jmap:conc:${owner.id}`);
            const holdAll = async owner => {
                const { maxConcurrentRequests } = session.capabilities[URN.core];
                const entries = Array.from({ length: maxConcurrentRequests }, () => hold(owner));
                await clock.waitFor(async () => Number(await slots(owner)) === maxConcurrentRequests, { message: 'requests were not held' });
                return entries;
            };
            const abortAll = async () => {
                for (const entry of held.splice(0)) {
                    entry.req.destroy();
                }
            };
            afterEach(abortAll);

            scenario('CORE-086', async () => {
                const owner = await accounts.createUser();
                const ownerClient = forUser(owner);
                await ownerClient.session();
                const entries = await holdAll(owner);
                const over = await ownerClient.request(echo({}));
                const problem = expectProblem(over, 429, 'limit');
                expect(problem.limit).to.equal('maxConcurrentRequests');

                entries[0].finish();
                expect((await entries[0].response).status).to.equal(200);
                expect((await ownerClient.request(echo({}))).status).to.equal(200);

                // aborted connections release their slots as well
                await abortAll();
                await clock.waitFor(async () => Number(await slots(owner)) === 0, { message: 'slots of aborted requests were not released' });
                expect((await ownerClient.request(echo({}))).status).to.equal(200);
            });

            scenario('CORE-087', async () => {
                const owner = await accounts.createUser();
                const otherUser = await accounts.createUser();
                await holdAll(owner);
                expect((await forUser(otherUser).request(echo({}))).status).to.equal(200);
                expect((await forUser(owner).raw('/.well-known/jmap')).status).to.equal(200);
            });
        });

        const fakeEmailIds = count => Array.from({ length: count }, (v, i) => `M${i.toString(16).padStart(24, '0')}`);

        scenario('CORE-088', async () => {
            const { maxObjectsInGet } = session.capabilities[URN.core];
            const res = await client.call([['Email/get', { accountId: true, ids: fakeEmailIds(maxObjectsInGet), properties: ['id'] }, 'a']]);
            expect(res[0][0]).to.equal('Email/get');
            expect(res[0][1].notFound).to.have.length(maxObjectsInGet);
            const over = await client.request({
                using: [URN.core, URN.mail],
                methodCalls: [['Email/get', { accountId: client.accountId, ids: fakeEmailIds(maxObjectsInGet + 1), properties: ['id'] }, 'b']]
            });
            expect(over.status).to.equal(200);
            expect(over.json.methodResponses[0][0]).to.equal('error');
            expect(over.json.methodResponses[0][1].type).to.equal('requestTooLarge');
            expect(over.json.methodResponses[0][1]).to.not.have.property('list');
        });

        scenario('CORE-090', async () => {
            const { maxObjectsInGet } = session.capabilities[URN.core];
            const owner = await accounts.createUser();
            const raw = await fixtures.buildMessage();
            await seed.withImap(owner, imap => imap.append('INBOX', raw));
            const ownerClient = forUser(owner);
            // Email/query clamps limit, so /ids never exceeds maxObjectsInGet; a flattening path does
            const ids = fakeEmailIds(maxObjectsInGet + 1);
            const responses = await ownerClient.call([
                ['Email/query', { accountId: true, limit: maxObjectsInGet + 100 }, 'q'],
                ['Core/echo', { parts: [ids.slice(0, 700), ids.slice(700)] }, 'e'],
                ['Email/get', { accountId: true, '#ids': { resultOf: 'e', name: 'Core/echo', path: '/parts/*' }, properties: ['id'] }, 'g']
            ]);
            expect(responses[0][0]).to.equal('Email/query');
            expect(responses[0][1].ids.length).to.be.at.most(maxObjectsInGet);
            expect(responses[2][0]).to.equal('error');
            expect(responses[2][1].type).to.equal('requestTooLarge');
        });

        scenario('CORE-091', async () => {
            const depth = 100000;
            const body = `{"using":["${URN.core}"],"methodCalls":[["Core/echo",{"deep":${'['.repeat(depth)}${']'.repeat(depth)}},"c"]]}`;
            const started = Date.now();
            const res = await client.request(body);
            expect(Date.now() - started).to.be.below(5000);
            if (res.status === 400) {
                expectProblem(res, 400, 'notJSON');
            } else {
                expect(res.status).to.equal(200);
                expect(res.json.methodResponses[0][1].type).to.equal('invalidArguments');
            }
            expect((await client.request(echo({ after: true }))).status).to.equal(200);
        });

        scenario('CORE-092', async () => {
            const bodies = [
                `{"using":["${URN.core}"],"using":["${URN.core}"],"methodCalls":[["Core/echo",{},"c"]]}`,
                `{"using":["${URN.core}"],"methodCalls":[["Core/echo",{"a":1,"a":2},"c"]]}`
            ];
            for (const body of bodies) {
                expectProblem(await client.request(body), 400, 'notJSON');
            }
        });

        scenario('CORE-093', async () => {
            const json = JSON.stringify(echo({ text: 'hello' }));
            const utf16 = Buffer.from(json, 'utf16le');
            const invalid = Buffer.concat([
                Buffer.from(json.slice(0, json.indexOf('hello'))),
                Buffer.from([0xc3, 0x28]),
                Buffer.from(json.slice(json.indexOf('hello')))
            ]);
            const surrogate = Buffer.from(json.replace('hello', 'he\\ud800llo'));
            for (const body of [utf16, invalid, surrogate]) {
                expectProblem(await client.request(body), 400, 'notJSON');
            }
        });

        scenario('CORE-094', async () => {
            const cases = [{ limit: -1 }, { limit: 1.5 }, { limit: '9007199254740993' }, { position: '0' }];
            for (const args of cases) {
                // 9007199254740993 can not be written from JavaScript, so that body is patched as text
                const literal = args.limit === '9007199254740993';
                const body = JSON.stringify({
                    using: [URN.core, URN.mail],
                    methodCalls: [['Email/query', Object.assign({ accountId: client.accountId }, args), 'q']]
                });
                const res = await client.request(literal ? body.replace('"9007199254740993"', '9007199254740993') : body);
                expect(res.json.methodResponses[0][0], JSON.stringify(args)).to.equal('error');
                expect(res.json.methodResponses[0][1].type).to.equal('invalidArguments');
            }
        });

        scenario('CORE-095', async () => {
            for (const name of ['__proto__', 'constructor']) {
                const body = `{"using":["${URN.core}","${URN.mail}"],"methodCalls":[["Mailbox/get",{"accountId":"${client.accountId}","${name}":{"polluted":true}},"c"]]}`;
                const res = await client.request(body);
                expect(res.json.methodResponses[0][0], name).to.equal('error');
                expect(res.json.methodResponses[0][1].type).to.equal('invalidArguments');
            }
            const later = await client.request(echo({}));
            expect(later.json.methodResponses).to.deep.equal([['Core/echo', {}, 'c1']]);
            expect(later.body.toString()).to.not.include('polluted');
            expect({}.polluted).to.be.undefined;
        });

        scenario('CORE-096', async () => {
            const names = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'Mailbox/__proto__'];
            const res = await client.request({ using: [URN.core, URN.mail], methodCalls: names.map(name => [name, {}, name]) });
            expect(res.status).to.equal(200);
            expect(res.json.methodResponses).to.deep.equal(names.map(name => ['error', { type: 'unknownMethod' }, name]));
        });

        scenario('CORE-098', async () => {
            const names = ['Fake/nonexistent', 'Mailbox/frobnicate', 'mailbox/get'];
            const responses = await client.call(names.map(name => [name, { accountId: true }, name]));
            for (const [index, entry] of responses.entries()) {
                expect(entry[0]).to.equal('error');
                expect(entry[1].type).to.be.a('string').that.equals('unknownMethod');
                expect(entry[2]).to.equal(names[index]);
            }
        });

        scenario('CORE-099', async () => {});

        scenario('CORE-100', async () => {
            const responses = await client.call([
                ['Mailbox/get', {}, 'a'],
                ['Mailbox/get', { accountId: null }, 'b'],
                ['Mailbox/get', { accountId: 42 }, 'c']
            ]);
            for (const entry of responses) {
                expect(entry[0]).to.equal('error');
                expect(entry[1].type).to.equal('invalidArguments');
            }
        });

        scenario('CORE-101', async () => {
            const err = await client.method('Mailbox/get', { accountId: 'nonexistent-account-id-xyz' }).catch(e => e);
            expect(err.type).to.equal('accountNotFound');
        });

        scenario('CORE-102', async () => {
            const random = `u${crypto.randomBytes(12).toString('hex')}`;
            for (const [name, args] of [
                ['Mailbox/get', {}],
                ['Email/query', {}],
                ['Thread/get', { ids: [] }]
            ]) {
                const responses = await client.call([
                    [name, Object.assign({ accountId: `u${other.id}` }, args), 'b'],
                    [name, Object.assign({ accountId: random }, args), 'r']
                ]);
                expect(responses[0][0]).to.equal('error');
                expect(responses[0][1].type, name).to.equal('accountNotFound');
                expect(JSON.stringify(responses[0][1])).to.equal(JSON.stringify(responses[1][1]));
            }
        });

        scenario('CORE-104', async () => {
            const first = await client.call([
                ['Mailbox/get', { accountId: true, ids: [] }, 'a'],
                ['Mailbox/get', { '#accountId': { resultOf: 'a', name: 'Mailbox/get', path: '/accountId' }, ids: [] }, 'b']
            ]);
            expect(first[1][0]).to.equal('Mailbox/get');
            expect(first[1][1].accountId).to.equal(client.accountId);
            const second = await client.call([
                ['Core/echo', { x: `u${other.id}` }, 'e'],
                ['Mailbox/get', { '#accountId': { resultOf: 'e', name: 'Core/echo', path: '/x' }, ids: [] }, 'b']
            ]);
            expect(second[1][0]).to.equal('error');
            expect(second[1][1].type).to.equal('accountNotFound');
        });

        scenario('CORE-105', async () => {
            const responses = await client.call([
                ['Mailbox/get', { accountId: true, ids: 'not-an-array' }, 'a'],
                ['Mailbox/get', { accountId: true, properties: { id: true } }, 'b'],
                ['Email/query', { accountId: true, filter: [] }, 'c']
            ]);
            for (const entry of responses) {
                expect(entry[0], entry[2]).to.equal('error');
                expect(entry[1].type, entry[2]).to.equal('invalidArguments');
                if ('description' in entry[1]) {
                    expect(entry[1].description).to.be.a('string');
                }
            }
        });

        scenario('CORE-106', async () => {
            const responses = await client.call([
                ['Mailbox/get', { accountId: true, frobnicate: true }, 'a'],
                ['Email/get', { accountId: true, ids: [], fetchAllBodyValue: true }, 'b']
            ]);
            for (const entry of responses) {
                expect(entry[0], entry[2]).to.equal('error');
                expect(entry[1].type, entry[2]).to.equal('invalidArguments');
            }
        });

        scenario('CORE-107', async () => {
            const ids = ['../x.y', '', 'x'.repeat(300)];
            for (const name of ['Mailbox/get', 'Email/get']) {
                const result = await client.method(name, { ids, properties: ['id'] });
                expect(result.list, name).to.deep.equal([]);
                expect(result.notFound, name).to.have.members(ids);
            }
        });

        scenario('CORE-108', async () => {});
        scenario('CORE-109', async () => {});

        scenario('CORE-110', async () => {
            const records = instance.captureLog();
            const { app, url } = await instance.startInstance();
            const owner = await accounts.createUser();
            const db = await seed.db();
            // a corrupted mailbox document: the path is not a string
            await db.collection('mailboxes').insertOne({
                user: new seed.ObjectId(owner.id),
                path: 42,
                uidValidity: 1,
                uidNext: 1,
                modifyIndex: 0,
                subscribed: true,
                flags: [],
                retention: 0
            });
            const ownerClient = forUser(owner);
            const res = await ownerClient.raw(`${url}/jmap/api/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    using: [URN.core, URN.mail],
                    methodCalls: [
                        ['Core/echo', { one: 1 }, 'one'],
                        ['Mailbox/get', { accountId: `u${owner.id}` }, 'two'],
                        ['Core/echo', { three: 3 }, 'three']
                    ]
                })
            });
            expect(res.status).to.equal(200);
            const [first, second, third] = res.json.methodResponses;
            expect(first).to.deep.equal(['Core/echo', { one: 1 }, 'one']);
            expect(third).to.deep.equal(['Core/echo', { three: 3 }, 'three']);
            expect(second[0]).to.equal('error');
            expect(second[1].type).to.equal('serverFail');
            const description = second[1].description || '';
            expect(description).to.not.match(/\bat \S+ \(|\.js:\d+|\/Users\/|\/home\/|node_modules|\{\s*user/);
            // logged server side
            expect(records.some(record => record.level === 'error' && record.message.includes(`u${owner.id}`) && record.message.includes('Mailbox/get'))).to.be
                .true;
            await instance.stopInstance(app);
        });
    });

    describe('result references', () => {
        let refUser;
        let refClient;

        before(async () => {
            refUser = await accounts.createUser();
            refClient = forUser(refUser);
            await refClient.session();
            // two threads in the Inbox: three messages and two messages
            const threads = [3, 2];
            for (const [index, count] of threads.entries()) {
                const subject = `Thread ${index} ${crypto.randomBytes(4).toString('hex')}`;
                let previous = null;
                for (let i = 0; i < count; i++) {
                    const messageId = `<t${index}m${i}.${crypto.randomBytes(4).toString('hex')}@scenario.example>`;
                    const raw = await fixtures.buildMessage({
                        to: refUser.address,
                        subject: i ? `Re: ${subject}` : subject,
                        messageId,
                        inReplyTo: previous || undefined,
                        references: previous ? [previous] : undefined
                    });
                    await seed.deliver(refUser.address, raw);
                    previous = messageId;
                }
            }
            await clock.waitFor(async () => (await refClient.method('Email/query', {})).ids.length === 5);
        });

        const inbox = async () => (await refClient.method('Mailbox/query', { filter: { role: 'inbox' } })).ids[0];

        scenario('CORE-113', async () => {
            const mailboxId = await inbox();
            const responses = await refClient.call([
                ['Email/query', { accountId: true, filter: { inMailbox: mailboxId }, limit: 3 }, 'q'],
                ['Email/get', { accountId: true, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject'] }, 'g']
            ]);
            const ids = responses[0][1].ids;
            expect(ids).to.have.length(3);
            expect(responses[1][1].list.map(email => email.id)).to.have.members(ids);
            expect(responses[1][1].notFound).to.deep.equal([]);
        });

        scenario('CORE-114', async () => {
            const responses = await refClient.call([
                ['Mailbox/get', { accountId: true, ids: null }, 'a'],
                ['Mailbox/get', { accountId: true, '#ids': { resultOf: 'a', name: 'Mailbox/get', path: '/list/*/id' } }, 'b']
            ]);
            expect(responses[1][1].list).to.deep.equal(responses[0][1].list);
            expect(responses[1][1].notFound).to.deep.equal([]);
        });

        scenario('CORE-115', async () => {
            const responses = await refClient.call([
                ['Email/query', { accountId: true, collapseThreads: true }, 't0'],
                ['Email/get', { accountId: true, '#ids': { resultOf: 't0', name: 'Email/query', path: '/ids' }, properties: ['threadId'] }, 't1'],
                ['Thread/get', { accountId: true, '#ids': { resultOf: 't1', name: 'Email/get', path: '/list/*/threadId' } }, 't2'],
                [
                    'Email/get',
                    { accountId: true, '#ids': { resultOf: 't2', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['id', 'threadId'] },
                    't3'
                ]
            ]);
            expect(responses[0][1].ids).to.have.length(2);
            expect(responses[2][1].list.map(thread => thread.emailIds.length).sort()).to.deep.equal([2, 3]);
            const t3 = responses[3];
            expect(t3[0]).to.equal('Email/get');
            expect(t3[1].list).to.have.length(5);
            expect(t3[1].notFound).to.deep.equal([]);
        });

        scenario('CORE-116', async () => {
            const responses = await refClient.call([
                ['Mailbox/get', { accountId: true, ids: [] }, 's'],
                ['Mailbox/changes', { accountId: true, '#sinceState': { resultOf: 's', name: 'Mailbox/get', path: '/state' } }, 'c']
            ]);
            const state = responses[0][1].state;
            expect(responses[1][0]).to.equal('Mailbox/changes');
            expect(responses[1][1].oldState).to.equal(state);
            expect(responses[1][1].newState).to.equal(state);
            for (const key of ['created', 'updated', 'destroyed']) {
                expect(responses[1][1][key]).to.deep.equal([]);
            }
        });

        scenario('CORE-117', async () => {
            const source = { list: [{ id: 'a' }, { id: 'b' }], 'k/1': { 'm~n': ['x'] } };
            const ref = path => ({ '#v': { resultOf: 'e', name: 'Core/echo', path } });
            const responses = await refClient.call([
                ['Core/echo', source, 'e'],
                ['Core/echo', ref('/list/1/id'), 'r1'],
                ['Core/echo', ref('/k~11/m~0n/0'), 'r2'],
                ['Core/echo', ref(''), 'r3']
            ]);
            expect(responses[1][1]).to.deep.equal({ v: 'b' });
            expect(responses[2][1]).to.deep.equal({ v: 'x' });
            expect(responses[3][1]).to.deep.equal({ v: source });
        });

        const expectReferenceError = (entry, type = 'invalidResultReference') => {
            expect(entry[0], JSON.stringify(entry)).to.equal('error');
            expect(entry[1].type).to.equal(type);
        };

        scenario('CORE-118', async () => {
            const responses = await refClient.call([
                ['Mailbox/get', { accountId: true, ids: null }, 'a'],
                ['Mailbox/get', { accountId: true, '#ids': { resultOf: 'a', name: 'Mailbox/get', path: '/*/*/id' } }, 'b'],
                ['Core/echo', { nested: [[1, 2], [3]] }, 'e'],
                ['Core/echo', { '#v': { resultOf: 'e', name: 'Core/echo', path: '/nested/*/*/*' } }, 'f']
            ]);
            expect(responses[0][0]).to.equal('Mailbox/get');
            expect(responses[0][1].list).to.not.be.empty;
            expectReferenceError(responses[1]);
            expectReferenceError(responses[3]);
        });

        scenario('CORE-119', async () => {
            const paths = ['/nosuch', '/list/999/id', 'list', '/list/*/nosuch'];
            const responses = await refClient.call([
                ['Mailbox/get', { accountId: true, ids: null }, 'a'],
                ...paths.map((path, i) => ['Mailbox/get', { accountId: true, '#ids': { resultOf: 'a', name: 'Mailbox/get', path } }, `r${i}`])
            ]);
            responses.slice(1).forEach(entry => expectReferenceError(entry));
        });

        scenario('CORE-120', async () => {
            const responses = await refClient.call([
                ['Email/get', { accountId: true, '#ids': { resultOf: 'nonexistent', name: 'Email/query', path: '/ids' } }, 'g']
            ]);
            expectReferenceError(responses[0]);
        });

        scenario('CORE-121', async () => {
            const responses = await refClient.call([
                ['Email/query', { accountId: true }, 'q'],
                ['Email/get', { accountId: true, '#ids': { resultOf: 'q', name: 'Mailbox/get', path: '/ids' } }, 'g']
            ]);
            expect(responses[0][0]).to.equal('Email/query');
            expectReferenceError(responses[1]);
        });

        scenario('CORE-122', async () => {
            const responses = await refClient.call([
                ['Email/query', { accountId: true, filter: { nosuchCondition: true } }, 'q'],
                ['Email/get', { accountId: true, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' } }, 'g']
            ]);
            expect(responses[0][0]).to.equal('error');
            expectReferenceError(responses[1]);
        });

        scenario('CORE-123', async () => {
            const responses = await refClient.call([
                ['Email/get', { accountId: true, '#ids': { resultOf: 'later', name: 'Email/query', path: '/ids' } }, 'g'],
                ['Email/query', { accountId: true }, 'later']
            ]);
            expectReferenceError(responses[0]);
            expect(responses[1][0]).to.equal('Email/query');
            expect(responses[1][1].ids).to.have.length(5);
        });

        scenario('CORE-124', async () => {
            const responses = await refClient.call([
                ['Mailbox/get', { accountId: true, ids: null }, 'a'],
                ['Mailbox/get', { accountId: true, ids: ['x'], '#ids': { resultOf: 'a', name: 'Mailbox/get', path: '/list/*/id' } }, 'b'],
                ['Core/echo', { foo: 1, '#foo': { resultOf: 'a', name: 'Mailbox/get', path: '/state' } }, 'c']
            ]);
            expectReferenceError(responses[1], 'invalidArguments');
            expectReferenceError(responses[2], 'invalidArguments');
        });

        scenario('CORE-125', async () => {
            const references = ['a string', { resultOf: 'a', name: 'Mailbox/get' }, { resultOf: 1, name: 'Mailbox/get', path: '/list/*/id' }, null];
            const responses = await refClient.call([
                ['Mailbox/get', { accountId: true, ids: null }, 'a'],
                ...references.map((reference, i) => ['Mailbox/get', { accountId: true, '#ids': reference }, `r${i}`])
            ]);
            responses.slice(1).forEach(entry => expectReferenceError(entry));
        });

        scenario('CORE-126', async () => {
            const responses = await refClient.call([
                ['Mailbox/get', { accountId: true, ids: [] }, 'a'],
                ['Mailbox/get', { accountId: true, '#ids': { resultOf: 'a', name: 'Mailbox/get', path: '/state' } }, 'b']
            ]);
            expectReferenceError(responses[1], 'invalidArguments');
        });

        scenario('CORE-127', async () => {
            const responses = await refClient.call([
                ['Core/echo', { v: ['one'] }, 'dup'],
                ['Core/echo', { v: ['two'] }, 'dup'],
                ['Core/echo', { '#v': { resultOf: 'dup', name: 'Core/echo', path: '/v' } }, 'r']
            ]);
            expect(responses[2][1]).to.deep.equal({ v: ['one'] });
        });

        scenario('CORE-128', async () => {
            const nested = { inner: { '#x': { resultOf: 'a', name: 'Mailbox/get', path: '/state' } } };
            const responses = await refClient.call([
                ['Mailbox/get', { accountId: true, ids: null }, 'a'],
                ['Email/query', { accountId: true, filter: { '#inMailbox': { resultOf: 'a', name: 'Mailbox/get', path: '/list/0/id' } } }, 'q'],
                ['Core/echo', nested, 'e']
            ]);
            expect(responses[1][0]).to.equal('error');
            expect(responses[1][1].type).to.be.oneOf(['invalidArguments', 'unsupportedFilter']);
            expect(responses[2][1]).to.deep.equal(nested);
        });

        scenario('CORE-129', async () => {
            const paths = ['/__proto__', '/constructor', '/a/constructor/name', '/a/toString'];
            const responses = await refClient.call([
                ['Core/echo', { a: { b: 1 } }, 'e'],
                ...paths.map((path, i) => ['Core/echo', { '#v': { resultOf: 'e', name: 'Core/echo', path } }, `r${i}`])
            ]);
            responses.slice(1).forEach(entry => expectReferenceError(entry));
            const body = `{"using":["${URN.core}"],"methodCalls":[["Core/echo",{"a":1},"e"],["Core/echo",{"#__proto__":{"resultOf":"e","name":"Core/echo","path":"/a"}},"p"]]}`;
            const res = await refClient.request(body);
            const last = res.json.methodResponses[1];
            expect(last[0]).to.equal('error');
            expect(last[1].type).to.be.oneOf(['invalidResultReference', 'invalidArguments']);
            expect(res.body.toString()).to.not.match(/function|\[native code\]/);
        });
    });

    describe('Core/echo', () => {
        scenario('CORE-103', async () => {
            const responses = await client.call([
                ['Core/echo', { hello: 'world' }, 'a'],
                ['Core/echo', { accountId: 'some-other-id', hello: 'world' }, 'b']
            ]);
            expect(responses).to.deep.equal([
                ['Core/echo', { hello: 'world' }, 'a'],
                ['Core/echo', { accountId: 'some-other-id', hello: 'world' }, 'b']
            ]);
        });

        scenario('CORE-130', async () => {
            const responses = await client.call([['Core/echo', {}, 'e']]);
            expect(responses).to.deep.equal([['Core/echo', {}, 'e']]);
        });

        scenario('CORE-131', async () => {
            const args = {
                text: 'non BMP 𝄞😀 and controls \u0000\u0001\t\n\r"\\',
                zero: 0,
                minusOne: -1,
                maxSafe: 9007199254740991,
                yes: true,
                no: false,
                nothing: null,
                emptyArray: [],
                mixed: [1, 'two', null, false, { three: [3] }],
                emptyObject: {},
                '': 'empty key',
                deep: { l1: { l2: { l3: { l4: { l5: 'bottom' } } } } }
            };
            const res = await client.request(echo(args));
            expect(res.json.methodResponses[0][1]).to.deep.equal(args);
            expect(res.body.toString()).to.include('"maxSafe":9007199254740991');
            expect(res.json.methodResponses[0][1]).to.have.property('nothing', null);
        });
    });

    describe('HTTP', () => {
        scenario('CORE-132', async () => {
            for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
                const res = await client.raw('/jmap/api/', { method });
                expect(res.status, method).to.equal(405);
                expect(res.headers.get('allow')).to.match(/\bPOST\b/);
                if (res.body.length) {
                    expectProblem(res, 405);
                }
                expect(res.json || {}).to.not.have.property('methodResponses');
            }
        });

        scenario('CORE-133', async () => {
            const extra = await client.raw('/jmap/api/extra/segments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(echo({}))
            });
            expectProblem(extra, 404);
            const undefinedPath = await client.raw('/no/such/path');
            expectProblem(undefinedPath, 404);
        });

        describe('CORS', () => {
            const origin = 'https://webmail.example';
            let cors;

            before(async () => {
                cors = await instance.startInstance({ cors: { origins: [origin] } });
            });
            after(() => instance.stopInstance(cors.app));

            scenario('CORE-134', async () => {
                const paths = [
                    '/jmap/api/',
                    '/.well-known/jmap',
                    `/jmap/upload/${client.accountId}/`,
                    `/jmap/download/${client.accountId}/Bm${'0'.repeat(24)}/x`,
                    '/jmap/eventsource/'
                ];
                for (const path of paths) {
                    const res = await new JmapClient(null).raw(`${cors.url}${path}`, {
                        method: 'OPTIONS',
                        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' }
                    });
                    expect(res.status, path).to.be.within(200, 299);
                    expect(res.headers.get('access-control-allow-origin'), path).to.equal(origin);
                    expect(res.headers.get('access-control-allow-headers').toLowerCase()).to.include('authorization').and.include('content-type');
                    expect(res.headers.get('www-authenticate')).to.be.null;
                    if (path === '/jmap/api/') {
                        expect(res.headers.get('access-control-allow-methods')).to.match(/\bPOST\b/);
                    }
                }
            });

            scenario('CORE-135', async () => {
                const send = (authorization, body, requestOrigin) =>
                    new JmapClient(authorization).raw(`${cors.url}/jmap/api/`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
                        body
                    });
                const responses = [
                    await send(client.authorization, JSON.stringify(echo({})), origin),
                    await send(null, JSON.stringify(echo({})), origin),
                    await send(client.authorization, 'not json', origin)
                ];
                expect(responses.map(res => res.status)).to.deep.equal([200, 401, 400]);
                for (const res of responses) {
                    expect(res.headers.get('access-control-allow-origin')).to.equal(origin);
                }
                const disallowed = await send(client.authorization, JSON.stringify(echo({})), 'https://evil.example');
                expect(disallowed.headers.get('access-control-allow-origin')).to.be.null;
            });
        });

        scenario('CORE-137', async () => {
            const { hostname, port } = new URL(JMAP_URL);
            // announces a 10 MB body, sends 1 KB of it and reads the answer
            const answerOf = (method, path) =>
                new Promise((resolve, reject) => {
                    const socket = net.connect(Number(port), hostname, () => {
                        socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${hostname}\r\nContent-Type: application/json\r\nContent-Length: 10485760\r\n\r\n`);
                        socket.write('x'.repeat(1024));
                    });
                    let data = '';
                    const timer = setTimeout(() => {
                        socket.destroy();
                        reject(new Error(`${method} ${path}: no answer while the body was pending`));
                    }, 3000);
                    socket.on('data', chunk => {
                        data += chunk;
                        if (data.includes('\r\n\r\n')) {
                            clearTimeout(timer);
                            socket.destroy();
                            resolve(data.slice(0, data.indexOf('\r\n\r\n')));
                        }
                    });
                    socket.on('error', reject);
                });
            for (const [method, path, status] of [
                ['POST', '/jmap/session', 405],
                ['POST', '/jmap/no-such-path', 404],
                ['OPTIONS', '/jmap/api/', 204]
            ]) {
                const head = await answerOf(method, path);
                expect(head, `${method} ${path}`).to.match(new RegExp(`^HTTP/1\\.1 ${status} `));
                expect(head, `${method} ${path}`).to.match(/\r\nconnection: close/i);
            }
        });

        scenario('CORE-138', async () => {
            const owner = await accounts.createUser();
            const ownerClient = forUser(owner);
            const session = await ownerClient.session();
            const { maxConcurrentRequests } = session.capabilities[URN.core];
            const uploaded = await ownerClient.raw(`/jmap/upload/${ownerClient.accountId}/`, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: 'download me'
            });
            const path = `/jmap/download/${ownerClient.accountId}/${uploaded.json.blobId}/f.txt`;
            // the download slots of the user are all taken
            const redis = redisClient();
            const key = `jmap:dlc:${owner.id}`;
            await redis.set(key, maxConcurrentRequests);
            try {
                const over = await ownerClient.raw(path);
                expect(expectProblem(over, 429, 'limit').limit).to.equal('maxConcurrentRequests');
                expect(Number(await redis.get(key))).to.equal(maxConcurrentRequests);
                expect((await ownerClient.request(echo({}))).status).to.equal(200);
            } finally {
                await redis.set(key, 0);
            }
            const ok = await ownerClient.raw(path);
            expect(ok.status).to.equal(200);
            expect(ok.body.toString()).to.equal('download me');
            // the slot is given back once the response is done
            await clock.waitFor(async () => Number(await redis.get(key)) === 0, { message: 'the download slot was not released' });
        });

        scenario('CORE-139', async () => {
            const owner = await accounts.createUser();
            const ownerClient = forUser(owner);
            await ownerClient.session();
            const { host } = new URL(JMAP_URL);
            const send = origin =>
                new Promise((resolve, reject) => {
                    const req = http.request(`${JMAP_URL}/jmap/upload/${ownerClient.accountId}/`, {
                        method: 'POST',
                        headers: Object.assign(
                            { 'Content-Type': 'text/plain', Authorization: basic(owner.username, owner.password) },
                            origin ? { Origin: origin } : {}
                        )
                    });
                    req.on('response', res => {
                        res.resume();
                        res.on('end', () => resolve(res.statusCode));
                    });
                    req.on('error', reject);
                    req.end('cross site');
                });
            expect(await send('https://evil.example')).to.equal(403);
            expect(await send('null')).to.equal(403);
            expect(await send(`http://${host}`)).to.equal(200);
            expect(await send(null)).to.equal(200);
        });

        scenario('CORE-136', async () => {
            const records = instance.captureLog();
            const { app, url } = await instance.startInstance();
            const injected = 'x%0d%0aJMAP GET /forged 200 user=evil\\r\\n|tab\there';
            const from = records.length;
            const res = await client.raw(`${url}/jmap/api/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': injected, 'X-Forwarded-For': `1.2.3.4, ${injected}` },
                body: JSON.stringify({
                    using: [URN.core],
                    methodCalls: [
                        ['Core/echo', {}, 'line\r\nJMAP POST /forged 200 user=evil'],
                        ['Core/echo\nJMAP forged', {}, 'c']
                    ]
                })
            });
            expect(res.status).to.be.oneOf([200, 400]);
            for (const [name, value] of res.headers) {
                expect(value, name).to.not.include('forged');
                expect(value, name).to.not.include('evil');
            }
            const access = await clock.waitFor(() => records.slice(from).filter(record => record.prefix === 'JMAP' && record.message.includes('/jmap/api')));
            expect(access).to.have.length(1);
            for (const record of records.slice(from)) {
                expect(record.message).to.not.match(/[\r\n]/);
            }
            await instance.stopInstance(app);
        });
    });
});
