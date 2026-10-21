/* global document, window, localStorage, navigator */
(function () {
    'use strict';

    function getCsrfToken() {
        var meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') || '' : '';
    }

    document.addEventListener('htmx:configRequest', function (evt) {
        var token = getCsrfToken();
        if (token && evt.detail && evt.detail.headers) {
            evt.detail.headers['X-CSRF-Token'] = token;
        }
    });

    function showToast(message) {
        var region = document.getElementById('toast-region');
        if (!region || !message) {
            return;
        }
        var item = document.createElement('div');
        item.className = 'toast-item';
        item.setAttribute('role', 'status');
        item.textContent = message;
        region.appendChild(item);
        setTimeout(function () {
            if (item.parentNode) {
                item.parentNode.removeChild(item);
            }
        }, 3500);
    }

    document.body.addEventListener('showToast', function (evt) {
        var msg = evt.detail && (evt.detail.value || evt.detail.message || evt.detail);
        if (typeof msg === 'string') {
            showToast(msg);
        }
    });

    document.addEventListener('click', function (evt) {
        var copyBtn = evt.target.closest('[data-copy-text]');
        if (copyBtn && navigator.clipboard) {
            var text = copyBtn.getAttribute('data-copy-text');
            navigator.clipboard.writeText(text).then(function () {
                var copiedLabel = copyBtn.getAttribute('data-copied-label') || 'Copied';
                showToast(copiedLabel);
            });
        }

        var closeBtn = evt.target.closest('[data-close-modal]');
        if (closeBtn) {
            var modalContainer = document.getElementById('modal-container');
            if (modalContainer) {
                modalContainer.innerHTML = '';
            }
        }

        var themeBtn = evt.target.closest('[data-toggle-theme]');
        if (themeBtn) {
            var root = document.documentElement;
            var current = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            root.setAttribute('data-theme', current);
            try {
                localStorage.setItem('wd_theme', current);
            } catch (e) {
                // ignore storage errors
            }
        }
    });

    document.addEventListener('keydown', function (evt) {
        if (evt.key === 'Escape') {
            var modalContainer = document.getElementById('modal-container');
            if (modalContainer && modalContainer.innerHTML.trim() !== '') {
                modalContainer.innerHTML = '';
            }
        }
    });

    try {
        var savedTheme = localStorage.getItem('wd_theme');
        if (savedTheme === 'dark' || savedTheme === 'light') {
            document.documentElement.setAttribute('data-theme', savedTheme);
        }
    } catch (e) {
        // ignore storage errors
    }

    window.WildDuckSuite = {
        showToast: showToast
    };
})();
