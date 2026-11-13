'use strict';

// Blob management (RFC 9404): Blob/upload, Blob/get and Blob/lookup over the blob id space of
// blob.js. Blob/upload stores its result as a temporary upload, exactly like the upload endpoint
// (same expiry, same upload quota, never the mail quota). Every lookup is scoped to the account, and
// another account's blob is reported exactly like an unknown one.

const crypto = require('crypto');
const { URN } = require('../capabilities');
const { eventsReferencing } = require('./calendar-event');
const { MethodError, invalidArguments } = require('../errors');
const { requireAccount, checkArguments, isObject, setOwn } = require('./common');
const { SetError, invalidProperties } = require('../set-errors');
const { resolveId } = require('../set');
const { openBlob, partExists } = require('../blob');
const { blobId, parseBlobId, formatId, MEDIA_TYPE } = require('../ids');
const { resolveRoots } = require('../../message-roots');
const { visibility, VISIBILITY_FIELDS } = require('../visibility');
const consts = require('../../consts');
const responseBudget = require('../response-budget');
const { cardsOfMedia } = require('./contactcard');

const CREATION_ID = /^[A-Za-z0-9_-]{1,255}$/;
// RFC 4648 base64 with padding, no line breaks
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// HTTP Digest Algorithm Values registry names (lower case) and their node:crypto names
const DIGESTS = { sha: 'sha1', 'sha-256': 'sha256', 'sha-512': 'sha512' };
// type names Blob/lookup answers, and the capability each one needs in using
const TYPE_CAPABILITIES = { Mailbox: URN.mail, Thread: URN.mail, Email: URN.mail, ContactCard: URN.contacts, CalendarEvent: URN.calendars };
const TYPE_NAMES = Object.keys(TYPE_CAPABILITIES);
const DEFAULT_MAX_DATA_SOURCES = 64;
const DEFAULT_MAX_SIZE_BLOB_SET = 10 * 1024 * 1024;
const DEFAULT_MAX_SIZE_BLOB_GET = 16 * 1024 * 1024;

const settingsOf = context => ({
    maxSizeBlobSet: context.limits.maxSizeBlobSet || DEFAULT_MAX_SIZE_BLOB_SET,
    maxDataSources: context.limits.maxDataSources || DEFAULT_MAX_DATA_SOURCES,
    // most octets one Blob/get call returns, so a response stays bounded; larger blobs are read in ranges
    maxSizeBlobGet: context.limits.maxSizeBlobGet || DEFAULT_MAX_SIZE_BLOB_GET
});

const accountCapability = context => {
    const { maxSizeBlobSet, maxDataSources } = settingsOf(context);
    return { maxSizeBlobSet, maxDataSources, supportedTypeNames: TYPE_NAMES, supportedDigestAlgorithms: Object.keys(DIGESTS) };
};

const isUnsigned = value => Number.isSafeInteger(value) && value >= 0;
const optionalUnsigned = value => value === undefined || value === null || isUnsigned(value);

// ---------------------------------------------------------------- reading ranges

/**
 * Streams a blob and keeps only the octets of [offset, offset + keep). Chunks before the offset are
 * discarded, so memory is bounded by the kept range, not by its end position.
 *
 * @param {Stream} stream
 * @param {Number} offset
 * @param {Number} keep most octets to keep
 * @param {Boolean} toEnd read on to the end of the stream (to learn the size) after the kept range is full
 * @returns {Promise<{content: Buffer, more: Boolean, size: Number|null}>} more is true when the stream had octets
 *   after the kept range; size is the total length, null when the stream was stopped early
 */
async function readSlice(stream, offset, keep, toEnd) {
    const chunks = [];
    let position = 0;
    let held = 0;
    let more = false;
    for await (const chunk of stream) {
        const start = Math.max(0, offset - position);
        position += chunk.length;
        if (start >= chunk.length) {
            continue;
        }
        const room = keep - held;
        if (chunk.length - start > room) {
            more = true;
            if (room > 0) {
                chunks.push(chunk.subarray(start, start + room));
                held += room;
            }
            if (!toEnd) {
                stream.destroy();
                return { content: Buffer.concat(chunks, held), more, size: null };
            }
            continue;
        }
        chunks.push(start ? chunk.subarray(start) : chunk);
        held += chunk.length - start;
    }
    return { content: Buffer.concat(chunks, held), more, size: position };
}

