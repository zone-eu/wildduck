'use strict';

//
// Thanks to Forward Email
// <https://forwardemail.net>
// <https://github.com/zone-eu/wildduck/issues/711>
// tag XAPPLEPUSHSERVICE aps-version 2 aps-account-id 0715A26B-CA09-4730-A419-793000CA982E aps-device-token 2918390218931890821908309283098109381029309829018310983092892829 aps-subtopic com.apple.mobilemail mailboxes (INBOX Notes)
//

// TODO:
//  1. store APS information in DB, each deviceToken separately
//  2. on new email use the stored information to push to apple (use matching deviceTokens as an array of recipients)
//  3. if pushing to a specific deviceToken yields in 410, remove that token

module.exports = server => (accountID, deviceToken, subTopic, mailboxes, session, callback) => {
    server.logger.debug(
        {
            tnx: 'xapplepushservice',
            cid: session.id
        },
        '[%s] XAPPLEPUSHSERVICE accountID "%s" deviceToken "%s" subTopic "%s" mailboxes "%s"',
        session.id,
        accountID,
        deviceToken,
        subTopic,
        mailboxes
    );

    return callback(new Error('Not implemented, see <https://github.com/zone-eu/wildduck/issues/711>'));
};
