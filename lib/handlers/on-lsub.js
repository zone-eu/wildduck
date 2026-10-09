'use strict';

const db = require('../db');
const consts = require('../consts');

// LSUB "" "*"
// Returns all subscribed folders, query is informational
// folders is either an Array or a Map
module.exports = server => async (query, session, callback) => {
    server.logger.debug(
        {
            tnx: 'lsub',
            cid: session.id
        },
        '[%s] LSUB for "%s"',
        session.id,
        query
    );
    let result;
    try {
        result = await db.database
            .collection('mailboxes')
            .find({
                user: session.user.id,
                subscribed: true,
                hidden: { $ne: true }
            })
            .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
            .toArray();
    } catch (err) {
        return callback(err);
    }
    return callback(null, result);
};
