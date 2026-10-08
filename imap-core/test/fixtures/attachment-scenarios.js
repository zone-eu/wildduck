'use strict';

// Messages with transfer-encoded attachments for the storage tests. Every scenario is a complete
// message whose attachment bodies are moved to the attachment storage by getMaildata(), plus the
// bytes a byte-exact rebuild must return (the source itself, which is already CRLF-normalised).

const libbase64 = require('libbase64');
const libqp = require('libqp');

// deterministic pseudo-random bytes, so base64 output has every alphabet character
function payload(length, seed) {
    let buf = Buffer.alloc(length);
    let x = seed || 1;
    for (let i = 0; i < length; i++) {
        x = (x * 1103515245 + 12345) % 4294967296;
        buf[i] = Math.floor(x / 65536) % 256;
    }
    return buf;
}

function base64Body(data, options) {
    options = options || {};
    let text = libbase64.wrap(libbase64.encode(data), options.lineLen || 76).replace(/\r?\n/g, '\r\n');
    if (options.unpadded) {
        text = text.replace(/[=]+$/, '');
    }
    return text + '\r\n'.repeat(options.trailing || 0);
}

function part(headers, body) {
    return headers.join('\r\n') + '\r\n\r\n' + body;
}

function multipart(parts, boundary) {
    boundary = boundary || 'b';
    return (
        `Content-Type: multipart/mixed; boundary="${boundary}"\r\nSubject: attachment scenario\r\n\r\n--${boundary}\r\n` +
        parts.join(`\r\n--${boundary}\r\n`) +
        `\r\n--${boundary}--\r\n`
    );
}

const text = part(['Content-Type: text/plain'], 'hello');

const scenarios = [];

function add(name, source, info) {
    scenarios.push(Object.assign({ name, source: Buffer.from(source, 'binary') }, info || {}));
}

// lengths around the base64 quantum (3 bytes), the 76-column line (57 bytes), and multiples of 57 whose
// encoding ends exactly on a line end, which is the layout where the encoder appends a line break
const LENGTHS = [1, 2, 3, 56, 57, 58, 76, 300, 1140, 1141, 1083];

for (let length of LENGTHS) {
    for (let lineLen of [76, 72]) {
        for (let trailing of [0, 1, 2]) {
            let data = payload(length, length * 7 + lineLen);
            // a body that fits on one line carries no wrap length, it is stored with the default one
            let storedLineLen = Math.ceil(length / 3) * 4 <= lineLen ? 76 : lineLen;
            add(
                `base64 ${length} bytes, ${lineLen} columns, ${trailing} trailing blank lines`,
                multipart([text, part(['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64'], base64Body(data, { lineLen, trailing }))]),
                { decoded: true, lineLen: storedLineLen, decodedLength: length }
            );
        }
    }
}

for (let length of [1, 2, 4, 1000]) {
    let data = payload(length, 99);
    add(
        `unpadded base64 ${length} bytes`,
        multipart([text, part(['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64'], base64Body(data, { unpadded: true }))]),
        { decoded: false }
    );
}

add(
    'base64 single short line',
    multipart([text, part(['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64'], 'aGVsbG8gd29ybGQ=')]),
    { decoded: true, lineLen: 76, decodedLength: 11 }
);

// 12 + 8 characters is a valid wrap at 12, so this one is stored decoded with that line length
add(
    'base64 wrapped at an unusual line length',
    multipart([text, part(['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64'], 'aGVsbG8gd29y\r\nbGQhIQ==')]),
    { decoded: true, lineLen: 12, decodedLength: 13 }
);

// 8 + 12 characters is not a wrap at any line length
add(
    'base64 with uneven wrapping',
    multipart([text, part(['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64'], 'aGVsbG8g\r\nd29ybGQhIQ==')]),
    { decoded: false }
);

add(
    'quoted-printable attachment',
    multipart([
        text,
        part(['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: quoted-printable'], libqp.wrap(libqp.encode(payload(500, 5))).replace(/\r?\n/g, '\r\n'))
    ]),
    { decoded: false }
);

add(
    'two attachments and a text part after them',
    multipart([
        text,
        part(['Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64'], base64Body(payload(1140, 1), { trailing: 1 })),
        part(['Content-Type: application/pdf', 'Content-Transfer-Encoding: base64'], base64Body(payload(200, 2))),
        part(['Content-Type: text/plain'], 'after the attachments\r\n')
    ])
);

// inline text above the size limit is moved to the storage too, verbatim or decoded
add(
    'large inline text part stored verbatim',
    multipart([text, part(['Content-Type: text/plain; charset=utf-8'], ('line of text that repeats\r\n'.repeat(13000) + 'last line').replace(/x/g, 'y'))]),
    { decoded: false }
);

add(
    'large inline base64 text part stored decoded',
    multipart([text, part(['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64'], base64Body(payload(330000, 11), { trailing: 1 }))]),
    { decoded: true, lineLen: 76, decodedLength: 330000 }
);

add(
    'attachment as the whole message body',
    'Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\nSubject: root attachment\r\n\r\n' + base64Body(payload(1140, 3), { trailing: 1 }),
    { decoded: true, lineLen: 76, decodedLength: 1140 }
);

// scenarios whose seams deserve every single offset
const SEAMS = new Set([
    'base64 1140 bytes, 76 columns, 0 trailing blank lines',
    'base64 1141 bytes, 76 columns, 1 trailing blank lines',
    'base64 57 bytes, 76 columns, 1 trailing blank lines',
    'base64 1083 bytes, 72 columns, 2 trailing blank lines',
    'two attachments and a text part after them',
    'attachment as the whole message body'
]);

module.exports = { scenarios, SEAMS, payload, base64Body };
