'use strict';

// Quota (RFC 9425) over the per user storage quota: one Quota object per account, of resource type
// octets and scope account, whose used value is the user's storageUsed and whose hardLimit is the
// effective quota (the user's own, else the server default that delivery enforces).
//
// Usage changes with every delivery, so the state is derived instead of logged: it names used and the
// limit, with a keyed checksum of the account. Nothing is written when mail arrives, /changes compares
// the two values, and a state of another account, or a made up one, is never accepted.

const crypto = require('crypto');
const { URN } = require('../capabilities');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments, isObject } = require('./common');
const { pagingArguments, windowOf } = require('../query');
const { maxChangesOf } = require('../state');
const consts = require('../../consts');

const QUOTA_ID = 'Qstorage';
const NAME = 'Mail storage';
const DESCRIPTION = 'Storage used by the messages of the account';
const PROPERTIES = ['id', 'resourceType', 'used', 'hardLimit', 'scope', 'name', 'types', 'warnLimit', 'softLimit', 'description'];
const FILTERS = ['name', 'scope', 'resourceType', 'type'];
const SORTS = ['name', 'used'];
const STATE = /^q([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-f]{8})$/;

function checksum(context, used, limit) {
    return crypto.createHmac('sha256', context.options.accessSecret).update(`${context.account.id}:quota:${used}:${limit}`).digest('hex').slice(0, 8);
}

const formatState = (context, usage) => `q${usage.used.toString(36)}.${usage.limit.toString(36)}.${checksum(context, usage.used, usage.limit)}`;

/** {used, limit} of a state string of this account, or null */
function parseState(context, state) {
    const match = STATE.exec(state);
    if (!match) {
        return null;
    }
    const used = parseInt(match[1], 36);
    const limit = parseInt(match[2], 36);
    return checksum(context, used, limit) === match[3] ? { used, limit } : null;
}

// the server default quota (const:max:storage), kept in memory for a while instead of read for every state
const DEFAULT_LIMIT_CACHE_TIME = 60 * 1000;
const defaultLimitCache = { value: null, expires: 0 };

async function defaultLimit(settingsHandler) {
    if (defaultLimitCache.expires < Date.now()) {
        defaultLimitCache.value = Number(await settingsHandler.get('const:max:storage')) || 0;
        defaultLimitCache.expires = Date.now() + DEFAULT_LIMIT_CACHE_TIME;
    }
    return defaultLimitCache.value;
}

/**
 * The usage and the effective limit of the account, read once per request. A user document with quota
 * and storageUsed that the caller has read already (context.cache.quotaUser, Web Push) is used as is.
 */
function loadUsage(context) {
    if (!context.cache.quota) {
        context.cache.quota = (async () => {
            const { deps, account } = context;
            const userData =
                context.cache.quotaUser ||
                (await deps.users
                    .collection('users')
                    .findOne({ _id: account.user }, { projection: { quota: true, storageUsed: true }, maxTimeMS: consts.DB_MAX_TIME_USERS }));
            const limit = Number(userData && userData.quota) || (await defaultLimit(deps.settingsHandler));
            return { used: Math.max(Number(userData && userData.storageUsed) || 0, 0), limit };
        })();
    }
    return context.cache.quota;
}

/** The quota applies to Email only, so a client that did not ask for mail does not see it (RFC 9425 4.1) */
const visible = context => !context.using || context.using.has(URN.mail);

function toQuota(usage, properties) {
    const values = {
        id: QUOTA_ID,
        resourceType: 'octets',
        used: usage.used,
        hardLimit: usage.limit,
        scope: 'account',
        name: NAME,
        types: ['Email'],
        warnLimit: null,
        softLimit: null,
        description: DESCRIPTION
    };
    return Object.fromEntries(properties.map(property => [property, values[property]]));
}

