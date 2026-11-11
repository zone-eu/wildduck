'use strict';

// ContactCard/get, ContactCard/changes, ContactCard/set and ContactCard/copy (RFC 9610 3).
//
// A ContactCard is a JSContact Card (RFC 9553) with an id and the ids of its address books. Stored cards
// keep the Card exactly as the client sent it (map keys, order, unknown and vendor properties), with
// the server maintaining uid (when the client sent none), created and updated. Media given as data:
// URIs or uploaded blobs become contact media blobs (contact-media.js).
//
// The read only address register book holds one synthesised card per enabled register entry: its
// id is "R" and the entry id, its uid is derived from the entry id, and it has the name and address of
// the entry. Those cards can not be changed. Changes to register entries reach ContactCard/changes
// through lib/jmap/contacts-sync.js.

const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const consts = require('../../consts');
const { URN } = require('../capabilities');
const { formatId, parseId, parseBlobId, blobId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { SetError, invalidProperties } = require('../set-errors');
const { requireAccount, checkArguments, isObject, setOwn } = require('./common');
const { changeLogFor } = require('../changelog');
const { applyPatch } = require('../patch');
const { runSet, resolveId } = require('../set');
const { maxChangesOf } = require('../state');
const { formatUTCDate } = require('../utcdate');
const { readBlob } = require('../blob');
const { validateCard, VERSION, escapeToken } = require('../../schemas/jscontact');
const { termsOf, sortValues } = require('../contact-search');
const { mediaTypeFor, parseDataUri } = require('../contact-media');
const { CARD_TYPE, CARDS, REGISTER } = require('../../contact-handler');
const { contactsOf, loadBooks, findBook, formatBookId, REGISTER_ID } = require('./addressbook');

const TYPE = CARD_TYPE;
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;
// tries of an update that met a concurrent change of the same card
const UPDATE_ATTEMPTS = 5;
// most octets of card JSON one ContactCard/get call returns
const MAX_GET_SIZE = 64 * 1024 * 1024;
const REGISTER_UID = /^urn:uuid:00000000-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/;

const state = context => changeLogFor(context).state(context.account.user, context.account.id, TYPE);

/** The JMAP id of a card: a stored card or a register entry ("R"), and of a tombstone (stored as its id) */
const formatCardId = id => (typeof id === 'string' ? id : formatId('contactCard', id));

// ---------------------------------------------------------------- register cards

/** The uid of a register card: a urn:uuid made of the entry id */
function registerUid(id) {
    const hex = `00000000${id.toString()}`;
    return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The register entry id a register card uid names, or null */
function registerUidEntry(uid) {
    const match = typeof uid === 'string' && REGISTER_UID.exec(uid);
    return match ? new ObjectId(match.slice(1).join('')) : null;
}

/** The Card of a register entry */
function registerCard(entry) {
    const created = entry._id.getTimestamp();
    const card = { '@type': 'Card', version: VERSION, uid: registerUid(entry._id) };
    if (entry.name) {
        card.name = { full: entry.name };
    }
    card.emails = { e1: { address: entry.address } };
    card.created = formatUTCDate(created, { seconds: true });
    card.updated = formatUTCDate(entry.changed || created, { seconds: true });
    return card;
}

/** A query and get record of a register entry */
function registerRecord(entry) {
    const card = registerCard(entry);
    return {
        id: formatId('registerCard', entry._id),
        register: true,
        card,
        books: [REGISTER_ID],
        uid: card.uid,
        kind: 'individual',
        members: [],
        created: new Date(card.created),
        updated: new Date(card.updated),
        sort: {}
    };
}

// ---------------------------------------------------------------- stored cards

/** A query and get record of a stored card document; the Card is parsed when the document has it */
function storedRecord(doc) {
    return {
        id: formatCardId(doc._id),
        doc,
        card: doc.json ? JSON.parse(doc.json) : null,
        books: (doc.addressBooks || []).map(formatBookId),
        uid: doc.uid,
        kind: doc.kind,
        members: doc.members || [],
        created: doc.created || null,
        updated: doc.updated || null,
        sort: doc.sort || {}
    };
}

/** The ContactCard of a record: the Card with id and addressBookIds */
function toContactCard(record) {
    const object = { id: record.id, addressBookIds: Object.fromEntries(record.books.map(id => [id, true])) };
    for (const [key, value] of Object.entries(record.card)) {
        setOwn(object, key, value);
    }
    return object;
}

/** The stored fields of a Card that queries, sorting and limits need */
function cardFields(card, books) {
    const json = JSON.stringify(card);
    const { terms, truncated } = termsOf(card);
    const fields = {
        json,
        size: Buffer.byteLength(json),
        addressBooks: books,
        uid: card.uid,
        kind: typeof card.kind === 'string' ? card.kind : 'individual',
        members: isObject(card.members) ? Object.keys(card.members) : [],
        created: card.created ? new Date(card.created) : null,
        updated: new Date(card.updated),
        sort: sortValues(card),
        terms,
        blobs: Object.values(isObject(card.media) ? card.media : {})
            .map(entry => parseBlobId(entry && entry.blobId))
            .filter(parsed => parsed && parsed.kind === 'media')
            .map(parsed => parsed.id)
    };
    if (truncated) {
        fields.termsTruncated = true;
    }
    return fields;
}

// ---------------------------------------------------------------- get and changes

function checkGetProperties(properties) {
    if (properties === undefined || properties === null) {
        return null;
    }
    // JSContact has unknown and vendor properties, so any name is accepted (CARD-005)
    if (!Array.isArray(properties) || properties.some(property => typeof property !== 'string' || !property.length || property.includes('/'))) {
        throw invalidArguments('properties must be a list of property names');
    }
    return properties;
}

function pick(object, properties) {
    if (!properties) {
        return object;
    }
    const result = { id: object.id };
    for (const property of properties) {
        if (property !== 'id' && Object.hasOwn(object, property)) {
            setOwn(result, property, object[property]);
        }
    }
    return result;
}

/** The records of every card of the account (stored and register), within the size budget of a get */
async function allRecords(context, limit) {
    const contacts = contactsOf(context);
    const user = context.account.user;
    const [docs, entries] = await Promise.all([
        context.deps.database
            .collection(CARDS)
            .find({ user }, { projection: { _id: true, size: true }, maxTimeMS: MAX_TIME_MS })
            .sort({ _id: 1 })
            .limit(limit + 1)
            .toArray(),
        contacts.registerEntries(user)
    ]);
    if (docs.length + entries.length > limit) {
        throw new MethodError('requestTooLarge', { description: `the account has more than ${limit} cards, use ContactCard/query` });
    }
    return [...(await storedRecords(context, docs)), ...entries.map(registerRecord)];
}

/** The records of stored cards, read after their sizes are checked */
async function storedRecords(context, docs) {
    const total = docs.reduce((sum, doc) => sum + (doc.size || 0), 0);
    if (total > MAX_GET_SIZE) {
        throw new MethodError('requestTooLarge', { description: 'the cards are too large for one response' });
    }
    if (!docs.length) {
        return [];
    }
    const full = await contactsOf(context).findCards(
        context.account.user,
        docs.map(doc => doc._id)
    );
    const byId = new Map(full.map(doc => [doc._id.toString(), doc]));
    return docs
        .map(doc => byId.get(doc._id.toString()))
        .filter(Boolean)
        .map(storedRecord);
}

/** The records of the cards the ids name, by id (unknown ids are left out) */
async function recordsById(context, ids) {
    const stored = [];
    const register = [];
    for (const id of ids) {
        const card = parseId('contactCard', id);
        const entry = !card && parseId('registerCard', id);
        if (card) {
            stored.push(card);
        } else if (entry) {
            register.push(entry);
        }
    }
    const user = context.account.user;
    const [docs, entries] = await Promise.all([
        stored.length
            ? context.deps.database
                  .collection(CARDS)
                  .find({ user, _id: { $in: stored } }, { projection: { _id: true, size: true }, maxTimeMS: MAX_TIME_MS })
                  .toArray()
            : [],
        register.length ? contactsOf(context).registerEntries(user, { ids: register }) : []
    ]);
    const records = [...(await storedRecords(context, docs)), ...entries.map(registerRecord)];
    return new Map(records.map(record => [record.id, record]));
}

async function get(args, context) {
    checkArguments(args, ['accountId', 'ids', 'properties']);
    requireAccount(args, context);
    const properties = checkGetProperties(args.properties);
    if (args.ids !== undefined && args.ids !== null && !(Array.isArray(args.ids) && args.ids.every(id => typeof id === 'string'))) {
        throw invalidArguments('ids must be a list of ids');
    }
    const limit = context.limits.maxObjectsInGet;
    if (args.ids && args.ids.length > limit) {
        throw new MethodError('requestTooLarge');
    }
    await loadBooks(context);
    const result = { accountId: context.account.id, state: await state(context), list: [], notFound: [] };
    if (args.ids === undefined || args.ids === null) {
        result.list = (await allRecords(context, limit)).map(record => pick(toContactCard(record), properties));
        return result;
    }
    const resolved = args.ids.map(reference => resolveId(context, reference));
    const records = await recordsById(context, resolved.filter(Boolean));
    args.ids.forEach((reference, index) => {
        const record = resolved[index] && records.get(resolved[index]);
        if (record) {
            result.list.push(pick(toContactCard(record), properties));
        } else {
            result.notFound.push(reference);
        }
    });
    return result;
}

// the live objects of ContactCard: stored cards and enabled register entries
const CHANGE_SOURCES = [
    { collection: CARDS, formatId: formatCardId },
    { collection: REGISTER, formatId: id => formatId('registerCard', id), filter: { disabled: false } }
];

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const maxChanges = maxChangesOf(args);
    await loadBooks(context);
    const result = await changeLogFor(context).changes({
        user: context.account.user,
        accountId: context.account.id,
        type: TYPE,
        sources: CHANGE_SOURCES,
        sinceState: args.sinceState,
        maxChanges: Math.min(maxChanges, context.limits.maxObjectsInGet),
        formatId: formatCardId
    });
    return Object.assign({ accountId: context.account.id }, result);
}

// ---------------------------------------------------------------- set

/**
 * Checks addressBookIds of a new or patched card.
 *
 * @returns {Promise<ObjectId[]>} the stored address books
 */
async function checkBooks(context, value) {
    if (!isObject(value) || !Object.keys(value).length || Object.values(value).some(flag => flag !== true)) {
        throw invalidProperties('addressBookIds', 'addressBookIds must name at least one address book, each with the value true');
    }
    const resolved = [];
    for (const reference of Object.keys(value)) {
        const id = resolveId(context, reference);
        resolved.push(id && (await findBook(context, id)));
    }
    if (resolved.some(book => !book)) {
        throw invalidProperties('addressBookIds', 'unknown address book');
    }
    if (resolved.includes(REGISTER_ID)) {
        throw new SetError('forbidden', 'cards can not be added to the address register');
    }
    const books = [...new Map(resolved.map(book => [book._id.toString(), book._id])).values()];
    const limits = contactsOf(context).limits;
    if (limits.maxAddressBooksPerCard && books.length > limits.maxAddressBooksPerCard) {
        throw invalidProperties('addressBookIds', `a card is in at most ${limits.maxAddressBooksPerCard} address books`);
    }
    return books;
}

/** The Card part of a ContactCard object: without id and addressBookIds, and without null properties */
function cardPart(object) {
    const card = {};
    for (const [key, value] of Object.entries(object)) {
        if (key !== 'id' && key !== 'addressBookIds' && value !== null) {
            setOwn(card, key, value);
        }
    }
    return card;
}

function checkCard(card) {
    const invalid = validateCard(card, { blobIds: true });
    if (invalid.length) {
        throw invalidProperties(invalid, 'invalid JSContact data');
    }
}

const mediaLimit = context => Math.min(contactsOf(context).limits.maxMediaSize, context.limits.maxSizeUpload);
const tooLarge = (property, description) => new SetError('tooLarge', description, { properties: [property] });

/**
 * Stores the content of one Media entry that has a data: URI or the blobId of something other than a
 * contact media file, and points the entry at the stored file.
 *
 * @param {Object} context
 * @param {Object} entry the Media object, changed in place
 * @param {String} path its path in the card, for errors
 * @param {ObjectId[]} stored media files stored so far, removed again when the card is not saved
 * @returns {Promise<Boolean>} true when the entry was changed
 */
async function storeMediaEntry(context, entry, path, stored) {
    const contacts = contactsOf(context);
    const user = context.account.user;
    const limit = mediaLimit(context);
    let content;
    let declared = typeof entry.mediaType === 'string' ? entry.mediaType : null;
    if (typeof entry.uri === 'string' && /^data:/i.test(entry.uri)) {
        let parsed;
        try {
            parsed = parseDataUri(entry.uri, limit);
        } catch (err) {
            throw tooLarge(`${path}/uri`, `the data is larger than ${limit} octets`);
        }
        if (!parsed) {
            throw invalidProperties(`${path}/uri`, 'malformed data: URI');
        }
        content = parsed.content;
        declared = parsed.type || declared;
    } else if (typeof entry.blobId === 'string') {
        const parsed = parseBlobId(resolveId(context, entry.blobId));
        if (parsed && parsed.kind === 'media') {
            const media = await contacts.getMedia(user, parsed.id, { statOnly: true });
            if (!media) {
                throw invalidProperties(`${path}/blobId`, 'unknown blob');
            }
            entry.blobId = blobId.media(parsed.id);
            entry.mediaType = media.contentType;
            return false;
        }
        try {
            content = await readBlob(context, entry.blobId, limit);
        } catch (err) {
            if (err.code === 'BlobTooLarge') {
                throw tooLarge(`${path}/blobId`, `the blob is larger than ${limit} octets`);
            }
            throw err;
        }
        if (!content) {
            throw invalidProperties(`${path}/blobId`, 'unknown blob');
        }
    } else {
        return false;
    }
    const type = mediaTypeFor(entry.kind, content, declared);
    if (!type) {
        throw invalidProperties(`${path}/${entry.uri !== undefined ? 'uri' : 'blobId'}`, `not a recognised ${entry.kind} file`);
    }
    const id = await contacts.storeMedia(user, content, type);
    stored.push(id);
    delete entry.uri;
    entry.blobId = blobId.media(id);
    entry.mediaType = type;
    return true;
}

/**
 * Turns data: URIs and uploaded blobs of the Media entries into contact media blobs. Entries unchanged
 * since the previous version of the card are left as they are.
 *
 * @returns {Promise<Boolean>} true when an entry was changed (the media property is then reported)
 */
async function storeMedia(context, card, previous, stored) {
    if (!isObject(card.media)) {
        return false;
    }
    let changed = false;
    const before = previous && isObject(previous.media) ? previous.media : {};
    for (const [key, entry] of Object.entries(card.media)) {
        if (!isObject(entry) || (Object.hasOwn(before, key) && JSON.stringify(before[key]) === JSON.stringify(entry))) {
            continue;
        }
        changed = (await storeMediaEntry(context, entry, `media/${escapeToken(key)}`, stored)) || changed;
    }
    return changed;
}

const now = () => formatUTCDate(new Date(), { seconds: true });

/** Fails when the uid is the uid of a register card */
async function checkRegisterUid(context, uid) {
    const entry = registerUidEntry(uid);
    if (entry && (await contactsOf(context).registerEntries(context.account.user, { ids: [entry] })).length) {
        throw invalidProperties('uid', 'the uid is used by a card of the address register');
    }
}

/** Fails when the stored card would be larger than the card size limit */
function checkSize(context, fields) {
    const limits = contactsOf(context).limits;
    if (fields.size > limits.maxCardSize) {
        throw new SetError('tooLarge', `a card has at most ${limits.maxCardSize} octets of JSON`);
    }
}

async function createCard(context, object, counter) {
    const contacts = contactsOf(context);
    if (Object.hasOwn(object, 'id')) {
        throw invalidProperties('id', 'id is set by the server');
    }
    const books = await checkBooks(context, object.addressBookIds);
    const card = cardPart(object);
    const reported = {};
    const fill = (property, value) => {
        if (card[property] === undefined || property === 'updated') {
            if (card[property] !== value) {
                reported[property] = value;
            }
            card[property] = value;
        }
    };
    fill('@type', 'Card');
    fill('version', VERSION);
    fill('uid', `urn:uuid:${crypto.randomUUID()}`);
    fill('created', now());
    fill('updated', now());
    checkCard(card);
    await checkRegisterUid(context, card.uid);
    if (counter.count >= contacts.limits.maxCards) {
        throw new SetError('overQuota', `an account has at most ${contacts.limits.maxCards} cards`);
    }

    const stored = [];
    try {
        if (await storeMedia(context, card, null, stored)) {
            reported.media = card.media;
        }
        const fields = cardFields(card, books);
        checkSize(context, fields);
        const doc = await contacts.insertCard(context.account.user, fields);
        counter.count++;
        return Object.assign({ id: formatCardId(doc._id) }, reported);
    } catch (err) {
        await contacts.releaseMedia(context.account.user, stored);
        if (err.code === 'DuplicateUid') {
            throw invalidProperties('uid', 'a card with this uid exists in the account');
        }
        throw err;
    }
}

/** The changed card and its stored fields after a patch, or null when the patch changes nothing */
async function patchCard(context, doc, patch, stored) {
    const record = storedRecord(doc);
    const current = toContactCard(record);
    const { object: patched } = applyPatch(current, patch, { arrays: true });
    if (patched.id !== current.id) {
        throw invalidProperties('id', 'id can not be changed');
    }
    if (patched.uid !== current.uid) {
        throw invalidProperties('uid', 'uid can not be changed');
    }
    const books = await checkBooks(context, patched.addressBookIds);
    const card = cardPart(patched);
    // the server keeps updated
    card.updated = record.card.updated;
    checkCard(card);
    const sameBooks = books.length === doc.addressBooks.length && books.every(id => doc.addressBooks.some(other => other.equals(id)));
    if (sameBooks && JSON.stringify(card) === doc.json) {
        return null;
    }
    const reported = {};
    if (await storeMedia(context, card, record.card, stored)) {
        reported.media = card.media;
    }
    card.updated = now();
    if (card.updated !== record.card.updated) {
        reported.updated = card.updated;
    }
    return { fields: cardFields(card, books), reported };
}

async function updateCard(context, id, patch) {
    const contacts = contactsOf(context);
    const user = context.account.user;
    if (parseId('registerCard', id)) {
        await registerCardOrNotFound(context, id);
    }
    const cardId = parseId('contactCard', id);
    for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
        const [doc] = cardId ? await contacts.findCards(user, [cardId]) : [];
        if (!doc) {
            throw new SetError('notFound');
        }
        const stored = [];
        try {
            const result = await patchCard(context, doc, patch, stored);
            if (!result) {
                return null;
            }
            checkSize(context, result.fields);
            if (await contacts.replaceCard(user, doc, result.fields)) {
                return Object.keys(result.reported).length ? result.reported : null;
            }
        } catch (err) {
            await contacts.releaseMedia(user, stored);
            throw err;
        }
        // changed by someone else meanwhile: the patch is applied to the new version
        await contacts.releaseMedia(user, stored);
    }
    throw new SetError('forbidden', 'the card is changed concurrently, try again');
}

