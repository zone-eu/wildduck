'use strict';

const config = require('wild-config');
const tools = require('./tools');
const consts = require('./consts');
const EventEmitter = require('events').EventEmitter;
const Redis = require('ioredis');
const log = require('npmlog');
const counters = require('./counters');
const { publish, MARKED_SPAM, MARKED_HAM } = require('./events');

class ImapNotifier extends EventEmitter {
    constructor(options) {
        super();

        this.database = options.database;
        this.publisher = options.redis || new Redis(tools.redisConfig(config.dbs.redis));
        this.counters = counters(this.publisher);

        this.logger = options.logger || {
            info: log.silly.bind(log, 'IMAP'),
            debug: log.silly.bind(log, 'IMAP'),
            error: log.error.bind(log, 'IMAP')
        };

        if (options.pushOnly) {
            // do not need to set up the following if we do not care about updates
            return;
        }

        this.connectionSessions = new WeakMap();

        // Subscriber needs its own client connection. This is relevant only in the context of IMAP
        this.subscriber = new Redis(tools.redisConfig(config.dbs.redis));

        this._listeners = new EventEmitter();
        this._listeners.setMaxListeners(0);

        let publishTimers = new Map();
        let scheduleDataEvent = ev => {
            let data;

            let fire = () => {
                clearTimeout(data.timeout);
                publishTimers.delete(ev);
                this._listeners.emit(ev);
            };

            if (publishTimers.has(ev)) {
                data = publishTimers.get(ev) || {};
                clearTimeout(data.timeout);
                data.count++;

                if (data.initial < Date.now() - 1000) {
                    // if the event has been held back already for a second, then fire immediately
                    return fire();
                }
            } else {
                // initialize new event object
                data = {
                    ev,
                    count: 1,
                    initial: Date.now(),
                    timeout: null
                };
            }

            data.timeout = setTimeout(() => {
                fire();
            }, 100);
            data.timeout.unref();

            if (!publishTimers.has(ev)) {
                publishTimers.set(ev, data);
            }
        };

        this.subscriber.on('message', (channel, message) => {
            if (channel === 'wd_events') {
                let data;
                // if e present at beginning, check if p also is present
                // if no p -> no json parse
                // if p -> json parse ONLY p
                // if e not in beginning but p is -> json parse whole

                let needFullParse = true;

                if (message.length === 32 && message[2] === 'e' && message[5] === '"' && message[6 + 24] === '"') {
                    // there is only e, no p -> no need for full parse
                    needFullParse = false;
                }

                if (!needFullParse) {
                    // get e and continue
                    data = { e: message.slice(6, 6 + 24) };
                } else {
                    // full parse
                    try {
                        data = JSON.parse(message);
                    } catch (E) {
                        return;
                    }
                }

                if (this._listeners._events[data.e]?.length > 0) {
                    // do not schedule or fire/emit empty events
                    if (data.e && !data.p) {
                        // events without payload are scheduled, these are notifications about changes in journal
                        scheduleDataEvent(data.e);
                    } else if (data.e) {
                        // events with payload are triggered immediately, these are actions for doing something
                        this._listeners.emit(data.e, data.p);
                    }
                }
            }
        });

        this.subscriber.subscribe('wd_events');
    }

    /**
     * Registers an event handler for userid events
     *
     * @param {Object} session
     * @param {Function} handler Function to run once there are new entries in the journal
     */
    addListener(session, handler) {
        this._listeners.addListener(session.user.id.toString(), handler);

        this.logger.debug('[%s] New journal listener for %s (%s)', session.id, session.user.id.toString(), session.user.username);
    }

    /**
     * Unregisters an event handler for path:user events
     *
     * @param {Object} session
     * @param {Function} handler Function to run once there are new entries in the journal
     */
    removeListener(session, handler) {
        this._listeners.removeListener(session.user.id.toString(), handler);

        this.logger.debug('[%s] Removed journal listener from %s (%s)', session.id, session.user.id.toString(), session.user.username);
    }

