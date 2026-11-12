'use strict';

// EmailSubmission/get, changes, query, queryChanges and set (RFC 8621 7), under the submission
// capability. A create checks the Email against the identity, derives or checks the envelope and
// hands a copy of the message to the outbound queue through Maildropper, like the REST submit
// endpoint (recipient limits on the shared wdr: counter, Bcc removed from the queued copy, the queue
// id added to the message's outbound list). The stored Email is not changed; clients file it with
// onSuccessUpdateEmail or onSuccessDestroyEmail, answered as an implicit Email/set (RFC 8621 7.5).
//
// Records live in jmapsubmissions with the owned change log (lib/jmap/changelog.js). undoStatus
// follows the queue (lib/jmap/submission-queue.js); destroying a record never touches the queue.

const { isDeepStrictEqual } = require('util');
const { ObjectId } = require('mongodb');
const config = require('@zone-eu/wild-config');
const consts = require('../../consts');
const { URN } = require('../capabilities');
const { formatId, parseId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { SetError, invalidProperties } = require('../set-errors');
const { requireAccount, checkArguments, isObject } = require('./common');
const { changeLogFor, ownedPushStates } = require('../changelog');
const { applyPatch } = require('../patch');
const { runSet, resolveId } = require('../set');
const { maxChangesOf } = require('../state');
const { pagingArguments, sortArgument, windowOf } = require('../query');
const { parseUTCDate, formatUTCDate } = require('../utcdate');
const { rootOf } = require('../../message-roots');
const outbound = require('../../outbound');
const { openPart, readPrefix } = require('../email-body');
const envelopes = require('../submission-envelope');
const queue = require('../submission-queue');
const identity = require('./identity');
const emailSet = require('./email-set');

const { TYPE, COLLECTION, toSecond } = queue;
const PROPERTIES = ['id', 'identityId', 'emailId', 'threadId', 'envelope', 'sendAt', 'undoStatus', 'deliveryStatus', 'dsnBlobIds', 'mdnBlobIds'];
const MAX_TIME_MS = consts.DB_MAX_TIME_USERS;
// most ids one EmailSubmission/query reads
const MAX_QUERY = 10000;
const MAX_FILTER_DEPTH = 10;
const MAX_FILTER_CONDITIONS = 100;
// a week of submission history, see [jmap.submission] in config/jmap.toml
const DEFAULT_RETENTION = 7 * 24 * 3600;
// seconds between two polls of the queue for due pending submissions
const DEFAULT_POLL_INTERVAL = 15;
// how long a record may outlive its release before the TTL index removes it unconditionally: the queue
// keeps a message at most maxQueueTime, the lazy cleanup gets the retention, the change log 30 days more
const PURGE_MARGIN = 31 * 24 * 3600 * 1000;
// the armor comment of messages WildDuck encrypted for the account (lib/message-handler.js), which
// older versions did not mark on the message document
const ARMOR_COMMENT = 'Comment: Plaintext message encrypted by WildDuck Mail Server';
const SORTS = { emailId: 'emailId', threadId: 'threadId', sentAt: 'sendAt', sendAt: 'sendAt' };
const FILTER_LISTS = ['identityIds', 'emailIds', 'threadIds'];
const FILTER_PROPERTIES = [...FILTER_LISTS, 'undoStatus', 'before', 'after'];

const collection = context => context.deps.database.collection(COLLECTION);

// RFC 8621 7: what WildDuck can say about a recipient. The MTA reports nothing back, so a message is
// queued until it leaves the queue, and unknown afterwards
const DELIVERY = {
    pending: { smtpReply: '250 2.0.0 Queued for delivery', delivered: 'queued', displayed: 'unknown' },
    final: { smtpReply: '250 2.0.0 Handed over to the outbound queue', delivered: 'unknown', displayed: 'unknown' },
    canceled: { smtpReply: '250 2.0.0 Canceled before delivery', delivered: 'unknown', displayed: 'unknown' }
};

/** The submission settings of the service: [jmap.submission] over the sender configuration */
function settingsOf(options) {
    const configured = (options && options.submission) || {};
    const maxQueueTime = Number(config.sender && config.sender.maxQueueTime) || consts.MAX_QUEUE_TIME;
    const maxDelayedSend =
        Number.isSafeInteger(configured.maxDelayedSend) && configured.maxDelayedSend >= 0 ? configured.maxDelayedSend : Math.floor(maxQueueTime / 1000);
    return {
        maxDelayedSend,
        retention: Number(configured.retention) > 0 ? Number(configured.retention) : DEFAULT_RETENTION,
        maxSize: Number(configured.maxSize) || Number(options && options.limits && options.limits.maxSizeMessage) || consts.MAX_ALLOWED_MESSAGE_SIZE,
        maxQueueTime,
        pollInterval: configured.pollInterval === undefined ? DEFAULT_POLL_INTERVAL : Number(configured.pollInterval) || 0
    };
}

/** RFC 8621 1.3.2: the submission account capability */
function accountCapability(context) {
    const { maxDelayedSend } = settingsOf(context.options);
    return { maxDelayedSend, submissionExtensions: maxDelayedSend ? { FUTURERELEASE: [String(maxDelayedSend)] } : {} };
}

const state = context => changeLogFor(context).state(context.account.user, context.account.id, TYPE);

/**
 * Once per request before submissions are read: pending submissions follow the queue and records past
 * the retention are removed.
 */
function ready(context) {
    if (!context.cache.submissions) {
        const user = context.account.user;
        context.cache.submissions = queue
            .refreshUser(context.deps, user)
            .then(() => queue.cleanupUser(context.deps, user, settingsOf(context.options).retention));
    }
    return context.cache.submissions;
}

function toSubmission(doc, properties) {
    const delivery = DELIVERY[doc.undoStatus];
    const values = {
        id: formatId('submission', doc._id),
        identityId: doc.identityId,
        emailId: doc.emailId,
        threadId: doc.threadId,
        envelope: doc.envelope,
        sendAt: formatUTCDate(doc.sendAt, { seconds: true }),
        undoStatus: doc.undoStatus,
        deliveryStatus: Object.fromEntries(doc.envelope.rcptTo.map(address => [address.email, Object.assign({}, delivery)])),
        dsnBlobIds: [],
        mdnBlobIds: []
    };
    return Object.fromEntries(properties.map(property => [property, values[property]]));
}

// ---------------------------------------------------------------- get and changes

async function get(args, context) {
    checkArguments(args, ['accountId', 'ids', 'properties']);
    requireAccount(args, context);
    const properties = args.properties === undefined || args.properties === null ? PROPERTIES : args.properties;
    if (!Array.isArray(properties) || properties.some(property => !PROPERTIES.includes(property))) {
        throw invalidArguments('unknown property');
    }
    const list = ['id', ...new Set(properties.filter(property => property !== 'id'))];
    if (args.ids !== undefined && args.ids !== null && !(Array.isArray(args.ids) && args.ids.every(id => typeof id === 'string'))) {
        throw invalidArguments('ids must be a list of ids');
    }
    if (args.ids && args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    await ready(context);
    const user = context.account.user;
    const result = { accountId: context.account.id, state: await state(context), list: [], notFound: [] };
    if (args.ids === undefined || args.ids === null) {
        const docs = await collection(context).find({ user }, { maxTimeMS: MAX_TIME_MS }).sort({ _id: 1 }).limit(context.limits.maxObjectsInGet).toArray();
        result.list = docs.map(doc => toSubmission(doc, list));
        return result;
    }
    const wanted = args.ids.map(reference => ({ reference, objectId: parseId('submission', resolveId(context, reference)) }));
    const objectIds = wanted.filter(entry => entry.objectId).map(entry => entry.objectId);
    const docs = objectIds.length
        ? await collection(context)
              .find({ _id: { $in: objectIds }, user }, { maxTimeMS: MAX_TIME_MS })
              .toArray()
        : [];
    const byId = new Map(docs.map(doc => [doc._id.toString(), doc]));
    for (const { reference, objectId } of wanted) {
        const doc = objectId && byId.get(objectId.toString());
        if (doc) {
            result.list.push(toSubmission(doc, list));
        } else {
            result.notFound.push(reference);
        }
    }
    return result;
}

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const maxChanges = maxChangesOf(args);
    await ready(context);
    const result = await changeLogFor(context).changes({
        user: context.account.user,
        accountId: context.account.id,
        type: TYPE,
        collection: COLLECTION,
        sinceState: args.sinceState,
        maxChanges: Math.min(maxChanges, context.limits.maxObjectsInGet),
        formatId: id => formatId('submission', id)
    });
    return Object.assign({ accountId: context.account.id }, result);
}

// ---------------------------------------------------------------- query

/** FilterCondition (RFC 8621 7.3) to a MongoDB condition */
function conditionQuery(condition) {
    const unknown = Object.keys(condition).filter(key => !FILTER_PROPERTIES.includes(key));
    if (unknown.length) {
        throw invalidArguments(`unknown filter property ${unknown[0]}`);
    }
    const query = {};
    for (const property of FILTER_LISTS) {
        const value = condition[property];
        if (value === undefined || value === null) {
            continue;
        }
        if (!Array.isArray(value) || !value.every(id => typeof id === 'string') || value.length > MAX_QUERY) {
            throw invalidArguments(`${property} must be a list of ids`);
        }
        // the record field is the singular of the filter property
        query[property.slice(0, -1)] = { $in: value };
    }
    if (condition.undoStatus !== undefined && condition.undoStatus !== null) {
        if (typeof condition.undoStatus !== 'string') {
            throw invalidArguments('undoStatus must be a string');
        }
        // a value outside the three states matches nothing
        query.undoStatus = condition.undoStatus;
    }
    for (const [property, operator] of [
        ['before', '$lt'],
        ['after', '$gte']
    ]) {
        if (condition[property] === undefined || condition[property] === null) {
            continue;
        }
        const date = parseUTCDate(condition[property]);
        if (!date) {
            throw invalidArguments(`${property} must be a UTCDate`);
        }
        query.sendAt = Object.assign(query.sendAt || {}, { [operator]: date });
    }
    return query;
}

const NOTHING = { _id: { $exists: false } };

/** A Filter (FilterOperator or FilterCondition) to a MongoDB query */
function filterQuery(filter, counter = { conditions: 0 }, depth = 0) {
    if (filter === undefined || filter === null) {
        return {};
    }
    if (!isObject(filter) || depth > MAX_FILTER_DEPTH || ++counter.conditions > MAX_FILTER_CONDITIONS) {
        throw invalidArguments('filter must be a FilterOperator or FilterCondition');
    }
    if (!('operator' in filter)) {
        return conditionQuery(filter);
    }
    if (Object.keys(filter).some(key => key !== 'operator' && key !== 'conditions') || !Array.isArray(filter.conditions)) {
        throw invalidArguments('a FilterOperator has operator and conditions');
    }
    const parts = filter.conditions.map(entry => filterQuery(entry, counter, depth + 1));
    switch (filter.operator) {
        case 'AND':
            return parts.length ? { $and: parts } : {};
        case 'OR':
            return parts.length ? { $or: parts } : NOTHING;
        case 'NOT':
            return parts.length ? { $nor: parts } : {};
        default:
            throw invalidArguments('operator must be AND, OR or NOT');
    }
}

/** Comparators (RFC 8621 7.3) to a MongoDB sort; the record id breaks ties */
function sortOf(sort) {
    if (sort === undefined || sort === null) {
        return { _id: 1 };
    }
    if (!Array.isArray(sort) || sort.length > 10) {
        throw invalidArguments('sort must be a list of Comparators');
    }
    const result = {};
    for (const comparator of sort) {
        if (!isObject(comparator) || typeof comparator.property !== 'string') {
            throw invalidArguments('a Comparator needs a property');
        }
        if (comparator.isAscending !== undefined && typeof comparator.isAscending !== 'boolean') {
            throw invalidArguments('isAscending must be a boolean');
        }
        if (comparator.collation !== undefined && typeof comparator.collation !== 'string') {
            throw invalidArguments('collation must be a string');
        }
        const field = Object.hasOwn(SORTS, comparator.property) && SORTS[comparator.property];
        if (!field) {
            throw new MethodError('unsupportedSort', { description: `can not sort by ${comparator.property}` });
        }
        if (!(field in result)) {
            result[field] = comparator.isAscending === false ? -1 : 1;
        }
    }
    result._id = 1;
    return result;
}

async function query(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'position', 'anchor', 'anchorOffset', 'limit', 'calculateTotal']);
    requireAccount(args, context);
    const filter = filterQuery(args.filter);
    const sort = sortOf(sortArgument(args.sort));
    const paging = pagingArguments(args, MAX_QUERY);
    await ready(context);
    const docs = await collection(context)
        .find({ $and: [{ user: context.account.user }, filter] }, { projection: { _id: true }, maxTimeMS: MAX_TIME_MS })
        .sort(sort)
        .limit(MAX_QUERY)
        .toArray();
    const ids = docs.map(doc => formatId('submission', doc._id));
    const window = windowOf(ids, paging);
    const result = { accountId: context.account.id, queryState: await state(context), canCalculateChanges: false, position: window.position, ids: window.ids };
    if (paging.calculateTotal) {
        result.total = ids.length;
    }
    if (paging.limitClamped) {
        result.limit = paging.limit;
    }
    return result;
}