/** Register cards can not be changed: forbidden for an existing one, notFound otherwise */
async function registerCardOrNotFound(context, id) {
    const entry = parseId('registerCard', id);
    const found = entry && (await contactsOf(context).registerEntries(context.account.user, { ids: [entry] })).length;
    throw found ? new SetError('forbidden', 'cards of the address register can not be changed') : new SetError('notFound');
}

async function destroyCard(context, id) {
    if (parseId('registerCard', id)) {
        await registerCardOrNotFound(context, id);
    }
    const cardId = parseId('contactCard', id);
    const contacts = contactsOf(context);
    const [doc] = cardId ? await contacts.findCards(context.account.user, [cardId], { _id: true, createdSeq: true, blobs: true }) : [];
    if (!doc) {
        throw new SetError('notFound');
    }
    await contacts.destroyCards(context.account.user, [doc]);
}

async function set(args, context) {
    const counter = { count: null };
    return runSet(args, context, {
        state: () => state(context),
        prepare: async () => {
            await loadBooks(context);
            if (Object.keys(args.create || {}).length) {
                counter.count = await contactsOf(context).countCards(context.account.user);
            }
        },
        create: object => createCard(context, object, counter),
        update: (id, patch) => updateCard(context, id, patch),
        destroy: async id => {
            await destroyCard(context, id);
            if (counter.count !== null) {
                counter.count--;
            }
        }
    });
}