    /**
     * Stores multiple journal entries to db
     *
     * @param {String} mailbox Mailbox ID
     * @param {Array|Object} entries An array of entries to be journaled
     * @param {Function} callback Runs once the entry is either stored or an error occurred
     */
    addEntries(mailbox, entries, callback) {
        if (entries && !Array.isArray(entries)) {
            entries = [entries];
        } else if (!entries || !entries.length) {
            return callback(null, false);
        }

        // find list of message ids that need to be updated
        let updated = entries.filter(entry => !entry.modseq && entry.message).map(entry => entry.message);

        let getMailbox = next => {
            if (!mailbox) {
                return next(null, false);
            }

            let mailboxData;
            let mailboxQuery;

            if (mailbox._id) {
                // we were already provided a mailbox object
                mailboxQuery = {
                    _id: mailbox._id
                };
                mailboxData = mailbox;
            } else {
                mailboxQuery = {
                    _id: mailbox
                };
            }

            if (updated.length) {
                // provision new modseq value
                return this.database.collection('mailboxes').findOneAndUpdate(
                    mailboxQuery,
                    {
                        $inc: {
                            modifyIndex: 1
                        }
                    },
                    {
                        returnDocument: 'after'
                    },
                    (err, item) => {
                        if (err) {
                            return callback(err);
                        }

                        next(null, item && item.value);
                    }
                );
            }
            if (mailboxData) {
                return next(null, mailboxData);
            }
            this.database.collection('mailboxes').findOne(mailboxQuery, next);
        };

        // final action to push entries to journal
        let pushToJournal = async () => {
            for (let entry of entries) {
                if (entry.command === 'EXISTS' && entry.junk) {
                    await publish(this.publisher, {
                        ev: entry.junk > 0 ? MARKED_SPAM : MARKED_HAM,
                        user: entry.user.toString(),
                        mailbox: entry.mailbox.toString(),
                        message: entry.message.toString(),
                        id: entry.uid
                    });
                }
            }

            let r = await this.database.collection('journal').insertMany(entries, {
                writeConcern: 1,
                ordered: false
            });

            setImmediate(() => this.updateCounters(entries));

            return r.insertedCount;
        };

        getMailbox((err, mailboxData) => {
            if (err) {
                return callback(err);
            }

            if (!mailboxData) {
                let err = new Error('Selected mailbox does not exist');
                err.responseCode = 404;
                err.code = 'NoSuchMailbox';
                return callback(null, err);
            }

            let modseq = mailboxData.modifyIndex;
            let created = new Date();

            entries.forEach(entry => {
                entry.modseq = entry.modseq || modseq;
                entry.created = entry.created || created;
                entry.mailbox = entry.mailbox || mailboxData._id;
                entry.user = mailboxData.user;
            });

            if (updated.length) {
                this.logger.debug('Updating message collection %s %s entries', mailboxData._id, updated.length);
                this.database.collection('messages').updateMany(
                    {
                        _id: {
                            $in: updated
                        },
                        mailbox: mailboxData._id
                    },
                    {
                        // only update modseq if the new value is larger than old one
                        $max: {
                            modseq
                        }
                    },
                    err => {
                        if (err) {
                            this.logger.error('Error updating modseq for messages. %s', err.message);
                        }
                        pushToJournal()
                            .then(count => callback(null, count))
                            .catch(err => callback(err));
                    }
                );
            } else {
                pushToJournal()
                    .then(count => callback(null, count))
                    .catch(err => callback(err));
            }
        });
    }

    /**
     * Sends a notification that there are new updates in the selected mailbox
     *
     * @param {String} user User ID
     */
    fire(user, payload) {
        if (!user) {
            return;
        }
        setImmediate(() => {
            let data = JSON.stringify({
                e: user.toString(),
                p: payload
            });
            this.publisher.publish('wd_events', data);
        });
    }

