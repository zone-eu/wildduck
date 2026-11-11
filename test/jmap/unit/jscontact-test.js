/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { validateCard, escapeToken, isVendor } = require('../../../lib/schemas/jscontact');

const card = extra => Object.assign({ '@type': 'Card', version: '1.0', uid: 'urn:uuid:22B2C7DF-9120-4969-8460-05956FE6B065' }, extra);
const valid = extra => expect(validateCard(card(extra)), JSON.stringify(extra)).to.deep.equal([]);
const invalid = (extra, paths) => expect(validateCard(card(extra)).sort(), JSON.stringify(extra)).to.deep.equal([].concat(paths).sort());

describe('JSContact validation (RFC 9553)', () => {
    describe('the examples of RFC 9553', () => {
        it('Figure 6: a basic card', () => {
            valid({
                kind: 'individual',
                name: {
                    components: [
                        { kind: 'given', value: 'John' },
                        { kind: 'surname', value: 'Doe' }
                    ],
                    isOrdered: true
                }
            });
        });

        it('Figures 7 to 15: the metadata properties', () => {
            valid({
                created: '2022-09-30T14:35:10Z',
                updated: '2021-10-31T22:27:10Z',
                kind: 'group',
                language: 'de-AT',
                prodId: 'ACME Contacts App version 1.23.5',
                members: { 'urn:uuid:03a0e51f-d1aa-4385-8a53-e29025acd8af': true, 'urn:uuid:b8767877-b4a1-4c70-9acc-505d3819e519': true },
                relatedTo: {
                    'urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6': { relation: { friend: true } },
                    '8cacdfb7d1ffdb59@example.com': { relation: {} }
                }
            });
        });

        it('Figure 19: sortAs', () => {
            valid({
                name: {
                    components: [
                        { kind: 'given', value: 'Robert' },
                        { kind: 'given2', value: 'Pau' },
                        { kind: 'surname', value: 'Shou Chang' }
                    ],
                    sortAs: { surname: 'Pau Shou Chang', given: 'Robert' },
                    isOrdered: true
                }
            });
        });

        it('Figure 20: phonetic data in a localization that patches array members', () => {
            valid({
                language: 'zh-Hant',
                name: {
                    components: [
                        { kind: 'surname', value: '孫' },
                        { kind: 'given', value: '中山' },
                        { kind: 'given2', value: '文' },
                        { kind: 'given2', value: '逸仙' }
                    ]
                },
                localizations: {
                    yue: {
                        'name/phoneticSystem': 'jyut',
                        'name/phoneticScript': 'Latn',
                        'name/components/0/phonetic': 'syun1',
                        'name/components/1/phonetic': 'zung1saan1',
                        'name/components/2/phonetic': 'man4',
                        'name/components/3/phonetic': 'jat6sin1'
                    }
                }
            });
        });

        it('Figures 21 to 24: nicknames, organizations, speakToAs and titles', () => {
            valid({
                nicknames: { k391: { name: 'Johnny' } },
                organizations: {
                    o1: { name: 'ABC, Inc.', units: [{ name: 'North American Division' }, { name: 'Marketing' }], sortAs: 'ABC' },
                    o2: { name: 'ABC, Inc.' }
                },
                speakToAs: { grammaticalGender: 'neuter', pronouns: { k19: { pronouns: 'they/them', pref: 2 }, k32: { pronouns: 'xe/xir', pref: 1 } } },
                titles: { le9: { kind: 'title', name: 'Research Scientist' }, k2: { kind: 'role', name: 'Project Leader', organizationId: 'o2' } }
            });
        });

        it('Figures 25 to 30: contact and scheduling properties', () => {
            valid({
                emails: { e1: { contexts: { work: true }, address: 'jqpublic@xyz.example.com' }, e2: { address: 'jane_doe@example.com', pref: 1 } },
                onlineServices: {
                    x1: { uri: 'xmpp:alice@example.com' },
                    x2: { service: 'Mastodon', user: '@alice@example2.com', uri: 'https://example2.com/@alice' }
                },
                phones: {
                    tel0: { contexts: { private: true }, features: { voice: true }, number: 'tel:+1-555-555-5555;ext=5555', pref: 1 },
                    tel3: { contexts: { work: true }, number: 'tel:+1-201-555-0123' }
                },
                preferredLanguages: {
                    l1: { language: 'en', contexts: { work: true }, pref: 1 },
                    l2: { language: 'fr', contexts: { work: true }, pref: 2 },
                    l3: { language: 'fr', contexts: { private: true } }
                },
                calendars: {
                    calA: { kind: 'calendar', uri: 'webcal://calendar.example.com/calA.ics' },
                    'project-a': { kind: 'freeBusy', uri: 'https://calendar.example.com/busy/project-a' }
                },
                schedulingAddresses: { sched1: { uri: 'mailto:janedoe@example.com' } }
            });
        });

        it('Figures 31 and 33: addresses with separators and a localization', () => {
            valid({
                addresses: {
                    k23: {
                        contexts: { work: true },
                        components: [
                            { kind: 'number', value: '54321' },
                            { kind: 'separator', value: ' ' },
                            { kind: 'name', value: 'Oak St' },
                            { kind: 'locality', value: 'Reston' },
                            { kind: 'region', value: 'VA' },
                            { kind: 'separator', value: ' ' },
                            { kind: 'postcode', value: '20190' },
                            { kind: 'country', value: 'USA' }
                        ],
                        countryCode: 'US',
                        defaultSeparator: ', ',
                        isOrdered: true
                    },
                    k26: {
                        components: [
                            { kind: 'block', value: '2-7' },
                            { kind: 'separator', value: '-' },
                            { kind: 'number', value: '2' },
                            { kind: 'postcode', value: '100-8994' }
                        ],
                        defaultSeparator: ', ',
                        full: '2-7-2 Marunouchi, Chiyoda-ku, Tokyo 100-8994',
                        isOrdered: true
                    }
                },
                localizations: {
                    jp: {
                        'addresses/k26': {
                            components: [
                                { kind: 'region', value: '東京都' },
                                { kind: 'postcode', value: '〒100-8994' }
                            ],
                            defaultSeparator: '',
                            full: '〒100-8994東京都千代田区丸ノ内2-7-2',
                            isOrdered: true
                        }
                    }
                }
            });
        });

        it('Figures 34 to 38: resources', () => {
            valid({
                cryptoKeys: {
                    mykey1: { uri: 'https://www.example.com/keys/jdoe.cer' },
                    mykey2: {
                        uri: 'data:application/pgp-keys;base64,LS0tLS1CRUdJTiBSU0EgUFVCTElDIEtFWS0tLS0tCk1JSUJDZ0tDQVFFQSt4R1ovd2N6OXVnRnBQMDdOc3BvNlUxN2wwWWhGaUZweHhVNHBUazNMaWZ6OVIzenNJc3UKRVJ3dGE3K2ZXSWZ4T28yMDhldHQvamhza2lWb2RTRXQzUUJHaDRYQmlweVdvcEt3WjkzSEhhRFZaQUFMaS8yQQorWHhUdFlnZ0lJeDNHdG1Ua2VWYXRITVVpOFkyRUNkWmFBRUlJMWN3VUtNV1A2SHVuVGdpUmtEbE5QaHYxcG1qCk9xeGxCbU9UNkU4WGZPcEZwSXZNQS9DdG9ra2RrTlZMN3pyakFHNnBkVytKcVp1NWlGWVpGbXFOWFMzWjN1ZUsKKzdyM2ovOEdZQk9GaUZXR2ZYNjdsdlhBbzZGemFJOVFNOXUxOEhWQ3gzMVFUYWxTMENrd0hrVHM2NjJQSGhvdApCVWJvRUhTOHZxcnBQOFdYNWtnTkpIRE5Rd0lEQVFBQgotLS0tLUVORCBSU0EgUFVCTElDIEtFWS0tLS0tCg=='
                    }
                },
                directories: {
                    dir1: { kind: 'entry', uri: 'https://dir.example.com/addrbook/jdoe/Jean%20Dupont.vcf' },
                    dir2: { kind: 'directory', uri: 'ldap://ldap.example/o=Example%20Tech,ou=Engineering', pref: 1 }
                },
                links: { link3B: { kind: 'contact', uri: 'mailto:contact@example.com', pref: 1 } },
                media: {
                    res45: { kind: 'sound', uri: 'CID:JOHNQ.part8.19960229T080000.xyzMail@example.com' },
                    res47: { kind: 'logo', uri: 'https://www.example.com/pub/logos/abccorp.jpg' },
                    res1: {
                        kind: 'photo',
                        uri: 'data:image/jpeg;base64,MIICajCCAdOgAwIBAgICBEUwDQYJKoZIhvAQEEBQAwdzELMAkGA1UEBhMCVVMxLDAqBgNVBAoTI05ldHNjYXBlIENvbW11bmljYXRpb25zIENvcnBvcmF0aW9uMRwwGgYDVQQLExNJbmZvcm1hdGlvbiBTeXN0'
                    }
                }
            });
        });

        it('Figures 39 to 44: localizations, anniversaries, keywords, notes and personal information', () => {
            valid({
                name: { full: 'Gabriel García Márquez' },
                titles: { t1: { kind: 'title', name: 'novelist' } },
                localizations: { es: { 'titles/t1/name': 'escritor' } },
                anniversaries: {
                    k8: { kind: 'birth', date: { year: 1953, month: 4, day: 15 } },
                    k9: {
                        kind: 'death',
                        date: { '@type': 'Timestamp', utc: '2019-10-15T23:10:00Z' },
                        place: { full: '4445 Tree Street\nNew England, ND 58647\nUSA' }
                    }
                },
                keywords: { internet: true, IETF: true },
                notes: { n1: { note: 'Open office hours are 1600 to 1715 EST, Mon-Fri', created: '2022-11-23T15:01:32Z', author: { name: 'John' } } },
                personalInfo: {
                    pi2: { kind: 'expertise', value: 'chemistry', level: 'high' },
                    pi1: { kind: 'hobby', value: 'reading', level: 'high' },
                    pi6: { kind: 'interest', value: 'r&b music', level: 'medium' }
                }
            });
        });
    });

    describe('invalid cards', () => {
        it('needs @type, version and uid', () => {
            expect(validateCard({}).sort()).to.deep.equal(['@type', 'uid', 'version']);
            expect(validateCard('card')).to.deep.equal(['']);
            invalid({ '@type': 'card' }, '@type');
            invalid({ version: '2.0' }, 'version');
        });

        it('rejects reserved, case variant and malformed property names', () => {
            invalid({ extra: 1 }, 'extra');
            invalid({ Name: { full: 'x' } }, 'Name');
            invalid({ 'example.com:a/b': 1 }, 'example.com:a~1b');
            invalid({ 'not a name': 1 }, 'not a name');
            valid({ futureProp: 1, 'example.com:any thing': { x: [1] } });
        });

        it('checks the rules between properties of a Name', () => {
            invalid({ name: {} }, 'name');
            invalid({ name: { components: [{ kind: 'separator', value: '-' }], isOrdered: true } }, 'name/components');
            invalid(
                {
                    name: {
                        components: [
                            { kind: 'given', value: 'A' },
                            { kind: 'separator', value: '-' }
                        ]
                    }
                },
                'name/components/1/kind'
            );
            invalid({ name: { full: 'A', defaultSeparator: ' ' } }, 'name/defaultSeparator');
            invalid({ name: { components: [{ kind: 'given', value: 'A' }], sortAs: { surname: 'B' } } }, 'name/sortAs');
            invalid({ name: { components: [{ kind: 'given', value: 'A', phonetic: 'a' }] } }, 'name/components/0/phonetic');
        });

        it('checks partial dates', () => {
            invalid({ anniversaries: { a: { kind: 'birth', date: { day: 5 } } } }, 'anniversaries/a/date/day');
            invalid({ anniversaries: { a: { kind: 'birth', date: { month: 5 } } } }, 'anniversaries/a/date/month');
            invalid({ anniversaries: { a: { kind: 'birth', date: {} } } }, 'anniversaries/a/date');
            invalid({ anniversaries: { a: { kind: 'birth', date: { utc: '2019-10-15T23:10:00Z' } } } }, 'anniversaries/a/date');
            invalid({ anniversaries: { a: { kind: 'birth', date: { '@type': 'Timestamp' } } } }, 'anniversaries/a/date/utc');
        });

        it('checks UTCDateTime values', () => {
            invalid({ created: '2024-01-02T03:04:05.000Z' }, 'created');
            invalid({ created: '2024-02-30T03:04:05Z' }, 'created');
            valid({ created: '2024-01-02T03:04:05.5Z' });
        });

        it('checks members, media and localizations', () => {
            invalid({ members: { u: true } }, 'members');
            invalid({ media: { m: { kind: 'photo', blobId: 'Bc1' } } }, 'media/m/blobId');
            expect(validateCard(card({ media: { m: { kind: 'photo', blobId: 'Bc1' } } }), { blobIds: true })).to.deep.equal([]);
            invalid({ media: { m: { kind: 'photo' } } }, 'media/m/uri');
            invalid({ titles: { t1: { name: 'Boss' } }, localizations: { de: { 'titles/t1/name': 5 } } }, 'localizations/de/titles~1t1~1name');
            invalid({ localizations: { de: { 'localizations/fr': {} } } }, 'localizations/de/localizations~1fr');
            invalid({ localizations: { de: { 'titles/t9/name': 'x' } } }, 'localizations/de');
        });

        it('rejects control characters in text', () => {
            invalid({ notes: { n: { note: 'bell\u0007' } } }, 'notes/n/note');
            valid({ notes: { n: { note: 'tab\tline\r\nend' } } });
        });

        it('reports every invalid property', () => {
            invalid({ kind: 'nonsense', emails: { e1: {} }, phones: { p1: { number: 5 } } }, ['kind', 'emails/e1/address', 'phones/p1/number']);
        });
    });

    describe('helpers', () => {
        it('escapes pointer tokens', () => {
            expect(escapeToken('a/b~c')).to.equal('a~1b~0c');
        });

        it('recognises vendor names', () => {
            expect(isVendor('example.com:foo')).to.be.true;
            expect(isVendor('ex-ample.co.uk:foo bar')).to.be.true;
            expect(isVendor(':foo')).to.be.false;
            expect(isVendor('example.com:a/b')).to.be.false;
            expect(isVendor('example.com:a~b')).to.be.false;
        });
    });
});
