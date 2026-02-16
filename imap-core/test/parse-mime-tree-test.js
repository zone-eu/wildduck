/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const MIMEParser = require('../lib/indexer/parse-mime-tree').MIMEParser;
const Indexer = require('../lib/indexer/indexer');
const libmime = require('libmime');
const indexer = new Indexer();

const fs = require('fs');
const chai = require('chai');
const expect = chai.expect;
chai.config.includeStack = true;

const fixtures = {
    no_empty_line_between_text_boundary: {
        eml: fs.readFileSync(__dirname + '/fixtures/no_empty_line_between_text_boundary.eml')
    }
};

function unfoldHeaders(headers) {
    return (headers || '').replace(/\r?\n[ \t]+/g, ' ');
}

function getHeaderValue(headers, key) {
    let target = key.toLowerCase();
    let lines = unfoldHeaders(headers).split(/\r?\n/);

    for (let line of lines) {
        if (!line || !line.trim()) {
            continue;
        }

        let pos = line.indexOf(':');
        if (pos < 0) {
            continue;
        }

        let headerKey = line.slice(0, pos).trim().toLowerCase();
        if (headerKey !== target) {
            continue;
        }

        return line.slice(pos + 1).trim();
    }

    return '';
}

function decodeWordsSafe(value) {
    value = (value || '').toString();

    try {
        return libmime.decodeWords(value).trim();
    } catch {
        return value.trim();
    }
}

function detectSource(headerValue, baseName) {
    if (!headerValue) {
        return null;
    }

    if (new RegExp(`\\b${baseName}\\*0\\*\\s*=`, 'i').test(headerValue)) {
        return `${baseName}*0*`;
    }

    if (new RegExp(`\\b${baseName}\\*0(?!\\d)\\s*=`, 'i').test(headerValue)) {
        return `${baseName}*0`;
    }

    if (new RegExp(`\\b${baseName}\\*(?!\\d)\\s*=`, 'i').test(headerValue)) {
        return `${baseName}*`;
    }

    if (new RegExp(`\\b${baseName}\\s*=`, 'i').test(headerValue)) {
        return baseName;
    }

    return null;
}

function mapContentTypeSource(source) {
    if (!source) {
        return null;
    }

    switch (source) {
        case 'name':
            return 'content-type-name';
        case 'name*':
            return 'content-type-name*';
        case 'name*0':
            return 'content-type-name*0';
        case 'name*0*':
            return 'content-type-name*0*';
        default:
            return null;
    }
}

// Uses the existing MIMEParser for parameter parsing. This helper only picks
// Content-Disposition/Content-Type and decodes the parser output like indexer does.
function parseFilename(headers) {
    let parser = new MIMEParser();

    let dispositionValue = getHeaderValue(headers, 'content-disposition');
    if (dispositionValue) {
        let parsedDisposition = parser.parseValueParams(dispositionValue);
        let filenameToken = parsedDisposition && parsedDisposition.params && parsedDisposition.params.filename;
        if (filenameToken) {
            return {
                filename: decodeWordsSafe(filenameToken),
                source: detectSource(dispositionValue, 'filename')
            };
        }
    }

    let contentTypeValue = getHeaderValue(headers, 'content-type');
    if (contentTypeValue) {
        let parsedContentType = parser.parseValueParams(contentTypeValue);
        let nameToken = parsedContentType && parsedContentType.params && parsedContentType.params.name;
        if (nameToken) {
            return {
                filename: decodeWordsSafe(nameToken),
                source: mapContentTypeSource(detectSource(contentTypeValue, 'name'))
            };
        }
    }

    return {
        filename: null,
        source: null
    };
}

function percentEncodeByEncoding(value, encoding) {
    return Array.from(Buffer.from(value, encoding))
        .map(byte => '%' + byte.toString(16).toUpperCase().padStart(2, '0'))
        .join('');
}

function splitRawInTwo(value) {
    let mid = Math.max(1, Math.floor(value.length / 2));
    return [value.slice(0, mid), value.slice(mid)];
}

function splitPercentEncodedInTwo(encoded) {
    let bytes = encoded.match(/%[0-9A-F]{2}/g) || [];
    let mid = Math.max(1, Math.floor(bytes.length / 2));
    return [bytes.slice(0, mid).join(''), bytes.slice(mid).join('')];
}

