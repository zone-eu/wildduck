'use strict';

/**
 * @module storage-handler
 * @description Manages per-user file storage backed by MongoDB GridFS. Files stored here are
 * typically draft attachments uploaded via the REST API (`POST /users/:user/storage`) and later
 * attached to outgoing messages. The download route (`GET /users/:user/storage/:file`) bypasses
 * the `get()` method and streams directly from the public `gridstore` property via
 * `gridstore.openDownloadStream()`.
 */

const GridFSBucket = require('mongodb').GridFSBucket;

// temporary uploads removed per round by removeUploads()
const EXPIRY_BATCH = 100;
// temporary uploads expiring after this are referenced (pinned) and never evicted to make room
const PINNED_UPLOADS = new Date('9000-01-01T00:00:00Z');
const libbase64 = require('libbase64');
const libmime = require('libmime');

/**
 * @typedef {Object} StorageHandlerOptions
 * @property {import('mongodb').Db} database - Primary MongoDB database connection
 * @property {import('mongodb').Db} [gridfs] - GridFS database connection (defaults to `database`)
 * @property {import('mongodb').Db} [users] - Users database connection (defaults to `database`)
 * @property {Function} [loggelf] - Graylog logging function (accepted but unused by this class)
 */

/**
 * @typedef {Object} FileAddOptions
 * @property {string} [filename] - Original filename. If omitted, one is generated from the date and contentType.
 * @property {string} [contentType] - MIME type. If omitted, inferred from filename or defaults to `application/octet-stream`.
 * @property {string} [encoding] - Content encoding identifier. When falsy or omitted, `content` is
 *   written directly to GridFS as raw bytes — the caller is expected to provide a Buffer (or a string
 *   that Node.js writable streams accept). When set to `'base64'`, the `content` string is piped
 *   through a `libbase64.Decoder` that strips base64 encoding before writing the decoded bytes to
 *   GridFS. `'base64'` is the only value accepted by the storage API route's Joi validation
 *   (`.valid('base64')`); the message submission route defaults it to `'base64'` as well. Internally
 *   any truthy value triggers the same base64 decode path — there is no branching for other encodings.
 * @property {Buffer|string|import('stream').Readable} content - File content as a Buffer (raw), a string (when
 *   base64-encoded) or a readable stream of raw bytes.
 * @property {string} [cid] - Optional Content-ID for inline attachments (e.g. embedded images in HTML drafts).
 * @property {Date} [expires] - Makes the file a temporary upload, removed by the GC after this time
 * @property {number} [quota] - Upload quota in bytes for temporary uploads (see makeRoom)
 * @property {number} [size] - Expected size in bytes, checked against `quota` before storing; the stored file is
 *   checked again afterwards (see fitUpload)
 * @property {number} [maxUploads] - Most temporary uploads of the user, checked with `quota` (see makeRoom)
 */

/**
 * @typedef {Object} StoredFileData
 * @property {string} id - Hex string of the GridFS file ObjectId
 * @property {string} filename - Stored filename
 * @property {string} contentType - MIME type
 * @property {number} size - File size in bytes
 * @property {Buffer} content - Entire file content buffered in memory
 * @property {string} [cid] - Content-ID if one was set during upload
 */

/**
 * Handles user-scoped file storage operations using MongoDB GridFS. Files are stored in the
 * `storage.files` / `storage.chunks` collections with a 255 KB chunk size. Each file's metadata
 * includes the owning user's ObjectId, ensuring all read and delete operations are user-scoped.
 *
 * Used by the storage REST API routes (`lib/api/storage.js`) and the message submission route
 * (`lib/api/messages.js`) to attach uploaded files to outgoing draft messages.
 */
class StorageHandler {
    /**
     * Creates a new StorageHandler instance.
     *
     * @param {StorageHandlerOptions} options - Configuration options
     * @example
     * const storageHandler = new StorageHandler({
     *     database: db.database,
     *     users: db.users,
     *     gridfs: db.gridfs,
     *     loggelf: message => loggelf(message)
     * });
     */
    constructor(options) {
        this.database = options.database;
        this.gridfs = options.gridfs || options.database;
        this.users = options.users || options.database;
        this.bucketName = 'storage';

        this.gridstore = new GridFSBucket(this.gridfs, {
            bucketName: this.bucketName,
            chunkSizeBytes: 255 * 1024
        });
    }

