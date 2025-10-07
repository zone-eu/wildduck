'use strict';

const log = require('npmlog');
const db = require('../db');
const util = require('util');
const { prepareSearchFilter } = require('../prepare-search-filter');
const { getMongoDBQuery } = require('../search-query');
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
        filter = await getMongoDBQuery(db, user, data.q);
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
        const mailboxData = updateAction === 'move' ? await messageHandler.getMailboxAsync({ mailbox: action.moveTo }) : false;

        let cursor = await db.database.collection('messages').find(filter);

        let messageData;

        if (!updateAction) {
            // nothing to do here
            return;
        }

        while ((messageData = await cursor.next())) {
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
        await cursor.close();
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