/**
 * Reads the range [offset, offset + length) of a blob. Only the range is held in memory, the octets
 * before it are streamed past; the size is checked before anything is read when the blob has a known size.
 *
 * @param {Object} context
 * @param {String} id blob id or creation reference
 * @param {Object} range {offset, length (null: to the end), budget: most octets the range may have,
 *   wholeSize: the size of the whole blob is wanted}
 * @returns {Promise<{content: Buffer|null, size: Number|null, truncated: Boolean}|null>} null for an unknown blob.
 *   `truncated` is true when the range reaches past the end. `content` is null when `range.skipContent`
 * @throws {Error} code BlobTooLarge when the range has more octets than the budget
 */
async function readRange(context, id, range) {
    const opened = await openBlob(context, id, { statOnly: true });
    if (!opened) {
        return null;
    }
    const { offset, length, budget } = range;
    if (typeof opened.size === 'number') {
        const end = length === null ? opened.size : Math.min(opened.size, offset + length);
        const wanted = Math.max(0, end - offset);
        const truncated = offset > opened.size || (length !== null && offset + length > opened.size);
        if (range.skipContent || !wanted) {
            return { content: range.skipContent ? null : Buffer.alloc(0), size: opened.size, truncated };
        }
        if (wanted > budget) {
            throw blobTooLarge();
        }
        const reopened = opened.stream ? opened : await openBlob(context, id);
        if (!reopened) {
            return null;
        }
        const { content } = await readSlice(reopened.stream, offset, wanted, false);
        return { content, size: opened.size, truncated };
    }

    // the size is only known once the content is read (a decoded MIME part): stream it, keep the range
    const wanted = length === null ? Infinity : length;
    const keep = range.skipContent ? 0 : Math.min(wanted, budget);
    const toEnd = length === null || range.wholeSize || range.skipContent;
    const { content, more, size } = await readSlice(opened.stream, offset, keep, toEnd);
    if (more && !range.skipContent && wanted > budget) {
        throw blobTooLarge();
    }
    return {
        content: range.skipContent ? null : content,
        size,
        truncated: size !== null && (offset > size || (length !== null && offset + length > size))
    };
}

function blobTooLarge() {
    const err = new Error('The blob is larger than allowed');
    err.code = 'BlobTooLarge';
    return err;
}

// ---------------------------------------------------------------- Blob/upload

const SOURCE_KEYS = ['data:asText', 'data:asBase64', 'blobId', 'offset', 'length'];

/** Checks one DataSourceObject; answers {kind, value, offset, length} */
function checkSource(source, index) {
    const property = `data/${index}`;
    if (!isObject(source) || Object.keys(source).some(key => !SOURCE_KEYS.includes(key))) {
        throw invalidProperties(property, 'a data source has data:asText, data:asBase64 or blobId');
    }
    const kinds = ['data:asText', 'data:asBase64', 'blobId'].filter(key => source[key] !== undefined);
    if (kinds.length !== 1 || typeof source[kinds[0]] !== 'string') {
        throw invalidProperties(property, 'a data source has exactly one of data:asText, data:asBase64 and blobId');
    }
    const kind = kinds[0];
    if (kind !== 'blobId' && (source.offset !== undefined || source.length !== undefined)) {
        throw invalidProperties(property, 'offset and length need a blobId');
    }
    if (!optionalUnsigned(source.offset) || !optionalUnsigned(source.length)) {
        throw invalidProperties(property, 'offset and length must be unsigned integers');
    }
    if (kind === 'data:asBase64' && !BASE64.test(source[kind])) {
        throw invalidProperties(property, 'data:asBase64 is not valid base64');
    }
    return { kind, value: source[kind], offset: source.offset || 0, length: isUnsigned(source.length) ? source.length : null };
}

