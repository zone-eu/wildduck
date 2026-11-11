'use strict';

// Mailbox/get, Mailbox/changes, Mailbox/query (RFC 8621 2). WildDuck mailboxes are paths with "/" as
// the delimiter; hidden mailboxes are not exposed. A child may exist without its parent (IMAP allows
// it): its parent is then the nearest existing ancestor, and its name the remaining path.

const { URN } = require('../capabilities');
const { formatId, parseId } = require('../ids');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments } = require('./common');
const { mailState, parseState, entriesSince, maxChangesOf, foldEntries, changeLists, formatState, createdAfter } = require('../state');
const { mailboxCounts } = require('../mailbox-counts');
const { pagingArguments, windowOf } = require('../query');
const consts = require('../../consts');

const PROPERTIES = ['id', 'name', 'parentId', 'role', 'sortOrder', 'totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads', 'myRights', 'isSubscribed'];
const COUNT_PROPERTIES = ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'];
const MAX_DEPTH = 128;
const MAX_NAME = 512;

const roleOf = mailboxData =>
    mailboxData.path === 'INBOX' ? 'inbox' : mailboxData.specialUse ? mailboxData.specialUse.replace(/^\\/, '').toLowerCase() : null;

// RFC 8621 2: the nine rights. INBOX can not be renamed or deleted, special use mailboxes not deleted
function rightsOf(mailboxData) {
    const isInbox = mailboxData.path === 'INBOX';
    return {
        mayReadItems: true,
        mayAddItems: true,
        mayRemoveItems: true,
        maySetSeen: true,
        maySetKeywords: true,
        mayCreateChild: true,
        mayRename: !isInbox,
        mayDelete: !isInbox && !mailboxData.specialUse,
        maySubmit: true
    };
}

/** All visible mailboxes of the account with name and parentId derived from the paths */
async function loadMailboxes(context) {
    if (!context.cache.mailboxes) {
        context.cache.mailboxes = (async () => {
            const docs = await context.deps.database
                .collection('mailboxes')
                .find(
                    { user: context.account.user },
                    {
                        projection: { path: true, specialUse: true, subscribed: true, hidden: true, sortOrder: true, modifyIndex: true, uidNext: true },
                        maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
                    }
                )
                .toArray();
            const visible = docs.filter(doc => !doc.hidden);
            const byPath = new Map(visible.map(doc => [doc.path, doc]));
            for (const doc of visible) {
                const segments = doc.path.split('/');
                let parent = null;
                let depth = segments.length - 1;
                for (; depth > 0; depth--) {
                    parent = byPath.get(segments.slice(0, depth).join('/'));
                    if (parent) {
                        break;
                    }
                }
                doc.parent = parent || null;
                doc.name = segments.slice(parent ? depth : 0).join('/');
            }
            return { list: visible, byId: new Map(visible.map(doc => [doc._id.toString(), doc])) };
        })();
    }
    return context.cache.mailboxes;
}

async function toMailbox(context, doc, properties) {
    const mailbox = {};
    const values = {
        id: () => formatId('mailbox', doc._id),
        name: () => doc.name,
        parentId: () => (doc.parent ? formatId('mailbox', doc.parent._id) : null),
        role: () => roleOf(doc),
        sortOrder: () => (Number.isInteger(doc.sortOrder) ? doc.sortOrder : 0),
        myRights: () => rightsOf(doc),
        isSubscribed: () => doc.subscribed !== false
    };
    if (properties.some(property => COUNT_PROPERTIES.includes(property))) {
        Object.assign(
            values,
            await mailboxCounts(context.deps, doc).then(counts => Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, () => value])))
        );
    }
    for (const property of properties) {
        mailbox[property] = values[property]();
    }
    return mailbox;
}

function propertiesOf(args) {
    if (args.properties === undefined || args.properties === null) {
        return PROPERTIES;
    }
    if (!Array.isArray(args.properties) || !args.properties.every(property => PROPERTIES.includes(property))) {
        throw invalidArguments('unknown property requested');
    }
    // the id is always returned
    return ['id', ...args.properties.filter(property => property !== 'id')];
}

