'use strict';

const ObjectId = require('mongodb').ObjectId;
const db = require('../db');
const tools = require('../tools');
const consts = require('../consts');

async function copyHandler(server, messageHandler, connection, mailbox, update, session) {
    const socket = (session.socket && session.socket._parent) || session.socket;
    server.logger.debug(
        {
            tnx: 'copy',
            cid: session.id
        },
        '[%s] Copying messages from "%s" to "%s"',
        session.id,
        mailbox,
        update.destination
    );
    tools.checkSocket(socket);

    let userData = await db.users.collection('users').findOne(
        {
            _id: session.user.id
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_USERS
        }
    );

    if (!userData) {
        throw new Error('User not found');
    }

    if (userData.quota && userData.storageUsed > userData.quota) {
        return 'OVERQUOTA';
    }

    let mailboxData = await db.database.collection('mailboxes').findOne(
        {
            _id: mailbox
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    if (!mailboxData) {
        return 'NONEXISTENT';
    }

    let targetData = await db.database.collection('mailboxes').findOne(
        {
            user: session.user.id,
            path: update.destination
        },
        {
            maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
        }
    );

    if (!targetData) {
        return 'TRYCREATE';
    }

    let cursor = await db.database
        .collection('messages')
        .find({
            mailbox: mailboxData._id,
            uid: tools.checkRangeQuery(update.messages)
        }) // no projection as we need to copy the entire message
        .sort({ uid: 1 })
        .maxTimeMS(consts.DB_MAX_TIME_MESSAGES);

    let copiedMessages = 0;
    let copiedStorage = 0;

    let updateQuota = async () => {
        if (!copiedMessages) {
            return;
        }
        try {
            let r = await db.users.collection('users').findOneAndUpdate(
                {
                    _id: mailboxData.user
                },
                {
                    $inc: {
                        storageUsed: copiedStorage
                    }
                },
                {
                    returnDocument: 'after',
                    projection: {
                        storageUsed: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
            if (r && r.value) {
                server.loggelf({
                    short_message: '[QUOTA] +',
                    _mail_action: 'quota',
                    _user: mailboxData.user,
                    _inc: copiedStorage,
                    _copied_messages: copiedMessages,
                    _storage_used: r.value.storageUsed,
                    _mailbox: targetData._id,
                    _sess: session && session.id
                });
            }
        } catch (err) {
            // ignore
        }
    };

    let sourceUid = [];
    let destinationUid = [];

    let messageData;

    // COPY might take a long time to finish, so send unsolicited responses
    let notifyTimeout;

    let notifyLongRunning = () => {
        clearTimeout(notifyTimeout);
        notifyTimeout = setTimeout(() => {
            connection.send('* OK Still processing...');
            notifyLongRunning();
        }, consts.LONG_COMMAND_NOTIFY_TTL);
    };

    notifyLongRunning();

    let targetMailboxEncrypted = false;

    if (targetData.encryptMessages) {
        targetMailboxEncrypted = true;
    }

    try {
        while ((messageData = await cursor.next())) {
            tools.checkSocket(socket); // do we even have to copy anything?
            // this query points to current message
            let existingQuery = {
                mailbox: messageData.mailbox,
                uid: messageData.uid,
                _id: messageData._id
            };

            const parsedHeader = (messageData.mimeTree && messageData.mimeTree.parsedHeader) || {};
            const parsedContentType = parsedHeader['content-type'];

            const isMessageEncrypted = parsedContentType ? parsedContentType.subtype === 'encrypted' : false;

            // Copying is not done in bulk to minimize risk of going out of sync with incremental UIDs
            sourceUid.unshift(messageData.uid);
            let item = await db.database.collection('mailboxes').findOneAndUpdate(
                {
                    _id: targetData._id
                },
                {
                    $inc: {
                        uidNext: 1
                    }
                },
                {
                    projection: {
                        uidNext: true,
                        modifyIndex: true
                    },
                    returnDocument: 'before',
                    maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
                }
            );

            if (!item || !item.value) {
                // mailbox not found
                return 'TRYCREATE';
            }

            let uidNext = item.value.uidNext;
            let modifyIndex = item.value.modifyIndex;
            destinationUid.unshift(uidNext);

            messageData._id = new ObjectId();
            messageData.mailbox = targetData._id;
            messageData.uid = uidNext;

            // retention settings
            messageData.exp = !!targetData.retention;
            messageData.rdate = Date.now() + (targetData.retention || 0);
            messageData.modseq = modifyIndex; // reset message modseq to whatever it is for the mailbox right now

            if (!messageData.flags.includes('\\Deleted')) {
                messageData.searchable = true;
            } else {
                delete messageData.searchable;
            }

            let junk = false;
            if (targetData.specialUse === '\\Junk' && !messageData.junk) {
                messageData.junk = true;
                junk = 1;
            } else if (targetData.specialUse !== '\\Trash' && messageData.junk) {
                delete messageData.junk;
                junk = -1;
            }

            if (!messageData.meta) {
                messageData.meta = {};
            }

            if (!messageData.meta.events) {
                messageData.meta.events = [];
            }
            messageData.meta.events.push({
                action: 'IMAPCOPY',
                time: new Date()
            });

            await db.database.collection('messages').updateOne(
                existingQuery,
                {
                    $set: {
                        // indicate that we do not need to archive this message when deleted
                        copied: true
                    }
                },
                { writeConcern: 'majority' }
            );

            const newPrepared = await new Promise((resolve, reject) => {
                if (targetMailboxEncrypted && !isMessageEncrypted && userData.pubKey) {
                    // encrypt message
                    // get raw from existing mimetree
                    let outputStream = messageHandler.indexer.rebuild(messageData.mimeTree); // get raw rebuilder response obj (.value is the stream)

                    if (!outputStream || outputStream.type !== 'stream' || !outputStream.value) {
                        return reject(new Error('Cannot fetch message'));
                    }
                    outputStream = outputStream.value; // set stream to actual stream object (.value)

                    let chunks = [];
                    let chunklen = 0;
                    outputStream
                        .on('readable', () => {
                            let chunk;
                            while ((chunk = outputStream.read()) !== null) {
                                chunks.push(chunk);
                                chunklen += chunk.length;
                            }
                        })
                        .on('end', () => {
                            const raw = Buffer.concat(chunks, chunklen);
                            messageHandler.encryptMessages(userData.pubKey, raw, (err, res) => {
                                if (err) {
                                    return reject(err);
                                }

                                // encrypted rebuilt raw

                                if (res) {
                                    messageHandler.prepareMessage({ raw: res }, (err, prepared) => {
                                        if (err) {
                                            return reject(err);
                                        }
                                        // prepared new message structure from encrypted raw

                                        const maildata = messageHandler.indexer.getMaildata(prepared.mimeTree);

                                        // add attachments of encrypted messages
                                        if (maildata.attachments && maildata.attachments.length) {
                                            messageData.attachments = maildata.attachments;
                                            messageData.ha = maildata.attachments.some(a => !a.related);
                                        } else {
                                            messageData.ha = false;
                                        }

                                        // remove fields that may leak data in FE or DB
                                        delete messageData.text;
                                        delete messageData.html;
                                        messageData.intro = '';

                                        messageHandler.indexer.storeNodeBodies(maildata, prepared.mimeTree, err => {
                                            // store new attachments
                                            let cleanup = () => {
                                                let attachmentIds = Object.keys(prepared.mimeTree.attachmentMap || {}).map(
                                                    key => prepared.mimeTree.attachmentMap[key]
                                                );

                                                messageHandler.attachmentStorage.deleteMany(attachmentIds, maildata.magic);

                                                if (err) {
                                                    return reject(err);
                                                }
                                            };

                                            if (err) {
                                                return cleanup(err);
                                            }

                                            return resolve(prepared);
                                        });
                                    });
                                }
                            });
                        });
                } else {
                    resolve(false);
                }
            });

            // replace fields
            if (newPrepared) {
                messageData.mimeTree = newPrepared.mimeTree;
                messageData.size = newPrepared.size;
                messageData.bodystructure = newPrepared.bodystructure;
                messageData.envelope = newPrepared.envelope;
                messageData.headers = newPrepared.headers;
            }

            let r = await db.database.collection('messages').insertOne(messageData, { writeConcern: 'majority' });

            if (!r || !r.acknowledged) {
                continue;
            }

            copiedMessages++;
            copiedStorage += Number(messageData.size) || 0;

            let attachmentIds = Object.keys(messageData.mimeTree.attachmentMap || {}).map(key => messageData.mimeTree.attachmentMap[key]);

            if (attachmentIds.length) {
                try {
                    await messageHandler.attachmentStorage.updateMany(attachmentIds, 1, messageData.magic);
                } catch (err) {
                    // should we care about this error?
                }
            }

            let entry = {
                command: 'EXISTS',
                uid: messageData.uid,
                message: messageData._id,
                unseen: messageData.unseen,
                idate: messageData.idate,
                thread: messageData.thread
            };
            if (junk) {
                entry.junk = junk;
            }
            await new Promise(resolve => server.notifier.addEntries(targetData, entry, resolve));
        }
    } finally {
        clearTimeout(notifyTimeout);

        try {
            await cursor.close();
        } catch (err) {
            //ignore, might be already closed
        }
        await updateQuota();
    }

    server.notifier.fire(session.user.id, targetData.path);
    return [
        true,
        {
            uidValidity: targetData.uidValidity,
            sourceUid,
            destinationUid
        }
    ];
}

// COPY / UID COPY sequence mailbox
module.exports = (server, messageHandler) => (connection, mailbox, update, session, callback) => {
    copyHandler(server, messageHandler, connection, mailbox, update, session)
        .then(args => callback(null, ...[].concat(args || [])))
        .catch(err => callback(err));
};
