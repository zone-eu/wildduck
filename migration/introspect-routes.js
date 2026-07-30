'use strict';

// Loads every lib/api route module with stubbed dependencies and collects the
// registered route specs (method, path, validationObjs, ...). Used by the
// golden-response capture harness and the OpenAPI parity diff during the
// Restify to Fastify migration. Temporary tooling, delete after migration.

const Path = require('path');

// A proxy that tolerates any property access, call, or construction. Route
// module factories touch db/handlers at init time (bind methods, create
// TaskHandler instances); none of that should execute real logic here.
function anyProxy() {
    const fn = function () {
        return anyProxy();
    };
    return new Proxy(fn, {
        get(target, prop) {
            if (prop === Symbol.toPrimitive) {
                return () => '';
            }
            if (prop === 'bind' || prop === 'call' || prop === 'apply') {
                return () => anyProxy();
            }
            return anyProxy();
        },
        apply() {
            return anyProxy();
        },
        construct() {
            return anyProxy();
        }
    });
}

// settings.js builds its Joi schemas from settingsHandler.keys, so it gets the
// real SettingsHandler (its keys list is static data, no db access on init).
const settingsExtras = () => {
    const { SettingsHandler } = require(Path.join(__dirname, '..', 'lib', 'settings-handler'));
    return [new SettingsHandler({ db: anyProxy() })];
};

const MODULES = [
    { file: 'acme' },
    { file: 'addresses' },
    { file: 'asps' },
    { file: 'audit' },
    { file: 'auth' },
    { file: 'autoreply' },
    { file: 'certs' },
    { file: 'dkim' },
    { file: 'domainaccess' },
    { file: 'domainaliases' },
    { file: 'filters' },
    { file: 'health' },
    { file: 'mailboxes' },
    { file: 'messages' },
    { file: 'settings', extras: settingsExtras },
    { file: 'storage' },
    { file: 'submit' },
    { file: '2fa/totp' },
    { file: '2fa/custom' },
    { file: '2fa/webauthn' },
    { file: 'updates' },
    { file: 'users' },
    { file: 'webhooks' }
];

function collectRoutes() {
    const routes = [];

    for (const mod of MODULES) {
        const factory = require(Path.join(__dirname, '..', 'lib', 'api', mod.file));
        const collector = {};
        for (const method of ['get', 'post', 'put', 'del', 'patch', 'head']) {
            collector[method] = (spec, ...handlers) => {
                if (typeof spec === 'string') {
                    spec = { path: spec };
                }
                routes.push({
                    module: mod.file,
                    method: method === 'del' ? 'delete' : method,
                    path: spec.path,
                    name: spec.name,
                    summary: spec.summary,
                    tags: spec.tags,
                    responseType: spec.responseType,
                    validationObjs: spec.validationObjs,
                    jsonSchema: !!spec.jsonSchema,
                    allowUnknown: !!spec.allowUnknown,
                    handlerCount: handlers.length
                });
            };
        }
        const extras = mod.extras ? mod.extras() : [anyProxy(), anyProxy(), anyProxy(), anyProxy(), anyProxy(), anyProxy()];
        factory(anyProxy(), collector, ...extras);
    }

    return routes;
}

module.exports = { collectRoutes, MODULES };

if (require.main === module) {
    const routes = collectRoutes();
    for (const r of routes) {
        console.log(`${r.module.padEnd(14)} ${r.method.toUpperCase().padEnd(6)} ${r.path}  ${r.validationObjs ? '' : 'NO-VALIDATION-OBJS'}`);
    }
    console.log(`total: ${routes.length}`);
}
