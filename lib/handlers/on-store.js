'use strict';

const imapTools = require('../../imap-core/lib/imap-tools');
const db = require('../db');
const tools = require('../tools');
const consts = require('../consts');

// STORE / UID STORE, updates flags for selected UIDs
module.exports = server => (mailbox, update, session, callback) => {
    server.logger.debug(
        {
            tnx: 'store',
            cid: session.id
        },
        '[%s] Updating messages in "%s"',
        session.id,
        mailbox
    );
    db.database.collection('mailboxes').findOne(
        {
            _id: mailbox
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        },
        (err, mailboxData) => {
            if (err) {
                return callback(err);
            }

            if (!mailboxData) {
                return callback(null, 'NONEXISTENT');
            }

            let unseenChange = update.value.includes('\\Seen');

            let modified = [];

            let newModseq = false;
            let getModseq = next => {
                if (newModseq) {
                    return next(null, newModseq);
                }
                db.database.collection('mailboxes').findOneAndUpdate(
                    { _id: mailboxData._id },
                    {
                        $inc: {
                            modifyIndex: 1
                        }
                    },
                    {
                        returnDocument: 'after',
                        maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
                    },
                    (err, item) => {
                        if (err) {
                            return next(err);
                        }

                        newModseq = item && item.value && item.value.modifyIndex;

                        next(null, newModseq);
                    }
                );
            };

            let query = {
                mailbox
            };

            let queryAll = false;
            if (update.messages.length !== session.selected.uidList.length) {
                // do not use uid selector for 1:*
                query.uid = tools.checkRangeQuery(update.messages);
            } else {
                // 1:*
                queryAll = true;
            }

            let condstoreEnabled = !!session.selected.condstoreEnabled;

            let cursor = db.database
                .collection('messages')
                .find(query)
                .project({
                    _id: true,
                    uid: true,
                    flags: true,
                    thread: true,
                    modseq: true
                })
                .maxTimeMS(consts.DB_MAX_TIME_MESSAGES)
                .sort({ uid: 1 });

            let updateEntries = [];
            let notifyEntries = [];

            let done = (...args) => {
                if (updateEntries.length) {
                    return db.database.collection('messages').bulkWrite(
                        updateEntries,
                        {
                            ordered: false,
                            writeConcern: 1
                        },
                        () => {
                            updateEntries = [];
                            server.notifier.addEntries(mailboxData, notifyEntries, () => {
                                notifyEntries = [];
                                server.notifier.fire(session.user.id);
                                if (args[0]) {
                                    // first argument is an error
                                    return callback(...args);
                                } else {
                                    updateMailboxFlags(mailboxData, update, () => callback(...args));
                                }
                            });
                        }
                    );
                }
                server.notifier.fire(session.user.id);
                if (args[0]) {
                    // first argument is an error
                    return callback(...args);
                } else {
                    updateMailboxFlags(mailboxData, update, () => callback(...args));
                }
            };

            // We have to process all messages one by one instead of just calling an update
            // for all messages as we need to know which messages were exactly modified,
            // otherwise we can't send flag update notifications and modify modseq values
            let processNext = () => {
                cursor.next((err, message) => {
                    if (err) {
                        return done(err);
                    }
                    if (!message) {
                        return cursor.close(() => done(null, true, modified));
                    }
                    if (queryAll && !session.selected.uidList.includes(message.uid)) {
                        // skip processing messages that we do not know about yet
                        return setImmediate(processNext);
                    }

                    if (update.unchangedSince && message.modseq > update.unchangedSince) {
                        modified.push(message.uid);
                        return setImmediate(processNext);
                    }

                    let flagsupdate = false; // query object for updates

                    let updated = false;
                    let existingFlags = message.flags.map(flag => flag.toLowerCase().trim());
                    switch (update.action) {
                        case 'set':
                            // check if update set matches current or is different
                            if (
                                // if length does not match
                                existingFlags.length !== update.value.length ||
                                // or a new flag was found
                                update.value.filter(flag => !existingFlags.includes(flag.toLowerCase().trim())).length
                            ) {
                                updated = true;
                            }

                            message.flags = [].concat(update.value);

                            // set flags
                            if (updated) {
                                flagsupdate = {
                                    $set: {
                                        flags: message.flags,
                                        unseen: !message.flags.includes('\\Seen'),
                                        flagged: message.flags.includes('\\Flagged'),
                                        undeleted: !message.flags.includes('\\Deleted'),
                                        draft: message.flags.includes('\\Draft')
                                    }
                                };

                                if (!message.flags.includes('\\Deleted')) {
                                    flagsupdate.$set.searchable = true;
                                } else {
                                    flagsupdate.$unset = {
                                        searchable: ''
                                    };
                                }
                            }
                            break;

                        case 'add': {
                            let newFlags = [];
                            message.flags = message.flags.concat(
                                update.value.filter(flag => {
                                    if (!existingFlags.includes(flag.toLowerCase().trim())) {
                                        updated = true;
                                        newFlags.push(flag);
                                        return true;
                                    }
                                    return false;
                                })
                            );

                            // add flags
                            if (updated) {
                                flagsupdate = {
                                    $addToSet: {
                                        flags: {
                                            $each: newFlags
                                        }
                                    }
                                };

                                if (
                                    newFlags.includes('\\Seen') ||
                                    newFlags.includes('\\Flagged') ||
                                    newFlags.includes('\\Deleted') ||
                                    newFlags.includes('\\Draft')
                                ) {
                                    flagsupdate.$set = {};

                                    if (newFlags.includes('\\Seen')) {
                                        flagsupdate.$set = {
                                            unseen: false
                                        };
                                    }

                                    if (newFlags.includes('\\Flagged')) {
                                        flagsupdate.$set = {
                                            flagged: true
                                        };
                                    }

                                    if (newFlags.includes('\\Deleted')) {
                                        flagsupdate.$set = {
                                            undeleted: false
                                        };
                                        flagsupdate.$unset = {
                                            searchable: ''
                                        };
                                    }

                                    if (newFlags.includes('\\Draft')) {
                                        flagsupdate.$set = {
                                            draft: true
                                        };
                                    }
                                }
                            }
                            break;
                        }

                        case 'remove': {
                            // We need to use the case of existing flags when removing
                            let oldFlags = [];
                            let flagsUpdates = update.value.map(flag => flag.toLowerCase().trim());
                            message.flags = message.flags.filter(flag => {
                                if (!flagsUpdates.includes(flag.toLowerCase().trim())) {
                                    return true;
                                }
                                oldFlags.push(flag);
                                updated = true;
                                return false;
                            });

                            // remove flags
                            if (updated) {
                                flagsupdate = {
                                    $pull: {
                                        flags: {
                                            $in: oldFlags
                                        }
                                    }
                                };
                                if (
                                    oldFlags.includes('\\Seen') ||
                                    oldFlags.includes('\\Flagged') ||
                                    oldFlags.includes('\\Deleted') ||
                                    oldFlags.includes('\\Draft')
                                ) {
                                    flagsupdate.$set = {};
                                    if (oldFlags.includes('\\Seen')) {
                                        flagsupdate.$set = {
                                            unseen: true
                                        };
                                    }
                                    if (oldFlags.includes('\\Flagged')) {
                                        flagsupdate.$set = {
                                            flagged: false
                                        };
                                    }
                                    if (oldFlags.includes('\\Deleted')) {
                                        flagsupdate.$set = {
                                            undeleted: true
                                        };
                                        if (!['\\Junk', '\\Trash'].includes(mailboxData.specialUse)) {
                                            flagsupdate.$set.searchable = true;
                                        }
                                    }
                                    if (oldFlags.includes('\\Draft')) {
                                        flagsupdate.$set = {
                                            draft: false
                                        };
                                    }
                                }
                            }
                            break;
                        }
                    }

                    if (updated) {
                        getModseq((err, modseq) => {
                            if (err) {
                                return cursor.close(() => done(err));
                            }

                            if (!update.silent || condstoreEnabled) {
                                // print updated state of the message
                                session.writeStream.write(
                                    session.formatResponse('FETCH', message.uid, {
                                        uid: update.isUid ? message.uid : false,
                                        flags: message.flags,
                                        modseq: condstoreEnabled ? modseq : false
                                    })
                                );
                            }

                            if (!flagsupdate.$set) {
                                flagsupdate.$set = {};
                            }
                            flagsupdate.$set.modseq = modseq;

                            updateEntries.push({
                                updateOne: {
                                    filter: {
                                        _id: message._id,
                                        // include shard key data as well
                                        mailbox: mailboxData._id,
                                        uid: message.uid,
                                        modseq: {
                                            $lt: modseq
                                        }
                                    },
                                    update: flagsupdate
                                }
                            });

                            notifyEntries.push({
                                command: 'FETCH',
                                ignore: session.id,
                                uid: message.uid,
                                flags: message.flags,
                                thread: message.thread,
                                message: message._id,
                                modseq,
                                unseenChange
                            });

                            if (updateEntries.length >= consts.BULK_BATCH_SIZE) {
                                return db.database.collection('messages').bulkWrite(
                                    updateEntries,
                                    {
                                        ordered: false,
                                        writeConcern: 1
                                    },
                                    err => {
                                        updateEntries = [];
                                        if (err) {
                                            return cursor.close(() => done(err));
                                        }

                                        server.notifier.addEntries(mailboxData, notifyEntries, () => {
                                            notifyEntries = [];
                                            server.notifier.fire(session.user.id);
                                            return setImmediate(processNext);
                                        });
                                    }
                                );
                            } else {
                                return setImmediate(processNext);
                            }
                        });
                    } else {
                        return setImmediate(processNext);
                    }
                });
            };

            return setImmediate(processNext);
        }
    );
};

function updateMailboxFlags(mailbox, update, callback) {
    if (update.action === 'remove') {
        // we didn't add any new flags, so there's nothing to update
        return callback();
    }

    let mailboxFlags = imapTools.systemFlags.concat(mailbox.flags || []).map(flag => flag.trim().toLowerCase());
    let newFlags = [];

    // find flags that are not listed with mailbox
    update.value.forEach(flag => {
        // limit mailbox flags by 100
        if (mailboxFlags.length + newFlags.length >= 100) {
            return;
        }
        // if mailbox does not have such flag, then add it
        if (!mailboxFlags.includes(flag.toLowerCase().trim())) {
            newFlags.push(flag);
        }
    });

    // nothing new found
    if (!newFlags.length) {
        return callback();
    }

    // found some new flags not yet set for mailbox
    // FIXME: Should we send unsolicited FLAGS and PERMANENTFLAGS notifications? Probably not
    return db.database.collection('mailboxes').updateOne(
        {
            _id: mailbox._id
        },
        {
            $addToSet: {
                flags: {
                    $each: newFlags
                }
            }
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        },
        callback
    );
}
