'use strict';

// VacationResponse/get and VacationResponse/set (RFC 8621 8).
//
// The singleton is the user's document in the autoreplies collection, the one the REST API
// (lib/api/autoreply.js) edits and the delivery path (lib/filter-handler.js, lib/autoreply.js) reads.
// isEnabled is `status` (and the users.autoreply flag delivery checks first, kept in step exactly like
// the REST API does), fromDate and toDate are `start` and `end`, subject, textBody and htmlBody are
// `subject`, `text` and `html`. The REST API marks an unset value with an empty string or false; JMAP
// shows null for both. The REST only `name` is left as it is.
//
// VacationResponse has no /changes, but its state must move with every change, wherever it was made.
// The state is a sequence of the owned change log (seq.VacationResponse in jmapstate), together with a
// digest of the object it was taken for. A read whose object no longer matches the digest takes the
// next sequence number, and the REST routes call syncVacation() (lib/jmap/vacation-sync.js), so their
// changes move the state and are pushed at once.

const crypto = require('crypto');
const consts = require('../../consts');
const { URN } = require('../capabilities');
const { isValidId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { SetError, invalidProperties } = require('../set-errors');
const { requireAccount, checkArguments } = require('./common');
const { changeLogFor } = require('../changelog');
const { applyPatch } = require('../patch');
const { runSet } = require('../set');
const { publish, AUTOREPLY_USER_DISABLED, AUTOREPLY_USER_ENABLED } = require('../../events');

const TYPE = 'VacationResponse';
const ID = 'singleton';
const PROPERTIES = ['id', 'isEnabled', 'fromDate', 'toDate', 'subject', 'textBody', 'htmlBody'];
// the limits of the REST API, in characters
const MAX_LENGTH = { subject: 2 * 1024, textBody: 128 * 1024, htmlBody: 128 * 1024 };
// property -> field of the autoreply document
const TEXT_FIELDS = { subject: 'subject', textBody: 'text', htmlBody: 'html' };
const DATE_FIELDS = { fromDate: 'start', toDate: 'end' };
const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;

// ---------------------------------------------------------------- mapping

const asDate = value => {
    const date = value instanceof Date ? value : typeof value === 'string' && value ? new Date(value) : null;
    return date && !isNaN(date.getTime()) ? date : null;
};

/** A Date as UTCDate (RFC 8620 1.4): no fraction of a second when it is zero */
const utcDate = date => (date ? date.toISOString().replace('.000Z', 'Z') : null);

/** The VacationResponse of an autoreply document (null for none) */
function toVacation(doc) {
    const values = { id: ID, isEnabled: !!(doc && doc.status) };
    for (const [property, field] of Object.entries(DATE_FIELDS)) {
        values[property] = utcDate(asDate(doc && doc[field]));
    }
    for (const [property, field] of Object.entries(TEXT_FIELDS)) {
        values[property] = doc && typeof doc[field] === 'string' && doc[field] ? doc[field] : null;
    }
    return values;
}

/** The autoreply document fields of a VacationResponse, in the form the REST API stores */
function toAutoreply(vacation) {
    const values = { status: vacation.isEnabled };
    for (const [property, field] of Object.entries(DATE_FIELDS)) {
        values[field] = vacation[property] ? new Date(vacation[property]) : false;
    }
    for (const [property, field] of Object.entries(TEXT_FIELDS)) {
        values[field] = vacation[property] || '';
    }
    return values;
}

const digestOf = vacation =>
    crypto
        .createHash('sha256')
        .update(JSON.stringify(PROPERTIES.map(property => vacation[property])))
        .digest('base64')
        .slice(0, 22);

/**
 * Checks the properties a patch touched on the resulting object.
 *
 * @param {Object} vacation the patched object
 * @param {Set<String>} touched the properties the patch named
 * @param {Object} current the object before the patch
 * @throws {SetError} invalidProperties naming every offending property
 */
function checkVacation(vacation, touched, current) {
    const invalid = [];
    for (const property of touched) {
        const value = vacation[property];
        let valid;
        if (property === 'id') {
            valid = value === current.id;
        } else if (property === 'isEnabled') {
            valid = typeof value === 'boolean';
        } else if (DATE_FIELDS[property]) {
            valid = value === null || (typeof value === 'string' && UTC_DATE.test(value) && asDate(value) !== null);
        } else {
            valid = value === null || (typeof value === 'string' && [...value].length <= MAX_LENGTH[property]);
        }
        if (!valid) {
            invalid.push(property);
        }
    }
    if (invalid.length) {
        throw invalidProperties(invalid, `invalid values: ${invalid.join(', ')}`);
    }
    const dates = ['fromDate', 'toDate'].filter(property => touched.has(property));
    if (dates.length && vacation.fromDate && vacation.toDate && asDate(vacation.fromDate) > asDate(vacation.toDate)) {
        throw invalidProperties(dates, 'fromDate is later than toDate');
    }
}

// ---------------------------------------------------------------- state

const statePosition = doc => ({
    seq: (doc && doc.seq && doc.seq[TYPE]) || 0,
    time: (doc && doc.seqTime && doc.seqTime[TYPE] && doc.seqTime[TYPE].getTime()) || 0
});

/**
 * Moves the VacationResponse state when the object differs from the one of the current state.
 *
 * @param {Db} database
 * @param {ObjectId} user
 * @param {Object} vacation the current VacationResponse
 * @returns {Promise<{seq: Number, time: Number, changed: Boolean}>} the state position
 */
async function reconcile(database, user, vacation) {
    const states = database.collection('jmapstate');
    const projection = { vacationDigest: true, [`seq.${TYPE}`]: true, [`seqTime.${TYPE}`]: true };
    const digest = digestOf(vacation);
    const stateDoc = await states.findOne({ _id: user }, { projection, maxTimeMS: MAX_TIME_MS });
    if (stateDoc && stateDoc.vacationDigest === digest) {
        return Object.assign(statePosition(stateDoc), { changed: false });
    }
    let result;
    try {
        // conditional on the digest read, so concurrent readers of one change take one number
        result = await states.findOneAndUpdate(
            { _id: user, vacationDigest: (stateDoc && stateDoc.vacationDigest) || null },
            { $set: { vacationDigest: digest, [`seqTime.${TYPE}`]: new Date() }, $inc: { [`seq.${TYPE}`]: 1 } },
            { upsert: true, returnDocument: 'after', projection, maxTimeMS: MAX_TIME_MS }
        );
    } catch (err) {
        if (err.code !== 11000) {
            throw err;
        }
        // another writer moved the state first
        return Object.assign(statePosition(await states.findOne({ _id: user }, { projection, maxTimeMS: MAX_TIME_MS })), { changed: true });
    }
    const doc = result && result.value !== undefined ? result.value : result;
    return Object.assign(statePosition(doc), { changed: true });
}

/** The VacationResponse of the account and its state position, once per request */
function loadVacation(context) {
    if (!context.cache.vacation) {
        context.cache.vacation = (async () => {
            const user = context.account.user;
            const doc = await context.deps.database.collection('autoreplies').findOne({ user }, { maxTimeMS: MAX_TIME_MS });
            const vacation = toVacation(doc);
            return { vacation, position: await reconcile(context.deps.database, user, vacation) };
        })();
    }
    return context.cache.vacation;
}

const state = async context => changeLogFor(context).formatState(context.account.id, TYPE, (await loadVacation(context)).position);

// ---------------------------------------------------------------- get

async function get(args, context) {
    checkArguments(args, ['accountId', 'ids', 'properties']);
    requireAccount(args, context);
    const properties = args.properties === undefined || args.properties === null ? PROPERTIES : args.properties;
    if (!Array.isArray(properties) || properties.some(property => !PROPERTIES.includes(property))) {
        throw invalidArguments('unknown property');
    }
    let ids = [ID];
    if (args.ids !== undefined && args.ids !== null) {
        if (!Array.isArray(args.ids) || !args.ids.every(isValidId)) {
            throw invalidArguments('ids must be a list of ids');
        }
        if (args.ids.length > context.limits.maxObjectsInGet) {
            throw new MethodError('requestTooLarge');
        }
        ids = [...new Set(args.ids)];
    }
    const { vacation } = await loadVacation(context);
    const list = ['id', ...properties.filter(property => property !== 'id')];
    return {
        accountId: context.account.id,
        state: await state(context),
        list: ids.includes(ID) ? [Object.fromEntries(list.map(property => [property, vacation[property]]))] : [],
        notFound: ids.filter(id => id !== ID)
    };
}

// ---------------------------------------------------------------- set

/** Stores a VacationResponse the way PUT /users/:user/autoreply does; answers the stored document */
async function store(context, vacation) {
    const { deps } = context;
    const user = context.account.user;
    const values = toAutoreply(vacation);
    // delivery reads the autoreply only when the user's flag is set
    const flag = await deps.users.collection('users').updateOne({ _id: user }, { $set: { autoreply: values.status } }, { maxTimeMS: MAX_TIME_MS });
    if (flag.modifiedCount) {
        await publish(deps.redis, { ev: values.status ? AUTOREPLY_USER_ENABLED : AUTOREPLY_USER_DISABLED, user });
    }
    const created = new Date();
    created.setMilliseconds(0);
    values.created = created.toISOString();
    const result = await deps.database
        .collection('autoreplies')
        .findOneAndUpdate({ user }, { $set: values }, { upsert: true, returnDocument: 'after', maxTimeMS: MAX_TIME_MS });
    return result && result.value !== undefined ? result.value : result;
}

function setHandlers(context) {
    return {
        state: () => state(context),
        prepare: () => loadVacation(context),

        async create() {
            throw new SetError('singleton', 'the VacationResponse can not be created');
        },

        async update(id, patch) {
            if (id !== ID) {
                throw new SetError('notFound');
            }
            const { vacation: current } = await loadVacation(context);
            const { object: patched, properties } = applyPatch(current, patch, { properties: PROPERTIES });
            checkVacation(patched, properties, current);
            if (PROPERTIES.every(property => patched[property] === current[property])) {
                return null;
            }
            const vacation = toVacation(await store(context, patched));
            const position = await reconcile(context.deps.database, context.account.user, vacation);
            context.cache.vacation = Promise.resolve({ vacation, position });
            // values the server stored differently from what was sent (an empty string is null)
            const differs = PROPERTIES.filter(property => properties.has(property) && vacation[property] !== patched[property]);
            return differs.length ? Object.fromEntries(differs.map(property => [property, vacation[property]])) : null;
        },

        async destroy(id) {
            if (id !== ID) {
                throw new SetError('notFound');
            }
            throw new SetError('singleton', 'the VacationResponse can not be destroyed');
        }
    };
}

const set = (args, context) => runSet(args, context, setHandlers(context));

// one lookup of the user's jmapstate document; changes made elsewhere reconcile and notify
const pushStates = async context => ({ [TYPE]: await changeLogFor(context).state(context.account.user, context.account.id, TYPE) });

module.exports = {
    capability: URN.vacationresponse,
    methods: { 'VacationResponse/get': get, 'VacationResponse/set': set },
    pushTypes: [TYPE],
    pushStates,
    reconcile,
    toVacation,
    toAutoreply,
    checkVacation,
    utcDate
};
