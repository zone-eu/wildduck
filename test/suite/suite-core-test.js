/* eslint no-invalid-this: 0, no-unused-expressions: 0 */

'use strict';

const chai = require('chai');
const { escapeHtml, rawHtml, html, formatBytes } = require('../../lib/suite/html');
const { createI18n, defaultI18n } = require('../../lib/suite/i18n');
const { createSessionManager, parseCookies, serializeCookie } = require('../../lib/suite/session');
const SuiteApiClient = require('../../lib/suite/api-client');
const { renderDocument, isHtmxRequest } = require('../../lib/suite/views/layout');
const { createSuiteApp } = require('../../suite');

const expect = chai.expect;

describe('Suite Core - HTML & i18n (Task 1)', () => {
    describe('HTML escaping and template tag', () => {
        it('escapes dangerous HTML characters and handles null/undefined safely', () => {
            expect(escapeHtml('<script>alert("xss")</script>')).to.include('&lt;script&gt;');
            expect(escapeHtml(null)).to.equal('');
            expect(escapeHtml(undefined)).to.equal('');
            expect(escapeHtml(42)).to.equal('42');
        });

        it('auto-escapes interpolated values in html template literals while preserving rawHtml fragments', () => {
            let untrusted = '<img src=x onerror=alert(1)>';
            let trusted = rawHtml('<strong>Safe Bold</strong>');
            let rendered = html`<div class="card">${untrusted}${trusted}</div>`;

            expect(rendered.toString()).to.include('&lt;img src=x onerror=alert(1)&gt;');
            expect(rendered.toString()).to.include('<strong>Safe Bold</strong>');
        });

        it('joins arrays of fragments inside html template literals', () => {
            let items = ['<a>1</a>', rawHtml('<span>2</span>')];
            let rendered = html`<ul>${items}</ul>`.toString();

            expect(rendered).to.include('&lt;a&gt;1&lt;/a&gt;');
            expect(rendered).to.include('<span>2</span>');
        });

        it('formats byte sizes into human-readable units', () => {
            expect(formatBytes(0)).to.equal('0 B');
            expect(formatBytes(1024)).to.equal('1.0 KB');
            expect(formatBytes(1048576 * 5)).to.equal('5.0 MB');
            expect(formatBytes(1073741824 * 2)).to.equal('2.0 GB');
        });
    });

    describe('Multi-language i18n engine', () => {
        it('loads English and Vietnamese locales with 100% key parity', () => {
            let locales = defaultI18n.getSupportedLocales();
            expect(locales).to.include('en');
            expect(locales).to.include('vi');

            let enKeys = Object.keys(defaultI18n.getCatalog('en')).sort();
            let viKeys = Object.keys(defaultI18n.getCatalog('vi')).sort();
            expect(viKeys).to.deep.equal(enKeys);
        });

        it('translates keys and interpolates named placeholders', () => {
            let tEn = defaultI18n.createTranslator('en');
            let tVi = defaultI18n.createTranslator('vi');

            expect(tEn('common.appName')).to.equal('WildDuck Mail Suite');
            expect(tVi('common.appName')).to.equal('WildDuck Mail Suite');
            expect(tEn('installer.welcomeTitle', { version: '1.55.1' })).to.include('1.55.1');
            expect(tVi('installer.welcomeTitle', { version: '1.55.1' })).to.include('1.55.1');
        });

        it('falls back to English when a locale or key is missing', () => {
            let custom = createI18n({
                en: { greeting: 'Hello {{user}}', fallbackOnly: 'English default' },
                vi: { greeting: 'Xin chao {{user}}' }
            });

            expect(custom.t('vi', 'greeting', { user: '<Admin>' })).to.equal('Xin chao <Admin>');
            expect(custom.t('vi', 'fallbackOnly')).to.equal('English default');
            expect(custom.t('fr', 'greeting', { user: 'Jean' })).to.equal('Hello Jean');
            expect(custom.t('en', 'unknown.key')).to.equal('unknown.key');
        });

        it('negotiates request locale from query, cookie, and Accept-Language header in priority order', () => {
            expect(
                defaultI18n.resolveRequestLocale({
                    query: { lang: 'vi' },
                    cookies: { wd_locale: 'en' },
                    headers: { 'accept-language': 'en-US,en;q=0.9' }
                })
            ).to.equal('vi');

            expect(
                defaultI18n.resolveRequestLocale({
                    query: {},
                    cookies: { wd_locale: 'vi' },
                    headers: { 'accept-language': 'en-US,en;q=0.9' }
                })
            ).to.equal('vi');

            expect(
                defaultI18n.resolveRequestLocale({
                    query: {},
                    cookies: {},
                    headers: { 'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8' }
                })
            ).to.equal('vi');

            expect(
                defaultI18n.resolveRequestLocale({
                    query: {},
                    cookies: {},
                    headers: { 'accept-language': 'de-DE,de;q=0.9' }
                })
            ).to.equal('en');
        });
    });

    describe('Session & CSRF Manager (Task 2)', () => {
        it('parses and serializes HTTP cookies with security flags', () => {
            let parsed = parseCookies('wd_locale=vi; wd_session=abc.123; theme=dark');
            expect(parsed).to.deep.equal({
                wd_locale: 'vi',
                wd_session: 'abc.123',
                theme: 'dark'
            });

            let header = serializeCookie('wd_session', 'token123', {
                httpOnly: true,
                sameSite: 'Lax',
                path: '/',
                maxAge: 3600
            });
            expect(header).to.include('wd_session=token123');
            expect(header).to.include('HttpOnly');
            expect(header).to.include('SameSite=Lax');
            expect(header).to.include('Max-Age=3600');
        });

        it('creates signed sessions, persists data, and enforces CSRF tokens on mutations', async () => {
            let manager = createSessionManager({ secret: 'test-secret-key', ttlSeconds: 600 });
            let created = await manager.createSession({
                userId: '507f191e810c19729de860ea',
                username: 'alice',
                role: 'user',
                accessToken: 'tok_alice'
            });

            expect(created.cookieValue).to.be.a('string').and.include('.');
            expect(created.session.csrfToken).to.be.a('string').with.length.greaterThan(16);

            let loaded = await manager.getSessionFromCookie(created.cookieValue);
            expect(loaded.username).to.equal('alice');
            expect(loaded.accessToken).to.equal('tok_alice');

            // Tampered cookie signature must be rejected
            let tampered = `${created.cookieValue}tamper`;
            expect(await manager.getSessionFromCookie(tampered)).to.equal(null);

            // CSRF validation passes with matching header or body token and fails otherwise
            expect(manager.verifyCsrf(loaded, { headers: { 'x-csrf-token': loaded.csrfToken } })).to.equal(true);
            expect(manager.verifyCsrf(loaded, { body: { _csrf: loaded.csrfToken } })).to.equal(true);
            expect(manager.verifyCsrf(loaded, { headers: { 'x-csrf-token': 'wrong-token' } })).to.equal(false);

            await manager.destroySession(created.session.id);
            expect(await manager.getSessionFromCookie(created.cookieValue)).to.equal(null);
        });
    });

    describe('Loopback WildDuck API Client (Task 2)', () => {
        it('forwards access tokens, serializes query parameters, and parses JSON responses', async () => {
            let calls = [];
            let client = new SuiteApiClient({
                apiUrl: 'http://127.0.0.1:8080',
                fetch: async (url, options) => {
                    calls.push({ url: url.toString(), options });
                    return {
                        ok: true,
                        status: 200,
                        headers: new Map([['content-type', 'application/json']]),
                        json: async () => ({ success: true, results: [{ id: 'u1', username: 'admin' }] })
                    };
                }
            });

            let res = await client.get('/users', { query: { limit: 10, query: 'admin', empty: undefined }, token: 'secret_token' });
            expect(res.success).to.equal(true);
            expect(res.results).to.have.lengthOf(1);
            expect(calls[0].url).to.equal('http://127.0.0.1:8080/users?limit=10&query=admin');
            expect(calls[0].options.headers['X-Access-Token']).to.equal('secret_token');
        });

        it('preserves API error codes and masks raw loopback connection failures', async () => {
            let errorClient = new SuiteApiClient({
                apiUrl: 'http://127.0.0.1:8080',
                fetch: async () => ({
                    ok: false,
                    status: 403,
                    headers: new Map([['content-type', 'application/json']]),
                    json: async () => ({ error: 'Auth failed', code: 'AuthFailed' })
                })
            });

            let caught;
            try {
                await errorClient.post('/authenticate', { body: { username: 'bob', password: 'wrong' } });
            } catch (err) {
                caught = err;
            }
            expect(caught).to.be.instanceOf(Error);
            expect(caught.code).to.equal('AuthFailed');
            expect(caught.responseCode).to.equal(403);

            let offlineClient = new SuiteApiClient({
                apiUrl: 'http://127.0.0.1:8080',
                fetch: async () => {
                    throw new Error('connect ECONNREFUSED 127.0.0.1:8080');
                }
            });

            let netErr;
            try {
                await offlineClient.get('/health');
            } catch (err) {
                netErr = err;
            }
            expect(netErr.code).to.equal('ApiUnavailable');
            expect(netErr.responseCode).to.equal(503);
            expect(netErr.message).to.not.include('127.0.0.1');
        });
    });

    describe('Suite Fastify Server & Shared HTMX Layout (Task 3)', () => {
        it('detects HTMX requests and renders full shell vs partial fragment appropriately', () => {
            expect(isHtmxRequest({ headers: { 'hx-request': 'true' } })).to.equal(true);
            expect(isHtmxRequest({ headers: { 'hx-request': 'true', 'hx-boosted': 'true' } })).to.equal(false);
            expect(isHtmxRequest({ headers: {} })).to.equal(false);

            let tEn = defaultI18n.createTranslator('en');
            let fullHtml = renderDocument({
                req: { headers: {} },
                t: tEn,
                locale: 'en',
                title: 'Test Page',
                csrfToken: 'csrf_123',
                body: '<main id="test-main">Hello HTMX</main>'
            });
            expect(fullHtml).to.include('<!DOCTYPE html>');
            expect(fullHtml).to.include('meta name="csrf-token" content="csrf_123"');
            expect(fullHtml).to.include('<main id="test-main">Hello HTMX</main>');

            let partialHtml = renderDocument({
                req: { headers: { 'hx-request': 'true' } },
                t: tEn,
                locale: 'en',
                title: 'Test Page',
                csrfToken: 'csrf_123',
                body: '<main id="test-main">Hello HTMX</main>'
            });
            expect(partialHtml).to.equal('<main id="test-main">Hello HTMX</main>');
        });

        it('serves static assets, negotiates language switching, and enforces CSRF on state-changing routes', async () => {
            let app = await createSuiteApp({
                cookieSecret: 'suite-test-secret'
            });

            try {
                let cssRes = await app.inject({
                    method: 'GET',
                    url: '/suite-assets/suite.css'
                });
                expect(cssRes.statusCode).to.equal(200);
                expect(cssRes.headers['content-type']).to.include('text/css');

                let localeRes = await app.inject({
                    method: 'POST',
                    url: '/locale',
                    headers: { 'hx-request': 'true' },
                    payload: { lang: 'vi', redirectTo: '/login' }
                });
                expect(localeRes.statusCode).to.equal(200);
                expect(localeRes.headers['set-cookie']).to.include('wd_locale=vi');
                expect(localeRes.headers['hx-redirect']).to.equal('/login');

                let stdLocaleRes = await app.inject({
                    method: 'POST',
                    url: '/locale',
                    payload: { lang: 'en', redirectTo: '/login' }
                });
                expect(stdLocaleRes.statusCode).to.equal(302);
                expect(stdLocaleRes.headers.location).to.equal('/login');

                let healthRes = await app.inject({
                    method: 'GET',
                    url: '/suite-health'
                });
                expect(healthRes.statusCode).to.equal(200);
                expect(JSON.parse(healthRes.body)).to.include({ success: true });
            } finally {
                await app.close();
            }
        });
    });
});
