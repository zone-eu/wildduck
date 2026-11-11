/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const envelopes = require('../../../lib/jmap/submission-envelope');
const { filterQuery, sortOf } = require('../../../lib/jmap/types/submission');

const errorOf = fn => {
    try {
        fn();
    } catch (err) {
        return err;
    }
    throw new Error('expected an error');
};

describe('JMAP submission envelope', () => {
    describe('validAddress', () => {
        it('accepts dot-atom addresses and converts internationalised domains', () => {
            expect(envelopes.validAddress('a.b+c@Example.COM')).to.deep.equal({
                email: 'a.b+c@Example.COM',
                address: 'a.b+c@example.com',
                key: 'a.b+c@example.com'
            });
            expect(envelopes.validAddress('user@exämple.com').address).to.equal('user@xn--exmple-cua.com');
            expect(envelopes.validAddress('postmaster@localhost')).to.not.equal(null);
        });

        it('accepts UTF-8 local parts (RFC 6531) and keeps them as written', () => {
            expect(envelopes.validAddress('üser@example.com')).to.deep.equal({
                email: 'üser@example.com',
                address: 'üser@example.com',
                key: 'üser@example.com'
            });
            expect(envelopes.validAddress('ä.ö@bücher.de').address).to.equal('ä.ö@xn--bcher-kva.de');
            expect(envelopes.validAddress('用户@例子.广告')).to.not.equal(null);
        });

        it('refuses anything that could carry SMTP syntax', () => {
            const bad = [
                'a@example.com>\r\nRCPT TO:<b@example.com',
                'a>b@example.com',
                'a b@example.com',
                'a\u0000b@example.com',
                '<a@example.com>',
                '"a b"@example.com',
                'a@b@example.com',
                'no-at-sign',
                'user@',
                '@example.com',
                'user@-bad.example',
                'user@bad-.example',
                'user@bad .example',
                'user@[127.0.0.1]',
                'a..b@example.com',
                `${'a'.repeat(65)}@example.com`,
                // 33 two octet characters are more than the 64 octets of a local part
                `${'ü'.repeat(33)}@example.com`,
                // Unicode spaces, line separators, controls, format characters and lone surrogates
                'a\u00a0b@example.com',
                'a\u3000b@example.com',
                'a\u2028b@example.com',
                'a\u0085b@example.com',
                'a\u200bb@example.com',
                'a\ud800b@example.com',
                'ü\r\n@example.com',
                '"ü"@example.com',
                null,
                42
            ];
            for (const address of bad) {
                expect(envelopes.validAddress(address), JSON.stringify(address)).to.equal(null);
            }
        });
    });

    describe('parseAddressList', () => {
        it('reads mailboxes, angle addresses and group members', () => {
            const { addresses, invalid } = envelopes.parseAddressList(
                'Jane (work) <jane@example.com>, "Doe, John" <john@example.com>, Team: a@example.net, b@example.org;, Empty: ;'
            );
            expect(addresses.map(entry => entry.email)).to.deep.equal(['jane@example.com', 'john@example.com', 'a@example.net', 'b@example.org']);
            expect(invalid).to.deep.equal([]);
        });

        it('never decodes encoded words into addresses', () => {
            expect(
                envelopes.parseAddressList('=?utf-8?Q?a=40example.net=0D=0Ab=40example.net?= <real@example.net>').addresses.map(entry => entry.email)
            ).to.deep.equal(['real@example.net']);
            expect(envelopes.parseAddressList('=?utf-8?Q?a=40example.net?=').addresses).to.deep.equal([]);
        });

        it('lists the unusable mailboxes as written', () => {
            const { addresses, invalid } = envelopes.parseAddressList('ok@example.net, a b@example.com, user@, <x@example.com> trailing');
            expect(addresses.map(entry => entry.email)).to.deep.equal(['ok@example.net']);
            expect(invalid).to.deep.equal(['a b@example.com', 'user@', '<x@example.com> trailing']);
            expect(envelopes.parseAddressList('<unbalanced@example.com').invalid).to.have.length(1);
        });
    });

    describe('messageAddresses', () => {
        const fields = lines => envelopes.headerFields({ header: lines });

        it('takes From, Sender and the recipients of To, Cc and Bcc', () => {
            const result = envelopes.messageAddresses(
                fields(['From: A <a@example.com>', 'Sender: s@example.com', 'To: t@example.net,\r\n c@example.net', 'Bcc: b@example.net'])
            );
            expect(result.from).to.equal('a@example.com');
            expect(result.sender).to.equal('s@example.com');
            expect(result.recipients.map(entry => entry.email)).to.deep.equal(['t@example.net', 'c@example.net', 'b@example.net']);
        });

        it('rejects a missing, repeated or multi address From and Sender', () => {
            const cases = [
                [['To: t@example.net'], ['from']],
                [['From: ', 'To: t@example.net'], ['from']],
                [['From: a@example.com, b@example.com'], ['from']],
                [['From: a@example.com', 'From: a@example.com'], ['from']],
                [['From: a@example.com', 'Sender: a@example.com', 'Sender: b@example.com'], ['sender']],
                [
                    ['From: a b@example.com', 'Sender: x y@example.com'],
                    ['from', 'sender']
                ]
            ];
            for (const [lines, properties] of cases) {
                const err = errorOf(() => envelopes.messageAddresses(fields(lines)));
                expect(err.type).to.equal('invalidEmail');
                expect(err.extra.properties).to.deep.equal(properties);
            }
        });

        it('reads UTF-8 header values as text', () => {
            const raw = Buffer.from('To: üser@example.net').toString('binary');
            const result = envelopes.messageAddresses(fields(['From: a@example.com', raw]));
            expect(result.recipients.map(entry => entry.email)).to.deep.equal(['üser@example.net']);
            expect(result.invalidRecipients).to.deep.equal([]);
        });

        it('refuses a group in From and Sender (RFC 5322 3.6.2)', () => {
            const cases = [
                [['From: Team: a@example.com;', 'To: t@example.net'], ['from']],
                [['From: undisclosed-recipients:;', 'To: t@example.net'], ['from']],
                [['From: a@example.com', 'Sender: Team: s@example.com;', 'To: t@example.net'], ['sender']]
            ];
            for (const [lines, properties] of cases) {
                const err = errorOf(() => envelopes.messageAddresses(fields(lines)));
                expect(err.type).to.equal('invalidEmail');
                expect(err.extra.properties).to.deep.equal(properties);
            }
            // a group stays allowed among the recipients
            const result = envelopes.messageAddresses(fields(['From: a@example.com', 'To: Team: t@example.net;']));
            expect(result.recipients.map(entry => entry.email)).to.deep.equal(['t@example.net']);
        });

        it('keeps the first spelling of a repeated recipient', () => {
            const list = envelopes.parseAddressList('x@example.net, X@Example.NET, y@example.net').addresses;
            expect(envelopes.uniqueRecipients(list).map(entry => entry.email)).to.deep.equal(['x@example.net', 'y@example.net']);
        });
    });

    describe('checkEnvelope', () => {
        it('accepts the Envelope shape', () => {
            const envelope = envelopes.checkEnvelope({
                mailFrom: { email: 'a@example.com', parameters: { HOLDFOR: '60' } },
                rcptTo: [{ email: 'b@example.com', parameters: {} }]
            });
            expect(envelope.mailFrom).to.deep.equal({ email: 'a@example.com', parameters: { HOLDFOR: '60' } });
        });

        it('rejects other shapes, recipient parameters and malformed parameters', () => {
            const mailFrom = { email: 'a@example.com' };
            const rcptTo = [{ email: 'b@example.com' }];
            const bad = [
                null,
                'x',
                { mailFrom },
                { rcptTo },
                { mailFrom, rcptTo, other: 1 },
                { mailFrom: { email: 1 }, rcptTo },
                { mailFrom, rcptTo: [{ email: 'b@example.com', parameters: { NOTIFY: 'NEVER' } }] },
                { mailFrom: { email: 'a@example.com', parameters: { 'A B': '1' } }, rcptTo },
                { mailFrom: { email: 'a@example.com', parameters: { A: 1 } }, rcptTo },
                { mailFrom: { email: 'a@example.com', parameters: { A: 'x\r\ny' } }, rcptTo },
                { mailFrom: { email: 'a@example.com', parameters: { A: 'x=y' } }, rcptTo }
            ];
            for (const envelope of bad) {
                const err = errorOf(() => envelopes.checkEnvelope(envelope));
                expect(err.type, JSON.stringify(envelope)).to.equal('invalidProperties');
                expect(err.extra.properties).to.deep.equal(['envelope']);
            }
        });
    });

    describe('releaseTime', () => {
        const now = new Date('2026-11-11T10:00:00.000Z');
        const options = { now, maxDelayedSend: 3600 };

        it('holds for a number of seconds or until a time, a past time sends at once', () => {
            expect(envelopes.releaseTime(null, options)).to.equal(now);
            expect(envelopes.releaseTime({ holdfor: '60' }, options).toISOString()).to.equal('2026-11-11T10:01:00.000Z');
            expect(envelopes.releaseTime({ HOLDFOR: '3600' }, options).toISOString()).to.equal('2026-11-11T11:00:00.000Z');
            expect(envelopes.releaseTime({ HoldUntil: '2026-11-11T10:30:00Z' }, options).toISOString()).to.equal('2026-11-11T10:30:00.000Z');
            expect(envelopes.releaseTime({ HOLDUNTIL: '2026-11-11T09:00:00Z' }, options)).to.equal(now);
            expect(envelopes.releaseTime({ HOLDFOR: '0' }, { now, maxDelayedSend: 0 }).getTime()).to.equal(now.getTime());
        });

        it('rejects other parameters, malformed values and holds beyond the limit', () => {
            const bad = [
                { SIZE: '100' },
                { HOLDFOR: '60', HOLDUNTIL: '2026-11-11T10:30:00Z' },
                { HOLDFOR: '60', holdfor: '60' },
                { HOLDFOR: '-1' },
                { HOLDFOR: '' },
                { HOLDFOR: null },
                { HOLDFOR: '1.5' },
                { HOLDFOR: '3601' },
                { HOLDUNTIL: '2026-11-11T10:30:00' },
                { HOLDUNTIL: '2026-11-11T11:00:01Z' },
                { HOLDUNTIL: null }
            ];
            for (const parameters of bad) {
                const err = errorOf(() => envelopes.releaseTime(parameters, options));
                expect(err.type, JSON.stringify(parameters)).to.equal('invalidProperties');
            }
        });
    });
});

