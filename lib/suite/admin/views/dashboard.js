'use strict';

const { html } = require('../../html');

function renderAdminShell({ activeTab, stageContent, t }) {
    let navItems = [
        { id: 'dashboard', href: '/admin', label: t('admin.navDashboard') },
        { id: 'users', href: '/admin/users', label: t('admin.navUsers') },
        { id: 'domains', href: '/admin/domains', label: t('admin.navDomains') },
        { id: 'certs', href: '/admin/certs', label: t('admin.navCerts') },
        { id: 'audit', href: '/admin/audit', label: t('admin.navAudit') },
        { id: 'system', href: '/admin/system', label: t('admin.navSystem') }
    ];

    return html`<div class="admin-shell">
        <aside class="admin-sidebar" aria-label="${t('admin.title')}">
            <div style="padding:0 0.75rem 0.75rem;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--text-muted);">
                ${t('admin.title')}
            </div>
            <ul class="admin-nav-list">
                ${navItems.map(
                    item => html`<li>
                        <a href="${item.href}"
                           hx-get="${item.href}"
                           hx-target="#admin-stage"
                           hx-push-url="true"
                           class="admin-nav-link ${activeTab === item.id ? 'active' : ''}">
                            <span>${item.label}</span>
                        </a>
                    </li>`
                )}
            </ul>
        </aside>
        <main class="admin-main" id="admin-stage">${stageContent}</main>
    </div>`;
}

function renderHealthCards({ health, stats, version, t }) {
    let services = [
        { label: t('admin.serviceApi'), ok: health.api !== false },
        { label: t('admin.serviceImap'), ok: health.imap !== false },
        { label: t('admin.servicePop3'), ok: health.pop3 !== false },
        { label: t('admin.serviceLmtp'), ok: health.lmtp !== false },
        { label: t('admin.serviceMongo'), ok: health.mongodb !== false },
        { label: t('admin.serviceRedis'), ok: health.redis !== false }
    ];

    return html`<div id="admin-health-panel" hx-get="/admin/health-fragment" hx-trigger="every 15s" hx-swap="outerHTML">
        <div class="stat-grid">
            <div class="stat-card">
                <div class="stat-label">${t('admin.activeUsers')}</div>
                <div class="stat-value">${stats.totalUsers || 0}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">${t('admin.totalDomains')}</div>
                <div class="stat-value">${stats.totalDomains || 0}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">${t('admin.versionLabel')}</div>
                <div class="stat-value">v${version || '1.55.1'}</div>
            </div>
        </div>
        <div class="card">
            <div class="card-header">
                <h2 class="card-title">${t('admin.healthTitle')}</h2>
                <button type="button" class="btn btn-sm" hx-get="/admin/health-fragment" hx-target="#admin-health-panel" hx-swap="outerHTML">
                    ${t('common.refresh')}
                </button>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Service</th>
                            <th>${t('common.status')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${services.map(
                            svc => html`<tr>
                                <td><strong>${svc.label}</strong></td>
                                <td>
                                    <span class="badge ${svc.ok ? 'badge-pass' : 'badge-fail'}">
                                        ${svc.ok ? t('admin.statusUp') : t('admin.statusDown')}
                                    </span>
                                </td>
                            </tr>`
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    </div>`;
}

function renderDashboardView({ health, stats, version, t }) {
    return html`<section>
        ${renderHealthCards({ health, stats, version, t })}
    </section>`;
}

module.exports = {
    renderAdminShell,
    renderHealthCards,
    renderDashboardView
};
