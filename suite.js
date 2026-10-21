/* eslint no-invalid-this: 0 */

'use strict';

const Path = require('path');
const fs = require('fs');
const fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const fastifyMultipart = require('@fastify/multipart');
const qs = require('qs');
const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const db = require('./lib/db');
const SuiteApiClient = require('./lib/suite/api-client');
const { defaultI18n } = require('./lib/suite/i18n');
const {
    SESSION_COOKIE_NAME,
    LOCALE_COOKIE_NAME,
    parseCookies,
    serializeCookie,
    createSessionManager
} = require('./lib/suite/session');
const { renderDocument } = require('./lib/suite/views/layout');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

async function createSuiteApp(options = {}) {
    let app = fastify({
        logger: false,
        bodyLimit: 50 * 1024 * 1024
    });

    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
        try {
            return done(null, qs.parse(body));
        } catch (err) {
            return done(err);
        }
    });

    await app.register(fastifyMultipart, {
        limits: {
            fileSize: 25 * 1024 * 1024,
            files: 10
        }
    });

    await app.register(fastifyStatic, {
        root: Path.join(__dirname, 'public', 'suite'),
        prefix: '/suite-assets/',
        decorateReply: false
    });

    let i18n = options.i18n || defaultI18n;
    let sessionManager =
        options.sessionManager ||
        createSessionManager({
            secret: options.cookieSecret || (config.suite && config.suite.cookieSecret),
            ttlSeconds: options.sessionTTL || (config.suite && config.suite.sessionTTL),
            redis: options.redis !== undefined ? options.redis : db.redis
        });
    let apiClient = options.apiClient || new SuiteApiClient(options.apiOptions || {});

    app.decorate('suiteI18n', i18n);
    app.decorate('suiteSessions', sessionManager);
    app.decorate('suiteApi', apiClient);
    app.decorate('suiteOptions', options);

    app.decorateRequest('cookies', null);
    app.decorateRequest('locale', 'en');
    app.decorateRequest('t', null);
    app.decorateRequest('session', null);

    app.decorateReply('setCookie', function (name, value, cookieOpts = {}) {
        let headerVal = serializeCookie(name, value, cookieOpts);
        let existing = this.getHeader('Set-Cookie');
        if (!existing) {
            this.header('Set-Cookie', headerVal);
        } else if (Array.isArray(existing)) {
            this.header('Set-Cookie', [...existing, headerVal]);
        } else {
            this.header('Set-Cookie', [existing, headerVal]);
        }
        return this;
    });

    app.decorateReply('toast', function (message) {
        if (message) {
            let safeAsciiJson = JSON.stringify({ showToast: String(message) }).replace(
                /[\u007f-\uffff]/g,
                ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
            );
            this.header('HX-Trigger', safeAsciiJson);
        }
        return this;
    });

    app.decorateReply('renderPage', function (pageOpts = {}) {
        let req = this.request;
        let rendered = renderDocument({
            req,
            t: req.t,
            locale: req.locale,
            session: req.session,
            csrfToken: (req.session && req.session.csrfToken) || '',
            ...pageOpts
        });
        this.type('text/html; charset=utf-8').send(rendered);
        return this;
    });

    app.addHook('preHandler', async (req, reply) => {
        req.cookies = parseCookies(req.headers.cookie);
        req.locale = i18n.resolveRequestLocale(req);
        req.t = i18n.createTranslator(req.locale);

        if (req.query && req.query.lang) {
            reply.setCookie(LOCALE_COOKIE_NAME, req.locale, {
                maxAge: 365 * 24 * 3600,
                httpOnly: false
            });
        }

        let rawSessionCookie = req.cookies[SESSION_COOKIE_NAME];
        if (rawSessionCookie) {
            req.session = await sessionManager.getSessionFromCookie(rawSessionCookie);
        }

        let routeConfig = (req.routeOptions && req.routeOptions.config) || {};
        if (MUTATING_METHODS.has(req.method) && req.session && !routeConfig.skipCsrf) {
            if (!sessionManager.verifyCsrf(req.session, req)) {
                return reply.code(403).type('text/html; charset=utf-8').send(`<div class="badge badge-fail">${req.t('common.csrfError')}</div>`);
            }
        }
    });

    app.get('/suite-health', async () => ({
        success: true,
        service: 'wildduck-suite',
        locales: i18n.getSupportedLocales()
    }));

    app.post('/locale', { config: { skipCsrf: true } }, async (req, reply) => {
        let requestedLang = (req.body && req.body.lang) || (req.query && req.query.lang) || 'en';
        let resolved = i18n.resolveRequestLocale({ query: { lang: requestedLang } });
        let redirectTo = (req.body && req.body.redirectTo) || req.headers.referer || '/';
        if (!String(redirectTo).startsWith('/')) {
            redirectTo = '/';
        }

        reply.setCookie(LOCALE_COOKIE_NAME, resolved, {
            maxAge: 365 * 24 * 3600,
            httpOnly: false
        });

        if (req.headers['hx-request'] === 'true') {
            return reply.header('HX-Redirect', redirectTo).send('');
        }
        return reply.redirect(redirectTo);
    });

    let installerRoutesPath = Path.join(__dirname, 'lib', 'suite', 'installer', 'routes.js');
    if (fs.existsSync(installerRoutesPath)) {
        // eslint-disable-next-line global-require
        await app.register(require(installerRoutesPath));
    }

    let adminRoutesPath = Path.join(__dirname, 'lib', 'suite', 'admin', 'routes.js');
    if (fs.existsSync(adminRoutesPath)) {
        // eslint-disable-next-line global-require
        await app.register(require(adminRoutesPath));
    }

    let webmailRoutesPath = Path.join(__dirname, 'lib', 'suite', 'webmail', 'routes.js');
    if (fs.existsSync(webmailRoutesPath)) {
        // eslint-disable-next-line global-require
        await app.register(require(webmailRoutesPath));
    }

    return app;
}

module.exports = async () => {
    if (!config.suite || !config.suite.enabled) {
        return false;
    }

    let app = await createSuiteApp();
    let port = Number(config.suite.port) || 8088;
    let host = config.suite.host || '127.0.0.1';

    await app.listen({ port, host });
    log.info('Suite', 'HTMX Mail Suite server listening on %s:%s', host, port);
    return app;
};

module.exports.createSuiteApp = createSuiteApp;
