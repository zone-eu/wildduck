'use strict';

// Internal loopback HTTP client for the WildDuck HTMX Mail Suite.
//
// Follows the same architecture as `lib/mcp-api-client.js`: every Admin Console and Webmail
// operation goes through WildDuck's official REST API so request validation, role permissions,
// quota calculations, Redis cache invalidation, and audit logging never drift from the core.

const config = require('@zone-eu/wild-config');
const { fetch: fetchCmd, Agent } = require('undici');

const DEFAULT_TIMEOUT = 30 * 1000;

function defaultApiUrl() {
    if (config.suite && config.suite.apiUrl) {
        return config.suite.apiUrl.replace(/\/+$/, '');
    }
    let api = config.api || {};
    return `${api.secure ? 'https' : 'http'}://${api.host && api.host !== '0.0.0.0' ? api.host : '127.0.0.1'}:${api.port || 8080}`;
}

function createError(message, code, responseCode) {
    let err = new Error(message);
    err.code = code || 'ApiError';
    err.responseCode = responseCode || 500;
    return err;
}

class SuiteApiClient {
    constructor(options = {}) {
        this.apiUrl = (options.apiUrl || defaultApiUrl()).replace(/\/+$/, '');
        this.timeout = Number(options.timeout || (config.suite && config.suite.apiTimeout) || DEFAULT_TIMEOUT);
        this.adminToken =
            options.adminToken !== undefined
                ? options.adminToken
                : (config.suite && config.suite.adminAccessToken) || (config.api && config.api.accessToken) || '';
        this.fetch = options.fetch || fetchCmd;
        this.dispatcher =
            options.dispatcher ||
            (this.fetch === fetchCmd
                ? new Agent({
                      keepAliveTimeout: 10 * 1000,
                      keepAliveMaxTimeout: 30 * 1000
                  })
                : undefined);
    }

    buildUrl(path, query) {
        let cleanPath = path.startsWith('/') ? path : `/${path}`;
        let url = new URL(`${this.apiUrl}${cleanPath}`);
        if (query && typeof query === 'object') {
            for (let [key, value] of Object.entries(query)) {
                if (value !== undefined && value !== null && value !== '') {
                    url.searchParams.set(key, String(value));
                }
            }
        }
        return url;
    }

    async request(options = {}) {
        let method = (options.method || 'GET').toUpperCase();
        let url = this.buildUrl(options.path || '/', options.query);
        let headers = {
            Accept: 'application/json',
            ...(options.headers || {})
        };

        let token = options.token !== undefined ? options.token : this.adminToken;
        if (token) {
            headers['X-Access-Token'] = token;
        }

        let bodyPayload;
        if (options.body !== undefined && options.body !== null && method !== 'GET' && method !== 'HEAD') {
            if (Buffer.isBuffer(options.body) || typeof options.body === 'string') {
                bodyPayload = options.body;
            } else {
                headers['Content-Type'] = 'application/json';
                bodyPayload = JSON.stringify(options.body);
            }
        }

        let response;
        try {
            response = await this.fetch(url, {
                method,
                headers,
                body: bodyPayload,
                dispatcher: this.dispatcher,
                signal: AbortSignal.timeout(this.timeout)
            });
        } catch (err) {
            throw createError('WildDuck API service is temporarily unavailable', 'ApiUnavailable', 503);
        }

        if (options.rawResponse) {
            return response;
        }

        let data;
        try {
            data = await response.json();
        } catch (err) {
            data = {};
        }

        if (!response.ok || data.error) {
            throw createError(data.error || `API request failed (${response.status})`, data.code || 'ApiRequestFailed', response.status || 500);
        }

        return data;
    }

    get(path, options = {}) {
        return this.request({ ...options, method: 'GET', path });
    }

    post(path, options = {}) {
        return this.request({ ...options, method: 'POST', path });
    }

    put(path, options = {}) {
        return this.request({ ...options, method: 'PUT', path });
    }

    del(path, options = {}) {
        return this.request({ ...options, method: 'DELETE', path });
    }
}

module.exports = SuiteApiClient;
