'use strict';

const addressparser = require('nodemailer/lib/addressparser');

// Format version of the trees this parser writes. Trees without a version are the layout written before
// 2026-10 (v1); indexer/tree-walker.js keeps rendering those the way they were stored.
const TREE_VERSION = 2;

// A line ends with LF, optionally preceded by one CR (RFC 5322 2.1, with the bare LF that transports
// produce). Every other byte is content, a bare CR included. Lines are stored with CRLF
const LINE_BREAKS = /\r?\n/g;

/**
 * Splits a structured header value (RFC 2045 5.1 Content-Type and friends) at a separator character,
 * leaving quoted strings intact and dropping RFC 822 comments outside of them. With no separator the
 * whole value comes back as one part with its comments removed.
 *
 * @param {String} value Header value
 * @param {String} [separator] Character to split at, outside quotes and comments
 * @returns {Array} Parts
 */
function splitStructuredValue(value, separator) {
    let parts = [];
    let current = '';
    let quoted = false;
    let depth = 0;

    for (let i = 0; i < value.length; i++) {
        let chr = value.charAt(i);

        if (quoted) {
            current += chr;
            if (chr === '\\' && i + 1 < value.length) {
                // quoted-pair, keep the escaped character for the value parser
                current += value.charAt(++i);
            } else if (chr === '"') {
                quoted = false;
            }
            continue;
        }

        if (depth) {
            // inside a comment, which may nest and may hold quoted-pairs
            if (chr === '\\') {
                i++;
            } else if (chr === '(') {
                depth++;
            } else if (chr === ')') {
                depth--;
            }
            continue;
        }

        if (chr === '"') {
            quoted = true;
            current += chr;
        } else if (chr === '(') {
            depth = 1;
        } else if (separator && chr === separator) {
            parts.push(current);
            current = '';
        } else {
            current += chr;
        }
    }

    parts.push(current);
    return parts;
}

/**
 * Parses a RFC822 message into a structured object (JSON compatible)
 *
 * @constructor
 * @param {String|Buffer} rfc822 Raw body of the message
 * @param {Object} [options]
 * @param {Boolean} [options.embedded] The input is the body of a message/rfc822 part, not a whole message
 */
class MIMEParser {
    constructor(rfc822, options) {
        options = options || {};

        // ensure the input is a binary string
        this.rfc822 = (rfc822 || '').toString('binary');

        // every line of a message ends with a line break. A message that does not end with one is
        // completed here, so the stored size and the rebuilt bytes describe a well formed message.
        // The body of an embedded message ends where the enclosing delimiter starts, the line break
        // before that delimiter belongs to the delimiter, so such a body is kept as it is
        if (!options.embedded && this.rfc822.length && !this.rfc822.endsWith('\n')) {
            this.rfc822 += '\r\n';
        }

        // the line break that ended the last line read, false once the input is used up
        this._br = '';
        this._pos = 0;

        this.tree = {
            rootNode: true,
            childNodes: []
        };
        this._node = this.createNode(this.tree);
    }

    /**
     * Parses the message, line by line
     */
    parse() {
        let line,
            prevBr = '';

        // keep parsing until the last linebreak is not a string (no linebreaks anymore)
        while (typeof this._br === 'string') {
            line = this.readLine();

            let delimiter = this.matchDelimiter(line);
            if (delimiter) {
                this.endPart(delimiter, prevBr);
            } else {
                switch (this._node.state) {
                    case 'header':
                        if (!line) {
                            // the blank line that separates the header from the body
                            this.processNodeHeader();
                            this.processContentType();
                            this._node.state = 'body';
                        } else {
                            this._node.header.push(line);
                        }
                        break;

                    case 'body':
                        // push the line with previous linebreak value
                        // if the array is joined together to a one string,
                        // then the linebreaks in the string are the 'original' ones
                        this._node.body.push((this._node.body.length ? prevBr : '') + line);
                        break;

                    case 'epilogue':
                        // RFC 2046 5.1.1: everything after the close delimiter up to the next delimiter
                        // of the enclosing multipart (or the end of the message) is the epilogue. Every
                        // epilogue line keeps the line break that precedes it, the first one being the
                        // line break that ends the close delimiter line
                        if (!this._node.epilogue) {
                            this._node.epilogue = [];
                        }
                        this._node.epilogue.push(prevBr + line);
                        break;

                    default:
                        // never should be reached
                        throw new Error('Unexpected state');
                }
            }

            // store the linebreak for later usage
            prevBr = this._br;
        }
    }

