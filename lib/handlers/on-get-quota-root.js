'use strict';

const { getUserQuota } = require('./quota');
const acl = require('../acl');
const { ACL_RIGHTS } = acl;
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

        let quota = await getUserQuota(server, resolved.owner);
        if (resolved.shared) {
            // shared mailboxes account against the quota root of their owner
            quota.root = acl.formatQuotaRoot(resolved.ownerNamespace, resolved.ownerName);
        }
        return quota;
    };

    getQuotaRoot().then(result => callback(null, result), callback);
};
