'use strict';

const imapTools = require('../imap-tools');

module.exports = {
    state: 'Selected',

    handler(command, callback) {
        // Check if EXPUNGE method is set
        if (typeof this._server.onExpunge !== 'function') {
            return callback(null, {
                response: 'NO',
                message: 'EXPUNGE not implemented'
            });
        }

        // Just unselect if in read only mode or if a shared mailbox does not allow expunging
        if (this.selected.readOnly || !imapTools.checkAclRights(this.selected, imapTools.ACL_RIGHTS.EXPUNGE)) {
            this.session.selected = this.selected = false;
            this.state = 'Authenticated';
            return callback(null, {
                response: 'OK'
            });
        }

        let mailbox = this.selected.mailbox;

        this.session.selected = this.selected = false;
        this.state = 'Authenticated';

        this._server.onExpunge(
            mailbox,
            {
                isUid: false,
                silent: true
            },
            this.session,
            () => {
                // don't care if expunging succeeded, the mailbox is now closed anyway
                callback(null, {
                    response: 'OK'
                });
            }
        );
    }
};
