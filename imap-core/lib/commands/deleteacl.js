'use strict';

const imapTools = require('../imap-tools');

// tag DELETEACL "mailbox" "identifier"

module.exports = {
    state: ['Authenticated', 'Selected'],

    schema: [
        {
            name: 'mailbox',
            type: 'string'
        },
        {
            name: 'identifier',
            type: 'string'
        }
    ],

    handler(command, callback) {
        let path = Buffer.from((command.attributes[0] && command.attributes[0].value) || '', 'binary').toString();
        path = imapTools.normalizeMailbox(path, !this.acceptUTF8Enabled);

        let identifier = Buffer.from((command.attributes[1] && command.attributes[1].value) || '', 'binary').toString();

        if (typeof this._server.onDeleteACL !== 'function') {
            return callback(null, {
                response: 'NO',
                message: command.command + ' not implemented'
            });
        }

        if (!path || !identifier) {
            return callback(new Error('Invalid arguments for DELETEACL'));
        }

        let logdata = {
            short_message: '[DELETEACL]',
            _mail_action: 'deleteacl',
            _user: this.session.user.id.toString(),
            _path: path,
            _identifier: identifier,
            _sess: this.id
        };

        this._server.onDeleteACL(
            path,
            {
                identifier
            },
            this.session,
            (err, success) => {
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

                callback(null, {
                    response: success === true ? 'OK' : 'NO',
                    code: typeof success === 'string' ? success.toUpperCase() : false
                });
            }
        );
    }
};
