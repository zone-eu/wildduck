/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const imapHandler = require('../lib/handler/imap-handler');
const expect = chai.expect;
chai.config.includeStack = true;

describe('IMAP Command Compiler', function () {
    describe('#compile', function () {
        it('should compile correctly', function () {
            let command =
                    '* FETCH (ENVELOPE ("Mon, 2 Sep 2013 05:30:13 -0700 (PDT)" NIL ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "tr.ee")) NIL NIL NIL "<-4730417346358914070@unknownmsgid>") BODYSTRUCTURE (("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 105 (NIL NIL ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "pangalink.net")) NIL NIL "<test1>" NIL) ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 12 0 NIL NIL NIL) 5 NIL NIL NIL)("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 83 (NIL NIL ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "kreata.ee")) ((NIL NIL "andris" "pangalink.net")) NIL NIL "NIL" NIL) ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 12 0 NIL NIL NIL) 4 NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 19 0 NIL NIL NIL) "MIXED" ("BOUNDARY" "----mailcomposer-?=_1-1328088797399") NIL NIL))',
                parsed = imapHandler.parser(command, {
                    allowUntagged: true
                }),
                compiled = imapHandler.compiler(parsed);

            expect(compiled).to.equal(command);
        });
    });

    describe('Types', function () {
        let parsed;

        beforeEach(function () {
            parsed = {
                tag: '*',
                command: 'CMD'
            };
        });

        describe('No attributes', function () {
            it('should compile correctly', function () {
                expect(imapHandler.compiler(parsed)).to.equal('* CMD');
            });
        });

        describe('TEXT', function () {
            it('should compile correctly', function () {
                parsed.attributes = [
                    {
                        type: 'TEXT',
                        value: 'Tere tere!'
                    }
                ];
                expect(imapHandler.compiler(parsed)).to.equal('* CMD Tere tere!');
            });
        });

        describe('SECTION', function () {
            it('should compile correctly', function () {
                parsed.attributes = [
                    {
                        type: 'SECTION',
                        section: [
                            {
                                type: 'ATOM',
                                value: 'ALERT'
                            }
                        ]
                    }
                ];
                expect(imapHandler.compiler(parsed)).to.equal('* CMD [ALERT]');
            });
        });

        describe('ATOM', function () {
            it('should compile correctly', function () {
                parsed.attributes = [
                    //
                    {
                        type: 'ATOM',
                        value: 'ALERT'
                    },
                    {
                        type: 'ATOM',
                        value: '\\ALERT'
                    },
                    {
                        type: 'ATOM',
                        value: 'NO ALERT'
                    }
                ];
                expect(imapHandler.compiler(parsed)).to.equal('* CMD ALERT \\ALERT "NO ALERT"');
            });
        });

        describe('SEQUENCE', function () {
            it('should compile correctly', function () {
                parsed.attributes = [
                    {
                        type: 'SEQUENCE',
                        value: '*:4,5,6'
                    }
                ];
                expect(imapHandler.compiler(parsed)).to.equal('* CMD *:4,5,6');
            });
        });

        describe('NIL', function () {
            it('should compile correctly', function () {
                parsed.attributes = [null, null];

                expect(imapHandler.compiler(parsed)).to.equal('* CMD NIL NIL');
            });
        });

        describe('TEXT', function () {
            it('should compile correctly', function () {
                parsed.attributes = [
                    // keep indentation
                    {
                        type: 'String',
                        value: 'Tere tere!',
                        sensitive: true
                    },
                    'Vana kere'
                ];

                expect(imapHandler.compiler(parsed)).to.equal('* CMD "Tere tere!" "Vana kere"');
            });

            it('should keep short strings', function () {
                parsed.attributes = [
                    // keep indentation
                    {
                        type: 'String',
                        value: 'Tere tere!'
                    },
                    'Vana kere'
                ];

                expect(imapHandler.compiler(parsed, false, true)).to.equal('* CMD "Tere tere!" "Vana kere"');
            });

            it('should hide strings', function () {
                parsed.attributes = [
                    // keep indentation
                    {
                        type: 'String',
                        value: 'Tere tere!',
                        sensitive: true
                    },
                    'Vana kere'
                ];

                expect(imapHandler.compiler(parsed, false, true)).to.equal('* CMD "(* value hidden *)" "Vana kere"');
            });

            it('should hide long strings', function () {
                parsed.attributes = [
                    // keep indentation
                    {
                        type: 'String',
                        value: 'Tere tere! Tere tere! Tere tere! Tere tere! Tere tere!'
                    },
                    'Vana kere'
                ];

                expect(imapHandler.compiler(parsed, false, true)).to.equal('* CMD "(* 54B string *)" "Vana kere"');
            });
        });

        describe('No Command', function () {
            it('should compile correctly', function () {
                parsed = {
                    tag: '*',
                    attributes: [
                        1,
                        {
                            type: 'ATOM',
                            value: 'EXPUNGE'
                        }
                    ]
                };

                expect(imapHandler.compiler(parsed)).to.equal('* 1 EXPUNGE');
            });
        });
        describe('Literal', function () {
            it('should return as text', function () {
                let parsed = {
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        // keep indentation
                        {
                            type: 'LITERAL',
                            value: 'Tere tere!'
                        },
                        'Vana kere'
                    ]
                };

                expect(imapHandler.compiler(parsed)).to.equal('* CMD {10}\r\nTere tere! "Vana kere"');
            });

            it('should return as an array text 1', function () {
                let parsed = {
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        {
                            type: 'LITERAL',
                            value: 'Tere tere!'
                        },
                        {
                            type: 'LITERAL',
                            value: 'Vana kere'
                        }
                    ]
                };
                expect(imapHandler.compiler(parsed, true)).to.deep.equal(['* CMD {10}\r\n', 'Tere tere! {9}\r\n', 'Vana kere']);
            });

            it('should return as an array text 2', function () {
                let parsed = {
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        // keep indentation
                        {
                            type: 'LITERAL',
                            value: 'Tere tere!'
                        },
                        {
                            type: 'LITERAL',
                            value: 'Vana kere'
                        },
                        'zzz'
                    ]
                };
                expect(imapHandler.compiler(parsed, true)).to.deep.equal(['* CMD {10}\r\n', 'Tere tere! {9}\r\n', 'Vana kere "zzz"']);
            });

            it('should compile correctly without tag and command', function () {
                let parsed = {
                    attributes: [
                        {
                            type: 'LITERAL',
                            value: 'Tere tere!'
                        },
                        {
                            type: 'LITERAL',
                            value: 'Vana kere'
                        }
                    ]
                };
                expect(imapHandler.compiler(parsed, true)).to.deep.equal(['{10}\r\n', 'Tere tere! {9}\r\n', 'Vana kere']);
            });

            it('should return byte length', function () {
                let parsed = {
                    tag: '*',
                    command: 'CMD',
                    attributes: [
                        // keep indentation
                        {
                            type: 'LITERAL',
                            value: 'Tere tere!'
                        },
                        'Vana kere'
                    ]
                };

                expect(imapHandler.compiler(parsed, false, true)).to.equal('* CMD "(* 10B literal *)" "Vana kere"');
            });
        });
    });
});

