'use strict';

const { getUserQuota } = require('./quota');
const { resolveMailboxAsync } = require('../mailbox-resolver');

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
        let resolved = await resolveMailboxAsync(server, session, path);
        let mailbox = resolved.mailboxData;

        if (!mailbox) {
            return 'NONEXISTENT';
        }

        return await getUserQuota(server, resolved.owner);
    };

    getQuotaRoot().then(result => callback(null, result), callback);
};
