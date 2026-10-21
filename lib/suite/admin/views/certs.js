'use strict';

const { html, formatDate } = require('../../html');

function renderCertsView({ certs = [], csrfToken, locale, t }) {
    return html`<section id="admin-certs-view">
        <div class="card">
            <div class="card-header">
                <h2 class="card-title">${t('admin.acmeOrder')}</h2>
            </div>
            <form method="POST" action="/admin/certs/acme" hx-post="/admin/certs/acme" hx-target="#admin-stage" hx-swap="innerHTML">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">${t('installer.serverHostname')}</label>
                        <input name="domain" class="form-input" required placeholder="mail.example.com">
                    </div>
                    <div class="form-group" style="display:flex;align-items:flex-end;">
                        <button type="submit" class="btn btn-primary">⚡ ${t('admin.acmeOrder')}</button>
                    </div>
                </div>
            </form>
        </div>

        <div class="card">
            <div class="card-header">
                <h2 class="card-title">${t('admin.certsTitle')} (${certs.length})</h2>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Servername (SNI)</th>
                            <th>Common Name</th>
                            <th>Expires</th>
                            <th>${t('common.actions')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${
                            certs.length === 0
                                ? html`<tr><td colspan="4" style="color:var(--text-muted);">No custom TLS certificates registered</td></tr>`
                                : certs.map(
                                      c => html`<tr id="cert-row-${c.id}">
                                          <td><strong>${c.servername}</strong></td>
                                          <td><span class="code-inline">${(c.subject && c.subject.commonName) || c.servername}</span></td>
                                          <td>${formatDate(c.expires, locale)}</td>
                                          <td>
                                              <button type="button"
                                                      class="btn btn-sm btn-danger"
                                                      hx-delete="/admin/certs/${c.id}?_csrf=${encodeURIComponent(csrfToken)}"
                                                      hx-target="#cert-row-${c.id}"
                                                      hx-swap="outerHTML">
                                                  ${t('common.delete')}
                                              </button>
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
    renderCertsView
};
