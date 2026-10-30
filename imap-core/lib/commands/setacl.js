'use strict';

const imapTools = require('../imap-tools');

// tag SETACL "mailbox" "identifier" "rights"

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
        },
        {
            name: 'rights',
            type: 'string'
        }
    ],

    handler(command, callback) {
        let path = Buffer.from((command.attributes[0] && command.attributes[0].value) || '', 'binary').toString();
        path = imapTools.normalizeMailbox(path, !this.acceptUTF8Enabled);

        let identifier = Buffer.from((command.attributes[1] && command.attributes[1].value) || '', 'binary').toString();
        let rights = ((command.attributes[2] && command.attributes[2].value) || '').toString();

        if (typeof this._server.onSetACL !== 'function') {
            return callback(null, {
                response: 'NO',
                message: command.command + ' not implemented'
            });
        }

        if (!path || !identifier) {
            return callback(new Error('Invalid arguments for SETACL'));
        }

        if (!/^[+-]?[lrswipkxteacd]*$/.test(rights)) {
            // RFC 4314: uppercase rights are not allowed
            return callback(new Error('Invalid rights argument for SETACL'));
        }

        let logdata = {
            short_message: '[SETACL]',
            _mail_action: 'setacl',
            _user: this.session.user.id.toString(),
            _path: path,
            _identifier: identifier,
            _rights: rights,
            _sess: this.id
        };

        this._server.onSetACL(
            path,
            {
                identifier,
                rights
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
