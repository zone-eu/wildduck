'use strict';

const { Transform } = require('stream');
const counters = require('./counters');
const { SettingsHandler } = require('./settings-handler');
const { getUserLimit } = require('./user-limits');
const { DB_MAX_TIME_USERS } = require('./consts');

function downloadLimitError(allowed, result) {
    const error = new Error('API attachment download allowance exceeded');
    error.code = 'ApiDownloadLimitExceeded';
    error.responseCode = 429;
    error.details = { allowed, used: result.value, ttl: result.ttl >= 0 ? result.ttl : false };
    return error;
}

class ApiDownload extends Transform {
    constructor(counter, key, allowed) {
        super();
        this.counter = counter;
        this.key = key;
        this.allowed = allowed;
    }

    _transform(chunk, encoding, done) {
        // Spend response-body bytes after MIME/charset decoding. Do not wait for
        // flush: aborted downloads and other workers must see consumed traffic.
        this.counter(this.key, chunk.length, this.allowed).then(
            result => {
                if (!result.success) {
                    return done(downloadLimitError(this.allowed, result));
                }
                done(null, chunk);
            },
            done
        );
    }
}

// The caller resolves ownership and the attachment first. Charge the content
// owner, also when the caller uses an administrator token.
function createApiDownloadLimiter(db, settingsHandler = new SettingsHandler({ db: db.database })) {
    let spendCounter;
    const asyncSpendCounter = (...args) => {
        spendCounter = spendCounter || counters(db.redis).asyncSpendCounter;
        return spendCounter(...args);
    };
    return async (user, expectedSize) => {
        const userData = await db.users.collection('users').findOne(
            { _id: user },
            { projection: { apiMaxDownload: true }, maxTimeMS: DB_MAX_TIME_USERS }
        );
        if (!userData) {
            const error = new Error('This user does not exist');
            error.code = 'UserNotFound';
            error.responseCode = 404;
            throw error;
        }
        const allowed = getUserLimit(userData, 'apiMaxDownload', await settingsHandler.get('const:max:api:download'));
        const key = `adw:${user}`;
        const result = await asyncSpendCounter(key, 0, allowed);
        // Known-length downloads that cannot fit are rejected before headers or
        // storage reads. Unknown decoded lengths remain bounded by the transform.
        if (!result.success || (allowed && Number.isFinite(expectedSize) && expectedSize > allowed - result.value)) {
            throw downloadLimitError(allowed, result);
        }
        return new ApiDownload(asyncSpendCounter, key, allowed);
    };
}

module.exports = { ApiDownload, createApiDownloadLimiter };
