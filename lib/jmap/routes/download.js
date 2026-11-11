'use strict';

// GET /jmap/download/{accountId}/{blobId}/{name}?type={type} (RFC 8620 6.2)

const { openBlob } = require('../blob');
const { RequestProblem } = require('../errors');
const { MEDIA_TYPE } = require('../ids');

// RFC 6266 / RFC 5987: an ASCII fallback and the UTF-8 name
function contentDisposition(name) {
    // an empty name gives no file name; the stored part name is never used implicitly
    if (!name) {
        return 'attachment';
    }
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

module.exports = ({ route, context }) => {
    route('/jmap/download/:accountId/:blobId/:name', ['GET'], async (request, reply) => {
        const requestContext = context(request, { capabilities: {}, state: null });
        const { accountId, blobId, name } = request.params;
        // another account's blob answers exactly like an unknown one
        const blob = accountId === requestContext.account.id ? await openBlob(requestContext, blobId) : null;
        if (!blob) {
            throw new RequestProblem('about:blank', 404, 'Blob not found');
        }
        const type = typeof request.query.type === 'string' && MEDIA_TYPE.test(request.query.type) ? request.query.type : 'application/octet-stream';
        reply.header('Content-Type', type);
        reply.header('Content-Disposition', contentDisposition(name));
        // blob contents never change, the id names the bytes
        reply.header('Cache-Control', 'private, immutable, max-age=31536000');
        reply.header('X-Content-Type-Options', 'nosniff');
        // the client chooses the Content-Type, so a browser must never run the content as an active document
        reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
        if (blob.size !== null && blob.size !== undefined) {
            reply.header('Content-Length', String(blob.size));
        }
        return reply.send(blob.stream);
    });
};
