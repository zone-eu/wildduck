'use strict';

const crypto = require('crypto');
const { Readable, PassThrough, pipeline } = require('stream');
const { S3Client, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { prepareStoredBody, createReadWindow } = require('./base64-codec');

class S3Storage {
    constructor(options) {
        const config = (options.options && options.options.s3) || {};
        this.bucket = config.bucket;
        this.prefix = (config.prefix || '').replace(/^\/+|\/+$/g, '');
        this.decodeBase64 = !!(options.options && options.options.decodeBase64);
        if (!this.bucket || !this.prefix) {
            throw new Error('S3 attachments require s3.bucket and a nonempty s3.prefix');
        }
        this.client =
            options.s3Client ||
            new S3Client({
                region: config.region || 'us-east-1',
                endpoint: config.endpoint || undefined,
                forcePathStyle: !!config.forcePathStyle,
                maxAttempts: config.maxAttempts || 3
            });
    }

    /**
     * Object key of one stored copy of an attachment. Every upload gets its own random generation, so a
     * key is written exactly once: writers racing on the same hash, or storing it with a different
     * decodeBase64 setting, never overwrite each other, and deleting an old copy can never remove a newer
     * one. Readers always take the key from the catalog record, never from the hash.
     *
     * @param {Buffer} id Attachment id (hash of the encoded body)
     * @param {String} generation Random generation id of this copy
     * @returns {String}
     */
    key(id, generation) {
        const hex = id.toString('hex');
        return `${this.prefix}/attachments/v1/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}.${generation}`;
    }

    /**
     * Attachment id of an object key written by key() under this prefix
     *
     * @param {String} key Object key
     * @returns {Buffer|null} Attachment id, or null when the key is not an attachment copy
     */
    parseKey(key) {
        const base = `${this.prefix}/attachments/v1/`;
        const match = key.startsWith(base) && /^([0-9a-f]{2})\/([0-9a-f]{2})\/(\1\2[0-9a-f]{60})\.[0-9a-f]{16}$/.exec(key.slice(base.length));
        return match ? Buffer.from(match[3], 'hex') : null;
    }

    prepare(attachment) {
        const { data, metadata } = prepareStoredBody(attachment, { decodeBase64: this.decodeBase64 });
        return { body: data, metadata: { ...metadata, m: attachment.magic, c: 1, cu: new Date() } };
    }

    /**
     * Uploads one copy of an attachment payload with a single PutObject. S3 checks the SHA-256 of the
     * received bytes against ChecksumSHA256 and rejects the request on a mismatch, so a stored object
     * never needs to be read back to be trusted
     *
     * @param {Buffer} id Attachment id
     * @param {Buffer|Readable} body Stored bytes, or a stream of exactly `length` bytes
     * @param {Number} length Number of stored bytes
     * @param {Buffer} checksum SHA-256 of the stored bytes
     * @returns {Object} Locator `{ bucket, key, length }`
     */
    async put(id, body, length, checksum) {
        const key = this.key(id, crypto.randomBytes(8).toString('hex'));
        await this.client.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: body,
                ContentLength: length,
                ChecksumSHA256: checksum.toString('base64')
            })
        );
        return { bucket: this.bucket, key, length };
    }

    /**
     * Uploads a new copy and lets `commit` point a catalog record at it. A copy that `commit` definitely
     * did not reference (it returned false, or the record already existed) is deleted again; when the
     * outcome is unknown the copy is kept, since the record may have been stored after all
     *
     * @param {Buffer} id Attachment id
     * @param {Buffer|Readable} body Stored bytes
     * @param {Number} length Number of stored bytes
     * @param {Buffer} checksum SHA-256 of the stored bytes
     * @param {Function} commit `async location => Boolean` storing the locator
     * @returns {Object|false} Locator, or false when commit declined it
     */
    async store(id, body, length, checksum, commit) {
        const location = await this.put(id, body, length, checksum);
        let committed;
        try {
            committed = await commit(location);
        } catch (err) {
            if (err.code === 11000) {
                await this.deletePayload(location).catch(() => false);
            }
            throw err;
        }
        if (!committed) {
            await this.deletePayload(location).catch(() => false);
            return false;
        }
        return location;
    }

    createReadStream(id, attachmentData, options) {
        const location = attachmentData.metadata.storage;
        if (!location || location.backend !== 's3' || !location.bucket || !location.key) {
            throw new Error('Invalid S3 attachment locator');
        }
        return createReadWindow((start, end) => this.openRange(location, attachmentData.length, start, end), attachmentData, options);
    }

    // the codec reads ranges synchronously, the S3 request is async; tearing the stream down aborts the request
    openRange(location, length, start, end) {
        const output = new PassThrough();
        const controller = new AbortController();
        output.once('close', () => controller.abort());
        this.openReadStream(location, length, { start, end }, controller.signal)
            .then(input => {
                if (output.destroyed) {
                    input.destroy();
                    return;
                }
                pipeline(input, output, err => {
                    if (err) {
                        output.destroy(err);
                    }
                });
            })
            .catch(err => output.destroy(err));
        return output;
    }

    async openReadStream(location, length, { start, end }, abortSignal) {
        const locator = { Bucket: location.bucket, Key: location.key };
        if (start >= end) {
            const head = await this.client.send(new HeadObjectCommand(locator), { abortSignal });
            if (Number(head.ContentLength) !== length) {
                throw new Error('S3 attachment length mismatch');
            }
            return Readable.from([]);
        }
        const requestedRange = start !== 0 || end !== length;
        const result = await this.client.send(new GetObjectCommand({ ...locator, Range: requestedRange ? `bytes=${start}-${end - 1}` : undefined }), {
            abortSignal
        });
        if ((requestedRange && result.ContentRange !== `bytes ${start}-${end - 1}/${length}`) || Number(result.ContentLength) !== end - start) {
            result.Body?.destroy();
            throw new Error('S3 attachment response range or length mismatch');
        }
        return result.Body;
    }

    async deletePayload(location) {
        await this.client.send(new DeleteObjectCommand({ Bucket: location.bucket, Key: location.key }));
    }
}

module.exports = S3Storage;
