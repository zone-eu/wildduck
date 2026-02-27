'use strict';

const MIN_LEVEL = 1;
const MAX_LEVEL = 7;

const CRITICAL_RE = /\b(exception|fatal|panic|critical|crash|uncaught)\b/i;
const WARNING_RE = /\b(warn(?:ing)?|fail(?:ed|ure)?|error|down|timeout|toobig|rate\s*limit|ratelimit|deny|denied|invalid|retry|reject(?:ed)?|missing|not\s+found|blocked|refused)\b/i;

const clampLevel = level => Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(level)));

module.exports.resolveLoggelfLevel = message => {
    if (message && typeof message === 'object' && message.level !== undefined) {
        let numericLevel = Number(message.level);
        if (!Number.isNaN(numericLevel) && Number.isFinite(numericLevel)) {
            return clampLevel(numericLevel);
        }
    }

    if (!message || typeof message !== 'object') {
        return 7;
    }

    if (message._exception === 'yes' || message._exception === true) {
        return 2;
    }

    if (message.full_message) {
        return 3;
    }

    let combined = [message.short_message, message._error, message._code, message._response].filter(Boolean).join(' ');

    if (CRITICAL_RE.test(combined)) {
        return 3;
    }

    if (WARNING_RE.test(combined)) {
        return 5;
    }

    return 7;
};
