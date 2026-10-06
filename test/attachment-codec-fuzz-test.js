/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-await-in-loop: 0, no-invalid-this: 0, no-div-regex: 0 */
'use strict';

// Property-based fuzzing of the attachment codec: whatever body arrives, and however it is stored (decoded or
// as it is), the whole body and random byte windows of it are served back exactly, however the store
// chunks the bytes it returns. Bodies are random canonical base64 at random line lengths, with blank lines
// after them, and random damage to all of it. ATTACHMENT_FUZZ_SEED replays a run, ATTACHMENT_FUZZ_CASES
// makes it longer.

const { expect } = require('chai');
const { Readable } = require('stream');
const libbase64 = require('libbase64');
const { prepareStoredBody, createReadWindow } = require('../lib/attachments/base64-codec');
const { prng, seedFrom, collect } = require('./attachment-s3-helpers');

const CASES = Number(process.env.ATTACHMENT_FUZZ_CASES) || 1500;
const SEED = seedFrom('ATTACHMENT_FUZZ_SEED');

const DAMAGE = [
    ['flip a character', (text, r) => replaceAt(text, r.int(0, text.length - 1), r.pick(['A', 'z', '0', '+', '/', '=']))],
    ['insert a foreign byte', (text, r) => insertAt(text, r.int(0, text.length), r.pick([' ', '\t', '*', 'é', '-', '_']))],
    ['drop the padding', text => text.replace(/=+(\r\n)*$/, '$1')],
    ['add padding', text => text.replace(/(\r\n)*$/, '=$1')],
    ['break a line early', (text, r) => insertAt(text, r.int(1, text.length), '\r\n')],
    ['join two lines', text => text.replace('\r\n', '')],
    ['bare line feed', text => text.replace('\r\n', '\n')],
    ['lowercase all', text => text.toLowerCase()]
];

function replaceAt(text, index, chr) {
    return text.slice(0, index) + chr + text.slice(index + 1);
}

function insertAt(text, index, chr) {
    return text.slice(0, index) + chr + text.slice(index);
}

// a body the way it can appear in a message: base64 at some width, maybe damaged, maybe blank lines after it
function makeBody(r) {
    let raw = r.bytes(r.pick([0, 1, 2, 3, r.int(4, 200), r.int(200, 5000)]));
    let width = r.chance(0.7) ? r.pick([76, 72, 64, 60]) : r.int(1, 120);
    let text = raw
        .toString('base64')
        .replace(new RegExp(`.{1,${width}}`, 'g'), '$&\r\n')
        .replace(/\r\n$/, '');
    let applied = [];
    if (text && r.chance(0.4)) {
        let [name, damage] = r.pick(DAMAGE);
        text = damage(text, r);
        applied.push(name);
    }
    let blank = r.chance(0.3) ? r.int(1, 3) : 0;
    text += '\r\n'.repeat(blank);
    return {
        body: Buffer.from(text, 'latin1'),
        transferEncoding: r.chance(0.9) ? 'base64' : 'quoted-printable',
        description: `width ${width}, ${blank} blank, ${applied.join(',') || 'clean'}`
    };
}

// a store that returns the requested range in chunks of random size
function store(data, r) {
    return (start, end) => {
        let slice = data.subarray(start, end);
        let parts = [];
        for (let pos = 0; pos < slice.length;) {
            let size = r.int(1, 64);
            parts.push(slice.subarray(pos, pos + size));
            pos += size;
        }
        return Readable.from(parts);
    };
}

describe(`Attachment codec fuzzing (seed ${SEED})`, function () {
    this.timeout(10 * 60 * 1000);

    it(`serves every window of ${CASES} random bodies byte for byte`, async function () {
        let r = prng(SEED);
        let decodedCount = 0;
        for (let i = 0; i < CASES; i++) {
            let { body, transferEncoding, description } = makeBody(r);
            let label = `case ${i} (${description}), replay with ATTACHMENT_FUZZ_SEED=${SEED}`;
            let { data, metadata } = prepareStoredBody({ body, transferEncoding }, { decodeBase64: true });

            if (metadata.decoded) {
                decodedCount++;
                // a body is only stored decoded when the encoder reproduces it, apart from blank lines after it
                let text = body.toString('latin1').replace(/(\r\n)+$/, '');
                expect(libbase64.wrap(data.toString('base64'), metadata.lineLen), label).to.equal(text);
            } else {
                expect(data.equals(body), label).to.be.true;
            }

            let attachmentData = { length: data.length, metadata };
            let windows = [{}, { startFrom: 0, maxLength: body.length }];
            for (let w = 0; w < 6; w++) {
                windows.push({ startFrom: r.int(0, body.length + 2), maxLength: r.int(1, 200) });
            }
            for (let window of windows) {
                let start = window.startFrom || 0;
                let expected = window.maxLength ? body.subarray(start, start + window.maxLength) : body.subarray(start);
                let served = await collect(createReadWindow(store(data, r), attachmentData, window));
                expect(served.equals(expected), `${label} window ${JSON.stringify(window)}`).to.be.true;
            }
        }
        // the generator keeps both paths busy
        expect(decodedCount).to.be.above(CASES / 10);
        expect(decodedCount).to.be.below(CASES);
    });
});
