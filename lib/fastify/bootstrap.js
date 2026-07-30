'use strict';

const log = require('npmlog');

// shared plumbing for the two Fastify entry points (api.js and the
// standalone ACME agent in acme.js): both must present the exact same
// restify-compatible surface, so the pieces live here instead of being
// copied between the files

const maskUrl = url => (url || '').replace(/(accessToken=)[^&]+/g, '$1xxxxxx');

// wdResponseBody carries the reply body object to the Gelf logging hook,
// wdContentType the exact restify-era content type (fastify force-appends a
// charset to bare application/json, so it is applied in the onSend hook)
const attachCompatReplyDecorations = app => {
    app.decorateReply('wdResponseBody', null);
    app.decorateReply('wdContentType', null);
};

const attachServerHeader = (app, serverName) => {
    app.addHook('onSend', async (request, reply, payload) => {
        reply.header('server', serverName);
        if (reply.wdContentType) {
            reply.header('content-type', reply.wdContentType);
        }
        return payload;
    });
};

// HTTP access log line (previously restify-logger)
const attachAccessLog = (app, logTag, { includeUser = false } = {}) => {
    app.addHook('onResponse', async (request, reply) => {
        const ctx = request.wdCtx || {};
        const params = request.wdMergedParams || request.query || {};
        const userIp = ((params && params.ip) || '').toString().substr(0, 40) || '-';
        const userSess = (params && params.sess) || '-';
        const user = (includeUser && ctx.user && ctx.user.toString()) || '-';
        const line = `${request.raw.socket.remoteAddress} ${user} [${userIp}/${userSess}] ${request.method} ${maskUrl(request.url)} ${reply.statusCode} ${Math.round(
            reply.elapsedTime
        )}ms`;
        log.http(logTag, line);
    });
};

// restify-errors style output ({code, message}) used by the access token
// middleware and body parser failures; anything else is an unhandled error
const attachCompatErrorHandler = (app, logTag) => {
    app.setErrorHandler((err, request, reply) => {
        if (err.restifyStyle || (err.responseCode && !reply.sent)) {
            const body = {
                code: err.code || 'InternalError',
                message: err.message
            };
            reply.status(err.responseCode || 500);
            reply.wdResponseBody = body;
            // restify-errors responses carried no charset parameter
            reply.wdContentType = 'application/json';
            return reply.send(body);
        }

        log.error(logTag, 'Unhandled error: %s', err.stack || err.message);
        const body = {
            code: 'InternalError',
            message: err.message
        };
        reply.status(500);
        reply.wdResponseBody = body;
        return reply.send(body);
    });
};

module.exports = {
    maskUrl,
    attachCompatReplyDecorations,
    attachServerHeader,
    attachAccessLog,
    attachCompatErrorHandler
};
