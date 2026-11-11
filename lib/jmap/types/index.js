'use strict';

// The JMAP data types WildDuck implements. A capability appears in the session once a module with
// that capability is listed here.

const core = require('./core');

module.exports = {
    modules: [core],
    // extra routes (download, upload, eventsource): functions called with the app helpers
    routes: []
};
