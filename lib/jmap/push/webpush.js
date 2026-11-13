'use strict';

// Web Push (RFC 8030) towards the URL of a PushSubscription (RFC 8620 7.2): message encryption
// (RFC 8291, aes128gcm of RFC 8188), VAPID authentication (RFC 8292) and the HTTP request itself.
//
// Push URLs come from clients, so every request is a server side request to a client chosen host.
// The host is resolved once per request, every address it resolves to must be public, and the
// connection goes to exactly the address that was checked (no second lookup between the check and the
// connection). Redirects are never followed.

const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const net = require('net');
const tls = require('tls');

const RECORD_SIZE = 4096;
const KEY_LENGTH = 65;
const AUTH_LENGTH = 16;
const MAX_URL_LENGTH = 2048;
// largest response body read from a push service (only to drain the socket)
const MAX_RESPONSE = 64 * 1024;

const b64url = buffer => Buffer.from(buffer).toString('base64url');

/** Decodes strict base64url (padding tolerated), or null */
function fromB64url(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
        return null;
    }
    return Buffer.from(value.replace(/[=]+$/, ''), 'base64url');
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const ONE = Buffer.from([1]);

/**
 * Checks the keys of a PushSubscription: a P-256 public key in uncompressed form and a 16 byte
 * authentication secret, both base64url (RFC 8291 2).
 *
 * @returns {{p256dh: String, auth: String}|null} the keys in canonical form, or null when invalid
 */
function parseKeys(keys) {
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).some(key => !['p256dh', 'auth'].includes(key))) {
        return null;
    }
    const publicKey = fromB64url(keys.p256dh);
    const auth = fromB64url(keys.auth);
    if (!publicKey || publicKey.length !== KEY_LENGTH || publicKey[0] !== 0x04 || !auth || auth.length !== AUTH_LENGTH) {
        return null;
    }
    try {
        // throws for a point that is not on the curve
        crypto.createPublicKey({
            key: { kty: 'EC', crv: 'P-256', x: b64url(publicKey.subarray(1, 33)), y: b64url(publicKey.subarray(33)) },
            format: 'jwk'
        });
    } catch {
        return null;
    }
    return { p256dh: b64url(publicKey), auth: b64url(auth) };
}

/** Key and nonce of a message (RFC 8291 3.4, RFC 8188 2.2) */
function contentKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt) {
    const prkKey = hmac(authSecret, ecdhSecret);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
    const ikm = hmac(prkKey, Buffer.concat([keyInfo, ONE]));
    const prk = hmac(salt, ikm);
    return {
        cek: hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), ONE])).subarray(0, 16),
        nonce: hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), ONE])).subarray(0, 12)
    };
}

/**
 * Encrypts a push message for a subscription (RFC 8291): one aes128gcm record with a fresh salt and
 * a fresh application server key pair, unless given (for the RFC test vector).
 *
 * @param {Buffer|String} plaintext
 * @param {{p256dh: String, auth: String}} keys
 * @param {Object} [options] {salt: Buffer, privateKey: Buffer (application server private key)}
 * @returns {Buffer} the request body
 */
function encrypt(plaintext, keys, options = {}) {
    const uaPublic = fromB64url(keys.p256dh);
    const authSecret = fromB64url(keys.auth);
    const ecdh = crypto.createECDH('prime256v1');
    if (options.privateKey) {
        ecdh.setPrivateKey(options.privateKey);
    } else {
        ecdh.generateKeys();
    }
    const asPublic = ecdh.getPublicKey();
    const salt = options.salt || crypto.randomBytes(16);
    const { cek, nonce } = contentKeys(ecdh.computeSecret(uaPublic), authSecret, uaPublic, asPublic, salt);

    const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
    if (data.length + 16 > RECORD_SIZE) {
        throw new Error('push message too large');
    }
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const sealed = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);

    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(RECORD_SIZE, 16);
    header[20] = asPublic.length;
    return Buffer.concat([header, asPublic, sealed]);
}

