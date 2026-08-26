'use strict';

const imapTools = require('../imap-tools');

module.exports = {
    state: ['Authenticated', 'Selected'],

    handler(command, callback) {
        if (this._server.options.acl) {
            // personal namespace, the namespace for mailboxes of other users and the
            // shared namespace for mailboxes of shared accounts (team mailboxes)
            this.send(
                '* NAMESPACE (("" "/")) (("' + imapTools.OTHER_USERS_NAMESPACE_PREFIX + '/" "/")) (("' + imapTools.SHARED_NAMESPACE_PREFIX + '/" "/"))'
            );
        } else {
            // fixed structure
            this.send('* NAMESPACE (("" "/")) NIL NIL');
        }

        callback(null, {
            response: 'OK'
        });
    }
};
