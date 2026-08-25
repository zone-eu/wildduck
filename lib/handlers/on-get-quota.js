'use strict';

const db = require('../db');
const consts = require('../consts');
const acl = require('../acl');
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

    let parsed = acl.isEnabled(server) ? acl.parseQuotaRoot(quotaRoot) : { shared: false, root: quotaRoot };

    const resolveUser = async () => {
        if (!parsed.shared) {
            return quotaRoot === '' ? session.user.id : false;
        }

        // quota root of another user: only visible if that user shares at least one mailbox
        let ownerData = await acl.asyncResolveIdentifier(parsed.identifier);
        if (!ownerData) {
            return false;
        }

        let aclData = await db.database.collection('mailboxacls').findOne(
            {
                user: session.user.id,
                owner: ownerData._id
            },
            {
                projection: {
                    _id: true
                },
                maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
            }
        );

        // do not disclose the quota of unrelated users
        return aclData ? ownerData._id : false;
    };

    const getQuota = async () => {
        let userId = await resolveUser();
        if (!userId) {
            return 'NONEXISTENT';
        }

        let quota = await getUserQuota(server, userId);
        quota.root = quotaRoot;
        return quota;
    };

    getQuota().then(result => callback(null, result), callback);
};