/** Query results are not kept, so a valid call answers cannotCalculateChanges (RFC 8620 5.6) */
async function queryChanges(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'sinceQueryState', 'maxChanges', 'upToId', 'calculateTotal']);
    requireAccount(args, context);
    if (typeof args.sinceQueryState !== 'string') {
        throw invalidArguments('sinceQueryState must be a string');
    }
    filterQuery(args.filter);
    sortOf(sortArgument(args.sort));
    maxChangesOf(args);
    throw new MethodError('cannotCalculateChanges');
}

// ---------------------------------------------------------------- create

/** Properties a create may not set: unknown ones, and server set ones with another value than they get */
function checkCreateProperties(object) {
    const bad = [];
    for (const [property, value] of Object.entries(object)) {
        if (['identityId', 'emailId', 'envelope', 'threadId'].includes(property)) {
            continue;
        }
        const harmless =
            (property === 'undoStatus' && value === 'pending') ||
            (property === 'deliveryStatus' && value === null) ||
            (['dsnBlobIds', 'mdnBlobIds'].includes(property) && Array.isArray(value) && !value.length);
        if (!harmless) {
            bad.push(property);
        }
    }
    for (const property of ['identityId', 'emailId']) {
        if (typeof object[property] !== 'string') {
            bad.push(property);
        }
    }
    if (bad.length) {
        throw invalidProperties(bad, 'unknown, server set or missing properties');
    }
}

