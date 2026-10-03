'use strict';

const stream = require('stream');
const PassThrough = stream.PassThrough;
const BodyStructure = require('./body-structure');
const createEnvelope = require('./create-envelope');
const parseMimeTree = require('./parse-mime-tree');
const { walkTree } = require('./tree-walker');
const libmime = require('libmime');
const libcharset = require('libmime/lib/charset');
const libqp = require('libqp');
const libbase64 = require('libbase64');
const he = require('he');
const { htmlToText } = require('html-to-text');
const crypto = require('crypto');

const MAX_HTML_PARSE_LENGTH = 2 * 1024 * 1024; // do not parse HTML messages larger than 2MB to plaintext

class Indexer {
    constructor(options) {
        this.options = options || {};
        this.fetchOptions = this.options.fetchOptions || {};

        this.attachmentStorage = this.options.attachmentStorage;

        if (this.attachmentStorage) {
            this.getAttachment = async (...args) => await this.attachmentStorage.get(...args);
        } else {
            this.getAttachment = async () => ({});
        }

        // create logger
        this.logger = this.options.logger || {
            info: () => false,
            debug: () => false,
            error: () => false
        };

        this.loggelf = this.options.loggelf || (() => false);
    }

    /**
     * Returns the size of the message a tree rebuilds to
     *
     * @param  {Object} mimeTree Parsed mimeTree object (or sub node)
     * @param  {Boolean} textOnly If true, do not include the message header in the response
     * @param  {Object} [options]
     * @param  {Boolean} [options.skipExternal] If true, do not include the external nodes
     * @return {Number} Message size in bytes
     */
    getSize(mimeTree, textOnly, options) {
        options = options || {};
        let size = 0;
        for (let piece of walkTree(mimeTree, { textOnly, skipExternal: options.skipExternal })) {
            size += piece.size;
        }
        return size;
    }

    /**
     * Builds a parsed mime tree into a rfc822 message
     *
     * The stream emits exactly the bytes getSize() counts for the same tree and options, or the
     * window of them selected by startFrom and maxLength
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @param  {Boolean} textOnly If true, do not include the message header in the response
     * @param  {Object} [options]
     * @param  {Number} [options.startFrom] First byte of the message to emit
     * @param  {Number} [options.maxLength] Number of bytes to emit
     * @param  {Boolean} [options.skipExternal] If true, do not include the external nodes
     * @return {Object} `{ type: 'stream', value: Stream, expectedLength: Number }`
     */
    rebuild(mimeTree, textOnly, options) {
        options = options || {};

        let output = new PassThrough();
        let aborted = false;

        let startFrom = Math.max(Number(options.startFrom) || 0, 0);
        let maxLength = Math.max(Number(options.maxLength) || 0, 0);
        let end = maxLength ? startFrom + maxLength : Infinity;

        output.isLimited = !!(options.startFrom || options.maxLength);

        let write = async chunk => {
            if (!chunk || !chunk.length || aborted || output.destroyed) {
                return;
            }

            if (output.write(chunk) === false) {
                await new Promise(resolve => {
                    let done = () => {
                        output.removeListener('drain', done);
                        output.removeListener('close', done);
                        resolve();
                    };
                    output.on('drain', done);
                    output.on('close', done);
                });
            }
        };

        let processStream = async () => {
            // position in the full message of the next piece
            let pos = 0;

            for (let piece of walkTree(mimeTree, { textOnly, skipExternal: options.skipExternal })) {
                if (aborted || output.destroyed || pos >= end) {
                    return;
                }

                // the part of this piece that falls inside the requested window
                let from = Math.max(startFrom - pos, 0);
                let to = Math.min(end - pos, piece.size);

                if (to > from) {
                    if (piece.data) {
                        await write(this.fitToSize(piece.data, piece.size, piece.node).subarray(from, to));
                    } else {
                        await this.writeAttachment(piece, mimeTree, from, to - from, write, () => aborted || output.destroyed);
                    }
                }

                pos += piece.size;
            }
        };

        setImmediate(() => {
            processStream()
                .then(() => {
                    output.end();
                })
                .catch(err => {
                    output.emit('error', err);
                });
        });

        // if called then stops resolving rest of the message
        output.abort = () => {
            aborted = true;
        };

        return {
            type: 'stream',
            value: output,
            expectedLength: this.getSize(mimeTree, textOnly, options)
        };
    }

