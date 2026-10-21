/* eslint no-invalid-this: 0, no-unused-expressions: 0 */

'use strict';

const chai = require('chai');
const { escapeHtml, rawHtml, html, formatBytes } = require('../../lib/suite/html');
const { createI18n, defaultI18n } = require('../../lib/suite/i18n');

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
});