async function resolveIdentity(context, reference) {
    const id = resolveId(context, reference);
    const objectId = parseId('identity', id);
    const { docs, rights, userData } = await identity.loadIdentities(context);
    const doc = objectId && docs.find(entry => entry._id.equals(objectId));
    if (!doc) {
        throw invalidProperties('identityId', 'no such identity');
    }
    return { id, doc, rights, userData };
}

const EMAIL_PROJECTION = { _id: true, root: true, mailbox: true, uid: true, thread: true, size: true, mimeTree: true, encryptedAtRest: true };

async function resolveEmail(context, reference) {
    const id = resolveId(context, reference);
    const root = parseId('email', id);
    const doc = root && (await emailSet.loadEmails(context, [root], EMAIL_PROJECTION)).get(root.toString());
    if (!doc) {
        throw invalidProperties('emailId', 'no such Email');
    }
    return { id: formatId('email', rootOf(doc)), doc, threadId: formatId('thread', doc.thread) };
}

/**
 * The account as this request read it with the sending rights: a sending block set after the credentials
 * were cached applies at once.
 */
function senderOf(identityRef) {
    const userData = identityRef.userData;
    if (!userData || userData.disabled || userData.suspended) {
        throw new SetError('forbiddenToSend', 'This account is disabled');
    }
    if ((userData.disabledScopes || []).includes('smtp')) {
        throw new SetError('forbiddenToSend', 'This account may not send mail');
    }
    return userData;
}

