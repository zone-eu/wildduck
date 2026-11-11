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

/**
 * Checks a message with `count` recipients against the per message limit (const:max:rcpt_to) and the
 * account's daily limit, before it is queued.
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
        log.info('API', 'RCPTDENY denied sent=%s allowed=%s expires=%ss.', sent, maxRecipients, ttl);
        const ttlHuman = formatTtl(ttl);
        throw apiError('You reached a daily sending limit for your account' + (ttlHuman ? '. Limit expires in ' + ttlHuman : ''), 'RateLimitedError', 403, {
            maxRecipients
        });
    }
    return { maxRecipients, sent };
}

/**
 * Queues a message and counts its recipients on the daily limit. A message that can not be counted is
 * taken out of the queue again and the error thrown: nothing leaves uncounted.
 *
 * @param {Object} deps {maildropper, counters}
 * @param {Object} options Maildropper#push options (user, userEmail, from, to, sendTime, ...); id is chosen here
 * @param {stream.Readable|Buffer} source the message
 * @param {Number} maxRecipients the daily limit, from checkRecipientLimits()
 * @param {Function} [onQueued] async (queueId), runs before the recipients are counted; when it fails,
 *   the message is taken out of the queue again and nothing is counted
 * @returns {Promise<String>} the queue id
 */
async function queueMessage(deps, options, source, maxRecipients, onQueued) {
    const { maildropper } = deps;
    // the id is chosen here, so a message that fails half way can be removed from the queue store again
    const id = seqIndex.get();
    try {
        await maildropper.pushStream(Object.assign({}, options, { id }), source);
    } catch (err) {
        await maildropper.removeMessageAsync(id).catch(() => false);
        throw err;
    }
    const cancel = async reason => {
        const canceled = await maildropper.cancelQueued(id).catch(() => false);
        log.error('API', 'Queued message taken back user=%s queue=%s canceled=%s error=%s', options.user, id, !!(canceled && canceled.success), reason);
    };
    if (onQueued) {
        try {
            await onQueued(id);
        } catch (err) {
            await cancel(err.message);
            throw err;
        }
    }
    try {
        await deps.counters.asyncTTLCounter(recipientCounterKey(options.user), options.to.length, maxRecipients, false);
    } catch (err) {
        await cancel(`recipients not counted: ${err.message}`);
        throw apiError(err.message, 'InternalDatabaseError', 500);
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
 * @param {Function} [onQueued] see queueMessage()
 * @returns {Promise<String>} the queue id
 * @throws {Error} code MessageNotFound when the message can not be read in full
 */
async function queueStoredMessage(deps, messageData, options, maxRecipients, onQueued) {
    // the message leaves this server, it must not carry a placeholder for an attachment that can not be read
    const rebuilt = deps.messageHandler.indexer.rebuild(messageData.mimeTree, false, { strict: true });
    if (!rebuilt || rebuilt.type !== 'stream' || !rebuilt.value) {
        throw apiError('This message does not exist', 'MessageNotFound', 404);
    }
    return await queueMessage({ maildropper: deps.maildropper, counters: deps.messageHandler.counters }, options, rebuilt.value, maxRecipients, onQueued);
}

module.exports = { LIMIT_SETTINGS, recipientCounterKey, maxRecipientsOf, checkRecipientLimits, queueMessage, queueStoredMessage };
