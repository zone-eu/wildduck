'use strict';

const imapTools = require('../imap-tools');

module.exports = {
    state: ['Authenticated', 'Selected'],

    handler(command, callback) {
        if (this._server.options.acl) {
            // personal namespace and the shared namespace for mailboxes of other users
            this.send('* NAMESPACE (("" "/")) (("' + imapTools.SHARED_NAMESPACE_PREFIX + '/" "/")) NIL');
        } else {
            // fixed structure
            this.send('* NAMESPACE (("" "/")) NIL NIL');
        }

        callback(null, {
            response: 'OK'
        });
    }
};
