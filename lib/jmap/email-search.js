'use strict';

// Email/query filters as MongoDB queries (RFC 8621 4.4.1).
//
// Every query is limited to the account's visible messages ({user, undeleted: true}). Text conditions
// use the fulltext index, which MongoDB allows only once and only at the root of a query: the first
// text condition on a plain AND path goes into the query itself, others run as separate, capped
// queries whose ids are substituted (the same approach as IMAP SEARCH in lib/handlers/on-search.js).
//
// String conditions are split into tokens that must all be present; a quoted part is a phrase. Header
// conditions match the decoded header values case and diacritic insensitively. Mail in hidden mailboxes
// is never matched, and a mailbox id in a filter must name a visible mailbox of the account.

const { ObjectId } = require('mongodb');
const { parseId } = require('./ids');
const { MethodError, invalidArguments } = require('./errors');
const consts = require('../consts');
const { decodeWords } = require('./email-headers');
const { visibleQuery } = require('./visibility');
const { loadMailboxes } = require('./types/mailbox');

const MAX_DEPTH = 10;
const MAX_CONDITIONS = 100;
// matches of a text condition that is not at the root of the query, substituted as an id list
const TEXT_MATCH_CAP = 10000;
// candidates of a value condition on a header WildDuck does not index, checked after decoding
const HEADER_MATCH_CAP = 10000;
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

// like tools.escapeRegexStr, but valid in a unicode (u flag) pattern, where "\-" is a syntax error.
// A NUL is written as \x00: MongoDB refuses a pattern that holds a raw one
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\\0]/g, char => (char === '\0' ? '\\x00' : '\\' + char));
const KEYWORD = /^[\x21-\x7e]{1,255}$/;
// RFC 5322 field name: printable US-ASCII except the colon
const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]{1,255}$/;
// headers copied into the indexed headers array (lowercase, decoded), see MessageHandler.generateIndexedHeaders
const INDEXED_HEADERS = new Set(consts.INDEXED_HEADERS);
// a token must start a word in the body text, as in the text index
const WORD_START = '(?<![\\p{L}\\p{N}])';
const COMBINING_MARKS = /[\u0300-\u036f]/g;

// latin base letter -> character class with its accented forms, so header matching folds diacritics like the text index
const FOLDED = (() => {
    const variants = {};
    for (let code = 0xc0; code <= 0x24f; code++) {
        const char = String.fromCodePoint(code);
        const base = char.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
        if (/^[a-z]$/.test(base) && base !== char.toLowerCase()) {
            (variants[base] = variants[base] || new Set([base, base.toUpperCase()])).add(char);
        }
    }
    return Object.fromEntries(Object.entries(variants).map(([base, set]) => [base, `[${[...set].join('')}]`]));
})();

/** A regular expression source matching the term case and diacritic insensitively (with the i flag) */
function foldedPattern(term) {
    return [...term.normalize('NFD').replace(COMBINING_MARKS, '').replace(/\s+/g, ' ').toLowerCase()]
        .map(char => (/\s/.test(char) ? '\\s+' : FOLDED[char] || escapeRegex(char)))
        .join('');
}

/**
 * Splits a search string into tokens. A part in double or single quotes is a phrase, where a backslash
 * escapes the next character; an unbalanced quote is an ordinary character.
 *
 * @returns {{text: String, phrase: Boolean}[]}
 */
function tokenize(value) {
    const tokens = [];
    let pos = 0;
    while (pos < value.length) {
        if (/\s/.test(value[pos])) {
            pos++;
            continue;
        }
        const quote = value[pos];
        if (quote === '"' || quote === "'") {
            let text = '';
            let end = pos + 1;
            for (; end < value.length && value[end] !== quote; end++) {
                if (value[end] === '\\' && end + 1 < value.length) {
                    end++;
                }
                text += value[end];
            }
            if (end < value.length) {
                text = text.trim().replace(/\s+/g, ' ');
                if (text) {
                    tokens.push({ text, phrase: true });
                }
                pos = end + 1;
                continue;
            }
        }
        let end = pos;
        while (end < value.length && !/\s/.test(value[end])) {
            end++;
        }
        tokens.push({ text: value.slice(pos, end), phrase: false });
        pos = end;
    }
    return tokens;
}

