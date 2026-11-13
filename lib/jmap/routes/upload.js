'use strict';

// POST /jmap/upload/{accountId}/ (RFC 8620 6.1)
//
// The body is streamed into the storage bucket as a temporary upload, never buffered and never
// parsed, whatever its media type. It expires after uploadTtl, counts against the per user upload
// quota (oldest unreferenced uploads are evicted to make room), not against the mail quota. Content a
// message was built from is copied into the message, so the message outlives the upload.

const { Transform } = require('stream');
const { RequestProblem } = require('../errors');
const { blobId, MEDIA_TYPE } = require('../ids');
const { acquireSlot } = require('../server');

const tooLarge = limit => new RequestProblem('limit', 413, `The upload is larger than ${limit} octets`, { limit: 'maxSizeUpload' });

/** Counts the bytes going through and fails once they pass the limit */
function sizeLimit(limit) {
    let size = 0;
    const counter = new Transform({
        transform(chunk, encoding, done) {
            size += chunk.length;
            done(size > limit ? tooLarge(limit) : null, chunk);
        }
    });
    counter.size = () => size;
    return counter;
}

module.exports = ({ app, route, context, limits, deps }) => {
    const upload = async (request, reply) => {
        const requestContext = context(request, { capabilities: {}, state: null });
        const account = requestContext.account;
        if (request.params.accountId !== account.id) {
            throw new RequestProblem('about:blank', 404, 'Account not found');
        }
        const declared = request.headers['content-length'] !== undefined ? Number(request.headers['content-length']) : null;
        if (declared !== null && declared > limits.maxSizeUpload) {
            throw tooLarge(limits.maxSizeUpload);
        }
        const header = request.jmapContentType || '';
        const type = MEDIA_TYPE.test(header) ? header : 'application/octet-stream';

        const release = await acquireSlot(deps.redis, account.user, limits.maxConcurrentUpload, 'maxConcurrentUpload');
        try {
            // room first: the body starts flowing once it is piped, and the store must be listening by then
            await deps.storageHandler.makeRoom(account.user, declared || 0, limits.uploadQuota, { maxUploads: limits.maxUploads });
            const counter = sizeLimit(limits.maxSizeUpload);
            // without a Content-Type (or an empty body) no parser runs and the request stream is unread
            const body = request.body || request.raw;
            body.once('error', err => counter.destroy(err));
            body.pipe(counter);
            const id = await deps.storageHandler.add(account.user, {
                filename: 'upload',
                contentType: type,
                content: counter,
                expires: new Date(Date.now() + limits.uploadTtl * 1000)
            });
            if (declared === null) {
                // the size was not known up front: evict older uploads now if this one went over
                await deps.storageHandler.makeRoom(account.user, 0, limits.uploadQuota).catch(() => false);
            }
            // 200, not 201: RFC 8620 6.1 names no status code, and clients built on go-jmap (aerc) accept only 200
            return reply
                .code(200)
                .header('Content-Type', 'application/json')
                .send(JSON.stringify({ accountId: account.id, blobId: blobId.upload(id), type, size: counter.size() }));
        } catch (err) {
            if (err.code === 'OverQuota') {
                throw new RequestProblem('limit', 413, 'The upload does not fit in the upload quota', { limit: 'uploadQuota' });
            }
            throw err;
        } finally {
            await release();
        }
    };

    // the body reaches the handler as the unread request stream, for every media type
    app.register(async scope => {
        // a body without a media type is still an upload: give the parser one, keep the original
        scope.addHook('onRequest', async request => {
            request.jmapContentType = (request.headers['content-type'] || '').trim();
            if (!request.jmapContentType) {
                request.headers['content-type'] = 'application/octet-stream';
            }
        });
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('*', (request, payload, done) => done(null, payload));
        route('/jmap/upload/:accountId', ['POST'], upload, {}, scope);
        route('/jmap/upload/:accountId/', ['POST'], upload, {}, scope);
    });
};
