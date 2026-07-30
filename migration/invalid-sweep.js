'use strict';

// Generates a deterministic battery of invalid requests for every API route,
// derived from the route validationObjs (Joi), and fires them at the API (or
// the recording proxy) in a stable order. Pins per-route rejection behavior:
// unknown-key handling (allowUnknown differences), wrong-type errors, missing
// required key errors, malformed path params.
// Usage: node migration/invalid-sweep.js <port>
// Temporary tooling, delete after migration.

const http = require('http');
const { collectRoutes } = require('./introspect-routes');

const port = Number(process.argv[2]);
if (!port && require.main === module) {
    console.error('Usage: node migration/invalid-sweep.js <port>');
    process.exit(1);
}

// stable, syntactically valid dummy for a path param based on its normalized
// description (see normalizeKeyDesc: works for Joi and JSON Schema alike)
function dummyForParam(desc, name) {
    if (!desc) {
        return 'test';
    }
    if (desc.valids && desc.valids.length) {
        return desc.valids[0];
    }
    if (desc.hexLen) {
        return '1'.repeat(desc.hexLen);
    }
    if (desc.type === 'number') {
        return '1';
    }
    if (name === 'domain') {
        return 'example.com';
    }
    return 'test';
}

// normalize a Joi describe() result or a plain JSON Schema (migrated routes)
// into { type, hexLen, valids } so both produce the SAME sweep cases
function normalizeKeyDesc(schema, isJsonSchema) {
    if (!schema) {
        return null;
    }
    if (!isJsonSchema) {
        let desc;
        try {
            desc = schema.describe();
        } catch {
            return null;
        }
        const rules = desc.rules || [];
        const lengthRule = rules.find(r => r.name === 'length');
        return {
            type: desc.type,
            hexLen: rules.some(r => r.name === 'hex') && lengthRule ? Number(lengthRule.args && lengthRule.args.limit) || 24 : 0,
            valids: (desc.allow || []).filter(v => typeof v === 'string' && v)
        };
    }
    const { resolveTree } = require('../lib/fastify/validation');
    require('../lib/schemas/json-schemas');
    const resolved = resolveTree(schema);
    let type = resolved.wdType || resolved.type;
    if (!type && Array.isArray(resolved.anyOf)) {
        // converted Joi alternatives (e.g. date-or-false) carry the
        // conversion target inside a branch
        for (const branch of resolved.anyOf) {
            if (branch && branch.wdType) {
                type = branch.wdType;
                break;
            }
        }
    }
    if (type === 'integer') {
        type = 'number';
    }
    let hexMatch = typeof resolved.pattern === 'string' && /^\^\[0-9a-f\]\{(\d+)\}\$$/.exec(resolved.pattern);
    const valids = [];
    const collectBranch = branch => {
        if (!branch || typeof branch !== 'object') {
            return;
        }
        if (branch.const && typeof branch.const === 'string') {
            valids.push(branch.const);
        }
        for (const v of branch.enum || []) {
            if (typeof v === 'string' && v) {
                valids.push(v);
            }
        }
        if (!hexMatch && typeof branch.pattern === 'string') {
            hexMatch = /^\^\[0-9a-f\]\{(\d+)\}\$$/.exec(branch.pattern);
        }
    };
    collectBranch(resolved);
    for (const branch of resolved.anyOf || []) {
        collectBranch(branch);
    }
    return {
        type,
        hexLen: hexMatch ? Number(hexMatch[1]) : 0,
        valids
    };
}

function mergedDescribe(validationObjs, isJsonSchema) {
    const merged = {
        ...(validationObjs.pathParams || {}),
        ...(validationObjs.requestBody || {}),
        ...(validationObjs.queryParams || {})
    };
    const keys = {};
    for (const [key, schema] of Object.entries(merged)) {
        keys[key] = normalizeKeyDesc(schema, isJsonSchema);
    }
    return { keys };
}

function buildCases() {
    const routes = collectRoutes();
    const cases = [];

    for (const route of routes) {
        if (!route.validationObjs || route.excludeRoute) {
            // excludeRoute routes (acme challenge) had no validationObjs in
            // the restify implementation, keep the sweep sequence stable
            continue;
        }
        if (route.responseType === 'text/event-stream' || route.path === '/users/:user/updates') {
            continue; // SSE hangs by design; migrated and verified separately
        }

        const desc = mergedDescribe(route.validationObjs, !!route.jsonSchema);
        const keys = desc.keys || {};
        const pathParamNames = (route.path.match(/:[a-zA-Z0-9_]+/g) || []).map(p => p.slice(1));

        const fillPath = overrides => {
            let url = route.path;
            for (const p of pathParamNames) {
                const val = overrides && p in overrides ? overrides[p] : dummyForParam(keys[p], p);
                url = url.replace(':' + p, encodeURIComponent(val));
            }
            return url;
        };

        // 1: unknown query key (pins allowUnknown vs reject per route)
        cases.push({
            label: `${route.method} ${route.path} :: unknown-key`,
            method: route.method,
            url: fillPath() + '?__migrationProbe=1'
        });

        // 2: bare request, no optional/required inputs (pins required-key errors)
        cases.push({
            label: `${route.method} ${route.path} :: bare`,
            method: route.method,
            url: fillPath()
        });

        // 3: wrong-type value per number/boolean/date key (query-delivered;
        // validation runs on the merged params object so this covers body keys too)
        for (const [key, kd] of Object.entries(keys)) {
            if (pathParamNames.includes(key)) {
                continue;
            }
            if (kd && ['number', 'boolean', 'date'].includes(kd.type)) {
                cases.push({
                    label: `${route.method} ${route.path} :: bad-${kd.type}-${key}`,
                    method: route.method,
                    url: fillPath() + `?${encodeURIComponent(key)}=__not_valid__`
                });
            }
        }

        // 4: malformed value for each path param
        for (const p of pathParamNames) {
            cases.push({
                label: `${route.method} ${route.path} :: bad-path-${p}`,
                method: route.method,
                url: fillPath({ [p]: '!' })
            });
        }
    }

    return cases;
}

function send(method, url) {
    return new Promise(resolve => {
        const req = http.request(
            { host: '127.0.0.1', port, method: method.toUpperCase(), path: url, headers: { 'x-migration-probe': '1' } },
            res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            }
        );
        req.setTimeout(10000, () => {
            req.destroy();
            resolve({ status: 0, body: 'TIMEOUT' });
        });
        req.on('error', err => resolve({ status: 0, body: 'ERROR: ' + err.message }));
        req.end();
    });
}

async function main() {
    const cases = buildCases();
    console.log(`sweep: ${cases.length} cases`);
    let n = 0;
    for (const c of cases) {
        const res = await send(c.method, c.url);
        n++;
        if (n % 50 === 0) {
            console.log(`  ${n}/${cases.length}`);
        }
        if (res.status === 0) {
            console.log(`  WARN ${c.label}: ${res.body}`);
        }
    }
    console.log(`sweep done: ${n} cases sent`);
}

module.exports = { buildCases };

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
