'use strict';

const URI_REGEX = /^(?:https?|ftp|mailto):(?:[a-z0-9._~:/?#[\]@!$&'()*+,;=-]|%[a-f0-9]{2})+$/i;

function skipFoldingWhitespace(value, start) {
    let pos = start;

    while (pos < value.length) {
        if (value[pos] === ' ' || value[pos] === '\t') {
            pos++;
            continue;
        }

        if (value[pos] === '\r' && value[pos + 1] === '\n' && (value[pos + 2] === ' ' || value[pos + 2] === '\t')) {
            pos += 2;
            continue;
        }

        break;
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
                    comment: comment.trim(),
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
    let pos = skipFoldingWhitespace(value, start);

    while (value[pos] === '(') {
        const result = readComment(value, pos);
        if (!result) {
            return -1;
        }

        if (result.comment) {
            comments.push(result.comment);
        }
        pos = skipFoldingWhitespace(value, result.pos);
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
            name: comments.join(' ')
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

function parseListUnsubscribe(value) {
    const entries = [];

    for (const headerValue of [].concat(value || [])) {
        if (!headerValue) {
            continue;
        }

        const source = headerValue.toString();
        if (!source) {
            continue;
        }

        const parsed = parseHeaderValue(source);
        entries.push(
            ...(parsed || [
                {
                    address: source,
                    name: ''
                }
            ])
        );
    }

    return entries;
}

module.exports = { parseListUnsubscribe };
