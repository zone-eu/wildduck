'use strict';

const { html, rawHtml, formatDate } = require('../../html');

function renderSystemView({ upgradeStatus, preflightReport, csrfToken, locale, t }) {
    let snapshots = upgradeStatus.snapshots || [];

    return html`<section id="admin-system-view">
        <div class="card">
            <div class="card-header">
                <div>
                    <h2 class="card-title">${t('admin.systemTitle')}</h2>
                    <span class="form-hint">${t('installer.upgradeDesc')}</span>
                </div>
                <span class="badge badge-pass">v${upgradeStatus.currentVersion}</span>
            </div>

            <form method="POST" action="/locale" hx-post="/locale" style="margin-bottom:1.25rem;">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <input type="hidden" name="redirectTo" value="/admin/system">
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label" for="sys-lang">${t('admin.defaultLanguage')}</label>
                        <select id="sys-lang" name="lang" class="form-select">
                            <option value="en" ${locale === 'en' ? rawHtml('selected') : ''}>English (en)</option>
                            <option value="vi" ${locale === 'vi' ? rawHtml('selected') : ''}>Tiếng Việt (vi)</option>
                        </select>
                    </div>
                    <div class="form-group" style="display:flex;align-items:flex-end;">
                        <button type="submit" class="btn btn-primary">${t('common.save')}</button>
                    </div>
                </div>
            </form>
        </div>

        <div class="card">
            <div class="card-header">
                <div>
                    <h2 class="card-title">${t('admin.upgradeSection')}</h2>
                    <span class="form-hint">Engine: v${upgradeStatus.engineVersion} | Active State: v${upgradeStatus.currentVersion}</span>
                </div>
                <div style="display:flex;gap:0.5rem;">
                    <form method="POST" action="/admin/system/upgrade" hx-post="/admin/system/upgrade" hx-target="#admin-stage" hx-swap="innerHTML" style="margin:0;">
                        <input type="hidden" name="_csrf" value="${csrfToken}">
                        <input type="hidden" name="targetVersion" value="${upgradeStatus.engineVersion}">
                        <button type="submit" class="btn btn-primary">${t('installer.runUpgrade')}</button>
                    </form>
                    ${
                        snapshots.length > 0
                            ? html`<form method="POST" action="/admin/system/rollback" hx-post="/admin/system/rollback" hx-target="#admin-stage" hx-swap="innerHTML" style="margin:0;">
                                  <input type="hidden" name="_csrf" value="${csrfToken}">
                                  <button type="submit" class="btn">${t('common.retry')} / Rollback</button>
                              </form>`
                            : ''
                    }
                </div>
            </div>

            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Snapshot ID</th>
                            <th>Version</th>
                            <th>Domain</th>
                            <th>Created</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${
                            snapshots.length === 0
                                ? html`<tr><td colspan="4" style="color:var(--text-muted);">No snapshots recorded yet</td></tr>`
                                : snapshots.map(
                                      s => html`<tr>
                                          <td><span class="code-inline">${s.id}</span></td>
                                          <td><span class="badge badge-neutral">v${s.version}</span></td>
                                          <td>${(s.config && s.config.mailDomain) || '-'}</td>
                                          <td>${formatDate(s.createdAt, locale)}</td>
                                      </tr>`
                                  )
                        }
                    </tbody>
                </table>
            </div>
        </div>

        ${
            preflightReport
                ? html`<div class="card">
                      <div class="card-header">
                          <h2 class="card-title">${t('installer.preflightTitle')}</h2>
                          <span class="badge ${preflightReport.ready ? 'badge-pass' : 'badge-warn'}">${preflightReport.ready ? 'READY' : 'WARN'}</span>
                      </div>
                      <div class="table-wrap">
                          <table class="data-table">
                              <thead>
                                  <tr>
                                      <th>Check</th>
                                      <th>Value</th>
                                      <th>${t('common.status')}</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  ${(preflightReport.checks || []).map(
                                      c => html`<tr>
                                          <td><strong>${t(c.labelKey)}</strong></td>
                                          <td><span class="code-inline">${c.value}</span></td>
                                          <td><span class="badge badge-${c.status}">${c.status}</span></td>
                                      </tr>`
                                  )}
                              </tbody>
                          </table>
                      </div>
                  </div>`
                : ''
        }
    </section>`;
}

module.exports = {
    renderSystemView
};
