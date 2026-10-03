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

function headerLines(node) {
    let header = node.header || [];
    return Array.isArray(header) ? header : [].concat(header || []);
}

function toBuffer(value) {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value && value.buffer && Buffer.isBuffer(value.buffer)) {
        return value.buffer;
    }
    if (typeof value === 'string') {
        return Buffer.from(value, 'binary');
    }
    return EMPTY;
}

/**
 * Trees written with a version (parse-mime-tree.js TREE_VERSION 2) describe the message exactly:
 *
 *     entity    = header-lines [ CRLF body ]            ; "CRLF body" present unless hasBody is false
 *     body      = bytes | preamble *( delimiter entity CRLF ) close-delimiter epilogue
 *     delimiter = "--" boundary pad CRLF
 *
 * The CRLF after an entity belongs to the delimiter that follows it (RFC 2046 5.1.1), a part body never
 * includes it. A multipart that never saw its close delimiter (`unterminated`) ends with the last part
 * running to the end of the message, and one without any delimiter at all is just its preamble.
 */
function* walkV2(tree, options) {
    const piece = data => ({ data, size: data.length });
    const text = str => piece(Buffer.from(str, 'binary'));

    const walk = function* (node, isRoot) {
        let withHeader = !options.textOnly || !isRoot;

        if (withHeader) {
            let header = headerLines(node);
            if (header.length) {
                yield text(header.join('\r\n') + '\r\n');
            }
        }

        if (node.hasBody === false) {
            return;
        }

        if (withHeader) {
            // the blank line between header and body
            yield piece(CRLF);
        }

        if (node.boundary) {
            let size = bodySize(node);
            if (size) {
                // preamble, verbatim
                yield { data: bodyBuffer(node), size };
            }

            let children = Array.isArray(node.childNodes) ? node.childNodes : [];
            for (let i = 0; i < children.length; i++) {
                let child = children[i];
                yield text('--' + node.boundary + (child.pad || '') + '\r\n');
                yield* walk(child, false);
                if (!node.unterminated || i < children.length - 1) {
                    // the line break that belongs to the next delimiter
                    yield piece(CRLF);
                }
            }

            if (!node.unterminated) {
                yield text('--' + node.boundary + '--' + (node.closePad || ''));
                let epilogue = toBuffer(node.epilogue);
                if (epilogue.length) {
                    yield piece(epilogue);
                }
            }
        } else if (node.attachmentId) {
            if (!options.skipExternal) {
                yield { node, attachmentId: node.attachmentId, size: bodySize(node) };
            }
        } else {
            let size = bodySize(node);
            if (size) {
                yield { data: bodyBuffer(node), size };
            }
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
 * @param {Number} [options.version] Tree format version, defaults to the `v` of the tree itself (1 when absent)
 */
function* walkTree(tree, options) {
    options = options || {};
    let version = Number(options.version || (tree && tree.v)) || 1;
    if (version >= 2) {
        yield* walkV2(tree, options);
    } else {
        yield* walkV1(tree, options);
    }
}

module.exports = { walkTree, bodyBuffer, bodySize, headerBlock, CRLF };