/**
 * Decrypts a single record aes128gcm push message with the user agent keys (the receiving side, used
 * by tests and tools).
 *
 * @param {Buffer} body
 * @param {Buffer} uaPrivate user agent private key
 * @param {String} auth base64url authentication secret
 * @returns {Buffer} the plaintext
 */
function decrypt(body, uaPrivate, auth) {
    const salt = body.subarray(0, 16);
    const idLength = body[20];
    const asPublic = body.subarray(21, 21 + idLength);
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(uaPrivate);
    const { cek, nonce } = contentKeys(ecdh.computeSecret(asPublic), fromB64url(auth), ecdh.getPublicKey(), asPublic, salt);
    const sealed = body.subarray(21 + idLength);
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const data = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    // strip the padding and its delimiter
    let end = data.length - 1;
    while (end > 0 && data[end] === 0) {
        end--;
    }
    if (data[end] !== 2) {
        throw new Error('invalid padding delimiter');
    }
    return data.subarray(0, end);
}

/**
 * The Authorization header of a push request (RFC 8292 3): a JWT signed with ES256 for the origin of
 * the push URL, and the application server public key.
 *
 * @param {{privateKey: KeyObject, publicKey: String}} vapid the key pair, publicKey as base64url
 * @param {String} url the push URL
 * @param {String} subject contact URI (mailto: or https:)
 * @param {Number} [now] ms
 * @param {Number} [lifetime] seconds the token is valid, at most 24 hours
 */
function vapidAuthorization(vapid, url, subject, now = Date.now(), lifetime = 12 * 3600) {
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64url(JSON.stringify({ aud: new URL(url).origin, exp: Math.floor(now / 1000) + Math.min(lifetime, 24 * 3600), sub: subject }));
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

// ---------------------------------------------------------------- target checks

// addresses a push request may never go to: this host, private networks, link local, shared address
// space, multicast and reserved ranges. IPv4 embedded in IPv6 (mapped, compatible, NAT64, 6to4) is
// checked as IPv4 by embeddedIPv4(); the IPv6 list leaves ::/96 and ::ffff:0:0/96 out because a
// BlockList matches IPv4 addresses against those as well
const BLOCKED = new net.BlockList();
for (const [prefix, length] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
]) {
    BLOCKED.addSubnet(prefix, length, 'ipv4');
}
for (const [prefix, length] of [
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 32],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8]
]) {
    BLOCKED.addSubnet(prefix, length, 'ipv6');
}

/** The IPv4 address embedded in an IPv4 mapped, compatible, NAT64 or 6to4 IPv6 address, or null */
function embeddedIPv4(address) {
    const bytes = ipv6Bytes(address);
    if (!bytes) {
        return null;
    }
    const zeros = count => bytes.subarray(0, count).every(byte => byte === 0);
    // ::a.b.c.d and ::ffff:a.b.c.d
    if (zeros(10) && ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))) {
        return bytes.subarray(12).join('.');
    }
    // NAT64 64:ff9b::/96
    if (bytes.readUInt16BE(0) === 0x64 && bytes.readUInt16BE(2) === 0xff9b) {
        return bytes.subarray(12).join('.');
    }
    // 6to4 2002:aabb:ccdd::/48
    if (bytes.readUInt16BE(0) === 0x2002) {
        return bytes.subarray(2, 6).join('.');
    }
    return null;
}

/** The 16 octets of an IPv6 address (a dotted IPv4 tail allowed), or null */
function ipv6Bytes(address) {
    let text = address;
    const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (tail) {
        const octets = Buffer.from(tail[1].split('.').map(Number));
        text = text.slice(0, -tail[1].length) + octets.readUInt16BE(0).toString(16) + ':' + octets.readUInt16BE(2).toString(16);
    }
    const halves = text.split('::');
    const parse = part => (part ? part.split(':').map(group => parseInt(group, 16)) : []);
    const head = parse(halves[0]);
    const rest = halves.length > 1 ? parse(halves[1]) : [];
    const groups = halves.length > 1 ? [...head, ...new Array(Math.max(8 - head.length - rest.length, 0)).fill(0), ...rest] : head;
    if (groups.length !== 8 || !groups.every(group => group >= 0 && group <= 0xffff)) {
        return null;
    }
    const bytes = Buffer.alloc(16);
    groups.forEach((group, i) => bytes.writeUInt16BE(group, i * 2));
    return bytes;
}

