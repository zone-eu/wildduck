'use strict';

const { ObjectId } = require('mongodb');
const db = require('../db');
const consts = require('../consts');
const tools = require('../tools');
const { getLabelMaps, resolveImapLabels } = require('../label-handler');
const imapTools = require('../../imap-core/lib/imap-tools');
const acl = require('../acl');
const { resolveMailboxAsync } = require('../mailbox-resolver');

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

    // Resolves with the callback arguments: [status, info] on success, [code] for a rejection
    // Quota and encryption follow the owning user, rate limits follow the session user
    const appendTo = async (owner, ownerPath) => {
        let userData = await db.users.collection('users').findOne(
            {
                _id: owner
            },
            {
                maxTimeMS: consts.DB_MAX_TIME_USERS
            }
        );

        if (!userData) {
            throw new Error('User not found');
        }

        let quota = await userCache.getAsync(owner, 'quota', { setting: 'const:max:storage' });
        if (quota && userData.storageUsed > quota) {
            return ['OVERQUOTA'];
        }

        let limit = await userCache.getAsync(session.user.id, 'imapMaxUpload', { setting: 'const:max:imap:upload' });

        let res = await messageHandler.counters.asyncTTLCounter('iup:' + session.user.id, 0, limit, false);
        if (!res.success) {
            let err = new Error('Upload was rate limited');
            err.response = 'NO';
            err.code = 'UploadRateLimited';
            err.ttl = res.ttl;
            err.responseMessage = `Upload was rate limited. Try again in ${tools.roundTime(res.ttl)}.`;
            throw err;
        }

        try {
            await messageHandler.counters.asyncTTLCounter('iup:' + session.user.id, raw.length, limit, false);
        } catch {
            // the upload counter is best-effort
        }

        flags = Array.isArray(flags) ? flags : [].concat(flags || []);

        const labelIds = flags
            .map(flag => typeof flag === 'string' && /^\$wdlabel\$([a-f0-9]{24})$/i.exec(flag))
            .filter(match => match)
            .map(match => new ObjectId(match[1]));
        const uniqueLabelIds = [...new Map(labelIds.map(id => [id.toString(), id])).values()];
        const labelMaps = uniqueLabelIds.length ? await getLabelMaps(db.database, owner, { ids: uniqueLabelIds }) : { records: [] };
        const resolved = resolveImapLabels(flags, labelMaps.records);
        const labels = resolved.labels;
        flags = resolved.flags;

        let encryptionKey = userData.encryptMessages && !flags.includes('\\Draft') ? tools.getUserEncryptionKey(userData) : false;
        if (encryptionKey) {
            try {
                let encryptResult = await messageHandler.encryptMessageAsync(encryptionKey, raw);
                if (encryptResult) {
                    raw = encryptResult.raw;
                } else {
                    server.logger.error(
                        { tnx: 'encrypt', cid: session.id },
                        '[%s] Encryption returned false, message stored unencrypted (source=%s user=%s)',
                        session.id,
                        'imap_append',
                        session.user.id
                    );
                    server.loggelf({
                        short_message: '[ENCRYPTSKIP] Encryption returned false, message stored unencrypted',
                        _mail_action: 'encrypt_skip',
                        _user: session.user.id,
                        _sess: session && session.id,
                        _source: 'imap_append'
                    });
                }
            } catch (err) {
                server.logger.error(
                    { tnx: 'encrypt', cid: session.id },
                    '[%s] Encryption failed, message stored unencrypted (source=%s user=%s code=%s): %s',
                    session.id,
                    'imap_append',
                    session.user.id,
                    err.code || 'EncryptionError',
                    err.message
                );
                server.loggelf({
                    short_message: '[ENCRYPTFAIL] Encryption failed, message stored unencrypted',
                    _mail_action: 'encrypt_fail',
                    _user: session.user.id,
                    _error: err.message,
                    _code: err.code || 'EncryptionError',
                    _sess: session && session.id,
                    _source: 'imap_append'
                });
            }
        }

        let added;
        try {
            added = await messageHandler.addAsync({
                user: owner,
                path: ownerPath,
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
                labels,
                raw
            });
        } catch (err) {
            if (err.imapResponse) {
                return [err.imapResponse];
            }
            throw err;
        }

        return [added.status, added.data];
    };

    const append = async () => {
        if (!acl.isEnabled(server) || !acl.parsePath(path).shared) {
            return await appendTo(session.user.id, path);
        }

        let resolved = await resolveMailboxAsync(server, session, path, { requireRights: acl.ACL_RIGHTS.INSERT });

        if (!resolved.mailboxData) {
            return ['TRYCREATE'];
        }

        if (resolved.denied) {
            return ['NOPERM'];
        }

        // RFC 4314: silently drop flags the user has no right to set
        flags = [].concat(flags || []).filter(flag => acl.hasRight(resolved.rights, imapTools.aclRightForFlag(flag)));

        return await appendTo(resolved.owner, resolved.path);
    };

    append().then(
        args => callback(null, ...args),
        err => {
            if (!err.response) {
                // not a protocol level rejection
                server.loggelf({
                    short_message: '[APPENDFAIL] Unhandled error during IMAP APPEND',
                    _mail_action: 'append_fail',
                    _user: session.user.id,
                    _error: err.message,
                    _code: err.code || 'UnhandledError',
                    _sess: session && session.id,
                    _source: 'imap_append'
                });
            }
            callback(err);
        }
    );
};