    /**
     * Stores a file in GridFS for the given user. If neither `filename` nor `contentType` is
     * provided, a date-based filename with `.bin` extension and `application/octet-stream` type
     * is generated. If only one is provided, the other is inferred using libmime. When
     * `options.encoding` is set (e.g. `'base64'`), the content is piped through a base64 decoder
     * before being written to GridFS.
     *
     * @param {import('mongodb').ObjectId} user - Owner user's ObjectId, stored in file metadata
     * @param {FileAddOptions} options - File data and metadata
     * @returns {Promise<import('mongodb').ObjectId>} The ObjectId of the newly stored GridFS file
     * @throws {Error} If the GridFS upload stream emits an error or content writing fails
     * @example
     * // Raw binary upload
     * let fileId = await storageHandler.add(userId, {
     *     filename: 'report.pdf',
     *     contentType: 'application/pdf',
     *     content: pdfBuffer
     * });
     *
     * @example
     * // Base64-encoded upload (from REST API)
     * let fileId = await storageHandler.add(userId, {
     *     filename: 'image.png',
     *     contentType: 'image/png',
     *     encoding: 'base64',
     *     content: base64String,
     *     cid: 'unique-cid@domain'
     * });
     */
    async add(user, options) {
        let { filename, contentType, cid } = options;

        // Generate a date-based default filename stem (e.g. 'upload-2024-01-15')
        let filebase = 'upload-' + new Date().toISOString().substr(0, 10);

        // Infer missing filename or contentType from whichever one is provided
        if (!contentType && !filename) {
            filename = filebase + '.bin';
            contentType = 'application/octet-stream';
        } else if (!contentType) {
            contentType = libmime.detectMimeType(filename) || 'application/octet-stream';
        } else if (!filename) {
            filename = filebase + '.' + libmime.detectExtension(contentType);
        }

        // Build GridFS metadata; user scopes the file for ownership checks in get/delete
        let metadata = {
            user,
            // mongodb 7's GridFS upload stream only persists custom metadata, not the legacy contentType option
            contentType
        };

        if (cid) {
            metadata.cid = cid;
        }

        if (options.expires) {
            // a temporary upload (JMAP): removed by the GC once it expires, and counted against the upload quota
            metadata.expires = options.expires;
            if (options.quota) {
                await this.makeRoom(user, options.size || 0, options.quota, { maxUploads: options.maxUploads });
            }
        }

        const id = await this.writeFile(filename, metadata, options);
        if (options.expires && options.quota) {
            // parallel uploads all found room before any of them was stored
            await this.fitUpload(user, id, options.quota, { maxUploads: options.maxUploads });
        }
        return id;
    }

    /** Writes the content of add() to the bucket; resolves with the id of the new file */
    writeFile(filename, metadata, options) {
        return new Promise((resolve, reject) => {
            let store = this.gridstore.openUploadStream(filename, {
                metadata
            });

            store.on('error', err => {
                reject(err);
            });

            store.once('finish', () => {
                resolve(store.id);
            });

            if (options.content && typeof options.content.pipe === 'function') {
                // a stream of raw bytes is written without buffering it; a failed source removes the chunks
                // written so far
                options.content.once('error', err => {
                    // settled first, so the abort error of the store does not replace the cause
                    reject(err);
                    options.content.unpipe(store);
                    store.abort().catch(() => false);
                });
                options.content.pipe(store);
                return;
            }

            if (!options.encoding) {
                // content is not encoded, pass on as is
                try {
                    store.end(options.content);
                } catch (err) {
                    reject(err);
                }
                return;
            }

            // Pipe content through a base64 decoder before writing to GridFS
            let decoder = new libbase64.Decoder();
            decoder.pipe(store);

            decoder.once('error', err => {
                // pass error forward
                store.emit('error', err);
            });

            try {
                decoder.end(options.content);
            } catch (err) {
                return reject(err);
            }
        });
    }

    /**
     * Retrieves a file from GridFS, buffering the entire content into memory. The file must
     * belong to the specified user (verified via `metadata.user`). Returns file metadata along
     * with the full content as a Buffer.
     *
     * Note: The entire file is buffered in memory (suitable for files up to the system's 64 MB
     * message size limit). For streaming large files to HTTP responses, use
     * `storageHandler.gridstore.openDownloadStream(fileId)` directly as the download route does.
     *
     * @param {import('mongodb').ObjectId} user - Owner user's ObjectId for ownership verification
     * @param {import('mongodb').ObjectId} file - GridFS file ObjectId to retrieve
     * @returns {Promise<StoredFileData>} File metadata and buffered content
     * @throws {Error} Throws with `responseCode: 404` and `code: 'FileNotFound'` if the file
     *   does not exist or does not belong to the user
     * @throws {Error} If the GridFS download stream emits an error
     * @example
     * let fileData = await storageHandler.get(userId, new ObjectId(fileId));
     * // fileData: { id, filename, contentType, size, content: Buffer, cid }
     */
    async get(user, file, options) {
        let fileData = await this.findOwned(user, file, options);

        // Stream the file from GridFS and buffer all chunks into a single Buffer
        return new Promise((resolve, reject) => {
            let stream = this.gridstore.openDownloadStream(file);
            let chunks = [];
            let chunklen = 0;

            stream.once('error', err => {
                reject(err);
            });

            stream.on('readable', () => {
                let chunk;
                while ((chunk = stream.read()) !== null) {
                    chunks.push(chunk);
                    chunklen += chunk.length;
                }
            });

            stream.once('end', () => {
                resolve({
                    id: fileData._id.toString(),
                    filename: fileData.filename,
                    contentType: fileData.metadata?.contentType || fileData.contentType,
                    size: fileData.length,
                    content: Buffer.concat(chunks, chunklen),
                    cid: fileData.metadata?.cid
                });
            });
        });
    }

