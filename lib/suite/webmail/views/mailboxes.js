'use strict';

const { html, formatBytes } = require('../../html');

function resolveMailboxDisplayName(mailbox, t) {
    if (mailbox.path === 'INBOX') {
        return t('webmail.inbox');
    }
    if (mailbox.specialUse === '\\Sent') {
        return t('webmail.sent');
    }
    if (mailbox.specialUse === '\\Drafts') {
        return t('webmail.drafts');
    }
    if (mailbox.specialUse === '\\Junk') {
        return t('webmail.junk');
    }
    if (mailbox.specialUse === '\\Trash') {
        return t('webmail.trash');
    }
    return mailbox.name || mailbox.path;
}

function renderMailboxesSidebar({ mailboxes = [], activeMailboxId = '', account = {}, csrfToken, t }) {
    let specialOrder = ['INBOX', '\\Sent', '\\Drafts', '\\Junk', '\\Trash'];
    let standard = [];
    let custom = [];

    for (let mb of mailboxes) {
        if (mb.path === 'INBOX' || (mb.specialUse && specialOrder.includes(mb.specialUse))) {
            standard.push(mb);
        } else {
            custom.push(mb);
        }
    }

    let quotaUsed = (account.limits && account.limits.quota && account.limits.quota.used) || 0;
    let quotaAllowed = (account.limits && account.limits.quota && account.limits.quota.allowed) || 0;
    let quotaPercent = quotaAllowed > 0 ? Math.min(100, Math.round((quotaUsed / quotaAllowed) * 100)) : 0;

    return html`<div id="webmail-folders-content" style="display:flex;flex-direction:column;height:100%;justify-content:space-between;">
        <div>
            <button type="button"
                    class="btn btn-primary"
                    style="width:100%;margin-bottom:0.875rem;padding:0.55rem;"
                    hx-get="/webmail/compose"
                    hx-target="#webmail-reader-pane"
                    hx-swap="innerHTML">
                ✎ ${t('webmail.compose')}
            </button>

            <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:var(--text-muted);margin-bottom:0.375rem;">
                ${t('webmail.folders')}
            </div>
            <ul class="admin-nav-list" style="margin-bottom:1rem;">
                ${standard.map(
                    mb => html`<li>
                        <a href="/webmail?mailbox=${mb.id}"
                           hx-get="/webmail/mailboxes/${mb.id}/messages"
                           hx-target="#webmail-list-pane"
                           hx-swap="innerHTML"
                           class="admin-nav-link ${mb.id === activeMailboxId ? 'active' : ''}">
                            <span>${resolveMailboxDisplayName(mb, t)}</span>
                            ${mb.unseen ? html`<span class="badge badge-pass">${mb.unseen}</span>` : ''}
                        </a>
                        ${
                            mb.specialUse === '\\Trash' || mb.specialUse === '\\Junk'
                                ? html`<form method="POST"
                                            action="/webmail/mailboxes/${mb.id}/empty"
                                            hx-post="/webmail/mailboxes/${mb.id}/empty"
                                            hx-target="#webmail-list-pane"
                                            hx-swap="innerHTML"
                                            style="margin:0.125rem 0 0.25rem 0.5rem;">
                                      <input type="hidden" name="_csrf" value="${csrfToken}">
                                      <button type="submit" class="btn btn-sm" style="font-size:11px;padding:0.125rem 0.4rem;">
                                          ${mb.specialUse === '\\Trash' ? t('webmail.emptyTrash') : t('webmail.emptyJunk')}
                                      </button>
                                  </form>`
                                : ''
                        }
                    </li>`
                )}
            </ul>

            <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:var(--text-muted);margin-bottom:0.375rem;">
                ${t('webmail.customFolders')}
            </div>
            <ul class="admin-nav-list" style="margin-bottom:0.75rem;">
                ${custom.map(
                    mb => html`<li id="folder-item-${mb.id}" style="display:flex;align-items:center;gap:0.25rem;">
                        <a href="/webmail?mailbox=${mb.id}"
                           hx-get="/webmail/mailboxes/${mb.id}/messages"
                           hx-target="#webmail-list-pane"
                           hx-swap="innerHTML"
                           style="flex:1;"
                           class="admin-nav-link ${mb.id === activeMailboxId ? 'active' : ''}">
                            <span>${mb.name || mb.path}</span>
                            ${mb.unseen ? html`<span class="badge badge-neutral">${mb.unseen}</span>` : ''}
                        </a>
                        <button type="button"
                                class="btn btn-sm"
                                title="${t('common.delete')}"
                                hx-delete="/webmail/mailboxes/${mb.id}?_csrf=${encodeURIComponent(csrfToken)}"
                                hx-target="#folder-item-${mb.id}"
                                hx-swap="outerHTML">×</button>
                    </li>`
                )}
            </ul>

            <form method="POST"
                  action="/webmail/mailboxes"
                  hx-post="/webmail/mailboxes"
                  hx-target="#webmail-folders-pane"
                  hx-swap="innerHTML"
                  style="display:flex;gap:0.25rem;margin-bottom:1rem;">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <input name="path" class="form-input" style="padding:0.3rem 0.5rem;font-size:12px;" required placeholder="${t('webmail.folderName')}...">
                <button type="submit" class="btn btn-sm">+</button>
            </form>
        </div>

        <div style="border-top:1px solid var(--border-default);padding-top:0.75rem;">
            <button type="button"
                    class="btn btn-sm"
                    style="width:100%;margin-bottom:0.625rem;"
                    hx-get="/webmail/settings"
                    hx-target="#webmail-reader-pane"
                    hx-swap="innerHTML">
                ⚙ ${t('webmail.settingsTitle')}
            </button>
            <div style="font-size:11px;color:var(--text-muted);display:flex;justify-content:space-between;">
                <span>${t('webmail.quotaUsed')}</span>
                <span>${formatBytes(quotaUsed)} / ${quotaAllowed ? formatBytes(quotaAllowed) : '∞'} (${quotaPercent}%)</span>
            </div>
            <div style="height:6px;background:var(--bg-subtle);border-radius:3px;overflow:hidden;margin-top:0.25rem;">
                <div style="height:100%;width:${quotaPercent}%;background:var(--brand-primary);"></div>
            </div>
        </div>
    </div>`;
}

module.exports = {
    resolveMailboxDisplayName,
    renderMailboxesSidebar
};
