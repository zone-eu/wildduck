'use strict';

const log = require('npmlog');
const db = require('../db');
const util = require('util');
const { prepareSearchFilter } = require('../prepare-search-filter');
const { getMongoDBQuery } = require('../search-query');
const consts = require('../consts');
const ObjectId = require('mongodb').ObjectId;

let run = async (task, data, options) => {
    const messageHandler = options.messageHandler;

    const updateMessage = util.promisify(messageHandler.update.bind(messageHandler));

    let updated = 0;
    let errors = 0;

    const user = new ObjectId(data.user);

    const action = data.action || {};
    let updateAction = false;

    if (action.moveTo) {
        action.moveTo = new ObjectId(action.moveTo);
        updateAction = 'move';
    }

    let query;
    let filter;

    if (data.q) {
        filter = await getMongoDBQuery(db, user, data.q, { useAndSearch: data.useAndSearch });
        query = data.q;
    } else {
        let prepared = await prepareSearchFilter(db, user, data);
        filter = prepared.filter;
        query = prepared.query;
    }

    try {
        let updates = {};
        for (let key of ['seen', 'flagged']) {
            if (key in action) {
                updates[key] = action[key];
            }
        }

        if (Object.keys(updates).length) {
            updateAction = 'update';
        }

        if (action.delete) {
            updateAction = 'delete';
        }

        // getMailboxAsync throws if mailbox is missing or wrong owner
        const mailboxData = updateAction === 'move' ? await messageHandler.getMailboxAsync({ user, mailbox: action.moveTo }) : false;

        if (!updateAction) {
            // nothing to do here
            return;
        }

        // Materialize one stable ID batch before applying any action. Updating or
        // moving messages while iterating the search cursor can change indexed fields
        // and cause MongoDB to skip later matches. Paging by _id keeps memory bounded
        // while ensuring our own mutations are always behind the next page boundary.
        const messages = db.database.collection('messages');
        const findOptions =
            updateAction === 'delete'
                ? {}
                : {
                      projection: {
                          _id: true,
                          user: true,
                          mailbox: true,
                          uid: true
                      }
                  };
        const maxIdEntries = await messages.find(filter).project({ _id: true }).sort({ _id: -1 }).limit(1).toArray();
        const maxId = maxIdEntries.length ? maxIdEntries[0]._id : false;

        if (!maxId) {
            return;
        }

        let lastId;
        let hasMore = true;

        while (hasMore) {
            const idRange = { $lte: maxId };
            if (lastId) {
                idRange.$gt = lastId;
            }

            const batchFilter = { $and: [filter, { _id: idRange }] };
            const messageIds = await messages
                .find(batchFilter)
                .project({ _id: true })
                .sort({ _id: 1 })
                .limit(consts.CURSOR_MAX_PAGE_SIZE)
                .toArray();

            if (!messageIds.length) {
                break;
            }

            lastId = messageIds[messageIds.length - 1]._id;
            hasMore = messageIds.length === consts.CURSOR_MAX_PAGE_SIZE;

            for (const { _id } of messageIds) {
                const messageData = await messages.findOne({ _id }, findOptions);

                if (!messageData || messageData.user.toString() !== user.toString()) {
                    continue;
                }

                if (updateAction === 'move' && action.moveTo.toString() === messageData.mailbox.toString()) {
                    updateAction = 'update';
                }

                switch (updateAction) {
                    case 'move':
                        try {
                            await messageHandler.moveAsync({
                                user,
                                source: {
                                    user: messageData.user,
                                    mailbox: messageData.mailbox
                                },
                                destination: {
                                    mailbox: mailboxData._id
                                },
                                updates: Object.keys(updates).length ? updates : false,
                                messageQuery: messageData.uid
                            });
                            updated++;
                        } catch (err) {
                            errors++;
                            log.error(
                                'Tasks',
                                'task=search-apply id=%s user=%s query=%s message=%s error=%s',
                                task._id,
                                data.user,
                                JSON.stringify(query),
                                messageData._id,
                                err.message
                            );
                        }

                        break;
                    case 'update':
                        try {
                            updated += await updateMessage(user, messageData.mailbox, messageData.uid, updates);
                        } catch (err) {
                            errors++;
                            log.error(
                                'Tasks',
                                'task=search-apply id=%s user=%s query=%s message=%s error=%s',
                                task._id,
                                data.user,
                                JSON.stringify(query),
                                messageData._id,
                                err.message
                            );
                        }
                        break;
                    case 'delete':
                        // delete found messages
                        // allow delete of searched messages only in Trash, Junk, and Drafts folders
                        try {
                            await messageHandler.delAsync({
                                user,
                                mailbox: { user, mailbox: messageData.mailbox },
                                messageData,
                                archive: !messageData.flags.includes('\\Draft')
                            });
                            updated++;
                        } catch (err) {
                            errors++;
                            log.error(
                                'Tasks',
                                'task=search-apply id=%s user=%s query=%s message=%s error=%s',
                                task._id,
                                data.user,
                                JSON.stringify(query),
                                messageData._id,
                                err.message
                            );
                        }
                        break;
                    default:
                        break;
                }
            }
        }
    } catch (err) {
        log.error('Tasks', 'task=search-apply id=%s user=%s error=%s', task._id, data.user, err.stack);
        // best effort, do not throw
    } finally {
        log.verbose('Tasks', 'task=search-apply id=%s user=%s query=%s updated=%s errors=%s', task._id, data.user, JSON.stringify(query), updated, errors);
    }
};

module.exports = (task, data, options, callback) => {
    run(task, data, options)
        .then(result => callback(null, result))
        .catch(err => {
            log.error('Tasks', 'task=search-apply id=%s user=%s error=%s', task._id, data.user, err.stack);
            callback(err);
        });
};
