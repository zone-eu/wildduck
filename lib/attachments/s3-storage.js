'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');
const {
    S3Client,
    HeadObjectCommand,
    CopyObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    CreateMultipartUploadCommand,
    UploadPartCopyCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const prepareAttachment = require('./prepare-attachment');
const { getReadOptions, createOutputStream, pipeAttachment } = require('./attachment-stream');

const MAX_COPY_BYTES = 5 * 1024 * 1024 * 1024;
const COPY_PART_BYTES = 512 * 1024 * 1024;

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

    key(id) {
        const hex = id.toString('hex');
        return `${this.prefix}/attachments/v1/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
    }

    prepare(attachment) {
        return prepareAttachment(attachment, this.decodeBase64);
    }

    async head(key) {
        try {
            return await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
        } catch (err) {
            if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                return null;
            }
            throw err;
        }
    }

    async publish(id, body, checksum) {
        return this.publishStream(id, () => body, body.length, checksum);
    }

    async publishStream(id, openStream, length, checksum) {
        const key = this.key(id);
        const existing = await this.head(key);
        if (existing) {
            this.verify(existing, length, checksum);
            return { bucket: this.bucket, key, length };
        }
        const stagingKey = `${this.prefix}/attachments/staging/${id.toString('hex')}/${crypto.randomUUID()}`;
        try {
            await new Upload({
                client: this.client,
                params: { Bucket: this.bucket, Key: stagingKey, Body: openStream(), Metadata: { sha256: checksum } },
                leavePartsOnError: false
            }).done();
            const staged = await this.head(stagingKey);
            this.verify(staged, length, checksum);
            await this.copyStaged(stagingKey, key, length, checksum);
            this.verify(await this.head(key), length, checksum);
            return { bucket: this.bucket, key, length };
        } finally {
            await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: stagingKey })).catch(() => false);
        }
    }

    async copyStaged(stagingKey, key, length, checksum) {
        const source = `${this.bucket}/${stagingKey.split('/').map(encodeURIComponent).join('/')}`;
        if (length <= MAX_COPY_BYTES) {
            try {
                await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: key, CopySource: source, IfNoneMatch: '*' }));
            } catch (err) {
                if (err.$metadata?.httpStatusCode !== 412) {
                    throw err;
                }
            }
            return;
        }

        const parts = Math.ceil(length / COPY_PART_BYTES);
        if (parts > 10000) {
            throw new Error('S3 attachment exceeds maximum multipart copy size');
        }
        const created = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, Metadata: { sha256: checksum } }));
        const uploadId = created.UploadId;
        try {
            const completed = [];
            for (let number = 1; number <= parts; number++) {
                const first = (number - 1) * COPY_PART_BYTES;
                const last = Math.min(length, first + COPY_PART_BYTES) - 1;
                const copied = await this.client.send(
                    new UploadPartCopyCommand({
                        Bucket: this.bucket,
                        Key: key,
                        UploadId: uploadId,
                        PartNumber: number,
                        CopySource: source,
                        CopySourceRange: `bytes=${first}-${last}`
                    })
                );
                completed.push({ PartNumber: number, ETag: copied.CopyPartResult.ETag });
            }
            await this.client.send(
                new CompleteMultipartUploadCommand({
                    Bucket: this.bucket,
                    Key: key,
                    UploadId: uploadId,
                    MultipartUpload: { Parts: completed },
                    IfNoneMatch: '*'
                })
            );
        } catch (err) {
            await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch(() => false);
            if (err.$metadata?.httpStatusCode !== 412) {
                throw err;
            }
        }
    }

    verify(head, length, checksum) {
        if (!head || Number(head.ContentLength) !== length || head.Metadata?.sha256 !== checksum) {
            throw new Error('S3 attachment length or checksum metadata mismatch');
        }
    }

    async verifyContent(location, length, checksum) {
        const result = await this.client.send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key }));
        const hash = crypto.createHash('sha256');
        let received = 0;
        for await (const chunk of result.Body) {
            hash.update(chunk);
            received += chunk.length;
        }
        if (received !== length || hash.digest('hex') !== checksum) {
            throw new Error('S3 attachment content checksum mismatch');
        }
    }

    createReadStream(id, attachmentData, options) {
        const location = attachmentData.metadata.storage;
        if (!location || location.backend !== 's3' || !location.bucket || !location.key) {
            throw new Error('Invalid S3 attachment locator');
        }
        const { streamOptions, encoderOptions, outputLength } = getReadOptions(attachmentData, options || {});
        const output = createOutputStream(outputLength);
        const controller = new AbortController();
        output.once('close', () => controller.abort());
        this.openReadStream(location, attachmentData.length, streamOptions, controller.signal)
            .then(input => pipeAttachment(input, output, encoderOptions))
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
