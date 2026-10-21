'use strict';

/* global document, window, localStorage, navigator */
(() => {
    function getCsrfToken() {
        let meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') || '' : '';
    }

    document.addEventListener('htmx:configRequest', evt => {
        let token = getCsrfToken();
        if (token && evt.detail && evt.detail.headers) {
            evt.detail.headers['X-CSRF-Token'] = token;
        }
    });

    function showToast(message) {
        let region = document.getElementById('toast-region');
        if (!region || !message) {
            return;
        }
        let item = document.createElement('div');
        item.className = 'toast-item';
        item.setAttribute('role', 'status');
        item.textContent = message;
        region.appendChild(item);
        setTimeout(() => {
            if (item.parentNode) {
                item.parentNode.removeChild(item);
            }
        }, 3500);
    }

    document.body.addEventListener('showToast', evt => {
        let msg = evt.detail && (evt.detail.value || evt.detail.message || evt.detail);
        if (typeof msg === 'string') {
            showToast(msg);
        }
    });

    document.addEventListener('click', evt => {
        let copyBtn = evt.target.closest('[data-copy-text]');
        if (copyBtn && navigator.clipboard) {
            let text = copyBtn.getAttribute('data-copy-text');
            navigator.clipboard.writeText(text).then(() => {
                let copiedLabel = copyBtn.getAttribute('data-copied-label') || 'Copied';
                showToast(copiedLabel);
            });
        }

        let closeBtn = evt.target.closest('[data-close-modal]');
        if (closeBtn) {
            let modalContainer = document.getElementById('modal-container');
            if (modalContainer) {
                modalContainer.innerHTML = '';
            }
        }

        let msgRow = evt.target.closest('.message-row');
        if (msgRow) {
            let allRows = document.querySelectorAll('.message-row.active');
            for (let i = 0; i < allRows.length; i++) {
                allRows[i].classList.remove('active');
            }
            msgRow.classList.add('active');
            msgRow.classList.remove('unseen');
        }

        let themeBtn = evt.target.closest('[data-toggle-theme]');
        if (themeBtn) {
            let root = document.documentElement;
            let current = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            root.setAttribute('data-theme', current);
            try {
                localStorage.setItem('wd_theme', current);
            } catch (e) {
                // ignore storage errors
            }
        }
    });

    document.addEventListener('keydown', evt => {
        if (evt.key === 'Escape') {
            let modalContainer = document.getElementById('modal-container');
            if (modalContainer && modalContainer.innerHTML.trim() !== '') {
                modalContainer.innerHTML = '';
            }
        }
    });

    try {
        let savedTheme = localStorage.getItem('wd_theme');
        if (savedTheme === 'dark' || savedTheme === 'light') {
            document.documentElement.setAttribute('data-theme', savedTheme);
        }
    } catch (e) {
        // ignore storage errors
    }

    window.WildDuckSuite = {
        showToast
    };
})();
