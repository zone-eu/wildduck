'use strict';

// Turns a parsed MIME tree into the sequence of byte pieces that make up the RFC 822 message.
//
// getSize() adds the piece sizes up and rebuild() writes the pieces, so the announced size of a message
// and the bytes served for it come from the same traversal and can not disagree.
//
// A piece is either `{ data, size }` for bytes held in the tree, or `{ attachmentId, size }` for a body
// that lives in the attachment storage, where `size` is the stored size of the node: the number of bytes
// the body had in the message, which the message document and the user quota were computed from.

const CRLF = Buffer.from('\r\n');
const EMPTY = Buffer.alloc(0);

/**
 * Returns bytes from the tree as a Buffer, whatever the storage driver returned them as
 */
function toBuffer(value) {
    if (Buffer.isBuffer(value)) {
        return value;
    }
    if (value && value.buffer && Buffer.isBuffer(value.buffer)) {
        // mongodb Binary
        return value.buffer;
    }
    if (typeof value === 'string') {
        return Buffer.from(value, 'binary');
    }
    return EMPTY;
}

function headerLines(node) {
    return node.header || [];
}

const piece = data => ({ data, size: data.length });
const text = str => piece(Buffer.from(str, 'binary'));

function childNodes(node) {
    return Array.isArray(node.childNodes) ? node.childNodes : [];
}

/**
 * The body of a non-multipart node: its attachment, or its bytes when it has any
 */
function* leafPieces(node, options) {
    if (node.attachmentId) {
        if (!options.skipExternal) {
            yield { attachmentId: node.attachmentId, size: typeof node.size === 'number' && node.size >= 0 ? node.size : 0 };
        }
        return;
    }
    let data = toBuffer(node.body);
    if (data.length) {
        yield { data, size: data.length };
    }
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
function* walkV1(root, options) {
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
        yield text(str);
    };

    const walk = function* (node, isRoot) {
        if (!options.textOnly || !isRoot) {
            yield* line(headerLines(node).join('\r\n') + '\r\n');
        }

        if (!node.boundary) {
            for (let piece of leafPieces(node, options)) {
                yield* separator();
                yield piece;
            }
            return;
        }

        yield* separator();
        let preamble = toBuffer(node.body);
        if (preamble.length) {
            yield piece(preamble);
        }
        yield text('--' + node.boundary);

        let children = childNodes(node);
        for (let i = 0; i < children.length; i++) {
            yield* walk(children[i], false);
            if (i < children.length - 1) {
                yield* line('--' + node.boundary);
            }
        }

        yield* line('--' + node.boundary + '--\r\n');
    };

    yield* walk(options.node || root, true);
}

/**
 * Trees written with a version (parse-mime-tree.js TREE_VERSION 2) describe the message exactly:
 *
 *     entity    = header-lines [ CRLF body ]            ; "CRLF body" present unless hasBody is false
 *     body      = bytes | preamble *( delimiter entity CRLF ) close-delimiter epilogue
 *     delimiter = "--" boundary pad CRLF
 *
 * The CRLF after an entity belongs to the delimiter that follows it (RFC 2046 5.1.1), a part body never
 * includes it. A bare entity (header lines directly followed by a delimiter) has no line break of its
 * own to give. A multipart that never saw its close delimiter (`unterminated`) ends with the last part
 * running to the end of the message, and one without any delimiter at all is just its preamble.
 */
function* walkV2(root, options) {
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

        if (!node.boundary) {
            yield* leafPieces(node, options);
            return;
        }

        let preamble = toBuffer(node.body);
        if (preamble.length) {
            yield piece(preamble);
        }

        let children = childNodes(node);
        for (let i = 0; i < children.length; i++) {
            let child = children[i];
            yield text('--' + node.boundary + (child.pad || '') + '\r\n');
            yield* walk(child, false);
            if ((!node.unterminated || i < children.length - 1) && !child.bare) {
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
    };

    yield* walk(options.node || root, true);
}

/**
 * Yields the byte pieces of a message
 *
 * @param {Object} root Parsed MIME tree. Its format version decides the layout
 * @param {Object} [options]
 * @param {Object} [options.node] A node of the tree to render instead of the whole message (BODY[n])
 * @param {Boolean} [options.textOnly] Leave out the header of the rendered node (BODY[TEXT], BODY[n])
 * @param {Boolean} [options.skipExternal] Leave out bodies that live in the attachment storage
 */
function* walkTree(root, options) {
    options = options || {};
    let version = Number(root && root.v) || 1;
    if (version >= 2) {
        yield* walkV2(root, options);
    } else {
        yield* walkV1(root, options);
    }
}

module.exports = { walkTree, headerLines };
