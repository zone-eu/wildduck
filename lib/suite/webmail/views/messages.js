'use strict';

const { html, rawHtml, escapeHtml, formatBytes, formatDate } = require('../../html');
const { webSafeHtml } = require('../../../mcp-html');

function renderMessageBody(messageData = {}) {
    if (messageData.html && (Array.isArray(messageData.html) ? messageData.html.length : messageData.html)) {
        let safeHtml = webSafeHtml(messageData.html);
        return html`<div class="message-body-html">${rawHtml(safeHtml)}</div>`;
    }
    let plainText = escapeHtml(messageData.text || '').replace(/\r?\n/g, '<br>');
    return html`<div class="message-body-text">${rawHtml(plainText)}</div>`;
}

function renderMessageListPane({ messages = [], activeMailboxId = '', searchQuery = '', filter = 'all', locale = 'en', t }) {
    return html`<div style="display:flex;flex-direction:column;height:100%;">
        <div class="webmail-list-toolbar">
            <form method="GET"
                  action="/webmail/search"
                  hx-get="/webmail/search"
                  hx-target="#webmail-list-pane"
                  hx-swap="innerHTML"
                  style="display:flex;gap:0.375rem;margin:0 0 0.5rem;">
                <input name="query" class="form-input" style="padding:0.375rem 0.625rem;" placeholder="${t('webmail.searchPlaceholder')}" value="${searchQuery}">
                <button type="submit" class="btn btn-sm btn-primary">${t('common.search')}</button>
            </form>
            <div style="display:flex;gap:0.375rem;">
                <a href="/webmail/mailboxes/${activeMailboxId}/messages"
                   hx-get="/webmail/mailboxes/${activeMailboxId}/messages"
                   hx-target="#webmail-list-pane"
                   hx-swap="innerHTML"
                   class="btn btn-sm ${filter === 'all' ? 'btn-primary' : ''}">
                    ${t('webmail.filterAll')}
                </a>
                <a href="/webmail/mailboxes/${activeMailboxId}/messages?unseen=true"
                   hx-get="/webmail/mailboxes/${activeMailboxId}/messages?unseen=true"
                   hx-target="#webmail-list-pane"
                   hx-swap="innerHTML"
                   class="btn btn-sm ${filter === 'unseen' ? 'btn-primary' : ''}">
                    ${t('webmail.filterUnseen')}
                </a>
                <a href="/webmail/mailboxes/${activeMailboxId}/messages?flagged=true"
                   hx-get="/webmail/mailboxes/${activeMailboxId}/messages?flagged=true"
                   hx-target="#webmail-list-pane"
                   hx-swap="innerHTML"
                   class="btn btn-sm ${filter === 'flagged' ? 'btn-primary' : ''}">
                    ★ ${t('webmail.filterFlagged')}
                </a>
            </div>
        </div>

        <div class="webmail-messages-scroll">
            ${
                messages.length === 0
                    ? html`<div style="padding:2.5rem 1rem;text-align:center;color:var(--text-muted);">${t('webmail.noMessages')}</div>`
                    : messages.map(msg => {
                          let mbId = msg.mailbox || activeMailboxId;
                          let sender = (msg.from && (msg.from.name || msg.from.address)) || '-';
                          return html`<a href="/webmail/mailboxes/${mbId}/messages/${msg.id}"
                                         hx-get="/webmail/mailboxes/${mbId}/messages/${msg.id}"
                                         hx-target="#webmail-reader-pane"
                                         hx-swap="innerHTML"
                                         class="message-row ${msg.seen ? '' : 'unseen'}">
                              <div class="message-meta">
                                  <span class="message-sender">${msg.flagged ? '★ ' : ''}${sender}</span>
                                  <span>${msg.attachments ? '📎 ' : ''}${formatDate(msg.date, locale)}</span>
                              </div>
                              <div class="message-subject">${msg.subject || '(No Subject)'}</div>
                              <div class="message-intro">${msg.intro || ''}</div>
                          </a>`;
                      })
            }
        </div>
    </div>`;
}

function formatAddressList(list = []) {
    if (!Array.isArray(list) || !list.length) {
        return '-';
    }
    return list.map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}

