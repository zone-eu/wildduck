'use strict';

// Blobs (RFC 8620 6): raw messages, decoded MIME parts and temporary uploads behind one id space
// (ids.js). Every lookup checks that the blob belongs to the account.

const { parseBlobId } = require('./ids');
const { resolveId } = require('./set');
const { resolveRoots } = require('../message-roots');
const { openPart } = require('./email-body');
const { visibility, VISIBILITY_FIELDS } = require('./visibility');
const parseMimeTree = require('../../imap-core/lib/indexer/parse-mime-tree');

// message/rfc822 parts the stored tree did not open (transfer encoded ones, digest children without a
// Content-Type) are parsed on demand to reach the parts inside them, at most this many levels deep
const MAX_NESTING = 8;

/**
 * Reads a stream into a Buffer, at most `limit` octets.
 *
 * @throws {Error} code BlobTooLarge when the stream is longer than the limit
 */
async function readAll(stream, limit) {
    const chunks = [];
    let length = 0;
    for await (const chunk of stream) {
        length += chunk.length;
        if (length > limit) {
            stream.destroy();
            throw blobTooLarge();
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
}

function blobTooLarge() {
    const err = new Error('The blob is larger than allowed');
    err.code = 'BlobTooLarge';
    return err;
}

function isClosedMessage(node) {
    const ct = node.parsedHeader && node.parsedHeader['content-type'];
    const type = ((ct && ct.value) || (typeof ct === 'string' ? ct : '')).toLowerCase().trim();
    return type === 'message/rfc822' && !node.message;
}

/**
 * Opens a part of a MIME tree by its IMAP part path. A path that leads into a message/rfc822 part whose
 * message the tree does not hold is resolved by decoding and parsing that part.
 *
 * @returns {Promise<{stream: Readable, node: Object}|null>}
 */
async function openNestedPart(messageHandler, mimeTree, path, limit, depth = 0) {
    const opened = await openPart(messageHandler, mimeTree, path);
    if (opened || depth >= MAX_NESTING) {
        return opened;
    }
    const numbers = path.split('.');
    for (let i = numbers.length - 1; i > 0; i--) {
        const prefix = numbers.slice(0, i).join('.');
        const node = messageHandler.indexer.resolveContentNode(mimeTree, prefix);
        if (!node) {
            continue;
        }
        if (!isClosedMessage(node)) {
            return null;
        }
        const container = await openPart(messageHandler, mimeTree, prefix);
        // parsed like the stored tree parses an embedded message
        const tree = parseMimeTree(await readAll(container.stream, limit), { embedded: true });
        return openNestedPart(messageHandler, tree, numbers.slice(i).join('.'), limit, depth + 1);
    }
    return null;
}

const notFound = err => {
    if (err.code === 'FileNotFound') {
        return null;
    }
    throw err;
};

/**
 * A container blobs point into (a stored message, a parsed upload), loaded once per request: the parts
 * of one message or upload share one load and one parse. Mail writes drop the memo (invalidateMailCache).
 */
function container(context, key, load) {
    const cache = context.cache;
    if (!cache) {
        return load();
    }
    cache.blobContainers = cache.blobContainers || new Map();
    if (!cache.blobContainers.has(key)) {
        cache.blobContainers.set(key, load());
    }
    return cache.blobContainers.get(key);
}

async function openUploadStream(context, id, statOnly) {
    const storageHandler = context.deps.storageHandler;
    const user = context.account.user;
    const opened = statOnly
        ? await storageHandler
              .findOwned(user, id, { temporary: true })
              .then(fileData => ({ fileData, stream: null }))
              .catch(notFound)
        : await storageHandler.openStream(user, id, { temporary: true }).catch(notFound);
    if (opened && opened.fileData.metadata.expires < new Date()) {
        // expired, only waiting for the cleanup
        if (opened.stream) {
            opened.stream.destroy();
        }
        return null;
    }
    return opened;
}

// the MIME tree of an upload, or null (uploads are bounded by maxSizeUpload)
async function uploadTree(context, id) {
    const opened = await openUploadStream(context, id);
    if (!opened) {
        return null;
    }
    if (opened.fileData.length > context.limits.maxSizeUpload) {
        opened.stream.destroy();
        return null;
    }
    return parseMimeTree(await readAll(opened.stream, opened.fileData.length));
}

async function openUpload(context, parsed, statOnly) {
    if (parsed.kind === 'upload') {
        const opened = await openUploadStream(context, parsed.id, statOnly);
        return opened && { stream: opened.stream, size: opened.fileData.length, type: opened.fileData.metadata.contentType || null };
    }
    // a part of an upload: the upload is parsed to find it
    const tree = await container(context, `upload:${parsed.id}`, () => uploadTree(context, parsed.id));
    const part = tree && (await openNestedPart(context.deps.messageHandler, tree, parsed.part, context.limits.maxSizeUpload));
    return part && { stream: part.stream, size: null, type: null };
}

// the visible message document of a message blob id, or null
async function messageDoc(context, root) {
    const [found, visible] = await Promise.all([
        resolveRoots(context.deps.database.collection('messages'), context.account.user, [root], {
            projection: Object.assign({ mimeTree: true, size: true, thread: true }, VISIBILITY_FIELDS)
        }),
        visibility(context)
    ]);
    const doc = found.get(root.toString());
    return doc && visible(doc) ? doc : null;
}

/**
 * Opens a blob for reading.
 *
 * @param {Object} context Request context
 * @param {String} id Blob id, or a creation reference ("#c1") of a blob created earlier in the request (RFC 9404 4.1)
 * @param {Object} [options]
 * @param {Boolean} [options.statOnly] when the size is known without reading (a message, an upload), answer
 *   it with `stream` null instead of opening the content
 * @returns {Promise<{stream: Readable|null, size: Number|null, type: String|null}|null>} null for an unknown blob, an expired
 *   upload or a blob of another account. `type` is the media type recorded at upload, or message/rfc822 for a message
 */
async function openBlob(context, id, options = {}) {
    const parsed = parseBlobId(resolveId(context, id));
    if (!parsed) {
        return null;
    }
    const deps = context.deps;

    if (parsed.kind === 'upload' || parsed.kind === 'uploadPart') {
        return openUpload(context, parsed, options.statOnly);
    }

    const doc = await container(context, `message:${parsed.id}`, () => messageDoc(context, parsed.id));
    if (!doc) {
        return null;
    }
    if (parsed.kind === 'message' && options.statOnly) {
        return { stream: null, size: doc.size, type: 'message/rfc822' };
    }
    if (parsed.kind === 'message') {
        const rebuilt = deps.messageHandler.indexer.rebuild(doc.mimeTree);
        return { stream: rebuilt.value, size: doc.size, type: 'message/rfc822' };
    }
    const part = await openNestedPart(deps.messageHandler, doc.mimeTree, parsed.part, doc.size || context.limits.maxSizeUpload);
    return part && { stream: part.stream, size: null, type: null };
}

/**
 * Reads a whole blob.
 *
 * @param {Object} context Request context
 * @param {String} id Blob id
 * @param {Number} limit Most octets to read
 * @returns {Promise<Buffer|null>} null for an unknown blob or one of another account
 * @throws {Error} code BlobTooLarge when the blob is larger than the limit
 */
async function readBlob(context, id, limit) {
    const opened = await openBlob(context, id);
    if (!opened) {
        return null;
    }
    if (typeof opened.size === 'number' && opened.size > limit) {
        opened.stream.destroy();
        throw blobTooLarge();
    }
    return readAll(opened.stream, limit);
}

/**
 * True when a part path names a part of a stored MIME tree. A path into a message/rfc822 part the tree
 * does not open is taken as existing without parsing that part.
 */
function partExists(messageHandler, mimeTree, path) {
    if (messageHandler.indexer.resolveContentNode(mimeTree, path)) {
        return true;
    }
    const numbers = path.split('.');
    for (let i = numbers.length - 1; i > 0; i--) {
        const node = messageHandler.indexer.resolveContentNode(mimeTree, numbers.slice(0, i).join('.'));
        if (node) {
            return isClosedMessage(node);
        }
    }
    return false;
}

module.exports = { openBlob, readBlob, readAll, partExists };