/** An address the user may send from, covered by the identity */
const coveredBy = (identityDoc, address) => !!address && identity.covers(identityDoc.email, address);

/** identity.maySendFrom() for one create, each address resolved once */
function senderCheck(context, rights) {
    const resolved = new Map();
    return email => {
        if (!resolved.has(email)) {
            resolved.set(email, identity.maySendFrom(context, email, rights));
        }
        return resolved.get(email);
    };
}

/**
 * True when WildDuck encrypted the stored copy for the account (MessageHandler marks it). Older versions
 * left no mark; their PGP/MIME messages carry WildDuck's armor comment at the start of the encrypted part.
 * A client composed encrypted message has neither and is sent as it is.
 */
async function storedEncrypted(messageHandler, doc) {
    if (doc.encryptedAtRest) {
        return true;
    }
    const contentType = (doc.mimeTree && doc.mimeTree.parsedHeader && doc.mimeTree.parsedHeader['content-type']) || {};
    if (String(contentType.value || '').toLowerCase() !== 'multipart/encrypted') {
        return false;
    }
    const opened = await openPart(messageHandler, doc.mimeTree, '2');
    if (!opened) {
        return false;
    }
    // the comment follows the armor header line
    const { content } = await readPrefix(opened.stream, 512);
    return content.toString('latin1').includes(ARMOR_COMMENT);
}

