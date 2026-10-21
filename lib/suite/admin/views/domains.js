'use strict';

const { html } = require('../../html');

function renderDomainsView({ dkimList = [], domainAliases = [], csrfToken, t }) {
    return html`<section id="admin-domains-view">
        <div class="card">
            <div class="card-header">
                <h2 class="card-title">${t('admin.addDomain')}</h2>
            </div>
            <form method="POST" action="/admin/domains/dkim" hx-post="/admin/domains/dkim" hx-target="#admin-stage" hx-swap="innerHTML">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label" for="dk-domain">${t('admin.domainName')}</label>
                        <input id="dk-domain" name="domain" class="form-input" required placeholder="example.com">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="dk-sel">${t('admin.dkimSelector')}</label>
                        <input id="dk-sel" name="selector" class="form-input" required value="wd2026">
                    </div>
                    <div class="form-group" style="display:flex;align-items:flex-end;">
                        <button type="submit" class="btn btn-primary">+ ${t('admin.generateDkim')}</button>
                    </div>
                </div>
            </form>
        </div>

        <div class="card">
            <div class="card-header">
                <h2 class="card-title">${t('admin.domainsTitle')} (${dkimList.length})</h2>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>${t('admin.domainName')}</th>
                            <th>${t('admin.dkimSelector')}</th>
                            <th>DNS TXT Record</th>
                            <th>${t('common.actions')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${
                            dkimList.length === 0
                                ? html`<tr><td colspan="4" style="color:var(--text-muted);">No DKIM domains configured yet</td></tr>`
                                : dkimList.map(
                                      dk => html`<tr id="dkim-row-${dk.id}">
                                          <td><strong>${dk.domain}</strong></td>
                                          <td><span class="badge badge-neutral">${dk.selector}</span></td>
                                          <td>
                                              <div style="display:flex;align-items:center;gap:0.5rem;">
                                                  <span class="code-inline">${(dk.dnsTxt && dk.dnsTxt.name) || `${dk.selector}._domainkey.${dk.domain}`}</span>
                                                  ${
                                                      dk.dnsTxt && dk.dnsTxt.value
                                                          ? html`<button type="button" class="btn btn-sm" data-copy-text="${dk.dnsTxt.value}" data-copied-label="${t('common.copied')}">${t('common.copy')} TXT</button>`
                                                          : ''
                                                  }
                                              </div>
                                          </td>
                                          <td>
                                              <button type="button"
                                                      class="btn btn-sm btn-danger"
                                                      hx-delete="/admin/domains/dkim/${dk.id}?_csrf=${encodeURIComponent(csrfToken)}"
                                                      hx-target="#dkim-row-${dk.id}"
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

        <div class="card">
            <div class="card-header">
                <h2 class="card-title">${t('admin.domainAliasesTitle')}</h2>
            </div>
            <form method="POST" action="/admin/domains/aliases" hx-post="/admin/domains/aliases" hx-target="#admin-stage" hx-swap="innerHTML" style="margin-bottom:1rem;">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Alias Domain (e.g. brand2.com)</label>
                        <input name="alias" class="form-input" required placeholder="brand2.com">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Target Primary Domain (e.g. example.com)</label>
                        <input name="domain" class="form-input" required placeholder="example.com">
                    </div>
                    <div class="form-group" style="display:flex;align-items:flex-end;">
                        <button type="submit" class="btn btn-primary">+ ${t('admin.addDomainAlias')}</button>
                    </div>
                </div>
            </form>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Alias Domain</th>
                            <th>Target Domain</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${
                            domainAliases.length === 0
                                ? html`<tr><td colspan="2" style="color:var(--text-muted);">No domain aliases configured</td></tr>`
                                : domainAliases.map(
                                      da => html`<tr>
                                          <td><span class="code-inline">${da.alias}</span></td>
                                          <td><strong>${da.domain}</strong></td>
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
    renderDomainsView
};
