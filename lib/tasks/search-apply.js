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
    if (action.moveTo) {
        action.moveTo = new ObjectId(action.moveTo);
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
        // getMailboxAsync throws if mailbox is missing or wrong owner
        let mailboxData = false;

        if (action.moveTo) {
            mailboxData = await messageHandler.getMailboxAsync({ mailbox: action.moveTo });
        }

        if (action.delete && data.mailbox) {
            mailboxData = await messageHandler.getMailboxAsync({ mailbox: data.mailbox });
        }

        let updates = {};
        for (let key of ['seen', 'flagged']) {
            if (key in action) {
                updates[key] = action[key];
            }
        }

        let cursor = await db.database.collection('messages').find(filter);

        let messageData;

        if (!action.moveTo && !Object.keys(updates).length) {
            // nothing to do here
            return;
        }

        while ((messageData = await cursor.next())) {
            if (!messageData || messageData.user.toString() !== user.toString()) {
                continue;
            }

            if (action.moveTo && action.moveTo.toString() !== messageData.mailbox.toString()) {
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
            } else if (Object.keys(updates).length) {
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
            } else if (action.delete && ['\\Trash', '\\Junk', '\\Drafts'].includes(mailboxData.specialUse)) {
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
