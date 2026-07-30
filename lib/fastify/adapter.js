'use strict';

const CompatResponse = require('./compat-response');
const { compileRouteValidator, resolveTree } = require('./validation');

// documentation view of a validation schema: the wd* conversion vocabulary is
// internal, OpenAPI consumers get plain JSON Schema with equivalent types
function toDocSchema(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return node;
    }
    const out = {};
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (key.startsWith('wd') && key !== 'wdType') {
            continue;
        }
        if (key === 'wdType') {
            if (!node.type) {
                if (value === 'date') {
                    out.type = 'string';
                    out.format = 'date-time';
                } else if (value === 'binary') {
                    out.type = 'string';
                    out.format = 'binary';
                } else {
                    out.type = value === 'booleanStrict' ? 'boolean' : value;
                }
            }
            continue;
        }
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            out[key] = toDocSchema(value);
        } else if (Array.isArray(value)) {
            out[key] = value.map(entry => (entry && typeof entry === 'object' && !Array.isArray(entry) ? toDocSchema(entry) : entry));
        } else {
            out[key] = value;
        }
    }
    return out;
}

// build a doc-only object schema for one request part (params, querystring
// or body); Fastify only documents these, validation runs on the merged
// object in the route wrapper
function docPartSchema(defs) {
    const keys = Object.keys(defs || {});
    if (!keys.length) {
        return null;
    }
    const properties = {};
    const required = [];
    for (const key of keys) {
        const resolved = resolveTree(defs[key]);
        if (resolved && resolved.wdRequired) {
            required.push(key);
        }
        properties[key] = toDocSchema(resolved);
    }
    const schema = { type: 'object', properties };
    if (required.length) {
        schema.required = required;
    }
    return schema;
}

// deep copy for validation input: the convert pass mutates nested objects in
// place, but some handlers inspect the pre-validation params (key presence
// checks Joi allowed because it copied values). Buffers and Dates stay by
// reference.
function cloneParams(value) {
    if (Array.isArray(value)) {
        return value.map(entry => cloneParams(entry));
    }
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
        const out = {};
        for (const key of Object.keys(value)) {
            out[key] = cloneParams(value[key]);
        }
        return out;
    }
    return value;
}

/**
 * Restify-compatible route registration adapter for Fastify.
 *
 * Route modules keep calling server.get/post/put/del(spec, handler) exactly as
 * they did with restify. The adapter registers the route with Fastify and
 * invokes the handler with (req, res) facades that reproduce the restify
 * behavior the handlers rely on, most importantly the merged req.params
 * object (path, query and body merged with restify's mapParams precedence).
 *
 * Merge semantics replicated from restify 11 source (queryParser and
 * bodyParser with mapParams: true, overrideParams: false):
 *  - path params first, then query keys, then parsed body keys
 *  - an existing TRUTHY value is never overridden, a falsy one is
 *  - an array JSON body replaces params entirely when there are no path
 *    params, and errors when there are
 *  - a scalar JSON body replaces params when truthy
 *  - Buffer and raw string bodies are not merged (handlers read req.body)
 */

function mergeParams(pathParams, query, body) {
    const params = {};
    for (const key of Object.keys(pathParams || {})) {
        params[key] = pathParams[key];
    }
    for (const key of Object.keys(query || {})) {
        if (params[key]) {
            continue;
        }
        params[key] = query[key];
    }

    if (body === undefined || body === null || Buffer.isBuffer(body) || typeof body === 'string') {
        return { params };
    }

    if (Array.isArray(body)) {
        if (Object.keys(params).length > 0) {
            const err = new Error('Cannot map POST body of [Array array] onto req.params');
            err.responseCode = 500;
            err.restifyStyle = true;
            err.code = 'InternalServer';
            throw err;
        }
        return { params: body };
    }

    if (typeof body === 'object') {
        for (const key of Object.keys(body)) {
            if (params[key]) {
                continue;
            }
            params[key] = body[key];
        }
        return { params };
    }

    // scalar body (number/boolean from a bare JSON value): restify stomps
    return { params: body || params };
}

function buildCompatRequest(request, spec) {
    const ctx = request.wdCtx || {};
    const merged = mergeParams(request.params, request.query, request.body);

    const raw = request.raw;

    const req = {
        params: merged.params,
        query: request.query || {},
        body: request.body,
        headers: request.headers,
        method: request.method,
        url: request.url,
        user: ctx.user,
        role: ctx.role,
        accessToken: ctx.accessToken,
        validate: ctx.validate,
        _fastifyRequest: request,
        route: {
            name: spec.name,
            path: spec.path,
            spec
        },
        connection: raw.socket,
        socket: raw.socket,
        header: name => request.headers[String(name || '').toLowerCase()],
        // stream access for handlers that consume the raw request (data import)
        pipe: (...args) => raw.pipe(...args),
        once: (...args) => raw.once(...args),
        on: (...args) => raw.on(...args)
    };

    // expose the merged params to the logging hook
    request.wdMergedParams = req.params;

    return req;
}

