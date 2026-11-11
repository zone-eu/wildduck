'use strict';

// SearchSnippet/get (RFC 8621 5): the subject and a part of the body with the search terms of a filter
// marked. The body text is the plain text stored with the message, escaped for HTML.
//
// Terms are matched ignoring case and diacritics (as the fulltext index does), a quoted phrase only as a
// whole, and marks always cover whole grapheme clusters. text terms mark both fields, subject terms only
// the subject and body terms only the preview; terms under a NOT are never marked.

const { URN } = require('../capabilities');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments } = require('./common');
const { validateFilter } = require('../email-search');
const { messagesByEmailId } = require('./email');

// RFC 8621 5: the preview is at most 255 octets
const PREVIEW_BYTES = 255;
// characters of context shown before the first match
const PREVIEW_CONTEXT = 40;
// body text read per message: the indexed start plus this much of the rest
const BODY_FOOTER_CHARS = 15 * 1024;

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const escapeHtml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Folds a string for matching: lower case, no combining marks, white space runs as one space. Answers
 * the folded string and, for every UTF-16 unit of it, the index of the source code point.
 */
function fold(value) {
    let folded = '';
    const map = [];
    let space = false;
    for (let i = 0; i < value.length;) {
        const char = String.fromCodePoint(value.codePointAt(i));
        if (/\s/.test(char)) {
            if (!space) {
                folded += ' ';
                map.push(i);
            }
            space = true;
        } else {
            space = false;
            const base = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
            for (let k = 0; k < base.length; k++) {
                folded += base[k];
                map.push(i);
            }
        }
        i += char.length;
    }
    return { folded, map };
}

/** Splits a search string into folded words and quoted phrases */
function parseTerms(value) {
    const terms = [];
    const pattern = /"([^"]*)"|(\S+)/g;
    let match;
    while ((match = pattern.exec(value))) {
        const term = fold((match[1] !== undefined ? match[1] : match[2]).replace(/"/g, '')).folded.trim();
        if (term) {
            terms.push(term);
        }
    }
    return terms;
}

/** The terms to mark in the subject and in the body, from conditions outside NOT branches */
function collectTerms(filter, terms = { subject: [], body: [] }, negated = false) {
    if (!filter || typeof filter !== 'object') {
        return terms;
    }
    if (Array.isArray(filter.conditions)) {
        for (const condition of filter.conditions) {
            collectTerms(condition, terms, negated !== (filter.operator === 'NOT'));
        }
        return terms;
    }
    if (negated) {
        return terms;
    }
    for (const [key, fields] of [
        ['text', ['subject', 'body']],
        ['subject', ['subject']],
        ['body', ['body']]
    ]) {
        if (typeof filter[key] === 'string') {
            const parsed = parseTerms(filter[key]);
            for (const field of fields) {
                terms[field].push(...parsed);
            }
        }
    }
    return terms;
}

/** Source ranges [start, end) of every term occurrence; a term that starts with a letter or digit must start a word */
function findMatches(value, terms) {
    const { folded, map } = fold(value);
    const ranges = [];
    for (const term of terms) {
        const wordStart = /^[a-z0-9]/.test(term);
        for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + 1)) {
            if (wordStart && at > 0 && /[\p{L}\p{N}]/u.test(folded[at - 1])) {
                continue;
            }
            const last = map[at + term.length - 1];
            ranges.push([map[at], last + String.fromCodePoint(value.codePointAt(last)).length]);
        }
    }
    return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * Escapes a text for HTML with every grapheme cluster that overlaps a match inside mark tags.
 *
 * @param {String} value
 * @param {Array} ranges From findMatches()
 * @param {Number} [maxBytes] Stop before the output (closing tag included) would be longer
 */
function render(value, ranges, maxBytes = Infinity) {
    let result = '';
    let bytes = 0;
    let marked = false;
    let next = 0;
    for (const { segment, index } of graphemes.segment(value)) {
        const end = index + segment.length;
        while (next < ranges.length && ranges[next][1] <= index) {
            next++;
        }
        const inMatch = next < ranges.length && ranges[next][0] < end;
        const piece = (inMatch && !marked ? '<mark>' : '') + (!inMatch && marked ? '</mark>' : '') + escapeHtml(segment);
        const pieceBytes = Buffer.byteLength(piece);
        if (bytes + pieceBytes + (inMatch ? 7 : 0) > maxBytes) {
            break;
        }
        result += piece;
        bytes += pieceBytes;
        marked = inMatch;
    }
    return marked ? result + '</mark>' : result;
}

function subjectSnippet(subject, terms) {
    if (!subject || !terms.length) {
        return null;
    }
    const ranges = findMatches(subject, terms);
    return ranges.length ? render(subject, ranges) : null;
}

function previewSnippet(text, terms) {
    if (!text || !terms.length) {
        return null;
    }
    const flat = text.replace(/\s+/g, ' ').trim();
    const ranges = findMatches(flat, terms);
    if (!ranges.length) {
        return null;
    }
    // a window that starts a little before the first match; a cluster cut at its start is dropped
    let start = Math.max(0, ranges[0][0] - PREVIEW_CONTEXT);
    if (start > 0) {
        const space = flat.indexOf(' ', start);
        start = space >= 0 && space < ranges[0][0] ? space + 1 : start;
        const lead = flat.slice(Math.max(0, start - 8), ranges[0][0] + 1);
        for (const { index } of graphemes.segment(lead)) {
            const at = Math.max(0, start - 8) + index;
            if (at >= start) {
                start = at;
                break;
            }
        }
    }
    const windowText = flat.slice(start, start + PREVIEW_BYTES + 8);
    return render(windowText, findMatches(windowText, terms), PREVIEW_BYTES) || null;
}

async function get(args, context) {
    checkArguments(args, ['accountId', 'filter', 'emailIds']);
    requireAccount(args, context);
    if (!Array.isArray(args.emailIds) || !args.emailIds.every(id => typeof id === 'string')) {
        throw invalidArguments('emailIds must be a list of Email ids');
    }
    // the filter has no default (RFC 8621 5.1), null is an explicit "no filter"
    if (!('filter' in args)) {
        throw invalidArguments('filter is required');
    }
    if (args.emailIds.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    validateFilter(args.filter);
    const terms = collectTerms(args.filter);

    const ids = [...new Set(args.emailIds)];
    const projection = { _id: true, root: true, undeleted: true };
    if (terms.subject.length) {
        projection.subject = true;
    }
    if (terms.body.length) {
        projection.text = true;
        projection.textFooter = { $substrCP: [{ $ifNull: ['$textFooter', ''] }, 0, BODY_FOOTER_CHARS] };
    }
    const docs = await messagesByEmailId(context, ids, projection);
    const list = [];
    const notFound = [];
    for (const id of ids) {
        const doc = docs.get(id);
        if (!doc) {
            notFound.push(id);
            continue;
        }
        list.push({
            emailId: id,
            subject: subjectSnippet(doc.subject, terms.subject),
            preview: previewSnippet((doc.text || '') + (doc.textFooter || ''), terms.body)
        });
    }
    return { accountId: context.account.id, list, notFound: notFound.length ? notFound : null };
}

module.exports = {
    capability: URN.mail,
    methods: { 'SearchSnippet/get': get },
    // exposed for unit tests
    collectTerms,
    findMatches,
    render,
    previewSnippet,
    subjectSnippet
};
