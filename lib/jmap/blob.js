'use strict';

// Blobs (RFC 8620 6): raw messages, decoded MIME parts and temporary uploads behind one id space
// (ids.js). Every lookup checks that the blob belongs to the account.

const { parseBlobId } = require('./ids');
const { resolveRoots } = require('../message-roots');
const { openPart } = require('./email-body');

/**
 * Opens a blob for reading.
 *
 * @param {Object} context Request context
 * @param {String} id Blob id
 * @returns {Promise<{stream: Readable, size: Number|null}|null>} null for an unknown blob or one of another account
 */
async function openBlob(context, id) {
    const parsed = parseBlobId(id);
    if (!parsed) {
        return null;
    }
    const deps = context.deps;

    if (parsed.kind === 'upload') {
        const opened = await deps.storageHandler.openStream(context.account.user, parsed.id, { temporary: true }).catch(err => {
            if (err.code === 'FileNotFound') {
                return null;
            }
            throw err;
        });
        return opened && { stream: opened.stream, size: opened.fileData.length };
    }

    const found = await resolveRoots(deps.database.collection('messages'), context.account.user, [parsed.id], {
        projection: { mimeTree: true, size: true, undeleted: true }
    });
    const doc = found.get(parsed.id.toString());
    if (!doc || doc.undeleted === false) {
        return null;
    }
    if (parsed.kind === 'message') {
        const rebuilt = deps.messageHandler.indexer.rebuild(doc.mimeTree);
        return { stream: rebuilt.value, size: doc.size };
    }
    const part = await openPart(deps.messageHandler, doc.mimeTree, parsed.part);
    return part && { stream: part.stream, size: null };
}

module.exports = { openBlob };
