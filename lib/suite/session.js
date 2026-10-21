'use strict';

const crypto = require('crypto');
const config = require('@zone-eu/wild-config');

const SESSION_COOKIE_NAME = 'wd_session';
const LOCALE_COOKIE_NAME = 'wd_locale';
const REDIS_PREFIX = 'wdsuite:sess:';

function parseCookies(cookieHeader) {
    let cookies = {};
    if (!cookieHeader || typeof cookieHeader !== 'string') {
        return cookies;
    }
    let pairs = cookieHeader.split(';');
    for (let pair of pairs) {
        let idx = pair.indexOf('=');
        if (idx <= 0) {
            continue;
        }
        let key = pair.substring(0, idx).trim();
        let val = pair.substring(idx + 1).trim();
        try {
            cookies[key] = decodeURIComponent(val);
        } catch (err) {
            cookies[key] = val;
        }
    }
    return cookies;
}

function serializeCookie(name, value, options = {}) {
    let parts = [`${name}=${encodeURIComponent(value || '')}`];
    parts.push(`Path=${options.path || '/'}`);
    if (typeof options.maxAge === 'number') {
        parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
    }
    if (options.httpOnly !== false) {
        parts.push('HttpOnly');
    }
    parts.push(`SameSite=${options.sameSite || 'Lax'}`);
    if (options.secure) {
        parts.push('Secure');
    }
    return parts.join('; ');
}

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    let bufA = Buffer.from(a, 'utf8');
    let bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function signSessionId(sessionId, secret) {
    let hmac = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
    return `${sessionId}.${hmac}`;
}

function unsignSessionCookie(cookieValue, secret) {
    if (!cookieValue || typeof cookieValue !== 'string') {
        return null;
    }
    let dotIdx = cookieValue.lastIndexOf('.');
    if (dotIdx <= 0) {
        return null;
    }
    let sessionId = cookieValue.substring(0, dotIdx);
    let expected = signSessionId(sessionId, secret);
    if (!safeEqual(cookieValue, expected)) {
        return null;
    }
    return sessionId;
}

function createSessionManager(options = {}) {
    let secret = options.secret || (config.suite && config.suite.cookieSecret) || 'wildduck-suite-default-cookie-secret';
    let ttlSeconds = Number(options.ttlSeconds || (config.suite && config.suite.sessionTTL) || 28800);
    let redis = options.redis || null;
    let memoryStore = new Map();

    async function saveRecord(sessionId, data) {
        let payload = JSON.stringify(data);
        if (redis && typeof redis.set === 'function') {
            await redis.set(`${REDIS_PREFIX}${sessionId}`, payload, 'EX', ttlSeconds);
            return;
        }
        memoryStore.set(sessionId, {
            payload,
            expiresAt: Date.now() + ttlSeconds * 1000
        });
    }

    async function loadRecord(sessionId) {
        if (redis && typeof redis.get === 'function') {
            let raw = await redis.get(`${REDIS_PREFIX}${sessionId}`);
            return raw ? JSON.parse(raw) : null;
        }
        let entry = memoryStore.get(sessionId);
        if (!entry) {
            return null;
        }
        if (Date.now() > entry.expiresAt) {
            memoryStore.delete(sessionId);
            return null;
        }
        return JSON.parse(entry.payload);
    }

    async function createSession(data = {}) {
        let sessionId = crypto.randomBytes(24).toString('hex');
        let csrfToken = crypto.randomBytes(24).toString('hex');
        let session = {
            ...data,
            id: sessionId,
            csrfToken,
            createdAt: new Date().toISOString()
        };
        await saveRecord(sessionId, session);
        let cookieValue = signSessionId(sessionId, secret);
        return { session, cookieValue };
    }

    async function updateSession(session) {
        if (!session || !session.id) {
            return null;
        }
        await saveRecord(session.id, session);
        return session;
    }

    async function getSessionFromCookie(cookieValue) {
        let sessionId = unsignSessionCookie(cookieValue, secret);
        if (!sessionId) {
            return null;
        }
        return await loadRecord(sessionId);
    }

    async function destroySession(sessionId) {
        if (!sessionId) {
            return;
        }
        if (redis && typeof redis.del === 'function') {
            await redis.del(`${REDIS_PREFIX}${sessionId}`);
            return;
        }
        memoryStore.delete(sessionId);
    }

    function verifyCsrf(session, req) {
        if (!session || !session.csrfToken || !req) {
            return false;
        }
        let candidate =
            (req.headers && (req.headers['x-csrf-token'] || req.headers['X-CSRF-Token'])) ||
            (req.body && req.body._csrf) ||
            (req.query && req.query._csrf) ||
            '';
        return safeEqual(String(candidate), session.csrfToken);
    }

    return {
        ttlSeconds,
        createSession,
        updateSession,
        getSessionFromCookie,
        destroySession,
        verifyCsrf
    };
}

module.exports = {
    SESSION_COOKIE_NAME,
    LOCALE_COOKIE_NAME,
    parseCookies,
    serializeCookie,
    createSessionManager
};
