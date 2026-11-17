'use strict';
/* global db, log, loggelf */
// MongoDB Migration Script: make message roots usable as JMAP Email ids for every user
//
// JMAP Email ids are message roots (lib/message-roots.js). Messages stored before every message got a
// root lack one, and IMAP copies made before a copy got its own root share the root of the original.
// The JMAP service repairs a user's roots on first use, so this migration is optional: it does the
// same for every user ahead of time, a user at a time, and skips users that are already done.
const config = require('@zone-eu/wild-config');
const { ensureUserRoots } = require('../../lib/message-roots');

const migrationConfig = config?.migrations?.database?.messagesRootRepair || {};
const ENABLED = process.env.NODE_ENV === 'test' ? false : !!migrationConfig.enabled;
const THROTTLE_MS = getNonNegativeInteger(migrationConfig.throttleMs, 100);
const SETTLE_MS = getNonNegativeInteger(migrationConfig.settleMs, 2000);

function getNonNegativeInteger(value, defaultValue) {
    const numericValue = Number(value);
    return Number.isSafeInteger(numericValue) && numericValue >= 0 ? numericValue : defaultValue;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function repairRoots() {
    const started = Date.now();
    log('Starting migration: repairing message roots per user');
    loggelf({
        short_message: '[MIGRATION] messages root repair started',
        _migration_event: 'started',
        _collection: 'messages',
        _throttle_ms: THROTTLE_MS
    });

    let users = 0;
    let repaired = 0;
    let filled = 0;
    let separated = 0;

    try {
        // every user has exactly one INBOX, which gives the user list from this database. The projection
        // is covered by the {user, path} index, so the scan reads index keys and no mailbox documents
        const cursor = db
            .collection('mailboxes')
            .find({ path: 'INBOX' }, { projection: { _id: false, user: true } })
            .hint('user_path');
        for await (const mailbox of cursor) {
            users++;
            const result = await ensureUserRoots(db, mailbox.user, { settleMs: SETTLE_MS });
            if (result.repaired) {
                repaired++;
                filled += result.filled;
                separated += result.separated;
                if (THROTTLE_MS) {
                    await sleep(THROTTLE_MS);
                }
            }
        }
    } catch (err) {
        loggelf({
            short_message: '[MIGRATION] messages root repair failed',
            _migration_event: 'failed',
            _error: err.message,
            _users: users,
            _repaired: repaired
        });
        throw err;
    }

    log(`Migration finished: ${users} users, ${repaired} repaired, ${filled} roots filled, ${separated} shared roots separated`);
    loggelf({
        short_message: '[MIGRATION] messages root repair finished',
        _migration_event: 'finished',
        _users: users,
        _repaired: repaired,
        _filled: filled,
        _separated: separated,
        _duration_ms: Date.now() - started
    });
}

if (ENABLED) {
    return repairRoots();
}

log('Migration disabled: messagesRootRepair');
