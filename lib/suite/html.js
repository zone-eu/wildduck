'use strict';

const he = require('he');

class RawHtml {
    constructor(value) {
        this.value = value === null || value === undefined ? '' : String(value);
    }

    toString() {
        return this.value;
    }
}

function escapeHtml(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (value instanceof RawHtml) {
        return value.toString();
    }
    return he.escape(String(value));
}

function rawHtml(value) {
    if (value instanceof RawHtml) {
        return value;
    }
    return new RawHtml(value);
}

function renderValue(val) {
    if (val === null || val === undefined || val === false) {
        return '';
    }
    if (Array.isArray(val)) {
        return val.map(item => renderValue(item)).join('');
    }
    if (val instanceof RawHtml) {
        return val.toString();
    }
    return escapeHtml(val);
}

function html(strings, ...values) {
    let output = '';
    for (let i = 0; i < strings.length; i++) {
        output += strings[i];
        if (i < values.length) {
            output += renderValue(values[i]);
        }
    }
    return new RawHtml(output);
}

function formatBytes(bytes) {
    let num = Number(bytes) || 0;
    if (num <= 0) {
        return '0 B';
    }
    let units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let idx = 0;
    while (num >= 1024 && idx < units.length - 1) {
        num /= 1024;
        idx++;
    }
    return idx === 0 ? `${num} B` : `${num.toFixed(1)} ${units[idx]}`;
}

function formatDate(dateInput, locale = 'en') {
    if (!dateInput) {
        return '-';
    }
    let date = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (Number.isNaN(date.getTime())) {
        return '-';
    }
    try {
        return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US', {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }).format(date);
    } catch (err) {
        return date.toISOString().substring(0, 16).replace('T', ' ');
    }
}

module.exports = {
    RawHtml,
    escapeHtml,
    rawHtml,
    html,
    formatBytes,
    formatDate
};