async function get(args, context) {
    checkArguments(args, ['accountId', 'ids', 'properties']);
    requireAccount(args, context);
    const properties = propertiesOf(args);
    if (args.ids !== undefined && args.ids !== null && (!Array.isArray(args.ids) || !args.ids.every(id => typeof id === 'string'))) {
        throw invalidArguments('ids must be a list of ids');
    }
    const { list, byId } = await loadMailboxes(context);
    const wanted = args.ids === undefined || args.ids === null ? list : null;
    if (wanted && wanted.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    if (!wanted && args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }

    const found = [];
    const notFound = [];
    for (const id of wanted ? list.map(doc => formatId('mailbox', doc._id)) : args.ids) {
        const resolved = id.startsWith('#') && context.createdIds[id.slice(1)] ? context.createdIds[id.slice(1)] : id;
        const oid = parseId('mailbox', resolved);
        const doc = oid && byId.get(oid.toString());
        if (doc) {
            found.push(doc);
        } else {
            notFound.push(id);
        }
    }

    const { state } = await mailState(context);
    return { accountId: context.account.id, state, list: await Promise.all(found.map(doc => toMailbox(context, doc, properties))), notFound };
}

const STRUCTURAL = new Set(['CREATE', 'RENAME', 'DELETE', 'MAILBOX_UPDATE']);

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    const since = parseState(context, args.sinceState);
    const maxChanges = maxChangesOf(args);
    const entries = await entriesSince(context, since, { mailbox: { $exists: true } });

    // per mailbox: whether anything but the counts changed
    const {
        changes: touched,
        last,
        more
    } = await foldEntries(
        entries,
        {
            key: entry => entry.mailbox.toString(),
            fold: (map, entry) => map.set(entry.mailbox.toString(), map.get(entry.mailbox.toString()) || STRUCTURAL.has(entry.command))
        },
        maxChanges
    );

    const { byId } = await loadMailboxes(context);
    const result = new Map();
    let countsOnly = true;
    for (const [id, structural] of touched) {
        const doc = byId.get(id);
        const createdSince = createdAfter(id, since);
        if (!doc) {
            if (!createdSince) {
                result.set(formatId('mailbox', id), 'destroyed');
            }
        } else if (createdSince) {
            result.set(formatId('mailbox', id), 'created');
        } else {
            result.set(formatId('mailbox', id), 'updated');
            countsOnly = countsOnly && !structural;
        }
    }

    const { state } = await mailState(context);
    const lists = changeLists(result);
    return {
        accountId: context.account.id,
        oldState: args.sinceState,
        newState: more ? formatState(context, last || since) : state,
        hasMoreChanges: more,
        updatedProperties: lists.updated.length && countsOnly ? COUNT_PROPERTIES : null,
        ...lists
    };
}

// ---- query

const FILTER_PROPERTIES = ['parentId', 'name', 'role', 'hasAnyRole', 'isSubscribed'];

function compileFilter(filter, depth = 0) {
    if (filter === undefined || filter === null) {
        return () => true;
    }
    if (typeof filter !== 'object' || Array.isArray(filter) || depth > 10) {
        throw invalidArguments('invalid filter');
    }
    if ('operator' in filter) {
        if (
            !['AND', 'OR', 'NOT'].includes(filter.operator) ||
            !Array.isArray(filter.conditions) ||
            Object.keys(filter).some(key => !['operator', 'conditions'].includes(key))
        ) {
            throw invalidArguments('invalid filter operator');
        }
        const conditions = filter.conditions.map(condition => compileFilter(condition, depth + 1));
        if (filter.operator === 'AND') {
            return doc => conditions.every(test => test(doc));
        }
        if (filter.operator === 'OR') {
            return doc => conditions.some(test => test(doc));
        }
        return doc => !conditions.some(test => test(doc));
    }
    const tests = [];
    for (const [key, value] of Object.entries(filter)) {
        if (!FILTER_PROPERTIES.includes(key)) {
            throw invalidArguments(`unknown filter property ${key}`);
        }
        if (key === 'parentId') {
            if (value !== null && typeof value !== 'string') {
                throw invalidArguments('parentId must be an id or null');
            }
            tests.push(doc => (doc.parent ? formatId('mailbox', doc.parent._id) : null) === value);
        } else if (key === 'name') {
            if (typeof value !== 'string') {
                throw invalidArguments('name must be a string');
            }
            tests.push(doc => doc.name.toLowerCase().includes(value.toLowerCase()));
        } else if (key === 'role') {
            if (value !== null && typeof value !== 'string') {
                throw invalidArguments('role must be a string or null');
            }
            tests.push(doc => roleOf(doc) === value);
        } else {
            if (typeof value !== 'boolean') {
                throw invalidArguments(`${key} must be a boolean`);
            }
            tests.push(key === 'hasAnyRole' ? doc => !!roleOf(doc) === value : doc => (doc.subscribed !== false) === value);
        }
    }
    return doc => tests.every(test => test(doc));
}

