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

        // quota root of another account: only visible if that account shares at least one mailbox
        let ownerData = await acl.asyncResolveIdentifier(parsed.identifier);
        if (!ownerData || acl.ownerNamespace(ownerData) !== parsed.namespace) {
            // unknown owner, or the quota root names the wrong namespace for the account kind
            return false;
        }

        let aclList = await db.database
            .collection('acls')
            .find({
                user: session.user.id,
                owner: ownerData._id
            })
            .project({
                rights: true
            })
            .maxTimeMS(consts.DB_MAX_TIME_MAILBOXES)
            .toArray();

        let visible = aclList.some(aclData => {
            let rights = acl.normalizeRights(aclData.rights);
            return acl.hasRight(rights, acl.ACL_RIGHTS.LOOKUP) || acl.hasRight(rights, acl.ACL_RIGHTS.READ);
        });
        if (!visible) {
            // do not disclose the quota of unrelated users
            return false;
        }

        // grants that cross the tenant scope behave as if they do not exist
        let sameTenant = await acl.asyncCheckTenantScope(ownerData._id, session.user.id);
        return sameTenant ? ownerData._id : false;
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
