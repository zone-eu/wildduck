'use strict';

// The JMAP data types WildDuck implements. A capability appears in the session once a module with
// that capability is listed here.

const core = require('./core');
const mailbox = require('./mailbox');
const thread = require('./thread');
const email = require('./email');
const emailChanges = require('./email-changes');
const emailQuery = require('./email-query');
const searchSnippet = require('./searchsnippet');

module.exports = {
    modules: [core, mailbox, thread, email, emailChanges, emailQuery, searchSnippet],
    // extra routes (download, upload, eventsource): functions called with the app helpers
    routes: []
};
