'use strict';

const stream = require('stream');
const PassThrough = stream.PassThrough;
const BodyStructure = require('./body-structure');
const createEnvelope = require('./create-envelope');
const parseMimeTree = require('./parse-mime-tree');
const libmime = require('libmime');
const libcharset = require('libmime/lib/charset');
const libqp = require('libqp');
const libbase64 = require('libbase64');
const he = require('he');
const { htmlToText } = require('html-to-text');
const crypto = require('crypto');

const MAX_HTML_PARSE_LENGTH = 2 * 1024 * 1024; // do not parse HTML messages larger than 2MB to plaintext

const NEWLINE = Buffer.from('\r\n');

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
     * Returns expected size for a node
     *
     * @param  {Object} mimeTree Parsed mimeTree object (or sub node)
     * @param  {Boolean} textOnly If true, do not include the message header in the response
     * @return {String} Expected message size
     */
    getSize(mimeTree, textOnly) {
        let size = 0;
        let first = true;
        let root = true;
        let lastByte = null;
        let forceSeparator = false;

        // make sure that mixed body + mime gets rebuilt correctly
        let append = (data, force) => {
            if (Array.isArray(data)) {
                data = data.join('\r\n');
            }
            if (data || force) {
                if (!first) {
                    if (forceSeparator || force || lastByte !== 0x0a) {
                        size += NEWLINE.length;
                    }
                    forceSeparator = false;
                } else {
                    first = false;
                }

                if (data) {
                    let buf = Buffer.from(data, 'binary');
                    size += buf.length;
                    lastByte = buf[buf.length - 1];
                } else if (force) {
                    lastByte = 0x0a;
                }
            }
        };

        let walk = (node, next) => {
            if (!textOnly || !root) {
                append(formatHeaders(node.header).join('\r\n') + '\r\n');
                forceSeparator = true;
            }

            let finalize = () => {
                if (node.boundary) {
                    append(`--${node.boundary}--`);
                    if (node.epilogue && node.epilogue.length) {
                        size += node.epilogue.length;
                        lastByte = node.epilogue[node.epilogue.length - 1];
                    }
                }

                append();
                next();
            };

            root = false;
            if (node.size || node.attachmentId) {
                if (!node.boundary) {
                    append(false, true); // force newline
                }
                let nodeSize = Number(node.size);
                if (!Number.isFinite(nodeSize)) {
                    if (Buffer.isBuffer(node.body)) {
                        nodeSize = node.body.length;
                    } else if (node.body && node.body.buffer && Buffer.isBuffer(node.body.buffer)) {
                        nodeSize = node.body.buffer.length;
                    } else if (typeof node.body === 'string') {
                        nodeSize = Buffer.byteLength(node.body, 'binary');
                    } else if (Array.isArray(node.body)) {
                        nodeSize = Buffer.byteLength(node.body.join(''), 'binary');
                    } else {
                        nodeSize = 0;
                    }
                }
                size += nodeSize;
                if (nodeSize) {
                    if (Buffer.isBuffer(node.body)) {
                        lastByte = node.body[node.body.length - 1];
                    } else if (node.body && node.body.buffer && Buffer.isBuffer(node.body.buffer)) {
                        lastByte = node.body.buffer[node.body.buffer.length - 1];
                    } else if (typeof node.body === 'string' && node.body.length) {
                        lastByte = Buffer.from(node.body, 'binary').at(-1);
                    } else if (Array.isArray(node.body)) {
                        let lastChar;
                        for (let i = node.body.length - 1; i >= 0; i--) {
                            if (typeof node.body[i] === 'string' && node.body[i].length) {
                                lastChar = node.body[i].at(-1);
                                break;
                            }
                        }
                        if (lastChar) {
                            lastByte = Buffer.from(lastChar, 'binary')[0];
                        } else {
                            lastByte = 0x0a;
                        }
                    } else {
                        // Externalized body; assume it ends with a line break as boundaries require.
                        lastByte = 0x0a;
                    }
                }
            }

            if (node.boundary) {
                append(`--${node.boundary}`);
            }

            if (Array.isArray(node.childNodes)) {
                let pos = 0;
                let processChildNodes = () => {
                    if (pos >= node.childNodes.length) {
                        return finalize();
                    }
                    let childNode = node.childNodes[pos++];
                    walk(childNode, () => {
                        if (pos < node.childNodes.length) {
                            append(`--${node.boundary}`);
                        }
                        return processChildNodes();
                    });
                };
                processChildNodes();
            } else {
                finalize();
            }
        };

        walk(mimeTree, () => false);

        if (!textOnly && needsTrailingNewline(mimeTree)) {
            size += NEWLINE.length;
        }

        return size;
    }

    /**
     * Builds a parsed mime tree into a rfc822 message
     *
     * @param  {Object} mimeTree Parsed mimeTree object
     * @param  {Boolean} textOnly If true, do not include the message header in the response
     * @param  {Object} [options]
     * @param  {Boolean} skipExternal If true, do not include the external nodes
     * @return {Stream} Message stream
     */
    rebuild(mimeTree, textOnly, options) {
        options = options || {};

        let output = new PassThrough();
        let aborted = false;
        let appendTrailingNewline = !textOnly && needsTrailingNewline(mimeTree);

        let startFrom = Math.max(Number(options.startFrom) || 0, 0);
        let maxLength = Math.max(Number(options.maxLength) || 0, 0);

        output.isLimited = !!(options.startFrom || options.maxLength);

        let curWritePos = 0;
        let writeLength = 0;
        let lastByte = null;
        let forceSeparator = false;

        let getCurrentBounds = size => {
            if (curWritePos + size < startFrom) {
                curWritePos += size;
                return false;
            }

            if (maxLength && writeLength >= maxLength) {
                writeLength += size;
                return false;
            }

            let startFromBounds = curWritePos < startFrom ? startFrom - curWritePos : 0;

            let maxLengthBounds = maxLength ? maxLength - writeLength : 0;
            maxLengthBounds = Math.min(size - startFromBounds, maxLengthBounds);
            if (maxLengthBounds < 0) {
                maxLengthBounds = 0;
            }

            return {
                startFrom: startFromBounds,
                maxLength: maxLengthBounds
            };
        };

        let write = async chunk => {
            if (!chunk || !chunk.length) {
                return;
            }
            chunk = normalizeChunk(chunk);
            if (!chunk || !chunk.length) {
                return;
            }

            if (curWritePos >= startFrom) {
                // already allowed to write
                curWritePos += chunk.length;
            } else if (curWritePos + chunk.length <= startFrom) {
                // not yet ready to write, skip
                curWritePos += chunk.length;
                return;
            } else {
                // chunk is in the middle
                let useBytes = curWritePos + chunk.length - startFrom;
                curWritePos += chunk.length;
                chunk = chunk.slice(-useBytes);
            }

            if (maxLength) {
                if (writeLength >= maxLength) {
                    // can not write anymore
                    return;
                } else if (writeLength + chunk.length <= maxLength) {
                    // can still write chunks, so do nothing
                    writeLength += chunk.length;
                } else {
                    // chunk is in the middle
                    let allowedBytes = maxLength - writeLength;
                    writeLength += chunk.length;
                    chunk = chunk.slice(0, allowedBytes);
                }
            }

            lastByte = chunk[chunk.length - 1];
            if (output.write(chunk) === false) {
                await new Promise(resolve => {
                    output.once('drain', resolve());
                });
            }
        };

        let processStream = async () => {
            let firstLine = true;
            let isRootNode = true;
            let remainder = false;

            // make sure that mixed body + mime gets rebuilt correctly
            let emit = async (data, force) => {
                if (remainder || data || force) {
                    if (!firstLine) {
                        if (forceSeparator || lastByte !== 0x0a) {
                            await write(NEWLINE);
                        }
                        forceSeparator = false;
                    } else {
                        firstLine = false;
                    }

                    if (remainder && remainder.length) {
                        await write(remainder);
                    }

                    if (data) {
                        await write(Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary'));
                    }
                }
                remainder = false;
            };

            let walk = async node => {
                if (aborted) {
                    return;
                }

                if (!textOnly || !isRootNode) {
                    await emit(formatHeaders(node.header).join('\r\n') + '\r\n');
                    forceSeparator = true;
                }

                isRootNode = false;
                let epilogue = null;
                if (Buffer.isBuffer(node.body)) {
                    // node Buffer
                    remainder = node.body;
                } else if (node.body && node.body.buffer) {
                    // mongodb Binary
                    remainder = node.body.buffer;
                } else if (typeof node.body === 'string') {
                    // binary string
                    remainder = Buffer.from(node.body, 'binary');
                } else {
                    // whatever
                    remainder = node.body;
                }

                if (node.boundary) {
                    if (node.epilogue && node.epilogue.length) {
                        epilogue = normalizeChunk(node.epilogue);
                    } else if (remainder && remainder.length) {
                        let splitBody = splitMultipartBody(remainder);
                        remainder = splitBody.preamble;
                        epilogue = splitBody.epilogue;
                    }
                }

                if (node.boundary) {
                    // this is a multipart node, so start with initial boundary before continuing
                    await emit(`--${node.boundary}`);
                } else if (node.attachmentId && !options.skipExternal) {
                    await emit(false, true); // force newline between header and contents

                    let attachmentId = node.attachmentId;
                    if (mimeTree.attachmentMap && mimeTree.attachmentMap[node.attachmentId]) {
                        attachmentId = mimeTree.attachmentMap[node.attachmentId];
                    }
                    let attachmentData;
                    try {
                        attachmentData = await this.getAttachment(attachmentId);
                    } catch (err) {
                        if (err.code === 'FileNotFound') {
                            this.loggelf({
                                short_message: 'Attachment missing',
                                _mail_action: 'attachment_missing',
                                _attachment_id: attachmentId
                            });

                            // attachment was not found from storage, use empty placeholder instead
                            attachmentData = {
                                contentType: 'application/octet-stream',
                                transferEncoding: '8bit',
                                length: 0,
                                count: 0,
                                hash: attachmentId,
                                metadata: {
                                    lineLen: 0
                                }
                            };
                        } else {
                            throw err;
                        }
                    }

                    let attachmentSize = Number(node.size);
                    if (!Number.isFinite(attachmentSize)) {
                        attachmentSize = Number(attachmentData && attachmentData.metadata && attachmentData.metadata.esize);
                    }
                    if (!Number.isFinite(attachmentSize)) {
                        attachmentSize = Number(attachmentData && attachmentData.length);
                    }
                    if (!Number.isFinite(attachmentSize)) {
                        attachmentSize = 0;
                    }
                    let nodeTransferEncoding = ((node.parsedHeader && node.parsedHeader['content-transfer-encoding']) || '7bit')
                        .toString()
                        .toLowerCase()
                        .trim();
                    // we need to calculate expected length as the original does not apply anymore
                    // original size matches input data but decoding/encoding is not 100% lossless so we need to
                    // calculate the actual possible output size
                    if (attachmentData.metadata && attachmentData.metadata.decoded && attachmentData.metadata.lineLen) {
                        let b64Size = Math.ceil(attachmentData.length / 3) * 4;
                        let lineBreaks = Math.floor((b64Size - 1) / attachmentData.metadata.lineLen);
                        let storedLineCount = normalizeLineCount(attachmentData.metadata.lineCount);

                        if (storedLineCount !== null) {
                            lineBreaks = storedLineCount;
                        } else if (attachmentData.metadata.esize) {
                            let recovered = Math.floor((attachmentData.metadata.esize - b64Size) / 2);
                            if (recovered >= 0) {
                                lineBreaks = Math.max(lineBreaks, recovered);
                            }
                        }

                        let computedSize = b64Size + lineBreaks * 2;
                        if (Number.isFinite(attachmentSize)) {
                            attachmentSize = Math.max(attachmentSize, computedSize);
                        } else {
                            attachmentSize = computedSize;
                        }
                    }

                    let readBounds = getCurrentBounds(attachmentSize);
                    if (readBounds) {
                        // move write pointer ahead by skipped base64 bytes
                        let bytes = Math.min(readBounds.startFrom, attachmentSize);
                        curWritePos += bytes;

                        // only process attachment if we are reading inside existing bounds
                        if (attachmentSize > readBounds.startFrom) {
                            let attachmentStream = this.attachmentStorage.createReadStream(attachmentId, attachmentData, readBounds);
                            await new Promise((resolve, reject) => {
                                let attachmentOutputBytes = 0;
                                attachmentStream.on('data', chunk => {
                                    if (chunk && chunk.length) {
                                        lastByte = chunk[chunk.length - 1];
                                        attachmentOutputBytes += chunk.length;
                                    }
                                });
                                attachmentStream.once('error', err => {
                                    if (err.code === 'ENOENT') {
                                        this.loggelf({
                                            short_message: 'Attachment missing',
                                            _mail_action: 'attachment_missing',
                                            _attachment_id: attachmentId
                                        });
                                        return resolve();
                                    }
                                    reject(err);
                                });

                                attachmentStream.once('end', () => {
                                    // update read offset counters
                                    let bytes = attachmentOutputBytes;

                                    if (!bytes && 'outputBytes' in attachmentStream) {
                                        bytes = attachmentStream.outputBytes;
                                    }

                                    if (!bytes) {
                                        bytes = readBounds.maxLength;
                                    }

                                    if (bytes) {
                                        curWritePos += bytes;
                                        if (maxLength) {
                                            writeLength += bytes;
                                        }
                                    }

                                    if (!output.isLimited && attachmentSize && bytes && bytes < attachmentSize) {
                                        let missing = attachmentSize - bytes;
                                        if (missing > 0 && missing % 2 === 0) {
                                            let transferEncoding = (attachmentData && attachmentData.transferEncoding) || nodeTransferEncoding;
                                            if (transferEncoding === 'base64') {
                                                return write(Buffer.alloc(missing, '\r\n'))
                                                    .then(resolve)
                                                    .catch(reject);
                                            }
                                        }
                                    }

                                    return resolve();
                                });

                                attachmentStream.pipe(output, {
                                    end: false
                                });
                            });
                        }
                    }
                }

                if (Array.isArray(node.childNodes)) {
                    let pos = 0;
                    for (let childNode of node.childNodes) {
                        await walk(childNode);

                        if (aborted) {
                            return;
                        }

                        if (pos++ < node.childNodes.length - 1) {
                            // emit boundary unless last item
                            await emit(`--${node.boundary}`);
                        }
                    }
                }

                if (node.boundary) {
                    await emit(`--${node.boundary}--`);
                    if (epilogue && epilogue.length) {
                        await write(epilogue);
                    }
                }

                await emit();
            };

            await walk(mimeTree);

            if (appendTrailingNewline) {
                await write(NEWLINE);
            }

            output.end();
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
            expectedLength: this.getSize(mimeTree, textOnly)
        };
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

function formatHeaders(headers) {
    headers = headers || [];
    if (!Array.isArray(headers)) {
        headers = [].concat(headers || []);
    }
    return headers;
}

function normalizeChunk(chunk) {
    if (!chunk) {
        return chunk;
    }
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }
    if (chunk.buffer && Buffer.isBuffer(chunk.buffer)) {
        return chunk.buffer;
    }
    if (typeof chunk === 'string') {
        return Buffer.from(chunk, 'binary');
    }
    try {
        return Buffer.from(chunk);
    } catch {
        return null;
    }
}

function needsTrailingNewline(node) {
    if (!node) {
        return false;
    }

    if (node.boundary) {
        if (node.epilogue && node.epilogue.length) {
            const epilogue = normalizeChunk(node.epilogue);
            return !!epilogue && epilogue.length && epilogue[epilogue.length - 1] !== 0x0a;
        }
        // No epilogue means final boundary is the last bytes, which need CRLF.
        return true;
    }

    if (node.body) {
        const body = normalizeChunk(node.body);
        return !!body && body.length && body[body.length - 1] !== 0x0a;
    }

    // Externalized body or empty content – avoid guessing.
    return false;
}

function normalizeLineCount(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value;
    }
    if (!value) {
        return null;
    }
    if (typeof value.toNumber === 'function') {
        const num = value.toNumber();
        if (Number.isFinite(num) && num >= 0) {
            return num;
        }
    }
    const coerced = Number(value);
    if (Number.isFinite(coerced) && coerced >= 0) {
        return coerced;
    }
    return null;
}

function splitMultipartBody(body) {
    if (!body || !body.length) {
        return { preamble: body, epilogue: null };
    }

    let buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'binary');

    // Find last non-linebreak byte to ensure there is actual content.
    let lastContent = buffer.length - 1;
    while (lastContent >= 0 && (buffer[lastContent] === 0x0d || buffer[lastContent] === 0x0a)) {
        lastContent--;
    }

    if (lastContent < 0) {
        return { preamble: buffer, epilogue: null };
    }

    let pos = buffer.length;
    let crlfCount = 0;
    while (pos >= 2 && buffer[pos - 2] === 0x0d && buffer[pos - 1] === 0x0a) {
        crlfCount++;
        pos -= 2;
    }

    if (crlfCount <= 1) {
        return { preamble: buffer, epilogue: null };
    }

    let splitIndex = buffer.length - (crlfCount - 1) * 2;
    return {
        preamble: buffer.slice(0, splitIndex),
        epilogue: buffer.slice(splitIndex)
    };
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