function expectedFromDeclaredCharset(value, scenario) {
    // Mirrors current libmime behavior through encoded-words used by MIMEParser:
    // UTF-8 -> utf8 bytes; ISO-8859-1 and US-ASCII currently decode leniently as latin1.
    return Buffer.from(value, scenario.bufferEncoding).toString(scenario.outputEncoding);
}

describe('#parseValueParams', function () {
    it('should return continuation value as mime-word', function () {
        let parser = new MIMEParser();
        const parsed = parser.parseValueParams(
            'text/plain;\n' +
                '\tname*0=emailengine_uuendamise_kasud_ja_muud_asjad_ja_veelgi_pikem_pealk;\n' +
                '\tname*1=iri.txt;\n' +
                '\tx-apple-part-url=99AFDE83-8953-43B4-BE59-F59D6160AFAB'
        );

        expect(parsed).to.deep.equal({
            value: 'text/plain',
            type: 'text',
            subtype: 'plain',
            params: {
                'x-apple-part-url': '99AFDE83-8953-43B4-BE59-F59D6160AFAB',
                name: '=?UTF-8?Q?emailengine_uuendamise_kasud_ja_muud_asjad_ja_veelgi_pikem_pealkiri.txt?='
            },
            hasParams: true
        });
    });

    it('should return continuation value as mime-word', function () {
        let parser = new MIMEParser();
        const parsed = parser.parseValueParams('image/jpeg; name="=?UTF-8?Q?sw=C3=A4n=2Ejpg?="');

        expect(parsed).to.deep.equal({
            value: 'image/jpeg',
            type: 'image',
            subtype: 'jpeg',
            params: {
                name: '=?UTF-8?Q?sw=C3=A4n=2Ejpg?='
            },
            hasParams: true
        });
    });

    it('should parse single filename* value with charset and language', function () {
        let parser = new MIMEParser();
        const parsed = parser.parseValueParams("attachment; filename*=utf-8''n%C3%B5usoleku%20vorm.docx");

        expect(parsed).to.deep.equal({
            value: 'attachment',
            type: 'attachment',
            subtype: '',
            params: {
                filename: '=?UTF-8?Q?n=C3=B5usoleku=20vorm.docx?='
            },
            hasParams: true
        });
    });

    it('should parse a file with no empty line between text and boundary', function (done) {
        // parse a file and then make sure that boundary is correct

        let source = Buffer.concat([fixtures.no_empty_line_between_text_boundary.eml]);

        let parser = new MIMEParser(source);

        parser.parse();
        parser.finalizeTree();

        let parsed = parser.tree.childNodes[0];

        indexer.bodyQuery(parsed, '', (err, data) => {
            expect(err).to.not.exist;
            expect(data.toString().indexOf('This is a multi-part message in MIME format.\r\n--------------cWFvDSey27tFG0hVYLqp9hs9')).to.gt(0);
            done();
        });
    });
});