describe('IMAP Quoting', function () {
    it('should not use JSON escapes inside a quoted string', function () {
        // RFC 3501 9: QUOTED-CHAR = <any TEXT-CHAR except quoted-specials> / "\" quoted-specials,
        // so a TAB or a control character stands for itself and only " and \ are escaped
        expect(imapHandler.compiler({ tag: '*', command: 'CMD', attributes: [{ type: 'STRING', value: 'a\tb' }] })).to.equal('* CMD "a\tb"');

        expect(imapHandler.compiler({ tag: '*', command: 'CMD', attributes: [{ type: 'STRING', value: 'e\u0001f' }] })).to.equal('* CMD "e\u0001f"');

        expect(imapHandler.compiler({ tag: '*', command: 'CMD', attributes: [{ type: 'STRING', value: 'q"u\\x' }] })).to.equal('* CMD "q\\"u\\\\x"');

        expect(imapHandler.compiler({ tag: '*', command: 'CMD', attributes: ['a\tb'] })).to.equal('* CMD "a\tb"');
    });

    it('should send a value with CR or LF as a literal', function () {
        // RFC 3501 4.3: a quoted string excludes CR and LF
        expect(imapHandler.compiler({ tag: '*', command: 'CMD', attributes: [{ type: 'STRING', value: 'c\nd' }] })).to.equal('* CMD {3}\r\nc\nd');

        expect(imapHandler.compiler({ tag: '*', command: 'CMD', attributes: ['c\r\nd', 'tail'] })).to.equal('* CMD {4}\r\nc\r\nd "tail"');
    });

    it('should drop the NUL character', function () {
        // RFC 3501 9: "The ASCII NUL character, %x00, MUST NOT be used at any time"
        expect(imapHandler.compiler({ tag: '*', command: 'CMD', attributes: [{ type: 'STRING', value: 'a\u0000b' }] })).to.equal('* CMD "ab"');
    });

    it('should quote an ATOM value that is not a valid atom without JSON escapes', function () {
        expect(imapHandler.compiler({ tag: '*', command: 'CMD', attributes: [{ type: 'ATOM', value: 'a]b' }] })).to.equal('* CMD "a]b"');

        expect(imapHandler.compiler({ tag: '*', command: 'CMD', attributes: [{ type: 'ATOM', value: 'a\tb' }] })).to.equal('* CMD "a\tb"');
    });
});
