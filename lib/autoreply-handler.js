'use strict';

// Writes of a user's vacation autoreply, shared by the REST API (lib/api/autoreply.js) and JMAP
// VacationResponse/set: the autoreplies document delivery reads (lib/filter-handler.js, lib/autoreply.js),
// the users.autoreply flag delivery checks first, the enabled/disabled events, the audit log line, and
// the JMAP VacationResponse state, which moves and is pushed with every change.

const { publish, AUTOREPLY_USER_DISABLED, AUTOREPLY_USER_ENABLED } = require('./events');
const { syncVacation } = require('./jmap/vacation-sync');
const consts = require('./consts');

// fields of the autoreplies document
const FIELDS = ['status', 'name', 'subject', 'text', 'html', 'start', 'end'];

class AutoreplyHandler {
    /**
     * @param {Object} options
     * @param {Db} options.database
     * @param {Db} [options.users] defaults to database
     * @param {Redis} options.redis
     * @param {ImapNotifier} [options.notifier] tells open JMAP event streams about the new VacationResponse state
     * @param {Function} [options.loggelf]
     */
    constructor(options) {
        this.database = options.database;
        this.users = options.users || options.database;
        this.redis = options.redis;
        this.notifier = options.notifier;
        this.loggelf = options.loggelf || (() => false);
    }

    /**
     * Creates or updates the autoreply of a user, as PUT /users/:user/autoreply does.
     *
     * @param {ObjectId} user
     * @param {Object} values {status, name, subject, text, html, start, end}, only the given ones are changed
     * @param {Object} [meta] {sess, ip} for the audit log
     * @returns {Promise<Object>} the stored autoreply document
     * @throws {Error} code UserNotFound
     */
    async set(user, values, meta = {}) {
        const users = this.users.collection('users');
        if (typeof values.status === 'boolean') {
            // delivery reads the autoreply only when the user's flag is set
            const r = await users.updateOne({ _id: user }, { $set: { autoreply: values.status } }, { maxTimeMS: consts.DB_MAX_TIME_USERS });
            if (!r.matchedCount) {
                throw userNotFound();
            }
            if (r.modifiedCount) {
                await publish(this.redis, { ev: values.status ? AUTOREPLY_USER_ENABLED : AUTOREPLY_USER_DISABLED, user });
            }
        } else if (!(await users.findOne({ _id: user }, { projection: { _id: true }, maxTimeMS: consts.DB_MAX_TIME_USERS }))) {
            throw userNotFound();
        }

        const update = { user };
        for (const field of FIELDS) {
            if (values[field] !== undefined) {
                update[field] = values[field];
            }
        }
        const created = new Date();
        created.setMilliseconds(0);
        update.created = created.toISOString();

        const result = await this.database
            .collection('autoreplies')
            .findOneAndUpdate(
                { user },
                { $set: update },
                { returnDocument: 'after', upsert: true, includeResultMetadata: true, maxTimeMS: consts.DB_MAX_TIME_USERS }
            );
        const doc = result.value;
        const action = result.lastErrorObject && result.lastErrorObject.upserted ? 'create' : 'update';

        this.loggelf({
            short_message: `[AUTOREPLY] ${action}`,
            _mail_action: `${action === 'create' ? 'Create' : 'Update'} autoreply`,
            _user: user,
            _autoreply_id: doc && doc._id.toString(),
            _autoreply_status: doc && doc.status,
            _autoreply_name: doc && doc.name,
            _autoreply_subject: doc && doc.subject,
            _autoreply_start: doc && doc.start,
            _autoreply_end: doc && doc.end,
            _autoreply_created: doc && doc.created,
            _sess: meta.sess,
            _ip: meta.ip
        });

        await this.syncJmap(user);
        return doc;
    }

    /**
     * Deletes the autoreply of a user, as DELETE /users/:user/autoreply does.
     *
     * @param {ObjectId} user
     * @param {Object} [meta] {sess, ip} for the audit log
     * @returns {Promise<Object|null>} the deleted document ({_id}) or null when there was none
     */
    async delete(user, meta = {}) {
        const r = await this.users.collection('users').updateOne({ _id: user }, { $set: { autoreply: false } }, { maxTimeMS: consts.DB_MAX_TIME_USERS });
        if (r.modifiedCount) {
            await publish(this.redis, { ev: AUTOREPLY_USER_DISABLED, user });
        }

        const doc = await this.database
            .collection('autoreplies')
            .findOneAndDelete({ user }, { projection: { _id: true }, maxTimeMS: consts.DB_MAX_TIME_USERS });

        this.loggelf({
            short_message: '[AUTOREPLY] Delete',
            _mail_action: 'Delete autoreply',
            _user: user,
            _autoreply_id: doc && doc._id.toString(),
            _sess: meta.sess,
            _ip: meta.ip
        });

        await this.syncJmap(user);
        return doc;
    }

    // the JMAP VacationResponse state follows every change; never fails the write
    syncJmap(user) {
        return syncVacation({ database: this.database, notifier: this.notifier }, user);
    }
}

function userNotFound() {
    const err = new Error('Unknown user');
    err.responseCode = 404;
    err.code = 'UserNotFound';
    return err;
}

module.exports = AutoreplyHandler;
