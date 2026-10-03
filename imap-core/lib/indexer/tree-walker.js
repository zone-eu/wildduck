'use strict';

// Turns a parsed MIME tree into the sequence of byte pieces that make up the RFC 822 message.
//
// getSize() adds the piece sizes up and rebuild() writes the pieces, so the announced size of a message
// and the bytes served for it come from the same traversal and can not disagree.
//
// A piece is either `{ data, size }` for bytes held in the tree, or `{ node, attachmentId, size }` for a
// body that lives in the attachment storage. `size` is the number of bytes the piece occupies in the
// message. For stored bodies that is the stored `size` of the node, which is what the message document
// and the user quota were computed from.

const CRLF = Buffer.from('\r\n');
const EMPTY = Buffer.alloc(0);

/**
 * Returns the body bytes of a node as a Buffer, whatever the storage driver returned them as
 */
function bodyBuffer(node) {
    let body = node.body;
    if (Buffer.isBuffer(body)) {
        return body;
    }
    if (body && body.buffer && Buffer.isBuffer(body.buffer)) {
        // mongodb Binary
        return body.buffer;
    }
    if (typeof body === 'string') {
        return Buffer.from(body, 'binary');
    }
    return EMPTY;
}

/**
 * Number of bytes the body of a node occupies in the message
 */
function bodySize(node) {
    if (typeof node.size === 'number' && node.size >= 0) {
        return node.size;
    }
    return bodyBuffer(node).length;
}

function headerBlock(node) {
    let header = node.header || [];
    if (!Array.isArray(header)) {
        header = [].concat(header || []);
    }
    return header.join('\r\n') + '\r\n';
}

/**
 * The layout the parser wrote before trees carried a version. Existing mail stores are full of these
 * trees, their stored `size` was computed by exactly this traversal, so it must stay byte for byte what
 * it was: the header block and every delimiter are lines joined by CRLF, a non-multipart body is preceded
 * by a separator line, a multipart body (preamble, which in these trees also holds the epilogue) sits
 * between the separator and the first delimiter, and the close delimiter carries its own CRLF.
 *
 * The three things the old rebuild did on top of this (a separator line for an empty body, a trailing
 * CRLF for multi-line nodes, and attachment streams of a recomputed length) were never counted by the
 * old size calculation and are left out on purpose.
 */
function* walkV1(tree, options) {
    let first = true;

    // every line except the first one is preceded by the CRLF that ends the previous line
    const separator = function* () {
        if (!first) {
            yield { data: CRLF, size: 2 };
        }
        first = false;
    };

    const line = function* (str) {
        yield* separator();
        let data = Buffer.from(str, 'binary');
        yield { data, size: data.length };
    };

    const walk = function* (node, isRoot) {
        if (!options.textOnly || !isRoot) {
            yield* line(headerBlock(node));
        }

        let size = bodySize(node);

        if (node.boundary) {
            yield* separator();
            if (size) {
                yield { data: bodyBuffer(node), size };
            }
            let delimiter = Buffer.from('--' + node.boundary, 'binary');
            yield { data: delimiter, size: delimiter.length };

            let children = Array.isArray(node.childNodes) ? node.childNodes : [];
            for (let i = 0; i < children.length; i++) {
                yield* walk(children[i], false);
                if (i < children.length - 1) {
                    yield* line('--' + node.boundary);
                }
            }

            yield* line('--' + node.boundary + '--\r\n');
        } else if (node.attachmentId) {
            if (!options.skipExternal) {
                yield* separator();
                yield { node, attachmentId: node.attachmentId, size };
            }
        } else if (size) {
            yield* separator();
            yield { data: bodyBuffer(node), size };
        }
    };

    yield* walk(tree, true);
}

/**
 * Yields the byte pieces of a message
 *
 * @param {Object} tree Parsed MIME tree, or a node of it for BODY[n]
 * @param {Object} [options]
 * @param {Boolean} [options.textOnly] Leave out the header of the root node (BODY[TEXT], BODY[n])
 * @param {Boolean} [options.skipExternal] Leave out bodies that live in the attachment storage
 */
function* walkTree(tree, options) {
    options = options || {};
    yield* walkV1(tree, options);
}

module.exports = { walkTree, bodyBuffer, bodySize, headerBlock, CRLF };