function renderMessageReaderPane({ message, activeMailboxId, mailboxes = [], csrfToken, locale = 'en', t }) {
    let mbId = message.mailbox || activeMailboxId;
    let attachments = Array.isArray(message.attachments) ? message.attachments : [];

    return html`<article id="message-reader-${message.id}">
        <div class="card-header" style="flex-wrap:wrap;">
            <div style="display:flex;gap:0.375rem;flex-wrap:wrap;">
                <button type="button"
                        class="btn btn-sm btn-primary"
                        hx-get="/webmail/compose?replyMailbox=${mbId}&replyMessage=${message.id}"
                        hx-target="#webmail-reader-pane"
                        hx-swap="innerHTML">
                    ↩ ${t('webmail.reply')}
                </button>
                <button type="button"
                        class="btn btn-sm"
                        hx-get="/webmail/compose?forwardMailbox=${mbId}&forwardMessage=${message.id}"
                        hx-target="#webmail-reader-pane"
                        hx-swap="innerHTML">
                    ↪ ${t('webmail.forward')}
                </button>
                <form method="POST"
                      action="/webmail/mailboxes/${mbId}/messages/${message.id}/update"
                      hx-post="/webmail/mailboxes/${mbId}/messages/${message.id}/update"
                      hx-target="#webmail-reader-pane"
                      hx-swap="innerHTML"
                      style="display:inline;margin:0;">
                    <input type="hidden" name="_csrf" value="${csrfToken}">
                    <input type="hidden" name="flagged" value="${message.flagged ? 'false' : 'true'}">
                    <button type="submit" class="btn btn-sm">${message.flagged ? '★' : '☆'} ${t('webmail.toggleFlag')}</button>
                </form>
                <form method="POST"
                      action="/webmail/mailboxes/${mbId}/messages/${message.id}/update"
                      hx-post="/webmail/mailboxes/${mbId}/messages/${message.id}/update"
                      hx-target="#webmail-reader-pane"
                      hx-swap="innerHTML"
                      style="display:inline;margin:0;">
                    <input type="hidden" name="_csrf" value="${csrfToken}">
                    <input type="hidden" name="seen" value="false">
                    <button type="submit" class="btn btn-sm">${t('webmail.markUnread')}</button>
                </form>
            </div>

            <div style="display:flex;gap:0.375rem;align-items:center;">
                ${
                    mailboxes.length > 1
                        ? html`<form method="POST"
                                    action="/webmail/mailboxes/${mbId}/messages/${message.id}/update"
                                    hx-post="/webmail/mailboxes/${mbId}/messages/${message.id}/update"
                                    hx-target="#webmail-reader-pane"
                                    hx-swap="innerHTML"
                                    style="display:inline-flex;gap:0.25rem;margin:0;">
                              <input type="hidden" name="_csrf" value="${csrfToken}">
                              <select name="moveTo" class="form-select" style="width:auto;padding:0.2rem 0.4rem;font-size:12px;">
                                  ${mailboxes.map(
                                      m => html`<option value="${m.id}" ${m.id === mbId ? rawHtml('selected') : ''}>${m.name || m.path}</option>`
                                  )}
                              </select>
                              <button type="submit" class="btn btn-sm">${t('webmail.moveTo')}</button>
                          </form>`
                        : ''
                }
                <button type="button"
                        class="btn btn-sm btn-danger"
                        hx-delete="/webmail/mailboxes/${mbId}/messages/${message.id}?_csrf=${encodeURIComponent(csrfToken)}"
                        hx-target="#webmail-reader-pane"
                        hx-swap="innerHTML">
                    ${t('common.delete')}
                </button>
            </div>
        </div>

        <h2 style="margin:0 0 0.75rem;font-size:18px;">${message.subject || '(No Subject)'}</h2>

        <div class="card" style="background:var(--bg-subtle);padding:0.75rem 1rem;margin-bottom:1rem;font-size:13px;">
            <div><strong>${t('webmail.from')}:</strong> ${formatAddressList(message.from ? [message.from] : [])}</div>
            <div><strong>${t('webmail.to')}:</strong> ${formatAddressList(message.to)}</div>
            ${message.cc && message.cc.length ? html`<div><strong>${t('webmail.cc')}:</strong> ${formatAddressList(message.cc)}</div>` : ''}
            <div><strong>${t('webmail.date')}:</strong> ${formatDate(message.date, locale)}</div>
        </div>

        ${
            attachments.length > 0
                ? html`<div class="card" style="padding:0.625rem 0.875rem;margin-bottom:1rem;">
                      <strong style="font-size:12px;display:block;margin-bottom:0.375rem;">📎 ${t('webmail.attachments')} (${attachments.length})</strong>
                      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
                          ${attachments.map(
                              att => html`<a href="/webmail/mailboxes/${mbId}/messages/${message.id}/attachments/${att.id}"
                                             class="btn btn-sm"
                                             target="_blank"
                                             rel="noopener">
                                  ⬇ ${att.filename || att.id} (${formatBytes(att.size)})
                              </a>`
                          )}
                      </div>
                  </div>`
                : ''
        }

        ${renderMessageBody(message)}
    </article>`;
}

module.exports = {
    renderMessageBody,
    renderMessageListPane,
    renderMessageReaderPane
};
