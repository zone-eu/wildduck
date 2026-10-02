/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const imapTools = require('../lib/imap-tools');
const chai = require('chai');
const expect = chai.expect;
chai.config.includeStack = true;

describe('#packMessageRange', function () {
    it('should return as is', function () {
        expect(imapTools.packMessageRange([1, 3, 5, 9])).to.equal('1,3,5,9');
    });

    it('should return a range', function () {
        expect(imapTools.packMessageRange([1, 2, 3, 4])).to.equal('1:4');
    });

    it('should return mixed ranges', function () {
        expect(imapTools.packMessageRange([1, 3, 4, 6, 8, 9, 10, 11, 13])).to.equal('1,3:4,6,8:11,13');
    });
});

describe('#filterFolders', function () {
    it('should not throw for wildcard queries containing braces', function () {
        expect(function () {
            imapTools.filterFolders([{ path: 'test' }], '%{2}');
        }).to.not.throw();
    });

    it('should treat braces in wildcard queries as literal characters', function () {
        expect(imapTools.filterFolders([{ path: 'test' }, { path: 'test{2}' }, { path: 'other{2}' }], '%{2}').map(folder => folder.path)).to.deep.equal([
            'test{2}',
            'other{2}'
        ]);
    });
});

describe('#sendCapabilityResponse', function () {
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

    it('should advertise WITHIN before authentication', function () {
        expect(getCapabilities({ state: 'Not Authenticated' })).to.include('WITHIN');
    });

    it('should advertise WITHIN after authentication', function () {
        expect(getCapabilities({ state: 'Authenticated' })).to.include('WITHIN');
    });

    it('should advertise WITHIN together with STARTTLS capabilities', function () {
        let capabilities = getCapabilities({
            secure: false,
            state: 'Not Authenticated',
            _server: { options: {} }
        });

        expect(capabilities).to.include('WITHIN');
        expect(capabilities).to.include('STARTTLS');
        expect(capabilities).to.include('LOGINDISABLED');
    });

    it('should advertise WITHIN only once', function () {
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

describe('#getCopyUidCode', function () {
    it('should build a COPYUID code', function () {
        expect(imapTools.getCopyUidCode(true, { uidValidity: 123, sourceUid: [1, 2, 3], destinationUid: [10, 11, 12] })).to.equal('COPYUID 123 1:3 10:12');
    });

    it('should skip the code when nothing was copied', function () {
        // RFC 4315 4: resp-code-copy takes two non-empty uid-sets
        expect(imapTools.getCopyUidCode(true, { uidValidity: 123, sourceUid: [], destinationUid: [] })).to.be.false;
    });

    it('should pass a failure code through', function () {
        expect(imapTools.getCopyUidCode('trycreate', false)).to.equal('TRYCREATE');
    });
});

describe('#validateSequence', function () {
    it('should accept a sequence set', function () {
        expect(imapTools.validateSequence('1')).to.be.true;
        expect(imapTools.validateSequence('*')).to.be.true;
        expect(imapTools.validateSequence('1:*')).to.be.true;
        expect(imapTools.validateSequence('*:4')).to.be.true;
        expect(imapTools.validateSequence('1,3,5:9')).to.be.true;
        // leading zeros name the same non-zero message, keep accepting them
        expect(imapTools.validateSequence('01')).to.be.true;
    });

    it('should reject a zero sequence number', function () {
        // RFC 3501 9: seq-number = nz-number / "*"
        expect(imapTools.validateSequence('0')).to.be.false;
        expect(imapTools.validateSequence('1:0')).to.be.false;
        expect(imapTools.validateSequence('0:1')).to.be.false;
        expect(imapTools.validateSequence('1,0')).to.be.false;
        expect(imapTools.validateSequence('00')).to.be.false;
    });

    it('should reject malformed input', function () {
        expect(imapTools.validateSequence('')).to.be.false;
        expect(imapTools.validateSequence('1:')).to.be.false;
        expect(imapTools.validateSequence('a')).to.be.false;
    });
});

describe('#isValidKeyword', function () {
    it('should accept an atom', function () {
        expect(imapTools.isValidKeyword('MyFlag')).to.be.true;
        expect(imapTools.isValidKeyword('$label1')).to.be.true;
        expect(imapTools.isValidKeyword('NonJunk')).to.be.true;
        // the parser accepts 8-bit bytes in atoms, so keywords keep accepting them too
        expect(imapTools.isValidKeyword('töö')).to.be.true;
    });

    it('should reject a value that is not an atom', function () {
        // RFC 3501 9: flag-keyword = atom, so no atom-specials
        expect(imapTools.isValidKeyword('')).to.be.false;
        expect(imapTools.isValidKeyword('a b')).to.be.false;
        expect(imapTools.isValidKeyword('a(b')).to.be.false;
        expect(imapTools.isValidKeyword('a)b')).to.be.false;
        expect(imapTools.isValidKeyword('a{b')).to.be.false;
        expect(imapTools.isValidKeyword('a]b')).to.be.false;
        expect(imapTools.isValidKeyword('a*b')).to.be.false;
        expect(imapTools.isValidKeyword('a%b')).to.be.false;
        expect(imapTools.isValidKeyword('a"b')).to.be.false;
        expect(imapTools.isValidKeyword('a\\b')).to.be.false;
        expect(imapTools.isValidKeyword('a\u0001b')).to.be.false;
    });
});

describe('#isValidUtf8', function () {
    const formalSyntax = require('../lib/handler/imap-formal-syntax'); // eslint-disable-line global-require

    it('should accept 7-bit and well formed UTF-8', function () {
        expect(formalSyntax.isValidUtf8('plain ascii')).to.be.true;
        expect(formalSyntax.isValidUtf8(Buffer.from('Pröbe', 'utf8').toString('binary'))).to.be.true;
        expect(formalSyntax.isValidUtf8(Buffer.from('😀', 'utf8').toString('binary'))).to.be.true;
    });

    it('should reject a high bit sequence that is not UTF-8', function () {
        // RFC 6855 3 requires a BAD response for these
        expect(formalSyntax.isValidUtf8(Buffer.from('Pröbe', 'latin1').toString('binary'))).to.be.false;
        expect(formalSyntax.isValidUtf8('Â')).to.be.false;
    });
});