describe('JMAP EmailSubmission/query translation', () => {
    it('turns filters into MongoDB conditions', () => {
        expect(filterQuery(null)).to.deep.equal({});
        expect(filterQuery({ identityIds: ['I1'], undoStatus: 'pending', after: '2026-11-11T10:00:00Z' })).to.deep.equal({
            identityId: { $in: ['I1'] },
            undoStatus: 'pending',
            sendAt: { $gte: new Date('2026-11-11T10:00:00Z') }
        });
        expect(filterQuery({ operator: 'NOT', conditions: [{ emailIds: ['M1'] }] })).to.deep.equal({ $nor: [{ emailId: { $in: ['M1'] } }] });
        expect(filterQuery({ operator: 'OR', conditions: [] })).to.deep.equal({ _id: { $exists: false } });
    });

    it('rejects malformed filters', () => {
        for (const filter of [1, [], { bogus: 1 }, { identityIds: 'I1' }, { before: 'today' }, { operator: 'XOR', conditions: [] }, { operator: 'AND' }]) {
            expect(errorOf(() => filterQuery(filter)).type, JSON.stringify(filter)).to.equal('invalidArguments');
        }
    });

    it('sorts by emailId, threadId and sentAt with the id as the last key', () => {
        expect(sortOf(null)).to.deep.equal({ _id: 1 });
        expect(sortOf([{ property: 'threadId' }, { property: 'sentAt', isAscending: false }])).to.deep.equal({ threadId: 1, sendAt: -1, _id: 1 });
        expect(errorOf(() => sortOf([{ property: 'undoStatus' }])).type).to.equal('unsupportedSort');
        expect(errorOf(() => sortOf([{ isAscending: true }])).type).to.equal('invalidArguments');
    });
});