/** The $text search string for tokens: every token is a quoted phrase, so all must match. Null when nothing is left */
function textSearch(tokens) {
    const search = tokens
        .map(token => (token.phrase ? token.text.replace(/"/g, ' ').trim() : token.text.replace(/"/g, '').replace(/^-+/, '')))
        .filter(Boolean)
        .map(term => `"${term}"`)
        .join(' ');
    return search || null;
}

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

function stringValue(value, name) {
    if (typeof value !== 'string') {
        throw invalidArguments(`${name} must be a string`);
    }
    return value;
}

/**
 * A header condition: the field exists and, when tokens are given, one instance of it contains all of them.
 * Headers outside the indexed set are read from the parsed MIME header; a value condition on them is
 * resolved later (see resolveHeader), as their values are stored without decoding.
 */
function headerQuery(name, value, state) {
    const tokens = value === undefined ? [] : tokenize(value);
    if (INDEXED_HEADERS.has(name)) {
        if (!tokens.length) {
            return { 'headers.key': name };
        }
        const $and = tokens.map(token => ({ value: { $regex: foldedPattern(token.text), $options: 'i' } }));
        return { headers: { $elemMatch: { key: name, $and } } };
    }
    // parse-mime-tree.js keeps only these field names in parsedHeader, and "." or "$" can not be part of a field path
    if (!/^[a-z0-9*-]+$/.test(name)) {
        return MATCH_NOTHING;
    }
    if (!tokens.length) {
        return { [`mimeTree.parsedHeader.${name}`]: { $exists: true } };
    }
    state.headers.push({ name, tokens });
    return { _headerPlaceholder: state.headers.length - 1 };
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
    if (depth > MAX_DEPTH || (!('operator' in filter) && ++state.count > MAX_CONDITIONS)) {
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
    const tokens = tokenize(stringValue(value, field));
    // every token must match: quoted terms are ANDed by MongoDB text search, a leading minus is not a negation
    const search = textSearch(tokens);
    if (!search) {
        return {};
    }
    // the text index covers headers and body text, so a body condition also matches the stored text itself
    const extra = field === 'body' ? { $and: tokens.map(token => ({ text: { $regex: WORD_START + foldedPattern(token.text), $options: 'i' } })) } : {};
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
            case 'inMailbox':
                parts.push({ mailbox: mailboxId(value, state, key) });
                break;
            case 'inMailboxOtherThan':
                if (!Array.isArray(value)) {
                    throw invalidArguments('inMailboxOtherThan must be a list of ids');
                }
                parts.push({ mailbox: { $nin: value.map(id => mailboxId(id, state, key)) } });
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
                parts.push(headerQuery(key, stringValue(value, key), state));
                break;
            case 'header':
                if (
                    !Array.isArray(value) ||
                    value.length < 1 ||
                    value.length > 2 ||
                    !value.every(item => typeof item === 'string') ||
                    !FIELD_NAME.test(value[0])
                ) {
                    throw invalidArguments('header must be [name] or [name, value]');
                }
                parts.push(headerQuery(value[0].toLowerCase(), value[1], state));
                break;
            default:
                // thread keyword conditions, see threadConditions()
                if (typeof value !== 'string') {
                    throw invalidArguments(`${key} must be a keyword`);
                }
                parts.push({ _threadKeyword: { kind: key, keyword: value } });
        }
    }
    if (!parts.length) {
        // a condition without properties matches every email
        return {};
    }
    return parts.length === 1 ? parts[0] : { $and: parts };
}

/** A mailbox id of the filter; unknown and hidden mailboxes are invalid (once the mailboxes are known) */
function mailboxId(value, state, key) {
    const mailbox = parseId('mailbox', value);
    if (!mailbox || (state.mailboxes && !state.mailboxes.byId.has(mailbox.toString()))) {
        throw invalidArguments(`${key} names an unknown mailbox`);
    }
    return mailbox;
}