describe('#parseFilename (MIMEParser-driven)', function () {
    const filenames = ['report.txt', 'résumé.pdf', 'Ångström.txt', 'mañana.txt', '中文文件名.txt', 'ПримерФайл.txt'];

    const scenarios = [
        {
            token: 'UTF-8',
            bufferEncoding: 'utf8',
            outputEncoding: 'utf8'
        },
        {
            token: 'ISO-8859-1',
            bufferEncoding: 'latin1',
            outputEncoding: 'latin1'
        },
        {
            token: 'US-ASCII',
            bufferEncoding: 'latin1',
            outputEncoding: 'latin1'
        }
    ];

    scenarios.forEach(scenario => {
        describe(`charset ${scenario.token}`, function () {
            filenames.forEach(filename => {
                let expectedExtended = expectedFromDeclaredCharset(filename, scenario);
                let encoded = percentEncodeByEncoding(filename, scenario.bufferEncoding);
                let encodedParts = splitPercentEncodedInTwo(encoded);
                let rawParts = splitRawInTwo(filename);
                // eslint-disable-next-line no-control-regex
                let nonLatin1 = /[^\u0000-\u00ff]/.test(filename);
                let strictExtendedChecks = !(scenario.token !== 'UTF-8' && nonLatin1);

                // A) Classical parameter
                it(`[A] filename= for ${filename}`, function () {
                    let headers = `Content-Disposition: attachment; filename="${filename}"`;
                    expect(parseFilename(headers)).to.deep.equal({
                        filename,
                        source: 'filename'
                    });
                });

                // C) RFC5987/RFC6266 filename*
                it(`[C] filename*= for ${filename}`, function () {
                    let headers = `Content-Disposition: attachment; filename*=${scenario.token}''${encoded}`;
                    let result = parseFilename(headers);

                    if (strictExtendedChecks) {
                        expect(result).to.deep.equal({
                            filename: expectedExtended,
                            source: 'filename*'
                        });
                    } else {
                        expect(result.source).to.equal('filename*');
                        expect(result.filename).to.be.a('string');
                        expect(result.filename.length).to.be.gt(0);
                    }
                });

                // C) Extended + classical fallback present
                it(`[C + fallback] filename*= overrides filename= for ${filename}`, function () {
                    let headers = `Content-Disposition: attachment; filename="ascii-fallback.txt"; filename*=${scenario.token}''${encoded}`;
                    let result = parseFilename(headers);

                    if (strictExtendedChecks) {
                        expect(result).to.deep.equal({
                            filename: expectedExtended,
                            source: 'filename*'
                        });
                    } else {
                        expect(result.source).to.equal('filename*');
                        expect(result.filename).to.be.a('string');
                        expect(result.filename.length).to.be.gt(0);
                    }
                });

                // B) RFC2231 continuation (unencoded)
                it(`[B] filename*0 + filename*1 for ${filename}`, function () {
                    let headers = `Content-Disposition: attachment; filename*0="${rawParts[0]}"; filename*1="${rawParts[1]}"`;
                    expect(parseFilename(headers)).to.deep.equal({
                        filename,
                        source: 'filename*0'
                    });
                });

                // B) RFC2231 continuation (encoded)
                it(`[B] filename*0* + filename*1* for ${filename}`, function () {
                    let headers = `Content-Disposition: attachment; filename*0*=${scenario.token}''${encodedParts[0]}; filename*1*=${encodedParts[1]}`;
                    let result = parseFilename(headers);

                    if (strictExtendedChecks) {
                        expect(result).to.deep.equal({
                            filename: expectedExtended,
                            source: 'filename*0*'
                        });
                    } else {
                        expect(result.source).to.equal('filename*0*');
                        expect(result.filename).to.be.a('string');
                        expect(result.filename.length).to.be.gt(0);
                    }
                });

                // 6) Precedence: continuation > single extended > classical
                it(`[precedence] filename*0* > filename* > filename for ${filename}`, function () {
                    let continuationValue = `continuation-${filename}`;
                    let singleValue = `single-${filename}`;

                    let continuationEncoded = percentEncodeByEncoding(continuationValue, scenario.bufferEncoding);
                    let continuationParts = splitPercentEncodedInTwo(continuationEncoded);
                    let singleEncoded = percentEncodeByEncoding(singleValue, scenario.bufferEncoding);

                    let expected = expectedFromDeclaredCharset(continuationValue, scenario);

                    let headers =
                        `Content-Disposition: attachment; filename="classic.txt"; ` +
                        `filename*=${scenario.token}''${singleEncoded}; ` +
                        `filename*0*=${scenario.token}''${continuationParts[0]}; filename*1*=${continuationParts[1]}`;

                    let result = parseFilename(headers);

                    if (strictExtendedChecks) {
                        expect(result).to.deep.equal({
                            filename: expected,
                            source: 'filename*0*'
                        });
                    } else {
                        expect(result.source).to.equal('filename*0*');
                        expect(result.filename).to.be.a('string');
                        expect(result.filename.startsWith('continuation-')).to.be.true;
                    }
                });

                // 7) Folding
                it(`[folding] folded filename*= for ${filename}`, function () {
                    let headers = `Content-Disposition: attachment;\r\n\tfilename*=${scenario.token}''${encoded}`;
                    let result = parseFilename(headers);

                    if (strictExtendedChecks) {
                        expect(result).to.deep.equal({
                            filename: expectedExtended,
                            source: 'filename*'
                        });
                    } else {
                        expect(result.source).to.equal('filename*');
                        expect(result.filename).to.be.a('string');
                        expect(result.filename.length).to.be.gt(0);
                    }
                });
            });

            // 8) Quoting/escaping
            it('[edge quoting] escaped quotes and backslashes', function () {
                let headers = 'Content-Disposition: attachment; filename="weird\\"name\\\\test.txt"';
                expect(parseFilename(headers)).to.deep.equal({
                    filename: 'weird\\"name\\\\test.txt',
                    source: 'filename'
                });
            });
        });
    });

    // 2) Continuation assembly policy in current MIMEParser: concatenate available indexes
    // in numeric order; gaps are ignored (no stop-at-gap behavior).
    it('continuation with missing segment concatenates existing parts (unencoded)', function () {
        let headers = 'Content-Disposition: attachment; filename*0="part-A"; filename*2="part-C"';
        expect(parseFilename(headers)).to.deep.equal({
            filename: 'part-Apart-C',
            source: 'filename*0'
        });
    });

    it('continuation with missing segment concatenates existing parts (encoded)', function () {
        let headers = "Content-Disposition: attachment; filename*0*=UTF-8''A; filename*2*=C";
        expect(parseFilename(headers)).to.deep.equal({
            filename: 'AC',
            source: 'filename*0*'
        });
    });

    // 4) Malformed/no-charset behavior in current MIMEParser (lenient/quirky by design).
    it('malformed filename* with empty charset does not fall back automatically', function () {
        let headers = "Content-Disposition: attachment; filename*=''r%C3%A9sum%C3%A9.pdf";
        expect(parseFilename(headers)).to.deep.equal({
            filename: '=?R%C3%A9SUM%C3%A9.PDF?Q??=',
            source: 'filename*'
        });
    });

    it('malformed filename* with empty charset still overrides classical filename=', function () {
        let headers = 'Content-Disposition: attachment; filename="ascii-fallback"; filename*=\'\'r%C3%A9sum%C3%A9.pdf';
        expect(parseFilename(headers)).to.deep.equal({
            filename: '=?R%C3%A9SUM%C3%A9.PDF?Q??=',
            source: 'filename*'
        });
    });

    it('filename*=UTF-8 with raw unescaped non-ascii is accepted leniently', function () {
        let headers = "Content-Disposition: attachment; filename*=UTF-8''résumé.pdf";
        expect(parseFilename(headers)).to.deep.equal({
            filename: 'résumé.pdf',
            source: 'filename*'
        });
    });

    it('quoted filename* value is accepted leniently', function () {
        let headers = 'Content-Disposition: attachment; filename*="UTF-8\'\'r%C3%A9sum%C3%A9.pdf"';
        expect(parseFilename(headers)).to.deep.equal({
            filename: 'résumé.pdf',
            source: 'filename*'
        });
    });

    it('plain percent-encoded value without charset/lang is treated as malformed token', function () {
        let headers = 'Content-Disposition: attachment; filename*=r%C3%A9sum%C3%A9.pdf';
        expect(parseFilename(headers)).to.deep.equal({
            filename: '=?R%C3%A9SUM%C3%A9.PDF?Q??=',
            source: 'filename*'
        });
    });

    // 5) Whitespace around separators/operators
    it('accepts whitespace around separators and assignment operators', function () {
        let headers = 'Content-Disposition: attachment ; filename = "fallback.txt" ; filename* = UTF-8\'\'%72%65%70%6F%72%74%2E%74%78%74';
        expect(parseFilename(headers)).to.deep.equal({
            filename: 'report.txt',
            source: 'filename*'
        });
    });

    // Optional Content-Type fallback path
    it('falls back to Content-Type name if Content-Disposition is missing', function () {
        let headers = 'Content-Type: application/octet-stream; name="report.txt"';
        expect(parseFilename(headers)).to.deep.equal({
            filename: 'report.txt',
            source: 'content-type-name'
        });
    });

    it('falls back to Content-Type name* if Content-Disposition is missing', function () {
        let headers = "Content-Type: application/octet-stream; name*=UTF-8''%E4%B8%AD%E6%96%87%E6%96%87%E4%BB%B6%E5%90%8D.txt";
        expect(parseFilename(headers)).to.deep.equal({
            filename: '中文文件名.txt',
            source: 'content-type-name*'
        });
    });

    it('prefers Content-Disposition over Content-Type when both are present', function () {
        let headers = 'Content-Disposition: attachment; filename="a.txt"\r\nContent-Type: application/octet-stream; name="b.txt"';
        expect(parseFilename(headers)).to.deep.equal({
            filename: 'a.txt',
            source: 'filename'
        });
    });

    // 6) Security/sanity: current parser behavior is preserve-as-is.
    it('preserves path separators', function () {
        let headers = 'Content-Disposition: attachment; filename="../folder/file.txt"';
        expect(parseFilename(headers)).to.deep.equal({
            filename: '../folder/file.txt',
            source: 'filename'
        });
    });

    it('preserves control characters', function () {
        let headers = `Content-Disposition: attachment; filename="bad\u0001name.txt"`;
        expect(parseFilename(headers)).to.deep.equal({
            filename: 'bad\u0001name.txt',
            source: 'filename'
        });
    });
});
