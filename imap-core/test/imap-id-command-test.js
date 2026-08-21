/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const { expect } = require('chai');
const idCommand = require('../lib/commands/id');
const imapParser = require('../lib/handler/imap-parser');

describe('ID command handler', function () {
    // minimal IMAPConnection stand-in: the handler reads session/_server and calls send()
    const createConnection = () => {
        const responses = [];
        const gelf = [];
        const connection = {
            id: 'sess-test',
            session: {
                user: {
                    id: {
                        toString() {
                            return 'user';
                        }
                    }
                }
            },
            _server: {
                options: {},
                logger: {
                    debug() {},
                    info() {},
                    error() {}
                },
                loggelf(message) {
                    gelf.push(message);
                }
            },
            send(response) {
                responses.push(response);
            }
        };
        return { connection, responses, gelf };
    };

    const runId = (connection, line) =>
        new Promise((resolve, reject) => {
            const command = imapParser(line);
            try {
                idCommand.handler.call(connection, command, (err, response) => {
                    if (err) {
                        return reject(err);
                    }
                    resolve(response);
                });
            } catch (err) {
                reject(err);
            }
        });

    it('should not crash on a NIL key value and should omit that key', async function () {
        const { connection } = createConnection();

        // the command Apple Mail sends: a trailing "event" NIL pair
        const response = await runId(connection, 'S3 ID ("name" "Mail" "version" "3864.600.51.2.1" "os" "iOS" "vendor" "Apple Inc" "event" NIL)');

        expect(response.response).to.equal('OK');
        expect(connection.session.clientId).to.deep.equal({
            name: 'Mail',
            version: '3864.600.51.2.1',
            os: 'iOS',
            vendor: 'Apple Inc'
        });
        // NIL-valued key is omitted entirely, not stored as an empty string
        expect(connection.session.clientId).to.not.have.property('event');
    });

    it('should keep keys sent with an empty-string value', async function () {
        const { connection } = createConnection();

        const response = await runId(connection, 'S3 ID ("name" "" "vendor" "Apple Inc")');

        expect(response.response).to.equal('OK');
        expect(connection.session.clientId).to.deep.equal({
            name: '',
            vendor: 'Apple Inc'
        });
    });

    it('should not crash when the whole argument is NIL', async function () {
        const { connection, responses } = createConnection();

        const response = await runId(connection, 'S3 ID NIL');

        expect(response.response).to.equal('OK');
        // no client id parsed, but the server still answers with its own ID line
        expect(connection.session.clientId).to.be.undefined;
        expect(responses.some(line => /^\* ID /.test(line))).to.be.true;
    });
});
