'use strict';

const db = require('../db');
const consts = require('../consts');
const tools = require('../tools');

// APPEND mailbox (flags) date message
module.exports = (server, messageHandler, userCache) => (path, flags, date, raw, session, callback) => {
    server.logger.debug(
        {
            tnx: 'append',
            cid: session.id
        },
        '[%s] Appending message to "%s"',
        session.id,
        path
    );

    db.users.collection('users').findOne(
        {
            _id: session.user.id
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_USERS
        },
        (err, userData) => {
            if (err) {
                return callback(err);
            }
            if (!userData) {
                return callback(new Error('User not found'));
            }

            userCache.get(session.user.id, 'quota', { setting: 'const:max:storage' }, (err, quota) => {
                if (err) {
                    return callback(err);
                }

                if (quota && userData.storageUsed > quota) {
                    return callback(false, 'OVERQUOTA');
                }

                userCache.get(session.user.id, 'imapMaxUpload', { setting: 'const:max:imap:upload' }, (err, limit) => {
                    if (err) {
                        return callback(err);
                    }

                    const counterKey = 'iup:' + tools.redisClusterValue(session.user.id, db.redis);

                    messageHandler.counters.ttlcounter(counterKey, 0, limit, false, (err, res) => {
                        if (err) {
                            return callback(err);
                        }
                        if (!res.success) {
                            let err = new Error('Upload was rate limited');
                            err.response = 'NO';
                            err.code = 'UploadRateLimited';
                            err.ttl = res.ttl;
                            err.responseMessage = `Upload was rate limited. Try again in ${tools.roundTime(res.ttl)}.`;
                            return callback(err);
                        }

                        messageHandler.counters.ttlcounter(counterKey, raw.length, limit, false, () => {
                            flags = Array.isArray(flags) ? flags : [].concat(flags || []);

                            messageHandler.encryptMessage(
                                userData.encryptMessages && !flags.includes('\\Draft') ? userData.pubKey : false,
                                raw,
                                (err, encrypted) => {
                                    if (!err && encrypted) {
                                        raw = encrypted;
                                    }
                                    messageHandler.add(
                                        {
                                            user: session.user.id,
                                            path,
                                            meta: {
                                                source: 'IMAP',
                                                from: '',
                                                to: [session.user.address || session.user.username],
                                                origin: session.remoteAddress,
                                                transtype: 'APPEND',
                                                time: new Date()
                                            },
                                            session,
                                            date,
                                            flags,
                                            raw
                                        },
                                        (err, status, data) => {
                                            if (err) {
                                                if (err.imapResponse) {
                                                    return callback(null, err.imapResponse);
                                                }

                                                return callback(err);
                                            }
                                            callback(null, status, data);
                                        }
                                    );
                                }
                            );
                        });
                    });
                });
            });
        }
    );
};
