'use strict';

// Random MIME message generator for the indexer fuzz suite.
//
// generateMessage() builds a random message structure as a model (what the parser is expected to
// find), serialises it to bytes following the same grammar the v2 tree walker uses, and returns both.
// mutate() then derails a message in the ways real mail is broken, for the properties that must hold
// for any input at all. Everything is driven by a seeded generator, so a failing case is reproducible
// from its seed.

const libbase64 = require('libbase64');
const libqp = require('libqp');

/**
 * Deterministic pseudo random source (mulberry32)
 */
class Rng {
    constructor(seed) {
        this.state = seed >>> 0 || 1; // eslint-disable-line no-bitwise
    }

    next() {
        // eslint-disable-next-line no-bitwise
        let t = (this.state += 0x6d2b79f5) >>> 0;
        // eslint-disable-next-line no-bitwise
        t = Math.imul(t ^ (t >>> 15), t | 1);
        // eslint-disable-next-line no-bitwise
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        // eslint-disable-next-line no-bitwise
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    int(min, max) {
        return min + Math.floor(this.next() * (max - min + 1));
    }

    chance(probability) {
        return this.next() < probability;
    }

    pick(list) {
        return list[Math.floor(this.next() * list.length)];
    }

    bytes(length) {
        let buf = Buffer.alloc(length);
        for (let i = 0; i < length; i++) {
            buf[i] = this.int(0, 255);
        }
        return buf;
    }

    token(length, alphabet) {
        let out = '';
        for (let i = 0; i < length; i++) {
            out += alphabet.charAt(this.int(0, alphabet.length - 1));
        }
        return out;
    }
}

const ensureFinalBreak = buf => (buf.length && !buf.subarray(-2).equals(Buffer.from('\r\n')) ? Buffer.concat([buf, Buffer.from('\r\n')]) : buf);

/**
 * Makes the serialised bytes of a model end with a line break: finds the innermost entity that ends
 * them (through unterminated multiparts and embedded messages), gives it the break, and serialises every
 * enclosing message/rfc822 body again
 */
function completeTail(model) {
    let chain = [];
    let tail = model;
    for (;;) {
        if (tail.kind === 'rfc822' && tail.message) {
            chain.push(tail);
            tail = tail.message;
        } else if (tail.kind === 'multipart' && tail.children.length && tail.unterminated) {
            tail = tail.children[tail.children.length - 1];
        } else {
            break;
        }
    }
    if (tail.kind === 'multipart') {
        if (!tail.unterminated) {
            tail.epilogue = Buffer.concat([tail.epilogue || Buffer.alloc(0), Buffer.from('\r\n')]);
        }
    } else if (tail.hasBody) {
        tail.body = ensureFinalBreak(tail.body);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
        chain[i].body = serialize(chain[i].message);
    }
}

const ASCII_TEXT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?()[]<>=+-/@#$%&*_"\'';
const BOUNDARY_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'()+_,-./:=?";
const WORDS = ['tere', 'hello', 'Tõivu', '中文', 'résumé', 'Ångström', 'x', 'line', 'of', 'text', '--not-a-boundary', 'From ', '.', '=3D', '?='];

/**
 * One line of random text as bytes, never starting with "--" so it can not collide with a delimiter
 */
function textLine(rng) {
    let kind = rng.next();
    let line;
    if (kind < 0.5) {
        line = Buffer.from(rng.token(rng.int(0, 90), ASCII_TEXT), 'latin1');
    } else if (kind < 0.8) {
        let words = [];
        for (let i = rng.int(1, 8); i > 0; i--) {
            words.push(rng.pick(WORDS));
        }
        line = Buffer.from(words.join(' '));
    } else if (kind < 0.95) {
        // 8-bit bytes, NUL and a bare CR are content and survive a rebuild; LF is a line break
        line = rng.bytes(rng.int(1, 40));
        for (let i = 0; i < line.length; i++) {
            if (line[i] === 0x0a || (line[i] === 0x0d && (i === line.length - 1 || line[i + 1] === 0x0a))) {
                line[i] = 0x20;
            }
        }
    } else {
        line = Buffer.from('x'.repeat(rng.int(900, 2000)));
    }
    if (line.length >= 2 && line[0] === 0x2d && line[1] === 0x2d) {
        line = Buffer.concat([Buffer.from('+'), line]);
    }
    return line;
}

/**
 * Random body text: `lines` lines joined by CRLF, optionally ending with a line break
 */
function textBody(rng, options) {
    options = options || {};
    let lines = [];
    for (let i = rng.int(options.minLines || 0, options.maxLines || 12); i > 0; i--) {
        lines.push(textLine(rng));
    }
    let body = Buffer.concat(lines.flatMap((line, i) => (i ? [Buffer.from('\r\n'), line] : [line])));
    if (lines.length && (options.finalBreak || rng.chance(0.5))) {
        body = Buffer.concat([body, Buffer.from('\r\n')]);
    }
    return body;
}

function base64Body(rng) {
    let data = rng.bytes(rng.pick([0, 1, 2, 3, 57, 58, 76, rng.int(0, 400), rng.int(0, 3000), 1140, 1083]));
    let lineLen = rng.pick([76, 76, 76, 72, 64, 998, 0]);
    let text = libbase64.encode(data);
    if (lineLen) {
        text = libbase64.wrap(text, lineLen).replace(/\r?\n/g, '\r\n');
    }
    if (rng.chance(0.1)) {
        text = text.replace(/[=]+$/, '');
    }
    if (rng.chance(0.05) && text.length > 10) {
        // a stray character the encoder would never produce, in place of a base64 character
        let pos = rng.int(0, text.length - 1);
        if (!/[\r\n]/.test(text.charAt(pos))) {
            text = text.slice(0, pos) + '*' + text.slice(pos + 1);
        }
    }
    return Buffer.from(text + '\r\n'.repeat(rng.pick([0, 0, 0, 1, 1, 2])), 'latin1');
}

function qpBody(rng) {
    let text = textBody(rng, { maxLines: 6 }).toString('latin1');
    return Buffer.from(libqp.wrap(libqp.encode(Buffer.from(text, 'latin1'))).replace(/\r?\n/g, '\r\n'), 'latin1');
}

function randomHeaderValue(rng) {
    let kind = rng.next();
    if (kind < 0.5) {
        return rng.token(rng.int(1, 40), ASCII_TEXT.replace(/[\r\n]/g, ''));
    }
    if (kind < 0.7) {
        return rng.pick(['Tõivu', '中文主题', 'résumé']);
    }
    if (kind < 0.85) {
        return '=?UTF-8?Q?T=C3=B5ivu?= =?ISO-8859-1?B?SGVsbG8=?=';
    }
    // folded value
    return rng.token(rng.int(1, 20), ASCII_TEXT) + '\r\n ' + rng.token(rng.int(1, 20), ASCII_TEXT);
}

/**
 * Builds the header lines of a node. Returns the logical lines (folded continuation included), the
 * form the parser keeps in `node.header`
 */
function headerLines(rng, contentType, encoding, options) {
    options = options || {};
    let lines = [];

    if (options.topLevel) {
        lines.push('From: ' + rng.pick(['a@b.c', 'Jüri <juri@näide.ee>', '"Quoted, Name" <q@n.ee>', 'localuser', 'Group: x@y.z, w@v.u;']));
        if (rng.chance(0.8)) {
            lines.push('To: ' + rng.pick(['to@example.com', 'undisclosed-recipients:;', 'Nobody <nobody@example.com>, other@example.com']));
        }
        if (rng.chance(0.9)) {
            lines.push('Subject: ' + randomHeaderValue(rng));
        }
        if (rng.chance(0.3)) {
            // duplicate header
            lines.push('Subject: ' + randomHeaderValue(rng));
        }
        if (rng.chance(0.8)) {
            lines.push('Date: ' + rng.pick(['Thu, 15 May 2014 13:53:30 +0000', '15 May 14 13:53 EEST', 'garbage date']));
        }
        if (rng.chance(0.5)) {
            lines.push('Message-ID: <' + rng.token(10, 'abcdef0123456789') + '@example.com>');
        }
        if (rng.chance(0.3)) {
            lines.push('X-Odd Key!: value');
        }
        if (rng.chance(0.2)) {
            lines.push('No colon on this line');
        }
        if (rng.chance(0.3)) {
            lines.push('MIME-Version: 1.0');
        }
    }

    if (contentType) {
        let params = [];
        if (contentType.params) {
            params = Object.keys(contentType.params).map(key => key + '=' + contentType.params[key]);
        }
        if (rng.chance(0.3)) {
            params.push('charset=' + rng.pick(['utf-8', '"us-ascii"', 'ISO-8859-1', '""']));
        }
        if (rng.chance(0.2)) {
            params.push('name="' + rng.pick(['a;b.txt', 'weird\\"name.txt', 'plain.txt', 'résumé.pdf']) + '"');
        }
        let value = contentType.value + (params.length ? '; ' + params.join('; ') : '');
        if (rng.chance(0.1)) {
            value += ' (comment)';
        }
        lines.push((rng.chance(0.2) ? 'content-type' : 'Content-Type') + ': ' + value);
    }
    if (encoding) {
        lines.push('Content-Transfer-Encoding: ' + (rng.chance(0.2) ? encoding.toUpperCase() : encoding) + (rng.chance(0.1) ? ' (comment)' : ''));
    }
    if (rng.chance(0.3)) {
        lines.push('Content-Disposition: ' + rng.pick(['inline', 'attachment; filename="f.bin"', "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"]));
    }
    if (rng.chance(0.2)) {
        lines.push('Content-ID: <' + rng.token(8, 'abcdef0123456789') + '@cid>');
    }
    if (rng.chance(0.1)) {
        lines.push('Content-Description: ' + randomHeaderValue(rng));
    }

    // the parser keeps header lines as binary strings, one character per byte of the UTF-8 input
    return lines.map(line => Buffer.from(line, 'utf8').toString('latin1'));
}

/**
 * Generates a random node model
 *
 * @param {Rng} rng
 * @param {Object} options `{ depth, topLevel, digest, boundaries }`
 * @returns {Object} model `{ header, contentType, hasBody, body, boundary, preamble, children, epilogue, unterminated, pad, closePad, message }`
 */
function generateNode(rng, options) {
    options = options || {};
    let depth = options.depth || 0;
    let boundaries = options.boundaries || [];

    let kinds = ['text', 'text', 'text', 'base64', 'qp', 'rfc822', 'headerless'];
    if (depth < 4) {
        kinds.push('multipart', 'multipart');
    }
    if (!options.topLevel) {
        kinds.push('nobody');
    }
    let kind = options.kind || rng.pick(kinds);

    let model = { kind, header: [], hasBody: true, children: [], pad: '', closePad: '' };

    if (kind === 'multipart') {
        let subtype = rng.pick(['mixed', 'alternative', 'related', 'digest', 'report', 'Mixed']);
        let boundary;
        do {
            boundary = rng.chance(0.3)
                ? rng.token(rng.int(1, 70), BOUNDARY_CHARS + ' ').replace(/ +$/, 'x')
                : rng.pick(['b', '----=_Part_', '=_fuzz_', 'simple boundary']) + rng.token(rng.int(1, 20), '0123456789abcdef');
        } while (boundaries.some(existing => boundary.startsWith(existing) || existing.startsWith(boundary)));
        model.boundary = boundary;
        model.contentType = { value: 'multipart/' + subtype, params: { boundary: /[^0-9a-zA-Z_.-]/.test(boundary) || rng.chance(0.5) ? `"${boundary}"` : boundary } };
        model.header = headerLines(rng, model.contentType, null, options);

        let preambleKind = rng.next();
        if (preambleKind < 0.5) {
            model.preamble = Buffer.alloc(0);
        } else if (preambleKind < 0.7) {
            model.preamble = Buffer.from('\r\n');
        } else {
            model.preamble = Buffer.concat([textBody(rng, { minLines: 1, maxLines: 3 }), Buffer.from('\r\n')]).subarray(0);
            // the preamble as stored ends with exactly one line break for its last line
            model.preamble = Buffer.from(model.preamble.toString('latin1').replace(/(\r\n)+$/, '\r\n'), 'latin1');
        }

        let count = rng.chance(0.05) ? 0 : rng.int(1, 4);
        let childBoundaries = boundaries.concat(boundary);
        for (let i = 0; i < count; i++) {
            let child = generateNode(rng, { depth: depth + 1, boundaries: childBoundaries, digest: subtype.toLowerCase() === 'digest' });
            child.pad = rng.chance(0.05) ? rng.pick([' ', '  ', '\t']) : '';
            model.children.push(child);
        }

        let last = model.children[model.children.length - 1];
        if (!count) {
            model.unterminated = true;
            model.epilogue = null;
        } else if (options.topLevel && !options.embedded && rng.chance(0.05) && last.kind !== 'multipart') {
            // the message ends with the last part, which then ends with a line break
            model.unterminated = true;
            model.epilogue = null;
            completeTail(last);
        } else {
            model.closePad = rng.chance(0.05) ? ' ' : '';
            let epilogueKind = rng.next();
            if (epilogueKind < 0.5) {
                model.epilogue = null;
            } else if (epilogueKind < 0.75) {
                model.epilogue = Buffer.from('\r\n');
            } else {
                model.epilogue = Buffer.concat([Buffer.from('\r\n'), textBody(rng, { minLines: 1, maxLines: 3 })]);
                // an epilogue line ends with its own line break only when it is the last one in the message
                model.epilogue = Buffer.from(model.epilogue.toString('latin1').replace(/(\r\n)+$/, ''), 'latin1');
            }
        }
        return model;
    }

    let finish = leaf => {
        if (options.topLevel && !options.embedded && leaf.hasBody) {
            // a top-level message ends with a line break
            leaf.body = ensureFinalBreak(leaf.body);
        }
        return leaf;
    };

    if (kind === 'rfc822') {
        let encoding = rng.pick(['7bit', '8bit', 'binary', null, 'base64', '7BIT']);
        model.contentType = { value: rng.pick(['message/rfc822', 'Message/RFC822', 'message/rfc822']) };
        model.header = headerLines(rng, model.contentType, encoding, options);
        let inner = generateNode(rng, { depth: depth + 1, boundaries, topLevel: true, embedded: true });
        let innerBytes = serialize(inner);
        if (encoding === 'base64') {
            model.body = Buffer.from(libbase64.wrap(libbase64.encode(innerBytes), 76).replace(/\r?\n/g, '\r\n'), 'latin1');
            model.message = null;
        } else {
            model.body = innerBytes;
            model.message = inner;
        }
        if (options.topLevel && !options.embedded && model.message && !model.body.subarray(-2).equals(Buffer.from('\r\n'))) {
            // the embedded message gains the final break of the outer message, so its model must too
            completeTail(model);
        }
        return finish(model);
    }

    if (kind === 'headerless') {
        // RFC 2046 5.1: no header fields at all. In a digest that is a message/rfc822 part
        model.header = [];
        if (options.digest) {
            let inner = generateNode(rng, { depth: depth + 1, boundaries, topLevel: true, embedded: true });
            model.body = serialize(inner);
            model.message = inner;
            model.contentType = { value: 'message/rfc822' };
        } else {
            model.body = textBody(rng);
            model.contentType = { value: 'text/plain' };
        }
        return finish(model);
    }

    if (kind === 'nobody') {
        model.contentType = { value: 'text/plain' };
        model.header = headerLines(rng, model.contentType, null, options);
        model.hasBody = false;
        model.body = Buffer.alloc(0);
        return model;
    }

    if (kind === 'base64') {
        model.contentType = { value: rng.pick(['application/octet-stream', 'application/pdf', 'image/png', 'text/plain']) };
        model.header = headerLines(rng, model.contentType, 'base64', options);
        model.body = base64Body(rng);
        return finish(model);
    }

    if (kind === 'qp') {
        model.contentType = { value: rng.pick(['text/plain', 'text/html']) };
        model.header = headerLines(rng, model.contentType, 'quoted-printable', options);
        model.body = qpBody(rng);
        return finish(model);
    }

    // text. Without a Content-Type header the part defaults to text/plain, except inside a digest where
    // the default is message/rfc822 (that case is the headerless kind)
    model.contentType = rng.chance(0.15) && !options.topLevel && !options.digest ? null : { value: rng.pick(['text/plain', 'text/html', 'TEXT/Plain', 'text/x-custom']) };
    model.header = headerLines(rng, model.contentType, rng.pick([null, null, '7bit', '8bit']), options);
    model.body = textBody(rng);
    return finish(model);
}

/**
 * Serialises a model to the message bytes (CRLF) following the v2 grammar:
 * entity = header-lines [ CRLF body ]; multipart body = preamble *( "--" boundary pad CRLF entity CRLF ) "--" boundary "--" closePad epilogue
 */
function serialize(model) {
    let parts = [];
    if (model.header.length) {
        parts.push(Buffer.from(model.header.join('\r\n') + '\r\n', 'latin1'));
    }
    if (!model.hasBody) {
        return Buffer.concat(parts);
    }
    parts.push(Buffer.from('\r\n'));

    if (model.kind === 'multipart') {
        parts.push(model.preamble);
        model.children.forEach((child, i) => {
            parts.push(Buffer.from('--' + model.boundary + child.pad + '\r\n', 'latin1'));
            parts.push(serialize(child));
            if (!model.unterminated || i < model.children.length - 1) {
                parts.push(Buffer.from('\r\n'));
            }
        });
        if (!model.unterminated) {
            parts.push(Buffer.from('--' + model.boundary + '--' + model.closePad, 'latin1'));
            if (model.epilogue) {
                parts.push(model.epilogue);
            }
        }
    } else {
        parts.push(model.body);
    }

    return Buffer.concat(parts);
}

/**
 * Generates a complete random message
 *
 * @param {Number} seed
 * @returns {Object} `{ seed, model, source, expected }` where `expected` is what a byte-exact rebuild returns
 */
function generateMessage(seed) {
    let rng = new Rng(seed);
    let model = generateNode(rng, { topLevel: true, depth: 0 });
    if (model.kind === 'multipart' && !model.unterminated) {
        // the message ends with a line break: the one that ends the close delimiter line, or the last
        // epilogue line
        model.epilogue = Buffer.concat([model.epilogue || Buffer.alloc(0), Buffer.from('\r\n')]);
    }
    let source = serialize(model);
    let expected = source;

    // transport variations the parser normalises: LF only line endings, a missing final line break
    let variant = rng.next();
    if (variant < 0.2) {
        source = Buffer.from(source.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    } else if (variant < 0.3 && source.length > 4 && !source.subarray(-4).equals(Buffer.from('\r\n\r\n'))) {
        // drop the final line break of a non-empty last line (an empty last line is structure)
        source = source.subarray(0, source.length - 2);
    }

    return { seed, model, source, expected };
}

/**
 * Breaks a message in ways real mail is broken. The result has no model, only the universal properties
 * (byte exact rebuild of the canonical form, consistent sizes, exact windows) apply
 */
function mutate(rng, source) {
    let bytes = Buffer.from(source);
    let text = bytes.toString('latin1');
    switch (rng.int(0, 7)) {
        case 0:
            // truncate anywhere
            return bytes.subarray(0, rng.int(0, bytes.length));
        case 1: {
            // flip random bytes
            for (let i = rng.int(1, 5); i > 0; i--) {
                bytes[rng.int(0, bytes.length - 1)] = rng.int(0, 255);
            }
            return bytes;
        }
        case 2: {
            // duplicate a random line
            let lines = text.split('\r\n');
            let i = rng.int(0, lines.length - 1);
            lines.splice(i, 0, lines[i]);
            return Buffer.from(lines.join('\r\n'), 'latin1');
        }
        case 3: {
            // drop a random line
            let lines = text.split('\r\n');
            lines.splice(rng.int(0, lines.length - 1), 1);
            return Buffer.from(lines.join('\r\n'), 'latin1');
        }
        case 4: {
            // insert a fake delimiter line
            let lines = text.split('\r\n');
            lines.splice(rng.int(0, lines.length), 0, rng.pick(['--', '----', '--b', '--b--', '--boundary "quoted"', '--' + rng.token(10, BOUNDARY_CHARS)]));
            return Buffer.from(lines.join('\r\n'), 'latin1');
        }
        case 5:
            // CR runs and bare CRs at line ends
            return Buffer.from(text.replace(/\r\n/g, () => rng.pick(['\r\n', '\r\r\n', '\n', '\r\n'])), 'latin1');
        case 6:
            // random garbage
            return rng.bytes(rng.int(0, 500));
        default:
            // repeat the whole message after itself (looks like a message inside a message)
            return Buffer.concat([bytes, bytes]);
    }
}

/**
 * What rebuild() returns for any input: a line break is LF with an optional CR before it and becomes
 * CRLF, everything else is content, and a message that does not end with a line break gets one
 */
function canonical(source) {
    let out = Buffer.from(source.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
    if (out.length && !out.subarray(-2).equals(Buffer.from('\r\n'))) {
        out = Buffer.concat([out, Buffer.from('\r\n')]);
    }
    return out;
}

module.exports = { Rng, generateMessage, generateNode, serialize, mutate, canonical };