// ---------------------------------------------------------------- copy

/**
 * ContactCard/copy (RFC 8620 5.4). There is one account per user and no sharing, so the only call that
 * names two valid accounts names the same one twice: the method answers the RFC errors (plan 1.3).
 */
async function copy(args, context) {
    checkArguments(args, ['fromAccountId', 'ifFromInState', 'accountId', 'ifInState', 'create', 'onSuccessDestroyOriginal', 'destroyFromIfInState']);
    requireAccount(args, context);
    if (typeof args.fromAccountId !== 'string') {
        throw invalidArguments('fromAccountId is required');
    }
    if (!isObject(args.create)) {
        throw invalidArguments('create must be an object');
    }
    for (const key of ['ifFromInState', 'ifInState', 'destroyFromIfInState']) {
        if (args[key] !== undefined && args[key] !== null && typeof args[key] !== 'string') {
            throw invalidArguments(`${key} must be a string`);
        }
    }
    if (args.onSuccessDestroyOriginal !== undefined && typeof args.onSuccessDestroyOriginal !== 'boolean') {
        throw invalidArguments('onSuccessDestroyOriginal must be a boolean');
    }
    if (args.fromAccountId === context.account.id) {
        throw invalidArguments('fromAccountId and accountId must name different accounts');
    }
    throw new MethodError('fromAccountNotFound');
}

// ---------------------------------------------------------------- blobs

/**
 * The cards that reference contact media blobs, for Blob/lookup.
 *
 * @param {Object} context
 * @param {ObjectId[]} ids media ids
 * @returns {Promise<Map<String, String[]>>} media id (hex) -> card ids
 */
async function cardsOfMedia(context, ids) {
    const result = new Map();
    if (!ids.length) {
        return result;
    }
    for (const doc of await contactsOf(context).cardsWithMedia(context.account.user, ids)) {
        for (const media of doc.blobs || []) {
            const key = media.toString();
            result.set(key, [...(result.get(key) || []), formatCardId(doc._id)]);
        }
    }
    return result;
}

const pushStates = async context => ({ [TYPE]: await state(context) });

module.exports = {
    capability: URN.contacts,
    methods: { 'ContactCard/get': get, 'ContactCard/changes': changes, 'ContactCard/set': set, 'ContactCard/copy': copy },
    pushTypes: [TYPE],
    pushStates,
    state,
    storedRecord,
    registerRecord,
    toContactCard,
    cardsOfMedia,
    registerUid,
    formatCardId
};
