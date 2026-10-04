'use strict';

// Message sources shared by the indexer tests.
//
// Synthetic cases are binary strings with explicit CRLF line endings, so the bytes are exactly what the
// comments describe. `expected` is what a byte-exact rebuild of the whole message must return: the
// CRLF-normalised source with a final CRLF appended when the source has none. Those two are the only
// canonicalisations the parser applies to well-formed and malformed input alike.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { partsOf } = require('../../lib/indexer/body-structure');

// a line break is LF with an optional CR before it, stored as CRLF. Anything else is content
const normalize = source => Buffer.from(Buffer.from(source).toString('binary').replace(/\r?\n/g, '\r\n'), 'binary');

const ensureFinalCrlf = buf => (buf.length && buf.subarray(-2).toString('binary') !== '\r\n' ? Buffer.concat([buf, Buffer.from('\r\n')]) : buf);

const expectedFor = source => ensureFinalCrlf(normalize(source));

const synthetic = {
    // RFC 2046 5.1.1: text after the close delimiter is the epilogue and must stay after it
    epilogue: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\np1\r\n--b--\r\nThis is the epilogue.\r\n',
    // the most common epilogue: a single blank line after the close delimiter
    epilogue_blank: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\np1\r\n--b--\r\n\r\n',
    // inner close delimiter directly followed by the outer delimiter, the minimal legal encoding
    nested_tight:
        'Content-Type: multipart/mixed; boundary="o"\r\n\r\n--o\r\nContent-Type: multipart/alternative; boundary="i"\r\n\r\n--i\r\nContent-Type: text/plain\r\n\r\nplain\r\n--i\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n--i--\r\n--o\r\nContent-Type: application/pdf\r\n\r\nPDF\r\n--o--\r\n',
    // same with a blank line between the inner close delimiter and the outer delimiter
    nested_blank:
        'Content-Type: multipart/mixed; boundary="o"\r\n\r\n--o\r\nContent-Type: multipart/alternative; boundary="i"\r\n\r\n--i\r\nContent-Type: text/plain\r\n\r\nplain\r\n--i\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n--i--\r\n\r\n--o\r\nContent-Type: application/pdf\r\n\r\nPDF\r\n--o--\r\n',
    // RFC 2046 5.1: a body part may have no header fields at all
    headerless_part: 'Content-Type: multipart/mixed; boundary="d"\r\n\r\n--d\r\n\r\nplain text\r\n--d--\r\n',
    // RFC 2046 5.1.5: header-less parts of a digest are message/rfc822
    digest: 'Content-Type: multipart/digest; boundary="d"\r\n\r\n--d\r\n\r\nFrom: inner@x.y\r\nSubject: inner\r\n\r\nbody\r\n--d--\r\n',
    // header, separator, no body
    header_only: 'From: a@b.c\r\nSubject: s\r\n\r\n',
    // RFC 5322 3.5: the separator is optional when there is no body
    header_only_nosep: 'From: a@b.c\r\nSubject: s\r\n',
    // empty part with a separator line
    empty_part_blank:
        'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\np2\r\n--b--\r\n',
    // empty part without a separator line: the CRLF after the header belongs to the delimiter
    empty_part_noblank: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\np2\r\n--b--\r\n',
    // RFC 2046 5.1.1: receivers must accept transport padding after the boundary
    transport_padding: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b  \r\nContent-Type: text/plain\r\n\r\np1\r\n--b-- \r\n',
    // multipart without a boundary parameter is not a multipart
    no_boundary_param: 'Content-Type: multipart/mixed\r\n\r\nbody\r\n',
    // boundary declared but never used
    boundary_never_appears: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\nbody\r\n',
    preamble: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\npreamble\r\n--b\r\nContent-Type: text/plain\r\n\r\np1\r\n--b--\r\n',
    // a preamble that is a single blank line, as produced by several ESPs (see append.eml)
    preamble_blank_line: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\np1\r\n--b--\r\n',
    text_no_final_crlf: 'From: a@b.c\r\n\r\nl1\r\nl2\r\nl3',
    text_final_crlf: 'From: a@b.c\r\n\r\nl1\r\nl2\r\nl3\r\n',
    text_trailing_blank: 'From: a@b.c\r\n\r\nl1\r\n\r\n',
    // top-level message/rfc822 whose embedded message is a multipart
    root_rfc822:
        'Content-Type: message/rfc822\r\n\r\nContent-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\np1\r\n--x\r\nContent-Type: text/html\r\n\r\n<p>p2</p>\r\n--x--\r\n',
    // RFC 2045 5.1 and 6.1: type, subtype and encoding values are not case sensitive
    attached_rfc822_upper:
        'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\np1\r\n--b\r\nContent-Type: Message/RFC822\r\nContent-Transfer-Encoding: 7BIT\r\n\r\nFrom: inner@x.y\r\nSubject: inner subj\r\n\r\ninner body\r\n--b--\r\n',
    attached_rfc822: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\np1\r\n--b\r\nContent-Type: message/rfc822\r\n\r\nFrom: inner@x.y\r\nSubject: inner subj\r\n\r\ninner body\r\n--b--\r\n',
    // truncated in transport: no close delimiter at all
    missing_close: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\np1\r\n',
    // a part whose header lines are directly followed by the next delimiter, without a blank line and
    // without a line break of its own (RFC 2046 5.1.1 wants one before every delimiter)
    bare_part: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n--b\r\nContent-Type: text/plain\r\n\r\np2\r\n--b--\r\n',
    // two delimiters in a row: a part with nothing in it at all
    empty_bare_part: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\n--b\r\nContent-Type: text/plain\r\n\r\np2\r\n--b--\r\n',
    // a close delimiter without any part, after a preamble
    preamble_then_close: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\npre\r\n--b--\r\n',
    // lines that look like the own delimiter after the close delimiter are epilogue text
    delimiters_in_epilogue: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\np1\r\n--b--\r\n--b\r\nagain\r\n--b--\r\n',
    // a bare CR is content, not a line break
    bare_cr: 'From: a@b.c\r\n\r\nl1\rstill l1\r\nl2\r\n',
    // LF only input is normalised to CRLF
    lf_only: 'Content-Type: multipart/mixed; boundary="b"\n\n--b\nContent-Type: text/plain\n\np1\n--b--\n',
    // part bodies may legitimately end with a blank line, which stays part of the body
    part_trailing_blank: 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\np1\r\n\r\n--b--\r\n'
};

