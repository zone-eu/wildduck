'use strict';

const addressparser = require('nodemailer/lib/addressparser');

// Format version of the trees this parser writes. Trees without a version are the layout written before
// 2026-10 (v1); indexer/tree-walker.js keeps rendering those the way they were stored.
const TREE_VERSION = 2;

const LINE_BREAK = /(\r\n|\n|\r)$/;

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
        if (!options.embedded && this.rfc822.length && !LINE_BREAK.test(this.rfc822)) {
            this.rfc822 += '\r\n';
        }

        this._br = '';
        this._pos = 0;

        this.rawBody = '';

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

            switch (this._node.state) {
                case 'header': {
                    // process header section
                    if (this.rawBody) {
                        this.rawBody += prevBr + line;
                    }

                    // RFC 2046 5.1.1: a delimiter right after the header lines, with no blank line in
                    // between, ends a part that has no body section at all
                    let delimiter = this._node.parentBoundary && this.matchDelimiter(line, this._node.parentBoundary);
                    if (delimiter) {
                        this.processNodeHeader();
                        this.processContentType();
                        this._node.state = 'body';
                        this.processDelimiter(delimiter);
                        break;
                    }

                    if (!line) {
                        this.processNodeHeader();
                        this.processContentType();

                        this._node.state = 'body';
                        // an empty line ended by a line break is the blank line that separates the header
                        // from the body. The empty remainder after the last line break of the input is not
                        this._node.hasBody = this._br !== false;
                    } else {
                        this._node.header.push(line);
                    }
                    break;
                }

                case 'body': {
                    // process body section
                    this.rawBody += prevBr + line;

                    let delimiter = this._node.parentBoundary && this.matchDelimiter(line, this._node.parentBoundary);
                    if (delimiter) {
                        this.processDelimiter(delimiter);
                        break;
                    }

                    if (this._node.boundary) {
                        let own = this.matchDelimiter(line, this._node.boundary);
                        if (own && !own.close) {
                            let child = this.createNode(this._node);
                            child.pad = own.pad;
                            this._node = child;
                            break;
                        }
                        if (own && own.close) {
                            // a close delimiter without any part: the multipart has no children
                            this._node.closePad = own.pad;
                            this._node.terminated = true;
                            this._node.state = 'epilogue';
                            break;
                        }
                    }

                    // push the line with previous linebreak value
                    // if the array is joined together to a one string,
                    // then the linebreaks in the string are the 'original' ones
                    this._node.body.push((this._node.body.length ? prevBr : '') + line);
                    break;
                }

                case 'epilogue': {
                    // RFC 2046 5.1.1: everything after the close delimiter up to the next delimiter of
                    // the enclosing multipart (or the end of the message) is the epilogue
                    this.rawBody += prevBr + line;

                    let delimiter = this._node.parentBoundary && this.matchDelimiter(line, this._node.parentBoundary);
                    if (delimiter) {
                        this.processDelimiter(delimiter);
                        break;
                    }

                    // every epilogue line keeps the line break that precedes it, the first one being the
                    // line break that ends the close delimiter line
                    this._node.epilogue.push(prevBr + line);
                    break;
                }

                default:
                    // never should be reached
                    throw new Error('Unexpected state');
            }

            // store the linebreak for later usage
            prevBr = this._br;
        }
    }

    /**
     * Reads a line from the message body
     *
     * @return {String|Boolean} A line from the message
     */
    readLine() {
        let match = this.rfc822.substr(this._pos).match(/(.*?)(\r*\n|\r(?!\n)|\r*$)/);
        if (match) {
            this._br = match[2] || false;
            this._pos += match[0].length;

            return match[1];
        }
        return false;
    }

    /**
     * Checks whether a line is a delimiter of a boundary. RFC 2046 5.1.1: `--boundary` or `--boundary--`,
     * optionally followed by transport padding (spaces and tabs) that receivers must accept.
     *
     * @param {String} line Line of the message
     * @param {String} boundary Boundary to look for
     * @return {Object|Boolean} `{ close, pad }`, or false when the line is not a delimiter of this boundary
     */
    matchDelimiter(line, boundary) {
        let prefix = '--' + boundary;
        if (!line.startsWith(prefix)) {
            return false;
        }

        let rest = line.slice(prefix.length);
        let close = false;
        if (rest.startsWith('--')) {
            close = true;
            rest = rest.slice(2);
        }

        if (/[^ \t]/.test(rest)) {
            // something other than padding after the boundary, so a different boundary or body text
            return false;
        }

        return { close, pad: rest };
    }

    /**
     * Ends the current node at a delimiter of the enclosing multipart and moves on to the next part
     * or to the epilogue of that multipart
     *
     * @param {Object} delimiter Result of matchDelimiter()
     */
    processDelimiter(delimiter) {
        let node = this._node;

        if (node.state === 'body' && !node.body.length) {
            // nothing between the header and the delimiter: the blank line that ended the header was
            // the line break that belongs to the delimiter, there is no body section
            node.hasBody = false;
        }

        this.parseEmbeddedMessage(node);

        let parent = node.parentNode;
        if (!delimiter.close) {
            let next = this.createNode(parent);
            next.pad = delimiter.pad;
            this._node = next;
        } else {
            parent.closePad = delimiter.pad;
            parent.terminated = true;
            parent.state = 'epilogue';
            this._node = parent;
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
            if (node.body) {
                if (node.parentNode === this.tree) {
                    // the message itself may be a message/rfc822 entity
                    this.parseEmbeddedMessage(node);
                }

                let lines = node.body;

                if (node.boundary && lines.length && node.childNodes.length) {
                    // the line break between the preamble and the first delimiter belongs to the
                    // delimiter and was dropped with it, but the preamble lines end with their own
                    lines[lines.length - 1] += '\n';
                }

                node.lineCount = lines.length ? lines.length - 1 : 0;
                node.body = Buffer.from(
                    lines
                        .join('')
                        // ensure proper line endings
                        .replace(/\r?\n/g, '\r\n'),
                    'binary'
                );
                node.size = node.body.length;
            }

            if (Array.isArray(node.epilogue) && node.epilogue.length) {
                node.epilogue = Buffer.from(node.epilogue.join('').replace(/\r?\n/g, '\r\n'), 'binary');
            } else {
                delete node.epilogue;
            }

            if (node.boundary && !node.terminated) {
                // no close delimiter was seen, the last part runs to the end of the message
                node.unterminated = true;
            }
            delete node.terminated;

            if (node.hasBody) {
                // the common case is not stored
                delete node.hasBody;
            } else {
                node.hasBody = false;
            }

            if (!node.pad) {
                delete node.pad;
            }
            if (!node.closePad) {
                delete node.closePad;
            }

            node.childNodes.forEach(walker);

            // remove unneeded properties
            delete node.parentNode;
            delete node.state;
            if (!node.childNodes.length) {
                delete node.childNodes;
            }
            delete node.parentBoundary;
        };
        walker(this.tree);
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
            epilogue: [],
            hasBody: false,
            multipart: false,
            parentBoundary: parentNode.boundary,
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
        let key, value;

        for (let i = this._node.header.length - 1; i >= 0; i--) {
            if (i && this._node.header[i].match(/^\s/)) {
                this._node.header[i - 1] = this._node.header[i - 1] + '\r\n' + this._node.header[i];
                this._node.header.splice(i, 1);
            } else {
                value = this._node.header[i].split(':');
                key = (value.shift() || '').trim().toLowerCase();
                value = value.join(':').trim();

                // Do not touch headers that have strange looking keys, keep these
                // only in the unparsed array
                if (/[^a-zA-Z0-9\-*]/.test(key) || key.length >= 100) {
                    continue;
                }

                // assume UTF-8 for binary headers
                value = Buffer.from(value, 'binary').toString();

                if (key in this._node.parsedHeader) {
                    if (Array.isArray(this._node.parsedHeader[key])) {
                        this._node.parsedHeader[key].unshift(value);
                    } else {
                        this._node.parsedHeader[key] = [value, this._node.parsedHeader[key]];
                    }
                } else {
                    this._node.parsedHeader[key] = value.replace(/\s*\r?\n\s*/g, ' ');
                }
            }
        }

        // always ensure the presence of Content-Type. RFC 2046 5.1.5: inside a digest the default
        // is message/rfc822 instead of text/plain
        if (!this._node.parsedHeader['content-type']) {
            let parentSubtype = ((this._node.parentNode && this._node.parentNode.multipart) || '').toString().toLowerCase();
            this._node.parsedHeader['content-type'] = parentSubtype === 'digest' ? 'message/rfc822' : 'text/plain';
        }

        // parse additional params for Content-Type and Content-Disposition
        ['content-type', 'content-disposition'].forEach(key => {
            if (this._node.parsedHeader[key]) {
                this._node.parsedHeader[key] = this.parseValueParams([].concat(this._node.parsedHeader[key] || []).pop());
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
            if (Array.isArray(this._node.parsedHeader[key])) {
                this._node.parsedHeader[key] = this._node.parsedHeader[key].pop();
            }
        });

        if (this._node.parsedHeader['content-transfer-encoding']) {
            // RFC 2045 6.1: the mechanism token may be followed by a comment, which is not part of it
            this._node.parsedHeader['content-transfer-encoding'] = splitStructuredValue(this._node.parsedHeader['content-transfer-encoding'])[0].trim();
        }

        // Parse address fields (join several fields with same key)
        ['from', 'sender', 'reply-to', 'to', 'cc', 'bcc'].forEach(key => {
            let addresses = [];
            if (this._node.parsedHeader[key]) {
                [].concat(this._node.parsedHeader[key] || []).forEach(value => {
                    if (value) {
                        addresses = addresses.concat(addressparser(value) || []);
                    }
                });
                this._node.parsedHeader[key] = addresses;
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
        let match;
        let processEncodedWords = {};

        let charsetRequired = new WeakSet();

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

            if ((match = key.match(/^([^*]+)\*(\d+)?\*?$/))) {
                if (!processEncodedWords[match[1]]) {
                    processEncodedWords[match[1]] = [];

                    // Additionally allow RFC2231 encoded values
                    if (key.match(/^([^*]+)\*(?:\d+\*)?$/)) {
                        // must have charset
                        charsetRequired.add(processEncodedWords[match[1]]);
                    }
                }
                processEncodedWords[match[1]][Number(match[2]) || 0] = value;
            } else {
                data.params[key] = value;
            }
            data.hasParams = true;
        });

        // convert extended mime word into a regular one
        Object.keys(processEncodedWords).forEach(key => {
            let charset = '';
            let value = '';

            let isCharsetRequired = charsetRequired.has(processEncodedWords[key]);
            if (!isCharsetRequired) {
                charset = 'utf-8';
                value = processEncodedWords[key].join('').replace(/%/g, '=');
            } else {
                processEncodedWords[key].forEach((val, i) => {
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
        if (!this._node.parsedHeader['content-type']) {
            return;
        }

        if (this._node.parsedHeader['content-type'].type === 'multipart' && this._node.parsedHeader['content-type'].params.boundary) {
            this._node.multipart = this._node.parsedHeader['content-type'].subtype;
            this._node.boundary = this._node.parsedHeader['content-type'].params.boundary;
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
