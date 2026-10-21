'use strict';

const config = require('@zone-eu/wild-config');
const { LOCALE_COOKIE_NAME } = require('../session');
const { isHtmxRequest } = require('../views/layout');
const { createInstallerState } = require('./state');
const { runPreflightChecks } = require('./preflight');
const { provisionSuiteStack } = require('./provisioner');
const { verifyDnsRecords } = require('./dns-verifier');
const {
    renderStep1Language,
    renderStep2Preflight,
    renderStep3Provision,
    renderStep4Dns,
    renderStep5Complete,
    renderWizardShell
} = require('./views');

function resolveTokenFromRequest(req) {
    return (
        (req.query && req.query.token) ||
        (req.body && req.body.token) ||
        (req.cookies && req.cookies.wd_setup_token) ||
        ''
    );
}

function checkSetupAccess(req, stateStore, expectedToken) {
    let state = stateStore.load();
    if (req.session && req.session.role === 'admin') {
        return { allowed: true, state };
    }
    if (state.locked) {
        return { allowed: false, state };
    }
    if (!expectedToken) {
        return { allowed: true, state };
    }
    let candidate = resolveTokenFromRequest(req);
    return { allowed: candidate === expectedToken, state };
}

module.exports = async function installerRoutes(app) {
    let suiteOpts = app.suiteOptions || {};
    let stateStore = suiteOpts.installerState || createInstallerState();
    let expectedToken =
        suiteOpts.setupToken !== undefined
            ? suiteOpts.setupToken
            : (config.suite && config.suite.setupToken) || '';

    app.decorate('suiteInstallerState', stateStore);

    app.get('/setup', async (req, reply) => {
        let access = checkSetupAccess(req, stateStore, expectedToken);
        if (!access.allowed) {
            return reply.code(403).renderPage({
                title: req.t('auth.setupWizard'),
                activeSection: 'setup',
                body: `<main class="wizard-container"><div class="card"><span class="badge badge-fail">LOCKED</span> <p>${req.t('installer.lockedMessage')}</p></div></main>`
            });
        }

        let token = resolveTokenFromRequest(req);
        if (token) {
            reply.setCookie('wd_setup_token', token, { maxAge: 7200, httpOnly: true });
        }

        let state = access.state;
        let requestedStep = Number(req.query && req.query.step) || state.resumeStep || 1;
        let stageContent;

        if (requestedStep === 2) {
            let report = await runPreflightChecks(suiteOpts.preflightOptions || {});
            stageContent = renderStep2Preflight({ report, token, t: req.t });
        } else if (requestedStep === 3) {
            stageContent = renderStep3Provision({ state, token, t: req.t });
        } else if (requestedStep === 4) {
            let dnsReport = await verifyDnsRecords(state.config, suiteOpts.dnsResolver);
            stageContent = renderStep4Dns({ dnsReport, token, t: req.t });
        } else if (requestedStep === 5) {
            stageContent = renderStep5Complete({ state, t: req.t });
        } else {
            stageContent = renderStep1Language({ state, token, t: req.t });
        }

        let body = renderWizardShell({
            activeStep: requestedStep,
            state,
            stageContent,
            t: req.t
        });

        return reply.renderPage({
            title: req.t('auth.setupWizard'),
            activeSection: 'setup',
            body
        });
    });

    app.post('/setup/language', { config: { skipCsrf: true } }, async (req, reply) => {
        let access = checkSetupAccess(req, stateStore, expectedToken);
        if (!access.allowed) {
            return reply.code(403).send('Setup locked');
        }

        let chosenLang = (req.body && req.body.lang) || 'en';
        let normalized = app.suiteI18n.resolveRequestLocale({ query: { lang: chosenLang } });
        req.locale = normalized;
        req.t = app.suiteI18n.createTranslator(normalized);

        reply.setCookie(LOCALE_COOKIE_NAME, normalized, { maxAge: 365 * 24 * 3600, httpOnly: false });
        stateStore.updateStep('language', 'completed', { locale: normalized });

        let token = resolveTokenFromRequest(req);
        let report = await runPreflightChecks(suiteOpts.preflightOptions || {});
        let stage = renderStep2Preflight({ report, token, t: req.t });

        if (isHtmxRequest(req)) {
            return reply.type('text/html; charset=utf-8').send(stage.toString());
        }
        return reply.redirect(`/setup?step=2&token=${encodeURIComponent(token)}`);
    });

    app.post('/setup/preflight', { config: { skipCsrf: true } }, async (req, reply) => {
        let access = checkSetupAccess(req, stateStore, expectedToken);
        if (!access.allowed) {
            return reply.code(403).send('Setup locked');
        }

        let token = resolveTokenFromRequest(req);
        let report = await runPreflightChecks(suiteOpts.preflightOptions || {});

        if (req.body && req.body.rescan === 'true') {
            let stage = renderStep2Preflight({ report, token, t: req.t });
            return reply.type('text/html; charset=utf-8').send(stage.toString());
        }

        stateStore.updateStep('preflight', 'completed');
        let state = stateStore.load();
        let stage = renderStep3Provision({ state, token, t: req.t });

        if (isHtmxRequest(req)) {
            return reply.type('text/html; charset=utf-8').send(stage.toString());
        }
        return reply.redirect(`/setup?step=3&token=${encodeURIComponent(token)}`);
    });

    app.post('/setup/provision', { config: { skipCsrf: true } }, async (req, reply) => {
        let access = checkSetupAccess(req, stateStore, expectedToken);
        if (!access.allowed) {
            return reply.code(403).send('Setup locked');
        }

        let token = resolveTokenFromRequest(req);
        let state = access.state;

        try {
            let provisioned = await provisionSuiteStack(
                {
                    mailDomain: req.body && req.body.mailDomain,
                    hostname: req.body && req.body.hostname,
                    publicIp: (req.body && req.body.publicIp) || '127.0.0.1',
                    dkimSelector: (req.body && req.body.dkimSelector) || 'wd2026',
                    adminUsername: (req.body && req.body.adminUsername) || 'admin',
                    adminPassword: req.body && req.body.adminPassword,
                    enableLetsEncrypt: req.body && req.body.enableLetsEncrypt,
                    locale: state.locale || req.locale
                },
                app.suiteApi
            );

            stateStore.updateStep('provision', 'completed', {
                config: {
                    mailDomain: provisioned.mailDomain,
                    hostname: provisioned.hostname,
                    publicIp: provisioned.publicIp,
                    adminUsername: provisioned.adminUsername,
                    dkimSelector: provisioned.dkimSelector,
                    dkimPublicKey: provisioned.dkimPublicKey,
                    enableLetsEncrypt: provisioned.enableLetsEncrypt
                }
            });

            let updatedState = stateStore.load();
            let dnsReport = await verifyDnsRecords(updatedState.config, suiteOpts.dnsResolver);
            reply.toast(req.t('installer.provisioningSuccess'));
            let stage = renderStep4Dns({ dnsReport, token, t: req.t });

            if (isHtmxRequest(req)) {
                return reply.type('text/html; charset=utf-8').send(stage.toString());
            }
            return reply.redirect(`/setup?step=4&token=${encodeURIComponent(token)}`);
        } catch (err) {
            stateStore.updateStep('provision', 'failed', { error: err.message });
            let updatedState = stateStore.load();
            let stage = renderStep3Provision({ state: updatedState, token, errorMsg: err.message, t: req.t });
            return reply.code(400).type('text/html; charset=utf-8').send(stage.toString());
        }
    });

    app.post('/setup/verify-dns', { config: { skipCsrf: true } }, async (req, reply) => {
        let access = checkSetupAccess(req, stateStore, expectedToken);
        if (!access.allowed) {
            return reply.code(403).send('Setup locked');
        }

        let token = resolveTokenFromRequest(req);
        let state = access.state;
        let dnsReport = await verifyDnsRecords(state.config, suiteOpts.dnsResolver);
        stateStore.updateStep('dns', 'completed');

        let stage = renderStep4Dns({ dnsReport, token, t: req.t });
        return reply.type('text/html; charset=utf-8').send(stage.toString());
    });

    app.post('/setup/finalize', { config: { skipCsrf: true } }, async (req, reply) => {
        let access = checkSetupAccess(req, stateStore, expectedToken);
        if (!access.allowed) {
            return reply.code(403).send('Setup locked');
        }

        let lockedState = stateStore.lock();
        let stage = renderStep5Complete({ state: lockedState, t: req.t });

        if (isHtmxRequest(req)) {
            return reply.type('text/html; charset=utf-8').send(stage.toString());
        }
        return reply.redirect('/admin');
    });
};
