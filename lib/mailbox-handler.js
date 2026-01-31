'use strict';

const ObjectId = require('mongodb').ObjectId;
const ImapNotifier = require('./imap-notifier');
const { publish, MAILBOX_CREATED, MAILBOX_RENAMED, MAILBOX_DELETED } = require('./events');
const { SettingsHandler } = require('./settings-handler');
const { MAX_MAILBOX_NAME_LENGTH, MAX_SUB_MAILBOXES } = require('./consts');

class MailboxHandler {
    constructor(options) {
        this.database = options.database;
        this.users = options.users || options.database;
        this.redis = options.redis;

        this.loggelf = options.loggelf || (() => false);

        this.notifier =
            options.notifier ||
            new ImapNotifier({
                database: options.database,
                redis: this.redis,
                pushOnly: true
            });

        this.settingsHandler = new SettingsHandler({ db: this.database });

        // JMAP changelog helper
        try {
            const JmapChanges = require('./jmap-changes');
            this.jmapChanges = new JmapChanges(this.redis);
        } catch (E) {
            this.jmapChanges = null;
        }
    }

    create(user, path, opts, callback) {
        this.createAsync(user, path, opts)
            .then(mailboxData => callback(null, ...[mailboxData.status, mailboxData.id]))
            .catch(err => callback(err));
    }

    async createAsync(user, path, opts) {
        const userData = await this.users.collection('users').findOne({ _id: user }, { projection: { retention: true } });

        if (!userData) {
            const err = new Error('This user does not exist');
            err.code = 'UserNotFound';
            err.responseCode = 404;
            throw err;
        }

        const splittedPathArr = path.split('/');

        if (splittedPathArr.length > MAX_SUB_MAILBOXES) {
            // too many subpaths
            const err = new Error(`The mailbox path cannot be more than ${MAX_SUB_MAILBOXES} levels deep`);
            err.code = 'CANNOT';
            err.responseCode = 400;
            throw err;
        }

        for (const pathPart of splittedPathArr) {
            if (pathPart.length > MAX_MAILBOX_NAME_LENGTH) {
                // individual path part longer than specified max
                const err = new Error(`Any part of the mailbox path cannot be longer than ${MAX_MAILBOX_NAME_LENGTH} chars`);
                err.code = 'CANNOT';
                err.responseCode = 400;
                throw err;
            }
        }

        let mailboxData = await this.database.collection('mailboxes').findOne({ user, path });

        if (mailboxData) {
            const err = new Error('Mailbox creation failed with code MailboxAlreadyExists');
            err.code = 'ALREADYEXISTS';
            err.responseCode = 400;
            throw err;
        }

        const mailboxCountForUser = await this.database.collection('mailboxes').countDocuments({ user });

        if (mailboxCountForUser > (await this.settingsHandler.get('const:max:mailboxes'))) {
            const err = new Error('Mailbox creation failed with code ReachedMailboxCountLimit. Max mailboxes count reached.');
            err.code = 'CANNOT';
            err.responseCode = 400;
            throw err;
        }

        mailboxData = {
            _id: new ObjectId(),
            user,
            path,
            uidValidity: Math.floor(Date.now() / 1000),
            uidNext: 1,
            modifyIndex: 0,
            subscribed: true,
            flags: [],
            retention: userData.retention
        };

        Object.keys(opts || {}).forEach(key => {
            if (!['_id', 'user', 'path'].includes(key)) {
                mailboxData[key] = opts[key];
            }
        });

        const r = this.database.collection('mailboxes').insertOne(mailboxData, { writeConcern: 'majority' });

        try {
            await publish(this.redis, {
                ev: MAILBOX_CREATED,
                user,
                mailbox: r.insertedId,
                path: mailboxData.path
            });
        } catch {
            // ignore
        }

        await this.notifier.addEntries(
            mailboxData,
            {
                command: 'CREATE',
                mailbox: r.insertedId,
                path
            },
            () => {
                this.notifier.fire(user);
                return;
            }
        );

        return {
            status: true,
            id: mailboxData._id
        };
    }

