'use strict';

// Email/parse (RFC 8621 4.9): blobs parsed into Email objects without storing anything. The Email model
// is the one of Email/get (email-model.js); id, threadId, mailboxIds, keywords and receivedAt are null,
// and the parts of the parsed message get blob ids inside the parsed blob, so they can be downloaded
// and parsed in turn.

const { URN } = require('../capabilities');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments } = require('./common');
const { resolveProperties, bodyArguments, toEmail, PARSE_PROPERTIES } = require('../email-model');
const { parseBlobId, blobId } = require('../ids');
const { readBlob } = require('../blob');
const { resolveId } = require('../set');
const { looksLikeMessage, parseMessage } = require('../parsed-message');
const consts = require('../../consts');

const NULL_METADATA = ['id', 'threadId', 'mailboxIds', 'keywords', 'receivedAt'];

/** The blob id of a part of the parsed blob, by its part path inside the parsed message */
function partIdsOf(id) {
    const parsed = parseBlobId(id);
    const nested = path => (parsed.part ? `${parsed.part}.${path}` : path);
    if (parsed.kind === 'upload' || parsed.kind === 'uploadPart') {
        return path => blobId.uploadPart(parsed.id, nested(path));
    }
    return path => blobId.part(parsed.id, nested(path));
}

function blobIdList(args, context) {
    if (!Array.isArray(args.blobIds) || !args.blobIds.every(id => typeof id === 'string')) {
        throw invalidArguments('blobIds must be a list of blob ids');
    }
    if (args.blobIds.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    return [...new Set(args.blobIds)];
}

async function parse(args, context) {
    checkArguments(args, [
        'accountId',
        'blobIds',
        'properties',
        'bodyProperties',
        'fetchTextBodyValues',
        'fetchHTMLBodyValues',
        'fetchAllBodyValues',
        'maxBodyValueBytes'
    ]);
    requireAccount(args, context);
    const ids = blobIdList(args, context);
    const resolved = resolveProperties(args.properties, { defaults: PARSE_PROPERTIES, withId: false });
    const body = bodyArguments(args);
    // the preview and hasAttachment take a pass over the whole message (htmlToText), so only when asked
    const summary = resolved.properties.some(property => property === 'preview' || property === 'hasAttachment');

    const parsed = {};
    const notParsable = [];
    const notFound = [];
    // one blob at a time: each one is held in memory while it is parsed
    for (const reference of ids) {
        // a creation reference ("#b1") names a blob made earlier in the request (RFC 9404 4.1)
        const id = resolveId(context, reference);
        // a blob larger than any message is not a message
        const buffer =
            id && (await readBlob(context, id, consts.MAX_ALLOWED_MESSAGE_SIZE).catch(err => (err.code === 'BlobTooLarge' ? false : Promise.reject(err))));
        if (!id || buffer === null) {
            notFound.push(reference);
            continue;
        }
        if (!buffer || !looksLikeMessage(buffer)) {
            notParsable.push(id);
            continue;
        }
        // the content of a message/rfc822 part is parsed as the stored message parses it, so its parts match
        const doc = parseMessage(context.deps.messageHandler, buffer, { embedded: !!parseBlobId(id).part, summary });
        const values = Object.fromEntries(NULL_METADATA.map(property => [property, () => null]));
        values.blobId = () => id;
        parsed[id] = await toEmail(doc, resolved, body, { messageHandler: context.deps.messageHandler, partBlobId: partIdsOf(id), values });
    }

    return {
        accountId: context.account.id,
        parsed: Object.keys(parsed).length ? parsed : null,
        notParsable: notParsable.length ? notParsable : null,
        notFound: notFound.length ? notFound : null
    };
}

module.exports = { capability: URN.mail, methods: { 'Email/parse': parse } };
