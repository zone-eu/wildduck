'use strict';

const config = require('@zone-eu/wild-config');

module.exports = (server, userHandler, userCache) => (login, session, callback) => {
    let username = (login.username || '').toString().trim();

    // Resolves with the session user, or with nothing when the login is refused
    const authenticate = async () => {
        let [result] = await userHandler.asyncAuthenticate(username, login.password, 'imap', {
            protocol: 'IMAP',
            sess: session.id,
            ip: session.remoteAddress
        });

        if (!result) {
            return;
        }

        if (result.scope === 'master' && result.require2fa) {
            // master password not allowed if 2fa is enabled!
            return;
        }

        if (typeof server.notifier.allocateConnection === 'function') {
            let limit = await userCache.getAsync(result.user, 'imapMaxConnections', config.imap.maxConnections || 15);
            let connection = login.connection || {};

            let success = await new Promise((resolve, reject) =>
                server.notifier.allocateConnection(
                    {
                        service: 'imap',
                        session,
                        user: result.user,
                        limit
                    },
                    (err, success) => (err ? reject(err) : resolve(success))
                )
            );

            server.loggelf(
                success
                    ? {
                          short_message: '[CONNSTART] Connection established for ' + result.user,
                          _connection: 'establish',
                          _service: 'imap',
                          _sess: session && session.id,
                          _user: result.user,
                          _cid: connection.id,
                          _ip: connection.remoteAddress,
                          _limit: limit
                      }
                    : {
                          short_message: '[CONNFAILED] Connection failed for ' + result.user,
                          _connection: 'limited',
                          _service: 'imap',
                          _sess: session && session.id,
                          _user: result.user,
                          _cid: connection.id,
                          _ip: connection.remoteAddress,
                          _limit: limit
                      }
            );

            if (!success) {
                let err = new Error('[ALERT] Too many simultaneous connections.');
                err.response = 'NO';
                throw err;
            }
        }

        return {
            user: {
                id: result.user,
                username: result.username
            }
        };
    };

    authenticate().then(result => callback(null, result), callback);
};