class RestifyCompatAdapter {
    constructor(fastify) {
        this.fastify = fastify;
        this.routes = {};
        // properties assigned by api.js and read by route modules
        this.loggelf = null;
        this.lock = null;
    }

    _register(method, spec, handler) {
        if (typeof spec === 'string') {
            spec = { path: spec };
        }

        const routeInfo = {
            name: spec.name,
            method: method.toUpperCase(),
            path: spec.path,
            // same shape as restify's router.getRoutes() entries: the test
            // overview generator reads spec.method/spec.path/spec.name
            spec: Object.assign({}, spec, { method: method.toUpperCase() })
        };
        if (spec.name) {
            this.routes[spec.name] = routeInfo;
        }

        const adapter = this;

        // migrated routes (spec.jsonSchema) carry plain JSON Schema in their
        // validationObjs: the adapter validates the merged params object here
        // and handlers contain no validation code. Response schemas are
        // attached to the Fastify route so fast-json-stringify serializes
        // replies (and @fastify/swagger documents them).
        let validate = null;
        let routeSchema;
        if (spec.jsonSchema) {
            validate = compileRouteValidator(spec.validationObjs, { allowUnknown: spec.allowUnknown });
            const response = (spec.validationObjs && spec.validationObjs.response) || {};
            const responseSchemas = {};
            for (const status of Object.keys(response)) {
                if (response[status] && response[status].model) {
                    responseSchemas[status] = response[status].model;
                }
            }
            routeSchema = {
                summary: spec.summary,
                description: spec.description,
                tags: spec.tags,
                operationId: spec.name
            };
            if (spec.excludeRoute) {
                routeSchema.hide = true;
            }
            if (Object.keys(responseSchemas).length) {
                routeSchema.response = responseSchemas;
            }
            const paramsDoc = docPartSchema(spec.validationObjs.pathParams);
            const queryDoc = docPartSchema(spec.validationObjs.queryParams);
            const bodyDoc = docPartSchema(spec.validationObjs.requestBody);
            if (paramsDoc) {
                routeSchema.params = paramsDoc;
            }
            if (queryDoc) {
                routeSchema.querystring = queryDoc;
            }
            if (bodyDoc && !['GET', 'DELETE', 'HEAD'].includes(method.toUpperCase())) {
                routeSchema.body = bodyDoc;
            }
        }

        this.fastify.route({
            method: method.toUpperCase(),
            url: spec.path,
            config: { spec, name: spec.name },
            schema: routeSchema,
            handler: async (request, reply) => {
                const req = buildCompatRequest(request, spec);
                const res = new CompatResponse(reply);
                req.res = res;

                if (validate) {
                    // restify-era handlers called res.charSet('utf-8') before
                    // validating; routes that did not set spec.charset false
                    if (spec.charset !== false) {
                        res.charSet('utf-8');
                    }
                    if (typeof spec.preValidate === 'function') {
                        // route-specific request preprocessing that ran before
                        // validation in the restify era (submit attachments)
                        spec.preValidate(req.params, req);
                    }
                    if (spec.rawBodyParam && !req.params[spec.rawBodyParam] && req.body && (Buffer.isBuffer(req.body) || typeof req.body === 'string')) {
                        // restify-era handlers copied the raw request body into
                        // a named param before validating (message uploads,
                        // storage files)
                        req.params[spec.rawBodyParam] = req.body;
                    }
                    // handlers may inspect the original input (key presence
                    // on nested objects), keep it reachable as rawParams
                    req.rawParams = req.params;
                    const result = validate(cloneParams(req.params));
                    if (result.error) {
                        res.status(400);
                        return res.json({
                            error: result.error,
                            code: 'InputValidationError',
                            details: result.details
                        });
                    }
                    req.params = result.value;
                    request.wdMergedParams = result.value;
                }

                // handlers are wrapped in tools.responseWrapper and are
                // responsible for sending a response themselves
                await handler.call(adapter, req, res);
                // hijacked (streamed) replies manage their own lifecycle
                return reply;
            }
        });
    }

    get(spec, handler) {
        this._register('GET', spec, handler);
    }

    post(spec, handler) {
        this._register('POST', spec, handler);
    }

    put(spec, handler) {
        this._register('PUT', spec, handler);
    }

    del(spec, handler) {
        this._register('DELETE', spec, handler);
    }

    // the standalone ACME agent registers a restify style catch-all with
    // server.on('NotFound', (req, res, err, cb) => ...)
    on(event, handler) {
        if (event !== 'NotFound') {
            throw new Error(`Unsupported server event: ${event}`);
        }
        this.fastify.setNotFoundHandler((request, reply) => {
            const req = buildCompatRequest(request, {});
            const res = new CompatResponse(reply);
            handler(req, res, null, () => false);
            return reply;
        });
    }
}

module.exports = { RestifyCompatAdapter, mergeParams, buildCompatRequest };
