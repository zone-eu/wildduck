'use strict';

const log = require('npmlog');
const metrics = require('../metrics');

// shared plumbing for the two Fastify entry points (api.js and the
// standalone ACME agent in acme.js): both must present the exact same
// surface, so the pieces live here instead of being copied between the files

const maskUrl = url => (url || '').replace(/(accessToken=)[^&]+/g, '$1xxxxxx');

// throws when a permission check fails; exposed to handlers as req.validate
function validatePermission(permission) {
    if (!permission.granted) {
        const err = new Error('Not enough privileges');
        err.responseCode = 403;
        err.code = 'MissingPrivileges';
        throw err;
    }
}

// request state shared by the auth hook, validation, handlers and the
// logging hooks. All request-scoped values default to null/false and are
// assigned per request.
const attachRequestDecorations = app => {
    app.decorateRequest('user', null);
    app.decorateRequest('role', null);
    app.decorateRequest('accessToken', null);
    app.decorateRequest('validate', validatePermission);
    // pre-validation view of the merged params (key-presence checks)
    app.decorateRequest('rawParams', null);
    // merged params for the logging hooks (raw before validation, the
    // validated result after)
    app.decorateRequest('wdMergedParams', null);
    // route skips the access token check
    app.decorateRequest('wdIsPublic', false);
    // validation passed, the request reached handler code: thrown errors get
    // the handler error contract instead of the infra {code, message} shape
    app.decorateRequest('wdValidated', false);
};

// wdResponseBody carries the reply body object to the Gelf logging hook,
// wdContentType pins an exact content type applied in the onSend hook
// (fastify force-appends a charset to bare application/json)
const attachReplyDecorations = app => {
    app.decorateReply('wdResponseBody', null);
    app.decorateReply('wdContentType', null);
};

// preSerialization: runs for every object payload right before it is
// serialized, whether sent from a handler, a hook or the error handler
const attachPayloadStash = app => {
    app.addHook('preSerialization', async (request, reply, payload) => {
        if (payload && typeof payload === 'object') {
            // the Gelf logging hook reads the body object (the restify
            // implementation logged from within its JSON formatter)
            reply.wdResponseBody = payload;
            if (payload.error !== undefined && payload.success === undefined) {
                // legacy inline error bodies ({error, code}, sometimes with a
                // 200 status) predate the response schemas; serialize them
                // verbatim instead of letting fast-json-stringify reject them
                // over missing required keys
                reply.serializer(body => JSON.stringify(body));
            }
        }
        return payload;
    });
};

// server header on every response plus the JSON content-type policy:
// an explicitly pinned wdContentType always wins; otherwise JSON replies
// carry charset=utf-8 unless the route opts out with config.charset = false
// (routes that never called res.charSet in the restify era)
const attachResponseHeaders = (app, serverName) => {
    app.addHook('onSend', async (request, reply, payload) => {
        reply.header('server', serverName);
        if (reply.wdContentType) {
            reply.header('content-type', reply.wdContentType);
            return payload;
        }
        const contentType = reply.getHeader('content-type');
        if (typeof contentType === 'string' && contentType.startsWith('application/json')) {
            const config = request.routeOptions && request.routeOptions.config;
            reply.header('content-type', config && config.charset === false ? 'application/json' : 'application/json; charset=utf-8');
        }
        return payload;
    });
};

// HTTP access log line (previously restify-logger)
const attachAccessLog = (app, logTag, { includeUser = false } = {}) => {
    app.addHook('onResponse', async (request, reply) => {
        const params = request.wdMergedParams || request.query || {};
        const userIp = ((params && params.ip) || '').toString().substr(0, 40) || '-';
        const userSess = (params && params.sess) || '-';
        const user = (includeUser && request.user && request.user.toString()) || '-';
        const line = `${request.raw.socket.remoteAddress} ${user} [${userIp}/${userSess}] ${request.method} ${maskUrl(request.url)} ${reply.statusCode} ${Math.round(
            reply.elapsedTime
        )}ms`;
        log.http(logTag, line);
    });
};

/**
 * Global error handler.
 *
 * Three error classes:
 *  - infra errors (access token check, body parsing, param merging): thrown
 *    with restifyStyle/responseCode markers before handler code runs,
 *    answered in the restify-errors shape {code, message} without a charset
 *  - handler errors on validated requests: the contract of the retired
 *    tools.responseWrapper, {error, code?, ...details} with the IMAP error
 *    code mapping; the status stays untouched unless the error carries a
 *    responseCode (legacy paths answer 200 {error})
 *  - anything else: unhandled, logged, 500 {code, message}
 */
const attachErrorHandler = (app, logTag) => {
    app.setErrorHandler((err, request, reply) => {
        if (reply.sent || reply.raw.headersSent) {
            // response already on the wire (streaming), nothing to send
            log.error(logTag, 'Error after response started: %s', err.stack || err.message);
            return;
        }

        if (request.wdValidated && !err.restifyStyle) {
            const data = {
                error: err.formattedMessage || err.message
            };

            switch (err.code) {
                case 'ALREADYEXISTS':
                    err.responseCode = err.responseCode || 400;
                    err.code = 'MailboxExistsError';
                    break;
                case 'NONEXISTENT':
                    err.responseCode = err.responseCode || 404;
                    err.code = 'NoSuchMailbox';
                    break;
                case 'CANNOT':
                    err.responseCode = err.responseCode || 400;
                    err.code = 'DisallowedMailboxMethod';
                    break;
            }

            if (err.responseCode) {
                reply.status(err.responseCode);
            }

            if (err.code) {
                data.code = err.code;
            }

            metrics.recordApiError(request.method, (request.routeOptions && request.routeOptions.url) || 'unknown', err.code || err.responseCode || 'error');

            if (err.details && typeof err.details === 'object') {
                for (const key of Object.keys(err.details)) {
                    if (!data[key]) {
                        data[key] = err.details[key];
                    }
                }
            }

            const params = request.wdMergedParams || {};
            log.http(
                'Error',
                `${request.method} ${request.url} sess=${(params && params.sess) || '-'} user=${request.user ? request.user : '-'} error=${JSON.stringify(
                    err.stack
                )}`
            );

            reply.wdContentType = 'application/json; charset=utf-8';
            return reply.send(data);
        }

        if (err.restifyStyle || err.responseCode) {
            const body = {
                code: err.code || 'InternalError',
                message: err.message
            };
            reply.status(err.responseCode || 500);
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
        return reply.send(body);
    });
};

module.exports = {
    maskUrl,
    attachRequestDecorations,
    attachReplyDecorations,
    attachPayloadStash,
    attachResponseHeaders,
    attachAccessLog,
    attachErrorHandler
};
