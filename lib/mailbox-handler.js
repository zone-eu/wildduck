'use strict';

const ObjectId = require('mongodb').ObjectId;
const ImapNotifier = require('./imap-notifier');
const { publish, MAILBOX_CREATED, MAILBOX_RENAMED, MAILBOX_DELETED } = require('./events');
const { SettingsHandler } = require('./settings-handler');
const { MAX_MAILBOX_NAME_LENGTH, MAX_SUB_MAILBOXES } = require('./consts');
const { escapeRegexStr } = require('./tools');

function validateMailboxPath(path) {
    const parts = path.split('/');

    if (parts.length > MAX_SUB_MAILBOXES) {
        const err = new Error(`The mailbox path cannot be more than ${MAX_SUB_MAILBOXES} levels deep`);
        err.code = 'CANNOT';
        err.responseCode = 400;
        return err;
    }

    for (const pathPart of parts) {
        if (pathPart.length > MAX_MAILBOX_NAME_LENGTH) {
            const err = new Error(`Any part of the mailbox path cannot be longer than ${MAX_MAILBOX_NAME_LENGTH} chars`);
            err.code = 'CANNOT';
            err.responseCode = 400;
            return err;
        }
    }

    return false;
}

class MailboxHandler {
    constructor(options) {
        this.database = options.database;
        this.users = options.users || options.database;
        this.redis = options.redis;
        this.settingsHandler = options.settingsHandler || new SettingsHandler({ db: this.database });

        this.loggelf = options.loggelf || (() => false);

        this.notifier =
            options.notifier ||
            new ImapNotifier({
                database: options.database,
                redis: this.redis,
                settingsHandler: this.settingsHandler,
                pushOnly: true
            });
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
            modifyIndex: 1,
            subscribed: true,
            flags: [],
            retention: userData.retention,
            retentionCounter: 0
        };

        Object.keys(opts || {}).forEach(key => {
            if (!['_id', 'user', 'path'].includes(key)) {
                mailboxData[key] = opts[key];
            }
        });

        const r = await this.database.collection('mailboxes').insertOne(mailboxData, { writeConcern: { w: 'majority' } });

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

