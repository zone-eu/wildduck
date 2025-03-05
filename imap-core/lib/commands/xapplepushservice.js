'use strict';

//
// Thanks to Forward Email
// <https://forwardemail.net>
// <https://github.com/zone-eu/wildduck/issues/711>
// tag XAPPLEPUSHSERVICE aps-version 2 aps-account-id 0715A26B-CA09-4730-A419-793000CA982E aps-device-token 2918390218931890821908309283098109381029309829018310983092892829 aps-subtopic com.apple.mobilemail mailboxes (INBOX Notes)
//

const requiredKeys = ['aps-version', 'aps-account-id', 'aps-device-token', 'aps-subtopic', 'mailboxes'];

module.exports = {
    state: ['Authenticated', 'Selected'],

    // the input is a key-value set which is not supported by the default schema handler
    schema: false,

    // [
    //   { type: 'ATOM', value: 'aps-version' },
    //   { type: 'ATOM', value: '2' },
    //   { type: 'ATOM', value: 'aps-account-id' },
    //   { type: 'ATOM', value: 'xxxxxxx' },
    //   { type: 'ATOM', value: 'aps-device-token' },
    //   {
    //     type: 'ATOM',
    //     value: 'xxxxxx'
    //   },
    //   { type: 'ATOM', value: 'aps-subtopic' },
    //   { type: 'ATOM', value: 'com.apple.mobilemail' },
    //   { type: 'ATOM', value: 'mailboxes' },
    //   [
    //     { type: 'STRING', value: 'Sent Mail' },
    //     { type: 'STRING', value: 'INBOX' }
    //   ]
    // ]

    handler(command, callback) {
        // Command = {
        //   tag: 'I5',
        //   command: 'XAPPLEPUSHSERVICE',
        //   attributes: [
        //     { type: 'ATOM', value: 'aps-version' }, // 0
        //     { type: 'ATOM', value: '2' }, // 1
        //     { type: 'ATOM', value: 'aps-account-id' }, // 2
        //     { type: 'ATOM', value: 'xxxxxx' }, // 3
        //     { type: 'ATOM', value: 'aps-device-token' }, // 4
        //     {  // 5
        //       type: 'ATOM',
        //       value: 'xxxxxx'
        //     },
        //     { type: 'ATOM', value: 'aps-subtopic' }, // 6
        //     { type: 'ATOM', value: 'com.apple.mobilemail' }, // 7
        //     { type: 'ATOM', value: 'mailboxes' }, // 8
        //     [ // 9
        //       { type: 'STRING', value: 'Sent Mail' },
        //       { type: 'STRING', value: 'INBOX' }
        //     ]
        //   ]
        // }

        const apsConfig = this._server.options.aps || {};

        // Reject if not enabled
        if (!apsConfig.enabled) {
            return callback(null, {
                response: 'BAD',
                message: `Unknown command: ${command.command}`
            });
        }

        // Parse input arguments into a structured object:

        // {
        //   "aps-version": "2",
        //   "aps-account-id": "0715A26B-CA09-4730-A419-793000CA982E",
        //   "aps-device-token": "2918390218931890821908309283098109381029309829018310983092892829",
        //   "aps-subtopic": "com.apple.mobilemail",
        //   "mailboxes": [
        //     "INBOX",
        //     "Notes"
        //   ]
        // }

        let data = {};
        let keyName;
        for (let i = 0, len = (command.attributes || []).length; i < len; i++) {
            let isKey = i % 2 === 0;
            let attr = command.attributes[i];
            if (isKey && !['ATOM', 'STRING'].includes(attr.type)) {
                return callback(null, {
                    response: 'BAD',
                    message: `Invalid argument for ${command.command}`
                });
            }
            if (isKey) {
                keyName = (attr.value || '').toString().toLowerCase();
                continue;
            }

            if (!requiredKeys.includes(keyName)) {
                // skip unknown keys
            }

            if (['ATOM', 'STRING'].includes(attr.type)) {
                data[keyName] = (attr.value || '').toString();
            } else if (Array.isArray(attr) && keyName === 'mailboxes') {
                let mailboxes = attr
                    .map(entry => {
                        if (['ATOM', 'STRING'].includes(entry.type)) {
                            return (entry.value || '').toString();
                        }
                        return false;
                    })
                    .filter(name => name);
                data[keyName] = mailboxes;
            }
        }

        // Make sure all required keys (except mailboxes) are present
        for (let requiredKey of requiredKeys) {
            if (!data[requiredKey] && requiredKey !== 'mailboxes') {
                return callback(null, {
                    response: 'BAD',
                    message: `Missing required arguments for ${command.command}`
                });
            }
        }

        const version = data['aps-version'];
        const accountID = data['aps-account-id'];
        const deviceToken = data['aps-device-token'];
        const subTopic = data['aps-subtopic'];
        const mailboxes = data.mailboxes || [];

        if (version !== '2') {
            return callback(null, {
                response: 'NO',
                message: 'Unsupported APS version',
                code: 'CLIENTBUG'
            });
        }

        if (subTopic !== 'com.apple.mobilemail') {
            return callback(null, {
                response: 'NO',
                message: `Invalid subtopic for ${command.command}`,
                code: 'CLIENTBUG'
            });
        }

        const logdata = {
            short_message: '[XAPPLEPUSHSERVICE]',
            _mail_action: 'xapplepushservice',
            _accountId: accountID,
            _deviceToken: deviceToken,
            _subTopic: subTopic,
            _mailboxes: mailboxes,
            _user: this.session.user.id.toString(),
            _sess: this.id
        };

        // <https://github.com/freswa/dovecot-xaps-daemon/issues/39#issuecomment-2263472541>
        this._server.onXAPPLEPUSHSERVICE(accountID, deviceToken, subTopic, mailboxes, this.session, (error, topic) => {
            if (error) {
                logdata._error = error.message;
                logdata._code = error.code;
                logdata._response = error.response;
                this._server.loggelf(logdata);

                return callback(null, {
                    response: 'NO',
                    code: 'TEMPFAIL'
                });
            }

            // this is a developer bug, they forgot to return a topic in callback
            if (typeof topic !== 'string' || !topic)
                return callback(null, {
                    response: 'NO',
                    code: 'TEMPFAIL'
                });

            // <https://opensource.apple.com/source/dovecot/dovecot-293/dovecot/src/imap/cmd-x-apple-push-service.c.auto.html>
            // <https://github.com/st3fan/dovecot-xaps-plugin/blob/3d1c71e0c78cc35ca6ead21f49a8e0e35e948a7c/xaps-imap-plugin.c#L158-L166>
            this.send(`* XAPPLEPUSHSERVICE aps-version "${version}" aps-topic "${topic}"`);
            callback(null, {
                response: 'OK',
                message: 'XAPPLEPUSHSERVICE Registration successful.'
            });
        });
    }
};