    rename(user, mailbox, newname, opts, callback) {
        this.database.collection('mailboxes').findOne(
            {
                _id: mailbox,
                user
            },
            (err, mailboxData) => {
                if (err) {
                    return callback(err);
                }

                const splittedPathArr = newname.split('/');

                if (splittedPathArr.length > MAX_SUB_MAILBOXES) {
                    // too many subpaths
                    const err = new Error(`The mailbox path cannot be more than ${MAX_SUB_MAILBOXES} levels deep`);
                    err.code = 'CANNOT';
                    err.responseCode = 400;
                    return callback(err, 'CANNOT');
                }

                for (const pathPart of splittedPathArr) {
                    if (pathPart.length > MAX_MAILBOX_NAME_LENGTH) {
                        // individual path part longer than specified max
                        const err = new Error(`Any part of the mailbox path cannot be longer than ${MAX_MAILBOX_NAME_LENGTH} chars`);
                        err.code = 'CANNOT';
                        err.responseCode = 400;
                        return callback(err, 'CANNOT');
                    }
                }

                if (!mailboxData) {
                    const err = new Error('Mailbox update failed with code NoSuchMailbox');
                    err.code = 'NONEXISTENT';
                    err.responseCode = 404;
                    return callback(err, 'NONEXISTENT');
                }
                if (mailboxData.path === 'INBOX' || mailboxData.hidden) {
                    const err = new Error('Mailbox update failed with code DisallowedMailboxMethod');
                    err.code = 'CANNOT';
                    err.responseCode = 400;
                    return callback(err, 'CANNOT');
                }
                this.database.collection('mailboxes').findOne(
                    {
                        user: mailboxData.user,
                        path: newname
                    },
                    (err, existing) => {
                        if (err) {
                            return callback(err);
                        }
                        if (existing) {
                            const err = new Error('Mailbox rename failed with code MailboxAlreadyExists');
                            err.code = 'ALREADYEXISTS';
                            err.responseCode = 400;
                            return callback(err, 'ALREADYEXISTS');
                        }

                        let $set = { path: newname };

                        Object.keys(opts || {}).forEach(key => {
                            if (!['_id', 'user', 'path'].includes(key)) {
                                $set[key] = opts[key];
                            }
                        });

                        this.database.collection('mailboxes').findOneAndUpdate(
                            {
                                _id: mailbox
                            },
                            {
                                $set
                            },
                            {},
                            (err, item) => {
                                if (err) {
                                    return callback(err);
                                }

                                if (!item || !item.value) {
                                    // was not able to acquire a lock
                                    const err = new Error('Mailbox update failed with code NoSuchMailbox');
                                    err.code = 'NONEXISTENT';
                                    err.responseCode = 404;
                                    return callback(err, 'NONEXISTENT');
                                }

                                publish(this.redis, {
                                    ev: MAILBOX_RENAMED,
                                    user,
                                    mailbox,
                                    previous: mailboxData.path,
                                    current: newname
                                }).catch(() => false);

                                this.notifier.addEntries(
                                    mailboxData,
                                    {
                                        command: 'RENAME',
                                        path: newname
                                    },
                                    async () => {
                                        // append updated changelog entries for messages in this mailbox (best-effort)
                                        try {
                                            if (this.jmapChanges) {
                                                const cursor = this.database.collection('messages').find({ mailbox }, { projection: { _id: 1 } });
                                                while (await cursor.hasNext()) {
                                                    const doc = await cursor.next();
                                                    try {
                                                        await this.jmapChanges.appendChange(mailboxData.user, { type: 'updated', id: doc._id.toString() });
                                                    } catch (E) {
                                                        // ignore per-entry errors
                                                    }
                                                }
                                            }
                                        } catch (E) {
                                            // ignore changelog errors
                                        }

                                        this.notifier.fire(mailboxData.user);
                                        return callback(null, true, mailbox);
                                    }
                                );
                            }
                        );
                    }
                );
            }
        );
    }