    async rename(user, mailbox, newname, opts, callback) {
        let mailboxData;
        try {
            mailboxData = await this.database.collection('mailboxes').findOne({
                _id: mailbox,
                user
            });
        } catch (err) {
            return callback(err);
        }

        const pathError = validateMailboxPath(newname);
        if (pathError) {
            return callback(pathError, 'CANNOT');
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
        let existing;
        try {
            existing = await this.database.collection('mailboxes').findOne({
                user: mailboxData.user,
                path: newname
            });
        } catch (err) {
            return callback(err);
        }

        if (existing) {
            const err = new Error('Mailbox rename failed with code MailboxAlreadyExists');
            err.code = 'ALREADYEXISTS';
            err.responseCode = 400;
            return callback(err, 'ALREADYEXISTS');
        }

        // RFC 3501 6.3.5: inferior hierarchical names MUST be renamed as well
        this.resolveRenamedChildren(mailboxData, newname, (err, children) => {
            if (err) {
                return callback(err, err.code);
            }

            this.renameMailboxEntry(mailboxData, newname, opts, (err, status, mailboxId, info) => {
                if (err) {
                    return callback(err, status);
                }

                this.renameChildren(children, () => callback(null, status, mailboxId, info));
            });
        });
    }

    /**
     * Resolves the new path of every inferior mailbox of a mailbox that is about to be renamed and
     * verifies that none of them is invalid or already taken.
     */
    async resolveRenamedChildren(mailboxData, newname, callback) {
        let childList;
        try {
            childList = await this.database
                .collection('mailboxes')
                .find({
                    user: mailboxData.user,
                    path: {
                        $regex: '^' + escapeRegexStr(mailboxData.path + '/')
                    }
                })
                .toArray();
        } catch (err) {
            return callback(err);
        }

        const children = [];
        for (const child of childList || []) {
            const childPath = newname + child.path.substring(mailboxData.path.length);
            const pathError = validateMailboxPath(childPath);
            if (pathError) {
                return callback(pathError);
            }
            children.push({ mailboxData: child, newname: childPath });
        }

        if (!children.length) {
            return callback(null, children);
        }

        let conflict;
        try {
            conflict = await this.database.collection('mailboxes').findOne({
                user: mailboxData.user,
                path: { $in: children.map(child => child.newname) }
            });
        } catch (err) {
            return callback(err);
        }

        if (conflict) {
            const err = new Error('Mailbox rename failed with code MailboxAlreadyExists');
            err.code = 'ALREADYEXISTS';
            err.responseCode = 400;
            return callback(err);
        }

        callback(null, children);
    }

    /**
     * Renames the already resolved inferior mailboxes. The parent has been renamed at this point, so a
     * failure here is reported in the log instead of failing the command.
     */
    renameChildren(children, callback) {
        let pos = 0;
        const renameNext = () => {
            if (pos >= children.length) {
                return callback();
            }

            const child = children[pos++];
            this.renameMailboxEntry(child.mailboxData, child.newname, false, err => {
                if (err) {
                    this.loggelf({
                        short_message: '[RENAMEFAIL] Failed to rename an inferior mailbox',
                        _mail_action: 'rename_child',
                        _user: child.mailboxData.user.toString(),
                        _mailbox: child.mailboxData._id.toString(),
                        _path: child.mailboxData.path,
                        _destination: child.newname,
                        _error: err.message,
                        _code: err.code
                    });
                }
                setImmediate(renameNext);
            });
        };
        renameNext();
    }

    async renameMailboxEntry(mailboxData, newname, opts, callback) {
        const mailbox = mailboxData._id;
        const user = mailboxData.user;
        const $set = { path: newname };
        const $inc = {};
        const changes = {};

        Object.keys(opts || {}).forEach(key => {
            if (!['_id', 'user', 'path'].includes(key)) {
                if (mailboxData[key] !== opts[key]) {
                    $set[key] = opts[key];
                    changes[key] = true;
                }
            }
        });

        if (changes.retention) {
            $inc.retentionCounter = 1;
        }

        const update = {
            $set
        };

        if ($inc.retentionCounter) {
            update.$inc = $inc;
        }

        let item;
        try {
            item = await this.database.collection('mailboxes').findOneAndUpdate(
                {
                    _id: mailbox
                },
                update,
                { includeResultMetadata: true, returnDocument: 'after' }
            );
        } catch (err) {
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
            () => {
                this.notifier.fire(mailboxData.user);
                return callback(null, true, mailbox, {
                    updated: true,
                    mailbox: item.value,
                    changes
                });
            }
        );
    }

    /**
     * Deletes a mailbox. Does not immediately release quota as the messages get deleted after a while
     */
    async del(user, mailbox, callback) {
        let mailboxData;
        try {
            mailboxData = await this.database.collection('mailboxes').findOne({
                _id: mailbox,
                user
            });
        } catch (err) {
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

        let r;
        try {
            r = await this.database.collection('mailboxes').deleteOne(
                {
                    _id: mailbox
                },
                { writeConcern: { w: 'majority' } }
            );
        } catch (err) {
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
                    async () => {
                        try {
                            await this.database.collection('messages').updateMany(
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
                                    writeConcern: { w: 1 }
                                }
                            );
                        } catch (err) {
                            return callback(err);
                        }

                        let done = () => {
                            this.notifier.fire(mailboxData.user);
                            callback(null, true, mailbox);
                        };

                        return done();
                    }
                );
            })
            .catch(() => false /* should not happen */);
    }

    async update(user, mailbox, updates, callback) {
        if (!updates) {
            return callback(null, false);
        }

        let mailboxData;
        try {
            mailboxData = await this.database.collection('mailboxes').findOne({
                _id: mailbox
            });
        } catch (err) {
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

        const $set = {};
        const $inc = {};
        const changes = {};
        let hasChanges = false;

        Object.keys(updates || {}).forEach(key => {
            if (!['_id', 'user', 'path'].includes(key)) {
                if (mailboxData[key] !== updates[key]) {
                    $set[key] = updates[key];
                    changes[key] = true;
                    hasChanges = true;
                }
            }
        });

        if (!hasChanges) {
            return callback(null, true, mailbox, {
                updated: false,
                mailbox: mailboxData,
                changes
            });
        }

        if (changes.retention) {
            $inc.retentionCounter = 1;
        }

        const update = {
            $set
        };

        if ($inc.retentionCounter) {
            update.$inc = $inc;
        }

        let item;
        try {
            item = await this.database.collection('mailboxes').findOneAndUpdate(
                {
                    _id: mailbox
                },
                update,
                { includeResultMetadata: true, returnDocument: 'after' }
            );
        } catch (err) {
            return callback(err);
        }

        if (!item || !item.value) {
            const err = new Error('Mailbox update failed with code NoSuchMailbox');
            err.code = 'NONEXISTENT';
            err.responseCode = 404;
            return callback(err, 'NONEXISTENT');
        }

        return callback(null, true, mailbox, {
            updated: true,
            mailbox: item.value,
            changes
        });
    }
}

module.exports = MailboxHandler;
