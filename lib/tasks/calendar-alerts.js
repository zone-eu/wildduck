'use strict';

// Task calendar-alerts: the events of a calendar that use its default alerts get their next alert time
// again after the default alerts changed (queued by JMAP Calendar/set, lib/calendar/alerts.js).

const log = require('npmlog');
const db = require('../db');
const alerts = require('../calendar/alerts');

const run = async (task, data, options, database = db.database) => {
    const passes = await alerts.runReschedule({ database }, data.user, data.calendar);
    log.verbose('Tasks', 'task=calendar-alerts id=%s user=%s calendar=%s passes=%s', task._id, data.user, data.calendar, passes);
    return { passes };
};

module.exports = (task, data, options, callback) => {
    run(task, data, options)
        .then(result => callback(null, result))
        .catch(err => {
            log.error('Tasks', 'task=calendar-alerts id=%s user=%s calendar=%s error=%s', task._id, data.user, data.calendar, err.message);
            callback(err);
        });
};

module.exports.run = run;
