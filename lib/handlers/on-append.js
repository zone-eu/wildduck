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

                    messageHandler.counters.ttlcounter('iup:' + session.user.id, 0, limit, false, (err, res) => {
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

                        messageHandler.counters.ttlcounter('iup:' + session.user.id, raw.length, limit, false, () => {
                            flags = Array.isArray(flags) ? flags : [].concat(flags || []);

                            (async () => {
                                try {
                                    let encryptResult = await messageHandler.encryptMessageAsync(
                                        userData.encryptMessages && !flags.includes('\\Draft') ? tools.getUserEncryptionKey(userData) : false,
                                        raw
                                    );
                                    if (encryptResult) {
                                        raw = encryptResult.raw;
                                    } else {
                                        server.logger.error(
                                            { tnx: 'encrypt', cid: session.id },
                                            '[%s] Encryption returned false for user %s, message stored unencrypted',
                                            session.id,
                                            session.user.id
                                        );
                                        server.loggelf({
                                            short_message: '[ENCRYPTSKIP] Encryption returned false during IMAP APPEND',
                                            _mail_action: 'encrypt_skip',
                                            _user: session.user.id,
                                            _sess: session && session.id,
                                            _source: 'imap_append'
                                        });
                                    }
                                } catch (err) {
                                    server.loggelf({
                                        short_message: '[ENCRYPTFAIL] Encryption failed during IMAP APPEND',
                                        _mail_action: 'encrypt_fail',
                                        _user: session.user.id,
                                        _error: err.message,
                                        _code: err.code || 'EncryptionError',
                                        _sess: session && session.id,
                                        _source: 'imap_append'
                                    });
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
                            })().catch(err => {
                                server.loggelf({
                                    short_message: '[APPENDFAIL] Unhandled error during IMAP APPEND',
                                    _mail_action: 'append_fail',
                                    _user: session.user.id,
                                    _error: err.message,
                                    _code: err.code || 'UnhandledError',
                                    _sess: session && session.id,
                                    _source: 'imap_append'
                                });
                                callback(err);
                            });
                        });
                    });
                });
            });
        }
    );
};
