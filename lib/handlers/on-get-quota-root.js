'use strict';

const { getUserQuota } = require('./quota');
const { ACL_RIGHTS } = require('../acl');
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
        let resolved = await resolveMailboxAsync(server, session, path, { requireRights: ACL_RIGHTS.READ });
        let mailbox = resolved.mailboxData;

        if (!mailbox) {
            return 'NONEXISTENT';
        }

        if (resolved.denied) {
            return 'NOPERM';
        }

        return await getUserQuota(server, resolved.owner);
    };

    getQuotaRoot().then(result => callback(null, result), callback);
};