/**
 * RFC 8621 7.5: the From address must belong to the identity and a Sender to the user. Answers the
 * envelope sender derived from the header: the Sender when the identity covers it, else the identity's
 * address (the From address for a *@domain identity).
 */
async function checkHeaderSenders(identityRef, headers, maySendFrom) {
    const { doc } = identityRef;
    const fromOwned = await maySendFrom(headers.from);
    const senderOwned = headers.sender && (await maySendFrom(headers.sender));
    const bad = [];
    if (!fromOwned || !(coveredBy(doc, headers.from) || coveredBy(doc, fromOwned))) {
        bad.push('from');
    }
    if (headers.sender && !senderOwned) {
        bad.push('sender');
    }
    if (bad.length) {
        throw new SetError('forbiddenFrom', 'the identity may not send this message', { properties: bad });
    }
    if (headers.sender && (coveredBy(doc, headers.sender) || coveredBy(doc, senderOwned))) {
        return headers.sender;
    }
    return doc.email.startsWith('*@') ? headers.from : doc.email;
}

/** The envelope recipients: the given rcptTo, or To, Cc and Bcc of the message, each address once */
function recipientsOf(given, headers) {
    let recipients;
    let invalid;
    if (given) {
        const checked = given.rcptTo.map(address => ({ email: address.email, valid: envelopes.validAddress(address.email) }));
        recipients = checked.filter(entry => entry.valid).map(entry => entry.valid);
        invalid = checked.filter(entry => !entry.valid).map(entry => entry.email);
    } else {
        recipients = headers.recipients;
        invalid = headers.invalidRecipients;
    }
    if (invalid.length) {
        throw new SetError('invalidRecipients', 'some recipient addresses are not valid', { invalidRecipients: [...new Set(invalid)] });
    }
    const unique = envelopes.uniqueRecipients(recipients);
    if (!unique.length) {
        throw new SetError('noRecipients', 'the message has no recipients');
    }
    return unique;
}

/**
 * Validates a create and works out what to queue.
 *
 * @returns {Promise<Object>} {identityId, email, envelope, mailFrom, recipients, sendAt, userData, settings}
 */
