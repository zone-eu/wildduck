'use strict';

const CompatResponse = require('./compat-response');
const { compileRouteValidator, docPartSchema } = require('./validation');
const { mergeParams, cloneParams } = require('./routes');

/**
 * Restify-compatible route registration adapter for Fastify.
 *
 * Route modules keep calling server.get/post/put/del(spec, handler) exactly as
 * they did with restify. The adapter registers the route with Fastify and
 * invokes the handler with (req, res) facades that reproduce the restify
 * behavior the handlers rely on, most importantly the merged req.params
 * object (path, query and body merged with restify's mapParams precedence,
 * see mergeParams in routes.js).
 */

function buildCompatRequest(request, spec) {
    const merged = mergeParams(request.params, request.query, request.body);

    const raw = request.raw;

    const req = {
        params: merged.params,
        query: request.query || {},
        body: request.body,
        headers: request.headers,
        method: request.method,
        url: request.url,
        user: request.user,
        role: request.role,
        accessToken: request.accessToken,
        validate: request.validate,
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

        // every route carries plain JSON Schema in its validationObjs: the
        // adapter validates the merged params object here and handlers contain
        // no validation code. Response schemas are attached to the Fastify
        // route so fast-json-stringify serializes replies (and
        // @fastify/swagger documents them).
        if (!spec.validationObjs) {
            throw new Error(`Route ${method.toUpperCase()} ${spec.path} is missing validationObjs`);
        }
        const validate = compileRouteValidator(spec.validationObjs, { allowUnknown: spec.allowUnknown });
        const response = spec.validationObjs.response || {};
        const responseSchemas = {};
        for (const status of Object.keys(response)) {
            if (response[status] && response[status].model) {
                responseSchemas[status] = response[status].model;
            }
        }
        const routeSchema = {
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

        this.fastify.route({
            method: method.toUpperCase(),
            url: spec.path,
            config: { spec, name: spec.name },
            schema: routeSchema,
            handler: async (request, reply) => {
                const req = buildCompatRequest(request, spec);
                const res = new CompatResponse(reply);
                req.res = res;

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

                // handlers are wrapped in tools.responseWrapper and are
                // responsible for sending a response themselves
                await handler.call(adapter, req, res);
                // hijacked (streamed) replies manage their own lifecycle
                return reply;
            }
        });
    }

    // restify's router.render(name, params): expand a named route's path
    // pattern with the given params (used for attachment links in messages);
    // returns null for unknown route names like restify did
    render(routeName, params, query) {
        const route = this.routes[routeName];
        if (!route) {
            return null;
        }
        const url = route.path.replace(/\/:([A-Za-z0-9_]+)/g, (match, key) => {
            if (!(key in params)) {
                throw new Error(`Route <${routeName}> is missing parameter <${key}>`);
            }
            return '/' + encodeURIComponent(params[key]);
        });
        const items = Object.keys(query || {}).map(key => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`);
        return items.length ? `${url}?${items.join('&')}` : url;
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

module.exports = { RestifyCompatAdapter };