async function get(args, context) {
    checkArguments(args, ['accountId', 'ids', 'properties']);
    requireAccount(args, context);
    const requested = args.properties === undefined || args.properties === null ? PROPERTIES : args.properties;
    if (!Array.isArray(requested) || requested.some(property => !PROPERTIES.includes(property))) {
        throw invalidArguments('unknown property');
    }
    if (args.ids !== undefined && args.ids !== null && !(Array.isArray(args.ids) && args.ids.every(id => typeof id === 'string'))) {
        throw invalidArguments('ids must be a list of ids');
    }
    if (args.ids && args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    const properties = ['id', ...requested.filter(property => property !== 'id')];
    const usage = await loadUsage(context);
    const result = { accountId: context.account.id, state: formatState(context, usage), list: [], notFound: [] };
    const ids = args.ids === undefined || args.ids === null ? [QUOTA_ID] : [...new Set(args.ids)];
    for (const id of ids) {
        if (id === QUOTA_ID && visible(context)) {
            result.list.push(toQuota(usage, properties));
        } else if (args.ids) {
            result.notFound.push(id);
        }
    }
    return result;
}

async function changes(args, context) {
    checkArguments(args, ['accountId', 'sinceState', 'maxChanges']);
    requireAccount(args, context);
    if (typeof args.sinceState !== 'string') {
        throw invalidArguments('sinceState must be a string');
    }
    maxChangesOf(args);
    const since = parseState(context, args.sinceState);
    if (!since) {
        throw new MethodError('cannotCalculateChanges');
    }
    const usage = await loadUsage(context);
    const newState = formatState(context, usage);
    const changed = since.used !== usage.used || since.limit !== usage.limit;
    return {
        accountId: context.account.id,
        oldState: args.sinceState,
        newState,
        hasMoreChanges: false,
        created: [],
        updated: changed ? [QUOTA_ID] : [],
        destroyed: [],
        // RFC 9425 4.3: [used] when nothing but the usage changed, otherwise null
        updatedProperties: changed && since.limit === usage.limit ? ['used'] : null
    };
}

/** A FilterCondition or FilterOperator to a predicate over the Quota object */
function filterOf(filter, depth = 0) {
    if (filter === undefined || filter === null) {
        return () => true;
    }
    if (!isObject(filter) || depth > 10) {
        throw invalidArguments('filter must be a FilterOperator or FilterCondition');
    }
    if ('operator' in filter) {
        if (Object.keys(filter).some(key => key !== 'operator' && key !== 'conditions') || !Array.isArray(filter.conditions)) {
            throw invalidArguments('a FilterOperator has operator and conditions');
        }
        const parts = filter.conditions.map(entry => filterOf(entry, depth + 1));
        const combine = {
            AND: quota => parts.every(part => part(quota)),
            OR: quota => parts.some(part => part(quota)),
            NOT: quota => !parts.some(part => part(quota))
        }[filter.operator];
        if (!combine) {
            throw invalidArguments('operator must be AND, OR or NOT');
        }
        return combine;
    }
    const tests = [];
    for (const [key, value] of Object.entries(filter)) {
        if (!FILTERS.includes(key)) {
            throw invalidArguments(`unknown filter property ${key}`);
        }
        if (typeof value !== 'string') {
            throw invalidArguments(`${key} must be a string`);
        }
        tests.push(
            {
                name: quota => quota.name.includes(value),
                scope: quota => quota.scope === value,
                resourceType: quota => quota.resourceType === value,
                type: quota => quota.types.includes(value)
            }[key]
        );
    }
    return quota => tests.every(test => test(quota));
}

function checkSort(sort) {
    if (sort === undefined || sort === null) {
        return;
    }
    if (!Array.isArray(sort) || sort.length > 10) {
        throw invalidArguments('sort must be a list of Comparators');
    }
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
        if (!SORTS.includes(comparator.property)) {
            throw new MethodError('unsupportedSort', { description: `can not sort by ${comparator.property}` });
        }
    }
}

async function query(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'position', 'anchor', 'anchorOffset', 'limit', 'calculateTotal']);
    requireAccount(args, context);
    const matches = filterOf(args.filter);
    checkSort(args.sort);
    const paging = pagingArguments(args, context.limits.maxObjectsInGet);
    const usage = await loadUsage(context);
    // a single object: every sort gives the same order
    const ids = visible(context) && matches(toQuota(usage, PROPERTIES)) ? [QUOTA_ID] : [];
    const window = windowOf(ids, paging);
    const result = {
        accountId: context.account.id,
        queryState: formatState(context, usage),
        canCalculateChanges: false,
        position: window.position,
        ids: window.ids
    };
    if (paging.calculateTotal) {
        result.total = ids.length;
    }
    return result;
}

/** Query results are not kept (canCalculateChanges is false), but the arguments are still checked */
async function queryChanges(args, context) {
    checkArguments(args, ['accountId', 'filter', 'sort', 'sinceQueryState', 'maxChanges', 'upToId', 'calculateTotal']);
    requireAccount(args, context);
    if (typeof args.sinceQueryState !== 'string') {
        throw invalidArguments('sinceQueryState must be a string');
    }
    filterOf(args.filter);
    checkSort(args.sort);
    maxChangesOf(args);
    throw new MethodError('cannotCalculateChanges');
}

const pushStates = async context => ({ Quota: formatState(context, await loadUsage(context)) });

module.exports = {
    capability: URN.quota,
    methods: { 'Quota/get': get, 'Quota/changes': changes, 'Quota/query': query, 'Quota/queryChanges': queryChanges },
    pushTypes: ['Quota'],
    pushStates,
    // exposed for unit tests
    filterOf,
    QUOTA_ID
};
