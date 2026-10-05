'use strict';

const { Readable } = require('stream');
const { buffer: streamToBuffer } = require('stream/consumers');
const BodyStructure = require('./body-structure');
const { partsOf } = BodyStructure;
const createEnvelope = require('./create-envelope');
const { decodeWordsSafe } = createEnvelope;
const parseMimeTree = require('./parse-mime-tree');
const { walkTree, headerLines } = require('./tree-walker');
const LengthLimiter = require('../length-limiter');
const { byteWindow, filler, decodedLength } = require('../../../lib/attachments/base64-codec');
const libmime = require('libmime');
const libcharset = require('libmime/lib/charset');
const libqp = require('libqp');
const libbase64 = require('libbase64');
const he = require('he');
const { htmlToText } = require('html-to-text');
const crypto = require('crypto');

const MAX_HTML_PARSE_LENGTH = 2 * 1024 * 1024; // do not parse HTML messages larger than 2MB to plaintext

// text nodes that are kept in the tree and decoded for the message preview
const INLINE_TEXT_TYPES = ['text/plain', 'text/html', 'text/rfc822-headers', 'message/delivery-status'];
// inline text larger than this is moved to the attachment storage like an attachment
const MAX_INLINE_TEXT_SIZE = 300 * 1024;

/**
 * RFC 822 header section: the header lines and the blank line that ends them
 */
const headerSection = node => headerLines(node).join('\r\n') + '\r\n\r\n';

/**
 * Number of bytes a sequence of pieces adds up to
 */
function sizeOf(pieces) {
    let size = 0;
    for (let piece of pieces) {
        size += piece.size;
    }
    return size;
}

class Indexer {
    constructor(options) {
        this.options = options || {};
        this.attachmentStorage = this.options.attachmentStorage;
        this.loggelf = this.options.loggelf || (() => false);
    }

    /**
     * Returns the size of the message a tree rebuilds to
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @return {Number} Message size in bytes
     */
    getSize(mimeTree) {
        return sizeOf(walkTree(mimeTree));
    }

    /**
     * Builds a parsed mime tree into a rfc822 message
     *
     * The stream emits exactly the bytes getSize() counts for the same tree and options, or the
     * window of them selected by startFrom and maxLength
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @param  {Boolean} textOnly If true, do not include the header of the rendered node
     * @param  {Object} [options]
     * @param  {Object} [options.node] A node of the tree to render instead of the whole message
     * @param  {Number} [options.startFrom] First byte of the message to emit
     * @param  {Number} [options.maxLength] Number of bytes to emit
     * @param  {Boolean} [options.skipExternal] If true, do not include the external nodes
     * @return {Object} `{ type: 'stream', value: Stream, expectedLength: Number }`
     */
    rebuild(mimeTree, textOnly, options) {
        options = options || {};

        let pieces = [...walkTree(mimeTree, { textOnly, node: options.node, skipExternal: options.skipExternal })];
        let expectedLength = sizeOf(pieces);
        let { start, end } = byteWindow(options, expectedLength);

        // the pieces inside the window and the part of each that falls into it. Attachments inside the
        // window are looked up at once instead of one at a time when reached
        let window = [];
        let lookups = new Map();
        let pos = 0;
        for (let piece of pieces) {
            let from = Math.max(start - pos, 0);
            let to = Math.min(end - pos, piece.size);
            pos += piece.size;
            if (to <= from) {
                continue;
            }
            let entry = { piece, from, to };
            if (piece.attachmentId) {
                entry.id = this.resolveAttachmentId(mimeTree, piece.attachmentId);
                if (!lookups.has(entry.id)) {
                    let lookup = this.lookupAttachment(entry.id);
                    // the rejection is handled where the lookup is awaited
                    lookup.catch(() => false);
                    lookups.set(entry.id, lookup);
                }
                entry.lookup = lookups.get(entry.id);
            }
            window.push(entry);
        }

        let output;
        let chunks = async function* () {
            // consecutive in-memory pieces go out as one chunk
            let pending = [];
            let flush = () => {
                let data = pending.length === 1 ? pending[0] : Buffer.concat(pending);
                pending = [];
                return data;
            };

            for (let { piece, from, to, id, lookup } of window) {
                if (piece.data) {
                    pending.push(from === 0 && to === piece.size ? piece.data : piece.data.subarray(from, to));
                    continue;
                }
                if (pending.length) {
                    yield flush();
                }
                yield* this.attachmentChunks(id, lookup, from, to - from, () => output.destroyed);
            }

            if (pending.length) {
                yield flush();
            }
        }.bind(this);

        output = Readable.from(chunks(), { objectMode: false });
        output.isLimited = !!(options.startFrom || options.maxLength);
        // if called then stops resolving rest of the message
        output.abort = () => output.destroy();

        return {
            type: 'stream',
            value: output,
            expectedLength
        };
    }

