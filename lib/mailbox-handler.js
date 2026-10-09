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

        const r = await this.database.collection('mailboxes').insertOne(mailboxData, { writeConcern: 'majority' });

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

        try {
            await this.notifier.addEntriesAsync(mailboxData, {
                command: 'CREATE',
                mailbox: r.insertedId,
                path
            });
        } catch {
            // the mailbox exists, only the journal entry is missing
        }
        this.notifier.fire(user);

        return {
            status: true,
            id: mailboxData._id
        };
    }

    rename(user, mailbox, newname, opts, callback) {
        this.renameAsync(user, mailbox, newname, opts).then(result => callback(null, result.status, result.mailbox, result.updateResult), callback);
    }

    /**
     * Renames a mailbox and its inferior mailboxes
     *
     * @returns {Promise<{status: Boolean, mailbox: ObjectId, updateResult: Object}>}
     */
    async renameAsync(user, mailbox, newname, opts) {
        const pathError = validateMailboxPath(newname);
        if (pathError) {
            throw pathError;
        }

        const mailboxData = await this.database.collection('mailboxes').findOne({
            _id: mailbox,
            user
        });

        if (!mailboxData) {
            const err = new Error('Mailbox update failed with code NoSuchMailbox');
            err.code = 'NONEXISTENT';
            err.responseCode = 404;
            throw err;
        }

        if (mailboxData.path === 'INBOX' || mailboxData.hidden) {
            const err = new Error('Mailbox update failed with code DisallowedMailboxMethod');
            err.code = 'CANNOT';
            err.responseCode = 400;
            throw err;
        }

        const existing = await this.database.collection('mailboxes').findOne({
            user: mailboxData.user,
            path: newname
        });

        if (existing) {
            const err = new Error('Mailbox rename failed with code MailboxAlreadyExists');
            err.code = 'ALREADYEXISTS';
            err.responseCode = 400;
            throw err;
        }

        // RFC 3501 6.3.5: inferior hierarchical names MUST be renamed as well
        const children = await this.resolveRenamedChildren(mailboxData, newname);
        const result = await this.renameMailboxEntry(mailboxData, newname, opts);
        await this.renameChildren(children);

        return result;
    }

    /**
     * Resolves the new path of every inferior mailbox of a mailbox that is about to be renamed and
     * verifies that none of them is invalid or already taken.
     *
     * @returns {Promise<Array>} `{ mailboxData, newname }` entries
     */
    async resolveRenamedChildren(mailboxData, newname) {
        const childList = await this.database
            .collection('mailboxes')
            .find({
                user: mailboxData.user,
                path: {
                    $regex: '^' + escapeRegexStr(mailboxData.path + '/')
                }
            })
            .toArray();

        const children = [];
        for (const child of childList || []) {
            const childPath = newname + child.path.substring(mailboxData.path.length);
            const pathError = validateMailboxPath(childPath);
            if (pathError) {
                throw pathError;
            }
            children.push({ mailboxData: child, newname: childPath });
        }

        if (!children.length) {
            return children;
        }

        const conflict = await this.database.collection('mailboxes').findOne({
            user: mailboxData.user,
            path: { $in: children.map(child => child.newname) }
        });

        if (conflict) {
            const err = new Error('Mailbox rename failed with code MailboxAlreadyExists');
            err.code = 'ALREADYEXISTS';
            err.responseCode = 400;
            throw err;
        }

        return children;
    }

    /**
     * Renames the already resolved inferior mailboxes. The parent has been renamed at this point, so a
     * failure here is reported in the log instead of failing the command.
     */
    async renameChildren(children) {
        for (const child of children) {
            try {
                await this.renameMailboxEntry(child.mailboxData, child.newname, false);
            } catch (err) {
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
        }
    }

    async renameMailboxEntry(mailboxData, newname, opts) {
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

        const item = await this.database.collection('mailboxes').findOneAndUpdate(
            {
                _id: mailbox
            },
            update,
            {
                returnDocument: 'after'
            }
        );

        if (!item || !item.value) {
            // was not able to acquire a lock
            const err = new Error('Mailbox update failed with code NoSuchMailbox');
            err.code = 'NONEXISTENT';
            err.responseCode = 404;
            throw err;
        }

        publish(this.redis, {
            ev: MAILBOX_RENAMED,
            user,
            mailbox,
            previous: mailboxData.path,
            current: newname
        }).catch(() => false);

        try {
            await this.notifier.addEntriesAsync(mailboxData, {
                command: 'RENAME',
                path: newname
            });
        } catch {
            // the mailbox is renamed, only the journal entry is missing
        }
        this.notifier.fire(mailboxData.user);

        return {
            status: true,
            mailbox,
            updateResult: {
                updated: true,
                mailbox: item.value,
                changes
            }
        };
    }

    /**
     * Deletes a mailbox. Does not immediately release quota as the messages get deleted after a while
     */
    del(user, mailbox, callback) {
        this.delAsync(user, mailbox).then(status => callback(null, status, mailbox), callback);
    }

    /**
     * Deletes a mailbox. Does not immediately release quota as the messages get deleted after a while
     *
     * @returns {Promise<Boolean>} true once the mailbox is deleted
     */
    async delAsync(user, mailbox) {
        const mailboxData = await this.database.collection('mailboxes').findOne({
            _id: mailbox,
            user
        });

        if (!mailboxData) {
            const err = new Error('Mailbox deletion failed with code NoSuchMailbox');
            err.code = 'NONEXISTENT';
            err.responseCode = 404;
            throw err;
        }

        if (mailboxData.specialUse || mailboxData.path === 'INBOX' || mailboxData.hidden) {
            const err = new Error('Mailbox deletion failed with code DisallowedMailboxMethod');
            err.code = 'CANNOT';
            err.responseCode = 400;
            throw err;
        }

        const r = await this.database.collection('mailboxes').deleteOne(
            {
                _id: mailbox
            },
            { writeConcern: 'majority' }
        );

        if (r.deletedCount) {
            publish(this.redis, {
                ev: MAILBOX_DELETED,
                user,
                mailbox,
                path: mailboxData.path
            }).catch(() => false);
        }

        await this.deleteMailboxFilters(user, mailbox);

        // send information about deleted mailbox straight to connected clients
        this.notifier.fire(mailboxData.user, {
            command: 'DROP',
            mailbox
        });

        try {
            await this.notifier.addEntriesAsync(mailboxData, {
                command: 'DELETE',
                mailbox
            });
        } catch {
            // the mailbox is deleted, only the journal entry is missing
        }

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
                writeConcern: 1
            }
        );

        this.notifier.fire(mailboxData.user);

        return true;
    }

    /**
     * Deletes the filters that move messages to a mailbox. Failures are logged, the mailbox is already gone
     */
    async deleteMailboxFilters(user, mailbox) {
        let filters;
        try {
            filters = await this.database
                .collection('filters')
                .find({
                    user,
                    'action.mailbox': mailbox
                })
                .toArray();
        } catch (err) {
            this.loggelf({
                user,
                mailbox,
                action: 'delete_filter',
                error: err.message
            });
            return;
        }

        for (let filterData of filters || []) {
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
    }

    update(user, mailbox, updates, callback) {
        this.updateAsync(user, mailbox, updates).then(result => callback(null, result.status, result.mailbox, result.updateResult), callback);
    }

    /**
     * Updates mailbox properties, a changed path renames the mailbox
     *
     * @returns {Promise<{status: Boolean, mailbox: ObjectId, updateResult: Object}>}
     */
    async updateAsync(user, mailbox, updates) {
        if (!updates) {
            return { status: false };
        }

        const mailboxData = await this.database.collection('mailboxes').findOne({
            _id: mailbox
        });

        if (!mailboxData) {
            const err = new Error('Mailbox update failed with code NoSuchMailbox');
            err.code = 'NONEXISTENT';
            err.responseCode = 404;
            throw err;
        }

        if (updates.path && updates.path !== mailboxData.path) {
            return await this.renameAsync(user, mailbox, updates.path, updates);
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
            return {
                status: true,
                mailbox,
                updateResult: {
                    updated: false,
                    mailbox: mailboxData,
                    changes
                }
            };
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

        const item = await this.database.collection('mailboxes').findOneAndUpdate(
            {
                _id: mailbox
            },
            update,
            {
                returnDocument: 'after'
            }
        );

        if (!item || !item.value) {
            const err = new Error('Mailbox update failed with code NoSuchMailbox');
            err.code = 'NONEXISTENT';
            err.responseCode = 404;
            throw err;
        }

        return {
            status: true,
            mailbox,
            updateResult: {
                updated: true,
                mailbox: item.value,
                changes
            }
        };
    }
}

module.exports = MailboxHandler;
