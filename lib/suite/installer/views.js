'use strict';

const os = require('os');
const { html, rawHtml } = require('../html');

function detectDefaultPublicIp() {
    let interfaces = os.networkInterfaces() || {};
    for (let name of Object.keys(interfaces)) {
        for (let iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal && iface.address) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

function renderBadge(status, t) {
    if (status === 'pass' || status === 'completed') {
        return html`<span class="badge badge-pass">● ${t ? t('common.status') : 'PASS'}</span>`;
    }
    if (status === 'warn') {
        return html`<span class="badge badge-warn">▲ WARN</span>`;
    }
    return html`<span class="badge badge-fail">✕ CHƯA TRỎ / FAIL</span>`;
}

function renderStepper(activeStep, state, token, t) {
    let steps = [
        { num: 1, key: 'language', label: t('installer.stepLanguage') },
        { num: 2, key: 'preflight', label: t('installer.stepPreflight') },
        { num: 3, key: 'provision', label: t('installer.stepProvision') },
        { num: 4, key: 'dns', label: t('installer.stepDns') },
        { num: 5, key: 'finalize', label: t('installer.stepComplete') }
    ];

    return html`<nav class="wizard-stepper" aria-label="Setup Progress">
        ${steps.map(s => {
            let st = state && state.steps && state.steps[s.key] && state.steps[s.key].status;
            let isDone = st === 'completed' || s.num < activeStep;
            let cls = s.num === activeStep ? 'wizard-step active' : isDone ? 'wizard-step done' : 'wizard-step';
            let badgeText = isDone && s.num !== activeStep ? '✓' : String(s.num);
            if (s.num < activeStep && activeStep < 5 && token) {
                return html`<a href="/setup?step=${s.num}&token=${encodeURIComponent(token)}"
                               class="${cls}">
                    <span class="wizard-step-num">${badgeText}</span>
                    <span>${s.label}</span>
                </a>`;
            }
            return html`<div class="${cls}">
                <span class="wizard-step-num">${badgeText}</span>
                <span>${s.label}</span>
            </div>`;
        })}
    </nav>`;
}

function renderStep1Language({ state, token, t }) {
    return html`${renderStepper(1, state, token, t)}
    <div class="card">
        <div class="card-header">
            <div>
                <h2 class="card-title">Bước 1/5 - ${t('installer.stepLanguage')}</h2>
                <span class="form-hint">${t('installer.chooseLanguage')}</span>
            </div>
            <span class="badge badge-neutral">WildDuck v${state.version || '1.55.1'}</span>
        </div>
        <form method="POST" action="/setup/language" hx-post="/setup/language" hx-target="#wizard-stage" hx-swap="innerHTML">
            <input type="hidden" name="token" value="${token}">
            <div class="form-group">
                <label class="form-label" for="setup-lang-select">${t('common.language')}</label>
                <select id="setup-lang-select" name="lang" class="form-select">
                    <option value="vi" ${state.locale === 'vi' ? rawHtml('selected') : ''}>🇻🇳 Tiếng Việt (Vietnamese)</option>
                    <option value="en" ${state.locale === 'en' ? rawHtml('selected') : ''}>🌐 English (International Default)</option>
                </select>
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:1.25rem;">
                <button type="submit" class="btn btn-primary">${t('common.next')} →</button>
            </div>
        </form>
    </div>`;
}

function renderStep2Preflight({ report, state = {}, token, t }) {
    let rows = (report.checks || []).map(
        check => html`<tr>
            <td><strong>${t(check.labelKey)}</strong><span class="form-hint">${check.detail}</span></td>
            <td><span class="code-inline">${check.value}</span></td>
            <td>${renderBadge(check.status)}</td>
        </tr>`
    );

    return html`${renderStepper(2, state, token, t)}
    <div class="card">
        <div class="card-header">
            <div>
                <h2 class="card-title">Bước 2/5 - ${t('installer.preflightTitle')}</h2>
                <span class="form-hint">${t('installer.preflightDesc')}</span>
            </div>
            <form method="POST" action="/setup/preflight" hx-post="/setup/preflight" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                <input type="hidden" name="token" value="${token}">
                <input type="hidden" name="rescan" value="true">
                <button type="submit" class="btn btn-sm">↻ ${t('installer.runPreflight')}</button>
            </form>
        </div>
        <div class="callout callout-info">
            <div>
                <strong>Tự động kiểm tra phần cứng & cổng mạng:</strong> Hệ thống đã tự động quét cấu hình máy chủ của bạn. Nếu các mục đạt <strong>PASS</strong> (hoặc <strong>WARN</strong>), bạn hãy bấm <strong>Tiếp tục</strong> để sang Bước 3 khai báo Tên miền và mật khẩu Admin.
            </div>
        </div>
        <div class="table-wrap">
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Hạng mục kiểm tra</th>
                        <th>Thông số phát hiện trên Server</th>
                        <th>${t('common.status')}</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <div style="margin-top:1.25rem;display:flex;justify-content:space-between;align-items:center;">
            <a href="/setup?step=1&token=${encodeURIComponent(token)}" class="btn">← ${t('common.back')}</a>
            <form method="POST" action="/setup/preflight" hx-post="/setup/preflight" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                <input type="hidden" name="token" value="${token}">
                <button type="submit" class="btn btn-primary">${t('common.next')} (Cấu hình Tên miền) →</button>
            </form>
        </div>
    </div>`;
}

function renderStep3Provision({ state, token, errorMsg, t }) {
    let cfg = state.config || {};
    let defaultIp = cfg.publicIp || detectDefaultPublicIp();
    let errorBanner = errorMsg
        ? html`<div class="callout" style="background:var(--status-fail-bg);border-color:var(--status-fail-border);color:var(--status-fail-fg);">
              <strong>Lỗi cấu hình:</strong> ${errorMsg}
          </div>`
        : '';

    return html`${renderStepper(3, state, token, t)}
    <div class="card">
        <div class="card-header">
            <div>
                <h2 class="card-title">Bước 3/5 - ${t('installer.domainConfigTitle')}</h2>
                <span class="form-hint">${t('installer.domainConfigDesc')}</span>
            </div>
        </div>
        ${errorBanner}
        <form method="POST" action="/setup/provision" hx-post="/setup/provision" hx-target="#wizard-stage" hx-swap="innerHTML">
            <input type="hidden" name="token" value="${token}">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" for="prov-domain">${t('installer.mailDomain')} *</label>
                    <input id="prov-domain"
                           name="mailDomain"
                           class="form-input"
                           required
                           placeholder="congtycuaban.vn"
                           value="${cfg.mailDomain || ''}"
                           oninput="var h=document.getElementById('prov-hostname'); if(h && (!h.dataset.touched)){ h.value = this.value ? 'mail.' + this.value.trim() : ''; }">
                    <span class="form-hint">Tên miền chính dùng cho địa chỉ email (ví dụ: <code>admin@congtycuaban.vn</code>)</span>
                </div>
                <div class="form-group">
                    <label class="form-label" for="prov-hostname">${t('installer.serverHostname')} (FQDN) *</label>
                    <input id="prov-hostname"
                           name="hostname"
                           class="form-input"
                           required
                           placeholder="mail.congtycuaban.vn"
                           value="${cfg.hostname || ''}"
                           oninput="this.dataset.touched='1'">
                    <span class="form-hint">Tên máy chủ bản ghi MX/A (thường là <code>mail.tenmien.vn</code>)</span>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" for="prov-ip">Địa chỉ IP Public của Máy chủ (IPv4) *</label>
                    <input id="prov-ip" name="publicIp" class="form-input mono" required value="${defaultIp}">
                    <span class="form-hint">Đã tự động điền IP máy chủ hiện tại để sinh bản ghi A và SPF</span>
                </div>
                <div class="form-group">
                    <label class="form-label" for="prov-selector">${t('admin.dkimSelector')} *</label>
                    <input id="prov-selector" name="dkimSelector" class="form-input mono" required value="${cfg.dkimSelector || 'wd2026'}">
                    <span class="form-hint">Tiền tố bản ghi chữ ký số DKIM RSA 2048-bit</span>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label" for="prov-admin">${t('installer.adminUsername')} *</label>
                    <input id="prov-admin" name="adminUsername" class="form-input" required value="${cfg.adminUsername || 'admin'}">
                </div>
                <div class="form-group">
                    <label class="form-label" for="prov-pass">${t('installer.adminPassword')} (Tối thiểu 6 ký tự) *</label>
                    <input id="prov-pass" type="password" name="adminPassword" class="form-input" required minlength="6" placeholder="Nhập mật khẩu quản trị...">
                </div>
            </div>
            <div class="form-group">
                <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
                    <input type="checkbox" name="enableLetsEncrypt" value="true" ${cfg.enableLetsEncrypt !== false ? rawHtml('checked') : ''}>
                    <span>${t('installer.enableLetsEncrypt')}</span>
                </label>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:1.25rem;">
                <a href="/setup?step=2&token=${encodeURIComponent(token)}" class="btn">← ${t('common.back')}</a>
                <button type="submit" class="btn btn-primary">${t('installer.provisionNow')} →</button>
            </div>
        </form>
    </div>`;
}

function renderDnsVerificationTable({ dnsReport, t }) {
    let rows = (dnsReport.records || []).map(
        rec => html`<tr>
            <td><span class="badge badge-neutral">${rec.type}</span></td>
            <td><span class="code-inline">${rec.host}</span></td>
            <td>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">
                    <span class="code-inline" style="flex:1;">${rec.expected}</span>
                    <button type="button" class="btn btn-sm" data-copy-text="${rec.expected}" data-copied-label="${t('common.copied')}">📋 ${t('common.copy')}</button>
                </div>
                <span class="form-hint">${rec.description || ''}</span>
            </td>
            <td><span class="code-inline">${(rec.actual && rec.actual.length && rec.actual.join(', ')) || 'Chưa phát hiện bản ghi'}</span></td>
            <td>${renderBadge(rec.status)}</td>
        </tr>`
    );

    return html`<div id="dns-verification-table" class="table-wrap">
        <table class="data-table">
            <thead>
                <tr>
                    <th>${t('installer.recordType')}</th>
                    <th>${t('installer.recordHost')}</th>
                    <th>Giá trị cần trỏ trên nhà cung cấp DNS (Bấm Sao chép)</th>
                    <th>${t('installer.recordActual')}</th>
                    <th>${t('installer.recordStatus')}</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

function renderStep4Dns({ dnsReport, state = {}, token, t }) {
    let records = (dnsReport && dnsReport.records) || [];
    let passedCount = records.filter(r => r.status === 'pass').length;
    let allPassed = records.length > 0 && passedCount === records.length;

    return html`${renderStepper(4, state, token, t)}
    <div class="card">
        <div class="card-header">
            <div>
                <h2 class="card-title">Bước 4/5 - ${t('installer.dnsTitle')}</h2>
                <span class="form-hint">${t('installer.dnsDesc')}</span>
            </div>
            <div style="display:flex;align-items:center;gap:0.5rem;">
                <span class="badge ${allPassed ? 'badge-pass' : 'badge-warn'}">Đã trỏ đúng: ${passedCount}/${records.length} bản ghi</span>
                <form method="POST" action="/setup/verify-dns" hx-post="/setup/verify-dns" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                    <input type="hidden" name="token" value="${token}">
                    <button type="submit" class="btn btn-primary btn-sm">↻ ${t('installer.verifyDnsNow')}</button>
                </form>
            </div>
        </div>

        <div class="callout ${allPassed ? 'callout-info' : 'callout-warn'}">
            <div>
                <strong>Hướng dẫn cấu hình DNS:</strong> Hệ thống đã tự động sinh 6 bản ghi DNS chuẩn (bao gồm khóa chữ ký số DKIM 2048-bit) cho tên miền <strong>${dnsReport.mailDomain || ''}</strong>.
                <br>• Nếu bạn dùng tên miền thật: Hãy bấm <strong>Sao chép</strong> từng dòng bên dưới và thêm vào trang quản trị DNS (Cloudflare, Mắt Bão, Nhân Hòa...), sau đó bấm <strong>Kiểm tra DNS</strong>.
                <br>• Nếu bạn đang cài đặt thử nghiệm (chưa trỏ DNS thật): Bạn vẫn có thể bấm nút <strong>Bỏ qua kiểm tra DNS & Hoàn tất (Chế độ thử nghiệm)</strong> ở góc dưới bên phải để vào sử dụng ngay Webmail và Admin Console.
            </div>
        </div>

        ${renderDnsVerificationTable({ dnsReport, t })}

        <div style="margin-top:1.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;">
            <a href="/setup?step=3&token=${encodeURIComponent(token)}" class="btn">← Quay lại sửa Tên miền / Admin</a>
            <div style="display:flex;gap:0.625rem;align-items:center;">
                <form method="POST" action="/setup/verify-dns" hx-post="/setup/verify-dns" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                    <input type="hidden" name="token" value="${token}">
                    <button type="submit" class="btn">↻ Kiểm tra lại DNS</button>
                </form>
                <form method="POST" action="/setup/finalize" hx-post="/setup/finalize" hx-target="#wizard-stage" hx-swap="innerHTML" style="margin:0;">
                    <input type="hidden" name="token" value="${token}">
                    <button type="submit" class="btn ${allPassed ? 'btn-primary' : ''}">
                        ${allPassed ? `${t('common.finish')} ✓` : 'Bỏ qua kiểm tra DNS & Hoàn tất (Chạy thử nghiệm) →'}
                    </button>
                </form>
            </div>
        </div>
    </div>`;
}

function renderStep5Complete({ state, t }) {
    let cfg = state.config || {};
    return html`${renderStepper(5, state, '', t)}
    <div class="card" style="text-align:center;padding:3rem 1.5rem;">
        <div style="margin-bottom:1rem;">
            <span class="badge badge-pass" style="font-size:13px;padding:0.4rem 1rem;">● HỆ THỐNG ĐÃ SẴN SÀNG</span>
        </div>
        <h2 style="margin-top:0;font-size:22px;">${t('installer.completeTitle')}</h2>
        <p style="color:var(--text-secondary);max-width:580px;margin:0.5rem auto 1.25rem;">
            ${t('installer.completeDesc')}
        </p>
        <div class="card" style="max-width:460px;margin:0 auto 1.5rem;text-align:left;background:var(--bg-subtle);padding:1rem 1.25rem;">
            <div style="font-size:12.5px;margin-bottom:0.35rem;"><strong>Tên miền Mail:</strong> <span class="mono">${cfg.mailDomain || '-'}</span></div>
            <div style="font-size:12.5px;margin-bottom:0.35rem;"><strong>Máy chủ (Hostname):</strong> <span class="mono">${cfg.hostname || '-'}</span></div>
            <div style="font-size:12.5px;"><strong>Tài khoản Quản trị:</strong> <span class="mono">${cfg.adminUsername || 'admin'}@${cfg.mailDomain || ''}</span> (hoặc đăng nhập bằng username: <span class="mono">${cfg.adminUsername || 'admin'}</span>)</div>
        </div>
        <div style="display:flex;justify-content:center;gap:0.75rem;flex-wrap:wrap;">
            <a href="/login?next=/admin" class="btn btn-primary">🛡 ${t('installer.openAdmin')}</a>
            <a href="/login?next=/webmail" class="btn">✉ ${t('installer.openWebmail')}</a>
        </div>
    </div>`;
}

function renderWizardShell({ activeStep, state, stageContent, t }) {
    let resumeBanner = '';
    if (state.resumeStep > 1 && state.steps && Object.values(state.steps).some(s => s.status === 'failed')) {
        resumeBanner = html`<div class="callout callout-warn">
            <strong>${t('installer.resumeNotice', { step: state.resumeStep })}</strong>
        </div>`;
    }

    return html`<main class="wizard-container">
        <div class="wizard-hero">
            <div>
                <h1>${t('installer.welcomeTitle', { version: state.version || '1.55.1' })}</h1>
                <p>${t('installer.welcomeSubtitle')}</p>
            </div>
            <span class="badge badge-pass">Zero-Touch Core v${state.version || '1.55.1'}</span>
        </div>
        ${resumeBanner}
        <section id="wizard-stage" data-active-step="${activeStep}">${stageContent}</section>
    </main>`;
}

module.exports = {
    renderBadge,
    renderStepper,
    renderStep1Language,
    renderStep2Preflight,
    renderStep3Provision,
    renderDnsVerificationTable,
    renderStep4Dns,
    renderStep5Complete,
    renderWizardShell
};