/** The size of a literal source without decoding it */
function literalSize(source) {
    if (source.kind === 'data:asText') {
        return Buffer.byteLength(source.value, 'utf8');
    }
    const padding = source.value.endsWith('==') ? 2 : source.value.endsWith('=') ? 1 : 0;
    return (source.value.length / 4) * 3 - padding;
}

function checkUpload(object, settings) {
    const unknown = Object.keys(object).filter(key => !['data', 'type'].includes(key));
    if (unknown.length) {
        throw invalidProperties(unknown, 'unknown properties');
    }
    if (!Array.isArray(object.data)) {
        throw invalidProperties('data', 'data must be a list of data sources');
    }
    if (object.data.length > settings.maxDataSources) {
        throw invalidProperties('data', `more than ${settings.maxDataSources} data sources`);
    }
    if (object.type !== undefined && object.type !== null && (typeof object.type !== 'string' || !MEDIA_TYPE.test(object.type))) {
        throw invalidProperties('type', 'type must be a media type');
    }
    return { sources: object.data.map(checkSource), type: object.type || 'application/octet-stream' };
}

/**
 * The content of one creation, checked against the size limit before each source is read.
 *
 * @param {Number} maxSize maxSizeBlobSet
 * @param {Number} room octets the call may still create
 */
async function assemble(context, sources, maxSize, room) {
    const limit = Math.min(maxSize, room);
    const tooLarge = () =>
        new SetError('tooLarge', limit < maxSize ? 'the blobs of this call are too large together' : `the blob is larger than ${maxSize} octets`, { maxSize });
    const parts = [];
    let total = 0;
    for (const [index, source] of sources.entries()) {
        if (source.kind !== 'blobId') {
            total += literalSize(source);
            if (total > limit) {
                throw tooLarge();
            }
            parts.push(Buffer.from(source.value, source.kind === 'data:asText' ? 'utf8' : 'base64'));
            continue;
        }
        const range = await readRange(context, source.value, { offset: source.offset, length: source.length, budget: limit - total }).catch(err =>
            Promise.reject(err.code === 'BlobTooLarge' ? tooLarge() : err)
        );
        if (!range) {
            throw invalidProperties(`data/${index}/blobId`, 'no such blob');
        }
        if (range.truncated) {
            throw invalidProperties(`data/${index}`, 'the range reaches past the end of the blob');
        }
        total += range.content.length;
        if (total > limit) {
            throw tooLarge();
        }
        parts.push(range.content);
    }
    return Buffer.concat(parts, total);
}

async function storeUpload(context, content, type) {
    const { storageHandler } = context.deps;
    const { account, limits } = context;
    // checked against the upload quota before and after it is stored
    const id = await storageHandler
        .add(account.user, {
            filename: 'upload',
            contentType: type,
            content,
            expires: new Date(Date.now() + limits.uploadTtl * 1000),
            quota: limits.uploadQuota,
            maxUploads: limits.maxUploads,
            size: content.length
        })
        .catch(err => Promise.reject(err.code === 'OverQuota' ? new SetError('overQuota', 'the blob does not fit in the upload quota') : err));
    return { id: blobId.upload(id), type, size: content.length };
}

async function upload(args, context) {
    checkArguments(args, ['accountId', 'create', 'update', 'destroy']);
    requireAccount(args, context);
    if (args.update !== undefined || args.destroy !== undefined) {
        throw invalidArguments('blobs can not be updated or destroyed');
    }
    if (!isObject(args.create)) {
        throw invalidArguments('create must be an object');
    }
    const entries = Object.entries(args.create);
    if (entries.length > context.limits.maxObjectsInSet) {
        throw new MethodError('requestTooLarge', { description: `more than ${context.limits.maxObjectsInSet} objects` });
    }
    if (entries.some(([creationId]) => !CREATION_ID.test(creationId))) {
        throw invalidArguments('invalid creation id');
    }

    const settings = settingsOf(context);
    const created = {};
    const notCreated = {};
    // octets one call may still create: blob references can multiply the data of a request
    let room = Math.max(settings.maxSizeBlobSet, context.limits.maxSizeUpload);
    // one creation at a time, in order: a later creation may use an earlier one as a source
    for (const [creationId, object] of entries) {
        try {
            if (!isObject(object)) {
                throw new SetError('invalidProperties', 'the object must be a JSON object');
            }
            const checked = checkUpload(object, settings);
            const content = await assemble(context, checked.sources, settings.maxSizeBlobSet, room);
            const result = await storeUpload(context, content, checked.type);
            room -= content.length;
            setOwn(created, creationId, result);
            setOwn(context.createdIds, creationId, result.id);
        } catch (err) {
            if (!(err instanceof SetError)) {
                throw err;
            }
            setOwn(notCreated, creationId, err.toSetError());
        }
    }
    return {
        accountId: context.account.id,
        created: Object.keys(created).length ? created : null,
        notCreated: Object.keys(notCreated).length ? notCreated : null
    };
}

