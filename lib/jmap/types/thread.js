'use strict';

// Thread/get and Thread/changes (RFC 8621 3). A Thread lists the visible Emails of one WildDuck thread
// across all mailboxes, oldest first. Thread ids never change for a message.

const { ObjectId } = require('mongodb');
const { URN } = require('../capabilities');
const { parseId, formatId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments } = require('./common');
const { mailState, parseState, entriesSince, maxChangesOf, foldEntries, changeLists, formatState, createdAfter } = require('../state');
const { rootOf } = require('../../message-roots');
const consts = require('../../consts');

const PROPERTIES = ['id', 'emailIds'];

/** thread id (hex) -> Email ids (oldest first) of the visible messages of those threads */
async function threadEmails(context, threads) {
    const docs = await context.deps.database
        .collection('messages')
        .find(
            { user: context.account.user, thread: { $in: threads }, undeleted: true },
            { projection: { _id: true, root: true, thread: true, idate: true }, maxTimeMS: consts.DB_MAX_TIME_MESSAGES }
        )
        .toArray();
    docs.sort((a, b) => a.idate - b.idate || (a._id.toString() < b._id.toString() ? -1 : 1));
    const result = new Map();
    for (const doc of docs) {
        const key = doc.thread.toString();
        result.set(key, (result.get(key) || []).concat(formatId('email', rootOf(doc))));
    }
    return result;
}

async function get(args, context) {
    checkArguments(args, ['accountId', 'ids', 'properties']);
    requireAccount(args, context);
    if (!Array.isArray(args.ids) || !args.ids.every(id => typeof id === 'string')) {
        throw invalidArguments('ids is required and must be a list of Thread ids');
    }
    if (args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    if (
        args.properties !== undefined &&
        args.properties !== null &&
        (!Array.isArray(args.properties) || !args.properties.every(property => PROPERTIES.includes(property)))
    ) {
        throw invalidArguments('unknown property requested');
    }
    const properties = args.properties ? ['id', ...args.properties.filter(property => property !== 'id')] : PROPERTIES;
    const ids = [...new Set(args.ids)];
    const threads = ids.map(id => parseId('thread', id)).filter(Boolean);
    const emails = await threadEmails(context, threads);

    const list = [];
    const notFound = [];
    for (const id of ids) {
        const thread = parseId('thread', id);
        const emailIds = thread && emails.get(thread.toString());
        if (emailIds) {
            const entry = { id };
            if (properties.includes('emailIds')) {
                entry.emailIds = emailIds;
            }
            list.push(entry);
        } else {
            notFound.push(id);
        }
    }
    const { state } = await mailState(context);
    return { accountId: context.account.id, state, list, notFound };
}

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const since = parseState(context, args.sinceState);
    const maxChanges = maxChangesOf(args);
    const entries = await entriesSince(context, since, { thread: { $exists: true } });
    const {
        changes: touched,
        last,
        more
    } = await foldEntries(entries, { key: entry => entry.thread.toString(), fold: (map, entry) => map.set(entry.thread.toString(), true) }, maxChanges);

    // what the touched threads look like now decides between created, updated and destroyed
    const existing = await threadEmails(
        context,
        [...touched.keys()].map(id => new ObjectId(id))
    );
    const result = new Map();
    for (const id of touched.keys()) {
        // thread ids are ObjectIds created with the thread, so a thread newer than the state is new to the client
        const createdSince = createdAfter(id, since);
        if (!existing.has(id)) {
            if (!createdSince) {
                result.set(formatId('thread', id), 'destroyed');
            }
        } else {
            result.set(formatId('thread', id), createdSince ? 'created' : 'updated');
        }
    }
    const { state } = await mailState(context);
    return {
        accountId: context.account.id,
        oldState: args.sinceState,
        newState: more ? formatState(context, last || since) : state,
        hasMoreChanges: more,
        ...changeLists(result)
    };
}

module.exports = { capability: URN.mail, methods: { 'Thread/get': get, 'Thread/changes': changes } };
