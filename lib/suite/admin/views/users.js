'use strict';

const { html, rawHtml } = require('../../html');

function renderUserRow(user, csrfToken, t) {
    let usedMb = Math.round(((user.limits && user.limits.quota && user.limits.quota.used) || 0) / (1024 * 1024));
    let allowedMb = Math.round(((user.limits && user.limits.quota && user.limits.quota.allowed) || 0) / (1024 * 1024));

    return html`<tr id="user-row-${user.id}">
        <td><strong>${user.username}</strong></td>
        <td>${user.name || '-'}</td>
        <td><span class="code-inline">${user.address || '-'}</span></td>
        <td>${usedMb} / ${allowedMb || '∞'} MB</td>
        <td>
            <div style="display:flex;gap:0.375rem;">
                <button type="button" class="btn btn-sm" hx-get="/admin/users/${user.id}/edit" hx-target="#modal-container" hx-swap="innerHTML">
                    ${t('common.edit')}
                </button>
                <button type="button"
                        class="btn btn-sm btn-danger"
                        hx-delete="/admin/users/${user.id}?_csrf=${encodeURIComponent(csrfToken)}"
                        hx-confirm="${t('admin.confirmDeleteUser')}"
                        hx-target="#user-row-${user.id}"
                        hx-swap="outerHTML">
                    ${t('common.delete')}
                </button>
            </div>
        </td>
    </tr>`;
}

function renderUsersView({ users = [], defaultDomain = 'example.com', query = '', csrfToken, locale, t }) {
    return html`<section id="admin-users-view">
        <div class="card">
            <div class="card-header">
                <h2 class="card-title">${t('admin.createUser')}</h2>
            </div>
            <form method="POST" action="/admin/users" hx-post="/admin/users" hx-target="#admin-stage" hx-swap="innerHTML">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label" for="u-username">${t('admin.username')}</label>
                        <input id="u-username" name="username" class="form-input" required placeholder="alice">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="u-name">${t('admin.fullName')}</label>
                        <input id="u-name" name="name" class="form-input" placeholder="Alice Nguyen">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="u-addr">${t('admin.primaryAddress')}</label>
                        <input id="u-addr" name="address" type="email" class="form-input" required placeholder="alice@${defaultDomain}">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label" for="u-pass">${t('admin.password')}</label>
                        <input id="u-pass" name="password" type="password" class="form-input" required minlength="6">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="u-quota">${t('admin.quotaMb')}</label>
                        <input id="u-quota" name="quotaMb" type="number" class="form-input" value="1024">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="u-lang">${t('admin.userLanguage')}</label>
                        <select id="u-lang" name="language" class="form-select">
                            <option value="en" ${locale === 'en' ? rawHtml('selected') : ''}>English (en)</option>
                            <option value="vi" ${locale === 'vi' ? rawHtml('selected') : ''}>Tiếng Việt (vi)</option>
                        </select>
                    </div>
                </div>
                <div style="display:flex;justify-content:flex-end;">
                    <button type="submit" class="btn btn-primary">+ ${t('admin.createUser')}</button>
                </div>
            </form>
        </div>

        <div class="card">
            <div class="card-header">
                <h2 class="card-title">${t('admin.usersTitle')} (${users.length})</h2>
                <form method="GET" action="/admin/users" hx-get="/admin/users" hx-target="#admin-stage" hx-swap="innerHTML" style="display:flex;gap:0.5rem;margin:0;">
                    <input name="query" class="form-input" style="width:220px;" placeholder="${t('common.search')}..." value="${query}">
                    <button type="submit" class="btn btn-sm">${t('common.search')}</button>
                </form>
            </div>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>${t('admin.username')}</th>
                            <th>${t('admin.fullName')}</th>
                            <th>${t('admin.primaryAddress')}</th>
                            <th>${t('admin.quotaMb')}</th>
                            <th>${t('common.actions')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${
                            users.length === 0
                                ? html`<tr><td colspan="5" style="color:var(--text-muted);">No accounts found</td></tr>`
                                : users.map(u => renderUserRow(u, csrfToken, t))
                        }
                    </tbody>
                </table>
            </div>
        </div>
    </section>`;
}

function renderEditUserModal({ user, addresses = [], csrfToken, t }) {
    let allowedMb = Math.round(((user.limits && user.limits.quota && user.limits.quota.allowed) || 1073741824) / (1024 * 1024));
    let recipientsAllowed = (user.limits && user.limits.recipients && user.limits.recipients.allowed) || 200;
    let forwardsAllowed = (user.limits && user.limits.forwards && user.limits.forwards.allowed) || 50;

    return html`<div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="${t('admin.editUser')}">
        <div class="modal-card">
            <div class="card-header">
                <h2 class="card-title">${t('admin.editUser')}: ${user.username}</h2>
                <button type="button" class="btn btn-sm" data-close-modal="true">${t('common.close')}</button>
            </div>

            <form method="POST"
                  action="/admin/users/${user.id}/update"
                  hx-post="/admin/users/${user.id}/update"
                  hx-target="#admin-stage"
                  hx-swap="innerHTML">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">${t('admin.fullName')}</label>
                        <input name="name" class="form-input" value="${user.name || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">${t('admin.quotaMb')}</label>
                        <input name="quotaMb" type="number" class="form-input" value="${allowedMb}">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">${t('admin.recipientsLimit')}</label>
                        <input name="recipients" type="number" class="form-input" value="${recipientsAllowed}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">${t('admin.forwardsLimit')}</label>
                        <input name="forwards" type="number" class="form-input" value="${forwardsAllowed}">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">${t('webmail.newPassword')} (Optional)</label>
                    <input name="password" type="password" class="form-input" placeholder="Leave blank to keep existing password">
                </div>
                <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-bottom:1.25rem;">
                    <button type="button" class="btn" data-close-modal="true">${t('common.cancel')}</button>
                    <button type="submit" class="btn btn-primary" data-close-modal="true">${t('common.save')}</button>
                </div>
            </form>

            <div class="card-header">
                <h3 class="card-title" style="font-size:14px;">${t('admin.aliasesTitle')}</h3>
            </div>
            <ul style="list-style:none;padding:0;margin:0 0 1rem;">
                ${addresses.map(
                    addr => html`<li style="display:flex;justify-content:space-between;align-items:center;padding:0.375rem 0;border-bottom:1px solid var(--border-default);">
                        <span class="code-inline">${addr.address} ${addr.main ? '(Primary)' : ''}</span>
                    </li>`
                )}
            </ul>
            <form method="POST"
                  action="/admin/users/${user.id}/addresses"
                  hx-post="/admin/users/${user.id}/addresses"
                  hx-target="#modal-container"
                  hx-swap="innerHTML"
                  style="display:flex;gap:0.5rem;">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <input name="address" type="email" class="form-input" required placeholder="alias@example.com">
                <button type="submit" class="btn btn-sm btn-primary">+ ${t('admin.addAlias')}</button>
            </form>
        </div>
    </div>`;
}

module.exports = {
    renderUserRow,
    renderUsersView,
    renderEditUserModal
};
