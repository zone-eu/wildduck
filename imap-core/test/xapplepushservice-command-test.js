/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const { expect } = require('chai');
const xappleCommand = require('../lib/commands/xapplepushservice');
const imapParser = require('../lib/handler/imap-parser');
const imapTools = require('../lib/imap-tools');

describe('XAPPLEPUSHSERVICE command handler', function () {
    // minimal IMAPConnection stand-in: the handler reads session/_server, calls send()
    // and delegates to _server.onXAPPLEPUSHSERVICE
    const createConnection = (options = {}) => {
        const responses = [];
        const gelf = [];
        const calls = [];
        const connection = {
            id: 'sess-test',
            acceptUTF8Enabled: !!options.acceptUTF8Enabled,
            session: {
                id: 'sess-test',
                user: {
                    id: {
                        toString() {
                            return 'user';
                        }
                    }
                }
            },
            _server: {
                options: { aps: { enabled: true } },
                loggelf(message) {
                    gelf.push(message);
                },
                onXAPPLEPUSHSERVICE(accountID, deviceToken, subTopic, mailboxes, session, cb) {
                    calls.push({ accountID, deviceToken, subTopic, mailboxes });
                    // return a topic so the handler responds OK
                    cb(null, 'com.apple.mail.XServer.topic');
                }
            },
            send(response) {
                responses.push(response);
            }
        };
        return { connection, responses, gelf, calls };
    };

    const run = (connection, line) =>
        new Promise((resolve, reject) => {
            // the wire delivers bytes; parse from a UTF-8 buffer so multi-byte names round-trip
            const command = imapParser(Buffer.from(line, 'utf8'));
            try {
                xappleCommand.handler.call(connection, command, (err, response) => {
                    if (err) {
                        return reject(err);
                    }
                    resolve(response);
                });
            } catch (err) {
                reject(err);
            }
        });

    const validLine = mailboxes =>
        'A1 XAPPLEPUSHSERVICE aps-version 2 aps-account-id 0715A26B-CA09-4730-A419-793000CA982E ' +
        'aps-device-token 2918390218931890821908309283098109381029309829018310983092892829 ' +
        `aps-subtopic com.apple.mobilemail mailboxes ${mailboxes}`;

    describe('malformed / NIL input', function () {
        it('should answer BAD instead of crashing when a key is NIL', async function () {
            const { connection } = createConnection();
            // NIL in a key position previously dereferenced attr.type and crashed the worker
            const response = await run(connection, 'A1 XAPPLEPUSHSERVICE NIL 2 mailboxes (INBOX)');
            expect(response.response).to.equal('BAD');
        });

        it('should answer BAD instead of crashing when a value is NIL', async function () {
            const { connection, calls } = createConnection();
            // aps-device-token is required; a NIL value must be rejected, not stored
            const response = await run(
                connection,
                'A1 XAPPLEPUSHSERVICE aps-version 2 aps-account-id 0715A26B-CA09-4730-A419-793000CA982E ' +
                    'aps-device-token NIL aps-subtopic com.apple.mobilemail mailboxes (INBOX)'
            );
            expect(response.response).to.equal('BAD');
            expect(calls).to.have.length(0);
        });

        it('should skip NIL entries inside the mailboxes list without crashing', async function () {
            const { connection, calls } = createConnection();
            const response = await run(connection, validLine('(INBOX NIL Notes)'));
            expect(response.response).to.equal('OK');
            expect(calls).to.have.length(1);
            // the NIL entry is dropped, the real mailboxes survive
            expect(calls[0].mailboxes).to.deep.equal(['INBOX', 'Notes']);
        });

        it('should not crash when mailboxes itself is NIL', async function () {
            const { connection, calls } = createConnection();
            const response = await run(
                connection,
                'A1 XAPPLEPUSHSERVICE aps-version 2 aps-account-id 0715A26B-CA09-4730-A419-793000CA982E ' +
                    'aps-device-token 2918390218931890821908309283098109381029309829018310983092892829 ' +
                    'aps-subtopic com.apple.mobilemail mailboxes NIL'
            );
            expect(response.response).to.equal('OK');
            expect(calls[0].mailboxes).to.deep.equal([]);
        });
    });

    describe('mailbox name normalization', function () {
        it('should fold a case-variant INBOX to canonical INBOX', async function () {
            const { connection, calls } = createConnection();
            const response = await run(connection, validLine('(inbox)'));
            expect(response.response).to.equal('OK');
            expect(calls[0].mailboxes).to.deep.equal(['INBOX']);
        });

        it('should decode modified UTF-7 mailbox names', async function () {
            const { connection, calls } = createConnection();
            const encoded = imapTools.utf7encode('Töö'); // e.g. "T&APYA9g-"
            const response = await run(connection, validLine(`("${encoded}")`));
            expect(response.response).to.equal('OK');
            expect(calls[0].mailboxes).to.deep.equal(['Töö']);
        });

        it('should not UTF-7 decode when the client negotiated UTF8=ACCEPT', async function () {
            const { connection, calls } = createConnection({ acceptUTF8Enabled: true });
            const encoded = imapTools.utf7encode('Töö'); // e.g. "T&APYA9g-"
            // with UTF8=ACCEPT the ampersand form is a literal name, not a shift sequence,
            // so it must survive verbatim rather than being decoded to "Töö"
            const response = await run(connection, validLine(`("${encoded}")`));
            expect(response.response).to.equal('OK');
            expect(calls[0].mailboxes).to.deep.equal([encoded]);
        });
    });

    it('should reply BAD when APS support is disabled', async function () {
        const { connection } = createConnection();
        connection._server.options.aps = { enabled: false };
        const response = await run(connection, validLine('(INBOX)'));
        expect(response.response).to.equal('BAD');
        expect(/Unknown command/.test(response.message)).to.be.true;
    });
});
