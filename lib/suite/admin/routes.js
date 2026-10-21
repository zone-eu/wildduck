'use strict';

const packageData = require('../../../package.json');
const { isHtmxRequest } = require('../views/layout');
const { createInstallerState } = require('../installer/state');
const { runPreflightChecks } = require('../installer/preflight');
const { getUpgradeStatus, runSafeUpgrade } = require('../installer/upgrader');
const { renderAdminShell, renderHealthCards, renderDashboardView } = require('./views/dashboard');
const { renderSystemView } = require('./views/system');

function ensureAdmin(req, reply) {
    if (!req.session || !req.session.userId) {
        if (isHtmxRequest(req)) {
            reply.header('HX-Redirect', '/login?next=/admin').send('');
            return false;
        }
        reply.redirect('/login?next=/admin');
        return false;
    }
    if (req.session.role !== 'admin') {
        reply.code(403).type('text/html; charset=utf-8').send('<div class="card"><span class="badge badge-fail">403 Forbidden</span></div>');
        return false;
    }
    return true;
}

async function fetchDashboardTelemetry(apiClient, stateStore) {
    let health = { api: true, imap: true, pop3: true, lmtp: true, mongodb: true, redis: true };
    let totalUsers = 0;
    let totalDomains = 0;

    try {
        let hRes = await apiClient.get('/health');
        health.mongodb = hRes.mongodb !== false;
        health.redis = hRes.redis !== false;
    } catch (err) {
        health.api = false;
    }

    try {
        let uRes = await apiClient.get('/users', { query: { limit: 1 } });
        totalUsers = Number(uRes.total) || (uRes.results && uRes.results.length) || 0;
    } catch (err) {
        // Ignore when API is not reachable
    }

    try {
        let dRes = await apiClient.get('/dkim', { query: { limit: 50 } });
        totalDomains = Number(dRes.total) || (dRes.results && dRes.results.length) || 0;
    } catch (err) {
        // Fallback to configured domain count
    }

    if (!totalDomains && stateStore) {
        let st = stateStore.load();
        if (st.config && st.config.mailDomain) {
            totalDomains = 1;
        }
    }

    return {
        health,
        stats: { totalUsers, totalDomains },
        version: (stateStore && stateStore.load().version) || packageData.version
    };
}

function sendAdminView(req, reply, activeTab, stageContent) {
    if (isHtmxRequest(req)) {
        return reply.type('text/html; charset=utf-8').send(stageContent.toString());
    }
    let body = renderAdminShell({
        activeTab,
        stageContent,
        t: req.t
    });
    return reply.renderPage({
        title: req.t('admin.title'),
        activeSection: 'admin',
        body
    });
}

module.exports = async function adminRoutes(app) {
    let stateStore = app.suiteInstallerState || (app.suiteOptions && app.suiteOptions.installerState) || createInstallerState();
    let suiteOpts = app.suiteOptions || {};

    app.get('/admin', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let telemetry = await fetchDashboardTelemetry(app.suiteApi, stateStore);
        let stage = renderDashboardView({
            ...telemetry,
            t: req.t
        });
        return sendAdminView(req, reply, 'dashboard', stage);
    });

    app.get('/admin/health-fragment', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let telemetry = await fetchDashboardTelemetry(app.suiteApi, stateStore);
        let fragment = renderHealthCards({
            ...telemetry,
            t: req.t
        });
        return reply.type('text/html; charset=utf-8').send(fragment.toString());
    });

    app.get('/admin/system', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let upgradeStatus = getUpgradeStatus(stateStore);
        let preflightReport = await runPreflightChecks(suiteOpts.preflightOptions || {});
        let stage = renderSystemView({
            upgradeStatus,
            preflightReport,
            state: stateStore.load(),
            csrfToken: req.session.csrfToken,
            locale: req.locale,
            t: req.t
        });
        return sendAdminView(req, reply, 'system', stage);
    });

    app.post('/admin/system/upgrade', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let targetVersion = (req.body && req.body.targetVersion) || packageData.version;
        let result = await runSafeUpgrade({
            installerState: stateStore,
            targetVersion
        });

        reply.toast(result.success ? req.t('common.success') : result.error);
        let upgradeStatus = getUpgradeStatus(stateStore);
        let preflightReport = await runPreflightChecks(suiteOpts.preflightOptions || {});
        let stage = renderSystemView({
            upgradeStatus,
            preflightReport,
            state: stateStore.load(),
            csrfToken: req.session.csrfToken,
            locale: req.locale,
            t: req.t
        });
        return sendAdminView(req, reply, 'system', stage);
    });

    app.post('/admin/system/rollback', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        stateStore.restoreLatestSnapshot();
        reply.toast(req.t('installer.rollbackSuccess'));

        let upgradeStatus = getUpgradeStatus(stateStore);
        let preflightReport = await runPreflightChecks(suiteOpts.preflightOptions || {});
        let stage = renderSystemView({
            upgradeStatus,
            preflightReport,
            state: stateStore.load(),
            csrfToken: req.session.csrfToken,
            locale: req.locale,
            t: req.t
        });
        return sendAdminView(req, reply, 'system', stage);
    });
};
