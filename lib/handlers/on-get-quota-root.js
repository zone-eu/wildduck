'use strict';

const db = require('../db');
const consts = require('../consts');

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

    db.database.collection('mailboxes').findOne(
        {
            user: session.user.id,
            path
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        },
        (err, mailbox) => {
            if (err) {
                return callback(err);
            }
            if (!mailbox) {
                return callback(null, 'NONEXISTENT');
            }

            db.users.collection('users').findOne(
                {
                    _id: session.user.id
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                },
                (err, user) => {
                    if (err) {
                        return callback(err);
                    }
                    if (!user) {
                        return callback(new Error('User data not found'));
                    }

                    let getQuota = next => {
                        if (user.quota) {
                            return next(null, user.quota);
                        }

                        if (!server.options.settingsHandler) {
                            return next(null, 0);
                        }

                        server.options.settingsHandler
                            .get('const:max:storage')
                            .then(maxStorage => next(null, maxStorage))
                            .catch(err => next(err));
                    };

                    getQuota((err, maxStorage) => {
                        if (err) {
                            return callback(err);
                        }

                        callback(null, {
                            root: '',
                            quota: user.quota || maxStorage || 0,
                            storageUsed: Math.max(user.storageUsed || 0, 0)
                        });
                    });
                }
            );
        }
    );
};