    /**
     * Returns `data` as exactly `size` bytes. The two only differ for a corrupt tree whose stored body
     * does not match its stored size; the stored size wins because the message size and the quota hold it
     */
    fitToSize(data, size, node) {
        if (data.length === size) {
            return data;
        }

        this.loggelf({
            short_message: 'Stored body size mismatch',
            _mail_action: 'body_size_mismatch',
            _expected: size,
            _received: data.length,
            _attachment_id: node && node.attachmentId
        });

        if (data.length > size) {
            return data.subarray(0, size);
        }
        return Buffer.concat([data, filler(size - data.length)]);
    }

    /**
     * Writes `length` bytes of an attachment body starting at `relStart`, counted from the start of the
     * body as it appears in the message. The attachment occupies exactly the stored size of its node, so
     * a stream that delivers more is cut and one that delivers less is padded with line breaks
     */
    async writeAttachment(piece, mimeTree, relStart, length, write, isAborted) {
        let attachmentId = piece.attachmentId;
        if (mimeTree.attachmentMap && mimeTree.attachmentMap[attachmentId]) {
            attachmentId = mimeTree.attachmentMap[attachmentId];
        }

        let attachmentData;
        try {
            attachmentData = await this.getAttachment(attachmentId);
        } catch (err) {
            if (err.code !== 'FileNotFound') {
                throw err;
            }
            attachmentData = false;
        }

        let received = 0;

        if (attachmentData) {
            let stream = this.attachmentStorage.createReadStream(attachmentId, attachmentData, { startFrom: relStart, maxLength: length });
            try {
                for await (let chunk of stream) {
                    if (isAborted()) {
                        stream.destroy();
                        return;
                    }
                    let take = Math.min(chunk.length, length - received);
                    if (take > 0) {
                        received += take;
                        await write(chunk.subarray(0, take));
                    }
                    // anything beyond `length` is not part of the message
                }
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    throw err;
                }
                attachmentData = false;
            }
        }

        if (!attachmentData) {
            this.loggelf({
                short_message: 'Attachment missing',
                _mail_action: 'attachment_missing',
                _attachment_id: attachmentId
            });
        }

