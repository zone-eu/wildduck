'use strict';

const db = require('../db');
const consts = require('../consts');

/**
 * Shared implementation of IMAP SUBSCRIBE and UNSUBSCRIBE. A change of the subscription state is
 * journaled like other mailbox setting changes (ImapNotifier.journalMailboxUpdate).
 *
 * @param {Object} server IMAP server
 * @param {Boolean} subscribed The state to set
 */
module.exports = (server, subscribed) => {
    const name = subscribed ? 'subscribe' : 'unsubscribe';

    return (path, session, callback) => {
        server.logger.debug({ tnx: name, cid: session.id }, '[%s] %s "%s"', session.id, name.toUpperCase(), path);

        db.database
            .collection('mailboxes')
            .findOneAndUpdate(
                { user: session.user.id, path },
                { $set: { subscribed } },
                { maxTimeMS: consts.DB_MAX_TIME_MAILBOXES, includeResultMetadata: true }
            )
            .then(async item => {
                const mailboxData = item && item.value;
                if (!mailboxData) {
                    return callback(null, 'NONEXISTENT');
                }

                // the document is the one before the update; missing means subscribed
                if ((mailboxData.subscribed !== false) !== subscribed) {
                    await server.notifier.journalMailboxUpdate(mailboxData, ['subscribed']);
                }

                callback(null, true);
            }, callback);
    };
};
