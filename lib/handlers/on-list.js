'use strict';

const db = require('../db');
const consts = require('../consts');

// LIST "" "*"
// Returns all folders, query is informational
// folders is either an Array or a Map
module.exports = server =>
    (server.onList = async function (query, session, callback) {
        server.logger.debug(
            {
                tnx: 'list',
                cid: session.id
            },
            '[%s] LIST for "%s"',
            session.id,
            query
        );
        let result;
        try {
            result = await db.database
                .collection('mailboxes')
                .find({
                    user: session.user.id,
                    hidden: { $ne: true }
                })
                .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
                .toArray();
        } catch (err) {
            return callback(err);
        }
        return callback(null, result);
    });