    /**
     * Deletes a file from GridFS. The file must belong to the specified user (verified via
     * `metadata.user`). Removes both the `storage.files` document and all associated
     * `storage.chunks` documents. Typically called to clean up uploaded attachments after a
     * draft message is submitted for delivery.
     *
     * @param {import('mongodb').ObjectId} user - Owner user's ObjectId for ownership verification
     * @param {import('mongodb').ObjectId} file - GridFS file ObjectId to delete
     * @returns {Promise<void>}
     * @throws {Error} Throws with `responseCode: 404` and `code: 'FileNotFound'` if the file
     *   does not exist or does not belong to the user
     * @example
     * await storageHandler.delete(userId, new ObjectId(fileId));
     */
    async delete(user, file, options) {
        await this.findOwned(user, file, options);
        await this.deleteFiles([file]);
    }

    /**
     * The files document of a file the user owns. Storage files and temporary uploads (JMAP) share the
     * bucket but not their callers: a lookup finds one kind only.
     *
     * @param {Object} [options] {temporary: true finds a temporary upload, otherwise a storage file}
     * @throws {Error} With `responseCode: 404` and `code: 'FileNotFound'` if the file does not exist,
     *   belongs to another user or is of the other kind
     */
    async findOwned(user, file, options = {}) {
        // Query verifies both file existence and user ownership
        let fileData = await this.gridfs.collection('storage.files').findOne({
            _id: file,
            'metadata.user': user,
            'metadata.expires': { $exists: !!options.temporary }
        });

        if (!fileData) {
            let err = new Error('This file does not exist');
            err.responseCode = 404;
            err.code = 'FileNotFound';
            throw err;
        }
        return fileData;
    }

    /**
     * Opens a file the user owns for reading, without buffering it.
     *
     * @param {Object} [options] See findOwned
     * @returns {Promise<{fileData: Object, stream: Readable}>} The files document and a stream of the content
     */
    async openStream(user, file, options) {
        let fileData = await this.findOwned(user, file, options);
        return { fileData, stream: this.gridstore.openDownloadStream(file) };
    }

    /**
     * Makes room for a temporary upload of `size` bytes within the user's upload quota. Following
     * RFC 8620 section 6.1, temporary uploads are deleted oldest first until the new one fits; the
     * upload is refused only if it does not fit even then. Permanent storage files are not counted.
     *
     * The bytes and the number of the user's temporary uploads come from one aggregate over the
     * `user_temporary_usage` index, as a covered query (no files documents are read).
     * Uploads a calendar event names (pinned) count but are never deleted.
     *
     * @param {Object} [options] {maxUploads: most temporary uploads of the user, none when not set;
     *   keep: id of an upload stored already, counted but never deleted (see fitUpload)}
     * @throws {Error} With `code: 'OverQuota'` if the upload does not fit
     */
    async makeRoom(user, size, quota, options = {}) {
        // expires is always a Date: $type (unlike $exists) lets the usage aggregate run on the index alone
        const temporary = { 'metadata.user': user, 'metadata.expires': { $type: 'date' } };
        let usage = await this.uploadUsage(temporary);
        // an upload stored already is in the aggregate, a new one is one more
        const incoming = options.keep ? 0 : 1;
        const fits = () => usage.used + size <= (quota || Infinity) && usage.count + incoming <= (options.maxUploads || Infinity);

        if (fits()) {
            return;
        }

        // a stored upload (keep) answers only for itself and the uploads stored before it. Uploads stored
        // later make room for themselves, so parallel uploads never refuse each other, and the last one
        // stored brings the total back within the quota
        const scope = options.keep ? await this.storedUpTo(temporary, options.keep) : temporary;
        if (options.keep) {
            usage = await this.uploadUsage(scope);
        }
        if (!fits()) {
            await this.evictUploads(scope, usage, fits, options.keep);
            // parallel uploads add and delete files too: refuse only on what is there now
            usage = await this.uploadUsage(scope);
        }

        if (!fits()) {
            let err = new Error('Upload quota exceeded');
            err.responseCode = 413;
            err.code = 'OverQuota';
            throw err;
        }
    }