/** True when an IP address is a public unicast address a push request may go to */
function isPublicAddress(address) {
    const family = net.isIP(address);
    if (family === 4) {
        return !BLOCKED.check(address, 'ipv4');
    }
    if (family !== 6) {
        return false;
    }
    const v4 = embeddedIPv4(address);
    if (v4 && BLOCKED.check(v4, 'ipv4')) {
        return false;
    }
    if (v4 && /^::(ffff:)?\d/i.test(address)) {
        // an IPv4 mapped or compatible address is as public as its IPv4 address
        return true;
    }
    // otherwise only global unicast (2000::/3) is public: everything else in ::/8 (IPv4 translated
    // ::ffff:0:0/96 and the like), unique local, link local, multicast and unassigned space is refused
    const bytes = ipv6Bytes(address);
    return !!bytes && bytes[0] >= 0x20 && bytes[0] <= 0x3f && !BLOCKED.check(address, 'ipv6');
}

/**
 * Parses a push URL: an absolute https URL without credentials, at most 2048 characters.
 *
 * @returns {URL|null}
 */
function parsePushUrl(value) {
    // eslint-disable-next-line no-control-regex
    if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || /[\s\x00-\x1f\x7f]/.test(value)) {
        return null;
    }
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
        return null;
    }
    return url;
}

class TargetError extends Error {}

// Default DNS timeout of one resolution when the caller gives none (ms)
const RESOLVE_TIMEOUT = 5000;

/**
 * Resolves a host name to its A and AAAA records with c-ares (no libuv threadpool, so a slow DNS
 * server never blocks file system or crypto work). /etc/hosts is not consulted: push services are
 * public hosts, and names of the test DNS server go through domainResolver.
 *
 * @param {dns.promises.Resolver} resolver
 * @param {String} hostname
 * @returns {Promise<Array<{address: String, family: Number}>>}
 */
async function resolveAddresses(resolver, hostname) {
    const settled = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const found = settled.flatMap((result, i) => (result.status === 'fulfilled' ? result.value.map(address => ({ address, family: i ? 6 : 4 })) : []));
    if (!found.length) {
        const failed = settled.find(result => result.status === 'rejected');
        const err = new Error('not found');
        err.code = (failed && failed.reason && failed.reason.code) || 'ENOTFOUND';
        throw err;
    }
    return found;
}

// one default resolver per timeout value (the configured push.timeout, so in practice one)
const publicResolvers = new Map();

/**
 * The default resolver function: c-ares with the system DNS servers. resolveTarget() gives up on a
 * resolution after the timeout; the c-ares queries are sized to it (half of it per try, two tries), so
 * an abandoned query ends on its own soon after and holds no thread or worker slot.
 *
 * @param {Number} [timeout] ms the resolution may take
 */
function publicResolver(timeout = RESOLVE_TIMEOUT) {
    let resolve = publicResolvers.get(timeout);
    if (!resolve) {
        const resolver = new dns.promises.Resolver({ timeout: Math.max(Math.floor(timeout / 2), 1), tries: 2 });
        resolve = hostname => resolveAddresses(resolver, hostname);
        publicResolvers.set(timeout, resolve);
    }
    return resolve;
}

/** Runs a resolution, giving up after the timeout: the one deadline of every resolver, default or injected. */
function withTimeout(promise, timeout) {
    let timer;
    const expired = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            const err = new Error('DNS timeout');
            err.code = 'ETIMEOUT';
            reject(err);
        }, timeout);
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * Resolves the host of a push URL and checks every address.
 *
 * @param {URL} url
 * @param {Object} options {allowHosts: Set of host names exempt from the address check (tests),
 *   resolve: async (hostname, timeout) => [{address, family}] (default: publicResolver(timeout)),
 *   timeout: ms the resolution may take (default 5000)}
 * @returns {Promise<{address: String, family: Number}>} the address to connect to
 * @throws {TargetError} when the host does not resolve in time or resolves to an address that is not public
 */
