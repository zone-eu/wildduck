'use strict';

//
// Thanks to Forward Email
// <https://forwardemail.net>
// <https://github.com/zone-eu/wildduck/issues/711>
// tag XAPPLEPUSHSERVICE aps-version 2 aps-account-id 0715A26B-CA09-4730-A419-793000CA982E aps-device-token 2918390218931890821908309283098109381029309829018310983092892829 aps-subtopic com.apple.mobilemail mailboxes (INBOX Notes)
//

const db = require('../db');
const consts = require('../consts');

module.exports = server => (accountID, deviceToken, subTopic, mailboxes, session, callback) => {
    server.logger.debug(
        {
            tnx: 'xapplepushservice',
            cid: session.id
        },
        '[%s] XAPPLEPUSHSERVICE accountID "%s" deviceToken "%s..." subTopic "%s" mailboxes "%s"',
        session.id,
        accountID,
        (deviceToken || '').slice(0, 4),
        subTopic,
        mailboxes
    );

    if (!/^[0-9a-fA-F]{64}$/.test(deviceToken)) {
        server.logger.error(
            {
                tnx: 'xapplepushservice',
                cid: session.id
            },
            '[%s] XAPPLEPUSHSERVICE Invalid device token format for user %s',
            session.id,
            session.user.id
        );
        if (typeof server.loggelf === 'function') {
            server.loggelf({
                short_message: '[XAPPLEPUSHSERVICE] Invalid device token format',
                _mail_action: 'xapplepushservice_error',
                _user: session.user.id.toString(),
                _sess: session.id,
                _error: 'Invalid device token format'
            });
        }
        return callback(new Error('Invalid device token format'));
    }

    // aps-account-id is a UUID; validate it before storing as it is later used verbatim
    // as the apns-collapse-id header (capped at 64 bytes, must be a valid HTTP/2 header value)
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(accountID)) {
        server.logger.error(
            {
                tnx: 'xapplepushservice',
                cid: session.id
            },
            '[%s] XAPPLEPUSHSERVICE Invalid account id format for user %s',
            session.id,
            session.user.id
        );
        if (typeof server.loggelf === 'function') {
            server.loggelf({
                short_message: '[XAPPLEPUSHSERVICE] Invalid account id format',
                _mail_action: 'xapplepushservice_error',
                _user: session.user.id.toString(),
                _sess: session.id,
                _error: 'Invalid account id format'
            });
        }
        return callback(new Error('Invalid account id format'));
    }

    const apsConfig = server.options.aps || {};
    const topic = apsConfig.topic;

    if (!topic) {
        server.logger.error(
            {
                tnx: 'xapplepushservice',
                cid: session.id
            },
            '[%s] XAPPLEPUSHSERVICE Missing aps.topic configuration for user %s',
            session.id,
            session.user.id
        );
        if (typeof server.loggelf === 'function') {
            server.loggelf({
                short_message: '[XAPPLEPUSHSERVICE] Missing aps.topic configuration',
                _mail_action: 'xapplepushservice_error',
                _user: session.user.id.toString(),
                _sess: session.id,
                _error: 'APS topic not configured'
            });
        }
        return callback(new Error('APS topic not configured'));
    }

    const user = session.user.id;

    const storeRegistration = mailboxIds => {
        db.database.collection('pushsubscriptions').findOneAndUpdate(
            {
                user,
                deviceToken
            },
            {
                $set: {
                    accountId: accountID,
                    subTopic,
                    // only stable mailbox ids are stored; paths are resolved on read so renames are reflected
                    mailboxIds,
                    updated: new Date()
                },
                $setOnInsert: {
                    user,
                    deviceToken,
                    created: new Date()
                }
            },
            {
                upsert: true,
                maxTimeMS: consts.DB_MAX_TIME_USERS
            },
            (err, r) => {
                if (err) {
                    server.logger.error(
                        {
                            tnx: 'xapplepushservice',
                            cid: session.id
                        },
                        '[%s] XAPPLEPUSHSERVICE Failed to store registration for user %s. %s (code %s)',
                        session.id,
                        user,
                        err.message,
                        err.code
                    );
                    if (typeof server.loggelf === 'function') {
                        server.loggelf({
                            short_message: '[XAPPLEPUSHSERVICE] Failed to store registration',
                            _mail_action: 'xapplepushservice_error',
                            _user: user.toString(),
                            _sess: session.id,
                            _error: err.message,
                            _code: err.code
                        });
                    }
                    return callback(err);
                }

                let action = r.lastErrorObject && r.lastErrorObject.upserted ? 'created' : 'updated';

                server.logger.info(
                    {
                        tnx: 'xapplepushservice',
                        cid: session.id
                    },
                    '[%s] XAPPLEPUSHSERVICE Registration %s for user %s accountId "%s" deviceToken "%s..." mailboxes "%s"',
                    session.id,
                    action,
                    user,
                    accountID,
                    deviceToken.slice(0, 4),
                    (mailboxes || []).join(',')
                );

                if (typeof server.loggelf === 'function') {
                    server.loggelf({
                        short_message: '[XAPPLEPUSHSERVICE] Registration ' + action,
                        _mail_action: 'xapplepushservice_' + action,
                        _user: user.toString(),
                        _sess: session.id,
                        _accountId: accountID,
                        _deviceToken: deviceToken.slice(0, 4) + '...',
                        _mailboxes: (mailboxes || []).join(',')
                    });
                }

                return callback(null, topic);
            }
        );
    };

    // Resolve paths to stable mailbox IDs so renames (which change path, not _id) don't stop pushes.
    db.database
        .collection('mailboxes')
        .find(
            {
                user,
                path: { $in: Array.isArray(mailboxes) ? mailboxes : [] }
            },
            {
                projection: { _id: 1 },
                maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
            }
        )
        .toArray()
        .then(mailboxDocs => storeRegistration(mailboxDocs.map(mailboxData => mailboxData._id)))
        .catch(err => {
            server.logger.error(
                {
                    tnx: 'xapplepushservice',
                    cid: session.id
                },
                '[%s] XAPPLEPUSHSERVICE Failed to resolve mailbox ids for user %s. %s (code %s)',
                session.id,
                user,
                err.message,
                err.code
            );
            if (typeof server.loggelf === 'function') {
                server.loggelf({
                    short_message: '[XAPPLEPUSHSERVICE] Failed to resolve mailbox ids',
                    _mail_action: 'xapplepushservice_error',
                    _user: user.toString(),
                    _sess: session.id,
                    _error: err.message,
                    _code: err.code
                });
            }
            return callback(err);
        });
};
