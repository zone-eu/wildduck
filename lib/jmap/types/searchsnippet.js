'use strict';

// SearchSnippet/get (RFC 8621 5): the subject and a part of the body with the search terms of a filter
// marked. The body text is the plain text stored with the message (its first part), escaped for HTML.

const he = require('he');
const { URN } = require('../capabilities');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments } = require('./common');
const { validateFilter, searchTerms } = require('../email-search');
const { messagesByEmailId } = require('./email');

const PREVIEW_LENGTH = 255;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// marks every term in a text and escapes the rest for HTML; null when no term occurs
function highlight(text, pattern) {
    if (!text || !pattern) {
        return null;
    }
    pattern.lastIndex = 0;
    if (!pattern.test(text)) {
        return null;
    }
    pattern.lastIndex = 0;
    let result = '';
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        result += he.escape(text.slice(last, match.index)) + '<mark>' + he.escape(match[0]) + '</mark>';
        last = match.index + match[0].length;
    }
    return result + he.escape(text.slice(last));
}

// a window of the body around the first match
function previewOf(text, pattern) {
    if (!text || !pattern) {
        return null;
    }
    const flat = text.replace(/\s+/g, ' ').trim();
    pattern.lastIndex = 0;
    const match = pattern.exec(flat);
    if (!match) {
        return null;
    }
    const start = Math.max(0, match.index - 60);
    return highlight(flat.slice(start, start + PREVIEW_LENGTH), new RegExp(pattern.source, 'gi'));
}

async function get(args, context) {
    checkArguments(args, ['accountId', 'filter', 'emailIds']);
    requireAccount(args, context);
    if (!Array.isArray(args.emailIds) || !args.emailIds.every(id => typeof id === 'string')) {
        throw invalidArguments('emailIds must be a list of Email ids');
    }
    if (args.emailIds.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    validateFilter(args.filter);
    const terms = searchTerms(args.filter);
    const pattern = terms.length ? new RegExp(terms.map(escapeRegex).join('|'), 'gi') : null;

    const ids = [...new Set(args.emailIds)];
    const docs = await messagesByEmailId(context, ids, { _id: true, root: true, subject: true, text: true, undeleted: true });
    const list = [];
    const notFound = [];
    for (const id of ids) {
        const doc = docs.get(id);
        if (!doc) {
            notFound.push(id);
            continue;
        }
        list.push({ emailId: id, subject: highlight(doc.subject || '', pattern), preview: previewOf(doc.text || '', pattern) });
    }
    return { accountId: context.account.id, list, notFound };
}

module.exports = { capability: URN.mail, methods: { 'SearchSnippet/get': get } };
