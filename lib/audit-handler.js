'use strict';

const ObjectId = require('mongodb').ObjectId;
const GridFSBucket = require('mongodb').GridFSBucket;
const log = require('npmlog');
const libmime = require('libmime');
const { normalizeAddress } = require('./tools');
const TaskHandler = require('./task-handler');

class AuditHandler {
    constructor(options) {
        this.options = options || {};

        this.database = options.database;
        this.users = options.user || options.database;
        this.gridfs = options.gridfs || options.database;

        this.loggelf = options.loggelf || (() => false);

        this.taskHandler = new TaskHandler({ database: this.database });

        this.bucketName = this.options.bucket || 'audit';
        this.gridstore = new GridFSBucket(this.gridfs, {
            bucketName: this.bucketName,
            chunkSizeBytes: 255 * 1024,
            writeConcern: { w: this.options.writeConcern || 1 }
        });
    }

    async create(options) {
        options = options || {};

        if (!options.user || !ObjectId.isValid(options.user)) {
            let err = new Error('Missing user ID');
            err.responseCode = 400;
            err.code = 'InputValidationError';
            throw err;
        }

        let auditData = {
            user: typeof options.user === 'string' ? new ObjectId(options.user) : options.user,
            start: options.start, // Date or null
            end: options.end, // Date or null
            expires: options.expires, // Date
            deleted: false, // Boolean
            notes: options.notes, // String
            meta: options.meta || {}, // Object

            import: {
                status: 'queued',
                failed: 0,
                copied: 0
            },

            audited: 0,
            lastAuditedMessage: null
        };

        let r;
        try {
            r = await this.database.collection('audits').insertOne(auditData);
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!r.insertedId) {
            let err = new Error('Failed to create audit entry');
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        auditData._id = r.insertedId;

        try {
            await this.taskHandler.add('audit', {
                audit: auditData._id,
                user: auditData.user,
                start: auditData.start,
                end: auditData.end
            });
        } catch (err) {
            // try to rollback
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';

            try {
                await this.database.collection('audits').deleteOne({ _id: auditData._id });
            } catch (e) {
                // ignore
            }

            throw err;
        }

        return auditData._id;
    }

    /**
     * Store message to audit GridFS
     *
     * @param {ObjectId} audit ID of the audit session
     * @param {Mixed} message Either a Buffer, an Array of Buffers or a Stream
     * @param {Object} metadata Metadata for the stored message
     */
    async store(audit, message, metadata, skipCounters) {
        if (!message) {
            throw new Error('Missing message content');
        }

        if (typeof message === 'string') {
            message = Buffer.from(message);
        }

        let id = new ObjectId();

        metadata = metadata || {};
        metadata.audit = metadata.audit || audit;
        metadata.date = metadata.date || new Date();

        const headers = metadata.header || {};

        metadata.subject = ([].concat(headers.subject || []).pop() || '').trim();
        try {
            metadata.subject = libmime.decodeWords(metadata.subject);
        } catch (E) {
            // ignore
        }

        metadata.addresses = [];
        ['from', 'to', 'cc', 'bcc'].forEach(type => {
            if (Array.isArray(headers[type])) {
                headers[type].forEach(addr => {
                    let entry = {
                        name: addr.name,
                        address: normalizeAddress(addr.address),
                        type
                    };
                    try {
                        entry.name = libmime.decodeWords(entry.name);
                    } catch (E) {
                        // ignore
                    }
                    metadata.addresses.push(entry);
                });
            }
        });

        let result = await new Promise((resolve, reject) => {
            let stream = this.gridstore.openUploadStreamWithId(id, null, {
                contentType: 'message/rfc822',
                metadata
            });

            stream.on('error', err => reject(err));
            stream.once('finish', () => resolve(id));

            if (Buffer.isBuffer(message)) {
                message = [message];
            }

            let writeChunks = async () => {
                // write chunk by chunk
                for (let chunk of message) {
                    if (stream.write(chunk) === false) {
                        await new Promise(resolve => {
                            stream.once('drain', resolve);
                        });
                    }
                }
                stream.end();
            };

            if (Array.isArray(message)) {
                return writeChunks().catch(err => reject(err));
            }

            message.on('error', err => {
                stream.emit('error', err);
            });

            message.pipe(stream);
        });

        if (result && !skipCounters) {
            await this.database.collection('audits').updateOne({ _id: metadata.audit }, { $inc: { audited: 1 }, $set: { lastAuditedMessage: new Date() } });
        }

        return result;
    }

    /**
     * Retrieve message from audit GridFS
     *
     * @param {ObjectId} audit ID of the audit session
     * @param {Mixed} message Either a Buffer, an Array of Buffers or a Stream
     * @param {Object} metadata Metadata for the stored message
     */
    async retrieve(id) {
        let row = await this.gridfs.collection('audit.files').findOne({ _id: id });
        if (!row) {
            return false;
        }

        return new Promise((resolve, reject) => {
            try {
                let stream = this.gridstore.openDownloadStream(id);
                if (stream) {
                    resolve(stream);
                } else {
                    reject(new Error('Failed to open stream'));
                }
            } catch (err) {
                reject(err);
            }
        });
    }

    async updateDeliveryStatus(queueId, seq, status, info) {
        await this.gridfs.collection('audit.files').updateMany(
            { 'metadata.info.queueId': queueId },
            {
                $push: {
                    'metadata.info.delivery': {
                        seq,
                        status,
                        time: new Date(),
                        info
                    }
                }
            }
        );
    }

    async removeAudit(auditData) {
        let cursor = await this.gridfs.collection('audit.files').find({
            'metadata.audit': auditData._id
        });

        let messages = 0;
        let messageData;
        while ((messageData = await cursor.next())) {
            try {
                await this.gridstore.delete(messageData._id);
                messages++;
            } catch (err) {
                log.error('Audit', 'Failed to delete message %s. %s', messageData._id, err.message);
            }
        }
        await cursor.close();

        await this.database.collection('audits').updateOne({ _id: auditData._id }, { $set: { deleted: true, deletedTime: new Date() } });
        log.info('Audit', 'Deleted audit %s (%s messages)', auditData._id, messages);
        return {
            audit: auditData._id,
            messages
        };
    }

    async cleanExpired() {
        let expiredAudits = await this.database
            .collection('audits')
            .find({
                expires: { $lt: new Date() },
                deleted: false
            })
            .toArray();

        for (let auditData of expiredAudits) {
            try {
                await this.removeAudit(auditData);
            } catch (err) {
                log.error('Audit', 'Failed to delete expired audit %s. %s', auditData._id, err.message);
            }
        }
    }
}

module.exports = AuditHandler;
