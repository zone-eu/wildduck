'use strict';

const imapHandler = require('../handler/imap-handler');
const imapTools = require('../imap-tools');

// tag GETACL "mailbox"

module.exports = {
    state: ['Authenticated', 'Selected'],

    schema: [
        {
            name: 'mailbox',
            type: 'string'
        }
    ],

    handler(command, callback) {
        let mailbox = Buffer.from((command.attributes[0] && command.attributes[0].value) || '', 'binary').toString();
        let path = imapTools.normalizeMailbox(mailbox, !this.acceptUTF8Enabled);

        if (typeof this._server.onGetACL !== 'function') {
            return callback(null, {
                response: 'NO',
                message: command.command + ' not implemented'
            });
        }

        if (!path) {
            return callback(new Error('Invalid mailbox argument for GETACL'));
        }

        let logdata = {
            short_message: '[GETACL]',
            _mail_action: 'getacl',
            _user: this.session.user.id.toString(),
            _path: path,
            _sess: this.id
        };

        this._server.onGetACL(path, this.session, (err, data) => {
            if (err) {
                logdata._error = err.message;
                logdata._code = err.code;
                logdata._response = err.response;
                this._server.loggelf(logdata);

                return callback(null, {
                    response: 'NO',
                    code: 'TEMPFAIL'
                });
            }

            if (typeof data === 'string') {
                return callback(null, {
                    response: 'NO',
                    code: data.toUpperCase()
                });
            }

            // * ACL "mailbox" identifier rights [identifier rights]*
            let attributes = [mailbox];
            for (let aclData of data.acl || []) {
                attributes.push(aclData.identifier);
                attributes.push(aclData.rights);
            }

            this.send(
                imapHandler.compiler({
                    tag: '*',
                    command: 'ACL',
                    attributes
                })
            );

            callback(null, {
                response: 'OK'
            });
        });
    }
};
