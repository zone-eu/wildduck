'use strict';

const { html } = require('../../html');

function renderComposerPane({ draft = {}, csrfToken, t }) {
    return html`<section id="webmail-composer">
        <div class="card-header">
            <h2 class="card-title">${t('webmail.composeTitle')}</h2>
        </div>

        <form method="POST"
              action="/webmail/send"
              hx-post="/webmail/send"
              hx-target="#webmail-reader-pane"
              hx-swap="innerHTML">
            <input type="hidden" name="_csrf" value="${csrfToken}">
            <div class="form-group">
                <label class="form-label" for="comp-to">${t('webmail.to')}</label>
                <input id="comp-to" name="to" class="form-input" required placeholder="recipient@example.com" value="${draft.to || ''}">
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" for="comp-cc">${t('webmail.cc')}</label>
                    <input id="comp-cc" name="cc" class="form-input" placeholder="cc@example.com" value="${draft.cc || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="comp-bcc">${t('webmail.bcc')}</label>
                    <input id="comp-bcc" name="bcc" class="form-input" placeholder="bcc@example.com" value="${draft.bcc || ''}">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label" for="comp-subject">${t('webmail.subject')}</label>
                <input id="comp-subject" name="subject" class="form-input" required placeholder="${t('webmail.subject')}..." value="${draft.subject || ''}">
            </div>
            <div class="form-group">
                <label class="form-label" for="comp-body">${t('webmail.messageBody')}</label>
                <textarea id="comp-body" name="text" class="form-textarea" style="min-height:220px;" required>${draft.text || ''}</textarea>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" for="comp-att-name">📎 ${t('webmail.addAttachment')} (Filename)</label>
                    <input id="comp-att-name" name="attachmentFilename" class="form-input" placeholder="report.txt">
                </div>
                <div class="form-group">
                    <label class="form-label" for="comp-att-content">Content / Base64</label>
                    <input id="comp-att-content" name="attachmentContent" class="form-input" placeholder="Attachment text or base64...">
                </div>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:0.5rem;">
                <button type="submit" name="mode" value="draft" class="btn">${t('webmail.saveDraft')}</button>
                <button type="submit" name="mode" value="send" class="btn btn-primary">✉ ${t('webmail.sendNow')}</button>
            </div>
        </form>
    </section>`;
}

module.exports = {
    renderComposerPane
};