    /**
     * Reads a line from the message body
     *
     * @return {String} The line, without its line break
     */
    readLine() {
        let end = this.rfc822.indexOf('\n', this._pos);
        if (end < 0) {
            // the remainder, which is empty when the input ended with a line break
            let line = this.rfc822.slice(this._pos);
            this._pos = this.rfc822.length;
            this._br = false;
            return line;
        }

        let lineEnd = end;
        if (lineEnd > this._pos && this.rfc822.charCodeAt(lineEnd - 1) === 0x0d) {
            lineEnd--;
        }

        let line = this.rfc822.slice(this._pos, lineEnd);
        this._br = this.rfc822.slice(lineEnd, end + 1);
        this._pos = end + 1;
        return line;
    }

    /**
     * Checks whether a line is a delimiter of the innermost open multipart: the one the current node
     * belongs to, or the current node itself while it is collecting its preamble or epilogue.
     * RFC 2046 5.1.1: `--boundary` or `--boundary--`, optionally followed by transport padding (spaces
     * and tabs) that receivers must accept.
     *
     * @param {String} line Line of the message
     * @return {Object|Boolean} `{ multipart, close, pad }`, or false when the line is not a delimiter
     */
    matchDelimiter(line) {
        if (line.charCodeAt(0) !== 0x2d || line.charCodeAt(1) !== 0x2d) {
            return false;
        }

        let node = this._node;
        // a multipart in its body state is collecting its preamble, in its epilogue state its epilogue;
        // its own boundary opens parts in the first case only. A part always looks for its parent
        let multipart = node.boundary && node.state !== 'header' ? node : node.parentNode;
        if (!multipart || !multipart.boundary || !line.startsWith(multipart.delimiter)) {
            if (multipart === node && node.parentNode.boundary) {
                // the preamble of a multipart may also end with the delimiter of the enclosing one
                return this.matchDelimiterOf(node.parentNode, line);
            }
            return false;
        }

        return this.matchDelimiterOf(multipart, line);
    }

    matchDelimiterOf(multipart, line) {
        if (!line.startsWith(multipart.delimiter)) {
            return false;
        }

        let rest = line.slice(multipart.delimiter.length);
        let close = false;
        if (rest.startsWith('--')) {
            close = true;
            rest = rest.slice(2);
        }

        if (/[^ \t]/.test(rest)) {
            // something other than padding after the boundary, so a different boundary or body text
            return false;
        }

        if (multipart.state === 'epilogue') {
            // after the close delimiter, lines that look like the own delimiter are epilogue text
            return false;
        }

        return { multipart, close, pad: rest };
    }

    /**
     * Ends whatever the current node was collecting at a delimiter line and moves on to the next
     * part of that multipart, or to its epilogue
     *
     * @param {Object} delimiter Result of matchDelimiter()
     * @param {String} prevBr The line break that ended the line before the delimiter
     */
    endPart(delimiter, prevBr) {
        let node = this._node;
        let multipart = delimiter.multipart;

        if (node !== multipart) {
            // a part ends here
            if (node.state === 'header') {
                // a delimiter right after the header lines, with no blank line and no line break of
                // its own (RFC 2046 5.1.1 wants one before every delimiter): the line break that ended
                // the last header line, or the previous delimiter line, is the only one there is
                this.processNodeHeader();
                this.processContentType();
                node.state = 'body';
                node.bare = true;
            }
            this.parseEmbeddedMessage(node);
        } else if (node.body.length && node.state === 'body') {
            // the preamble ends here. The line break between the preamble and the delimiter belongs to
            // the delimiter, but the preamble lines end with their own
            node.body[node.body.length - 1] += prevBr;
        }

        if (!delimiter.close) {
            let next = this.createNode(multipart);
            if (delimiter.pad) {
                next.pad = delimiter.pad;
            }
            this._node = next;
        } else {
            if (delimiter.pad) {
                multipart.closePad = delimiter.pad;
            }
            delete multipart.unterminated;
            multipart.state = 'epilogue';
            this._node = multipart;
        }
    }

    /**
     * Parses the body of a message/rfc822 node into `node.message`. RFC 2046 5.2.1 only allows the
     * identity encodings for such a body, RFC 2045 5.1 and 6.1 make the type and encoding names case
     * insensitive
     */
    parseEmbeddedMessage(node) {
        let contentType = node.parsedHeader['content-type'];
        if (!contentType || (contentType.value || '').toLowerCase() !== 'message/rfc822') {
            return;
        }
        let encoding = (node.parsedHeader['content-transfer-encoding'] || '').toString().trim().toLowerCase();
        if (encoding && !['7bit', '8bit', 'binary'].includes(encoding)) {
            return;
        }
        node.message = parse(Array.isArray(node.body) ? node.body.join('') : node.body, { embedded: true });
    }