/** Ids of the messages where one instance of an unindexed header contains every token after decoding */
async function resolveHeader(context, { name, tokens }, maxTimeMS) {
    const field = `mimeTree.parsedHeader.${name}`;
    const patterns = tokens.map(token => foldedPattern(token.text));
    // a raw value matches directly, or holds encoded words that are decoded here
    const docs = await context.deps.database
        .collection('messages')
        .find(
            Object.assign(await visibleQuery(context), {
                $or: [{ [field]: { $regex: patterns[0], $options: 'i' } }, { [field]: { $regex: '=\\?' } }]
            }),
            { projection: { _id: true, [field]: true } }
        )
        .limit(HEADER_MATCH_CAP)
        .maxTimeMS(maxTimeMS)
        .toArray();
    const regexes = patterns.map(pattern => new RegExp(pattern, 'iu'));
    const matching = docs.filter(doc =>
        [].concat(doc.mimeTree.parsedHeader[name]).some(value => {
            const decoded = decodeWords(typeof value === 'string' ? value : String((value && value.value) || ''));
            return regexes.every(regex => regex.test(decoded));
        })
    );
    return { _id: { $in: matching.map(doc => doc._id) } };
}

/**
 * Ids of the threads that have a visible message with (present true) or without the keyword. Shared by
 * the thread keyword filters and sorts.
 */
async function threadsWithKeyword(context, keyword, present, maxTimeMS = consts.DB_MAX_TIME_MESSAGES_SEARCH * 3) {
    const query = Object.assign(await visibleQuery(context), keywordQuery(keyword, present));
    return context.deps.database.collection('messages').distinct('thread', query, { maxTimeMS });
}

/** Thread keyword conditions as thread id lists */
async function threadKeywordQuery(context, kind, keyword) {
    if (kind === 'someInThreadHaveKeyword') {
        return { thread: { $in: await threadsWithKeyword(context, keyword, true) } };
    }
    if (kind === 'noneInThreadHaveKeyword') {
        return { thread: { $nin: await threadsWithKeyword(context, keyword, true) } };
    }
    // allInThreadHaveKeyword: no message of the thread lacks the keyword
    return { thread: { $nin: await threadsWithKeyword(context, keyword, false) } };
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
            .maxTimeMS(state.maxTimeMS)
            .toArray();
        return { _id: { $in: ids.map(doc => doc._id) } };
    }
    if ('_headerPlaceholder' in node) {
        return resolveHeader(context, state.headers[node._headerPlaceholder], state.maxTimeMS);
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
async function buildQuery(filter, context, options = {}) {
    const mailboxes = await loadMailboxes(context);
    const maxTimeMS = options.maxTimeMS || consts.DB_MAX_TIME_MESSAGES_SEARCH * 3;
    const state = { texts: [], headers: [], count: 0, rootText: null, mailboxes, maxTimeMS };
    const compiled = filter === undefined || filter === null ? {} : compile(filter, state, { plain: true, negated: false }, 0);
    const resolved = await resolvePlaceholders(compiled, context, state);
    const query = await visibleQuery(context);
    if (state.rootText) {
        query.searchable = true;
        query.$text = { $search: state.rootText };
    }
    return Object.keys(resolved).length ? Object.assign(query, { $and: [resolved] }) : query;
}

/** Validates a filter the way Email/query does, without running anything */
function validateFilter(filter) {
    if (filter !== undefined && filter !== null) {
        compile(filter, { texts: [], headers: [], count: 0, rootText: null }, { plain: true, negated: false }, 0);
    }
}

module.exports = {
    buildQuery,
    validateFilter,
    keywordQuery,
    threadsWithKeyword,
    tokenize,
    textSearch,
    foldedPattern,
    THREAD_CONDITIONS,
    TEXT_MATCH_CAP,
    MAX_DEPTH,
    MAX_CONDITIONS
};
