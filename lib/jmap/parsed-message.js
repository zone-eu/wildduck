'use strict';

// Messages that are not stored: blobs parsed for Email/parse (RFC 8621 4.9) and checked before
// Email/import (RFC 8621 4.8). A parsed blob becomes a document shaped like a stored message, so the
// Email model of Email/get (email-model.js) describes it.

const { htmlToText } = require('html-to-text');
const parseMimeTree = require('../../imap-core/lib/indexer/parse-mime-tree');
const consts = require('../consts');

// a header field name: printable ASCII without the colon (RFC 5322 2.2)
const FIELD = /^[\x21-\x39\x3b-\x7e]+[ \t]*:/;

// the end of the header block: the first empty line, or the end of the blob
function headerEnd(buffer) {
    const ends = [buffer.indexOf('\r\n\r\n'), buffer.indexOf('\n\n')].filter(index => index >= 0);
    return ends.length ? Math.min(...ends) : buffer.length;
}

/** The header block of a message blob, without the empty line that ends it */
const headerBlock = buffer => buffer.subarray(0, headerEnd(buffer));

/**
 * Tells whether a blob is a message: it is not empty, its first line is a header field, and the header
 * block holds no NUL octet. Anything else (images, random binary data, plain text without a header) is
 * not a message, although the MIME parser would accept it.
 *
 * @param {Buffer} buffer
 * @returns {Boolean}
 */
function looksLikeMessage(buffer) {
    if (!buffer || !buffer.length) {
        return false;
    }
    const header = headerBlock(buffer);
    if (header.includes(0)) {
        return false;
    }
    const lineEnd = header.indexOf('\n');
    const firstLine = header.subarray(0, lineEnd < 0 ? Math.min(header.length, 1024) : Math.min(lineEnd, 1024)).toString('latin1');
    return FIELD.test(firstLine);
}

// every node of a tree, the nodes of embedded messages included
function nodesOf(node, list = []) {
    list.push(node);
    for (const child of node.childNodes || []) {
        nodesOf(child, list);
    }
    if (node.message) {
        nodesOf(node.message, list);
    }
    return list;
}

/**
 * hasAttachment and the preview, exactly as MessageHandler stores them (ha and intro), so a parsed blob
 * and the stored message agree. getMaildata() takes the bodies out of the tree; they are put back.
 */
function summaryOf(messageHandler, mimeTree) {
    const bodies = nodesOf(mimeTree).map(node => [node, node.body]);
    const maildata = messageHandler.indexer.getMaildata(mimeTree);
    for (const [node, body] of bodies) {
        node.body = body;
        delete node.attachmentId;
    }

    let intro = '';
    if (maildata.text) {
        // MessageHandler builds the intro from the indexed beginning of the text
        intro = messageHandler.createIntro(maildata.text.replace(/\r\n/g, '\n').trim().substr(0, consts.MAX_PLAINTEXT_INDEXED));
    }
    if (maildata.html && maildata.html.length) {
        let htmlSize = 0;
        const html = [];
        for (const chunk of maildata.html) {
            if (htmlSize >= consts.MAX_HTML_CONTENT || !chunk) {
                continue;
            }
            const kept = htmlSize + Buffer.byteLength(chunk) <= consts.MAX_HTML_CONTENT ? chunk : chunk.substr(0, consts.MAX_HTML_CONTENT);
            htmlSize += Buffer.byteLength(kept);
            html.push(kept);
        }
        try {
            intro = messageHandler.createIntro(htmlToText(html.join('')));
        } catch {
            // keep the text intro
        }
    }
    return { ha: (maildata.attachments || []).some(attachment => !attachment.related), intro };
}

/**
 * Parses a message blob into a document for toEmail().
 *
 * @param {Object} messageHandler
 * @param {Buffer} buffer The blob, a message (see looksLikeMessage)
 * @param {Object} [options] {embedded: true for the content of a message/rfc822 part, parsed like the stored message
 *   parses it: its last line is not completed with a line break; summary: false leaves out ha and intro}
 * @returns {{mimeTree: Object, size: Number, ha: Boolean, intro: String}}
 */
function parseMessage(messageHandler, buffer, options = {}) {
    const mimeTree = parseMimeTree(buffer, { embedded: !!options.embedded });
    const doc = { mimeTree, size: buffer.length };
    return options.summary === false ? doc : Object.assign(doc, summaryOf(messageHandler, mimeTree));
}

module.exports = { looksLikeMessage, parseMessage, headerBlock };
