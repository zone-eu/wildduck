'use strict';

// Strict JSON for request bodies (RFC 8620 3.1 requires I-JSON, RFC 7493): valid UTF-8, no duplicate
// member names, and a bounded nesting depth so a hostile body can not exhaust the stack. One linear
// scan checks the structure before JSON.parse does the actual parsing.

const MAX_DEPTH = 64;
const decoder = new TextDecoder('utf-8', { fatal: true });

class JsonError extends Error {}

// Index after the closing quote of the string starting at `start` (which holds the opening quote)
function stringEnd(text, start) {
    for (let i = start + 1; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 92) {
            // backslash: skip the escaped character
            i++;
        } else if (ch === 34) {
            return i + 1;
        }
    }
    throw new JsonError('unterminated string');
}

function checkStructure(text) {
    const stack = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const top = stack[stack.length - 1];
        if (ch === '"') {
            const end = stringEnd(text, i);
            if (top && top.keys && top.expectKey) {
                const key = JSON.parse(text.slice(i, end));
                if (top.keys.has(key)) {
                    throw new JsonError(`duplicate member name "${key}"`);
                }
                top.keys.add(key);
                top.expectKey = false;
            }
            i = end - 1;
        } else if (ch === '{' || ch === '[') {
            stack.push(ch === '{' ? { keys: new Set(), expectKey: true } : {});
            if (stack.length > MAX_DEPTH) {
                throw new JsonError(`nesting deeper than ${MAX_DEPTH}`);
            }
        } else if (ch === '}' || ch === ']') {
            stack.pop();
        } else if (ch === ',' && top && top.keys) {
            top.expectKey = true;
        }
    }
}

/**
 * Parses a request body.
 *
 * @param {Buffer} buffer
 * @returns {*} The parsed value
 * @throws {JsonError} For invalid UTF-8, invalid JSON, duplicate member names or excessive nesting
 */
function parseStrict(buffer) {
    let text;
    try {
        text = decoder.decode(buffer);
    } catch {
        throw new JsonError('the body is not valid UTF-8');
    }
    checkStructure(text);
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new JsonError(err.message);
    }
}

module.exports = { parseStrict, JsonError, MAX_DEPTH };
