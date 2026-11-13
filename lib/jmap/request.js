'use strict';

// The JMAP API request (RFC 8620 3): validates the Request object, runs the method calls in order,
// resolves result references and creation ids, and turns failures into method level errors. Type
// modules register their methods with a capability; a method is only callable when the request lists
// that capability in `using`.

const log = require('npmlog');
const { MethodError, RequestProblem } = require('./errors');
const { resolveReferences, ReferenceError: JmapReferenceError } = require('./references');
const { URN } = require('./capabilities');
const { drawObjects } = require('./response-budget');

const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isString = value => typeof value === 'string';

/**
 * Collects the methods of the type modules.
 *
 * @param {Object[]} modules Each {capability: URN, methods: {name: handler}, accountCapability?(context)}
 */
class MethodRegistry {
    constructor(modules) {
        this.methods = new Map();
        this.modules = modules;
        // capability -> the module that gives its account capability object; at most one may
        this.capabilities = new Map();
        for (const module of modules) {
            for (const [name, handler] of Object.entries(module.methods)) {
                this.methods.set(name, { capability: module.capability, handler });
            }
            if (module.capability === URN.core) {
                continue;
            }
            const giver = this.capabilities.get(module.capability);
            if (giver && giver.accountCapability && module.accountCapability) {
                throw new Error(`Two modules declare the account capability object of ${module.capability}`);
            }
            if (!giver || module.accountCapability) {
                this.capabilities.set(module.capability, module);
            }
        }
    }

    /** URN -> account capability object of every capability this server implements */
    accountCapabilities(context) {
        const result = {};
        for (const [capability, module] of this.capabilities) {
            result[capability] = module.accountCapability ? module.accountCapability(context) : {};
        }
        return result;
    }
}

function validateRequest(body, advertised, limits) {
    if (!isPlainObject(body) || !Array.isArray(body.using) || !Array.isArray(body.methodCalls)) {
        throw new RequestProblem('notRequest', 400, 'The request body is not a JMAP Request object');
    }
    if (
        !body.using.every(isString) ||
        !body.methodCalls.every(call => Array.isArray(call) && call.length === 3 && isString(call[0]) && isPlainObject(call[1]) && isString(call[2]))
    ) {
        throw new RequestProblem('notRequest', 400, 'using must list strings and every method call must be [name, arguments, callId]');
    }
    if (body.createdIds !== undefined && (!isPlainObject(body.createdIds) || !Object.values(body.createdIds).every(isString))) {
        throw new RequestProblem('notRequest', 400, 'createdIds must map creation ids to ids');
    }
    const unknown = body.using.find(urn => !advertised.has(urn));
    if (unknown) {
        throw new RequestProblem('unknownCapability', 400, `The capability ${unknown} is not supported`);
    }
    if (body.methodCalls.length > limits.maxCallsInRequest) {
        throw new RequestProblem('limit', 400, `More than ${limits.maxCallsInRequest} method calls`, { limit: 'maxCallsInRequest' });
    }
}

async function runCall(registry, using, call, responses, context) {
    const [name, args, callId] = call;
    const method = registry.methods.get(name);
    if (!method || !using.has(method.capability)) {
        return [['error', { type: 'unknownMethod' }, callId]];
    }
    try {
        const resolved = resolveReferences(args, responses);
        const result = await method.handler(resolved, context, name);
        if (name.endsWith('/get')) {
            // every /get draws from the response budget of the request, see response-budget.js
            drawObjects(context, result);
        }
        // a method may answer with more than one response (an implicit call follows it), as [name, args] pairs
        const answers = Array.isArray(result) ? result : [[name, result]];
        return answers.map(([answerName, answerArgs]) => [answerName, answerArgs, callId]);
    } catch (err) {
        if (err instanceof MethodError || err instanceof JmapReferenceError) {
            const type = err instanceof MethodError ? err.toResponse() : { type: err.type, description: err.message };
            return [['error', type, callId]];
        }
        if (err.code === 50 || err.codeName === 'MaxTimeMSExpired') {
            // a database operation ran into its time limit: temporary, the client may retry or simplify
            // (RFC 8620 3.6.2)
            log.info('JMAP', 'user=%s method=%s error=%s', context.account && context.account.id, name, err.message);
            return [['error', { type: 'serverUnavailable', description: 'The operation took too long' }, callId]];
        }
        log.error('JMAP', 'user=%s method=%s error=%s', context.account && context.account.id, name, err.stack || err.message);
        return [['error', { type: 'serverFail', description: 'Internal server error' }, callId]];
    }
}

/**
 * Processes a parsed Request object.
 *
 * @param {Object} body The parsed request
 * @param {MethodRegistry} registry
 * @param {Object} context Request context: account, limits, advertised capabilities (Set), sessionState and the handlers
 * @returns {Promise<Object>} The Response object
 * @throws {RequestProblem} For request level errors
 */
async function processRequest(body, registry, context) {
    validateRequest(body, context.advertised, context.limits);

    const using = new Set(body.using);
    context.using = using;
    context.createdIds = Object.assign({}, body.createdIds);

    const responses = [];
    for (const call of body.methodCalls) {
        responses.push(...(await runCall(registry, using, call, responses, context)));
    }

    const response = { methodResponses: responses, sessionState: context.sessionState };
    if (body.createdIds !== undefined) {
        response.createdIds = context.createdIds;
    }
    return response;
}

module.exports = { MethodRegistry, processRequest, validateRequest };
