'use strict';

// Strict JSON for request bodies (RFC 8620 3.1 requires I-JSON, RFC 7493): valid UTF-8, no duplicate
// member names, and a bounded nesting depth so a hostile body can not exhaust the stack. One linear
// scan checks the structure before JSON.parse does the actual parsing.

const MAX_DEPTH = 64;
const decoder = new TextDecoder('utf-8', { fatal: true });

class JsonError extends Error {}

const isHigh = code => code >= 0xd800 && code <= 0xdbff;
const isLow = code => code >= 0xdc00 && code <= 0xdfff;

// The UTF-16 code unit of a \uXXXX escape at `index` (which holds the backslash), or -1
function escapedUnit(text, index) {
    if (text[index] !== '\\' || text[index + 1] !== 'u') {
        return -1;
    }
    const hex = text.slice(index + 2, index + 6);
    return /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : -1;
}

// Index after the closing quote of the string starting at `start` (which holds the opening quote).
// Rejects \u escapes that leave a surrogate unpaired (RFC 7493 2.1); raw text is valid UTF-8 already.
function stringEnd(text, start) {
    for (let i = start + 1; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 92) {
            const unit = escapedUnit(text, i);
            if (isHigh(unit) && isLow(escapedUnit(text, i + 6))) {
                i += 11;
            } else if (isHigh(unit) || isLow(unit)) {
                throw new JsonError('unpaired surrogate in a string');
            } else {
                // skip the escaped character
                i++;
            }
        } else if (ch === 34) {
            return i + 1;
        }
    }
    throw new JsonError('unterminated string');
}

function parseKey(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new JsonError(err.message);
    }
}

function checkStructure(text) {
    const stack = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const top = stack[stack.length - 1];
        if (ch === '"') {
            const end = stringEnd(text, i);
            if (top && top.keys && top.expectKey) {
                const key = parseKey(text.slice(i, end));
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
