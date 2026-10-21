'use strict';

const { html, rawHtml, formatDate } = require('../../html');

function renderAuditView({ users = [], selectedUserId = '', authEvents = [], locale, t }) {
    return html`<section id="admin-audit-view">
        <div class="card">
            <div class="card-header">
                <h2 class="card-title">${t('admin.auditTitle')}</h2>
                <form method="GET" action="/admin/audit" hx-get="/admin/audit" hx-target="#admin-stage" hx-swap="innerHTML" style="display:flex;gap:0.5rem;margin:0;">
                    <select name="userId" class="form-select" style="width:240px;">
                        ${users.map(
                            u => html`<option value="${u.id}" ${u.id === selectedUserId ? rawHtml('selected') : ''}>
                                ${u.username} (${u.address || u.id})
                            </option>`
                        )}
                    </select>
                    <button type="submit" class="btn btn-sm btn-primary">${t('common.refresh')}</button>
                </form>
            </div>

            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Action</th>
                            <th>Protocol</th>
                            <th>IP Address</th>
                            <th>${t('common.status')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${
                            authEvents.length === 0
                                ? html`<tr><td colspan="5" style="color:var(--text-muted);">No authentication events recorded for this account</td></tr>`
                                : authEvents.map(
                                      ev => html`<tr>
                                          <td>${formatDate(ev.created, locale)}</td>
                                          <td><strong>${ev.action || 'auth'}</strong></td>
                                          <td><span class="badge badge-neutral">${ev.protocol || 'HTTP'}</span></td>
                                          <td><span class="code-inline">${ev.ip || '-'}</span></td>
                                          <td>
                                              <span class="badge ${ev.success !== false ? 'badge-pass' : 'badge-fail'}">
                                                  ${ev.success !== false ? 'SUCCESS' : 'FAILED'}
                                              </span>
                                          </td>
                                      </tr>`
                                  )
                        }
                    </tbody>
                </table>
            </div>
        </div>
    </section>`;
}

module.exports = {
    renderAuditView
};