// ---------------------------------------------------------------- Blob/get

const isUtf8 = content => {
    try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
        return true;
    } catch {
        return false;
    }
};

function checkGetProperties(properties) {
    if (properties === undefined || properties === null) {
        return ['data', 'size'];
    }
    if (!Array.isArray(properties) || !properties.every(property => typeof property === 'string')) {
        throw invalidArguments('properties must be a list of property names');
    }
    for (const property of properties) {
        const known = ['data', 'data:asText', 'data:asBase64', 'size'].includes(property);
        const digest = property.startsWith('digest:') && Object.hasOwn(DIGESTS, property.slice(7));
        if (!known && !digest) {
            throw invalidArguments(`unknown property ${property}`);
        }
    }
    return properties;
}

/** The Blob object for a read range */
function toBlob(id, range, properties) {
    const blob = { id };
    const wantsText = properties.includes('data:asText') || properties.includes('data');
    const wantsBase64 = properties.includes('data:asBase64');
    const content = range.content;
    if (wantsText || wantsBase64) {
        const text = wantsText && isUtf8(content);
        if (wantsText && (text || !properties.includes('data') || properties.includes('data:asText'))) {
            blob['data:asText'] = text ? content.toString('utf8') : null;
        }
        if (wantsBase64 || (properties.includes('data') && !text)) {
            blob['data:asBase64'] = content.toString('base64');
        }
        if (wantsText && !text) {
            blob.isEncodingProblem = true;
        }
    }
    for (const property of properties) {
        if (property.startsWith('digest:')) {
            blob[property] = crypto.createHash(DIGESTS[property.slice(7)]).update(content).digest('base64');
        }
    }
    if (properties.includes('size')) {
        blob.size = range.size;
    }
    if (range.truncated && properties.some(property => property !== 'size')) {
        blob.isTruncated = true;
    }
    return blob;
}

