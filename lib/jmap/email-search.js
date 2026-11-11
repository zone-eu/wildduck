'use strict';

// Email/query filters as MongoDB queries (RFC 8621 4.4.1).
//
// Every query is limited to the account's visible messages ({user, undeleted: true}). Text conditions
// use the fulltext index, which MongoDB allows only once and only at the root of a query: the first
// text condition on a plain AND path goes into the query itself, others run as separate, capped
// queries whose ids are substituted (the same approach as IMAP SEARCH in lib/handlers/on-search.js).

const { ObjectId } = require('mongodb');
const { parseId } = require('./ids');
const { MethodError, invalidArguments } = require('./errors');
const consts = require('../consts');

const MAX_DEPTH = 10;
const MAX_CONDITIONS = 100;
// matches of a text condition that is not at the root of the query, substituted as an id list
const TEXT_MATCH_CAP = 10000;
const MATCH_NOTHING = { _id: new ObjectId('000000000000000000000000') };

const CONDITIONS = [
    'inMailbox',
    'inMailboxOtherThan',
    'before',
    'after',
    'minSize',
    'maxSize',
    'allInThreadHaveKeyword',
    'someInThreadHaveKeyword',
    'noneInThreadHaveKeyword',
    'hasKeyword',
    'notKeyword',
    'hasAttachment',
    'text',
    'from',
    'to',
    'cc',
    'bcc',
    'subject',
    'body',
    'header'
];
const THREAD_CONDITIONS = ['allInThreadHaveKeyword', 'someInThreadHaveKeyword', 'noneInThreadHaveKeyword'];

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KEYWORD = /^[\x21-\x7e]{1,255}$/;

/** A JMAP keyword as a message query (system keywords have fields of their own) */
function keywordQuery(keyword, present) {
    if (typeof keyword !== 'string' || !KEYWORD.test(keyword) || /[()\]{%*"\\]/.test(keyword)) {
        throw invalidArguments('invalid keyword');
    }
    const lower = keyword.toLowerCase();
    const label = /^\$wdlabel\$([a-f0-9]{24})$/.exec(lower);
    if (label) {
        return present ? { labels: new ObjectId(label[1]) } : { labels: { $ne: new ObjectId(label[1]) } };
    }
    switch (lower) {
        case '$seen':
            return { unseen: !present };
        case '$flagged':
            return { flagged: present };
        case '$draft':
            return { draft: present };
        default: {
            const flag = lower === '$answered' ? '\\Answered' : keyword;
            const match = { $regex: `^${escapeRegex(flag)}$`, $options: 'i' };
            return present ? { flags: match } : { flags: { $not: new RegExp(`^${escapeRegex(flag)}$`, 'i') } };
        }
    }
}

function utcDate(value, name) {
    const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) ? new Date(value) : null;
    if (!date || isNaN(date)) {
        throw invalidArguments(`${name} must be a UTCDate`);
    }
    return date;
}

function unsignedInt(value, name) {
    if (!Number.isInteger(value) || value < 0) {
        throw invalidArguments(`${name} must be an unsigned integer`);
    }
    return value;
}

function headerQuery(key, value) {
    const term = { key };
    if (value !== undefined) {
        term.value = { $regex: escapeRegex(value.toLowerCase()) };
    }
    return { headers: { $elemMatch: term } };
}

/**
 * Compiles a FilterCondition or FilterOperator.
 *
 * @param {Object} filter
 * @param {Object} state Shared by the whole filter: {texts: [], count, rootText}
 * @param {Object} path Of this branch: {plain: only ANDs above it, negated: under an odd number of NOTs}
 * @returns {Object} MongoDB query fragment
 */
