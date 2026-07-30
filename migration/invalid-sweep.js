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
if (!port) {
    console.error('Usage: node migration/invalid-sweep.js <port>');
    process.exit(1);
}

// stable, syntactically valid dummy for a path param based on its Joi description
function dummyForParam(desc, name) {
    if (!desc) {
        return 'test';
    }
    const valids = desc.allow && desc.allow.filter(v => typeof v === 'string' && v);
    if (valids && valids.length) {
        return valids[0];
    }
    const rules = desc.rules || [];
    const hasHex = rules.some(r => r.name === 'hex');
    const lengthRule = rules.find(r => r.name === 'length');
    if (hasHex && lengthRule) {
        return '1'.repeat(Number(lengthRule.args && lengthRule.args.limit) || 24);
    }
    if (desc.type === 'number') {
        return '1';
    }
    if (name === 'domain') {
        return 'example.com';
    }
    return 'test';
}

function mergedDescribe(validationObjs) {
    // describe() each key individually: Joi's manifest validation chokes on
    // some schema shapes used in the routes (e.g. failover('')), and one bad
    // key must not lose introspection for the whole route
    const merged = {
        ...(validationObjs.pathParams || {}),
        ...(validationObjs.requestBody || {}),
        ...(validationObjs.queryParams || {})
    };
    const keys = {};
    for (const [key, schema] of Object.entries(merged)) {
        try {
            keys[key] = schema.describe();
        } catch {
            keys[key] = null;
        }
    }
    return { keys };
}

function buildCases() {
    const routes = collectRoutes();
    const cases = [];

    for (const route of routes) {
        if (!route.validationObjs) {
            continue;
        }
        if (route.responseType === 'text/event-stream' || route.path === '/users/:user/updates') {
            continue; // SSE hangs by design; migrated and verified separately
        }

        const desc = mergedDescribe(route.validationObjs);
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

main().catch(err => {
    console.error(err);
    process.exit(1);
});
