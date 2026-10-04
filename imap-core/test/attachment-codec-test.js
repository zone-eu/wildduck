/* eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-invalid-this: 0 */
'use strict';

// Unit tests for the attachment codec (base64 acceptance proof, read windows), the LengthLimiter and the
// way the rebuilder fits storage streams to the stored size, including the failure paths: a storage
// that delivers too much, too little, loses the file during the read, or fails outright.

const chai = require('chai');
const expect = chai.expect;
const crypto = require('crypto');
const { Readable, PassThrough } = require('stream');
const libbase64 = require('libbase64');
const { byteWindow, decodedLength, inspectBase64, prepareStoredBody, createReadWindow, filler } = require('../../lib/attachments/base64-codec');
const LengthLimiter = require('../lib/length-limiter');
const Indexer = require('../lib/indexer/indexer');
const { materialize } = require('./fixtures/indexer-cases');
const { Rng } = require('./fixtures/mime-fuzz');

chai.config.includeStack = true;

const collect = async stream => {
    let chunks = [];
    for await (let chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
};

const wrapped = (data, lineLen, trailing) => Buffer.from(libbase64.wrap(libbase64.encode(data), lineLen) + '\r\n'.repeat(trailing || 0), 'latin1');

describe('Attachment codec', function () {
    this.timeout(120000);

    describe('inspectBase64', function () {
        it('rejects what is not a body', function () {
            expect(inspectBase64(null)).to.be.false;
            expect(inspectBase64('aGVsbG8=')).to.be.false;
            expect(inspectBase64(Buffer.alloc(0))).to.be.false;
            expect(inspectBase64(Buffer.from('\r\n\r\n'))).to.be.false;
        });

        it('accepts canonical wrapping at any line length, with trailing line breaks', function () {
            let rng = new Rng(5);
            for (let i = 0; i < 300; i++) {
                let data = rng.bytes(rng.int(1, 2000));
                let lineLen = rng.pick([4, 8, 64, 72, 76, 100, 998]);
                let trailing = rng.int(0, 3);
                let result = inspectBase64(wrapped(data, lineLen, trailing));
                expect(result, `length ${data.length} line ${lineLen}`).to.not.be.false;
                expect(result.data.equals(data)).to.be.true;
                // a single line shorter than the default line length is served at the default length
                let encodedChars = Math.ceil(data.length / 3) * 4;
                expect(result.lineLen).to.equal(encodedChars <= lineLen ? Math.max(encodedChars, 76) : lineLen);
            }
        });

        it('rejects lines longer than RFC 5322 allows', function () {
            expect(inspectBase64(wrapped(crypto.randomBytes(2000), 999))).to.be.false;
        });

        it('only accepts bodies that re-encode byte for byte', function () {
            // property: whatever the damage, an accepted body re-encodes to exactly its text
            let rng = new Rng(9);
            let accepted = 0;
            for (let i = 0; i < 2000; i++) {
                let body = Buffer.from(wrapped(rng.bytes(rng.int(1, 600)), rng.pick([72, 76]), rng.int(0, 1)));
                let kind = rng.int(0, 5);
                let pos = rng.int(0, body.length - 1);
                if (kind === 0) {
                    body[pos] = rng.pick([0x2a, 0x20, 0x3d, 0x0a, 0x0d, 0x41]);
                } else if (kind === 1) {
                    body = Buffer.concat([body.subarray(0, pos), Buffer.from('\r\n'), body.subarray(pos)]);
                } else if (kind === 2) {
                    body = Buffer.concat([body.subarray(0, pos), body.subarray(pos + 1)]);
                } else if (kind === 3) {
                    body = Buffer.from(body.toString('latin1').replace(/[=]+(\r\n)*$/, ''), 'latin1');
                }
                let result = inspectBase64(body);
                if (result) {
                    accepted++;
                    let end = body.length;
                    while (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) {
                        end -= 2;
                    }
                    expect(wrapped(result.data, result.lineLen).equals(body.subarray(0, end)), `case ${i} kind ${kind}`).to.be.true;
                }
            }
            expect(accepted).to.be.above(100);
        });
    });

    describe('prepareStoredBody', function () {
        it('stores decoded base64 only when it is enabled and the body passes the proof', function () {
            let body = wrapped(crypto.randomBytes(300), 76, 1);
            let decoded = prepareStoredBody({ body, transferEncoding: 'base64' }, { decodeBase64: true });
            expect(decoded.metadata).to.include({ decoded: true, lineLen: 76, esize: body.length, transferEncoding: 'base64' });
            expect(prepareStoredBody({ body, transferEncoding: 'base64' }, { decodeBase64: false }).data).to.equal(body);
            expect(prepareStoredBody({ body, transferEncoding: 'quoted-printable' }, { decodeBase64: true }).metadata.decoded).to.be.undefined;
            expect(prepareStoredBody({ body: Buffer.from('not*base64'), transferEncoding: 'base64' }, { decodeBase64: true }).metadata.decoded).to.be.undefined;
        });
    });

    describe('sizes and windows', function () {
        it('estimates the decoded size', function () {
            expect(decodedLength(0)).to.equal(0);
            expect(decodedLength(-5)).to.equal(0);
            expect(decodedLength('x')).to.equal(0);
            for (let n of [1, 3, 57, 58, 1140, 100000]) {
                let encoded = wrapped(crypto.randomBytes(n), 76).length;
                expect(Math.abs(decodedLength(encoded) - n), `length ${n}`).to.be.at.most(2);
            }
        });

        it('turns range options into a byte range', function () {
            expect(byteWindow({}, 10)).to.deep.equal({ start: 0, end: 10 });
            expect(byteWindow(undefined, 10)).to.deep.equal({ start: 0, end: 10 });
            expect(byteWindow({ startFrom: 3, maxLength: 4 }, 10)).to.deep.equal({ start: 3, end: 7 });
            expect(byteWindow({ startFrom: 8, maxLength: 4 }, 10)).to.deep.equal({ start: 8, end: 10 });
            expect(byteWindow({ startFrom: 20, maxLength: 4 }, 10)).to.deep.equal({ start: 10, end: 10 });
            expect(byteWindow({ startFrom: -2, maxLength: -4 }, 10)).to.deep.equal({ start: 0, end: 10 });
        });

        it('fills gaps with line breaks in either phase', function () {
            expect(filler(0).toString()).to.equal('');
            expect(filler(3).toString()).to.equal('\r\n\r');
            expect(filler(3, 1).toString()).to.equal('\n\r\n');
            expect(filler(1, 1).toString()).to.equal('\n');
        });
    });

    describe('createReadWindow', function () {
        let reader = (data, chunk) => (start, end) => {
            let slice = data.subarray(start, end);
            let parts = [];
            for (let i = 0; i < slice.length; i += chunk) {
                parts.push(slice.subarray(i, i + chunk));
            }
            return Readable.from(parts);
        };

        it('serves every window of a decoded body, with and without legacy metadata', async function () {
            let rng = new Rng(21);
            for (let i = 0; i < 25; i++) {
                let data = rng.bytes(rng.pick([1, 2, 3, 57, 58, 114, rng.int(1, 400)]));
                let lineLen = rng.pick([76, 72, 64]);
                let trailing = rng.int(0, 2);
                let body = wrapped(data, lineLen, trailing);
                let variants = [
                    { length: data.length, metadata: { decoded: true, lineLen, esize: body.length } },
                    // stored before esize was recorded: the canonical encoding without trailing line breaks
                    { length: data.length, metadata: { decoded: true, lineLen } }
                ];
                for (let [v, attachmentData] of variants.entries()) {
                    let expected = v === 0 ? body : wrapped(data, lineLen);
                    let read = reader(data, rng.pick([1, 3, 57, 1000]));
                    expect((await collect(createReadWindow(read, attachmentData))).equals(expected)).to.be.true;
                    for (let origin = 0; origin <= expected.length; origin += rng.int(1, 5)) {
                        let length = rng.int(1, expected.length + 2);
                        let got = await collect(createReadWindow(read, attachmentData, { startFrom: origin, maxLength: length }));
                        expect(got.equals(expected.subarray(origin, origin + length)), `case ${i} variant ${v} <${origin}.${length}>`).to.be.true;
                    }
                }
            }
        });

        it('cuts an unpadded legacy body at its stored size', async function () {
            // stored decoded by the old rule although it lacked the base64 padding: esize is shorter
            let data = crypto.randomBytes(4);
            let unpadded = libbase64.encode(data).replace(/[=]+$/, '');
            let got = await collect(createReadWindow(reader(data, 2), { length: data.length, metadata: { decoded: true, lineLen: 76, esize: unpadded.length } }));
            expect(got.toString()).to.equal(unpadded);
        });

        it('serves windows of a verbatim body', async function () {
            let data = crypto.randomBytes(300);
            for (let [startFrom, maxLength] of [
                [0, 0],
                [10, 20],
                [290, 50],
                [400, 5]
            ]) {
                let got = await collect(createReadWindow(reader(data, 7), { length: data.length, metadata: {} }, { startFrom, maxLength }));
                expect(got.equals(data.subarray(startFrom, maxLength ? startFrom + maxLength : undefined))).to.be.true;
            }
        });

        it('tears the source down when the window is destroyed', async function () {
            let source = new PassThrough();
            let stream = createReadWindow(() => source, { length: 1000, metadata: { decoded: true, lineLen: 76, esize: 1354 } });
            source.write(crypto.randomBytes(57));
            stream.destroy();
            await new Promise(resolve => setImmediate(resolve));
            expect(source.destroyed).to.be.true;
        });
    });

    describe('LengthLimiter', function () {
        let limit = async (chunks, ...options) => {
            let limiter = new LengthLimiter(...options);
            let mismatches = [];
            limiter.on('mismatch', info => mismatches.push(info));
            let output = collect(limiter);
            for (let chunk of chunks) {
                limiter.write(chunk);
            }
            limiter.end();
            return { bytes: await output, mismatches };
        };

        it('skips to the start position inside and across chunks', async function () {
            let { bytes, mismatches } = await limit([Buffer.from('abc'), Buffer.from('defg'), Buffer.from('hij')], 8, ' ', 4);
            expect(bytes.toString()).to.equal('efgh');
            expect(mismatches).to.deep.equal([{ kind: 'truncated', expected: 8, received: 10 }]);
        });

        it('accepts string chunks and ignores empty ones', async function () {
            let limiter = new LengthLimiter(4);
            let output = collect(limiter);
            limiter.write('ab', 'latin1');
            limiter.write(Buffer.alloc(0));
            limiter.write('cd', 'latin1');
            limiter.end();
            expect((await output).toString()).to.equal('abcd');
        });

        it('reports data that keeps coming after an exact fill', async function () {
            let { bytes, mismatches } = await limit([Buffer.from('abcd'), Buffer.from('ef')], 4);
            expect(bytes.toString()).to.equal('abcd');
            expect(mismatches).to.deep.equal([{ kind: 'truncated', expected: 4, received: 6 }]);
            expect((await limit([Buffer.from('abcd')], 4)).mismatches).to.deep.equal([]);
        });

        it('pads with a function', async function () {
            let { bytes, mismatches } = await limit([Buffer.from('ab')], 5, n => Buffer.alloc(n, 'x'));
            expect(bytes.toString()).to.equal('abxxx');
            expect(mismatches).to.deep.equal([{ kind: 'padded', expected: 5, received: 2 }]);
        });
    });

    describe('fitting storage streams to the stored size', function () {
        // a message with one 300 byte attachment stored verbatim, served by a storage under test
        let source = Buffer.from(
            'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
                libbase64.wrap(libbase64.encode(crypto.randomBytes(225)), 76) +
                '\r\n--b--\r\n',
            'latin1'
        );

        let setup = behaviour => {
            let files = new Map();
            let logs = [];
            let storage = {
                create(attachment, callback) {
                    let id = crypto.createHash('sha256').update(attachment.body).digest();
                    files.set(id.toString('hex'), attachment.body);
                    setImmediate(() => callback(null, id));
                },
                async get(id) {
                    if (!files.has(id.toString('hex'))) {
                        let err = new Error('missing');
                        err.code = 'FileNotFound';
                        throw err;
                    }
                    return { length: files.get(id.toString('hex')).length, metadata: {} };
                },
                createReadStream(id, data, options) {
                    let body = files.get(id.toString('hex'));
                    let window = body.subarray(options.startFrom, options.startFrom + options.maxLength);
                    return behaviour(window);
                },
                async deleteManyAsync() {
                    return true;
                }
            };
            let indexer = new Indexer({ attachmentStorage: storage, loggelf: entry => logs.push(entry) });
            let tree = indexer.parseMimeTree(source);
            let maildata = indexer.getMaildata(tree);
            return new Promise(resolve => indexer.storeNodeBodies(maildata, tree, () => resolve({ indexer, tree, logs, files })));
        };

        let bodyRange = () => {
            let start = source.indexOf('base64\r\n\r\n') + 10;
            return [start, source.indexOf('\r\n--b--')];
        };

        it('serves the stored bytes exactly', async function () {
            let { indexer, tree, logs } = await setup(window => Readable.from([window]));
            let { bytes } = await materialize(indexer.getContents(tree, false));
            expect(bytes.equals(source)).to.be.true;
            expect(logs).to.deep.equal([]);
        });

        it('cuts a storage stream that delivers too much', async function () {
            let { indexer, tree, logs } = await setup(window => Readable.from([window, Buffer.from('EXTRA')]));
            let { size, bytes } = await materialize(indexer.getContents(tree, false));
            expect(bytes.length).to.equal(size);
            expect(bytes.equals(source)).to.be.true;
            expect(logs.map(entry => entry._mail_action)).to.deep.equal(['attachment_length_mismatch']);
        });

        it('pads a storage stream that delivers too little with line breaks', async function () {
            let { indexer, tree, logs } = await setup(window => Readable.from([window.subarray(0, 10)]));
            let { size, bytes } = await materialize(indexer.getContents(tree, false));
            let [start, end] = bodyRange();
            expect(bytes.length).to.equal(size);
            expect(bytes.subarray(0, start + 10).equals(source.subarray(0, start + 10))).to.be.true;
            expect(/^(\r\n)*\r?$/.test(bytes.subarray(start + 10, end).toString('latin1'))).to.be.true;
            expect(bytes.subarray(end).equals(source.subarray(end))).to.be.true;
            expect(logs.map(entry => entry._mail_action)).to.deep.equal(['attachment_length_mismatch']);
        });

        it('fills the rest when the file disappears during the read', async function () {
            let { indexer, tree, logs } = await setup(window => {
                let stream = new PassThrough();
                stream.write(window.subarray(0, 20));
                setImmediate(() => {
                    let err = new Error('gone');
                    err.code = 'ENOENT';
                    stream.destroy(err);
                });
                return stream;
            });
            let { size, bytes } = await materialize(indexer.getContents(tree, false));
            let [start, end] = bodyRange();
            expect(bytes.length).to.equal(size);
            expect(bytes.subarray(0, start + 20).equals(source.subarray(0, start + 20))).to.be.true;
            expect(/^(\r\n)*\r?$/.test(bytes.subarray(start + 20, end).toString('latin1'))).to.be.true;
            expect(bytes.subarray(end).equals(source.subarray(end))).to.be.true;
            expect(logs.map(entry => entry._mail_action)).to.include('attachment_missing');
        });

        it('serves line breaks for an attachment that is not in the storage', async function () {
            let { indexer, tree, logs, files } = await setup(window => Readable.from([window]));
            files.clear();
            let { size, bytes } = await materialize(indexer.getContents(tree, false));
            expect(bytes.length).to.equal(size);
            expect(logs.map(entry => entry._mail_action)).to.deep.equal(['attachment_missing']);
        });

        it('serves line breaks for attachments when no storage is configured', async function () {
            let { tree } = await setup(window => Readable.from([window]));
            let logs = [];
            let indexer = new Indexer({ loggelf: entry => logs.push(entry) });
            let { size, bytes } = await materialize(indexer.getContents(tree, false));
            let [start, end] = bodyRange();
            expect(bytes.length).to.equal(size);
            expect(bytes.subarray(0, start).equals(source.subarray(0, start))).to.be.true;
            expect(/^(\r\n)*\r?$/.test(bytes.subarray(start, end).toString('latin1'))).to.be.true;
            expect(logs.map(entry => entry._mail_action)).to.deep.equal(['attachment_missing']);
        });

        it('passes a failed lookup on to the reader', async function () {
            let { indexer, tree } = await setup(window => Readable.from([window]));
            indexer.attachmentStorage.get = async () => {
                throw new Error('database down');
            };
            let error = await collect(indexer.getContents(tree, false).value).then(
                () => null,
                err => err
            );
            expect(error && error.message).to.equal('database down');
        });

        it('stops reading the storage when the fetch is aborted', async function () {
            let source;
            let { indexer, tree } = await setup(window => {
                source = new PassThrough();
                source.write(window.subarray(0, 10));
                return source;
            });
            let result = indexer.getContents(tree, false);
            let stream = result.value;
            let received = 0;
            await new Promise(resolve => {
                stream.on('data', chunk => {
                    received += chunk.length;
                    if (source && received > 10) {
                        stream.abort();
                        resolve();
                    }
                });
                stream.on('close', resolve);
            });
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(stream.destroyed).to.be.true;
            expect(source.destroyed).to.be.true;
        });

        it('passes any other storage error on to the reader', async function () {
            let { indexer, tree } = await setup(() => {
                let stream = new PassThrough();
                setImmediate(() => stream.destroy(new Error('disk on fire')));
                return stream;
            });
            let result = indexer.getContents(tree, false);
            let error = await collect(result.value).then(
                () => null,
                err => err
            );
            expect(error && error.message).to.equal('disk on fire');
        });
    });
});
