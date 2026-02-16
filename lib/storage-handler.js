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
 * @property {Buffer|string} content - File content as a Buffer (raw) or string (when base64-encoded).
 * @property {string} [cid] - Optional Content-ID for inline attachments (e.g. embedded images in HTML drafts).
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
            user
        };

        if (cid) {
            metadata.cid = cid;
        }

        return new Promise((resolve, reject) => {
            let store = this.gridstore.openUploadStream(filename, {
                contentType,
                metadata
            });

            store.on('error', err => {
                reject(err);
            });

            store.once('finish', () => {
                resolve(store.id);
            });

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
    async get(user, file) {
        // Query verifies both file existence and user ownership
        let fileData = await this.gridfs.collection('storage.files').findOne({
            _id: file,
            'metadata.user': user
        });

        if (!fileData) {
            let err = new Error('This file does not exist');
            err.responseCode = 404;
            err.code = 'FileNotFound';
            throw err;
        }

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
                    contentType: fileData.contentType,
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
    async delete(user, file) {
        // Query verifies both file existence and user ownership before deletion
        let fileData = await this.gridfs.collection('storage.files').findOne({
            _id: file,
            'metadata.user': user
        });

        if (!fileData) {
            let err = new Error('This file does not exist');
            err.responseCode = 404;
            err.code = 'FileNotFound';
            throw err;
        }

        // Deletes the files document and all associated chunks from GridFS
        return this.gridstore.delete(file);
    }
}

module.exports = StorageHandler;
