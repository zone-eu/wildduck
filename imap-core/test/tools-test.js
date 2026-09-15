/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const imapTools = require('../lib/imap-tools');
const imapHandler = require('../lib/handler/imap-handler');
const { IMAPConnection } = require('../lib/imap-connection');
const chai = require('chai');
const expect = chai.expect;
chai.config.includeStack = true;

describe('Unicode flags', function() {
    it('should decode only values explicitly marked as wire-byte strings', function() {
        for (const keyword of ['café', 'čau-😀']) {
            expect(imapTools.decodeUtf8(keyword)).to.equal(keyword);
            expect(imapTools.decodeUtf8(Buffer.from(keyword).toString('binary'), 'binary')).to.equal(keyword);
        }
    });

    it('should preserve Unicode keywords without introducing response control bytes', function() {
        const keyword = 'safe\u010a\u010d-čau-😀';
        const connection = Object.create(IMAPConnection.prototype);
        connection.selected = { uidList: [42] };
        const compiled = imapHandler.compiler(
            connection.formatResponse('FETCH', 42, {
                query: [
                    {
                        item: 'flags',
                        original: { type: 'ATOM', value: 'FLAGS' }
                    }
                ],
                values: [[keyword]]
            })
        );
        const response = Buffer.from(compiled + '\r\n', 'binary');

        expect(response.toString()).to.equal(`* 1 FETCH (FLAGS (${keyword}))\r\n`);
        expect([...response].filter(byte => byte === 0x0a)).to.have.lengthOf(1);
        expect([...response].filter(byte => byte === 0x0d)).to.have.lengthOf(1);
    });

    it('should encode Unicode flags in unsolicited FETCH responses', function() {
        const keyword = 'žymė';
        const connection = Object.create(IMAPConnection.prototype);
        connection.selected = { uidList: [42] };
        const compiled = imapHandler.compiler(
            connection.formatResponse('FETCH', 42, {
                flags: [keyword]
            })
        );

        expect(Buffer.from(compiled, 'binary').toString()).to.equal(`* 1 FETCH (FLAGS (${keyword}))`);
    });
});

describe('#packMessageRange', function() {
    it('should return as is', function() {
        expect(imapTools.packMessageRange([1, 3, 5, 9])).to.equal('1,3,5,9');
    });

    it('should return a range', function() {
        expect(imapTools.packMessageRange([1, 2, 3, 4])).to.equal('1:4');
    });

    it('should return mixed ranges', function() {
        expect(imapTools.packMessageRange([1, 3, 4, 6, 8, 9, 10, 11, 13])).to.equal('1,3:4,6,8:11,13');
    });
});

describe('#filterFolders', function() {
    it('should not throw for wildcard queries containing braces', function() {
        expect(function() {
            imapTools.filterFolders([{ path: 'test' }], '%{2}');
        }).to.not.throw();
    });

    it('should treat braces in wildcard queries as literal characters', function() {
        expect(
            imapTools.filterFolders([{ path: 'test' }, { path: 'test{2}' }, { path: 'other{2}' }], '%{2}').map(folder => folder.path)
        ).to.deep.equal(['test{2}', 'other{2}']);
    });
});

describe('#sendCapabilityResponse', function() {
    function getCapabilities(connection) {
        let responses = [];

        imapTools.sendCapabilityResponse({
            secure: true,
            state: 'Authenticated',
            _server: { options: {} },
            ...connection,
            send: response => responses.push(response)
        });

        expect(responses).to.have.length(1);
        expect(responses[0]).to.match(/^\* CAPABILITY /);

        return responses[0].replace(/^\* CAPABILITY /, '').split(' ');
    }

    it('should advertise WITHIN before authentication', function() {
        expect(getCapabilities({ state: 'Not Authenticated' })).to.include('WITHIN');
    });

    it('should advertise WITHIN after authentication', function() {
        expect(getCapabilities({ state: 'Authenticated' })).to.include('WITHIN');
    });

    it('should advertise WITHIN together with STARTTLS capabilities', function() {
        let capabilities = getCapabilities({
            secure: false,
            state: 'Not Authenticated',
            _server: { options: {} }
        });

        expect(capabilities).to.include('WITHIN');
        expect(capabilities).to.include('STARTTLS');
        expect(capabilities).to.include('LOGINDISABLED');
    });

    it('should advertise WITHIN only once', function() {
        let capabilities = getCapabilities({
            state: 'Authenticated',
            _server: {
                options: {
                    enableCompression: true,
                    maxMessage: 1024
                }
            }
        });

        expect(capabilities.filter(capability => capability === 'WITHIN')).to.have.length(1);
    });
});
