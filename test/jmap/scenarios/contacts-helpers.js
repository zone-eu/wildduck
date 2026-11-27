'use strict';

// Shared helpers of the contacts scenarios (catalogue file contacts.yaml, RFC 9610).

const { expect } = require('chai');
const config = require('@zone-eu/wild-config');
const { api, accounts, jmap, seed } = require('../harness');
const sse = require('../harness/sse');
const instance = require('../harness/instance');

const USING = [jmap.URN.core, jmap.URN.contacts];
const USING_BLOB = [jmap.URN.core, jmap.URN.contacts, jmap.URN.blob];
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,254}$/;
const REGISTER_ID = 'Aregister';
// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0jpeg test bytes')]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

/** A user with a JMAP client whose session is loaded */
async function createUser(options) {
    const user = await accounts.createUser(options);
    user.client = jmap.forUser(user);
    await user.client.session();
    user.accountId = user.client.accountId;
    return user;
}

/** A client of a JMAP instance other than the test server (other limits) */
async function clientOn(url, user) {
    const client = new jmap.JmapClient(jmap.basic(user.username, user.password));
    const res = await client.raw(`${url}/.well-known/jmap`);
    client.accountId = Object.keys(res.json.accounts)[0];
    client.base = url;
    const raw = client.raw.bind(client);
    client.raw = (path, init) => raw(path.startsWith('http') ? path : url + path, init);
    return client;
}

/** Starts an instance with [jmap.contacts] and [jmap.limits] overrides */
async function startInstance(contacts = {}, limits = {}) {
    const { url } = await instance.startInstance({
        contacts: Object.assign({}, config.jmap.contacts, contacts),
        limits: Object.assign({}, config.jmap.limits, limits)
    });
    return url;
}

/** Runs one method call, answers its arguments; an error response throws with err.type */
const call = (c, name, args = {}, using = USING) => c.method(name, args, using);

/** Runs method calls (accountId: true is filled in), answers the method responses */
const calls = (c, methodCalls, using = USING) => c.call(methodCalls, using);

async function failsWith(promise, type) {
    try {
        await promise;
    } catch (err) {
        expect(err.type, err.message).to.equal(type);
        return err;
    }
    throw new Error(`expected ${type}`);
}

const getBooks = async (c, args = {}) => call(c, 'AddressBook/get', args);
const books = async c => (await getBooks(c)).list;
const defaultBook = async c => (await books(c)).find(book => book.isDefault);
const bookState = async c => (await getBooks(c, { ids: [] })).state;
const cardState = async c => (await call(c, 'ContactCard/get', { ids: [] })).state;
const setBooks = (c, args) => call(c, 'AddressBook/set', args);
const setCards = (c, args) => call(c, 'ContactCard/set', args);

/** Creates an address book, answers its id */
async function createBook(c, values = {}) {
    const res = await setBooks(c, { create: { b: Object.assign({ name: `Book ${Math.random().toString(36).slice(2, 8)}` }, values) } });
    expect(res.created, JSON.stringify(res.notCreated)).to.have.property('b');
    return res.created.b.id;
}

/** Creates a card (in the default book unless addressBookIds is given), answers {id, created} */
async function createCard(c, values = {}) {
    const book = values.addressBookIds ? null : (await defaultBook(c)).id;
    const card = Object.assign({ addressBookIds: book ? { [book]: true } : undefined, name: { full: 'Test Contact' } }, values);
    const res = await setCards(c, { create: { k: card } });
    expect(res.created, JSON.stringify(res.notCreated)).to.have.property('k');
    return Object.assign({ created: res.created.k }, res.created.k);
}

/** Creates several cards in one call, answers their ids in order */
async function createCards(c, list, book) {
    const target = book || (await defaultBook(c)).id;
    const create = Object.fromEntries(
        list.map((values, index) => [`k${index}`, Object.assign({ addressBookIds: { [target]: true }, name: { full: `Card ${index}` } }, values)])
    );
    const res = await setCards(c, { create });
    expect(Object.keys(res.created || {}).length, JSON.stringify(res.notCreated)).to.equal(list.length);
    return list.map((values, index) => res.created[`k${index}`].id);
}

/** Answers the outcome of creating one card: {created} or {notCreated} */
async function tryCreate(c, card, book) {
    const target = book || (await defaultBook(c)).id;
    const res = await setCards(c, { create: { k: Object.assign({ addressBookIds: { [target]: true } }, card) } });
    return res;
}

