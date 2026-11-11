/* eslint no-unused-expressions: 0, no-invalid-this: 0 */
/* global before */
'use strict';

// Catalogue file identity.yaml: Identity/get, Identity/changes and Identity/set (RFC 8621 6).

const { expect } = require('chai');
const crypto = require('crypto');
const punycode = require('punycode/');
const { scenario, api, accounts, seed, fixtures, clock, jmap } = require('../harness');

const USING = [jmap.URN.core, jmap.URN.mail, jmap.URN.submission];
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const unique = prefix => `${prefix}${crypto.randomBytes(5).toString('hex')}`;

async function client(user) {
    const c = jmap.forUser(user);
    await c.session();
    return c;
}

const call = (c, name, args = {}) => c.method(name, args, USING);

async function failsWith(promise, type) {
    try {
        await promise;
    } catch (err) {
        expect(err.type, err.message).to.equal(type);
        return err;
    }
    throw new Error(`expected ${type}`);
}

const identities = async c => (await call(c, 'Identity/get')).list;
const byEmail = (list, email) => list.find(identity => identity.email === email);
const addAddress = (user, address, extra = {}) => api('POST', `/users/${user.id}/addresses`, Object.assign({ address }, extra));
const addressId = async (user, address) => (await api('GET', `/users/${user.id}/addresses`)).results.find(entry => entry.address === address).id;

// one Identity/set call; answers the response arguments
const set = (c, args) => call(c, 'Identity/set', args);

/** Reads server sent events until `match` returns true for a parsed StateChange, or the timeout passes. */
async function waitForEvent(user, types, match, trigger, timeout = 8000) {
    const controller = new AbortController();
    const res = await fetch(`${jmap.JMAP_URL}/jmap/eventsource/?types=${types}&closeafter=no&ping=0`, {
        headers: { Authorization: jmap.basic(user.username, user.password), Accept: 'text/event-stream' },
        signal: controller.signal
    });
    const timer = setTimeout(() => controller.abort(), timeout);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let triggered = false;
    try {
        for (;;) {
            if (!triggered && buffer.includes(': connected')) {
                triggered = true;
                await trigger();
            }
            const { value, done } = await reader.read();
            if (done) {
                return null;
            }
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = block.split('\n').find(line => line.startsWith('data: '));
                if (/^event: state/m.test(block) && data && match(JSON.parse(data.slice(6)))) {
                    return JSON.parse(data.slice(6));
                }
            }
            if (!triggered && buffer.includes(': connected')) {
                triggered = true;
                await trigger();
            }
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            return null;
        }
        throw err;
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}

