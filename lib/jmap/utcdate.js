'use strict';

// UTCDate (RFC 8620 1.4): an RFC 3339 date-time in UTC, with an uppercase "T" and "Z" and no fraction
// of a second when it is zero.

const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * Parses a UTCDate. A date that does not exist (2018-02-30, 24:00:00) is not one.
 *
 * @param {*} value
 * @returns {Date|null} null when the value is not a UTCDate
 */
function parseUTCDate(value) {
    if (typeof value !== 'string' || !UTC_DATE.test(value)) {
        return null;
    }
    const date = new Date(value);
    // a field that overflows moves the date, so the date and time no longer read back the same
    if (isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) {
        return null;
    }
    return date;
}

/**
 * Formats a date as UTCDate.
 *
 * @param {Date|String|Number|null} date
 * @param {Object} [options]
 * @param {Boolean} [options.seconds] leave out the fraction of a second altogether
 * @returns {String|null}
 */
function formatUTCDate(date, options = {}) {
    if (date === null || date === undefined || date === false) {
        return null;
    }
    const iso = new Date(date).toISOString();
    return options.seconds ? iso.replace(/\.\d{3}Z$/, 'Z') : iso.replace('.000Z', 'Z');
}

module.exports = { parseUTCDate, formatUTCDate };
