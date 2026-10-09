'use strict';

const imapTools = require('../../imap-core/lib/imap-tools');
const db = require('../db');
const tools = require('../tools');
const consts = require('../consts');
const { ObjectId } = require('mongodb');
const { getLabelMaps, getMessageImapFlags, resolveImapLabels } = require('../label-handler');

// STORE / UID STORE, updates flags for selected UIDs
module.exports = server => async (mailbox, update, session, callback) => {
    server.logger.debug(
        {
            tnx: 'store',
            cid: session.id
        },
        '[%s] Updating messages in "%s"',
        session.id,
        mailbox
    );
    let mailboxData;
    try {
        mailboxData = await db.database.collection('mailboxes').findOne(
            {
                _id: mailbox
            },
            {
                maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
            }
        );
    } catch (err) {
        return callback(err);
    }

    if (!mailboxData) {
        return callback(null, 'NONEXISTENT');
    }

    let modified = [];

    let newModseq = false;
    let getModseq = async next => {
        if (newModseq) {
            return next(null, newModseq);
        }
        let item;
        try {
            item = await db.database.collection('mailboxes').findOneAndUpdate(
                { _id: mailboxData._id },
                {
                    $inc: {
                        modifyIndex: 1
                    }
                },
                { includeResultMetadata: true, returnDocument: 'after', maxTimeMS: consts.DB_MAX_TIME_MAILBOXES }
            );
        } catch (err) {
            return next(err);
        }

        newModseq = item && item.value && item.value.modifyIndex;

        next(null, newModseq);
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

    let labelMaps = { records: [], byId: new Map() };
    try {
        const assignedLabelIds = await db.database.collection('messages').distinct('labels', query, { maxTimeMS: consts.DB_MAX_TIME_MESSAGES });
        const requestedLabelIds = update.value
            .map(flag => typeof flag === 'string' && /^\$wdlabel\$([a-f0-9]{24})$/i.exec(flag))
            .filter(match => match)
            .map(match => new ObjectId(match[1]));
        const labelIds = [...new Map([...assignedLabelIds, ...requestedLabelIds].map(id => [id.toString(), id])).values()];
        if (labelIds.length) {
            labelMaps = await getLabelMaps(db.database, mailboxData.user, { ids: labelIds });
        }
    } catch (err) {
        return callback(err);
    }

    let condstoreEnabled = !!session.selected.condstoreEnabled;

    let cursor = db.database
        .collection('messages')
        .find(query)
        .project({
            _id: true,
            uid: true,
            flags: true,
            labels: true,
            thread: true,
            modseq: true
        })
        .maxTimeMS(consts.DB_MAX_TIME_MESSAGES)
        .sort({ uid: 1 });

    let updateEntries = [];
    let notifyEntries = [];

    let done = (...args) => {
        if (updateEntries.length) {
            return db.database
                .collection('messages')
                .bulkWrite(updateEntries, {
                    ordered: false,
                    writeConcern: { w: 1 }
                })
                .catch(() => false)
                .then(() => {
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
                });
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
    let processNext = async () => {
        let message;
        try {
            message = await cursor.next();
        } catch (err) {
            return done(err);
        }

        if (!message) {
            return cursor
                .close()
                .catch(() => false)
                .then(() => done(null, true, modified));
        }
        if (queryAll && !session.selected.uidList.includes(message.uid)) {
            // skip processing messages that we do not know about yet
            return setImmediate(processNext);
        }

        // RFC 7162 3.1.3: "Use of UNCHANGEDSINCE with a modification sequence of 0 always
        // fails if the metadata item exists. A system flag MUST always be considered
        // existent", so a modseq of 0 rejects every message
        if (update.unchangedSince !== false && message.modseq > update.unchangedSince) {
            modified.push(message.uid);
            return setImmediate(processNext);
        }

        let flagsupdate = false; // query object for updates
        let addedFlags = [];
        let removedFlags = [];

        message.flags = message.flags || [];
        message.labels = message.labels || [];
        const originalLabelIds = message.labels;
        const oldLabelNames = new Set((message.labels || []).map(id => labelMaps.byId.get(id.toString())).filter(name => name));
        message.flags = getMessageImapFlags(message, labelMaps.byId);

        let updated = false;
        const messageWasSeen = message.flags.includes('\\Seen');
        const messageWasFlagged = message.flags.includes('\\Flagged');
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

                    // also repairs a message stored while \Deleted kept it out of the index
                    flagsupdate.$set.searchable = true;
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
                    addedFlags = newFlags;
                    flagsupdate = {
                        $addToSet: {
                            flags: {
                                $each: newFlags
                            }
                        }
                    };

                    if (newFlags.includes('\\Seen') || newFlags.includes('\\Flagged') || newFlags.includes('\\Deleted') || newFlags.includes('\\Draft')) {
                        flagsupdate.$set = {};

                        if (newFlags.includes('\\Seen')) {
                            flagsupdate.$set.unseen = false;
                        }

                        if (newFlags.includes('\\Flagged')) {
                            flagsupdate.$set.flagged = true;
                        }

                        if (newFlags.includes('\\Deleted')) {
                            flagsupdate.$set.undeleted = false;
                        }

                        if (newFlags.includes('\\Draft')) {
                            flagsupdate.$set.draft = true;
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
                    removedFlags = oldFlags;
                    flagsupdate = {
                        $pull: {
                            flags: {
                                $in: oldFlags
                            }
                        }
                    };
                    if (oldFlags.includes('\\Seen') || oldFlags.includes('\\Flagged') || oldFlags.includes('\\Deleted') || oldFlags.includes('\\Draft')) {
                        flagsupdate.$set = {};
                        if (oldFlags.includes('\\Seen')) {
                            flagsupdate.$set.unseen = true;
                        }
                        if (oldFlags.includes('\\Flagged')) {
                            flagsupdate.$set.flagged = false;
                        }
                        if (oldFlags.includes('\\Deleted')) {
                            flagsupdate.$set.undeleted = true;
                            // repairs a message stored while \Deleted kept it out of the index
                            flagsupdate.$set.searchable = true;
                        }
                        if (oldFlags.includes('\\Draft')) {
                            flagsupdate.$set.draft = false;
                        }
                    }
                }
                break;
            }
        }

        let resolved;
        if (update.action === 'set') {
            resolved = resolveImapLabels(message.flags, labelMaps.records);
        } else {
            const labelFlag = id => `$wdlabel$${id.toString()}`;
            let currentIds = originalLabelIds.filter(id => labelMaps.byId.has(id.toString()));
            if (update.action === 'add') {
                const incoming = update.value.filter(flag => !existingFlags.includes(flag.toLowerCase().trim()));
                const additions = resolveImapLabels(incoming, labelMaps.records).labels;
                currentIds = [...new Map([...currentIds, ...additions].map(id => [id.toString(), id])).values()];
            } else if (update.action === 'remove') {
                const remaining = new Set(message.flags.map(flag => flag.toLowerCase()));
                currentIds = currentIds.filter(id => remaining.has(labelFlag(id).toLowerCase()));
            }
            const assignedFlags = new Set(currentIds.map(id => labelFlag(id).toLowerCase()));
            resolved = {
                labels: currentIds,
                flags: message.flags.filter(flag => !assignedFlags.has(flag.toLowerCase()))
            };
        }
        const currentLabelIds = resolved.labels;
        const currentLabelIdSet = new Set(currentLabelIds.map(id => id.toString()));
        const currentLabelNames = new Set(currentLabelIds.map(id => labelMaps.byId.get(id.toString())).filter(name => name));
        message.flags = getMessageImapFlags({ flags: resolved.flags, labels: currentLabelIds }, labelMaps.byId);

        const previousLabelIds = new Set(message.labels.map(label => label.toString()));
        if (previousLabelIds.size !== currentLabelIdSet.size || [...previousLabelIds].some(label => !currentLabelIdSet.has(label))) {
            updated = true;
        }

        if (updated) {
            flagsupdate = flagsupdate || { $set: {} };
            flagsupdate.$set = flagsupdate.$set || {};
            if (update.action === 'set') {
                flagsupdate.$set.flags = resolved.flags;
                flagsupdate.$set.labels = currentLabelIds;
            } else {
                const addedLabelIds = currentLabelIds.filter(id => !previousLabelIds.has(id.toString()));
                const removedLabelIds = originalLabelIds.filter(id => !currentLabelIdSet.has(id.toString()));
                const ordinaryAddedFlags = resolveImapLabels(addedFlags, labelMaps.records).flags;
                const ordinaryRemovedFlags = resolveImapLabels(removedFlags, labelMaps.records).flags;

                if (ordinaryAddedFlags.length || ordinaryRemovedFlags.length) {
                    const flagsBase = ordinaryRemovedFlags.length
                        ? {
                              $filter: {
                                  input: { $ifNull: ['$flags', []] },
                                  as: 'flag',
                                  cond: { $not: { $in: ['$$flag', { $literal: ordinaryRemovedFlags }] } }
                              }
                          }
                        : { $ifNull: ['$flags', []] };
                    flagsupdate.$set.flags = { $setUnion: [flagsBase, { $literal: ordinaryAddedFlags }] };
                }

                if (addedLabelIds.length || removedLabelIds.length) {
                    const labelsBase = removedLabelIds.length
                        ? {
                              $filter: {
                                  input: { $ifNull: ['$labels', []] },
                                  as: 'label',
                                  cond: { $not: { $in: ['$$label', { $literal: removedLabelIds }] } }
                              }
                          }
                        : { $ifNull: ['$labels', []] };
                    flagsupdate.$set.labels = { $setUnion: [labelsBase, { $literal: addedLabelIds }] };
                }
                delete flagsupdate.$addToSet;
                delete flagsupdate.$pull;
            }
        }

        if (updated) {
            getModseq(async (err, modseq) => {
                if (err) {
                    return cursor
                        .close()
                        .catch(() => false)
                        .then(() => done(err));
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

                let messageUpdate = flagsupdate;
                if (update.action !== 'set') {
                    const pipelineSet = {};
                    for (const [key, value] of Object.entries(flagsupdate.$set)) {
                        pipelineSet[key] = ['flags', 'labels'].includes(key) ? value : { $literal: value };
                    }
                    messageUpdate = [{ $set: pipelineSet }];
                    if (flagsupdate.$unset) {
                        messageUpdate.push({ $unset: Object.keys(flagsupdate.$unset) });
                    }
                }

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
                        update: messageUpdate
                    }
                });

                const messageIsSeen = message.flags.includes('\\Seen');
                const messageIsFlagged = message.flags.includes('\\Flagged');
                const notifyEntry = {
                    command: 'FETCH',
                    ignore: session.id,
                    uid: message.uid,
                    flags: message.flags,
                    thread: message.thread,
                    message: message._id,
                    modseq,
                    unseenChange: messageWasSeen !== messageIsSeen
                };

                if (notifyEntry.unseenChange && currentLabelNames.size) {
                    notifyEntry.labels = [...currentLabelNames];
                }

                if (messageWasFlagged !== messageIsFlagged) {
                    notifyEntry.flaggedChangedTo = messageIsFlagged;
                }

                const addedLabels = [...currentLabelNames].filter(name => !oldLabelNames.has(name));
                const removedLabels = [...oldLabelNames].filter(name => !currentLabelNames.has(name));
                if (addedLabels.length) {
                    notifyEntry.addedLabels = addedLabels;
                }
                if (removedLabels.length) {
                    notifyEntry.removedLabels = removedLabels;
                }

                notifyEntries.push(notifyEntry);

                if (updateEntries.length >= consts.BULK_BATCH_SIZE) {
                    try {
                        await db.database.collection('messages').bulkWrite(updateEntries, {
                            ordered: false,
                            writeConcern: { w: 1 }
                        });
                    } catch (err) {
                        updateEntries = [];

                        return cursor
                            .close()
                            .catch(() => false)
                            .then(() => done(err));
                    }

                    updateEntries = [];

                    server.notifier.addEntries(mailboxData, notifyEntries, () => {
                        notifyEntries = [];
                        // the next batch needs its own modseq, see the EXPUNGE batching in message-handler
                        newModseq = false;
                        server.notifier.fire(session.user.id);
                        return setImmediate(processNext);
                    });

                    return;
                } else {
                    return setImmediate(processNext);
                }
            });
        } else {
            return setImmediate(processNext);
        }
    };

    return setImmediate(processNext);
};

async function updateMailboxFlags(mailbox, update, callback) {
    if (update.action === 'remove') {
        // we didn't add any new flags, so there's nothing to update
        return callback();
    }

    let mailboxFlags = imapTools.systemFlags.concat(mailbox.flags || []).map(flag => flag.trim().toLowerCase());
    let newFlags = [];

    // find flags that are not listed with mailbox
    update.value.filter(flag => typeof flag !== 'string' || !/^\$wdlabel\$/i.test(flag)).forEach(flag => {
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
    let result;
    try {
        result = await db.database.collection('mailboxes').updateOne(
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
            }
        );
    } catch (err) {
        return callback(err);
    }
    return callback(null, result);
}