/** Expects the create of a card to fail with a SetError; answers the SetError */
async function createFails(c, card, type, properties, book) {
    const res = await tryCreate(c, card, book);
    expect(res.created, JSON.stringify(card)).to.equal(null);
    expect(res.notCreated.k.type, JSON.stringify(res.notCreated.k)).to.equal(type);
    if (properties) {
        for (const property of [].concat(properties)) {
            expect(res.notCreated.k.properties, JSON.stringify(card)).to.include(property);
        }
    }
    return res.notCreated.k;
}

/** Expects an update to fail; answers the SetError */
async function updateFails(c, id, patch, type, properties) {
    const res = await setCards(c, { update: { [id]: patch } });
    expect(res.updated, JSON.stringify(patch)).to.equal(null);
    expect(res.notUpdated[id].type, JSON.stringify(res.notUpdated[id])).to.equal(type);
    if (properties) {
        for (const property of [].concat(properties)) {
            expect(res.notUpdated[id].properties, JSON.stringify(patch)).to.include(property);
        }
    }
    return res.notUpdated[id];
}

async function updateCard(c, id, patch) {
    const res = await setCards(c, { update: { [id]: patch } });
    expect(res.updated, JSON.stringify(res.notUpdated)).to.have.property(id);
    return res;
}

const getCard = async (c, id, properties) => (await call(c, 'ContactCard/get', Object.assign({ ids: [id] }, properties ? { properties } : {}))).list[0];

/** The ids of a ContactCard/query */
const queryIds = async (c, args) => (await call(c, 'ContactCard/query', args)).ids;

/** Adds an address register entry through the REST submit endpoint, as sending mail does */
async function registerEntry(user, name, address) {
    await api('POST', `/users/${user.id}/submit`, {
        to: [{ name, address }],
        subject: 'register',
        text: 'hello'
    });
    return waitRegister(user, address);
}

/** Waits until the register of the user has the address, answers the entry */
async function waitRegister(user, address) {
    for (let i = 0; i < 50; i++) {
        const res = await api('GET', `/users/${user.id}/addressregister?query=${encodeURIComponent(address.split('@')[0])}`);
        const entry = (res.results || []).find(item => item.address === address.toLowerCase() || item.address === address);
        if (entry) {
            return entry;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`register entry ${address} not found`);
}

/** The register cards of the account */
async function registerCards(c) {
    const ids = await queryIds(c, { filter: { inAddressBook: REGISTER_ID } });
    return ids.length ? (await call(c, 'ContactCard/get', { ids })).list : [];
}

/** Uploads a blob, answers the upload response */
async function upload(c, content, type) {
    const res = await c.raw(`/jmap/upload/${c.accountId}/`, { method: 'POST', headers: { 'Content-Type': type }, body: content });
    expect(res.status, res.body.toString()).to.equal(200);
    return res.json;
}

async function download(c, blobId, name = 'file', type = 'application/octet-stream') {
    return c.raw(`/jmap/download/${c.accountId}/${blobId}/${name}?type=${encodeURIComponent(type)}`);
}

const dataUri = (content, type) => `data:${type};base64,${content.toString('base64')}`;

/** Opens an event source stream of the user */
async function openStream(user, types = '*') {
    const es = await sse.open(`/jmap/eventsource/?types=${types}&closeafter=no&ping=0`, { authorization: jmap.basic(user.username, user.password) });
    expect(es.status).to.equal(200);
    // the stream is listening once it sent its connected comment
    await es.until(() => es.comments.some(comment => comment.text.includes('connected')), 5000, 'the stream did not connect');
    return es;
}

/** The changes of ContactCard since a state, all pages */
async function allChanges(c, type, sinceState, maxChanges) {
    const result = { created: [], updated: [], destroyed: [], pages: [] };
    let state = sinceState;
    for (let i = 0; i < 100; i++) {
        const page = await call(c, `${type}/changes`, Object.assign({ sinceState: state }, maxChanges ? { maxChanges } : {}));
        result.pages.push(page);
        result.created.push(...page.created);
        result.updated.push(...page.updated);
        result.destroyed.push(...page.destroyed);
        state = page.newState;
        if (!page.hasMoreChanges) {
            break;
        }
    }
    result.newState = state;
    return result;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
    USING,
    USING_BLOB,
    ID,
    REGISTER_ID,
    PNG,
    JPEG,
    PDF,
    createUser,
    clientOn,
    startInstance,
    call,
    calls,
    failsWith,
    getBooks,
    books,
    defaultBook,
    bookState,
    cardState,
    setBooks,
    setCards,
    createBook,
    createCard,
    createCards,
    tryCreate,
    createFails,
    updateFails,
    updateCard,
    getCard,
    queryIds,
    registerEntry,
    waitRegister,
    registerCards,
    upload,
    download,
    dataUri,
    openStream,
    allChanges,
    delay,
    seed,
    api
};