async function planSubmission(context, object, now) {
    checkCreateProperties(object);
    const settings = settingsOf(context.options);
    // both references are checked, so a create that names neither gets one error listing both
    const [identityRef, email] = await Promise.all([
        resolveIdentity(context, object.identityId).catch(err => err),
        resolveEmail(context, object.emailId).catch(err => err)
    ]);
    const failed = [identityRef, email].filter(result => result instanceof Error);
    if (failed.some(err => !(err instanceof SetError))) {
        throw failed.find(err => !(err instanceof SetError));
    }
    if (failed.length) {
        throw invalidProperties(
            failed.flatMap(err => err.extra.properties),
            'no such identity or Email'
        );
    }
    if (object.threadId !== undefined && object.threadId !== email.threadId) {
        throw invalidProperties('threadId', 'threadId is set by the server');
    }
    if (await storedEncrypted(context.deps.messageHandler, email.doc)) {
        throw new SetError('invalidEmail', 'the message is stored encrypted for this account and can not be sent', { properties: ['emailId'] });
    }
    const given = object.envelope === undefined || object.envelope === null ? null : envelopes.checkEnvelope(object.envelope);
    if (given && given.mailFrom.email !== '' && !envelopes.validAddress(given.mailFrom.email)) {
        throw invalidProperties('envelope', 'mailFrom is not a valid address');
    }
    const sendAt = toSecond(envelopes.releaseTime(given && given.mailFrom.parameters, { now, maxDelayedSend: settings.maxDelayedSend }));

    const userData = senderOf(identityRef);
    const headers = envelopes.messageAddresses(envelopes.headerFields(email.doc.mimeTree));
    const maySendFrom = senderCheck(context, identityRef.rights);
    const derivedFrom = await checkHeaderSenders(identityRef, headers, maySendFrom);
    const mailFromEmail = given ? given.mailFrom.email : derivedFrom;
    if (!mailFromEmail || !(await maySendFrom(mailFromEmail))) {
        throw new SetError('forbiddenMailFrom', 'the account may not use this envelope sender');
    }
    const recipients = recipientsOf(given, headers);
    // a given envelope is kept as the client wrote it (checkEnvelope allowed only email and parameters)
    const envelope = given
        ? object.envelope
        : {
              mailFrom: { email: mailFromEmail, parameters: null },
              rcptTo: recipients.map(recipient => ({ email: recipient.email, parameters: null }))
          };
    return {
        identityId: identityRef.id,
        email,
        envelope,
        mailFrom: envelopes.validAddress(mailFromEmail).address,
        recipients,
        sendAt,
        userData,
        settings
    };
}

const outboundDeps = context => ({
    settingsHandler: context.deps.settingsHandler,
    messageHandler: context.deps.messageHandler,
    counters: context.deps.messageHandler.counters,
    maildropper: context.deps.maildropper
});

/** The size limit, and the per message and daily recipient limits shared with the REST API, before anything is queued */
async function checkLimits(context, plan) {
    if (plan.email.doc.size > plan.settings.maxSize) {
        throw new SetError('tooLarge', `the message is larger than ${plan.settings.maxSize} octets`, { maxSize: plan.settings.maxSize });
    }
    try {
        return (await outbound.checkRecipientLimits(outboundDeps(context), plan.userData, plan.recipients.length)).maxRecipients;
    } catch (err) {
        switch (err.code) {
            case 'TooMany':
                throw new SetError('tooManyRecipients', `a message can have at most ${err.maxRcptTo} recipients`, { maxRecipients: err.maxRcptTo });
            case 'RateLimitedError':
                throw new SetError('rateLimit', 'the daily recipient limit of the account is reached');
            default:
                throw err;
        }
    }
}

/**
 * Hands the message to the outbound queue, stores the submission record and counts the recipients. A
 * failure takes the message out of the queue again and leaves no record.
 *
 * @returns {Promise<Object>} the stored record
 */
async function enqueue(context, plan, maxRecipients, now) {
    let doc = null;
    try {
        await outbound.queueStoredMessage(
            outboundDeps(context),
            plan.email.doc,
            {
                user: context.account.user,
                userEmail: plan.userData.address,
                parentId: plan.email.doc._id,
                reason: 'submit',
                from: plan.mailFrom,
                to: plan.recipients.map(recipient => recipient.address),
                sendTime: plan.sendAt,
                origin: context.ip,
                passwordType: context.account.userData.authAsp ? 'asp' : 'master',
                runPlugins: true,
                mtaRelay: plan.userData.mtaRelay || false
            },
            maxRecipients,
            async queueId => {
                doc = await storeRecord(context, plan, queueId, now);
            }
        );
        return doc;
    } catch (err) {
        if (doc) {
            // queued and recorded, but the recipients could not be counted: the message was taken back
            await collection(context)
                .deleteOne({ _id: doc._id, user: context.account.user })
                .catch(() => false);
        }
        if (err instanceof SetError) {
            throw err;
        }
        if (err.code === 'MessageNotFound') {
            throw new SetError('serverFail', 'the message can not be read');
        }
        throw new SetError('serverFail', err.code === 'MessageRejected' ? err.message : 'the message could not be queued');
    }
}

