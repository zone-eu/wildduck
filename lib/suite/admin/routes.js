'use strict';

const packageData = require('../../../package.json');
const { isHtmxRequest } = require('../views/layout');
const { createInstallerState } = require('../installer/state');
const { runPreflightChecks } = require('../installer/preflight');
const { getUpgradeStatus, runSafeUpgrade } = require('../installer/upgrader');
const { renderAdminShell, renderHealthCards, renderDashboardView } = require('./views/dashboard');
const { renderSystemView } = require('./views/system');
const { renderUsersView, renderEditUserModal } = require('./views/users');
const { renderDomainsView } = require('./views/domains');
const { renderCertsView } = require('./views/certs');
const { renderAuditView } = require('./views/audit');

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

async function loadUsersStage(apiClient, stateStore, req) {
    let query = (req.query && req.query.query) || '';
    let users = [];
    try {
        let res = await apiClient.get('/users', { query: { query, limit: 100 } });
        users = res.results || [];
    } catch (err) {
        users = [];
    }
    let defaultDomain = (stateStore && stateStore.load().config && stateStore.load().config.mailDomain) || 'example.com';
    return renderUsersView({
        users,
        defaultDomain,
        query,
        csrfToken: req.session.csrfToken,
        locale: req.locale,
        t: req.t
    });
}

async function loadDomainsStage(apiClient, req) {
    let dkimList = [];
    let domainAliases = [];
    try {
        let dkimRes = await apiClient.get('/dkim', { query: { limit: 100 } });
        dkimList = dkimRes.results || [];
    } catch (err) {
        dkimList = [];
    }
    try {
        let daRes = await apiClient.get('/domainaliases', { query: { limit: 100 } });
        domainAliases = daRes.results || [];
    } catch (err) {
        domainAliases = [];
    }
    return renderDomainsView({
        dkimList,
        domainAliases,
        csrfToken: req.session.csrfToken,
        t: req.t
    });
}