        if (received < length) {
            // attachment was not found, or the storage returned fewer bytes than the message holds
            await write(filler(length - received));
        }
    }

    /**
     * Parses structured MIME tree from a rfc822 message source
     *
     * @param  {String|Buffer} rfc822 E-mail message as 'binary'-string or Buffer
     * @return {Object} Parsed mime tree
     */
    parseMimeTree(rfc822) {
        return parseMimeTree(rfc822);
    }

    /**
     * Decode text/plain and text/html parts, separate node bodies from the tree
     */
    getMaildata(mimeTree) {
        let magic = parseInt(crypto.randomBytes(2).toString('hex'), 16);
        let maildata = {
            nodes: [],
            attachments: [],
            text: '',
            html: [],
            // magic number to append to increment stored attachment object counter
            magic
        };

        let idcount = 0;
        let htmlContent = [];
        let textContent = [];
        let cidMap = new Map();

        let walk = (node, alternative, related) => {
            let flowed = false;
            let delSp = false;

            let parsedContentType = node.parsedHeader['content-type'];
            let parsedDisposition = node.parsedHeader['content-disposition'];
            let transferEncoding = (node.parsedHeader['content-transfer-encoding'] || '7bit').toLowerCase().trim();

            let contentType = ((parsedContentType && parsedContentType.value) || (node.rootNode ? 'text/plain' : 'application/octet-stream'))
                .toLowerCase()
                .trim();

            alternative = alternative || contentType === 'multipart/alternative';
            related = related || contentType === 'multipart/related';

            if (parsedContentType && parsedContentType.params.format && parsedContentType.params.format.toLowerCase().trim() === 'flowed') {
                flowed = true;
                if (parsedContentType.params.delsp && parsedContentType.params.delsp.toLowerCase().trim() === 'yes') {
                    delSp = true;
                }
            }

            let disposition = ((parsedDisposition && parsedDisposition.value) || '').toLowerCase().trim() || false;
            let isInlineText = false;
            let isMultipart = contentType.split('/')[0] === 'multipart';

            // If the current node is HTML or Plaintext then allow larger content included in the mime tree
            // Also decode text/html value
            if (
                ['text/plain', 'text/html', 'text/rfc822-headers', 'message/delivery-status'].includes(contentType) &&
                (!disposition || disposition === 'inline')
            ) {
                isInlineText = true;
                if (node.body && node.body.length) {
                    let charset = parsedContentType.params.charset || 'windows-1257';
                    let content = node.body;

                    if (transferEncoding === 'base64') {
                        content = libbase64.decode(content.toString());
                    } else if (transferEncoding === 'quoted-printable') {
                        content = libqp.decode(content.toString());
                    }

                    if (
                        !['ascii', 'usascii', 'utf8'].includes(
                            charset
                                .replace(/[^a-z0-9]+/g, '')
                                .trim()
                                .toLowerCase()
                        )
                    ) {
                        content = libcharset.decode(content, charset);
                    }

                    if (flowed) {
                        content = libmime.decodeFlowed(content.toString(), delSp);
                    } else {
                        content = content.toString();
                    }

                    if (contentType === 'text/html') {
                        htmlContent.push(content.trim());
                        if (!alternative) {
                            try {
                                if (content && content.length < MAX_HTML_PARSE_LENGTH) {
                                    let text = htmlToText(content);
                                    textContent.push(text.trim());
                                }
                            } catch (E) {
                                // ignore
                            }
                        }
                    } else {
                        textContent.push(content.trim());
                        if (!alternative) {
                            htmlContent.push(textToHtml(content));
                        }
                    }
                }
            }

            // remove attachments and very large text nodes from the mime tree
            if (!isMultipart && node.body && node.body.length && (!isInlineText || node.size > 300 * 1024)) {
                let attachmentId = `ATT${leftPad(++idcount, '0', 5)}`;

                let filename =
                    (node.parsedHeader['content-disposition'] &&
                        node.parsedHeader['content-disposition'].params &&
                        node.parsedHeader['content-disposition'].params.filename) ||
                    (node.parsedHeader['content-type'] && node.parsedHeader['content-type'].params && node.parsedHeader['content-type'].params.name) ||
                    false;

                let contentId = (node.parsedHeader['content-id'] || '').toString().replace(/<|>/g, '').trim();

                if (filename) {
                    try {
                        filename = libmime.decodeWords(filename).trim();
                    } catch (E) {
                        // failed to parse filename, keep as is (most probably an unknown charset is used)
                    }
                } else {
                    filename = crypto.randomBytes(4).toString('hex') + '.' + libmime.detectExtension(contentType);
                }

                cidMap.set(contentId, {
                    id: attachmentId,
                    filename
                });

                // push to queue
                maildata.nodes.push({
                    attachmentId,
                    magic: maildata.magic,
                    contentType,
                    transferEncoding,
                    lineCount: node.lineCount,
                    body: node.body
                });

                // do not include text content and multipart elements in the attachment list
                if (!isInlineText && !/^(multipart)\//i.test(contentType)) {
                    // list in the attachments array
                    maildata.attachments.push({
                        id: attachmentId,
                        filename,
                        contentType,
                        disposition,
                        transferEncoding,
                        cid: contentId ? `<${contentId}>` : null,
                        related,
                        // approximite size in kilobytes
                        sizeKb: Math.ceil((transferEncoding === 'base64' ? this.expectedB64Size(node.size) : node.size) / 1024)
                    });
                }

                node.body = false;
                node.attachmentId = attachmentId;
            }

            // message/rfc822
            if (node.message) {
                node = node.message;
            }

            if (Array.isArray(node.childNodes)) {
                node.childNodes.forEach(childNode => {
                    walk(childNode, alternative, related);
                });
            }
        };

        walk(mimeTree, false, false);

        let updateCidLinks = str =>
            str.replace(/\bcid:([^\s"']+)/g, (match, cid) => {
                if (cidMap.has(cid)) {
                    let attachment = cidMap.get(cid);
                    return `attachment:${attachment.id.toString()}`;
                }
                return match;
            });

        maildata.html = htmlContent.filter(str => str.trim()).map(updateCidLinks);
        maildata.text = textContent
            .filter(str => str.trim())
            .map(updateCidLinks)
            .join('\n')
            .trim();

        return maildata;
    }

    /**
     * Stores attachments to GridStore
     */
    storeNodeBodies(maildata, mimeTree, callback) {
        let pos = 0;
        let nodes = maildata.nodes;

        mimeTree.attachmentMap = {};
        let storeNode = () => {
            if (pos >= nodes.length) {
                return callback(null, true);
            }

            let node = nodes[pos++];
            this.attachmentStorage.create(node, (err, id, fileContentHash) => {
                if (err) {
                    return callback(err);
                }
                mimeTree.attachmentMap[node.attachmentId] = id;

                let attachmentInfo = maildata.attachments && maildata.attachments.find(a => a.id === node.attachmentId); // get reference to attachment info

                if (attachmentInfo && node.body) {
                    attachmentInfo.size = node.body.length;
                }

                if (attachmentInfo && fileContentHash) {
                    attachmentInfo.fileContentHash = fileContentHash;
                }

                return storeNode();
            });
        };

        storeNode();
    }

    expectedB64Size(b64size) {
        b64size = Number(b64size) || 0;
        if (!b64size || b64size <= 0) {
            return 0;
        }

        let newlines = Math.floor(b64size / 78);
        return Math.ceil(((b64size - newlines * 2) / 4) * 3);
    }

    /**
     * Generates IMAP compatible BODY object from message tree
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @return {Array} BODY object as a structured Array
     */
    getBody(mimeTree) {
        // BODY – BODYSTRUCTURE without extension data
        let body = new BodyStructure(mimeTree, {
            upperCaseKeys: true,
            body: true
        });

        return body.create();
    }

    /**
     * Generates IMAP compatible BODYSTRUCUTRE object from message tree
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @return {Array} BODYSTRUCTURE object as a structured Array
     */
    getBodyStructure(mimeTree) {
        // full BODYSTRUCTURE
        let bodystructure = new BodyStructure(mimeTree, {
            upperCaseKeys: true,
            skipContentLocation: false
        });

        return bodystructure.create();
    }

    /**
     * Generates IMAP compatible ENVELOPE object from message headers
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @return {Array} ENVELOPE object as a structured Array
     */
    getEnvelope(mimeTree) {
        return createEnvelope(mimeTree.parsedHeader || {});
    }

    /**
     * Resolves numeric path to a node in the parsed MIME tree
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @param  {String} path     Dot-separated numeric path
     * @return {Object}          Mime node
     */
    resolveContentNode(mimeTree, path) {
        if (!mimeTree.childNodes && path === '1') {
            path = '';
        }

        let pathNumbers = (path || '').toString().split('.');
        let contentNode = mimeTree;
        let pathNumber;

        while ((pathNumber = pathNumbers.shift())) {
            pathNumber = Number(pathNumber) - 1;
            if (contentNode.message) {
                // redirect to message/rfc822
                contentNode = contentNode.message;
            }

            if (contentNode.childNodes && contentNode.childNodes[pathNumber]) {
                contentNode = contentNode.childNodes[pathNumber];
            } else {
                return false;
            }
        }

        return contentNode;
    }

    bodyQuery(mimeTree, selector, callback) {
        let data = this.getContents(mimeTree, selector);

        if (data && data.type === 'stream') {
            let sent = false;
            let buffers = [];
            let buflen = 0;

            data.value.on('readable', () => {
                let buf;
                while ((buf = data.value.read())) {
                    buffers.push(buf);
                    buflen += buf.length;
                }
            });

            data.value.on('error', err => {
                if (sent) {
                    return;
                }
                sent = true;
                return callback(err);
            });

            data.value.on('end', () => {
                if (sent) {
                    return;
                }
                sent = true;
                return callback(null, Buffer.concat(buffers, buflen));
            });
        } else {
            return setImmediate(() => callback(null, Buffer.from((data || '').toString(), 'binary')));
        }
    }

    /**
     * Get node contents
     *
     * *selector* is an object with the following properties:
     *  * *path* – numeric path 1.2.3
     *  * *type* - one of content|header|header.fields|header.fields.not|text|mime
     *  * *headers* - an array of headers to include/exclude
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @param  {Object} selector What data to return
     * @param  {Object} [options]
     * @param  {Boolean} options.skipExternal If true, do not include the external nodes
     * @return {String} node contents
     */
    getContents(mimeTree, selector, options) {
        options = options || {};

        let node = mimeTree;
        if (typeof selector === 'string') {
            selector = {
                type: selector
            };
        }
        selector = selector || {
            type: ''
        };

        if (selector.path) {
            node = this.resolveContentNode(mimeTree, selector.path);
        }

        if (!node) {
            return '';
        }

        switch (selector.type) {
            case '':
            case 'content':
                if (!selector.path) {
                    // BODY[]
                    node.attachmentMap = mimeTree.attachmentMap;
                    return this.rebuild(node, false, options);
                }
                // BODY[1.2.3]
                node.attachmentMap = mimeTree.attachmentMap;
                return this.rebuild(node, true, options);

            case 'header':
                if (!selector.path) {
                    // BODY[HEADER] mail header
                    return formatHeaders(node.header).join('\r\n') + '\r\n\r\n';
                } else if (node.message) {
                    // BODY[1.2.3.HEADER] embedded message/rfc822 header
                    return (node.message.header || []).join('\r\n') + '\r\n\r\n';
                }
                return '';

            case 'header.fields': {
                // BODY[HEADER.FIELDS.NOT (Key1 Key2 KeyN)] only selected header keys
                if (!selector.headers || !selector.headers.length) {
                    return '\r\n\r\n';
                }
                let headers =
                    formatHeaders(node.header)
                        .filter(line => {
                            let key = line.split(':').shift().toLowerCase().trim();
                            return selector.headers.indexOf(key) >= 0;
                        })
                        .join('\r\n') + '\r\n\r\n';
                return headers;
            }
            case 'header.fields.not': {
                // BODY[HEADER.FIELDS.NOT (Key1 Key2 KeyN)] all but selected header keys
                if (!selector.headers || !selector.headers.length) {
                    return formatHeaders(node.header).join('\r\n') + '\r\n\r\n';
                }
                let headers =
                    formatHeaders(node.header)
                        .filter(line => {
                            let key = line.split(':').shift().toLowerCase().trim();
                            return selector.headers.indexOf(key) < 0;
                        })
                        .join('\r\n') + '\r\n\r\n';
                return headers;
            }

            case 'mime':
                // BODY[1.2.3.MIME] mime node header
                return formatHeaders(node.header).join('\r\n') + '\r\n\r\n';

            case 'text':
                if (!selector.path) {
                    // BODY[TEXT] mail body without headers
                    node.attachmentMap = mimeTree.attachmentMap;
                    return this.rebuild(node, true, options);
                } else if (node.message) {
                    // BODY[1.2.3.TEXT] embedded message/rfc822 body without headers
                    node.attachmentMap = mimeTree.attachmentMap;
                    return this.rebuild(node.message, true, options);
                }

                return '';
            default:
                return '';
        }
    }
}

/**
 * Line break bytes used to fill a gap when a stored body is shorter than the message says
 */
function filler(length) {
    return Buffer.from('\r\n'.repeat(Math.ceil(length / 2))).subarray(0, length);
}

function formatHeaders(headers) {
    headers = headers || [];
    if (!Array.isArray(headers)) {
        headers = [].concat(headers || []);
    }
    return headers;
}

function textToHtml(str) {
    let encoded = he
        // encode special chars
        .encode(str, {
            useNamedReferences: true
        });
    let text = `<p>${
        encoded
            .replace(/\r?\n/g, '\n')
            .trim() // normalize line endings
            .replace(/[ \t]+$/gm, '')
            .trim() // trim empty line endings
            .replace(/\n\n+/g, '</p><p>')
            .trim() // insert <p> to multiple linebreaks
            .replace(/\n/g, '<br/>') // insert <br> to single linebreaks
    }</p>`;

    return text;
}

function leftPad(val, chr, len) {
    return chr.repeat(len - val.toString().length) + val;
}

module.exports = Indexer;
