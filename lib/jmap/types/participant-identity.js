'use strict';

// ParticipantIdentity/get, /changes and /set (draft-ietf-jmap-calendars-33 3).
//
// The identities are derived from the user's addresses (wildcards excepted), the way the draft allows
// for identities "configured out of band": one per address, calendarAddress the mailto: URI of the
// stored (normalised) address, name the address name or else the user name, the main address the
// default. They are kept in jmap.participants only so that their ids are stable and their changes are
// in the owned change log. reconcile() brings them in line with the addresses when a ParticipantIdentity
// method runs, and after REST API address and name changes (lib/jmap/identity-sync.js). Every create,
// update and destroy is forbidden; onSuccessSetIsDefault is ignored, the default follows the main address.

const { ObjectId } = require('mongodb');
const punycode = require('punycode/');
const consts = require('../../consts');
const { URN } = require('../capabilities');
const { formatId, parseId } = require('../ids');
const { invalidArguments } = require('../errors');
const { SetError } = require('../set-errors');
const { requireAccount, checkArguments } = require('./common');
const { changeLogFor } = require('../changelog');
const { runSet } = require('../set');
const { maxChangesOf } = require('../state');
const { getObjects } = require('./calendar');

const TYPE = 'ParticipantIdentity';
const COLLECTION = 'jmap.participants';
const PROPERTIES = ['id', 'name', 'calendarAddress', 'isDefault'];
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;

/**
 * The mailto: URI of an address (RFC 6068): the local part percent encoded as UTF-8 where it is not
 * plain ASCII, the domain in its ASCII form.
 */
function calendarAddressOf(address) {
    const at = address.lastIndexOf('@');
    const local = encodeURIComponent(address.slice(0, at)).replace(/%2B/g, '+');
    return `mailto:${local}@${punycode.toASCII(address.slice(at + 1)).toLowerCase()}`;
}

/** The identity each address of the user gives: address id -> {calendarAddress, name, isDefault} */
async function participantsOf(deps, user) {
    const [userData, addresses] = await Promise.all([
        deps.users.collection('users').findOne({ _id: user }, { projection: { name: true, address: true }, maxTimeMS: MAX_TIME_MS }),
        deps.users
            .collection('addresses')
            .find({ user }, { projection: { address: true, name: true }, maxTimeMS: MAX_TIME_MS })
            .sort({ _id: 1 })
            .toArray()
    ]);
    const userName = (userData && userData.name) || '';
    const wanted = new Map();
    for (const addressData of addresses) {
        // a wildcard is not an address anybody can be invited as
        if (typeof addressData.address === 'string' && addressData.address.includes('@') && !addressData.address.includes('*')) {
            wanted.set(addressData._id.toString(), {
                calendarAddress: calendarAddressOf(addressData.address),
                name: addressData.name || userName,
                isDefault: !!userData && addressData.address === userData.address
            });
        }
    }
    return wanted;
}

const differs = (doc, values) => Object.keys(values).some(key => doc[key] !== values[key]);

/**
 * Brings the stored identities of a user in line with the addresses; each difference is a change in
 * the change log.
 *
 * @param {Object} deps {database, users}
 * @param {ObjectId} user
 * @param {Object} log a change log or change writer (lib/jmap/changelog.js)
 * @returns {Promise<{docs: Object[], changed: Boolean}>} the identities, the default first, then in address order
 */