const compareName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const sortOrderOf = doc => (Number.isInteger(doc.sortOrder) ? doc.sortOrder : 0);

function compileSort(sort) {
    if (sort === undefined || sort === null) {
        return (a, b) => sortOrderOf(a) - sortOrderOf(b) || compareName(a, b);
    }
    if (!Array.isArray(sort)) {
        throw invalidArguments('sort must be a list');
    }
    const comparators = sort.map(comparator => {
        if (!comparator || typeof comparator.property !== 'string' || (comparator.isAscending !== undefined && typeof comparator.isAscending !== 'boolean')) {
            throw invalidArguments('invalid comparator');
        }
        const direction = comparator.isAscending === false ? -1 : 1;
        if (comparator.property === 'sortOrder') {
            return (a, b) => direction * (sortOrderOf(a) - sortOrderOf(b));
        }
        if (comparator.property === 'name') {
            return (a, b) => direction * compareName(a, b);
        }
        throw new MethodError('unsupportedSort', { description: `can not sort by ${comparator.property}` });
    });
    // ties fall back to the id so the order is stable
    return (a, b) => {
        for (const compare of comparators) {
            const result = compare(a, b);
            if (result) {
                return result;
            }
        }
        return a._id.toString() < b._id.toString() ? -1 : 1;
    };
}

// sortAsTree: parents before children, siblings in sort order (RFC 8621 2.3)
function asTree(docs, compare) {
    const children = new Map();
    for (const doc of docs) {
        const key = doc.parent ? doc.parent._id.toString() : '';
        children.set(key, (children.get(key) || []).concat(doc));
    }
    const result = [];
    const visit = key => {
        for (const doc of (children.get(key) || []).sort(compare)) {
            result.push(doc);
            visit(doc._id.toString());
        }
    };
    visit('');
    return result;
}

async function query(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'position', 'anchor', 'anchorOffset', 'limit', 'calculateTotal', 'sortAsTree', 'filterAsTree']);
    requireAccount(args, context);
    const test = compileFilter(args.filter);
    const compare = compileSort(args.sort);
    const paging = pagingArguments(args, consts.MAX_MAILBOXES || 1500);
    const { list } = await loadMailboxes(context);

    let matching;
    if (args.filterAsTree) {
        // a mailbox matches only if it and all of its ancestors match
        const passes = new Map(list.map(doc => [doc._id.toString(), test(doc)]));
        const chainPasses = doc => passes.get(doc._id.toString()) && (!doc.parent || chainPasses(doc.parent));
        matching = list.filter(chainPasses);
    } else {
        matching = list.filter(test);
    }
    const ordered = args.sortAsTree ? asTree(matching, compare) : matching.sort(compare);
    const ids = ordered.map(doc => formatId('mailbox', doc._id));
    const window = windowOf(ids, paging);

    const { state } = await mailState(context);
    const result = { accountId: context.account.id, queryState: state, canCalculateChanges: false, position: window.position, ids: window.ids };
    if (paging.calculateTotal) {
        result.total = ids.length;
    }
    if (paging.limitClamped) {
        result.limit = paging.limit;
    }
    return result;
}

// RFC 8621 1.3.1: the mail account capability
const SORT_OPTIONS = ['receivedAt', 'sentAt', 'size', 'from', 'to', 'subject', 'hasKeyword', 'allInThreadHaveKeyword', 'someInThreadHaveKeyword'];
const accountCapability = () => ({
    maxMailboxesPerEmail: 1,
    maxMailboxDepth: MAX_DEPTH,
    maxSizeMailboxName: MAX_NAME,
    maxSizeAttachmentsPerEmail: consts.MAX_ALLOWED_MESSAGE_SIZE,
    emailQuerySortOptions: SORT_OPTIONS,
    mayCreateTopLevelMailbox: true
});

module.exports = {
    capability: URN.mail,
    accountCapability,
    methods: { 'Mailbox/get': get, 'Mailbox/changes': changes, 'Mailbox/query': query },
    loadMailboxes,
    roleOf,
    MAX_DEPTH,
    MAX_NAME
};