/** Stores the submission record of a queued message */
async function storeRecord(context, plan, queueId, now) {
    const log = changeLogFor(context);
    const user = context.account.user;
    const doc = {
        _id: new ObjectId(),
        user,
        identityId: plan.identityId,
        emailId: plan.email.id,
        threadId: plan.email.threadId,
        envelope: plan.envelope,
        sendAt: plan.sendAt,
        undoStatus: 'pending',
        queueId,
        deliveries: plan.recipients.length,
        created: now,
        // the poller looks at it from its release on
        checkAt: plan.sendAt,
        purgeAt: new Date(plan.sendAt.getTime() + plan.settings.maxQueueTime + plan.settings.retention * 1000 + PURGE_MARGIN)
    };
    try {
        const seq = await log.next(user, TYPE);
        Object.assign(doc, { createdSeq: seq, modSeq: seq });
        await collection(context).insertOne(doc);
    } catch {
        throw new SetError('serverFail', 'the submission could not be stored');
    }
    return doc;
}

async function createSubmission(context, object, records) {
    const now = new Date();
    const plan = await planSubmission(context, object, now);
    const maxRecipients = await checkLimits(context, plan);
    const doc = await enqueue(context, plan, maxRecipients, now);
    const queueId = doc.queueId;
    const { messageHandler, database } = context.deps;
    const user = context.account.user;
    // neither is needed for the delivery, a failure leaves the submission as it is
    await Promise.all([
        // the queue entry shows up in the REST API with the message, as for a REST submission
        database
            .collection('messages')
            .updateOne({ _id: plan.email.doc._id, mailbox: plan.email.doc.mailbox, uid: plan.email.doc.uid }, { $addToSet: { outbound: queueId } }),
        messageHandler.updateAddressRegister(
            user,
            plan.recipients.map(recipient => ({ address: recipient.address }))
        )
    ]).catch(() => false);
    records.set(formatId('submission', doc._id), doc.emailId);

    const created = toSubmission(doc, PROPERTIES);
    return Object.fromEntries(Object.entries(created).filter(([key]) => key === 'id' || !(key in object)));
}

// ---------------------------------------------------------------- update and destroy

async function ownedRecord(context, id) {
    const objectId = parseId('submission', id);
    const doc = objectId && (await collection(context).findOne({ _id: objectId, user: context.account.user }, { maxTimeMS: MAX_TIME_MS }));
    if (!doc) {
        throw new SetError('notFound', 'no such submission');
    }
    return doc;
}

/** RFC 8621 7.5: only undoStatus can change, and only to canceled */
async function updateSubmission(context, id, patch, records) {
    const doc = await ownedRecord(context, id);
    const current = toSubmission(doc, PROPERTIES);
    const { object: patched, properties } = applyPatch(current, patch, { properties: PROPERTIES });
    const changed = [...properties].filter(property => !isDeepStrictEqual(patched[property], current[property]));
    const readOnly = changed.filter(property => property !== 'undoStatus');
    if (readOnly.length) {
        throw invalidProperties(readOnly, 'these properties can not be changed');
    }
    if (properties.has('undoStatus') && patched.undoStatus !== 'canceled') {
        throw invalidProperties('undoStatus', 'undoStatus can only be set to canceled');
    }
    records.set(id, doc.emailId);
    if (!changed.length) {
        // canceling a canceled submission, or values repeated as they are
        return null;
    }
    if (current.undoStatus !== 'pending' || !(await queue.cancelDelivery(context.deps.maildropper, doc))) {
        if (current.undoStatus === 'pending') {
            // the MTA started on it, even if it was held for later (the REST API may have moved it)
            await queue.finalizeStarted(context.deps, [doc]);
        }
        throw new SetError('cannotUnsend', 'the message has already left the queue');
    }
    const seq = await changeLogFor(context).next(context.account.user, TYPE);
    await collection(context).updateOne({ _id: doc._id, user: context.account.user }, { $set: { undoStatus: 'canceled', modSeq: seq } });
    return null;
}