async function reconcile(deps, user, log) {
    const collection = deps.database.collection(COLLECTION);
    const [wanted, docs] = await Promise.all([participantsOf(deps, user), collection.find({ user }, { maxTimeMS: MAX_TIME_MS }).toArray()]);
    const byAddress = new Map(docs.map(doc => [doc.address.toString(), doc]));

    const gone = docs.filter(doc => !wanted.has(doc.address.toString()));
    if (gone.length) {
        const seq = await log.next(user, TYPE, gone.length);
        await collection.deleteMany({ user, _id: { $in: gone.map(doc => doc._id) } });
        await log.destroyed(
            user,
            TYPE,
            gone.map(doc => ({ id: doc._id, createdSeq: doc.createdSeq })),
            seq
        );
    }
    const missing = [...wanted.keys()].filter(address => !byAddress.has(address));
    const outdated = [...wanted.keys()].filter(address => byAddress.has(address) && differs(byAddress.get(address), wanted.get(address)));
    if (missing.length || outdated.length) {
        let seq = await log.next(user, TYPE, missing.length + outdated.length);
        // the old default loses the flag before the new one gets it, so two are never default at once
        outdated.sort((a, b) => Number(wanted.get(a).isDefault) - Number(wanted.get(b).isDefault));
        for (const address of outdated) {
            await collection.updateOne({ _id: byAddress.get(address)._id, user }, { $set: Object.assign({ modSeq: seq++ }, wanted.get(address)) });
        }
        if (missing.length) {
            const inserts = missing.map(address =>
                Object.assign({ _id: new ObjectId(), user, address: new ObjectId(address) }, wanted.get(address), { createdSeq: seq, modSeq: seq++ })
            );
            // a concurrent request may have created some first (unique on user and address)
            await collection.insertMany(inserts, { ordered: false }).catch(err => (err.code === 11000 ? null : Promise.reject(err)));
        }
    }
    const changed = !!(gone.length || missing.length || outdated.length);
    const live = changed ? await collection.find({ user }, { maxTimeMS: MAX_TIME_MS }).toArray() : docs;
    const order = [...wanted.keys()];
    live.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || order.indexOf(a.address.toString()) - order.indexOf(b.address.toString()));
    return { docs: live, changed };
}

function loadParticipants(context) {
    if (!context.cache.participants) {
        context.cache.participants = reconcile(context.deps, context.account.user, changeLogFor(context));
    }
    return context.cache.participants;
}

function toParticipant(doc, properties) {
    const values = { id: formatId('participantIdentity', doc._id), name: doc.name || '', calendarAddress: doc.calendarAddress, isDefault: !!doc.isDefault };
    return Object.fromEntries(properties.map(property => [property, values[property]]));
}

const state = context => changeLogFor(context).state(context.account.user, context.account.id, TYPE);

const get = (args, context) =>
    getObjects(args, context, {
        properties: PROPERTIES,
        load: async () => (await loadParticipants(context)).docs,
        toObject: toParticipant,
        idOf: doc => formatId('participantIdentity', doc._id),
        state: () => state(context)
    });

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const maxChanges = maxChangesOf(args);
    await loadParticipants(context);
    const result = await changeLogFor(context).changes({
        user: context.account.user,
        accountId: context.account.id,
        type: TYPE,
        collection: COLLECTION,
        sinceState: args.sinceState,
        maxChanges: Math.min(maxChanges, 1000),
        formatId: id => formatId('participantIdentity', id)
    });
    return Object.assign({ accountId: context.account.id }, result);
}

function setHandlers(args, context) {
    // an existing identity can not be changed (forbidden), an unknown one is notFound
    const refuse = async id => {
        const objectId = parseId('participantIdentity', id);
        const { docs } = await loadParticipants(context);
        if (!objectId || !docs.some(doc => doc._id.equals(objectId))) {
            throw new SetError('notFound');
        }
        throw new SetError('forbidden', 'participant identities follow the addresses of the account');
    };
    return {
        arguments: ['onSuccessSetIsDefault'],
        state: () => state(context),
        prepare: async () => {
            if (![undefined, null].includes(args.onSuccessSetIsDefault) && typeof args.onSuccessSetIsDefault !== 'string') {
                throw invalidArguments('onSuccessSetIsDefault must be an id');
            }
            await loadParticipants(context);
        },
        create: async () => {
            throw new SetError('forbidden', 'participant identities follow the addresses of the account');
        },
        update: refuse,
        destroy: refuse
    };
}

const set = (args, context) => runSet(args, context, setHandlers(args, context));

module.exports = {
    capability: URN.calendars,
    methods: { 'ParticipantIdentity/get': get, 'ParticipantIdentity/changes': changes, 'ParticipantIdentity/set': set },
    reconcile,
    calendarAddressOf
};
