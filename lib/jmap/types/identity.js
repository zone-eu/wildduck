'use strict';

// Identity/get, Identity/changes and Identity/set (RFC 8621 6).
//
// The addresses of a user, and the exact and *@domain entries of its fromWhitelist, are its sending
// rights. Each right has one derived identity; more identities for a right can be created over JMAP.
// Identities live in jmapidentities and are reconciled with the sending rights when an Identity method
// runs (one query on the user's addresses), so address changes made through the REST API or anywhere
// else appear as created, updated and destroyed identities in the owned change log without a hook in
// those writers. A derived identity carries `source` (the right) and keeps the name in the address
// document, so a name change is visible in both APIs. Destroying a derived identity hides it; the
// address itself is never removed.

const { ObjectId } = require('mongodb');
const tools = require('../../tools');
const consts = require('../../consts');
const { URN } = require('../capabilities');
const { formatId, parseId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { SetError, invalidProperties } = require('../set-errors');
const { requireAccount, checkArguments } = require('./common');
const { changeLogFor } = require('../changelog');
const { applyPatch } = require('../patch');
const { runSet, resolveId } = require('../set');
const { encodeAddress } = require('../email-builder');

const TYPE = 'Identity';
const COLLECTION = 'jmapidentities';
const PROPERTIES = ['id', 'name', 'email', 'replyTo', 'bcc', 'textSignature', 'htmlSignature', 'mayDelete'];
const WRITABLE = ['name', 'replyTo', 'bcc', 'textSignature', 'htmlSignature'];
const LIMITS = { maxIdentities: 100, maxName: 256, maxSignature: 64 * 1024, maxAddresses: 50 };
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;

const limitsOf = context => Object.assign({}, LIMITS, context.options.identities || {});
const collection = context => context.deps.database.collection(COLLECTION);

// ---------------------------------------------------------------- sending rights

/** An address the identity model can represent: plain, or the *@domain wildcard */
const representable = address => typeof address === 'string' && (!address.includes('*') || /^\*@[^*@]+$/.test(address));

/**
 * The sending rights of the user: source key -> {email, name, main}.
 */
async function sendingRights(deps, user) {
    const [userData, addresses] = await Promise.all([
        deps.users.collection('users').findOne({ _id: user }, { projection: { name: true, address: true, fromWhitelist: true }, maxTimeMS: MAX_TIME_MS }),
        deps.users
            .collection('addresses')
            .find({ user }, { projection: { address: true, name: true }, maxTimeMS: MAX_TIME_MS })
            .sort({ _id: 1 })
            .toArray()
    ]);
    const rights = new Map();
    const userName = (userData && userData.name) || '';
    for (const addressData of addresses) {
        if (representable(addressData.address)) {
            const main = !!userData && addressData.address === userData.address;
            rights.set(`a:${addressData._id}`, { email: addressData.address, name: addressData.name || userName, main, address: addressData._id });
        }
    }
    for (const entry of (userData && userData.fromWhitelist) || []) {
        if (representable(entry) && entry.includes('@')) {
            rights.set(`w:${entry}`, { email: entry, name: userName, main: false });
        }
    }
    return { rights, userData };
}

/**
 * The canonical form of an address the user may send from, or null. Covered are the addresses and
 * *@domain wildcards of the sending rights, after WildDuck's address normalisation and domain aliases.
 */
async function maySendFrom(context, email, rights) {
    const coveredBy = candidate => [...rights.values()].find(right => covers(right.email, candidate));
    let right = coveredBy(email);
    let canonical = email;
    if (!right) {
        const resolved = await context.deps.userHandler.asyncResolveAddress(email, { wildcard: true, projection: { address: true } });
        if (!resolved || !resolved.user || !resolved.user.equals(context.account.user) || !resolved.address || resolved.address.includes('*')) {
            return null;
        }
        canonical = resolved.address;
        right = coveredBy(canonical);
    }
    if (!right) {
        return null;
    }
    // an address of a wildcard is stored normalised, an owned address in its stored form
    return right.email.startsWith('*@') ? tools.normalizeAddress(canonical) : right.email;
}

// ---------------------------------------------------------------- reconcile

function loadIdentities(context) {
    if (!context.cache.identities) {
        context.cache.identities = reconcile(context.deps, context.account.user, changeLogFor(context));
    }
    return context.cache.identities;
}

// the main address first, then the derived identities in address order, then the extra ones
const rank = (doc, order) => (doc.main ? -1 : doc.source ? order.indexOf(doc.source) : order.length);

/**
 * Brings the stored identities of a user in line with the sending rights. Each difference is a change
 * in the change log. Runs once per JMAP request, and from the REST API after an address change.
 *
 * @param {Object} deps {database, users}
 * @param {ObjectId} user
 * @param {ChangeLog} log
 * @returns {Promise<{docs: Object[], rights: Map}>} the live identities, the main one first
 */
async function reconcile(deps, user, log) {
    const identities = deps.database.collection(COLLECTION);
    const [{ rights }, docs, hidden] = await Promise.all([
        sendingRights(deps, user),
        identities.find({ user }, { maxTimeMS: MAX_TIME_MS }).toArray(),
        deps.database.collection('jmapstate').findOne({ _id: user }, { projection: { hiddenIdentities: true } })
    ]);
    const hiddenSources = new Set((hidden && hidden.hiddenIdentities) || []);
    const derived = new Map(docs.filter(doc => doc.source).map(doc => [doc.source, doc]));

    // derived identities of rights that are gone, and extra identities whose address can no longer be used
    const gone = docs.filter(doc =>
        doc.source ? !rights.has(doc.source) || hiddenSources.has(doc.source) : ![...rights.values()].some(right => covers(right.email, doc.email))
    );
    if (gone.length) {
        const seq = await log.next(user, TYPE, gone.length);
        await identities.deleteMany({ _id: { $in: gone.map(doc => doc._id) }, user });
        await log.destroyed(
            user,
            TYPE,
            gone.map(doc => ({ id: doc._id, createdSeq: doc.createdSeq })),
            seq
        );
    }

    for (const [source, right] of rights) {
        if (hiddenSources.has(source)) {
            continue;
        }
        const doc = derived.get(source);
        const snapshot = { email: right.email, name: right.name, main: right.main };
        if (!doc) {
            const seq = await log.next(user, TYPE);
            const created = Object.assign({ _id: new ObjectId(), user, source }, snapshot, { createdSeq: seq, modSeq: seq });
            // a concurrent request may have created it first (unique on user and source)
            await identities.insertOne(created).catch(err => (err.code === 11000 ? null : Promise.reject(err)));
        } else if (doc.email !== snapshot.email || doc.name !== snapshot.name || !!doc.main !== snapshot.main) {
            await identities.updateOne({ _id: doc._id, user }, { $set: Object.assign({ modSeq: await log.next(user, TYPE) }, snapshot) });
        }
    }
    const stale = [...hiddenSources].filter(source => !rights.has(source));
    if (stale.length) {
        await deps.database.collection('jmapstate').updateOne({ _id: user }, { $pull: { hiddenIdentities: { $in: stale } } });
    }

    const live = await identities.find({ user }, { maxTimeMS: MAX_TIME_MS }).toArray();
    const order = [...rights.keys()];
    live.sort((a, b) => rank(a, order) - rank(b, order) || (a._id.toString() < b._id.toString() ? -1 : 1));
    return { docs: live, rights };
}

// an email a right covers: the address itself, or any address of a *@domain wildcard
function covers(rightEmail, email) {
    const owned = rightEmail.toLowerCase();
    const lower = (email || '').toLowerCase();
    return owned === lower || (owned.startsWith('*@') && lower.endsWith(owned.slice(1)));
}

function toIdentity(doc, properties) {
    const values = {
        id: formatId('identity', doc._id),
        name: doc.name || '',
        email: doc.email,
        replyTo: doc.replyTo || null,
        bcc: doc.bcc || null,
        textSignature: doc.textSignature || '',
        htmlSignature: doc.htmlSignature || '',
        mayDelete: !doc.main
    };
    return Object.fromEntries(properties.map(property => [property, values[property]]));
}

const state = context => changeLogFor(context).state(context.account.user, context.account.id, TYPE);

// ---------------------------------------------------------------- get and changes

async function get(args, context) {
    checkArguments(args, ['accountId', 'ids', 'properties']);
    requireAccount(args, context);
    const properties = args.properties === undefined || args.properties === null ? PROPERTIES : args.properties;
    if (!Array.isArray(properties) || properties.some(property => !PROPERTIES.includes(property))) {
        throw invalidArguments('unknown property');
    }
    const list = ['id', ...properties.filter(property => property !== 'id')];
    if (args.ids !== undefined && args.ids !== null && !(Array.isArray(args.ids) && args.ids.every(id => typeof id === 'string'))) {
        throw invalidArguments('ids must be a list of ids');
    }
    if (args.ids && args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    const { docs } = await loadIdentities(context);
    const result = { accountId: context.account.id, state: await state(context), list: [], notFound: [] };
    if (args.ids === undefined || args.ids === null) {
        result.list = docs.map(doc => toIdentity(doc, list));
        return result;
    }
    const byId = new Map(docs.map(doc => [formatId('identity', doc._id), doc]));
    for (const reference of args.ids) {
        const id = resolveId(context, reference);
        const doc = id && byId.get(id);
        if (doc) {
            result.list.push(toIdentity(doc, list));
        } else {
            result.notFound.push(reference);
        }
    }
    return result;
}

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const maxChanges = args.maxChanges === undefined || args.maxChanges === null ? 1000 : args.maxChanges;
    if (!Number.isInteger(maxChanges) || maxChanges < 1) {
        throw invalidArguments('maxChanges must be a positive integer');
    }
    await loadIdentities(context);
    const result = await changeLogFor(context).changes({
        user: context.account.user,
        accountId: context.account.id,
        type: TYPE,
        collection: COLLECTION,
        sinceState: args.sinceState,
        maxChanges: Math.min(maxChanges, 1000),
        formatId: id => formatId('identity', id)
    });
    return Object.assign({ accountId: context.account.id }, result);
}

// ---------------------------------------------------------------- set

function checkAddressList(value, property, limits) {
    if (value === null) {
        return null;
    }
    const valid =
        Array.isArray(value) &&
        value.length <= limits.maxAddresses &&
        value.every(
            entry => entry && typeof entry === 'object' && Object.keys(entry).every(key => ['name', 'email'].includes(key)) && encodeAddress(entry) !== null
        );
    if (!valid) {
        throw invalidProperties(property, `${property} must be a list of EmailAddress objects`);
    }
    return value.map(entry => ({ name: entry.name || null, email: entry.email }));
}

/** Validates the writable properties of a create or of a patched object */
function checkValues(object, limits) {
    const values = {};
    for (const property of ['name', 'textSignature', 'htmlSignature']) {
        if (object[property] === undefined) {
            continue;
        }
        if (typeof object[property] !== 'string' || object[property].includes('\x00')) {
            throw invalidProperties(property, `${property} must be a string`);
        }
        const max = property === 'name' ? limits.maxName : limits.maxSignature;
        if (Buffer.byteLength(object[property]) > max) {
            throw new SetError('tooLarge', `${property} is longer than ${max} octets`, { properties: [property] });
        }
        values[property] = object[property];
    }
    for (const property of ['replyTo', 'bcc']) {
        if (object[property] !== undefined) {
            values[property] = checkAddressList(object[property], property, limits);
        }
    }
    return values;
}

function setHandlers(context) {
    const user = context.account.user;
    const log = changeLogFor(context);
    const limits = limitsOf(context);
    const owned = async id => {
        const objectId = parseId('identity', id);
        const { docs } = await loadIdentities(context);
        const doc = objectId && docs.find(entry => entry._id.equals(objectId));
        if (!doc) {
            throw new SetError('notFound');
        }
        return doc;
    };

    return {
        state: () => state(context),
        prepare: () => loadIdentities(context),

        async create(object) {
            const unknown = Object.keys(object).filter(key => key !== 'email' && !WRITABLE.includes(key));
            if (unknown.length) {
                throw invalidProperties(unknown, 'server set or unknown properties');
            }
            if (typeof object.email !== 'string' || encodeAddress({ email: object.email }) === null || !object.email.includes('@')) {
                throw invalidProperties('email', 'email must be an address');
            }
            const values = checkValues(object, limits);
            const { docs, rights } = await loadIdentities(context);
            const email = await maySendFrom(context, object.email, rights);
            if (!email) {
                throw new SetError('forbiddenFrom', 'the account may not send from this address');
            }
            if (docs.length >= limits.maxIdentities) {
                throw new SetError('overQuota', `an account has at most ${limits.maxIdentities} identities`);
            }
            const seq = await log.next(user, TYPE);
            const doc = Object.assign({ _id: new ObjectId(), user, email, name: '' }, values, { createdSeq: seq, modSeq: seq });
            await collection(context).insertOne(doc);
            docs.push(doc);
            // the server set and defaulted properties the client did not give
            const created = toIdentity(doc, PROPERTIES);
            return Object.fromEntries(Object.entries(created).filter(([key]) => key === 'id' || !(key in object)));
        },

        async update(id, patch) {
            const doc = await owned(id);
            const current = toIdentity(doc, PROPERTIES);
            const { object: patched, properties } = applyPatch(current, patch, { properties: PROPERTIES });
            const readOnly = [...properties].filter(
                property => !WRITABLE.includes(property) && JSON.stringify(patched[property]) !== JSON.stringify(current[property])
            );
            if (readOnly.length) {
                throw invalidProperties(readOnly, 'these properties can not be changed');
            }
            for (const property of ['name', 'textSignature', 'htmlSignature']) {
                if (patched[property] === null) {
                    throw invalidProperties(property, `${property} can not be null`);
                }
            }
            const changed = WRITABLE.filter(property => properties.has(property));
            const values = checkValues(Object.fromEntries(changed.map(property => [property, patched[property]])), limits);
            if (!changed.some(property => JSON.stringify(values[property]) !== JSON.stringify(current[property]))) {
                return null;
            }
            if (doc.source && doc.source.startsWith('a:') && 'name' in values) {
                // the name of an address derived identity is the name of the address
                await context.deps.users.collection('addresses').updateOne({ _id: new ObjectId(doc.source.slice(2)), user }, { $set: { name: values.name } });
            }
            await collection(context).updateOne({ _id: doc._id, user }, { $set: Object.assign({ modSeq: await log.next(user, TYPE) }, values) });
            Object.assign(doc, values);
            return null;
        },

        async destroy(id) {
            const doc = await owned(id);
            if (doc.main) {
                throw new SetError('forbidden', 'the identity of the main address can not be destroyed');
            }
            const seq = await log.next(user, TYPE);
            if (doc.source) {
                // hidden, not removed: the address stays and the identity does not come back
                await context.deps.database.collection('jmapstate').updateOne({ _id: user }, { $addToSet: { hiddenIdentities: doc.source } }, { upsert: true });
            }
            await collection(context).deleteOne({ _id: doc._id, user });
            await log.destroyed(user, TYPE, [{ id: doc._id, createdSeq: doc.createdSeq }], seq);
            const { docs } = await loadIdentities(context);
            docs.splice(docs.indexOf(doc), 1);
        }
    };
}

const set = (args, context) => runSet(args, context, setHandlers(context));

const accountCapability = () => ({ maxDelayedSend: 0, submissionExtensions: {} });

// one lookup of the user's jmapstate document; address changes made elsewhere reconcile and notify
const pushStates = async context => ({ Identity: await state(context) });

module.exports = {
    capability: URN.submission,
    accountCapability,
    methods: { 'Identity/get': get, 'Identity/changes': changes, 'Identity/set': set },
    pushTypes: ['Identity'],
    pushStates,
    loadIdentities,
    reconcile,
    maySendFrom
};
