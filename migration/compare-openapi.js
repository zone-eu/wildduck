'use strict';

// Structural parity check between the restifyapigenerate OpenAPI snapshot and
// the @fastify/swagger generated spec: same paths, methods, parameters
// (name/in/required/type) and request body properties (name/type/required).
// Response models are compared by property name sets. Descriptions, examples
// and component naming are not compared.
// Usage: node migration/compare-openapi.js <old.json> <new.json>
// Temporary tooling, delete after migration.

const fs = require('fs');

const oldSpec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const newSpec = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

let problems = 0;
const report = (...args) => {
    problems++;
    console.log(...args);
};

function resolveRef(spec, node, depth = 0) {
    if (node && node.$ref && depth < 10) {
        const path = node.$ref.replace(/^#\//, '').split('/');
        let target = spec;
        for (const key of path) {
            target = target && target[key];
        }
        return resolveRef(spec, target, depth + 1) || {};
    }
    return node || {};
}

function typeOf(spec, schema) {
    schema = resolveRef(spec, schema);
    if (schema.type) {
        return schema.type;
    }
    if (schema.anyOf || schema.oneOf) {
        const branches = (schema.anyOf || schema.oneOf).map(branch => typeOf(spec, branch)).filter(Boolean);
        return branches.sort().join('|') || 'any';
    }
    if (schema.properties) {
        return 'object';
    }
    return 'any';
}

// 'string' matches 'any|string' etc: alternatives where a literal branch has
// no JSON type collapse differently between the generators; compatible when
// the non-any member sets intersect
function typesCompatible(a, b) {
    const setA = new Set(a.split('|').filter(entry => entry !== 'any'));
    const setB = new Set(b.split('|').filter(entry => entry !== 'any'));
    if (!setA.size || !setB.size) {
        return true;
    }
    for (const entry of setA) {
        if (setB.has(entry)) {
            return true;
        }
    }
    return false;
}

// the old spec documented a flat attestation response that the handler never
// produced (it returns { success, response }); the new spec documents reality
const CORRECTED_RESPONSES = new Set(['post /users/{user}/2fa/webauthn/registration-attestation']);

// parameters whose documented type was wrong in the restify era and was fixed
// deliberately (see migration/SEMANTICS.md section 9): the archived message id
// is an ObjectId, the numeric type made the route impossible to call
const CORRECTED_PARAMS = new Set(['post /users/{user}/archived/messages/{message}/restore path:message']);

const normPath = p => p.replace(/:([A-Za-z0-9_-]+)/g, '{$1}');

const oldPaths = {};
for (const [p, methods] of Object.entries(oldSpec.paths || {})) {
    oldPaths[normPath(p)] = methods;
}

for (const [p, oldMethods] of Object.entries(oldPaths)) {
    if (p === '/api-methods') {
        continue; // test-env debug route, intentionally undocumented now
    }
    const newMethods = newSpec.paths[p];
    if (!newMethods) {
        report(`PATH MISSING: ${p}`);
        continue;
    }
    for (const [method, oldOp] of Object.entries(oldMethods)) {
        const newOp = newMethods[method];
        if (!newOp) {
            report(`METHOD MISSING: ${method.toUpperCase()} ${p}`);
            continue;
        }

        // parameters (path + query)
        const oldParams = new Map((oldOp.parameters || []).map(par => [`${par.in}:${par.name}`, par]));
        const newParams = new Map((newOp.parameters || []).map(par => [`${par.in}:${par.name}`, par]));
        for (const [key, oldPar] of oldParams) {
            const newPar = newParams.get(key);
            if (!newPar) {
                report(`PARAM MISSING: ${method.toUpperCase()} ${p} ${key}`);
                continue;
            }
            const oldType = typeOf(oldSpec, oldPar.schema || {});
            const newType = typeOf(newSpec, newPar.schema || {});
            if (!typesCompatible(oldType, newType) && !CORRECTED_PARAMS.has(`${method} ${p} ${key}`)) {
                report(`PARAM TYPE: ${method.toUpperCase()} ${p} ${key}: ${oldType} vs ${newType}`);
            }
            if (Boolean(oldPar.required) !== Boolean(newPar.required)) {
                report(`PARAM REQUIRED: ${method.toUpperCase()} ${p} ${key}: ${Boolean(oldPar.required)} vs ${Boolean(newPar.required)}`);
            }
        }
        for (const key of newParams.keys()) {
            if (!oldParams.has(key)) {
                report(`PARAM EXTRA: ${method.toUpperCase()} ${p} ${key}`);
            }
        }

        // request body properties
        const bodySchema = spec => op => {
            const content = op.requestBody && op.requestBody.content;
            const json = content && (content['application/json'] || Object.values(content)[0]);
            return resolveRef(spec, json && json.schema);
        };
        const oldBody = bodySchema(oldSpec)(oldOp);
        const newBody = bodySchema(newSpec)(newOp);
        const oldProps = (oldBody && oldBody.properties) || {};
        const newProps = (newBody && newBody.properties) || {};
        for (const key of Object.keys(oldProps)) {
            if (!(key in newProps)) {
                report(`BODY PROP MISSING: ${method.toUpperCase()} ${p} ${key}`);
                continue;
            }
            const oldType = typeOf(oldSpec, oldProps[key]);
            const newType = typeOf(newSpec, newProps[key]);
            if (!typesCompatible(oldType, newType)) {
                report(`BODY PROP TYPE: ${method.toUpperCase()} ${p} ${key}: ${oldType} vs ${newType}`);
            }
        }
        for (const key of Object.keys(newProps)) {
            if (!(key in oldProps)) {
                report(`BODY PROP EXTRA: ${method.toUpperCase()} ${p} ${key}`);
            }
        }
        const oldReq = new Set((oldBody && oldBody.required) || []);
        const newReq = new Set((newBody && newBody.required) || []);
        for (const key of oldReq) {
            if (!newReq.has(key)) {
                report(`BODY REQUIRED MISSING: ${method.toUpperCase()} ${p} ${key}`);
            }
        }
        for (const key of newReq) {
            if (!oldReq.has(key)) {
                report(`BODY REQUIRED EXTRA: ${method.toUpperCase()} ${p} ${key}`);
            }
        }

        // 200 response property names
        const resSchema = spec => op => {
            const res = op.responses && (op.responses['200'] || op.responses[200]);
            const content = res && res.content;
            const json = content && content['application/json'];
            return resolveRef(spec, json && json.schema);
        };
        const oldRes = resSchema(oldSpec)(oldOp);
        const newRes = resSchema(newSpec)(newOp);
        const oldResProps = Object.keys((oldRes && oldRes.properties) || {});
        const newResProps = Object.keys((newRes && newRes.properties) || {});
        if (!CORRECTED_RESPONSES.has(`${method} ${p}`)) {
            for (const key of oldResProps) {
                if (!newResProps.includes(key)) {
                    report(`RESPONSE PROP MISSING: ${method.toUpperCase()} ${p} ${key}`);
                }
            }
        }
    }
}

for (const [p, newMethods] of Object.entries(newSpec.paths || {})) {
    if (!oldPaths[p]) {
        report(`PATH EXTRA: ${p}`);
        continue;
    }
    for (const method of Object.keys(newMethods)) {
        if (!oldPaths[p][method]) {
            report(`METHOD EXTRA: ${method.toUpperCase()} ${p}`);
        }
    }
}

console.log(problems ? `\nFAIL: ${problems} differences` : 'OK: structural parity');
process.exitCode = problems ? 1 : 0;