    /**
     * Join body arrays into strings. Removes unnecessary fields
     * from the tree (circular references prohibit conversion to JSON)
     */
    finalizeTree() {
        if (this._node.state === 'header') {
            this.processNodeHeader();
            this.processContentType();
        }

        let walker = node => {
            if (node.parentNode === this.tree) {
                // the message itself may be a message/rfc822 entity
                this.parseEmbeddedMessage(node);
            }

            // RFC 2046 5.1.1: a node has a body section when anything followed the blank line after its
            // header. A separator followed by the end of the input leaves the trailing empty line in the
            // body, a separator followed directly by a delimiter leaves nothing, and a multipart without
            // preamble has parts or a close delimiter
            if (!node.body.length && !node.childNodes.length && node.unterminated !== false && (!node.boundary || node.unterminated)) {
                node.hasBody = false;
            }

            node.lineCount = node.body.length ? node.body.length - 1 : 0;
            node.body = Buffer.from(node.body.join('').replace(LINE_BREAKS, '\r\n'), 'binary');
            node.size = node.body.length;

            if (node.epilogue) {
                node.epilogue = Buffer.from(node.epilogue.join('').replace(LINE_BREAKS, '\r\n'), 'binary');
            }

            node.childNodes.forEach(walker);

            // remove unneeded properties
            delete node.parentNode;
            delete node.state;
            delete node.delimiter;
            if (!node.childNodes.length) {
                delete node.childNodes;
            }
        };
        this.tree.childNodes.forEach(walker);
    }

    /**
     * Creates a new node with default values for the parse tree
     */
    createNode(parentNode) {
        let node = {
            state: 'header',
            childNodes: [],
            header: [],
            parsedHeader: {},
            body: [],
            multipart: false,
            boundary: false,
            parentNode
        };
        parentNode.childNodes.push(node);
        return node;
    }

    /**
     * Processes header lines. Splits lines to key-value pairs
     * and processes special values
     */
    processNodeHeader() {
        let node = this._node;

        // RFC 5322 2.2.3: a line that starts with whitespace continues the previous header field
        let header = [];
        for (let line of node.header) {
            if (header.length && /^\s/.test(line)) {
                header[header.length - 1] += '\r\n' + line;
            } else {
                header.push(line);
            }
        }
        node.header = header;

        for (let line of header) {
            let value = line.split(':');
            let key = (value.shift() || '').trim().toLowerCase();
            value = value.join(':').trim();

            // Do not touch headers that have strange looking keys, keep these
            // only in the unparsed array
            if (/[^a-zA-Z0-9\-*]/.test(key) || key.length >= 100) {
                continue;
            }

            // assume UTF-8 for binary headers
            value = Buffer.from(value, 'binary').toString();

            if (key in node.parsedHeader) {
                if (Array.isArray(node.parsedHeader[key])) {
                    node.parsedHeader[key].push(value);
                } else {
                    node.parsedHeader[key] = [node.parsedHeader[key], value];
                }
            } else {
                node.parsedHeader[key] = value.replace(/\s*\r?\n\s*/g, ' ');
            }
        }

        // always ensure the presence of Content-Type. RFC 2046 5.1.5: inside a digest the default
        // is message/rfc822 instead of text/plain
        if (!node.parsedHeader['content-type']) {
            let parentSubtype = ((node.parentNode && node.parentNode.multipart) || '').toString().toLowerCase();
            node.parsedHeader['content-type'] = parentSubtype === 'digest' ? 'message/rfc822' : 'text/plain';
        }

        // parse additional params for Content-Type and Content-Disposition
        ['content-type', 'content-disposition'].forEach(key => {
            if (node.parsedHeader[key]) {
                node.parsedHeader[key] = this.parseValueParams([].concat(node.parsedHeader[key] || []).pop());
            }
        });

        // ensure single value for selected fields. RFC 3501 7.4.2 wants a string for the date, so a
        // duplicated Date header keeps the last one like the other single value fields
        [
            'date',
            'in-reply-to',
            'message-id',
            'content-transfer-encoding',
            'content-id',
            'content-description',
            'content-language',
            'content-md5',
            'content-location'
        ].forEach(key => {
            if (Array.isArray(node.parsedHeader[key])) {
                node.parsedHeader[key] = node.parsedHeader[key].pop();
            }
        });

        if (node.parsedHeader['content-transfer-encoding']) {
            // RFC 2045 6.1: the mechanism token may be followed by a comment, which is not part of it
            node.parsedHeader['content-transfer-encoding'] = splitStructuredValue(node.parsedHeader['content-transfer-encoding'])[0].trim();
        }

        // Parse address fields (join several fields with same key)
        ['from', 'sender', 'reply-to', 'to', 'cc', 'bcc'].forEach(key => {
            let addresses = [];
            if (node.parsedHeader[key]) {
                [].concat(node.parsedHeader[key] || []).forEach(value => {
                    if (value) {
                        addresses = addresses.concat(addressparser(value) || []);
                    }
                });
                node.parsedHeader[key] = addresses;
            }
        });
    }

