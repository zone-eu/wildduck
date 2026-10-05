/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const { expect } = require('chai');
const db = require('../lib/db');
const createHandler = require('../lib/handlers/on-xapplepushservice');

describe('XAPPLEPUSHSERVICE registration validation', function () {
    for (let mailboxes of ['INBOX', '', null, undefined, {}]) {
        it(`should reject non-array mailboxes ${JSON.stringify(mailboxes)} before accessing MongoDB`, function (done) {
            let originalDatabase = db.database;
            db.database = {
                collection() {
                    throw new Error('Validation must run before database access');
                }
            };
            try {
                createHandler({})('0715A26B-CA09-4730-A419-793000CA982E', 'a'.repeat(64), 'com.apple.mobilemail', mailboxes, {}, err => {
                    expect(err).to.be.instanceof(Error);
                    expect(err.message).to.equal('Mailboxes must be an array');
                    done();
                });
            } finally {
                db.database = originalDatabase;
            }
        });
    }
});
