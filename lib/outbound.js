'use strict';

// Handing a user's own message to the outbound queue, shared by the REST submit endpoint, the REST
// draft submit and JMAP EmailSubmission: one recipient limit for all of them (per message and daily,
// on the wdr: counter the ZoneMTA plugin counts on too) and one way to queue a message and count it.

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const SeqIndex = require('@zone-eu/seq-index');

const seqIndex = new SeqIndex();

const LIMIT_SETTINGS = ['const:max:recipients', 'const:max:rcpt_to'];

/** The Redis key of the daily recipient counter of a user */
const recipientCounterKey = user => `wdr:${user}`;

/** The daily recipient limit of an account: its own setting, else the configured one, else the system setting */
const maxRecipientsOf = (userData, settings) => Number(userData.recipients) || Number(config.maxRecipients) || Number(settings['const:max:recipients']);

function formatTtl(ttl) {
    if (!ttl || ttl <= 0) {
        return false;
    }
    if (ttl < 60) {
        return ttl + ' seconds';
    }
    if (ttl < 3600) {
        return Math.round(ttl / 60) + ' minutes';
    }
    return Math.round(ttl / 3600) + ' hours';
}

function apiError(message, code, responseCode, extra) {
    const err = new Error(message);
    err.responseCode = responseCode;
    err.code = code;
    return Object.assign(err, extra);
}

function rateLimited(sent, maxRecipients, ttl) {
    log.info('API', 'RCPTDENY denied sent=%s allowed=%s expires=%ss.', sent, maxRecipients, ttl);
    const ttlHuman = formatTtl(ttl);
    return apiError('You reached a daily sending limit for your account' + (ttlHuman ? '. Limit expires in ' + ttlHuman : ''), 'RateLimitedError', 403, {
        maxRecipients
    });
}

/**
 * Checks a message with `count` recipients against the per message limit (const:max:rcpt_to) and the
 * account's daily limit, before anything is prepared for it. Counts nothing: queueMessage() reserves
 * the recipients atomically, this check turns away early what can not fit anyway.
 *
 * @param {Object} deps {settingsHandler, counters}
 * @param {Object} userData {_id, recipients}
 * @param {Number} count recipients of the message
 * @param {Object} [settings] the LIMIT_SETTINGS values, when they were read already
 * @returns {Promise<{maxRecipients: Number, sent: Number}>} the daily limit (pass it to queueMessage) and
 *   the recipients counted so far
 * @throws {Error} code TooMany (maxRcptTo set) or RateLimitedError (maxRecipients set), responseCode 403;
 *   InternalDatabaseError when the counter can not be read
 */
async function checkRecipientLimits(deps, userData, count, settings) {
    settings = settings || (await deps.settingsHandler.getMulti(LIMIT_SETTINGS));
    const maxRcptTo = Number(settings['const:max:rcpt_to']);
    const maxRecipients = maxRecipientsOf(userData, settings);
    if (count > maxRcptTo) {
        throw apiError('Your email has too many recipients', 'TooMany', 403, { maxRcptTo });
    }
    let counter;
    try {
        counter = await deps.counters.asyncTTLCounter(recipientCounterKey(userData._id), 0, maxRecipients, false);
    } catch (err) {
        throw apiError(err.message, 'InternalDatabaseError', 500);
    }
    const { success, value: sent, ttl } = counter;
    if (!success || sent + count > maxRecipients) {
        throw rateLimited(sent, maxRecipients, ttl);
    }
    return { maxRecipients, sent };
}

/**
 * Counts the recipients of a message on the daily limit, only when all of them fit. Atomic, so parallel
 * submissions can not pass the limit together.
 *
 * @returns {Promise<Function>} async () gives the recipients back (a no-op without a limit, nothing was
 *   counted then); a failure is only logged
 * @throws {Error} RateLimitedError as checkRecipientLimits(), InternalDatabaseError when Redis fails
 */
async function reserveRecipients(counters, user, count, maxRecipients) {
    let counter;
    try {
        counter = await counters.asyncTTLReserve(recipientCounterKey(user), count, maxRecipients, false);
    } catch (err) {
        throw apiError(err.message, 'InternalDatabaseError', 500);
    }
    if (!counter.success) {
        throw rateLimited(counter.value, maxRecipients, counter.ttl);
    }
    if (!maxRecipients) {
        return async () => {};
    }
    return () =>
        counters
            .asyncTTLReserve(recipientCounterKey(user), -count, maxRecipients, false)
            .catch(err => log.error('API', 'Recipient reservation not released user=%s count=%s error=%s', user, count, err.message));
}

