'use strict';

const db = require('../db');
const consts = require('../consts');
const { getUserQuota } = require('./quota');

module.exports = server => (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'quota',
            cid: session.id
        },
        '[%s] Requested quota root info for "%s"',
        session.id,
        path
    );

    const getQuotaRoot = async () => {
        let mailbox = await db.database.collection('mailboxes').findOne(
            {
                user: session.user.id,
                path
            },
            {
                maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
            }
        );

        if (!mailbox) {
            return 'NONEXISTENT';
        }

        return await getUserQuota(server, session.user.id);
    };

    getQuotaRoot().then(result => callback(null, result), callback);
};
