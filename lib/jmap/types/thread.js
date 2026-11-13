'use strict';

// Thread/get and Thread/changes (RFC 8621 3). A Thread lists the visible Emails of one WildDuck thread
// across all mailboxes, oldest first. Thread ids never change for a message.

const { ObjectId } = require('mongodb');
const { URN } = require('../capabilities');
const { parseId, formatId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments } = require('./common');
const { mailState, parseState, entriesSince, maxChangesOf, foldEntries, changeLists, formatState } = require('../state');
const { rootOf } = require('../../message-roots');
const consts = require('../../consts');
const { visibleQuery } = require('../visibility');
const responseBudget = require('../response-budget');

const PROPERTIES = ['id', 'emailIds'];
// messages one call reads for its threads at most. Real conversations stay far below (large mailing
// list threads reach some thousands); 100,000 projected documents take about 20 MB of heap, an
// unbounded thread of millions would take gigabytes. Changeable for tests.
const LIMITS = { maxThreadEmails: 100000 };

/**
 * thread id (hex) -> Email ids (oldest first) of the visible messages of those threads. The map has
 * `truncated` set when the threads hold more than LIMITS.maxThreadEmails messages; then it is incomplete.
 */
async function threadEmails(context, threads) {
    const docs = await context.deps.database
        .collection('messages')
        .find(Object.assign(await visibleQuery(context), { thread: { $in: threads } }), {
            projection: { _id: true, root: true, thread: true, idate: true },
            maxTimeMS: consts.DB_MAX_TIME_MESSAGES
        })
        .limit(LIMITS.maxThreadEmails + 1)
        .toArray();
    const truncated = docs.length > LIMITS.maxThreadEmails;
    // equal receivedAt values keep a stable order: by Email id, computed once per message
    docs.forEach(doc => (doc.emailId = formatId('email', rootOf(doc))));
    docs.sort((a, b) => a.idate - b.idate || (a.emailId < b.emailId ? -1 : a.emailId > b.emailId ? 1 : 0));
    const result = new Map();
    for (const doc of docs) {
        const key = doc.thread.toString();
        const list = result.get(key);
        if (list) {
            list.push(doc.emailId);
        } else {
            result.set(key, [doc.emailId]);
        }
    }
    result.truncated = truncated;
    return result;
}

/** Octets of the emailIds lists of the found threads: an Email id (all of one length) and its quotes and comma */
function emailIdBytes(emails) {
    let bytes = 0;
    for (const list of emails.values()) {
        bytes += list.length * (list[0].length + 3);
    }
    return bytes;
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
    const ids = args.ids;
    const threads = ids.map(id => parseId('thread', id)).filter(Boolean);
    const emails = await threadEmails(context, threads);
    if (emails.truncated) {
        throw new MethodError('requestTooLarge', { description: `the threads hold more than ${LIMITS.maxThreadEmails} Emails` });
    }
    if (properties.includes('emailIds')) {
        responseBudget.draw(context, emailIdBytes(emails));
    }

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

// A journal entry that makes a message visible: a new Email (delivery, append, copy, restore; not the
// arriving half of a move) or \Deleted cleared
const appears = entry =>
    (entry.command === 'EXISTS' && entry.origin !== consts.JOURNAL_ORIGIN.MOVE) || (entry.command === 'FETCH' && entry.deletedChangedTo === false);

// Only entries that can change the emailIds of a thread make it changed: messages added or removed, and
// \Deleted set or cleared (those messages are invisible). Other flag changes leave the thread as it was,
// but still tell that its message was visible before.
const membershipChange = entry =>
    entry.command === 'EXISTS' || entry.command === 'EXPUNGE' || (entry.command === 'FETCH' && entry.deletedChangedTo !== undefined);

/**
 * Folds journal entries per thread. For every message (root) of a thread only its first entry in the
 * window matters: if that entry made it appear, the message was not visible at the old state. A thread
 * where this holds for every message touched in the window was invisible at the old state, unless it
 * has visible messages the window did not touch.
 */
const threadFold = {
    key: entry => entry.thread.toString(),
    // `known`: an entry of the safety window, at or before the state, so its message was visible then
    fold(map, entry, known) {
        const key = entry.thread.toString();
        let thread = map.get(key);
        if (!thread) {
            thread = { roots: new Set(), visibleBefore: false, changed: false };
            map.set(key, thread);
        }
        thread.changed = thread.changed || membershipChange(entry);
        const root = (entry.root || entry.message || '').toString();
        if (!thread.roots.has(root)) {
            thread.roots.add(root);
            if (known || !appears(entry)) {
                thread.visibleBefore = true;
            }
        }
    }
};

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const since = parseState(context, args.sinceState);
    const maxChanges = maxChangesOf(args);
    const entries = await entriesSince(context, since, { thread: { $exists: true } });
    const { changes: touched, last, more } = await foldEntries(entries, threadFold, maxChanges);

    // only threads whose emailIds may have changed are reported; what they look like now decides between
    // created, updated and destroyed
    const changed = [...touched].filter(([, thread]) => thread.changed);
    const existing = await threadEmails(
        context,
        changed.map(([id]) => new ObjectId(id))
    );
    const result = new Map();
    for (const [id, thread] of changed) {
        if (existing.truncated) {
            // too many messages to tell created from destroyed: the client reads the threads again
            result.set(formatId('thread', id), 'updated');
            continue;
        }
        const emailIds = existing.get(id);
        // a visible message the window did not touch was visible at the old state too
        const visibleBefore = thread.visibleBefore || (emailIds && emailIds.some(emailId => !thread.roots.has(emailId.slice(1))));
        if (!emailIds) {
            if (visibleBefore) {
                result.set(formatId('thread', id), 'destroyed');
            }
        } else {
            result.set(formatId('thread', id), visibleBefore ? 'updated' : 'created');
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

module.exports = { capability: URN.mail, methods: { 'Thread/get': get, 'Thread/changes': changes }, threadFold, LIMITS };
