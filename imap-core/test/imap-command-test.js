/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const { expect } = require('chai');
const { PassThrough } = require('stream');
const { IMAPCommand } = require('../lib/imap-command');

describe('IMAPCommand', function () {
    const createConnection = options => {
        options = options || {};

        const responses = [];
        const writes = [];
        const appendCalls = [];
        const serverOptions = Object.assign(
            {
                maxMessage: 1024
            },
            options.serverOptions || {}
        );

        const connection = {
            id: 'test',
            state: options.state || 'Authenticated',
            selected: {
                mailbox: 'INBOX'
            },
            session: {
                commandCounters: {},
                user: {
                    id: {
                        toString() {
                            return 'user';
                        }
                    }
                }
            },
            _server: {
                options: serverOptions,
                logger: {
                    debug() {},
                    info() {},
                    error() {}
                },
                loggelf() {},
                onAppend(path, flags, internaldate, raw, session, callback) {
                    appendCalls.push({ path, flags, internaldate, raw, session });
                    callback(null, true, {
                        uidValidity: 1,
                        uid: 2
                    });
                }
            },
            logger: {
                debug() {},
                info() {},
                error() {}
            },
            send(response) {
                responses.push(response);
            },
            writeStream: {
                write(response) {
                    writes.push(response);
                }
            },
            emitNotifications() {},
            clearNotificationListener() {},
            close() {},
            loggelf() {}
        };

        return { connection, responses, writes, appendCalls };
    };

    it('should reject negative literal sizes', function (done) {
        const responses = [];
        const connection = {
            _server: {
                options: {
                    maxMessage: 1024
                }
            },
            send(response) {
                responses.push(response);
            }
        };

        const command = new IMAPCommand(connection);

        command.append(
            {
                value: 'A1 APPEND INBOX {-1}\r\n',
                literal: {
                    on() {}
                },
                expecting: -1
            },
            err => {
                expect(err).to.exist;
                expect(err.code).to.equal('InvalidLiteralSize');
                expect(responses).to.deep.equal(['A1 BAD Invalid literal size']);
                done();
            }
        );
    });

    it('should accept zero literal sizes', function (done) {
        const { connection, responses } = createConnection();
        const command = new IMAPCommand(connection);
        let readyCalls = 0;

        command.append(
            {
                value: 'A1 APPEND INBOX {0}',
                literal: new PassThrough(),
                expecting: 0,
                readyCallback() {
                    readyCalls++;
                }
            },
            err => {
                expect(err).to.not.exist;
                expect(responses).to.deep.equal(['+ Go ahead']);
                expect(command.payload).to.equal('A1 APPEND INBOX {0}\r\n');
                expect(command.literals).to.deep.equal([]);
                expect(readyCalls).to.equal(1);
                done();
            }
        );
    });

    it('should reject an APPEND command with a zero length literal', function (done) {
        const { connection, responses, writes, appendCalls } = createConnection();
        const command = new IMAPCommand(connection);

        command.append(
            {
                value: 'A1 APPEND INBOX {0}',
                literal: new PassThrough(),
                expecting: 0,
                readyCallback() {}
            },
            err => {
                expect(err).to.not.exist;

                command.end(
                    {
                        value: '',
                        final: true
                    },
                    endErr => {
                        expect(endErr).to.not.exist;
                        expect(responses).to.deep.equal(['+ Go ahead']);
                        expect(appendCalls).to.have.length(0);
                        expect(writes).to.have.length(1);
                        expect(writes[0].tag).to.equal('A1');
                        expect(writes[0].command).to.equal('NO');
                        done();
                    }
                );
            }
        );
    });

    it('should not consume a cached literal for zero literal sizes', function (done) {
        const { connection, responses, writes } = createConnection({
            serverOptions: {
                id: {
                    name: 'server'
                }
            }
        });
        const command = new IMAPCommand(connection);
        const secondLiteral = new PassThrough();

        command.append(
            {
                value: 'A1 ID ("name" {0}',
                literal: new PassThrough(),
                expecting: 0,
                readyCallback() {}
            },
            err => {
                expect(err).to.not.exist;

                command.append(
                    {
                        value: ' "vendor" {4}',
                        literal: secondLiteral,
                        expecting: 4,
                        readyCallback() {}
                    },
                    literalErr => {
                        expect(literalErr).to.not.exist;
                        secondLiteral.end(Buffer.from('test'));

                        setImmediate(() => {
                            expect(command.literals).to.have.length(1);
                            command.end(
                                {
                                    value: ')',
                                    final: true
                                },
                                endErr => {
                                    expect(endErr).to.not.exist;
                                    expect(connection.session.clientId).to.deep.equal({
                                        name: '',
                                        vendor: 'test'
                                    });
                                    expect(responses).to.deep.equal(['+ Go ahead', '+ Go ahead', '* ID ("name" "server")']);
                                    expect(writes[0].tag).to.equal('A1');
                                    expect(writes[0].command).to.equal('OK');
                                    done();
                                }
                            );
                        });
                    }
                );
            }
        );
    });
});
