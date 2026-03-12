'use strict';

const hasValue = value => (typeof value === 'string' ? value.trim().length > 0 : !!value);

module.exports.normalizeLoggelfMessage = message => {
    if (!message || typeof message !== 'object') {
        return;
    }

    // Critical errors are represented by full_message + _error.
    // For all non-critical errors, move _error to _failure_msg.
    if (hasValue(message._error) && !hasValue(message.full_message)) {
        if (!hasValue(message._failure_msg)) {
            message._failure_msg = message._error;
        }
        delete message._error;
    }

    return;
};
