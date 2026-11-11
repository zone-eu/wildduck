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
const blob = require('./blob');
const quota = require('./quota');
const emailImport = require('./email-import');
const emailParse = require('./email-parse');
const emailCopy = require('./email-copy');
const vacation = require('./vacation');
const emailSet = require('./email-set');
const submission = require('./submission');
const pushSubscription = require('./pushsubscription');
const calendar = require('./calendar');
const participantIdentity = require('./participant-identity');
const addressBook = require('./addressbook');
const contactCard = require('./contactcard');
const contactCardQuery = require('./contactcard-query');

const download = require('../routes/download');
const upload = require('../routes/upload');
const eventSource = require('../routes/eventsource');

module.exports = {
    // at most one module of a capability declares its account capability object (checked by the registry)
    modules: [
        core,
        pushSubscription,
        mailbox,
        mailboxSet,
        thread,
        email,
        emailChanges,
        emailQuery,
        searchSnippet,
        identity,
        submission,
        blobCopy,
        blob,
        quota,
        emailParse,
        emailImport,
        emailCopy,
        vacation,
        emailSet,
        calendar,
        participantIdentity,
        addressBook,
        contactCard,
        contactCardQuery
    ],
    // extra routes (download, upload, eventsource): functions called with the app helpers
    routes: [download, upload, eventSource]
};