const cases = {};

for (let file of fs.readdirSync(__dirname).sort()) {
    if (!file.endsWith('.eml')) {
        continue;
    }
    let source = fs.readFileSync(path.join(__dirname, file));
    cases['fixture:' + file] = { name: 'fixture:' + file, source, expected: expectedFor(source) };
}

for (let key of Object.keys(synthetic)) {
    let source = Buffer.from(synthetic[key], 'binary');
    cases['synthetic:' + key] = { name: 'synthetic:' + key, source, expected: expectedFor(source) };
}

/**
 * Lists every stream-producing selector of a parsed tree: BODY[], BODY[TEXT], BODY[n] for every part
 * at every depth, and BODY[n.TEXT] for message/rfc822 parts.
 *
 * @param {Object} tree Parsed MIME tree
 * @returns {Array} selector descriptors `{ key, path, type }`
 */
function listSelectors(tree) {
    let selectors = [
        { key: '', path: '', type: '' },
        { key: 'text', path: '', type: 'text' }
    ];

    let walk = (node, prefix) => {
        let children = (node.message && partsOf(node.message)) || partsOf(node) || [];
        if (node.message && !prefix) {
            // RFC 3501 6.4.5: a top-level message/rfc822 message is part 1, its parts are 1.n
            prefix = '1';
        }
        children.forEach((child, i) => {
            let p = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
            selectors.push({ key: p, path: p, type: '' });
            if (child.message) {
                selectors.push({ key: `${p}.text`, path: p, type: 'text' });
            }
            walk(child, p);
        });
    };
    walk(tree, '');

    return selectors;
}

/**
 * Runs a selector against a tree the way `getQueryResponse()` does for FETCH
 */
function runSelector(indexer, tree, selector, options) {
    if (!selector.path) {
        return indexer.getContents(tree, selector.type ? { type: selector.type } : false, options);
    }
    return indexer.getContents(tree, { path: selector.path, type: selector.type }, options);
}

function collect(stream) {
    return new Promise((resolve, reject) => {
        let chunks = [];
        stream.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.once('error', reject);
        stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
}

/**
 * Resolves a getContents() result to `{ size, bytes }`
 */
async function materialize(result) {
    if (result && result.type === 'stream') {
        let bytes = await collect(result.value);
        return { size: result.expectedLength, bytes };
    }
    let bytes = Buffer.from((result || '').toString(), 'binary');
    return { size: bytes.length, bytes };
}

/**
 * Sends a stream result through the IMAP literal path (compile-stream and LengthLimiter) and returns the
 * announced octet count, the literal bytes and every length correction the limiter had to make
 */
async function wireLiteral(compileStream, result, options) {
    let node = { type: 'LITERAL', value: result.value, expectedLength: result.expectedLength };
    if (options && (options.startFrom || options.maxLength)) {
        node.startFrom = options.startFrom || 0;
        node.maxLength = options.maxLength || 0;
    }
    let output = compileStream({ tag: '*', command: '1 FETCH', attributes: [node] });
    let mismatches = [];
    output.on('literalMismatch', info => mismatches.push(info));
    let out = await collect(output);
    let match = out.toString('binary').match(/^\* 1 FETCH \{(\d+)\}\r\n/);
    return { announced: Number(match[1]), bytes: out.subarray(match[0].length), mismatches };
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// JSON helpers for trees: Buffers travel as `{ "$buffer": "<base64>" }`
const treeReplacer = (key, value) => (value && value.type === 'Buffer' && Array.isArray(value.data) ? { $buffer: Buffer.from(value.data).toString('base64') } : value);
const treeReviver = (key, value) => (value && typeof value === 'object' && typeof value.$buffer === 'string' ? Buffer.from(value.$buffer, 'base64') : value);

module.exports = { cases, normalize, ensureFinalCrlf, listSelectors, runSelector, collect, materialize, wireLiteral, sha256, treeReplacer, treeReviver };
