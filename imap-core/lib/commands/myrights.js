'use strict';

const imapHandler = require('../handler/imap-handler');
const imapTools = require('../imap-tools');

// tag MYRIGHTS "mailbox"

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

        if (typeof this._server.onMyRights !== 'function') {
            return callback(null, {
                response: 'NO',
                message: command.command + ' not implemented'
            });
        }

        if (!path) {
            return callback(new Error('Invalid mailbox argument for MYRIGHTS'));
        }

        let logdata = {
            short_message: '[MYRIGHTS]',
            _mail_action: 'myrights',
            _user: this.session.user.id.toString(),
            _path: path,
            _sess: this.id
        };

        this._server.onMyRights(path, this.session, (err, data) => {
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

            // * MYRIGHTS "mailbox" rights
            this.send(
                imapHandler.compiler({
                    tag: '*',
                    command: 'MYRIGHTS',
                    attributes: [mailbox, data.rights]
                })
            );

            callback(null, {
                response: 'OK'
            });
        });
    }
};
