'use strict';

// Compares two JSONL recordings produced by record-proxy.js (same test suite
// run against the old and new API implementation). Volatile values (ObjectIds,
// dates, tokens, multipart boundaries) are normalized with a first-seen
// registry so cross-references stay comparable. JSON bodies are compared
// semantically (field order and whitespace ignored, missing/extra fields are
// failures). Non-JSON bodies compare after id/date normalization.
// Usage: node migration/diff-recordings.js <old.jsonl> <new.jsonl> [--max=20]
// Temporary tooling, delete after migration.

const fs = require('fs');

const fileA = process.argv[2];
const fileB = process.argv[3];
const maxReport = Number((process.argv[4] || '').replace('--max=', '')) || 20;

if (!fileA || !fileB) {
    console.error('Usage: node migration/diff-recordings.js <old.jsonl> <new.jsonl> [--max=N]');
    process.exit(1);
}

// headers whose values are inherently volatile or transport-specific
const DROP_HEADERS = new Set(['date', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'server', 'request-id', 'x-request-id', 'etag', 'vary',
    // @fastify/cors adds these on every response; restify-cors-middleware2
    // only did when an Origin header was present (documented deviation)
    'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-expose-headers']);

function makeRegistry() {
    return { map: new Map(), counts: new Map() };
}

// per-class counters: an extra allocation in one class must not shift
// placeholder indexes of every other class
function regMap(reg, cls, rawKey) {
    const key = cls + ':' + rawKey;
    if (!reg.map.has(key)) {
        const n = (reg.counts.get(cls) || 0) + 1;
        reg.counts.set(cls, n);
        reg.map.set(key, `<${cls}${n}>`);
    }
    return reg.map.get(key);
}

function normalizeString(str, reg) {
    return (
        str
            // 24-hex ObjectIds: stable first-seen placeholders keep relationships
            .replace(/\b[0-9a-f]{24}\b/gi, m => regMap(reg, 'oid', m.toLowerCase()))
            // 40-hex access tokens
            .replace(/\b[0-9a-f]{40}\b/gi, '<token40>')
            // PGP payloads are re-encrypted per run
            .replace(/-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/g, '<pgp>')
            // nodemailer MIME boundaries (random per generated message)
            .replace(/--_NmP-[0-9a-f]+-Part_\d+/gi, '<nmboundary>')
            .replace(/\bnm_[0-9a-f]{10,}\b/gi, '<nmboundary2>')
            // fixture subjects embed Date.now() inside MIME encoded words and
            // quoted-printable wrapping splits the digits across lines
            .replace(/_message_=5B[\s\S]{0,60}?=5D/g, '_message_=5B<n>=5D')
            // racy concurrent-store fixture content: uid ties break by random
            // _id, so numbered fixture docs pair differently across runs
            .replace(/\d{0,4}Test message \d{1,4}/g, 'Test message <n>')
            // shorter hex ids (ZoneMTA queue ids, message-id local parts):
            // registry-mapped so response body values match later request urls
            .replace(/\b[0-9a-f]{15,23}\b/gi, m => regMap(reg, 'hex' + m.length + '-', m.toLowerCase()))
            // ISO dates with optional millis/zone
            .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<isodate>')
            // JS Date().toString() form in generated fixture content
            .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \w{3} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}(?: \([^)]*\))?/g, '<jsdate>')
            // uuids
            .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
            // random 12-hex suffixes in generated test addresses
            .replace(/\b[0-9a-f]{12}\b/gi, '<hex12>')
            // RFC2822-ish dates (headers, message sources)
            .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+\w{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}(?:\s+(?:GMT|[+-]\d{4}))?\b/g, '<rfcdate>')
            // epoch millis (13 digits) and seconds (10 digits) standing alone
            .replace(/\b1[0-9]{12}\b/g, '<epochms>')
            .replace(/\b1[0-9]{9}\b/g, '<epochs>')
            // test-suite random username convention: name-<random>-<epochms>
            // or name-<epochms>-<random>
            .replace(/\b(\d{1,6})-<epochms>/g, '<rnd>-<epochms>')
            .replace(/<epochms>-(\d{1,6})\b/g, '<epochms>-<rnd>')
            // random 8-hex attachment filenames generated for PGP parts
            .replace(/\b[0-9a-f]{8}(?=\.asc\b)/g, '<hex8name>')
            // bare 8-digit random numbers in generated fixture subjects
            .replace(/\b\d{8}\b/g, '<num8>')
            // addresses created without a domain get os.hostname() appended;
            // the machine hostname drifts between captures (mac vs
            // macbook-pro.local depending on network state)
            .replace(/@(mac|macbook[a-z0-9.-]*)\b/gi, '@<hostname>')
            // base36 Date.now() tokens used in generated test usernames
            .replace(/\bms[0-9a-z]{6}\b/g, '<ts36>')
            // long base64/base64url runs that decode to JSON (pagination
            // cursors wrap EJSON): compare by normalized decoded content so
            // per-run ids/dates align but structural changes still surface
            .replace(/\b[A-Za-z0-9_-]{40,}\b/g, m => {
                try {
                    const inner = JSON.parse(Buffer.from(m, 'base64url').toString('utf8'));
                    return '<b64json:' + normalizeString(JSON.stringify(inner), reg) + '>';
                } catch {
                    return m;
                }
            })
            // multipart boundaries
            .replace(/-{4,}[a-zA-Z0-9'()+_,\-./:=?]{8,}/g, '<boundary>')
    );
}

