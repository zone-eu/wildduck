'use strict';

// PushSubscription/get and PushSubscription/set (RFC 8620 7.2). Not tied to an account: no accountId,
// no state. A subscription belongs to the credentials that created it (see push/subscriptions.js) and
// receives nothing but its PushVerification until the client sets the verification code.

const crypto = require('crypto');
const log = require('npmlog');
const { ObjectId } = require('mongodb');
const { URN } = require('../capabilities');
const { formatId, parseId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { SetError, invalidProperties } = require('../set-errors');
const { checkArguments } = require('./common');
const { applyPatch } = require('../patch');
const { runSet, resolveId } = require('../set');
const { parseUTCDate, formatUTCDate } = require('../utcdate');
const { RESERVED_TYPES } = require('../routes/eventsource');
const webpush = require('../push/webpush');
const { pushSettings } = require('../push/settings');
const store = require('../push/subscriptions');
const { readStates } = require('../push/states');

const PROPERTIES = ['id', 'deviceClientId', 'url', 'keys', 'verificationCode', 'expires', 'types'];
// url and keys are never returned (RFC 8620 7.2.1)
const SECRET = ['url', 'keys'];
const DEFAULT_PROPERTIES = PROPERTIES.filter(property => !SECRET.includes(property));
const CREATABLE = ['deviceClientId', 'url', 'keys', 'verificationCode', 'expires', 'types'];
const UPDATABLE = ['verificationCode', 'expires', 'types'];
const MAX_DEVICE_CLIENT_ID = 255;
const RATE_WINDOW = 3600;

const credentialsOf = context => store.credentialsOf(context.account.userData);

/** The type names a subscription may list: what the account can push, and the reserved names of later types */
function knownTypes(context) {
    const types = new Set(RESERVED_TYPES);
    for (const module of context.deps.modules || []) {
        for (const type of module.pushTypes || []) {
            types.add(type);
        }
    }
    return types;
}

function toObject(doc, properties) {
    const values = {
        id: formatId('pushSubscription', doc._id),
        deviceClientId: doc.deviceClientId,
        // shown only once verified, so a client can not learn the code of an endpoint it does not control
        verificationCode: doc.verified ? doc.verificationCode : null,
        expires: formatUTCDate(doc.expires),
        types: doc.types || null
    };
    return Object.fromEntries(properties.map(property => [property, values[property]]));
}

// ---------------------------------------------------------------- get

function getProperties(args) {
    if (args.properties === undefined || args.properties === null) {
        return DEFAULT_PROPERTIES;
    }
    if (!Array.isArray(args.properties) || args.properties.some(property => !PROPERTIES.includes(property))) {
        throw invalidArguments('unknown property');
    }
    if (args.properties.some(property => SECRET.includes(property))) {
        throw new MethodError('forbidden', { description: 'url and keys can not be read' });
    }
    return ['id', ...args.properties.filter(property => property !== 'id')];
}

async function get(args, context) {
    checkArguments(args, ['ids', 'properties']);
    const properties = getProperties(args);
    if (args.ids !== undefined && args.ids !== null && !(Array.isArray(args.ids) && args.ids.every(id => typeof id === 'string'))) {
        throw invalidArguments('ids must be a list of ids');
    }
    if (args.ids && args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    const settings = pushSettings(context.options);
    const docs = await store.listOwned(context.deps, context.account.user, credentialsOf(context).cred, settings.maxPerUser * 2);
    const result = { list: [], notFound: [] };
    if (args.ids === undefined || args.ids === null) {
        result.list = docs.map(doc => toObject(doc, properties));
        return result;
    }
    const byId = new Map(docs.map(doc => [formatId('pushSubscription', doc._id), doc]));
    for (const reference of args.ids) {
        const id = resolveId(context, reference);
        const doc = id && byId.get(id);
        if (doc) {
            result.list.push(toObject(doc, properties));
        } else {
            result.notFound.push(reference);
        }
    }
    return result;
}

// ---------------------------------------------------------------- property checks

function checkTypes(value, context) {
    if (value === null) {
        return null;
    }
    const known = knownTypes(context);
    if (!Array.isArray(value) || !value.length || value.some(type => typeof type !== 'string' || !known.has(type))) {
        throw invalidProperties('types', 'types must be null or a non empty list of type names');
    }
    return [...new Set(value)];
}

/**
 * The expiry to store: the requested one, or the longest allowed lifetime when it is missing or too far
 * ahead (RFC 8620 7.2: the server may shorten it and reports the value back).
 *
 * @returns {{expires: Date, changed: Boolean}} changed: the stored value differs from the requested one
 */
function checkExpires(value, settings) {
    const max = new Date(Date.now() + settings.maxLifetime * 1000);
    if (value === undefined || value === null) {
        return { expires: max, changed: true };
    }
    const date = parseUTCDate(value);
    if (!date) {
        throw invalidProperties('expires', 'expires must be a UTCDate');
    }
    if (date <= new Date()) {
        throw invalidProperties('expires', 'expires must be in the future');
    }
    return date > max ? { expires: max, changed: true } : { expires: date, changed: false };
}

function checkCreate(object, context, settings) {
    const unknown = Object.keys(object).filter(property => !CREATABLE.includes(property));
    if (unknown.length) {
        throw invalidProperties(unknown, 'server set or unknown properties');
    }
    const deviceClientId = object.deviceClientId;
    if (typeof deviceClientId !== 'string' || !deviceClientId.length || deviceClientId.length > MAX_DEVICE_CLIENT_ID) {
        throw invalidProperties('deviceClientId', 'deviceClientId must be a non empty string');
    }
    const url = webpush.parsePushUrl(object.url);
    if (!url) {
        throw invalidProperties('url', 'url must be an absolute https URL without credentials');
    }
    let keys = null;
    if (object.keys !== undefined && object.keys !== null) {
        keys = webpush.parseKeys(object.keys);
        if (!keys) {
            throw invalidProperties('keys', 'keys must hold a P-256 public key (p256dh) and a 16 octet auth secret');
        }
    }
    if (object.verificationCode !== undefined && object.verificationCode !== null) {
        throw invalidProperties('verificationCode', 'the verification code is set after the PushVerification arrived');
    }
    const types = object.types === undefined ? null : checkTypes(object.types, context);
    return { deviceClientId, url, keys, types, ...checkExpires(object.expires, settings) };
}

// ---------------------------------------------------------------- set

async function checkTarget(url, settings) {
    try {
        await webpush.resolveTarget(url, { allowHosts: settings.allowHosts, resolve: settings.resolve });
    } catch (err) {
        if (err instanceof webpush.TargetError) {
            throw invalidProperties('url', `url can not be used: ${err.message}`);
        }
        throw err;
    }
}

async function checkLimits(context, settings, user) {
    const count = await store.collection(context.deps).countDocuments({ user }, { limit: settings.maxPerUser, maxTimeMS: store.MAX_TIME_MS });
    if (count >= settings.maxPerUser) {
        throw new SetError('overQuota', `at most ${settings.maxPerUser} push subscriptions`);
    }
    const rate = await context.deps.notifier.counters.asyncTTLCounter(`jmap:push:rate:${user}`, 1, settings.createRate, RATE_WINDOW);
    if (!rate.success) {
        throw new SetError('rateLimit', 'too many push subscriptions created, try again later');
    }
}

/** What the set handlers of one request share */
function scopeOf(context) {
    return {
        context,
        settings: pushSettings(context.options),
        user: context.account.user,
        credentials: credentialsOf(context),
        subscriptions: store.collection(context.deps),
        push: context.deps.push
    };
}

async function ownedSubscription(scope, id) {
    const _id = parseId('pushSubscription', id);
    const doc = _id && (await scope.subscriptions.findOne({ _id, user: scope.user, cred: scope.credentials.cred }, { maxTimeMS: store.MAX_TIME_MS }));
    if (!doc || !store.alive(doc, new Date())) {
        throw new SetError('notFound');
    }
    return doc;
}

// the states the first StateChange is compared with: those at the time of verification, of the
// subscribed types only
const currentStates = (context, types) => readStates(context.deps.modules, context, { types });

// the user gained or may have lost a verified subscription (push/delivery.js). The subscription itself is
// stored already: a failure here is logged, the periodic sync of the push service repairs it
async function pushChanged(scope) {
    if (scope.push) {
        await scope.push.changed(scope.user).catch(err => log.error('JMAP', 'push user update failed user=%s error=%s', scope.user, err.message));
    }
}

/** Checks a verification code; answers the fields to store. types: the subscribed types after the update */
async function verifyCode(scope, doc, code, types) {
    const given = Buffer.from(typeof code === 'string' ? code : '');
    const expected = Buffer.from(doc.verificationCode);
    const matches = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (doc.verified) {
        if (!matches) {
            throw invalidProperties('verificationCode', 'the subscription is verified already');
        }
        return {};
    }
    if (!matches) {
        const failed = await scope.subscriptions.findOneAndUpdate(
            { _id: doc._id, user: scope.user },
            { $inc: { verifyFailures: 1 } },
            { returnDocument: 'after' }
        );
        if (failed && failed.verifyFailures >= scope.settings.verifyAttempts) {
            // defence in depth: the code can not be guessed, but a client that keeps trying loses the subscription
            await scope.subscriptions.deleteOne({ _id: doc._id, user: scope.user });
        }
        throw invalidProperties('verificationCode', 'wrong verification code');
    }
    return { verified: true, pushed: await currentStates(scope.context, types) };
}

async function createSubscription(scope, object) {
    const { context, settings, user, credentials, subscriptions, push } = scope;
    if (!push) {
        throw new SetError('forbidden', 'Web Push is not available');
    }
    const values = checkCreate(object, context, settings);
    await checkTarget(values.url, settings);
    const duplicate = await subscriptions.countDocuments(
        { user, cred: credentials.cred, deviceClientId: values.deviceClientId },
        { limit: 1, maxTimeMS: store.MAX_TIME_MS }
    );
    if (duplicate) {
        throw invalidProperties('deviceClientId', 'these credentials have a subscription for this deviceClientId already');
    }
    await checkLimits(context, settings, user);
    const now = new Date();
    const verifyBy = new Date(now.getTime() + settings.verificationTimeout * 1000);
    const doc = {
        _id: new ObjectId(),
        user,
        ...credentials,
        deviceClientId: values.deviceClientId,
        url: object.url,
        keys: values.keys,
        types: values.types,
        expires: values.expires,
        verificationCode: crypto.randomBytes(24).toString('base64url'),
        verified: false,
        verifyFailures: 0,
        verifyBy,
        vapid: push.vapid.current ? push.vapid.current.id : null,
        created: now,
        purgeAt: verifyBy < values.expires ? verifyBy : values.expires
    };
    await subscriptions.insertOne(doc);
    await push.verificationCreated(doc._id);
    const created = { id: formatId('pushSubscription', doc._id), expires: formatUTCDate(doc.expires) };
    // the defaults of what the client left out
    for (const property of ['keys', 'types', 'verificationCode']) {
        if (object[property] === undefined) {
            created[property] = null;
        }
    }
    return created;
}

async function updateSubscription(scope, id, patch) {
    const doc = await ownedSubscription(scope, id);
    const current = Object.assign(toObject(doc, PROPERTIES), { url: doc.url, keys: doc.keys, verificationCode: null });
    const { object: patched, properties } = applyPatch(current, patch, { properties: PROPERTIES });
    const readOnly = [...properties].filter(property => !UPDATABLE.includes(property));
    if (readOnly.length) {
        throw invalidProperties(readOnly, 'only verificationCode, expires and types can be changed');
    }
    const $set = {};
    let result = null;
    if (properties.has('types')) {
        $set.types = checkTypes(patched.types, scope.context);
    }
    if (properties.has('expires')) {
        const { expires, changed } = checkExpires(patched.expires, scope.settings);
        $set.expires = expires;
        // a shortened expiry is reported back
        result = changed ? { expires: formatUTCDate(expires) } : null;
    }
    // null on an unverified subscription is its current value
    if (properties.has('verificationCode') && !(patched.verificationCode === null && !doc.verified)) {
        Object.assign($set, await verifyCode(scope, doc, patched.verificationCode, 'types' in $set ? $set.types : doc.types));
    }
    const expires = $set.expires || doc.expires;
    $set.purgeAt = $set.verified || doc.verified || doc.verifyBy > expires ? expires : doc.verifyBy;
    await scope.subscriptions.updateOne({ _id: doc._id, user: scope.user }, { $set });
    if ($set.verified && scope.push) {
        await pushChanged(scope);
    }
    return result;
}

async function destroySubscription(scope, id) {
    const doc = await ownedSubscription(scope, id);
    await scope.subscriptions.deleteOne({ _id: doc._id, user: scope.user });
    if (scope.push && doc.verified) {
        await pushChanged(scope);
    }
}

function setHandlers(context) {
    const scope = scopeOf(context);
    return {
        accountless: true,
        create: object => createSubscription(scope, object),
        update: (id, patch) => updateSubscription(scope, id, patch),
        destroy: id => destroySubscription(scope, id)
    };
}

const set = (args, context) => runSet(args, context, setHandlers(context));

module.exports = {
    capability: URN.core,
    methods: { 'PushSubscription/get': get, 'PushSubscription/set': set }
};