async function resolveTarget(url, options = {}) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const exempt = options.allowHosts && options.allowHosts.has(hostname);
    if (!exempt && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
        throw new TargetError('the host is not public');
    }
    let addresses;
    if (net.isIP(hostname)) {
        addresses = [{ address: hostname, family: net.isIP(hostname) }];
    } else {
        try {
            const timeout = options.timeout || RESOLVE_TIMEOUT;
            addresses = await withTimeout((options.resolve || publicResolver(timeout))(hostname, timeout), timeout);
        } catch (err) {
            throw new TargetError(`the host does not resolve (${err.code || err.message})`);
        }
    }
    if (!addresses || !addresses.length) {
        throw new TargetError('the host does not resolve');
    }
    if (!exempt && addresses.some(entry => !isPublicAddress(entry.address))) {
        throw new TargetError('the host resolves to an address that is not public');
    }
    return addresses[0];
}

/**
 * A resolver that sends names under the given domains to other DNS servers (a test DNS server), and
 * every other name to the default resolver of the timeout.
 *
 * @param {String[]} servers "host:port" entries
 * @param {String[]} domains
 */
function domainResolver(servers, domains) {
    const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
    resolver.setServers(servers);
    const matches = hostname => domains.some(domain => hostname === domain || hostname.endsWith('.' + domain));
    return (hostname, timeout) => (matches(hostname) ? resolveAddresses(resolver, hostname) : publicResolver(timeout)(hostname));
}

/**
 * POSTs to a push URL, connecting only to the given, already checked address. Never follows redirects.
 *
 * @param {URL} url
 * @param {{address: String, family: Number}} target
 * @param {Buffer} body
 * @param {Object} headers
 * @param {Object} options {timeout: ms, ca: extra trusted certificates}
 * @returns {Promise<{status: Number, headers: Object}>}
 * @throws for connection errors and the timeout
 */
function post(url, target, body, headers, options = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finish = (err, result) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                return err ? reject(err) : resolve(result);
            }
        };
        const request = https.request(
            {
                method: 'POST',
                host: target.address,
                port: url.port || 443,
                path: url.pathname + url.search,
                // the certificate is checked against the host name of the URL
                servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
                headers: Object.assign({ Host: url.host, 'Content-Length': body.length }, headers),
                ca: options.ca,
                agent: false,
                lookup: (hostname, lookupOptions, callback) =>
                    lookupOptions && lookupOptions.all ? callback(null, [target]) : callback(null, target.address, target.family),
                checkServerIdentity: (host, cert) => tls.checkServerIdentity(url.hostname.replace(/^\[|\]$/g, ''), cert)
            },
            response => {
                let size = 0;
                response.on('data', chunk => {
                    size += chunk.length;
                    if (size > MAX_RESPONSE) {
                        response.destroy();
                    }
                });
                response.on('error', () => false);
                response.on('close', () => finish(null, { status: response.statusCode, headers: response.headers }));
                response.on('end', () => finish(null, { status: response.statusCode, headers: response.headers }));
            }
        );
        timer = setTimeout(() => {
            const err = new Error('push request timed out');
            err.code = 'ETIMEDOUT';
            request.destroy(err);
            finish(err);
        }, options.timeout || 10000);
        request.on('error', err => finish(err));
        request.end(body);
    });
}

module.exports = {
    parseKeys,
    encrypt,
    decrypt,
    vapidAuthorization,
    isPublicAddress,
    ipv6Bytes,
    parsePushUrl,
    resolveTarget,
    domainResolver,
    publicResolver,
    post,
    TargetError,
    b64url,
    fromB64url,
    RECORD_SIZE
};
