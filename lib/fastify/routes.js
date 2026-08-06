'use strict';

const { cloneValue, compileRouteValidator, docPartSchema } = require('./validation');

/**
 * Native Fastify route support for the WildDuck API.
 *
 * Route modules register plain Fastify routes and put the WildDuck specifics
 * into the route config:
 *
 *   server.route({
 *       method: 'POST',
 *       url: '/users/:user/example',
 *       schema: { summary: '...', tags: ['Example'] },
 *       config: {
 *           name: 'exampleRoute',
 *           validationObjs: { requestBody: {...}, queryParams: {...}, pathParams: {...}, response: {...} }
 *       },
 *       async handler(req, reply) { ... }
 *   });
 *
 * Recognized config keys:
 *   name           route name: OpenAPI operationId and the route registry
 *   validationObjs request/response schema declaration used for validation,
 *                  response serialization and OpenAPI docs
 *   allowUnknown   unknown keys pass validation (Joi-era allowUnknown)
 *   charset        false when JSON replies must not carry a charset parameter
 *   preValidate    request preprocessing on the merged params object before
 *                  validation
 *   rawBodyParam   maps a raw (Buffer/string) request body into a named param
 *                  before validation
 *   public         the route serves unauthenticated requests
 *
 * The onRoute hook compiles the validation for every route that declares
 * validationObjs and attaches a preValidation step that:
 *   1. merges path params, query and body into one params object (the
 *      documented WildDuck request model: body-declared fields may legally
 *      arrive via the querystring, see docs/in-depth/api-validation.md)
 *   2. validates the merged object and replies 400 InputValidationError on
 *      failure
 *   3. exposes the validated result as req.params to the handler;
 *      req.rawParams keeps the pre-validation view for key-presence checks
 */

/**
 * Merge semantics carried over from the restify era (queryParser and
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
        return params;
    }

    if (Array.isArray(body)) {
        if (Object.keys(params).length > 0) {
            const err = new Error('Cannot map POST body of [Array array] onto req.params');
            err.responseCode = 500;
            err.code = 'InternalServer';
            throw err;
        }
        return body;
    }

    if (typeof body === 'object') {
        for (const key of Object.keys(body)) {
            if (params[key]) {
                continue;
            }
            params[key] = body[key];
        }
        return params;
    }

    // scalar body (number/boolean from a bare JSON value): restify stomps
    return body || params;
}

// shared preValidation step for every route that declares validationObjs
async function validateRequest(req, reply) {
    const config = req.routeOptions.config;

    const params = mergeParams(req.params, req.query, req.body);

    if (typeof config.preValidate === 'function') {
        // route-specific request preprocessing that ran before validation in
        // the restify era (submit attachments, updates Last-Event-ID header)
        config.preValidate(params, req);
    }

    if (config.rawBodyParam && !params[config.rawBodyParam] && req.body && (Buffer.isBuffer(req.body) || typeof req.body === 'string')) {
        // raw (Buffer/string) request bodies surface as a named param
        // (message uploads, storage files)
        params[config.rawBodyParam] = req.body;
    }

    // the pre-validation view stays reachable for handlers that need to tell
    // "key absent" from "key emptied"; the logging hooks read req.params
    req.rawParams = params;
    req.params = params;

    // deep copy for validation input: the convert pass mutates nested objects
    // in place, but some handlers inspect the pre-validation params (key
    // presence checks Joi allowed because it copied values)
    const result = config.validate(cloneValue(params));
    if (result.error) {
        return reply.code(400).send({
            error: result.error,
            code: 'InputValidationError',
            details: result.details
        });
    }

    req.params = result.value;
    // errors thrown past this point come from route handler code and get the
    // handler error contract (see the bootstrap error handler)
    req.wdValidated = true;
}

/**
 * Registers the onRoute hook that turns config.validationObjs into compiled
 * validation, response serialization schemas and OpenAPI documentation.
 * Named routes land in the given registry object ({ name -> route info },
 * served by the test-only /api-methods route).
 */
function attachNativeRoutes(app, registry) {
    app.addHook('onRoute', routeOptions => {
        const config = routeOptions.config;
        if (!config || !config.validationObjs) {
            // infra routes (metrics, docs, static files) declare no
            // validationObjs and handle their own schemas
            return;
        }

        config.validate = compileRouteValidator(config.validationObjs, { allowUnknown: config.allowUnknown });

        const schema = (routeOptions.schema = routeOptions.schema || {});
        if (config.name && !schema.operationId) {
            schema.operationId = config.name;
        }
        const response = config.validationObjs.response || {};
        const responseSchemas = {};
        for (const status of Object.keys(response)) {
            if (response[status] && response[status].model) {
                responseSchemas[status] = response[status].model;
            }
        }
        if (Object.keys(responseSchemas).length) {
            schema.response = responseSchemas;
        }

        const paramsDoc = docPartSchema(config.validationObjs.pathParams);
        const queryDoc = docPartSchema(config.validationObjs.queryParams);
        const bodyDoc = docPartSchema(config.validationObjs.requestBody);
        if (paramsDoc) {
            schema.params = paramsDoc;
        }
        if (queryDoc) {
            schema.querystring = queryDoc;
        }
        if (bodyDoc && !['GET', 'DELETE', 'HEAD'].includes(routeOptions.method)) {
            schema.body = bodyDoc;
        }

        routeOptions.preValidation = [validateRequest].concat(routeOptions.preValidation || []);

        if (registry && config.name) {
            registry[config.name] = {
                name: config.name,
                method: routeOptions.method,
                path: routeOptions.url,
                spec: {
                    method: routeOptions.method,
                    path: routeOptions.url,
                    name: config.name,
                    summary: schema.summary,
                    tags: schema.tags,
                    validationObjs: config.validationObjs
                }
            };
        }
    });
}

module.exports = { attachNativeRoutes };
