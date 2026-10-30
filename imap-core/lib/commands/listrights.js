'use strict';

const imapHandler = require('../handler/imap-handler');
const imapTools = require('../imap-tools');

// tag LISTRIGHTS "mailbox" "identifier"

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
        let mailbox = Buffer.from((command.attributes[0] && command.attributes[0].value) || '', 'binary').toString();
        let path = imapTools.normalizeMailbox(mailbox, !this.acceptUTF8Enabled);

        let identifier = Buffer.from((command.attributes[1] && command.attributes[1].value) || '', 'binary').toString();

        if (typeof this._server.onListRights !== 'function') {
            return callback(null, {
                response: 'NO',
                message: command.command + ' not implemented'
            });
        }

        if (!path || !identifier) {
            return callback(new Error('Invalid arguments for LISTRIGHTS'));
        }

        let logdata = {
            short_message: '[LISTRIGHTS]',
            _mail_action: 'listrights',
            _user: this.session.user.id.toString(),
            _path: path,
            _identifier: identifier,
            _sess: this.id
        };

        this._server.onListRights(
            path,
            {
                identifier
            },
            this.session,
            (err, data) => {
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

                // * LISTRIGHTS "mailbox" identifier required [optional]*
                let attributes = [mailbox, data.identifier, data.required || ''];
                for (let right of data.optional || []) {
                    attributes.push({
                        type: 'atom',
                        value: right
                    });
                }

                this.send(
                    imapHandler.compiler({
                        tag: '*',
                        command: 'LISTRIGHTS',
                        attributes
                    })
                );

                callback(null, {
                    response: 'OK'
                });
            }
        );
    }
};
