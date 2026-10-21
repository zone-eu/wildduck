'use strict';

const fs = require('fs');
const Path = require('path');
const config = require('@zone-eu/wild-config');
const folderTranslations = require('../translations.js');

const LOCALES_DIR = Path.join(__dirname, 'locales');

function loadDefaultCatalogs() {
    let catalogs = {};
    let files = fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'));
    for (let file of files) {
        let code = Path.basename(file, '.json').toLowerCase();
        let raw = fs.readFileSync(Path.join(LOCALES_DIR, file), 'utf8');
        catalogs[code] = JSON.parse(raw);
    }
    return catalogs;
}

function interpolate(template, params) {
    if (!params || typeof template !== 'string') {
        return template;
    }
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
        if (Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined && params[key] !== null) {
            return String(params[key]);
        }
        return '';
    });
}

function createI18n(customCatalogs) {
    let catalogs = customCatalogs || loadDefaultCatalogs();
    let supported = new Set(Object.keys(catalogs));

    function normalizeLocale(code) {
        if (!code || typeof code !== 'string') {
            return null;
        }
        let cleaned = code.trim().toLowerCase().split(/[-_]/)[0];
        return supported.has(cleaned) ? cleaned : null;
    }

    function getSupportedLocales() {
        return Array.from(supported);
    }

    function getCatalog(locale) {
        let normalized = normalizeLocale(locale) || 'en';
        return catalogs[normalized] || catalogs.en || {};
    }

    function t(locale, key, params) {
        let normalized = normalizeLocale(locale) || 'en';
        let primary = catalogs[normalized] || {};
        let fallback = catalogs.en || {};
        let template = Object.prototype.hasOwnProperty.call(primary, key)
            ? primary[key]
            : Object.prototype.hasOwnProperty.call(fallback, key)
              ? fallback[key]
              : key;
        return interpolate(template, params);
    }

    function createTranslator(locale) {
        let normalized = normalizeLocale(locale) || 'en';
        let fn = (key, params) => t(normalized, key, params);
        fn.locale = normalized;
        return fn;
    }

    function resolveRequestLocale(req) {
        if (req && req.query && req.query.lang) {
            let fromQuery = normalizeLocale(req.query.lang);
            if (fromQuery) {
                return fromQuery;
            }
        }
        if (req && req.cookies && req.cookies.wd_locale) {
            let fromCookie = normalizeLocale(req.cookies.wd_locale);
            if (fromCookie) {
                return fromCookie;
            }
        }
        let acceptHeader = req && req.headers && req.headers['accept-language'];
        if (typeof acceptHeader === 'string' && acceptHeader.trim()) {
            let parts = acceptHeader.split(',');
            for (let part of parts) {
                let tag = part.split(';')[0].trim();
                let matched = normalizeLocale(tag);
                if (matched) {
                    return matched;
                }
            }
        }
        let configured = config.suite && config.suite.defaultLocale;
        return normalizeLocale(configured) || 'en';
    }

    function getMailboxLanguages() {
        return Object.keys(folderTranslations.translations || { en: {} });
    }

    return {
        getSupportedLocales,
        getCatalog,
        t,
        createTranslator,
        resolveRequestLocale,
        getMailboxLanguages
    };
}

const defaultI18n = createI18n();

module.exports = {
    createI18n,
    defaultI18n
};
