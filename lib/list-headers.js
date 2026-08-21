'use strict';

const libmime = require('libmime');

// RFC 2369 allows any URI scheme inside the angle brackets, so only require a generic
// scheme prefix and reject whitespace, angle brackets and control characters
const URI_REGEX = /^[a-z][a-z0-9+.-]*:[^\s<>]+$/i;

// unfold and trim a header value, repeated header values are stored without unfolding
function unfoldValue(value) {
    return value
        .toString()
        .replace(/\s*\r?\n\s*/g, ' ')
        .trim();
}

// decode encoded words in a display name, keep the value as is on failure
function decodeDisplayName(name) {
    if (name.indexOf('=?') >= 0) {
        try {
            name = libmime.decodeWords(name);
        } catch (err) {
            // ignore, keep as is
        }
    }
    return name;
}

function skipWhitespace(value, start) {
    let pos = start;

    while (pos < value.length && (value[pos] === ' ' || value[pos] === '\t')) {
        pos++;
    }

    return pos;
}

function readComment(value, start) {
    let depth = 0;
    let comment = '';

    for (let pos = start; pos < value.length; pos++) {
        const chr = value[pos];

        if (chr === '\\' && pos + 1 < value.length) {
            comment += value[++pos];
            continue;
        }

        if (chr === '(') {
            if (depth) {
                comment += chr;
            }
            depth++;
            continue;
        }

        if (chr === ')') {
            depth--;
            if (!depth) {
                return {
                    comment: comment.replace(/\s+/g, ' ').trim(),
                    pos: pos + 1
                };
            }
            comment += chr;
            continue;
        }

        comment += chr;
    }

    return false;
}

function readComments(value, start, comments) {
    let pos = skipWhitespace(value, start);

    while (value[pos] === '(') {
        const result = readComment(value, pos);
        if (!result) {
            return -1;
        }

        if (result.comment) {
            comments.push(result.comment);
        }
        pos = skipWhitespace(value, result.pos);
    }

    return pos;
}

function parseHeaderValue(value) {
    const entries = [];
    let pos = 0;

    while (pos < value.length) {
        const comments = [];
        pos = readComments(value, pos, comments);

        if (pos < 0 || value[pos] !== '<') {
            return false;
        }

        const end = value.indexOf('>', pos + 1);
        if (end < 0) {
            return false;
        }

        const address = value.slice(pos + 1, end);
        if (!URI_REGEX.test(address)) {
            return false;
        }

        pos = readComments(value, end + 1, comments);
        if (pos < 0) {
            return false;
        }

        entries.push({
            address,
            name: decodeDisplayName(comments.join(' '))
        });

        if (pos === value.length) {
            return entries;
        }

        if (value[pos] !== ',') {
            return false;
        }
        pos++;
    }

    return false;
}

// last resort scan for valid <URI> segments inside an otherwise malformed value
function salvageUris(value) {
    const entries = [];

    const re = /<([^<>]+)>/g;
    let match;
    while ((match = re.exec(value))) {
        if (URI_REGEX.test(match[1])) {
            entries.push({
                address: match[1],
                name: ''
            });
        }
    }

    return entries;
}

function parseListUnsubscribe(value) {
    const entries = [];

    for (const headerValue of [].concat(value || [])) {
        if (!headerValue) {
            continue;
        }

        const source = unfoldValue(headerValue);
        if (!source) {
            continue;
        }

        // strict RFC 2369 parse first, then try to salvage valid <URI> entries from a malformed value
        const parsed = parseHeaderValue(source) || salvageUris(source);
        if (parsed.length) {
            entries.push(...parsed);
        } else {
            // No valid URI found. Keep the raw value as the display name, the address property
            // only ever contains a syntactically valid URI. Consumers must still restrict allowed
            // schemes before using the address as a link target
            entries.push({
                address: '',
                name: decodeDisplayName(source)
            });
        }
    }

    return entries;
}

function parseListId(value) {
    if (Array.isArray(value)) {
        // RFC 2919 allows a single List-ID header only, ignore the rest
        value = value[0];
    }

    if (!value) {
        return false;
    }

    const source = unfoldValue(value);
    if (!source) {
        return false;
    }

    // RFC 2919: optional display name (phrase) followed by "<" list-id ">"
    const match = /^([^<>]*)<([^<>\s]+)>$/.exec(source);
    if (!match) {
        // not in the expected format, keep the raw value as the display name
        return {
            address: '',
            name: decodeDisplayName(source)
        };
    }

    let name = match[1].trim();
    if (name.length > 1 && name[0] === '"' && name[name.length - 1] === '"') {
        name = name.slice(1, -1).replace(/\\(.)/g, '$1').trim();
    }

    return {
        address: match[2],
        name: decodeDisplayName(name)
    };
}

module.exports = { parseListId, parseListUnsubscribe };
