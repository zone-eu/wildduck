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
const emailCopy = require('./email-copy');
const vacation = require('./vacation');
const emailSet = require('./email-set');
const submission = require('./submission');

const download = require('../routes/download');
const upload = require('../routes/upload');
const eventSource = require('../routes/eventsource');

module.exports = {
    // submission comes before identity: the first module of a capability gives its account capability object
    modules: [
        core,
        mailbox,
        mailboxSet,
        thread,
        email,
        emailChanges,
        emailQuery,
        searchSnippet,
        submission,
        identity,
        blobCopy,
        emailParse,
        emailImport,
        emailCopy,
        vacation,
        emailSet
    ],
    // extra routes (download, upload, eventsource): functions called with the app helpers
    routes: [download, upload, eventSource]
};