    /**
     * Returns all entries from the journal that have higher than provided modification index
     *
     * @param {String} mailbox Mailbox ID
     * @param {Number} modifyIndex Last known modification id
     * @param {Function} callback Returns update entries as an array
     */
    getUpdates(mailbox, modifyIndex, callback) {
        modifyIndex = Number(modifyIndex) || 0;
        this.database
            .collection('journal')
            .find({
                mailbox: mailbox._id || mailbox,
                modseq: {
                    $gt: modifyIndex
                }
            })
            .toArray(callback);
    }

    updateCounters(entries) {
        if (!entries) {
            return;
        }
        let counters = new Map();
        (Array.isArray(entries) ? entries : [].concat(entries || [])).forEach(entry => {
            let m = entry.mailbox.toString();
            if (!counters.has(m)) {
                counters.set(m, { total: 0, unseen: 0, unseenChange: false });
            }

            switch (entry && entry.command) {
                case 'EXISTS':
                    counters.get(m).total += 1;
                    if (entry.unseen) {
                        counters.get(m).unseen += 1;
                    }
                    break;
                case 'EXPUNGE':
                    counters.get(m).total -= 1;
                    if (entry.unseen) {
                        counters.get(m).unseen -= 1;
                    }
                    break;
                case 'FETCH':
                    if (entry.unseen) {
                        // either increase or decrease
                        counters.get(m).unseen += typeof entry.unseen === 'number' ? entry.unseen : 1;
                    } else if (entry.unseenChange) {
                        // volatile change, just clear the cache
                        counters.get(m).unseenChange = true;
                    }
                    break;
            }
        });

        let pos = 0;
        let rows = Array.from(counters);
        let updateCounter = () => {
            if (pos >= rows.length) {
                return;
            }
            let row = rows[pos++];
            if (!row || !row.length) {
                return updateCounter();
            }
            let mailbox = row[0];
            let delta = row[1];

            this.counters.cachedcounter('total:' + mailbox, delta.total, consts.MAILBOX_COUNTER_TTL, () => {
                if (delta.unseenChange) {
                    // Message info changed in mailbox, so just te be sure, clear the unseen counter as well
                    // Unseen counter is more volatile and also easier to count (usually only a small number on indexed messages)
                    this.publisher.del('unseen:' + mailbox, updateCounter);
                } else if (delta.unseen) {
                    this.counters.cachedcounter('unseen:' + mailbox, delta.unseen, consts.MAILBOX_COUNTER_TTL, updateCounter);
                } else {
                    setImmediate(updateCounter);
                }
            });
        };

        updateCounter();
    }

    allocateConnection(data, callback) {
        if (!data || !data.session || this.connectionSessions.has(data.session)) {
            return callback(null, true);
        }

        let rlkey = 'lim:' + data.service;
        const { closed: socketClosed, connecting, destroyed } = data.session?.socket || {};

        if (!socketClosed && !connecting && !destroyed) {
            // socket alive, not closed
            this.counters.limitedcounter(rlkey, data.user, 1, data.limit || 15, (err, res) => {
                if (err) {
                    return callback(err);
                }

                if (!res.success) {
                    return callback(null, false);
                }

                this.connectionSessions.set(data.session, { service: data.service, user: data.user });

                return callback(null, true);
            });
        } else {
            // socket dead/closed/undefined
            const err = new Error('[ALERT] Socket closed unexpectedly before authentication completed.');
            err.response = 'NO';
            return callback(err, false);
        }
    }

    releaseConnection(data, callback) {
        // unauthenticated sessions are unknown
        if (!data || !data.session || !this.connectionSessions.has(data.session)) {
            return callback(null, true);
        }

        let entry = this.connectionSessions.get(data.session);
        this.connectionSessions.delete(data.session);

        let rlkey = 'lim:' + entry.service;
        this.counters.limitedcounter(rlkey, entry.user, -1, 0, err => {
            if (err) {
                this.logger.debug('[%s] Failed to release connection for user %s. %s', data.session.id, entry.user, err.message);
            }
            return callback(null, true);
        });
    }
}

module.exports = ImapNotifier;