    /**
     * Storage id of an attachment node: the tree maps the node's ATTnnnnn id to the stored hash
     */
    resolveAttachmentId(mimeTree, attachmentId) {
        return (mimeTree.attachmentMap && mimeTree.attachmentMap[attachmentId]) || attachmentId;
    }

    /**
     * Metadata of a stored attachment, false when the storage does not have it
     */
    async lookupAttachment(id) {
        if (!this.attachmentStorage) {
            return false;
        }
        try {
            return await this.attachmentStorage.get(id);
        } catch (err) {
            if (err.code === 'FileNotFound') {
                return false;
            }
            throw err;
        }
    }

    /**
     * Yields `length` bytes of an attachment body starting at `relStart`, counted from the start of the
     * body as it appears in the message. The attachment occupies exactly the stored size of its node, so
     * a storage that delivers more or less than asked for is logged, cut and padded with line breaks, and
     * a missing attachment is served as line breaks
     */
    async *attachmentChunks(id, lookup, relStart, length, isAborted) {
        let missing = () =>
            this.loggelf({
                short_message: 'Attachment missing',
                _mail_action: 'attachment_missing',
                _attachment_id: id
            });

        let attachmentData = await lookup;
        if (!attachmentData) {
            missing();
            yield filler(length);
            return;
        }

        let stream = this.attachmentStorage.createReadStream(id, attachmentData, { startFrom: relStart, maxLength: length });
        let limiter = new LengthLimiter(length, filler);
        limiter.on('mismatch', info =>
            this.loggelf({
                short_message: 'Attachment length mismatch',
                _mail_action: 'attachment_length_mismatch',
                _attachment_id: id,
                _expected: info.expected,
                _received: info.received
            })
        );
        stream.once('error', err => limiter.destroy(err));

        try {
            for await (let chunk of stream.pipe(limiter)) {
                if (isAborted()) {
                    return;
                }
                yield chunk;
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
            // the file went missing between the lookup and the read
            missing();
            yield filler(length - limiter.byteCounter);
        } finally {
            // an abandoned fetch must not leave the storage stream (and its cursor) open
            stream.destroy();
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

    getMaildata(mimeTree) {
        let magic = crypto.randomInt(0x10000);
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
            let parsedContentType = node.parsedHeader['content-type'];
            let parsedDisposition = node.parsedHeader['content-disposition'];
            let params = (parsedContentType && parsedContentType.params) || {};
            let transferEncoding = (node.parsedHeader['content-transfer-encoding'] || '7bit').toLowerCase().trim();

            let contentType = ((parsedContentType && parsedContentType.value) || 'application/octet-stream').toLowerCase().trim();

            alternative = alternative || contentType === 'multipart/alternative';
            related = related || contentType === 'multipart/related';

            let flowed = (params.format || '').toLowerCase().trim() === 'flowed';
            let delSp = flowed && (params.delsp || '').toLowerCase().trim() === 'yes';

            let disposition = ((parsedDisposition && parsedDisposition.value) || '').toLowerCase().trim() || false;
            let isMultipart = contentType.split('/')[0] === 'multipart';
            let isInlineText = INLINE_TEXT_TYPES.includes(contentType) && (!disposition || disposition === 'inline');

            let hasBody = !!(node.body && node.body.length);

            // decode inline text for the preview and the search index
            if (isInlineText && hasBody) {
                let charset = params.charset || 'windows-1257';
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

            // remove attachments and very large text nodes from the mime tree
            if (!isMultipart && hasBody && (!isInlineText || node.size > MAX_INLINE_TEXT_SIZE)) {
                let attachmentId = 'ATT' + String(++idcount).padStart(5, '0');

                let filename = (parsedDisposition && parsedDisposition.params.filename) || params.name || false;

                let contentId = (node.parsedHeader['content-id'] || '').toString().replace(/<|>/g, '').trim();

                if (filename) {
                    filename = decodeWordsSafe(filename).trim();
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

                // text content is not listed as an attachment
                if (!isInlineText) {
                    maildata.attachments.push({
                        id: attachmentId,
                        filename,
                        contentType,
                        disposition,
                        transferEncoding,
                        cid: contentId ? `<${contentId}>` : null,
                        related,
                        // approximate size in kilobytes
                        sizeKb: Math.ceil((transferEncoding === 'base64' ? decodedLength(node.size) : node.size) / 1024)
                    });
                }

                node.body = false;
                node.attachmentId = attachmentId;
            }

            // the parts of an embedded message are indexed like the parts of the message
            if (node.message) {
                node = node.message;
            }

            (node.childNodes || []).forEach(childNode => {
                walk(childNode, alternative, related);
            });
        };

        walk(mimeTree, false, false);

        let updateCidLinks = str =>
            str.replace(/\bcid:([^\s"']+)/g, (match, cid) => {
                if (cidMap.has(cid)) {
                    let attachment = cidMap.get(cid);
                    return `attachment:${attachment.id}`;
                }
                return match;
            });

        maildata.html = htmlContent.filter(Boolean).map(updateCidLinks);
        maildata.text = textContent.filter(Boolean).map(updateCidLinks).join('\n').trim();

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

                let attachmentInfo = maildata.attachments.find(a => a.id === node.attachmentId);
                if (attachmentInfo) {
                    attachmentInfo.size = node.body.length;
                    if (fileContentHash) {
                        attachmentInfo.fileContentHash = fileContentHash;
                    }
                }


                return storeNode();
            });
        };

        storeNode();
    }

    /**
     * Generates IMAP compatible BODY object from message tree
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @return {Array} BODY object as a structured Array
     */
    getBody(mimeTree) {
        // BODY: BODYSTRUCTURE without extension data
        return new BodyStructure(mimeTree, { upperCaseKeys: true, body: true }).create();
    }

    /**
     * Generates IMAP compatible BODYSTRUCTURE object from message tree
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @return {Array} BODYSTRUCTURE object as a structured Array
     */
    getBodyStructure(mimeTree) {
        return new BodyStructure(mimeTree, { upperCaseKeys: true }).create();
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
     * Resolves numeric path to a node in the parsed MIME tree. RFC 3501 6.4.5: the parts of a multipart
     * are numbered from 1, a non-multipart message has one part which is the message itself, and the
     * parts of a message/rfc822 part are numbered under it
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @param  {String} path     Dot-separated numeric path
     * @return {Object|Boolean}  Mime node, or false when there is no such part
     */
    resolveContentNode(mimeTree, path) {
        // the message whose parts the next number counts
        let scope = mimeTree;
        // v1 trees were served without the placeholder part of a multipart without parts
        let placeholder = (Number(mimeTree.v) || 1) >= 2;
        let node = mimeTree;

        for (let number of (path || '').toString().split('.')) {
            let index = Number(number) - 1;
            if (!scope || !(index >= 0)) {
                return false;
            }

            let parts = partsOf(scope, placeholder);
            node = parts ? parts[index] : index === 0 ? scope : undefined;
            if (!node) {
                return false;
            }

            scope = node.message || (partsOf(node, placeholder) ? node : false);
        }

        return node;
    }

    bodyQuery(mimeTree, selector, callback) {
        let data = this.getContents(mimeTree, selector);

        if (data && data.type === 'stream') {
            streamToBuffer(data.value).then(buf => callback(null, buf), callback);
            return;
        }

        setImmediate(() => callback(null, Buffer.from((data || '').toString(), 'binary')));
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
     * @return {String|Object} node contents, or a stream result from rebuild()
     */
    getContents(mimeTree, selector, options) {
        options = options || {};

        if (typeof selector === 'string') {
            selector = { type: selector };
        }
        selector = selector || { type: '' };

        let node = selector.path ? this.resolveContentNode(mimeTree, selector.path) : mimeTree;
        if (!node) {
            return '';
        }

        // the root carries the format version and the attachment map a node is rendered with
        let render = (target, textOnly) => this.rebuild(mimeTree, textOnly, Object.assign({}, options, { node: target }));

        // RFC 3501 6.4.5: HEADER and TEXT with a part number refer to the encapsulated message of a
        // message/rfc822 part, not to the part itself
        let message = selector.path ? node.message : node;

        switch (selector.type) {
            case '':
            case 'content':
                // BODY[] is the whole message, BODY[1.2.3] a part without its MIME header
                return render(node, !!selector.path);

            case 'mime':
                // BODY[1.2.3.MIME] is the MIME header of the part
                return headerSection(node);

            case 'text':
                return message ? render(message, true) : '';

            case 'header':
                return message ? headerSection(message) : '';

            case 'header.fields':
            case 'header.fields.not': {
                if (!message) {
                    return '';
                }
                let wanted = selector.type === 'header.fields';
                let headers = selector.headers || [];
                return headerLines(message).filter(line => headers.includes(line.split(':').shift().toLowerCase().trim()) === wanted).join('\r\n') + '\r\n\r\n';
            }

            default:
                return '';
        }
    }
}

function textToHtml(str) {
    let encoded = he.encode(str, { useNamedReferences: true });
    // normalise line endings, drop trailing whitespace, paragraphs at blank lines, breaks at the rest
    let text = encoded.replace(/\r?\n/g, '\n').trim().replace(/[ \t]+$/gm, '').replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br/>');
    return `<p>${text}</p>`;
}

module.exports = Indexer;