    /** The query of the uploads stored no later than the given one (by uploadDate, then _id) */
    async storedUpTo(temporary, id) {
        const own = await this.gridfs.collection('storage.files').findOne({ _id: id }, { projection: { uploadDate: true } });
        if (!own) {
            return Object.assign({}, temporary, { _id: id });
        }
        return Object.assign({}, temporary, {
            $or: [{ uploadDate: { $lt: own.uploadDate } }, { uploadDate: own.uploadDate, _id: { $lte: id } }]
        });
    }

    /** Bytes and number of the temporary uploads a query matches: {used, count} */
    async uploadUsage(query) {
        const [usage] = await this.gridfs
            .collection('storage.files')
            .aggregate([{ $match: query }, { $group: { _id: null, used: { $sum: '$length' }, count: { $sum: 1 } } }])
            .toArray();
        return { used: usage ? usage.used : 0, count: usage ? usage.count : 0 };
    }

    /**
     * Deletes unreferenced temporary uploads oldest first until `fits()` is true; `usage` is updated in place.
     *
     * @param {Object} temporary query of the user's temporary uploads
     * @param {ObjectId} [keep] an upload that is not deleted
     */
    async evictUploads(temporary, usage, fits, keep) {
        // uploads a calendar event names (expiring in the year 9999, lib/jmap/types/calendar-event.js) stay
        const unreferenced = Object.assign({}, temporary, { 'metadata.expires': { $lt: PINNED_UPLOADS } });
        if (keep) {
            unreferenced._id = { $ne: keep };
        }
        const cursor = this.gridfs
            .collection('storage.files')
            .find(unreferenced, { projection: { _id: true, length: true } })
            .sort({ uploadDate: 1 });
        for await (const fileData of cursor) {
            if (fits()) {
                break;
            }
            // gone afterwards unless the deletion failed, also when a parallel call deleted it first
            const gone = await this.deleteFiles([fileData._id]).then(
                () => true,
                () => false
            );
            if (gone) {
                usage.used -= fileData.length;
                usage.count--;
            }
        }
    }

    /**
     * Checks a temporary upload once it is stored. makeRoom() runs before an upload is stored, so parallel
     * uploads can each find room for themselves and go over the quota together: older uploads are
     * deleted now, and the upload itself is removed again if it does not fit even then.
     *
     * @param {Object} [options] {maxUploads}, see makeRoom
     * @throws {Error} With `code: 'OverQuota'` if the upload was removed
     */
    async fitUpload(user, id, quota, options = {}) {
        try {
            await this.makeRoom(user, 0, quota, Object.assign({}, options, { keep: id }));
        } catch (err) {
            if (err.code === 'OverQuota') {
                await this.deleteFiles([id]).catch(() => false);
            }
            throw err;
        }
    }

    /**
     * Deletes files of the bucket, the chunks first: a files document left behind by a failure is found
     * and deleted again later, chunks without one would never be (nothing sweeps storage.chunks, and
     * GridFSBucket.delete() does it the other way round).
     *
     * @param {ObjectId[]} ids
     * @returns {Promise<Number>} Number of deleted files documents
     */
    async deleteFiles(ids) {
        await this.gridfs.collection('storage.chunks').deleteMany({ files_id: { $in: ids } });
        return (await this.gridfs.collection('storage.files').deleteMany({ _id: { $in: ids } })).deletedCount;
    }

    /**
     * Deletes the temporary uploads a query matches, a batch at a time, until none are left or the
     * deadline passes.
     *
     * @param {Object} query storage.files query, limited to temporary uploads ({'metadata.expires': ...})
     *   and backed by one of their indexes
     * @param {Object} [options] {deadline: epoch ms, batchSize}
     * @returns {Promise<Number>} Number of deleted files
     */
    async removeUploads(query, options = {}) {
        const files = this.gridfs.collection('storage.files');
        const batchSize = options.batchSize || EXPIRY_BATCH;
        let deleted = 0;
        for (;;) {
            const ids = (
                await files
                    .find(query, { projection: { _id: true } })
                    .limit(batchSize)
                    .toArray()
            ).map(fileData => fileData._id);
            if (!ids.length) {
                return deleted;
            }
            // if deleting the files documents fails, the next round finds them again
            deleted += await this.deleteFiles(ids);
            if (ids.length < batchSize || (options.deadline && Date.now() > options.deadline)) {
                return deleted;
            }
        }
    }

    /**
     * Deletes expired temporary uploads. Called by the garbage collector of the task runner.
     *
     * @param {Object} [options] {deadline: epoch ms}
     * @returns {Promise<Number>} Number of deleted files
     */
    async removeExpiredUploads(options = {}) {
        return this.removeUploads({ 'metadata.expires': { $lt: new Date() } }, options);
    }
}

module.exports = StorageHandler;
