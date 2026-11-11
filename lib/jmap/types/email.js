'use strict';

// Email/get (RFC 8621 4.2) and the helpers other Email modules share. Email/changes lives in
// email-changes.js, Email/query in email-query.js.

const { URN } = require('../capabilities');
const { parseId, formatId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments } = require('./common');
const { mailState } = require('../state');
const { resolveProperties, projectionFor, bodyArguments, toEmail } = require('../email-model');
const { resolveRoots, ensureUserRoots, rootOf } = require('../../message-roots');
const { getLabelMaps } = require('../../label-handler');
const { attachmentSizes } = require('../email-body');

/**
 * Makes sure the roots of the account are usable as Email ids (once per user, see message-roots.js).
 * Resolves with true once that is done, so lookups can skip the legacy branch.
 */
function rootsReady(context) {
    if (!context.cache.rootsReady) {
        context.cache.rootsReady = ensureUserRoots(context.deps.database, context.account.user).then(
            () => true,
            () => false
        );
    }
    return context.cache.rootsReady;
}

/** Active label ids of the account, for keywords */
function labelIds(context) {
    if (!context.cache.labels) {
        context.cache.labels = getLabelMaps(context.deps.database, context.account.user).then(maps => new Set(maps.byId.keys()));
    }
    return context.cache.labels;
}

/**
 * The visible message documents for Email ids. Messages flagged \Deleted are invisible to JMAP.
 *
 * @returns {Promise<Map<String, Object>>} Email id -> document
 */
async function messagesByEmailId(context, emailIds, projection) {
    const roots = [];
    for (const id of emailIds) {
        const root = parseId('email', id);
        if (root) {
            roots.push(root);
        }
    }
    const found = await resolveRoots(context.deps.database.collection('messages'), context.account.user, roots, {
        projection,
        legacy: !(await rootsReady(context))
    });
    const result = new Map();
    for (const doc of found.values()) {
        if (doc.undeleted !== false) {
            result.set(formatId('email', rootOf(doc)), doc);
        }
    }
    return result;
}

function idList(args, context) {
    if (!Array.isArray(args.ids) || !args.ids.every(id => typeof id === 'string')) {
        throw invalidArguments('ids must be a list of Email ids');
    }
    if (args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    // creation id references resolve to the ids they were created as
    return [...new Set(args.ids)].map(id => [id, id.startsWith('#') && context.createdIds[id.slice(1)] ? context.createdIds[id.slice(1)] : id]);
}

async function get(args, context) {
    checkArguments(args, [
        'accountId',
        'ids',
        'properties',
        'bodyProperties',
        'fetchTextBodyValues',
        'fetchHTMLBodyValues',
        'fetchAllBodyValues',
        'maxBodyValueBytes'
    ]);
    requireAccount(args, context);
    if (args.ids === undefined || args.ids === null) {
        throw invalidArguments('ids is required, listing every Email is not supported');
    }
    const ids = idList(args, context);
    const resolved = resolveProperties(args.properties);
    const body = bodyArguments(args);

    const docs = await messagesByEmailId(
        context,
        ids.map(([, id]) => id),
        projectionFor(resolved)
    );
    const emailContext = { labelIds: await labelIds(context), messageHandler: context.deps.messageHandler };
    if (resolved.needsTree) {
        // exact decoded sizes of stored attachments, one query for every Email of the call
        emailContext.sizes = await attachmentSizes(
            context.deps.messageHandler,
            [...docs.values()].map(doc => doc.mimeTree)
        );
    }

    const list = [];
    const notFound = [];
    for (const [requested, id] of ids) {
        const doc = docs.get(id);
        if (doc) {
            list.push(await toEmail(doc, resolved, body, emailContext));
        } else {
            notFound.push(requested);
        }
    }
    const { state } = await mailState(context);
    return { accountId: context.account.id, state, list, notFound };
}

// push states of the mail types (EventSource, PushSubscription): they share one state, EmailDelivery has its own
async function pushStates(context) {
    const { state, delivery } = await mailState(context);
    return { Email: state, Mailbox: state, Thread: state, EmailDelivery: delivery };
}

module.exports = {
    capability: URN.mail,
    methods: { 'Email/get': get },
    pushTypes: ['Email', 'Mailbox', 'Thread', 'EmailDelivery'],
    pushStates,
    messagesByEmailId,
    rootsReady,
    labelIds
};