// response fields that are volatile by nature (crypto signatures with embedded
// timestamps, generated passwords/keys); compared by presence + length bucket
// only. Matched on the path tail (parent.key or bare key).
const VOLATILE_FIELDS = new Set(['mobileconfig', 'password', 'dnsTxt.value', 'publicKey', 'fingerprint', 'fileContentHash', 'challenge', 'hash', 'qrcode', 'rawId', 'seed']);

// fields whose values are legitimately nondeterministic across runs of the
// suite (concurrent message stores race for uids; generated MIME boundary
// length varies message size by a few bytes); dropped from comparison
const SKIP_FIELDS = new Set(['message.id', 'message.size', 'results.id']);

function pathTail(parent, key) {
    return parent ? `${parent}.${key}` : key;
}

function normalizeValue(value, reg, tail) {
    if (typeof value === 'string') {
        const bare = tail && tail.includes('.') ? tail.slice(tail.lastIndexOf('.') + 1) : tail;
        if (tail && (VOLATILE_FIELDS.has(tail) || VOLATILE_FIELDS.has(bare))) {
            return `<volatile:${Math.round(value.length / 1024)}>`;
        }
        return normalizeString(value, reg);
    }
    if (Array.isArray(value)) {
        return value.map(v => normalizeValue(v, reg, tail));
    }
    if (value && typeof value === 'object') {
        const out = {};
        const parentKey = tail && tail.includes('.') ? tail.slice(tail.lastIndexOf('.') + 1) : tail;
        for (const key of Object.keys(value).sort()) {
            const keyTail = pathTail(parentKey, key);
            if (SKIP_FIELDS.has(keyTail) || SKIP_FIELDS.has(key)) {
                continue;
            }
            out[key] = normalizeValue(value[key], reg, keyTail);
        }
        return out;
    }
    return value;
}

function decodeBody(body) {
    if (!body) {
        return { kind: 'empty' };
    }
    if (body.base64) {
        return { kind: 'binary', size: Buffer.from(body.base64, 'base64').length, truncated: !!body.truncated };
    }
    return { kind: 'text', text: body.text || '', truncated: !!body.truncated };
}

function safeDecodeURI(url) {
    try {
        return decodeURIComponent(url);
    } catch {
        return url;
    }
}