    /**
     * Deletes a mailbox. Does not immediately release quota as the messages get deleted after a while
     */
    del(user, mailbox, callback) {
        this.database.collection('mailboxes').findOne(
            {
                _id: mailbox,
                user
            },
            (err, mailboxData) => {
                if (err) {
                    return callback(err);
                }
                if (!mailboxData) {
                    const err = new Error('Mailbox deletion failed with code NoSuchMailbox');
                    err.code = 'NONEXISTENT';
                    err.responseCode = 404;
                    return callback(err, 'NONEXISTENT');
                }
                if (mailboxData.specialUse || mailboxData.path === 'INBOX' || mailboxData.hidden) {
                    const err = new Error('Mailbox deletion failed with code DisallowedMailboxMethod');
                    err.code = 'CANNOT';
                    err.responseCode = 400;
                    return callback(err, 'CANNOT');
                }

                this.database.collection('mailboxes').deleteOne(
                    {
                        _id: mailbox
                    },
                    { writeConcern: 'majority' },
                    (err, r) => {
                        if (err) {
                            return callback(err);
                        }

                        if (r.deletedCount) {
                            publish(this.redis, {
                                ev: MAILBOX_DELETED,
                                user,
                                mailbox,
                                path: mailboxData.path
                            }).catch(() => false);
                        }

                        let deleteFilters = async () => {
                            try {
                                let filters = await this.database
                                    .collection('filters')
                                    .find({
                                        user,
                                        'action.mailbox': mailbox
                                    })
                                    .toArray();
                                if (!filters) {
                                    return;
                                }
                                for (let filterData of filters) {
                                    // delete one by one for logging
                                    try {
                                        let r = await this.database.collection('filters').deleteOne({
                                            _id: filterData._id
                                        });
                                        if (r && r.deletedCount) {
                                            await publish(this.redis, {
                                                ev: `filter.deleted`,
                                                user,
                                                filter: filterData._id
                                            });
                                        }
                                    } catch (err) {
                                        this.loggelf({
                                            user,
                                            mailbox,
                                            action: 'delete_filter',
                                            filter: filterData._id,
                                            error: err.message
                                        });
                                    }
                                }
                            } catch (err) {
                                this.loggelf({
                                    user,
                                    mailbox,
                                    action: 'delete_filter',
                                    error: err.message
                                });
                            }
                        };

                        deleteFilters()
                            .then(() => {
                                // send information about deleted mailbox straight to connected clients
                                this.notifier.fire(mailboxData.user, {
                                    command: 'DROP',
                                    mailbox
                                });

                                this.notifier.addEntries(
                                    mailboxData,
                                    {
                                        command: 'DELETE',
                                        mailbox
                                    },
                                    () => {
                                        this.database.collection('messages').updateMany(
                                            {
                                                mailbox
                                            },
                                            {
                                                $set: {
                                                    exp: true,
                                                    // make sure the messages are in top of the expire queue
                                                    rdate: Date.now() - 24 * 3600 * 1000
                                                }
                                            },
                                            {
                                                multi: true,
                                                writeConcern: 1
                                            },
                                            async err => {
                                                if (err) {
                                                    return callback(err);
                                                }

                                                // Append destroyed changelog entries for messages in this mailbox (best-effort)
                                                try {
                                                    if (this.jmapChanges) {
                                                        const cursor = this.database.collection('messages').find({ mailbox }, { projection: { _id: 1 } });
                                                        while (await cursor.hasNext()) {
                                                            const doc = await cursor.next();
                                                            try {
                                                                await this.jmapChanges.appendChange(mailboxData.user, { type: 'destroyed', id: doc._id.toString() });
                                                            } catch (E) {
                                                                // ignore per-entry errors
                                                            }
                                                        }
                                                    }
                                                } catch (E) {
                                                    // ignore changelog errors
                                                }

                                                let done = () => {
                                                    this.notifier.fire(mailboxData.user);
                                                    callback(null, true, mailbox);
                                                };

                                                return done();
                                            }
                                        );
                                    }
                                );
                            })
                            .catch(() => false /* should not happen */);
                    }
                );
            }
        );
    }

    update(user, mailbox, updates, callback) {
        if (!updates) {
            return callback(null, false);
        }

        this.database.collection('mailboxes').findOne(
            {
                _id: mailbox
            },
            (err, mailboxData) => {
                if (err) {
                    return callback(err);
                }
                if (!mailboxData) {
                    const err = new Error('Mailbox update failed with code NoSuchMailbox');
                    err.code = 'NONEXISTENT';
                    err.responseCode = 404;
                    return callback(err, 'NONEXISTENT');
                }

                if (updates.path && updates.path !== mailboxData.path) {
                    return this.rename(user, mailbox, updates.path, updates, callback);
                }

                let $set = {};
                let hasChanges = false;

                Object.keys(updates || {}).forEach(key => {
                    if (!['_id', 'user', 'path'].includes(key)) {
                        $set[key] = updates[key];
                        hasChanges = true;
                    }
                });

                if (!hasChanges) {
                    return callback(null, true);
                }

                this.database.collection('mailboxes').findOneAndUpdate(
                    {
                        _id: mailbox
                    },
                    {
                        $set
                    },
                    {},
                    (err, item) => {
                        if (err) {
                            return callback(err);
                        }

                        if (!item || !item.value) {
                            const err = new Error('Mailbox update failed with code NoSuchMailbox');
                            err.code = 'NONEXISTENT';
                            err.responseCode = 404;
                            return callback(err, 'NONEXISTENT');
                        }

                        return callback(null, true);
                    }
                );
            }
        );
    }
}

module.exports = MailboxHandler;
