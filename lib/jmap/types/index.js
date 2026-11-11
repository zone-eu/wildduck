'use strict';

// The JMAP data types WildDuck implements. A capability appears in the session once a module with
// that capability is listed here.

const core = require('./core');
const mailbox = require('./mailbox');
const mailboxSet = require('./mailbox-set');
const thread = require('./thread');
const email = require('./email');
const emailChanges = require('./email-changes');
const emailQuery = require('./email-query');
const searchSnippet = require('./searchsnippet');
const identity = require('./identity');
const blobCopy = require('./blob-copy');
const emailImport = require('./email-import');
const emailParse = require('./email-parse');

const download = require('../routes/download');
const upload = require('../routes/upload');
const eventSource = require('../routes/eventsource');

module.exports = {
    modules: [core, mailbox, mailboxSet, thread, email, emailChanges, emailQuery, searchSnippet, identity, blobCopy, emailParse, emailImport],
    // extra routes (download, upload, eventsource): functions called with the app helpers
    routes: [download, upload, eventSource]
};