describe('Identity', function () {
    this.timeout(30000);

    describe('Identity/get', () => {
        let user;
        let c;
        let second;
        let third;
        before(async () => {
            user = await accounts.createUser({ name: 'Jane Doe' });
            second = `${unique('b')}@example.com`;
            third = `${unique('c')}@example.org`;
            await addAddress(user, second, { name: 'Sales Team' });
            await addAddress(user, third);
            c = await client(user);
        });

        scenario('IDN-001', async () => {
            const result = await call(c, 'Identity/get', { ids: null });
            expect(result.accountId).to.equal(c.accountId);
            expect(result.state).to.be.a('string').and.not.empty;
            expect(result.notFound).to.deep.equal([]);
            expect(result.list.map(identity => identity.email).sort()).to.deep.equal([user.address, second, third].sort());
            expect(new Set(result.list.map(identity => identity.id)).size).to.equal(3);
        });

        scenario('IDN-002', async () => {
            const fresh = await client(await accounts.createUser());
            const { list } = await call(fresh, 'Identity/get', { ids: null, properties: null });
            for (const identity of list) {
                expect(Object.keys(identity).sort()).to.deep.equal(['bcc', 'email', 'htmlSignature', 'id', 'mayDelete', 'name', 'replyTo', 'textSignature']);
                expect(identity).to.include({ replyTo: null, bcc: null, textSignature: '', htmlSignature: '' });
                expect(identity.id).to.be.a('string');
                expect(identity.name).to.be.a('string');
                expect(identity.mayDelete).to.be.a('boolean');
            }
        });

        scenario('IDN-003', async () => {
            const list = await identities(c);
            expect(list[0]).to.include({ email: user.address, mayDelete: false });
            expect(list.slice(1).every(identity => identity.mayDelete)).to.be.true;
        });

        scenario('IDN-004', async () => {
            const list = await identities(c);
            expect(byEmail(list, user.address).name).to.equal('Jane Doe');
            expect(byEmail(list, second).name).to.equal('Sales Team');
            const nameless = await accounts.createUser({ name: undefined });
            const [only] = await identities(await client(nameless));
            expect(only.name).to.equal('');
        });

        scenario('IDN-005', async () => {
            const owner = await accounts.createUser();
            const domain = `${unique('wild')}.example`;
            await addAddress(owner, `*@${domain}`, { allowWildcard: true });
            const identity = byEmail(await identities(await client(owner)), `*@${domain}`);
            expect(identity).to.include({ mayDelete: true });
        });

        scenario('IDN-006', async () => {
            const owner = await accounts.createUser();
            const suffix = unique('s');
            await addAddress(owner, `${owner.username}x@*`, { allowWildcard: true });
            await addAddress(owner, `*${suffix}@example.com`, { allowWildcard: true });
            const list = await identities(await client(owner));
            expect(list.every(identity => !identity.email.includes('*') || /^\*@[^*]+$/.test(identity.email))).to.be.true;
            expect(list.map(identity => identity.email)).to.deep.equal([owner.address]);
        });

        scenario('IDN-007', async () => {
            const list = await identities(c);
            const other = await client(await accounts.createUser());
            const [z] = await identities(other);
            const result = await call(c, 'Identity/get', { ids: [list[0].id, 'Iffffffffffffffffffffffff', z.id] });
            expect(result.list.map(identity => identity.id)).to.deep.equal([list[0].id]);
            expect(result.notFound.sort()).to.deep.equal(['Iffffffffffffffffffffffff', z.id].sort());
        });

        scenario('IDN-008', async () => {
            const result = await call(c, 'Identity/get', { ids: [] });
            expect(result).to.deep.include({ list: [], notFound: [] });
            expect(result.state).to.be.a('string');
        });

        scenario('IDN-009', async () => {
            const { list } = await call(c, 'Identity/get', { properties: ['email', 'name'] });
            expect(list.every(identity => Object.keys(identity).sort().join() === 'email,id,name')).to.be.true;
            const bare = await call(c, 'Identity/get', { properties: [] });
            expect(bare.list.every(identity => Object.keys(identity).join() === 'id')).to.be.true;
        });

        scenario('IDN-010', async () => {
            await failsWith(call(c, 'Identity/get', { properties: ['email', 'bogus'] }), 'invalidArguments');
        });

        scenario('IDN-011', async () => {
            const other = await accounts.createUser();
            const otherId = `u${other.id}`;
            for (const accountId of [otherId, 'u000000000000000000000000']) {
                await failsWith(call(c, 'Identity/get', { accountId }), 'accountNotFound');
                await failsWith(call(c, 'Identity/set', { accountId, create: { c1: { email: other.address } } }), 'accountNotFound');
                await failsWith(call(c, 'Identity/changes', { accountId, sinceState: 'o0.0.00000000' }), 'accountNotFound');
            }
            expect(await identities(await client(other))).to.have.length(1);
        });

        scenario('IDN-012', async () => {
            const state = (await call(c, 'Identity/get')).state;
            for (const [name, args] of [
                ['Identity/get', {}],
                ['Identity/set', {}],
                ['Identity/changes', { sinceState: state }]
            ]) {
                const [[response]] = [await c.call([[name, Object.assign({ accountId: c.accountId }, args), 'x']], [jmap.URN.core, jmap.URN.mail])];
                expect(response[0]).to.equal('error');
                expect(response[1].type).to.equal('unknownMethod');
                const [[ok]] = [await c.call([[name, Object.assign({ accountId: c.accountId }, args), 'x']], USING)];
                expect(ok[0]).to.equal(name);
            }
        });

        scenario('IDN-013', async () => {
            const first = await call(c, 'Identity/get');
            await seed.deliver(
                user.address,
                fixtures.buildMessage ? await fixtures.buildMessage({ subject: 'unrelated' }) : 'Subject: unrelated\r\n\r\nbody\r\n'
            );
            const again = await call(c, 'Identity/get');
            expect(again.state).to.equal(first.state);
            expect(again.list.map(identity => [identity.id, identity.email])).to.deep.equal(first.list.map(identity => [identity.id, identity.email]));
            expect(first.list.every(identity => ID.test(identity.id))).to.be.true;
        });
    });

    describe('address changes made through the REST API', () => {
        scenario('IDN-014', async () => {
            const user = await accounts.createUser();
            const c = await client(user);
            const before = await call(c, 'Identity/get');
            const added = `${unique('new')}@example.com`;
            await addAddress(user, added);
            const after = await call(c, 'Identity/get');
            expect(byEmail(after.list, added)).to.include({ mayDelete: true });
            expect(byEmail(after.list, user.address).id).to.equal(byEmail(before.list, user.address).id);
            expect(after.state).to.not.equal(before.state);
        });

        scenario('IDN-015', async () => {
            const user = await accounts.createUser();
            const old = `${unique('old')}@example.com`;
            await addAddress(user, old);
            const c = await client(user);
            const derived = byEmail(await identities(c), old);
            const created = await set(c, { create: { c1: { email: old, name: 'Extra' } } });
            const extra = created.created.c1.id;
            await api('DELETE', `/users/${user.id}/addresses/${await addressId(user, old)}`);
            const result = await call(c, 'Identity/get', { ids: [derived.id, extra] });
            expect(result.notFound.sort()).to.deep.equal([derived.id, extra].sort());
            expect(byEmail(await identities(c), old)).to.equal(undefined);
            const updated = await set(c, { update: { [extra]: { name: 'x' } } });
            expect(updated.notUpdated[extra].type).to.equal('notFound');
            const again = await set(c, { create: { c2: { email: old } } });
            expect(again.notCreated.c2.type).to.equal('forbiddenFrom');
        });

        scenario('IDN-016', async () => {
            const user = await accounts.createUser();
            const second = `${unique('b')}@example.com`;
            await addAddress(user, second);
            const c = await client(user);
            const before = await identities(c);
            await api('PUT', `/users/${user.id}/addresses/${await addressId(user, second)}`, { main: true });
            const after = await identities(c);
            expect(after[0]).to.include({ email: second, mayDelete: false, id: byEmail(before, second).id });
            expect(byEmail(after, user.address)).to.include({ mayDelete: true, id: byEmail(before, user.address).id });
        });

        scenario('IDN-017', async () => {
            const user = await accounts.createUser();
            const brand = `${unique('brand')}.example`;
            await api('PUT', `/users/${user.id}`, { fromWhitelist: ['ext@partner.example', `*@${brand}`, 'sales*@other.example'] });
            const list = await identities(await client(user));
            expect(byEmail(list, 'ext@partner.example')).to.include({ mayDelete: true });
            expect(byEmail(list, `*@${brand}`)).to.include({ mayDelete: true });
            expect(list.some(identity => identity.email.startsWith('sales'))).to.be.false;
        });
    });

    describe('Identity/set create', () => {
        let user;
        let c;
        before(async () => {
            user = await accounts.createUser({ name: 'Jane Doe' });
            await addAddress(user, `b-${user.username}@example.com`);
            c = await client(user);
        });

        scenario('IDN-018', async () => {
            const object = {
                email: user.address,
                name: 'Work',
                textSignature: 'text sig',
                htmlSignature: '<p>html <b>sig</b></p>',
                replyTo: [{ name: 'R', email: 'r@example.com' }],
                bcc: [{ name: null, email: 'archive@example.com' }]
            };
            const result = await set(c, { create: { c1: object } });
            expect(result.created.c1.id).to.match(ID);
            expect(result.created.c1.mayDelete).to.equal(true);
            expect(result.newState).to.not.equal(result.oldState);
            const list = await identities(c);
            const created = list.find(identity => identity.id === result.created.c1.id);
            expect(created).to.deep.include(object);
            expect(list.filter(identity => identity.email === user.address)).to.have.length(2);
        });

        scenario('IDN-019', async () => {
            const result = await set(c, { create: { c1: { email: user.address } } });
            const created = result.created.c1;
            expect(created).to.include.keys('id', 'name', 'replyTo', 'bcc', 'textSignature', 'htmlSignature', 'mayDelete');
            expect(created).to.not.have.property('email');
            const [identity] = (await call(c, 'Identity/get', { ids: [created.id] })).list;
            expect(identity).to.include({ name: '', replyTo: null, bcc: null, textSignature: '', htmlSignature: '', mayDelete: true });
        });

        scenario('IDN-020', async () => {
            const responses = await c.call(
                [
                    [
                        'Identity/set',
                        {
                            accountId: c.accountId,
                            create: { c1: { email: user.address, name: 'One' }, c2: { email: `b-${user.username}@example.com`, name: 'Two' } }
                        },
                        'a'
                    ],
                    ['Identity/get', { accountId: c.accountId, ids: ['#c1', '#c2'] }, 'b']
                ],
                USING
            );
            const created = responses[0][1].created;
            expect(created.c1.id).to.not.equal(created.c2.id);
            expect(responses[1][1].list.map(identity => identity.name)).to.deep.equal(['One', 'Two']);
            // createdIds comes back when the request carries it
            const res = await c.request({
                using: USING,
                methodCalls: [['Identity/set', { accountId: c.accountId, create: { c3: { email: user.address } } }, 'a']],
                createdIds: {}
            });
            expect(res.json.createdIds.c3).to.equal(res.json.methodResponses[0][1].created.c3.id);
        });

        scenario('IDN-021', async () => {
            const other = await accounts.createUser();
            const before = await call(c, 'Identity/get');
            const result = await set(c, { create: { c1: { email: other.address } } });
            expect(result.notCreated.c1.type).to.equal('forbiddenFrom');
            expect(result.created).to.equal(null);
            expect(result.newState).to.equal(result.oldState);
            expect((await call(c, 'Identity/get')).list).to.deep.equal(before.list);
        });

        scenario('IDN-022', async () => {
            const forwarded = `${unique('fwd')}@example.com`;
            await api('POST', '/addresses/forwarded', { address: forwarded, targets: ['target@example.net'] });
            const before = await api('GET', `/users/${user.id}/addresses`);
            for (const email of [`${unique('nobody')}@example.com`, 'someone@elsewhere.test', forwarded]) {
                const result = await set(c, { create: { c1: { email } } });
                expect(result.notCreated.c1.type, email).to.equal('forbiddenFrom');
            }
            expect((await api('GET', `/users/${user.id}/addresses`)).results).to.deep.equal(before.results);
        });

        scenario('IDN-023', async () => {
            const owner = await accounts.createUser();
            const other = await accounts.createUser();
            const wild = `${unique('wild')}.example`;
            const otherWild = `${unique('other')}.example`;
            await addAddress(owner, `*@${wild}`, { allowWildcard: true });
            await addAddress(other, `*@${otherWild}`, { allowWildcard: true });
            const oc = await client(owner);
            const result = await set(oc, {
                create: { a: { email: `anything@${wild}` }, b: { email: `*@${wild}` }, c: { email: `x@${otherWild}` }, d: { email: `*@${otherWild}` } }
            });
            expect(Object.keys(result.created).sort()).to.deep.equal(['a', 'b']);
            expect(result.notCreated.c.type).to.equal('forbiddenFrom');
            expect(result.notCreated.d.type).to.equal('forbiddenFrom');
        });

        scenario('IDN-024', async () => {
            const owner = await accounts.createUser();
            const local = unique('first.last');
            const domain = `${unique('münchen')}.example`;
            await addAddress(owner, `${local}@example.com`);
            await addAddress(owner, `${local}@${domain}`);
            const oc = await client(owner);
            const result = await set(oc, {
                create: {
                    a: { email: `${local.toUpperCase()}@EXAMPLE.com` },
                    b: { email: `${local}@${domain}` },
                    c: { email: `${local}@${punycode.toASCII(domain)}` }
                }
            });
            expect(Object.keys(result.created).sort()).to.deep.equal(['a', 'b', 'c']);
            const list = await identities(oc);
            const emails = ['a', 'b', 'c'].map(key => list.find(identity => identity.id === result.created[key].id).email);
            expect(emails[0]).to.equal(`${local}@example.com`);
            expect(emails[1]).to.equal(emails[2]);
            expect((await identities(oc)).map(identity => identity.email)).to.deep.equal(list.map(identity => identity.email));
        });

        scenario('IDN-025', async () => {
            const values = [undefined, null, 5, 'not-an-address', `a\r\nb@example.com`, '<a@example.com>'];
            for (const email of values) {
                const object = email === undefined ? { name: 'x' } : { email };
                const result = await set(c, { create: { c1: object } });
                expect(result.notCreated.c1, String(email)).to.deep.include({ type: 'invalidProperties', properties: ['email'] });
            }
        });

        scenario('IDN-026', async () => {
            for (const [extra, property] of [
                [{ id: 'Ifoo' }, 'id'],
                [{ mayDelete: false }, 'mayDelete'],
                [{ bogus: 1 }, 'bogus']
            ]) {
                const result = await set(c, { create: { c1: Object.assign({ email: user.address }, extra) } });
                expect(result.notCreated.c1).to.deep.include({ type: 'invalidProperties', properties: [property] });
                expect(result.created).to.equal(null);
            }
        });

        scenario('IDN-027', async () => {
            const [existing] = await identities(c);
            const bad = [
                ['replyTo', 'a@example.com'],
                ['replyTo', [{ name: 'x' }]],
                ['bcc', [{ email: 'not an address' }]],
                ['bcc', [{ email: 'a@example.com\r\nBcc: evil@example.com' }]],
                ['replyTo', [{ email: 'a@example.com', unknown: 1 }]]
            ];
            for (const [property, value] of bad) {
                const created = await set(c, { create: { c1: { email: user.address, [property]: value } } });
                expect(created.notCreated.c1).to.deep.include({ type: 'invalidProperties', properties: [property] });
                const updated = await set(c, { update: { [existing.id]: { [property]: value } } });
                expect(updated.notUpdated[existing.id]).to.deep.include({ type: 'invalidProperties', properties: [property] });
            }
            const empty = await set(c, { create: { c1: { email: user.address, replyTo: [], bcc: [] } } });
            const [identity] = (await call(c, 'Identity/get', { ids: [empty.created.c1.id] })).list;
            expect(identity.replyTo).to.deep.equal([]);
            expect(identity.bcc).to.deep.equal([]);
        });

        scenario('IDN-030', async () => {
            const tooLong = 'x'.repeat(257);
            for (const object of [{ name: tooLong }, { textSignature: 'x'.repeat(64 * 1024 + 1) }, { htmlSignature: 'x'.repeat(64 * 1024 + 1) }]) {
                const result = await set(c, { create: { c1: Object.assign({ email: user.address }, object) } });
                expect(['tooLarge', 'invalidProperties']).to.include(result.notCreated.c1.type);
            }
            const many = Array.from({ length: 51 }, (_, i) => ({ email: `r${i}@example.com` }));
            const result = await set(c, { create: { c1: { email: user.address, replyTo: many } } });
            expect(['tooLarge', 'invalidProperties']).to.include(result.notCreated.c1.type);
            const atLimit = await set(c, {
                create: { c1: { email: user.address, name: 'x'.repeat(256), textSignature: 'x'.repeat(64 * 1024), replyTo: many.slice(0, 50) } }
            });
            expect(atLimit.created.c1.id).to.be.a('string');
        });

        scenario('IDN-031', async () => {
            const owner = await accounts.createUser();
            const oc = await client(owner);
            const create = {};
            for (let i = 0; i < 99; i++) {
                create[`c${i}`] = { email: owner.address };
            }
            const filled = await set(oc, { create });
            expect(Object.keys(filled.created)).to.have.length(99);
            const result = await set(oc, { create: { more: { email: owner.address } } });
            expect(result.notCreated.more.type).to.equal('overQuota');
            expect(await identities(oc)).to.have.length(100);
        });
    });

    describe('Identity/set update and destroy', () => {
        let user;
        let c;
        let second;
        before(async () => {
            user = await accounts.createUser({ name: 'Jane Doe' });
            second = `${unique('b')}@example.com`;
            await addAddress(user, second);
            c = await client(user);
        });
        const extra = async (fields = {}) => (await set(c, { create: { x: Object.assign({ email: user.address }, fields) } })).created.x.id;
        const getOne = async id => (await call(c, 'Identity/get', { ids: [id] })).list[0];

        scenario('IDN-028', async () => {
            const id = await extra();
            const replyTo = [
                { name: 'Reply Desk', email: 'reply@example.com' },
                { email: 'second@example.com' },
                { name: 'Jõgi 漢字', email: 'third@example.com' }
            ];
            await set(c, { update: { [id]: { replyTo, bcc: [{ name: null, email: 'archive@example.com' }] } } });
            const identity = await getOne(id);
            expect(identity.replyTo).to.deep.equal([replyTo[0], { name: null, email: 'second@example.com' }, replyTo[2]]);
            expect(identity.bcc).to.deep.equal([{ name: null, email: 'archive@example.com' }]);
        });

        scenario('IDN-029', async () => {
            const id = await extra();
            const textSignature = '-- \r\nJane Doe\nLine two\r\n  indented  ';
            const htmlSignature = '<div>Jõgi &amp; <b>漢字</b>&nbsp;</div>\n';
            await set(c, { update: { [id]: { textSignature, htmlSignature } } });
            expect(await getOne(id)).to.include({ textSignature, htmlSignature });
        });

        scenario('IDN-032', async () => {
            const id = await extra({ name: 'Old', textSignature: 'keep' });
            const result = await set(c, { update: { [id]: { name: 'New' } } });
            expect(result.updated).to.have.property(id);
            expect(result.newState).to.not.equal(result.oldState);
            expect(await getOne(id)).to.include({ name: 'New', textSignature: 'keep', email: user.address });
        });

        scenario('IDN-033', async () => {
            const main = (await identities(c))[0];
            const result = await set(c, { update: { [main.id]: { textSignature: 'sig' } } });
            expect(result.updated).to.have.property(main.id);
            expect(await getOne(main.id)).to.include({ id: main.id, email: user.address, name: 'Jane Doe', mayDelete: false, textSignature: 'sig' });
        });

        scenario('IDN-034', async () => {
            const derived = byEmail(await identities(c), second);
            const s1 = (await call(c, 'Identity/get')).state;
            await set(c, { update: { [derived.id]: { name: 'From JMAP' } } });
            const id = await addressId(user, second);
            expect((await api('GET', `/users/${user.id}/addresses/${id}`)).name).to.equal('From JMAP');
            const s2 = (await call(c, 'Identity/get')).state;
            expect(s2).to.not.equal(s1);
            await api('PUT', `/users/${user.id}/addresses/${id}`, { name: 'From REST' });
            const after = await call(c, 'Identity/get');
            expect(byEmail(after.list, second).name).to.equal('From REST');
            expect(after.state).to.not.equal(s2);
        });

        scenario('IDN-035', async () => {
            const id = await extra({ replyTo: [{ email: 'r@example.com' }], bcc: [{ email: 'b@example.com' }] });
            await set(c, { update: { [id]: { replyTo: null, bcc: null } } });
            expect(await getOne(id)).to.include({ replyTo: null, bcc: null });
        });

        scenario('IDN-036', async () => {
            const id = await extra({ name: 'N', textSignature: 't', htmlSignature: 'h' });
            for (const property of ['name', 'textSignature', 'htmlSignature']) {
                const result = await set(c, { update: { [id]: { [property]: null } } });
                expect(result.notUpdated[id]).to.deep.include({ type: 'invalidProperties', properties: [property] });
                await set(c, { update: { [id]: { [property]: '' } } });
                expect((await getOne(id))[property]).to.equal('');
            }
        });

        scenario('IDN-037', async () => {
            const id = await extra();
            const moved = await set(c, { update: { [id]: { email: second } } });
            expect(moved.notUpdated[id]).to.deep.include({ type: 'invalidProperties', properties: ['email'] });
            const same = await set(c, { update: { [id]: { email: user.address, name: 'Same' } } });
            expect(same.updated).to.have.property(id);
            expect(await getOne(id)).to.include({ email: user.address, name: 'Same' });
        });

        scenario('IDN-038', async () => {
            const main = (await identities(c))[0];
            const id = await extra();
            for (const [target, patch, property] of [
                [main.id, { mayDelete: true }, 'mayDelete'],
                [id, { id: 'Iother' }, 'id'],
                [id, { bogus: 1 }, 'bogus']
            ]) {
                const result = await set(c, { update: { [target]: patch } });
                expect(result.notUpdated[target]).to.deep.include({ type: 'invalidProperties', properties: [property] });
            }
            expect((await getOne(main.id)).mayDelete).to.equal(false);
        });

        scenario('IDN-039', async () => {
            const id = await extra({ replyTo: [{ name: 'A', email: 'a@example.com' }] });
            const result = await set(c, { update: { [id]: { 'replyTo/0/name': 'Changed' } } });
            expect(result.notUpdated[id].type).to.equal('invalidPatch');
            expect((await getOne(id)).replyTo).to.deep.equal([{ name: 'A', email: 'a@example.com' }]);
        });

        scenario('IDN-040', async () => {
            const id = await extra();
            const other = await client(await accounts.createUser());
            const [z] = await identities(other);
            const result = await set(c, {
                update: { [id]: { name: 'Ok' }, Iffffffffffffffffffffffff: { name: 'A' }, [z.id]: { name: 'B' }, 'bad id!': { name: 'C' } }
            });
            expect(Object.keys(result.updated)).to.deep.equal([id]);
            for (const key of ['Iffffffffffffffffffffffff', z.id, 'bad id!']) {
                expect(result.notUpdated[key].type).to.equal('notFound');
            }
            expect((await identities(other))[0].name).to.equal(z.name);
        });

        scenario('IDN-041', async () => {
            const id = await extra();
            const result = await set(c, { destroy: [id] });
            expect(result.destroyed).to.deep.equal([id]);
            expect(result.newState).to.not.equal(result.oldState);
            expect((await call(c, 'Identity/get', { ids: [id] })).notFound).to.deep.equal([id]);
            expect(byEmail(await identities(c), user.address)).to.exist;
        });

        scenario('IDN-042', async () => {
            const main = (await identities(c))[0];
            const result = await set(c, { destroy: [main.id] });
            expect(result.notDestroyed[main.id].type).to.equal('forbidden');
            expect(result.destroyed).to.equal(null);
            expect(result.newState).to.equal(result.oldState);
            expect((await identities(c))[0].id).to.equal(main.id);
        });

        scenario('IDN-043', async () => {
            const main = (await identities(c))[0];
            const id = await extra();
            const other = await client(await accounts.createUser());
            const [z] = await identities(other);
            const result = await set(c, { destroy: [id, main.id, 'Iffffffffffffffffffffffff', z.id] });
            expect(result.destroyed).to.deep.equal([id]);
            expect(result.notDestroyed[main.id].type).to.equal('forbidden');
            expect(result.notDestroyed.Iffffffffffffffffffffffff.type).to.equal('notFound');
            expect(result.notDestroyed[z.id].type).to.equal('notFound');
            expect(await identities(other)).to.have.length(1);
        });

        scenario('IDN-044', async () => {
            const main = (await identities(c))[0];
            const s = (await call(c, 'Identity/get')).state;
            const rejected = await set(c, { create: { c1: { email: 'x@elsewhere.test' } }, update: { [main.id]: { bogus: 1 } }, destroy: [main.id] });
            expect(rejected).to.include({ oldState: s, newState: s });
            const empty = await set(c, { create: {}, update: {}, destroy: [] });
            expect(empty).to.include({ oldState: s, newState: s });
            const changes = await call(c, 'Identity/changes', { sinceState: s });
            expect(changes).to.deep.include({ created: [], updated: [], destroyed: [] });
        });

        scenario('IDN-045', async () => {
            const s1 = (await call(c, 'Identity/get')).state;
            await extra();
            const s2 = (await call(c, 'Identity/get')).state;
            await failsWith(set(c, { ifInState: s1, create: { c1: { email: user.address } } }), 'stateMismatch');
            expect((await call(c, 'Identity/get')).state).to.equal(s2);
            const ok = await set(c, { ifInState: s2, create: { c1: { email: user.address } } });
            expect(ok.created.c1.id).to.be.a('string');
        });

        scenario('IDN-046', async () => {
            const owner = await accounts.createUser();
            const b = `${unique('b')}@example.com`;
            await addAddress(owner, b);
            const oc = await client(owner);
            const derived = byEmail(await identities(oc), b);
            const result = await set(oc, { destroy: [derived.id] });
            expect(result.destroyed).to.deep.equal([derived.id]);
            expect(byEmail(await identities(oc), b)).to.equal(undefined);
            expect((await api('GET', `/users/${owner.id}/addresses`)).results.map(entry => entry.address)).to.include(b);
            await seed.deliver(b, 'From: a@example.net\r\nSubject: still delivered\r\n\r\nbody\r\n');
            await clock.waitFor(async () => (await api('GET', `/users/${owner.id}`)).limits.quota.used > 0, { message: 'expected the message to arrive' });
            expect(byEmail(await identities(oc), b)).to.equal(undefined);
        });
    });

    describe('Identity/changes', () => {
        let user;
        let c;
        before(async () => {
            user = await accounts.createUser({ name: 'Jane Doe' });
            c = await client(user);
        });
        const state = async () => (await call(c, 'Identity/get')).state;
        const create = async (fields = {}) => (await set(c, { create: { x: Object.assign({ email: user.address }, fields) } })).created.x.id;

        scenario('IDN-047', async () => {
            const s = await state();
            const result = await call(c, 'Identity/changes', { sinceState: s });
            expect(result).to.deep.include({ oldState: s, newState: s, hasMoreChanges: false, created: [], updated: [], destroyed: [] });
        });

        scenario('IDN-048', async () => {
            const x = await create();
            const y = await create();
            const s1 = await state();
            const n = await create();
            await set(c, { update: { [x]: { name: 'renamed' } }, destroy: [y] });
            const result = await call(c, 'Identity/changes', { sinceState: s1 });
            expect(result).to.deep.include({ created: [n], updated: [x], destroyed: [y] });
            expect(result.newState).to.equal(await state());
            expect(await call(c, 'Identity/changes', { sinceState: result.newState })).to.deep.include({ created: [], updated: [], destroyed: [] });
        });

        scenario('IDN-049', async () => {
            const x = await create();
            const s1 = await state();
            const t = await create();
            await set(c, { destroy: [t] });
            const u = await create();
            await set(c, { update: { [u]: { name: 'one' } } });
            await set(c, { update: { [u]: { name: 'two' } } });
            await set(c, { update: { [x]: { name: 'changed' } } });
            await set(c, { destroy: [x] });
            const result = await call(c, 'Identity/changes', { sinceState: s1 });
            expect(result).to.deep.include({ created: [u], updated: [], destroyed: [x] });
        });

        scenario('IDN-050', async () => {
            const owner = await accounts.createUser();
            const b = `${unique('b')}@example.com`;
            const cAddress = `${unique('c')}@example.com`;
            await addAddress(owner, b);
            await addAddress(owner, cAddress);
            const oc = await client(owner);
            const before = await call(oc, 'Identity/get');
            const d = `${unique('d')}@example.com`;
            await addAddress(owner, d);
            await api('DELETE', `/users/${owner.id}/addresses/${await addressId(owner, cAddress)}`);
            await api('PUT', `/users/${owner.id}/addresses/${await addressId(owner, b)}`, { name: 'Renamed' });
            const result = await call(oc, 'Identity/changes', { sinceState: before.state });
            const after = await identities(oc);
            expect(result.created).to.deep.equal([byEmail(after, d).id]);
            expect(result.destroyed).to.deep.equal([byEmail(before.list, cAddress).id]);
            expect(result.updated).to.deep.equal([byEmail(before.list, b).id]);
        });

        scenario('IDN-051', async () => {
            const owner = await accounts.createUser();
            const b = `${unique('b')}@example.com`;
            await addAddress(owner, b);
            const oc = await client(owner);
            const before = await call(oc, 'Identity/get');
            await api('PUT', `/users/${owner.id}/addresses/${await addressId(owner, b)}`, { main: true });
            const result = await call(oc, 'Identity/changes', { sinceState: before.state });
            expect(result.updated.sort()).to.deep.equal(before.list.map(identity => identity.id).sort());
            expect(result.created).to.deep.equal([]);
            expect(result.destroyed).to.deep.equal([]);
        });

        scenario('IDN-052', async () => {
            const a = await accounts.createUser();
            const b = await accounts.createUser();
            const x = `${unique('x')}@example.com`;
            await addAddress(a, x);
            const ac = await client(a);
            const bc = await client(b);
            const aBefore = await call(ac, 'Identity/get');
            await set(ac, { update: { [byEmail(aBefore.list, x).id]: { textSignature: 'mine' } } });
            const aState = (await call(ac, 'Identity/get')).state;
            const bState = (await call(bc, 'Identity/get')).state;
            await api('DELETE', `/users/${a.id}/addresses/${await addressId(a, x)}`);
            await addAddress(b, x);
            const aChanges = await call(ac, 'Identity/changes', { sinceState: aState });
            const bChanges = await call(bc, 'Identity/changes', { sinceState: bState });
            expect(aChanges.destroyed).to.deep.equal([byEmail(aBefore.list, x).id]);
            const moved = byEmail(await identities(bc), x);
            expect(bChanges.created).to.deep.equal([moved.id]);
            expect(moved.id).to.not.equal(byEmail(aBefore.list, x).id);
            expect(moved.textSignature).to.equal('');
        });

        scenario('IDN-053', async () => {
            const owner = await accounts.createUser();
            const oc = await client(owner);
            const emailState = (await oc.method('Email/get', { ids: [] })).state;
            for (const sinceState of ['o1.1.00000000', emailState]) {
                await failsWith(call(oc, 'Identity/changes', { sinceState }), 'cannotCalculateChanges');
            }
            // a real state from more than the retention ago, with changes since
            await set(oc, { create: { x: { email: owner.address } } });
            const db = await seed.db();
            await db
                .collection('jmapstate')
                .updateOne({ _id: new seed.ObjectId(owner.id) }, { $set: { 'seqTime.Identity': new Date(Date.now() - 31 * 24 * 3600 * 1000) } });
            const old = (await call(oc, 'Identity/get')).state;
            await set(oc, { create: { y: { email: owner.address } } });
            await failsWith(call(oc, 'Identity/changes', { sinceState: old }), 'cannotCalculateChanges');
            const fresh = (await call(oc, 'Identity/get')).state;
            await set(oc, { create: { z: { email: owner.address } } });
            expect((await call(oc, 'Identity/changes', { sinceState: fresh })).created).to.have.length(1);
        });

        scenario('IDN-054', async () => {
            const s1 = await state();
            const ids = [];
            for (let i = 0; i < 5; i++) {
                ids.push(await create());
            }
            const seen = [];
            let since = s1;
            for (let round = 0; round < 10; round++) {
                const result = await call(c, 'Identity/changes', { sinceState: since, maxChanges: 2 });
                expect(result.created.length + result.updated.length + result.destroyed.length).to.be.at.most(2);
                seen.push(...result.created);
                since = result.newState;
                if (!result.hasMoreChanges) {
                    break;
                }
            }
            expect(seen.sort()).to.deep.equal(ids.sort());
            expect(since).to.equal(await state());
            await failsWith(call(c, 'Identity/changes', { sinceState: s1, maxChanges: 0 }), 'invalidArguments');
        });

        scenario('IDN-055', async () => {
            const s = await state();
            await seed.deliver(user.address, 'From: a@example.net\r\nSubject: mail activity\r\n\r\nbody\r\n');
            await seed.withImap(user, async imap => {
                await imap.mailboxCreate(unique('Folder'));
                await imap.mailboxOpen('INBOX');
                await imap.messageFlagsAdd('1:*', ['\\Flagged']);
            });
            expect(await state()).to.equal(s);
            expect(await call(c, 'Identity/changes', { sinceState: s })).to.deep.include({ created: [], updated: [], destroyed: [] });
        });
    });

    describe('push and session', () => {
        scenario('IDN-056', async () => {
            const user = await accounts.createUser();
            const c = await client(user);
            const added = `${unique('push')}@example.com`;
            const first = await waitForEvent(
                user,
                'Identity',
                event => !!Object.values(event.changed)[0].Identity,
                () => addAddress(user, added)
            );
            expect(first, 'no event after the REST change').to.exist;
            expect(first.changed[c.accountId].Identity).to.equal((await call(c, 'Identity/get')).state);
            const [main] = await identities(c);
            const second = await waitForEvent(
                user,
                'Identity',
                event => !!Object.values(event.changed)[0].Identity,
                () => set(c, { update: { [main.id]: { name: 'Pushed' } } })
            );
            expect(second, 'no event after Identity/set').to.exist;
            expect(second.changed[c.accountId].Identity).to.equal((await call(c, 'Identity/get')).state);
        });

        scenario('IDN-057', async () => {
            const user = await accounts.createUser();
            const c = jmap.forUser(user);
            const t1 = await c.session();
            const b = `${unique('b')}@example.com`;
            await addAddress(user, b);
            const afterAdd = await c.session();
            expect(afterAdd.state).to.equal(t1.state);
            await api('PUT', `/users/${user.id}/addresses/${await addressId(user, b)}`, { main: true });
            const t2 = await c.session();
            expect(t2.state).to.not.equal(t1.state);
            expect(t2.accounts[c.accountId].name).to.equal(b);
            const res = await c.request({ using: USING, methodCalls: [['Identity/get', { accountId: c.accountId }, 'a']] });
            expect(res.json.sessionState).to.equal(t2.state);
        });
    });
});