    /**
     * Splits a value to an object.
     * eg. 'text/plain; charset=utf-8' -> {value: 'text/plain', params:{charset: 'utf-8'}}
     *
     * @param {String} headerValue A string value for a header key
     * @return {Object} Parsed value
     */
    parseValueParams(headerValue) {
        let data = {
            value: '',
            type: '',
            subtype: '',
            params: {}
        };

        // RFC 2231 continuations and encoded values, by parameter name
        let continuations = {};
        let charsetRequired = new Set();

        splitStructuredValue(headerValue || '', ';').forEach((part, i) => {
            let key, value;
            if (!i) {
                data.value = part.trim();
                data.subtype = data.value.split('/');
                data.type = (data.subtype.shift() || '').toLowerCase();
                data.subtype = data.subtype.join('/');
                return;
            }
            value = part.split('=');
            key = (value.shift() || '').trim().toLowerCase();
            value = value.join('=').trim();
            if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
                // RFC 2045 5.1 quoted-string: the quotes are not part of the value and a backslash
                // quotes the character after it (RFC 822 3.3)
                value = value.slice(1, -1).replace(/\\([\s\S])/g, '$1');
            } else {
                value = value.replace(/^['"\s]*|['"\s]*$/g, '');
            }

            // Do not touch headers that have strange looking keys, keep these
            // only in the unparsed array
            if (/[^a-zA-Z0-9\-*]/.test(key) || key.length >= 100) {
                return;
            }

            // This regex allows for an optional trailing asterisk, for headers
            // which are encoded with lang/charset info as well as a continuation.
            // See https://tools.ietf.org/html/rfc2231 section 4.1.
            let match = key.match(/^([^*]+)\*(\d+)?\*?$/);
            if (match) {
                let name = match[1];
                if (!continuations[name]) {
                    continuations[name] = [];

                    // Additionally allow RFC2231 encoded values
                    if (key.match(/^([^*]+)\*(?:\d+\*)?$/)) {
                        // must have charset
                        charsetRequired.add(name);
                    }
                }
                continuations[name][Number(match[2]) || 0] = value;
            } else {
                data.params[key] = value;
            }
            data.hasParams = true;
        });

        // convert extended mime word into a regular one
        Object.keys(continuations).forEach(key => {
            let charset = '';
            let value = '';

            if (!charsetRequired.has(key)) {
                charset = 'utf-8';
                value = continuations[key].join('').replace(/%/g, '=');
            } else {
                continuations[key].forEach((val, i) => {
                    if (!i) {
                        let parts = val.split("'"); // eslint-disable-line quotes
                        charset = parts.shift();
                        parts.shift(); // lang argument, ignored
                        val = parts.join("'"); // eslint-disable-line quotes
                    }
                    value += val.replace(/%/g, '=');
                });
            }

            data.params[key] = '=?' + (charset || 'ISO-8859-1').toUpperCase() + '?Q?' + value + '?=';
        });

        return data;
    }

    /**
     * Checks Content-Type value for the current tree node.
     */
    processContentType() {
        let node = this._node;
        let contentType = node.parsedHeader['content-type'];
        if (!contentType) {
            return;
        }

        if (contentType.type === 'multipart' && contentType.params.boundary) {
            node.multipart = contentType.subtype;
            node.boundary = contentType.params.boundary;
            node.delimiter = '--' + node.boundary;
            // until the close delimiter is seen
            node.unterminated = true;
        }
    }
}

function parse(rfc822, options) {
    let parser = new MIMEParser(rfc822, options);
    let response;

    parser.parse();
    parser.finalizeTree();

    response = parser.tree.childNodes[0] || false;
    if (response) {
        response.v = TREE_VERSION;
    }
    return response;
}

parse.MIMEParser = MIMEParser;
parse.TREE_VERSION = TREE_VERSION;

module.exports = parse;
