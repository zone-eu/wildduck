'use strict';

const { getUserQuota } = require('./quota');

module.exports = server => (quotaRoot, session, callback) => {
    server.logger.debug(
        {
            tnx: 'quota',
            cid: session.id
        },
        '[%s] Requested quota info for "%s"',
        session.id,
        quotaRoot
    );

    if (quotaRoot !== '') {
        return callback(null, 'NONEXISTENT');
    }

    getUserQuota(server, session.user.id).then(result => callback(null, result), callback);
};