async function get(args, context) {
    checkArguments(args, ['accountId', 'ids', 'properties', 'offset', 'length']);
    requireAccount(args, context);
    if (!Array.isArray(args.ids) || !args.ids.every(id => typeof id === 'string')) {
        // RFC 8620 5.1: ids null asks for every blob, which is not supported
        throw invalidArguments('ids must be a list of blob ids');
    }
    if (args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    const properties = checkGetProperties(args.properties);
    if (!optionalUnsigned(args.offset) || !optionalUnsigned(args.length)) {
        throw invalidArguments('offset and length must be unsigned integers');
    }
    const offset = args.offset || 0;
    const length = isUnsigned(args.length) ? args.length : null;
    const skipContent = properties.every(property => property === 'size');
    // the call's own limit, within what is left of the response budget of the request
    const start = Math.min(settingsOf(context).maxSizeBlobGet, responseBudget.remaining(context));
    let budget = start;

    const list = [];
    const notFound = [];
    // one blob at a time: each one is held in memory until it is answered
    for (const reference of [...new Set(args.ids)]) {
        // a creation reference ("#c1") is answered with the id it stands for
        const id = resolveId(context, reference);
        const range =
            id &&
            (await readRange(context, id, { offset, length, budget, skipContent, wholeSize: properties.includes('size') }).catch(err =>
                Promise.reject(
                    err.code === 'BlobTooLarge' ? new MethodError('requestTooLarge', { description: 'the blobs are too large, ask for a range' }) : err
                )
            ));
        if (!range) {
            notFound.push(reference);
            continue;
        }
        budget -= range.content ? range.content.length : 0;
        list.push(toBlob(id, range, properties));
    }
    responseBudget.spend(context, start - budget);
    return { accountId: context.account.id, list, notFound };
}

// ---------------------------------------------------------------- Blob/lookup

function checkTypeNames(typeNames, context) {
    if (!Array.isArray(typeNames) || !typeNames.every(name => typeof name === 'string')) {
        throw invalidArguments('typeNames must be a list of type names');
    }
    // a type is only usable with its capability in using
    const unusable = typeNames.find(name => !Object.hasOwn(TYPE_CAPABILITIES, name) || !context.using.has(TYPE_CAPABILITIES[name]));
    if (unusable !== undefined) {
        throw new MethodError('unknownDataType', { description: `${unusable} is not a type that references blobs` });
    }
    return [...new Set(typeNames)];
}

/** The visible message documents the message and part blob ids name, by root */
async function referencedMessages(context, parsedIds) {
    const roots = [
        ...new Map(parsedIds.filter(parsed => parsed && ['message', 'part'].includes(parsed.kind)).map(parsed => [parsed.id.toString(), parsed.id])).values()
    ];
    if (!roots.length) {
        return new Map();
    }
    const withParts = parsedIds.some(parsed => parsed && parsed.kind === 'part');
    const projection = Object.assign({ thread: true }, VISIBILITY_FIELDS, withParts ? { mimeTree: true } : {});
    const [found, visible] = await Promise.all([
        resolveRoots(context.deps.database.collection('messages'), context.account.user, roots, { projection, maxTimeMS: consts.DB_MAX_TIME_MESSAGES }),
        visibility(context)
    ]);
    return new Map([...found].filter(([, doc]) => visible(doc)));
}

async function lookup(args, context) {
    checkArguments(args, ['accountId', 'typeNames', 'ids']);
    requireAccount(args, context);
    const typeNames = checkTypeNames(args.typeNames, context);
    if (!Array.isArray(args.ids) || !args.ids.every(id => typeof id === 'string')) {
        throw invalidArguments('ids must be a list of blob ids');
    }
    if (args.ids.length > context.limits.maxObjectsInGet) {
        throw new MethodError('requestTooLarge');
    }
    const ids = [...new Set(args.ids)];
    // a creation reference ("#c1") is answered with the id it stands for
    const resolved = ids.map(id => resolveId(context, id) || id);
    const parsedIds = resolved.map(parseBlobId);
    const docs = await referencedMessages(context, parsedIds);
    const media = typeNames.includes('ContactCard')
        ? await cardsOfMedia(
              context,
              parsedIds.filter(parsed => parsed && parsed.kind === 'media').map(parsed => parsed.id)
          )
        : new Map();
    const events = typeNames.includes('CalendarEvent') ? await eventsReferencing(context, resolved) : new Map();
    const messageHandler = context.deps.messageHandler;

    const list = resolved.map((id, index) => {
        const parsed = parsedIds[index];
        const doc = parsed && parsed.kind !== 'media' && docs.get(parsed.id.toString());
        const found = doc && (parsed.kind === 'message' || (parsed.kind === 'part' && partExists(messageHandler, doc.mimeTree, parsed.part)));
        const matches = {
            Email: () => (found ? [formatId('email', parsed.id)] : []),
            Thread: () => (found && doc.thread ? [formatId('thread', doc.thread)] : []),
            Mailbox: () => (found ? [formatId('mailbox', doc.mailbox)] : []),
            ContactCard: () => (parsed && parsed.kind === 'media' && media.get(parsed.id.toString())) || []
        };
        matches.CalendarEvent = () => events.get(id) || [];
        return { id, matchedIds: Object.fromEntries(typeNames.map(name => [name, matches[name]()])) };
    });
    return { accountId: context.account.id, list, notFound: [] };
}

module.exports = {
    capability: URN.blob,
    accountCapability,
    methods: { 'Blob/upload': upload, 'Blob/get': get, 'Blob/lookup': lookup },
    // exposed for unit tests
    checkSource,
    literalSize,
    readSlice,
    toBlob
};
