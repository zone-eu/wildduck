'use strict';

const log = require('npmlog');
const consts = require('./consts');
const crypto = require('crypto');

class TaskHandler {
    constructor(options) {
        options = options || {};
        this.database = options.database;

        this.keepAliveTimers = new WeakMap();
    }

    async add(type, data, options) {
        options = options || {};

        let now = new Date();

        let notBefore = false;

        if (typeof options.wait === 'object') {
            notBefore = options.wait;
        } else if (typeof options.wait === 'number' && options.wait > 0) {
            notBefore = new Date(Date.now() + options.wait);
        }

        let insRes = await this.database.collection('tasks').insertOne({
            task: type,
            locked: notBefore ? true : false,
            lockedUntil: notBefore || now,
            created: now,
            status: notBefore ? 'delayed' : 'waiting',
            data
        });

        if (!insRes || !insRes.insertedId) {
            throw new Error('Failed to create task');
        }

        log.verbose('Tasks', 'Created task id=%s', insRes.insertedId);

        return insRes.insertedId;
    }

    async ensure(type, matchQuery, data, options) {
        options = options || {};

        let now = new Date();

        let notBefore = false;

        if (typeof options.wait === 'object') {
            notBefore = options.wait;
        } else if (typeof options.wait === 'number' && options.wait > 0) {
            notBefore = new Date(Date.now() + options.wait);
        }

        let query = { task: type };
        Object.keys(matchQuery).forEach(key => {
            query[`data.${key}`] = matchQuery[key];
        });

        let r = await this.database.collection('tasks').findOneAndUpdate(
            query,
            {
                $setOnInsert: {
                    task: type,
                    locked: notBefore ? true : false,
                    lockedUntil: notBefore || now,
                    created: now,
                    status: notBefore ? 'delayed' : 'waiting',
                    data
                },
                $set: {
                    updated: new Date()
                }
            },
            {
                upsert: true,
                returnDocument: 'after'
            }
        );

        if (!r || !r.value) {
            throw new Error('Failed to create task');
        }

        let existing = false;
        if (r && r.lastErrorObject && r.lastErrorObject.upserted) {
            log.verbose('Tasks', 'Created task id=%s', r.value._id);
        } else {
            existing = true;
            log.verbose('Tasks', 'Updated task id=%s', r.value._id);
        }

        return { existing, task: r.value._id };
    }

    keepAlive(task) {
        if (this.keepAliveTimers.has(task.lock)) {
            clearTimeout(this.keepAliveTimers.get(task.lock));
            this.keepAliveTimers.delete(task.lock);
        }
        let keepAliveTimer = setTimeout(() => {
            this.extend(task)
                .then(() => {
                    // set new timer
                    try {
                        if (this.keepAliveTimers.has(task.lock)) {
                            this.keepAlive(task);
                        }
                    } catch (err) {
                        log.error('Tasks', 'Failed processing %s [%s]. error=%s', task._id, task.lock.toString('hex'), err.message);
                    }
                })
                .catch(err => {
                    log.error('Tasks', 'Failed to extend %s [%s]. error=%s', task._id, task.lock.toString('hex'), err.message);
                    if (this.keepAliveTimers.has(task.lock)) {
                        clearTimeout(this.keepAliveTimers.get(task.lock));
                        this.keepAliveTimers.delete(task.lock);
                    }
                });
        }, consts.TASK_UPDATE_INTERVAL);
        keepAliveTimer.unref();
        this.keepAliveTimers.set(task.lock, keepAliveTimer);
    }

    async getNext() {
        let r;

        let lockId = crypto.randomBytes(12);
        r = await this.database.collection('tasks').findOneAndUpdate(
            {
                locked: false
            },
            {
                $set: {
                    locked: lockId,
                    lockedUntil: new Date(Date.now() + consts.TASK_LOCK_INTERVAL),
                    status: 'active',
                    runStart: new Date()
                },
                $inc: {
                    runCount: 1
                }
            },
            {
                returnDocument: 'after'
            }
        );

        if (!r || !r.value) {
            return { data: null, task: null };
        }

        let task = {
            type: r.value.task,
            _id: r.value._id,
            lock: lockId
        };

        // setup keep-alive timer
        this.keepAlive(task);

        log.verbose('Tasks', 'Found task for processing id=%s', r.value._id);

        return {
            // old tasks do not have a 'data' block
            data: 'data' in r.value ? r.value.data : r.value,
            task
        };
    }

    async release(task, completed) {
        if (this.keepAliveTimers.has(task.lock)) {
            clearTimeout(this.keepAliveTimers.get(task.lock));
            this.keepAliveTimers.delete(task.lock);
        }

        if (completed) {
            try {
                let r = await this.database.collection('tasks').deleteOne({
                    _id: task._id,
                    locked: task.lock
                });

                if (r && r.deletedCount) {
                    log.info('Tasks', 'Released task id=%s lock=%s', task._id, task.lock.toString('hex'));
                } else {
                    log.error('Tasks', 'Failed to release task id=%s lock=%s', task._id, task.lock.toString('hex'));
                }
            } catch (err) {
                log.error('Tasks', 'Failed to release task id=%s lock=%s error=%s', task._id, task.lock.toString('hex'), err.message);
            }
        } else {
            try {
                let r = await this.database.collection('tasks').updateOne(
                    {
                        _id: task._id,
                        locked: task.lock
                    },
                    {
                        $set: {
                            locked: false,
                            status: 'waiting'
                        }
                    }
                );

                if (r && r.modifiedCount) {
                    log.info('Tasks', 'Requeued task id=%s lock=%s', task._id, task.lock.toString('hex'));
                } else {
                    log.error('Tasks', 'Failed to requeue task id=%s lock=%s', task._id, task.lock.toString('hex'));
                }
            } catch (err) {
                log.error('Tasks', 'Failed to requeue task id=%s lock=%s error=%s', task._id, task.lock.toString('hex'), err.message);
            }
        }
    }

    async extend(task) {
        let r = await this.database.collection('tasks').updateOne(
            {
                _id: task._id,
                locked: task.lock
            },
            {
                $set: {
                    lockedUntil: new Date(Date.now() + consts.TASK_LOCK_INTERVAL),
                    status: 'processing',
                    extendTime: new Date()
                },
                $inc: { extendCount: 1 }
            }
        );

        if (!r || !r.modifiedCount) {
            throw new Error('Failed to extend task id=%s lock=%s error=No match found', task._id, task.lock.toString('hex'));
        }

        log.verbose('Tasks', 'Extended task id=%s lock=%s', task._id, task.lock.toString('hex'));

        return true;
    }

    async releasePending() {
        let r;
        try {
            r = await this.database.collection('tasks').updateMany(
                {
                    locked: { $ne: false },
                    lockedUntil: { $lt: new Date() }
                },
                {
                    $set: {
                        locked: false,
                        status: 'waiting'
                    }
                }
            );
            if (r.modifiedCount) {
                log.info('Tasks', 'Released %s pending tasks', r.modifiedCount);
            }
        } catch (err) {
            log.error('Tasks', 'Failed releasing expired tasks. error=%s', err.message);
        }
    }
}

module.exports = TaskHandler;