/** A message stream that is not queued is not read to the end; let go of it */
function discard(source) {
    if (source && typeof source.destroy === 'function' && !source.destroyed) {
        source.destroy();
    }
}

/**
 * Takes back what a failed queueMessage() did before the failure; each step only logs its own failure.
 *
 * @param {Object} done {pushed: the push was started and may have stored part of the message, undo: of
 *   the prepare step, release: of the reservation}
 */
async function rollback(maildropper, user, id, done, reason) {
    if (done.pushed) {
        await maildropper.removeMessageAsync(id).catch(err => log.error('API', 'Queue file not removed queue=%s error=%s', id, err.message));
    }
    if (done.undo) {
        await Promise.resolve()
            .then(done.undo)
            .catch(err => log.error('API', 'Queue preparation not undone user=%s queue=%s error=%s', user, id, err.message));
    }
    await done.release();
    log.info('API', 'Message not queued user=%s queue=%s error=%s', user, id, reason);
}

/**
 * Reserves the recipients of a message on the daily limit and queues it. Everything that can fail runs
 * before or at the queue insert: once the message is in the queue the MTA may deliver it at any
 * moment, so nothing afterwards may turn it into a reported failure. A failure undoes the reservation,
 * the prepare step and whatever the push stored.
 *
 * @param {Object} deps {maildropper, counters}
 * @param {Object} options Maildropper#push options (user, userEmail, from, to, sendTime, ...); id is chosen here
 * @param {stream.Readable|Buffer} source the message
 * @param {Number} maxRecipients the daily limit, from checkRecipientLimits()
 * @param {Function} [prepare] async (queueId) => undo, runs after the reservation and before the queue
 *   insert (to store a record that names the queue id); the undo function it may return runs when the
 *   insert fails
 * @returns {Promise<String>} the queue id
 * @throws {Error} RateLimitedError when the recipients do not fit (any more), else the error of the failed step
 */
async function queueMessage(deps, options, source, maxRecipients, prepare) {
    const { maildropper, counters } = deps;
    // the id is chosen here, so a record can name it before the message is queued
    const id = seqIndex.get();
    let release;
    try {
        release = await reserveRecipients(counters, options.user, options.to.length, maxRecipients);
    } catch (err) {
        discard(source);
        throw err;
    }
    const done = { pushed: false, undo: null, release };
    try {
        done.undo = prepare ? await prepare(id) : null;
        done.pushed = true;
        await maildropper.pushStream(Object.assign({}, options, { id }), source);
    } catch (err) {
        discard(source);
        await rollback(maildropper, options.user, id, done, err.message);
        throw err;
    }
    return id;
}

/**
 * Queues a stored message (a draft, or the Email of a JMAP submission) as it is stored. Its recipients
 * must have passed checkRecipientLimits().
 *
 * @param {Object} deps {messageHandler, maildropper}
 * @param {Object} messageData the stored message, with mimeTree
 * @param {Object} options Maildropper#push options
 * @param {Number} maxRecipients
 * @param {Function} [prepare] see queueMessage()
 * @returns {Promise<String>} the queue id
 * @throws {Error} code MessageNotFound when the message can not be read in full
 */
async function queueStoredMessage(deps, messageData, options, maxRecipients, prepare) {
    // the message leaves this server, it must not carry a placeholder for an attachment that can not be read
    const rebuilt = deps.messageHandler.indexer.rebuild(messageData.mimeTree, false, { strict: true });
    if (!rebuilt || rebuilt.type !== 'stream' || !rebuilt.value) {
        throw apiError('This message does not exist', 'MessageNotFound', 404);
    }
    return await queueMessage({ maildropper: deps.maildropper, counters: deps.messageHandler.counters }, options, rebuilt.value, maxRecipients, prepare);
}

module.exports = { LIMIT_SETTINGS, recipientCounterKey, maxRecipientsOf, checkRecipientLimits, queueMessage, queueStoredMessage };
