/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */
'use strict';

const { expect } = require('chai');
const { IMAPCommand } = require('../lib/imap-command');

describe('IMAPCommand', function () {
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
});