function normalizeRecord(rec, reg) {
    const headers = {};
    for (const [k, v] of Object.entries(rec.resHeaders || {})) {
        const key = k.toLowerCase();
        if (DROP_HEADERS.has(key)) {
            continue;
        }
        headers[key] = normalizeValue(String(v), reg);
    }

    const body = decodeBody(rec.resBody);
    let bodyNorm;
    const ctype = String((rec.resHeaders && rec.resHeaders['content-type']) || '');

    // migrated routes produce Ajv-worded validation errors; the goal accepts
    // text differences but the shape, the code and the set of offending
    // field paths must match, so blank only the message strings
    const maskValidationMessages = json => {
        if (json && typeof json === 'object' && json.code === 'InputValidationError') {
            const out = Object.assign({}, json, { error: '<validation-msg>' });
            if (out.details && typeof out.details === 'object') {
                const details = {};
                for (const key of Object.keys(out.details)) {
                    details[key] = '<validation-msg>';
                }
                out.details = details;
            }
            return out;
        }
        return json;
    };
    if (['/metrics', '/api-methods'].includes((rec.url || '').split('?')[0])) {
        // prometheus counters are volatile by definition; presence-only
        return { method: rec.method, url: (rec.url || '').split('?')[0], status: rec.status, headers, body: { presenceOnly: true }, proxyError: rec.proxyError };
    }
    if (body.kind === 'text' && /json/.test(ctype)) {
        try {
            bodyNorm = { json: normalizeValue(maskValidationMessages(JSON.parse(body.text)), reg) };
        } catch {
            bodyNorm = { text: normalizeString(body.text, reg) };
        }
    } else if (body.kind === 'text') {
        bodyNorm = { text: normalizeString(body.text, reg) };
    } else if (body.kind === 'binary') {
        bodyNorm = { binarySize: body.size };
    } else {
        bodyNorm = { empty: true };
    }

    return {
        method: rec.method,
        url: normalizeString(safeDecodeURI(rec.url || ''), reg),
        status: rec.status,
        headers,
        body: bodyNorm,
        proxyError: rec.proxyError
    };
}

function load(file) {
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));
}

function firstDiff(a, b, path = '$') {
    if (typeof a !== typeof b) {
        return `${path}: type ${typeof a} vs ${typeof b}`;
    }
    if (a && b && typeof a === 'object') {
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        for (const k of keysA) {
            if (!(k in b)) {
                return `${path}.${k}: missing in NEW`;
            }
        }
        for (const k of keysB) {
            if (!(k in a)) {
                return `${path}.${k}: extra in NEW`;
            }
        }
        for (const k of keysA) {
            const d = firstDiff(a[k], b[k], `${path}.${k}`);
            if (d) {
                return d;
            }
        }
        return null;
    }
    if (a !== b) {
        const show = v => (typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : JSON.stringify(v));
        return `${path}: ${show(a)} vs ${show(b)}`;
    }
    return null;
}

const recsA = load(fileA);
const recsB = load(fileB);

console.log(`old: ${recsA.length} records, new: ${recsB.length} records`);
if (recsA.length !== recsB.length) {
    console.log('WARNING: record counts differ, aligning by position until divergence');
}

const regA = makeRegistry();
const regB = makeRegistry();
let mismatches = 0;

const n = Math.min(recsA.length, recsB.length);
for (let i = 0; i < n; i++) {
    const a = normalizeRecord(recsA[i], regA);
    const b = normalizeRecord(recsB[i], regB);

    if (a.method !== b.method || a.url !== b.url) {
        console.log(`#${i + 1} REQUEST DESYNC: ${a.method} ${a.url}  vs  ${b.method} ${b.url}`);
        console.log('stopping: recordings are no longer aligned');
        process.exitCode = 1;
        return;
    }

    const diff = firstDiff({ status: a.status, headers: a.headers, body: a.body }, { status: b.status, headers: b.headers, body: b.body });

    if (diff) {
        mismatches++;
        if (mismatches <= maxReport) {
            console.log(`#${i + 1} ${a.method} ${a.url}`);
            console.log(`   ${diff}`);
        }
    }
}

if (recsA.length !== recsB.length) {
    mismatches++;
}

console.log(mismatches ? `FAIL: ${mismatches} mismatching responses (showing first ${Math.min(mismatches, maxReport)})` : `OK: ${n} responses match`);
process.exitCode = mismatches ? 1 : 0;