/** RFC 8621 7.5: the record goes, the delivery it stands for is not affected */
async function destroySubmission(context, id, records) {
    const doc = await ownedRecord(context, id);
    const log = changeLogFor(context);
    const seq = await log.next(context.account.user, TYPE);
    await collection(context).deleteOne({ _id: doc._id, user: context.account.user });
    await log.destroyed(context.account.user, TYPE, [{ id: doc._id, createdSeq: doc.createdSeq }], seq);
    records.set(id, doc.emailId);
}

// ---------------------------------------------------------------- set

/**
 * Checks onSuccessUpdateEmail and onSuccessDestroyEmail before anything is sent: every key must be a
 * creation reference of this call ("#c1") or an id the call updates or destroys.
 */
function checkOnSuccess(args) {
    const creations = new Set(Object.keys(isObject(args.create) ? args.create : {}));
    const touched = new Set([...Object.keys(isObject(args.update) ? args.update : {}), ...(Array.isArray(args.destroy) ? args.destroy : [])]);
    const known = key => typeof key === 'string' && (key.startsWith('#') ? creations.has(key.slice(1)) : touched.has(key));
    const update = args.onSuccessUpdateEmail;
    if (update !== undefined && update !== null) {
        if (!isObject(update) || !Object.entries(update).every(([key, patch]) => known(key) && isObject(patch))) {
            throw invalidArguments('onSuccessUpdateEmail must map submissions of this call to patches');
        }
    }
    const destroy = args.onSuccessDestroyEmail;
    if (destroy !== undefined && destroy !== null) {
        if (!Array.isArray(destroy) || !destroy.every(known)) {
            throw invalidArguments('onSuccessDestroyEmail must list submissions of this call');
        }
    }
}

/** The arguments of the implicit Email/set, or null when there is nothing to do */
function implicitEmailSet(args, response, records, accountId) {
    const created = Object.values(response.created || {}).map(object => object.id);
    const succeeded = new Set([...created, ...Object.keys(response.updated || {}), ...(response.destroyed || [])]);
    const emailOf = key => {
        const creationId = key.startsWith('#') ? key.slice(1) : null;
        const id = creationId ? response.created && Object.hasOwn(response.created, creationId) && response.created[creationId].id : key;
        return id && succeeded.has(id) ? records.get(id) : null;
    };
    const update = {};
    for (const [key, patch] of Object.entries(args.onSuccessUpdateEmail || {})) {
        const emailId = emailOf(key);
        if (emailId) {
            update[emailId] = patch;
        }
    }
    const destroy = [...new Set((args.onSuccessDestroyEmail || []).map(emailOf).filter(Boolean))];
    if (!Object.keys(update).length && !destroy.length) {
        return null;
    }
    return Object.assign({ accountId }, Object.keys(update).length ? { update } : {}, destroy.length ? { destroy } : {});
}

async function set(args, context) {
    checkOnSuccess(args);
    // submission id -> Email id of the submissions the call created, updated or destroyed
    const records = new Map();
    const response = await runSet(args, context, {
        arguments: ['onSuccessUpdateEmail', 'onSuccessDestroyEmail'],
        state: () => state(context),
        prepare: () => ready(context),
        create: object => createSubmission(context, object, records),
        update: (id, patch) => updateSubmission(context, id, patch, records),
        destroy: id => destroySubmission(context, id, records)
    });
    const emailArgs = implicitEmailSet(args, response, records, context.account.id);
    if (!emailArgs) {
        return response;
    }
    const emailSetMethod = emailSet.methods['Email/set'];
    try {
        return [
            ['EmailSubmission/set', response],
            ['Email/set', await emailSetMethod(emailArgs, context)]
        ];
    } catch (err) {
        if (err instanceof MethodError) {
            return [
                ['EmailSubmission/set', response],
                ['error', err.toResponse()]
            ];
        }
        throw err;
    }
}

const pushStates = context => ownedPushStates(context, [TYPE]);

module.exports = {
    capability: URN.submission,
    accountCapability,
    methods: {
        'EmailSubmission/get': get,
        'EmailSubmission/changes': changes,
        'EmailSubmission/query': query,
        'EmailSubmission/queryChanges': queryChanges,
        'EmailSubmission/set': set
    },
    pushTypes: ['EmailSubmission'],
    pushStates,
    settingsOf,
    // pure helpers, exported for the unit tests
    filterQuery,
    sortOf
};