function compile(filter, state, path, depth) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw invalidArguments('a filter must be an object');
    }
    if (depth > MAX_DEPTH || ++state.count > MAX_CONDITIONS) {
        throw new MethodError('unsupportedFilter', { description: 'the filter is too deep or too large' });
    }
    if ('operator' in filter) {
        if (
            !['AND', 'OR', 'NOT'].includes(filter.operator) ||
            !Array.isArray(filter.conditions) ||
            Object.keys(filter).some(key => !['operator', 'conditions'].includes(key))
        ) {
            throw invalidArguments('invalid FilterOperator');
        }
        const childPath = { plain: path.plain && filter.operator === 'AND', negated: path.negated !== (filter.operator === 'NOT') };
        const parts = filter.conditions.map(condition => compile(condition, state, childPath, depth + 1));
        if (!parts.length) {
            // AND of nothing matches everything, OR of nothing matches nothing, NOT of nothing everything
            return filter.operator === 'OR' ? MATCH_NOTHING : {};
        }
        if (filter.operator === 'AND') {
            return { $and: parts };
        }
        if (filter.operator === 'OR') {
            return { $or: parts };
        }
        return { $nor: parts };
    }
    return condition(filter, state, path);
}

function textCondition(value, field, state, path) {
    if (typeof value !== 'string') {
        throw invalidArguments(`${field} must be a string`);
    }
    // every word must match: quoted terms are ANDed by MongoDB text search, a leading minus is not a negation
    const search = value
        .split(/\s+/)
        .map(word => word.replace(/"/g, ''))
        .filter(Boolean)
        .map(word => `"${word}"`)
        .join(' ');
    if (!search) {
        return {};
    }
    const extra = field === 'body' ? { text: { $regex: escapeRegex(value.trim()), $options: 'i' } } : {};
    if (path.plain && !path.negated && !state.rootText) {
        state.rootText = search;
        return extra;
    }
    // resolved later into an id list
    const placeholder = { _textPlaceholder: state.texts.length };
    state.texts.push({ search, extra });
    return placeholder;
}

function condition(filter, state, path) {
    const parts = [];
    for (const [key, value] of Object.entries(filter)) {
        if (!CONDITIONS.includes(key)) {
            throw invalidArguments(`unknown filter property ${key}`);
        }
        switch (key) {
            case 'inMailbox': {
                const mailbox = parseId('mailbox', value);
                parts.push(mailbox ? { mailbox } : MATCH_NOTHING);
                break;
            }
            case 'inMailboxOtherThan':
                if (!Array.isArray(value) || !value.every(id => typeof id === 'string')) {
                    throw invalidArguments('inMailboxOtherThan must be a list of ids');
                }
                parts.push({ mailbox: { $nin: value.map(id => parseId('mailbox', id)).filter(Boolean) } });
                break;
            case 'before':
                parts.push({ idate: { $lt: utcDate(value, key) } });
                break;
            case 'after':
                parts.push({ idate: { $gte: utcDate(value, key) } });
                break;
            case 'minSize':
                parts.push({ size: { $gte: unsignedInt(value, key) } });
                break;
            case 'maxSize':
                parts.push({ size: { $lt: unsignedInt(value, key) } });
                break;
            case 'hasKeyword':
            case 'notKeyword':
                parts.push(keywordQuery(value, key === 'hasKeyword'));
                break;
            case 'hasAttachment':
                if (typeof value !== 'boolean') {
                    throw invalidArguments('hasAttachment must be a boolean');
                }
                parts.push(value ? { ha: true } : { ha: { $ne: true } });
                break;
            case 'text':
            case 'body':
                parts.push(textCondition(value, key, state, path));
                break;
            case 'from':
            case 'to':
            case 'cc':
            case 'bcc':
            case 'subject':
                if (typeof value !== 'string') {
                    throw invalidArguments(`${key} must be a string`);
                }
                parts.push(headerQuery(key, value));
                break;
            case 'header':
                if (!Array.isArray(value) || value.length < 1 || value.length > 2 || !value.every(item => typeof item === 'string')) {
                    throw invalidArguments('header must be [name] or [name, value]');
                }
                parts.push(headerQuery(value[0].toLowerCase(), value[1]));
                break;
            default:
                // thread keyword conditions, see threadConditions()
                if (typeof value !== 'string') {
                    throw invalidArguments(`${key} must be a keyword`);
                }
                parts.push({ _threadKeyword: { kind: key, keyword: value } });
        }
    }
    return parts.length === 1 ? parts[0] : { $and: parts };
}

/** Thread keyword conditions as thread id lists: which threads have messages with or without the keyword */
async function threadKeywordQuery(context, kind, keyword) {
    const messages = context.deps.database.collection('messages');
    const base = { user: context.account.user, undeleted: true };
    const threadsWith = async query => messages.distinct('thread', Object.assign({}, base, query), { maxTimeMS: consts.DB_MAX_TIME_MESSAGES_SEARCH * 3 });
    if (kind === 'someInThreadHaveKeyword') {
        return { thread: { $in: await threadsWith(keywordQuery(keyword, true)) } };
    }
    if (kind === 'noneInThreadHaveKeyword') {
        return { thread: { $nin: await threadsWith(keywordQuery(keyword, true)) } };
    }
    // allInThreadHaveKeyword: no message of the thread lacks the keyword
    return { thread: { $nin: await threadsWith(keywordQuery(keyword, false)) } };
}

/** Replaces the placeholders of a compiled query with the resolved sub queries */
async function resolvePlaceholders(node, context, state) {
    if (Array.isArray(node)) {
        return Promise.all(node.map(item => resolvePlaceholders(item, context, state)));
    }
    if (!node || typeof node !== 'object' || node instanceof ObjectId || node instanceof Date || node instanceof RegExp) {
        return node;
    }
    if ('_textPlaceholder' in node) {
        const { search, extra } = state.texts[node._textPlaceholder];
        const ids = await context.deps.database
            .collection('messages')
            .find(Object.assign({ user: context.account.user, searchable: true, $text: { $search: search } }, extra), { projection: { _id: true } })
            .limit(TEXT_MATCH_CAP)
            .maxTimeMS(consts.DB_MAX_TIME_MESSAGES_SEARCH * 3)
            .toArray();
        return { _id: { $in: ids.map(doc => doc._id) } };
    }
    if ('_threadKeyword' in node) {
        return threadKeywordQuery(context, node._threadKeyword.kind, node._threadKeyword.keyword);
    }
    const result = {};
    for (const [key, value] of Object.entries(node)) {
        result[key] = await resolvePlaceholders(value, context, state);
    }
    return result;
}

/**
 * The MongoDB query of an Email/query filter.
 *
 * @param {Object|null} filter
 * @param {Object} context Request context
 * @returns {Promise<Object>} Query on the messages collection
 */
async function buildQuery(filter, context) {
    const state = { texts: [], count: 0, rootText: null };
    const compiled = filter === undefined || filter === null ? {} : compile(filter, state, { plain: true, negated: false }, 0);
    const resolved = await resolvePlaceholders(compiled, context, state);
    const query = { user: context.account.user, undeleted: true };
    if (state.rootText) {
        query.searchable = true;
        query.$text = { $search: state.rootText };
    }
    return Object.keys(resolved).length ? Object.assign(query, { $and: [resolved] }) : query;
}

/** Validates a filter the way Email/query does, without running anything */
function validateFilter(filter) {
    if (filter !== undefined && filter !== null) {
        compile(filter, { texts: [], count: 0, rootText: null }, { plain: true, negated: false }, 0);
    }
}

/** The search terms of text, subject and body conditions outside NOT branches, for highlighting */
function searchTerms(filter, negated = false) {
    if (!filter || typeof filter !== 'object') {
        return [];
    }
    if (Array.isArray(filter.conditions)) {
        return filter.conditions.flatMap(condition => searchTerms(condition, negated !== (filter.operator === 'NOT')));
    }
    if (negated) {
        return [];
    }
    return ['text', 'subject', 'body']
        .filter(key => typeof filter[key] === 'string')
        .flatMap(key => filter[key].split(/\s+/).map(word => word.replace(/"/g, '')))
        .filter(Boolean);
}

module.exports = { buildQuery, validateFilter, searchTerms, keywordQuery, THREAD_CONDITIONS, TEXT_MATCH_CAP };