async function loadCertsStage(apiClient, req) {
    let certs = [];
    try {
        let cRes = await apiClient.get('/certs', { query: { limit: 100 } });
        certs = cRes.results || [];
    } catch (err) {
        certs = [];
    }
    return renderCertsView({
        certs,
        csrfToken: req.session.csrfToken,
        locale: req.locale,
        t: req.t
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

    // Users & Quotas CRUD
    app.get('/admin/users', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let stage = await loadUsersStage(app.suiteApi, stateStore, req);
        return sendAdminView(req, reply, 'users', stage);
    });

    app.post('/admin/users', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let body = req.body || {};
        let quotaBytes = (Number(body.quotaMb) || 1024) * 1024 * 1024;
        await app.suiteApi.post('/users', {
            body: {
                username: String(body.username || '').trim(),
                name: String(body.name || '').trim(),
                password: String(body.password || ''),
                address: String(body.address || '').trim(),
                quota: quotaBytes,
                language: String(body.language || req.locale || 'en').trim()
            }
        });
        reply.toast(req.t('common.success'));
        let stage = await loadUsersStage(app.suiteApi, stateStore, req);
        return sendAdminView(req, reply, 'users', stage);
    });

    app.get('/admin/users/:userId/edit', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let userId = req.params.userId;
        let [user, addrRes] = await Promise.all([
            app.suiteApi.get(`/users/${userId}`),
            app.suiteApi.get(`/users/${userId}/addresses`)
        ]);
        let modal = renderEditUserModal({
            user,
            addresses: (addrRes && addrRes.results) || [],
            csrfToken: req.session.csrfToken,
            t: req.t
        });
        return reply.type('text/html; charset=utf-8').send(modal.toString());
    });

    app.post('/admin/users/:userId/update', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let userId = req.params.userId;
        let body = req.body || {};
        let updatePayload = {
            name: String(body.name || '').trim(),
            quota: (Number(body.quotaMb) || 1024) * 1024 * 1024,
            recipients: Number(body.recipients) || 200,
            forwards: Number(body.forwards) || 50
        };
        if (body.password && String(body.password).trim()) {
            updatePayload.password = String(body.password);
        }
        await app.suiteApi.put(`/users/${userId}`, { body: updatePayload });
        reply.toast(req.t('common.success'));
        let stage = await loadUsersStage(app.suiteApi, stateStore, req);
        return sendAdminView(req, reply, 'users', stage);
    });

    app.post('/admin/users/:userId/addresses', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let userId = req.params.userId;
        await app.suiteApi.post(`/users/${userId}/addresses`, {
            body: { address: String(req.body && req.body.address).trim() }
        });
        let [user, addrRes] = await Promise.all([
            app.suiteApi.get(`/users/${userId}`),
            app.suiteApi.get(`/users/${userId}/addresses`)
        ]);
        reply.toast(req.t('common.success'));
        let modal = renderEditUserModal({
            user,
            addresses: (addrRes && addrRes.results) || [],
            csrfToken: req.session.csrfToken,
            t: req.t
        });
        return reply.type('text/html; charset=utf-8').send(modal.toString());
    });

    app.delete('/admin/users/:userId', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        await app.suiteApi.del(`/users/${req.params.userId}`);
        reply.toast(req.t('common.success'));
        return reply.type('text/html; charset=utf-8').send('');
    });

    // Domains, DKIM & Domain Aliases
    app.get('/admin/domains', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let stage = await loadDomainsStage(app.suiteApi, req);
        return sendAdminView(req, reply, 'domains', stage);
    });

    app.post('/admin/domains/dkim', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        await app.suiteApi.post('/dkim', {
            body: {
                domain: String((req.body && req.body.domain) || '').trim(),
                selector: String((req.body && req.body.selector) || 'wd2026').trim()
            }
        });
        reply.toast(req.t('common.success'));
        let stage = await loadDomainsStage(app.suiteApi, req);
        return sendAdminView(req, reply, 'domains', stage);
    });

    app.delete('/admin/domains/dkim/:dkimId', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        await app.suiteApi.del(`/dkim/${req.params.dkimId}`);
        reply.toast(req.t('common.success'));
        return reply.type('text/html; charset=utf-8').send('');
    });

    app.post('/admin/domains/aliases', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        await app.suiteApi.post('/domainaliases', {
            body: {
                alias: String((req.body && req.body.alias) || '').trim(),
                domain: String((req.body && req.body.domain) || '').trim()
            }
        });
        reply.toast(req.t('common.success'));
        let stage = await loadDomainsStage(app.suiteApi, req);
        return sendAdminView(req, reply, 'domains', stage);
    });

    // TLS Certificates & ACME
    app.get('/admin/certs', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let stage = await loadCertsStage(app.suiteApi, req);
        return sendAdminView(req, reply, 'certs', stage);
    });

    app.post('/admin/certs/acme', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        await app.suiteApi.post('/acme/certificate', {
            body: { servername: String((req.body && req.body.domain) || '').trim() }
        });
        reply.toast(req.t('common.success'));
        let stage = await loadCertsStage(app.suiteApi, req);
        return sendAdminView(req, reply, 'certs', stage);
    });

    app.delete('/admin/certs/:certId', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        await app.suiteApi.del(`/certs/${req.params.certId}`);
        reply.toast(req.t('common.success'));
        return reply.type('text/html; charset=utf-8').send('');
    });

    // Audit & Authentication Logs
    app.get('/admin/audit', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let users = [];
        try {
            let uRes = await app.suiteApi.get('/users', { query: { limit: 100 } });
            users = uRes.results || [];
        } catch (err) {
            users = [];
        }

        let selectedUserId = (req.query && req.query.userId) || (users[0] && users[0].id) || '';
        let authEvents = [];
        if (selectedUserId) {
            try {
                let logRes = await app.suiteApi.get(`/users/${selectedUserId}/authlog`);
                authEvents = logRes.results || [];
            } catch (err) {
                authEvents = [];
            }
        }

        let stage = renderAuditView({
            users,
            selectedUserId,
            authEvents,
            locale: req.locale,
            t: req.t
        });
        return sendAdminView(req, reply, 'audit', stage);
    });

    // System & Safe Upgrades
    app.get('/admin/system', async (req, reply) => {
        if (!ensureAdmin(req, reply)) {
            return;
        }
        let upgradeStatus = getUpgradeStatus(stateStore);
        let preflightReport = await runPreflightChecks(suiteOpts.preflightOptions || {});
        let stage = renderSystemView({
            upgradeStatus,
            preflightReport,
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
            csrfToken: req.session.csrfToken,
            locale: req.locale,
            t: req.t
        });
        return sendAdminView(req, reply, 'system', stage);
    });
};
