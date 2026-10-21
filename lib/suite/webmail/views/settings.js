'use strict';

const { html, rawHtml, formatDate } = require('../../html');
const { defaultI18n } = require('../../i18n');

const SUPPORTED_LOCALES = defaultI18n.getSupportedLocales();

function renderUserSettingsPane({
    account = {},
    autoreply = {},
    filters = [],
    asps = [],
    mailboxes = [],
    totpSetup = null,
    createdAsp = null,
    csrfToken,
    locale = 'en',
    t
}) {
    let forwardingText = Array.isArray(account.targets) ? account.targets.join('\n') : '';

    return html`<section id="webmail-settings-pane">
        <div class="card-header">
            <h2 class="card-title">⚙ ${t('webmail.settingsTitle')}</h2>
        </div>

        <div class="grid-2" style="margin-bottom:1.25rem;">
            <div class="card" style="margin-bottom:0;">
                <h3 class="card-title" style="margin-bottom:0.75rem;">${t('webmail.tabProfile')}</h3>
                <form method="POST"
                      action="/webmail/settings/profile"
                      hx-post="/webmail/settings/profile"
                      hx-target="#webmail-reader-pane"
                      hx-swap="innerHTML">
                    <input type="hidden" name="_csrf" value="${csrfToken}">
                    <div class="form-group">
                        <label class="form-label" for="prof-name">${t('webmail.displayName')}</label>
                        <input id="prof-name" name="name" class="form-input" value="${account.name || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="prof-lang">${t('webmail.interfaceLanguage')}</label>
                        <select id="prof-lang" name="language" class="form-select">
                            ${SUPPORTED_LOCALES.map(
                                code => html`<option value="${code}" ${(account.language || locale) === code ? rawHtml('selected') : ''}>
                                    ${code === 'vi' ? 'Tiếng Việt (vi)' : 'English (en)'}
                                </option>`
                            )}
                        </select>
                    </div>
                    <button type="submit" class="btn btn-primary btn-sm">${t('common.save')}</button>
                </form>
            </div>

            <div class="card" style="margin-bottom:0;">
                <h3 class="card-title" style="margin-bottom:0.75rem;">${t('webmail.tabForwarding')}</h3>
                <form method="POST"
                      action="/webmail/settings/forwarding"
                      hx-post="/webmail/settings/forwarding"
                      hx-target="#webmail-reader-pane"
                      hx-swap="innerHTML">
                    <input type="hidden" name="_csrf" value="${csrfToken}">
                    <div class="form-group">
                        <label class="form-label" for="fwd-targets">${t('webmail.forwardingAddresses')}</label>
                        <textarea id="fwd-targets" name="targets" class="form-textarea" style="min-height:92px;" placeholder="backup@example.com">${forwardingText}</textarea>
                    </div>
                    <button type="submit" class="btn btn-primary btn-sm">${t('common.save')}</button>
                </form>
            </div>
        </div>

        <div class="card">
            <h3 class="card-title" style="margin-bottom:0.75rem;">${t('webmail.tabAutoreply')}</h3>
            <form method="POST"
                  action="/webmail/settings/autoreply"
                  hx-post="/webmail/settings/autoreply"
                  hx-target="#webmail-reader-pane"
                  hx-swap="innerHTML">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <div class="form-group">
                    <label style="display:flex;align-items:center;gap:0.5rem;font-size:13px;cursor:pointer;">
                        <input type="checkbox" name="status" value="true" ${autoreply && autoreply.status ? rawHtml('checked') : ''}>
                        <strong>${t('webmail.autoreplyEnabled')}</strong>
                    </label>
                </div>
                <div class="form-group">
                    <label class="form-label" for="ar-subject">${t('webmail.autoreplySubject')}</label>
                    <input id="ar-subject" name="subject" class="form-input" value="${(autoreply && autoreply.subject) || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="ar-text">${t('webmail.autoreplyText')}</label>
                    <textarea id="ar-text" name="text" class="form-textarea" style="min-height:80px;">${(autoreply && autoreply.text) || ''}</textarea>
                </div>
                <button type="submit" class="btn btn-primary btn-sm">${t('common.save')}</button>
            </form>
        </div>

        <div class="card">
            <h3 class="card-title" style="margin-bottom:0.75rem;">${t('webmail.tabFilters')}</h3>
            <form method="POST"
                  action="/webmail/settings/filters"
                  hx-post="/webmail/settings/filters"
                  hx-target="#webmail-reader-pane"
                  hx-swap="innerHTML"
                  class="form-row"
                  style="align-items:flex-end;margin-bottom:1rem;">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <div class="form-group" style="margin-bottom:0;">
                    <label class="form-label">${t('webmail.filterName')}</label>
                    <input name="name" class="form-input" required placeholder="Invoices">
                </div>
                <div class="form-group" style="margin-bottom:0;">
                    <label class="form-label">${t('webmail.filterQuery')}</label>
                    <input name="queryFrom" class="form-input" required placeholder="billing@example.com">
                </div>
                <div class="form-group" style="margin-bottom:0;">
                    <label class="form-label">${t('webmail.filterAction')}</label>
                    <select name="mailbox" class="form-select">
                        ${mailboxes.map(m => html`<option value="${m.id}">${m.name || m.path}</option>`)}
                    </select>
                </div>
                <div>
                    <button type="submit" class="btn btn-primary">${t('webmail.addFilter')}</button>
                </div>
            </form>

            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>${t('webmail.filterName')}</th>
                            <th>${t('webmail.filterQuery')}</th>
                            <th>${t('common.actions')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${
                            filters.length === 0
                                ? html`<tr><td colspan="3" style="color:var(--text-muted);">-</td></tr>`
                                : filters.map(
                                      f => html`<tr>
                                          <td><strong>${f.name || f.id}</strong></td>
                                          <td class="mono">${JSON.stringify(f.query || {})}</td>
                                          <td>
                                              <button type="button"
                                                      class="btn btn-sm btn-danger"
                                                      hx-delete="/webmail/settings/filters/${f.id}?_csrf=${encodeURIComponent(csrfToken)}"
                                                      hx-target="#webmail-reader-pane"
                                                      hx-swap="innerHTML">
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

        <div class="grid-2">
            <div class="card">
                <h3 class="card-title" style="margin-bottom:0.75rem;">${t('webmail.totp2faTitle')}</h3>
                ${
                    totpSetup
                        ? html`<div style="text-align:center;padding:0.5rem 0;">
                              ${totpSetup.qrDataUrl ? html`<img src="${totpSetup.qrDataUrl}" alt="TOTP QR Code" style="width:160px;height:160px;border:1px solid var(--border);border-radius:8px;margin-bottom:0.5rem;">` : ''}
                              <div class="mono" style="margin-bottom:0.75rem;">Seed: <strong>${totpSetup.seed}</strong></div>
                              <form method="POST"
                                    action="/webmail/settings/2fa/totp/enable"
                                    hx-post="/webmail/settings/2fa/totp/enable"
                                    hx-target="#webmail-reader-pane"
                                    hx-swap="innerHTML"
                                    style="display:flex;gap:0.5rem;justify-content:center;">
                                  <input type="hidden" name="_csrf" value="${csrfToken}">
                                  <input name="code" class="form-input mono" style="max-width:140px;" required placeholder="123456">
                                  <button type="submit" class="btn btn-primary btn-sm">${t('webmail.enable2fa')}</button>
                              </form>
                          </div>`
                        : html`<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem;">
                              <form method="POST"
                                    action="/webmail/settings/2fa/totp/setup"
                                    hx-post="/webmail/settings/2fa/totp/setup"
                                    hx-target="#webmail-reader-pane"
                                    hx-swap="innerHTML"
                                    style="margin:0;">
                                  <input type="hidden" name="_csrf" value="${csrfToken}">
                                  <button type="submit" class="btn btn-primary btn-sm">${t('webmail.enable2fa')}</button>
                              </form>
                              <form method="POST"
                                    action="/webmail/settings/2fa/totp/disable"
                                    hx-post="/webmail/settings/2fa/totp/disable"
                                    hx-target="#webmail-reader-pane"
                                    hx-swap="innerHTML"
                                    style="margin:0;">
                                  <input type="hidden" name="_csrf" value="${csrfToken}">
                                  <button type="submit" class="btn btn-danger btn-sm">${t('webmail.disable2fa')}</button>
                              </form>
                          </div>`
                }

                <hr style="border:0;border-top:1px solid var(--border);margin:1rem 0;">
                <h4 style="margin:0 0 0.5rem;font-size:13px;">${t('webmail.changePassword')}</h4>
                <form method="POST"
                      action="/webmail/settings/password"
                      hx-post="/webmail/settings/password"
                      hx-target="#webmail-reader-pane"
                      hx-swap="innerHTML"
                      style="display:flex;gap:0.5rem;">
                    <input type="hidden" name="_csrf" value="${csrfToken}">
                    <input name="password" type="password" class="form-input" required placeholder="${t('webmail.newPassword')}">
                    <button type="submit" class="btn btn-sm btn-primary">${t('common.save')}</button>
                </form>
            </div>

            <div class="card">
                <h3 class="card-title" style="margin-bottom:0.75rem;">${t('webmail.appPasswordsTitle')}</h3>
                ${
                    createdAsp
                        ? html`<div class="card" style="background:var(--success-bg);border-color:var(--success);padding:0.75rem;margin-bottom:0.75rem;">
                              <div style="font-size:12px;color:var(--success);font-weight:600;">Generated App Password:</div>
                              <code class="mono" style="font-size:14px;font-weight:700;">${createdAsp.password}</code>
                          </div>`
                        : ''
                }
                <form method="POST"
                      action="/webmail/settings/asps"
                      hx-post="/webmail/settings/asps"
                      hx-target="#webmail-reader-pane"
                      hx-swap="innerHTML"
                      style="display:flex;gap:0.5rem;margin-bottom:0.75rem;">
                    <input type="hidden" name="_csrf" value="${csrfToken}">
                    <input name="description" class="form-input" required placeholder="${t('webmail.aspDescription')}">
                    <button type="submit" class="btn btn-primary btn-sm">${t('webmail.createAsp')}</button>
                </form>

                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Description</th>
                                <th>Created</th>
                                <th>${t('common.actions')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${
                                asps.length === 0
                                    ? html`<tr><td colspan="3" style="color:var(--text-muted);">-</td></tr>`
                                    : asps.map(
                                          a => html`<tr>
                                              <td>${a.description || a.id}</td>
                                              <td>${formatDate(a.created, locale)}</td>
                                              <td>
                                                  <button type="button"
                                                          class="btn btn-sm btn-danger"
                                                          hx-delete="/webmail/settings/asps/${a.id}?_csrf=${encodeURIComponent(csrfToken)}"
                                                          hx-target="#webmail-reader-pane"
                                                          hx-swap="innerHTML">
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
        </div>
    </section>`;
}

module.exports = {
    renderUserSettingsPane
};
