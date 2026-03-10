/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */
'use strict';

const chai = require('chai');
const expect = chai.expect;
const SMIMEEncryptor = require('../lib/smime');

const kdfX963 = SMIMEEncryptor._kdfX963;

// ---------------------------------------------------------------------------
// NIST CAVP test vectors (CAVS 12.0) - ANS X9.63-2001 KDF, SHA-256
// Source: https://github.com/pyca/cryptography/blob/main/vectors/cryptography_vectors/KDF/ansx963_2001.txt
// ---------------------------------------------------------------------------

describe('kdfX963 - NIST CAVP vectors (SHA-256)', function () {
    // [SHA-256] [shared secret length = 192] [SharedInfo length = 0] [key data length = 128]
    // Single-block derivation, no SharedInfo
    describe('single block, no SharedInfo (128-bit output)', function () {
        let vectors = [
            {
                z: '96c05619d56c328ab95fe84b18264b08725b85e33fd34f08',
                sharedInfo: '',
                keyData: '443024c3dae66b95e6f5670601558f71'
            },
            {
                z: '96f600b73ad6ac5629577eced51743dd2c24c21b1ac83ee4',
                sharedInfo: '',
                keyData: 'b6295162a7804f5667ba9070f82fa522'
            },
            {
                z: 'de4ec3f6b2e9b7b5b6160acd5363c1b1f250e17ee731dbd6',
                sharedInfo: '',
                keyData: 'c8df626d5caaabf8a1b2a3f9061d2420'
            },
            {
                z: 'd38bdbe5c4fc164cdd967f63c04fe07b60cde881c246438c',
                sharedInfo: '',
                keyData: '5e674db971bac20a80bad0d4514dc484'
            },
            {
                z: '693937e6e8e89606df311048a59c4ab83e62c56d692e05ce',
                sharedInfo: '',
                keyData: '5c3016128b7ee53a4d3b14c344b4db09'
            }
        ];

        vectors.forEach(function (v, i) {
            it('COUNT = ' + i, function () {
                let z = Buffer.from(v.z, 'hex');
                let keyLength = v.keyData.length / 2;
                let result = kdfX963(z, keyLength, Buffer.alloc(0));
                expect(result.toString('hex')).to.equal(v.keyData);
            });
        });
    });

    // [SHA-256] [shared secret length = 192] [SharedInfo length = 128] [key data length = 1024]
    // Multi-block derivation (4 SHA-256 blocks = 128 bytes), with SharedInfo
    describe('multi-block, with SharedInfo (1024-bit output)', function () {
        let vectors = [
            {
                z: '22518b10e70f2a3f243810ae3254139efbee04aa57c7af7d',
                sharedInfo: '75eef81aa3041e33b80971203d2c0c52',
                keyData:
                    'c498af77161cc59f2962b9a713e2b215152d139766ce34a776df11866a69bf2e' +
                    '52a13d9c7c6fc878c50c5ea0bc7b00e0da2447cfd874f6cf92f30d0097111485' +
                    '500c90c3af8b487872d04685d14c8d1dc8d7fa08beb0ce0ababc11f0bd496269' +
                    '142d43525a78e5bc79a17f59676a5706dc54d54d4d1f0bd7e386128ec26afc21'
            },
            {
                z: '7e335afa4b31d772c0635c7b0e06f26fcd781df947d2990a',
                sharedInfo: 'd65a4812733f8cdbcdfb4b2f4c191d87',
                keyData:
                    'c0bd9e38a8f9de14c2acd35b2f3410c6988cf02400543631e0d6a4c1d030365a' +
                    'cbf398115e51aaddebdc9590664210f9aa9fed770d4c57edeafa0b8c14f93300' +
                    '865251218c262d63dadc47dfa0e0284826793985137e0a544ec80abf2fdf5ab9' +
                    '0bdaea66204012efe34971dc431d625cd9a329b8217cc8fd0d9f02b13f2f6b0b'
            },
            {
                z: 'f148942fe6acdcd55d9196f9115b78f068da9b163a380fcf',
                sharedInfo: '6d2748de2b48bb21fd9d1be67c0c68af',
                keyData:
                    '6f61dcc517aa6a563dcadeabe1741637d9a6b093b68f19eb4311e0e7cc5ce704' +
                    '274331526ad3e3e0c8172ff2d92f7f07463bb4043e459ad4ed9ddffb9cc86905' +
                    '36b07379ba4aa8204ca25ec68c0d3639362fddf6648bcd2ce9334f091bd0167b' +
                    '7d38c771f632596599ef61ae0a93131b76c80d34e4926d26659ed57db7ba7555'
            },
            {
                z: 'fd4413d60953a7f9358492046109f61253ceef3c0e362ba0',
                sharedInfo: '824d7da4bc94b95259326160bf9c73a4',
                keyData:
                    '1825f49839ae8238c8c51fdd19dddc46d309288545e56e29e31712fd19e91e5a' +
                    '3aeee277085acd7c055eb50ab028bbb9218477aeb58a5e0a130433b2124a5c30' +
                    '98a77434a873b43bd0fec8297057ece049430d37f8f0daa222e15287e0796434' +
                    'e7cf32293c14fc3a92c55a1c842b4c857dd918819c7635482225fe91a3751eba'
            },
            {
                z: 'f365fe5360336c30a0b865785e3162d05d834596bb4034d0',
                sharedInfo: '0530781d7d765d0d9a82b154eec78c3c',
                keyData:
                    '92227b24b58da94b2803f6e7d0a8aab27e7c90a5e09afaecf136c3bab618104a' +
                    '694820178870c10b2933771aab6dedc893688122fffc5378f0eb178ed03bac4b' +
                    'fd3d7999f97c39aed64eeadb6801206b0f75cbd70ef96ae8f7c69b4947c1808f' +
                    'fc9ca589047803038d6310006924b934e8f3c1a15a59d99755a9a4e528daa201'
            }
        ];

        vectors.forEach(function (v, i) {
            it('COUNT = ' + i, function () {
                let z = Buffer.from(v.z, 'hex');
                let sharedInfo = Buffer.from(v.sharedInfo, 'hex');
                let keyLength = v.keyData.length / 2;
                let result = kdfX963(z, keyLength, sharedInfo);
                expect(result.toString('hex')).to.equal(v.keyData);
                expect(result.length).to.equal(keyLength);
            });
        });
    });

    // Exact block boundary: request exactly 32 bytes (one SHA-256 block)
    describe('exact block boundary (32 bytes = 1 SHA-256 block)', function () {
        it('COUNT = 0 single block, no SharedInfo, full 32-byte output', function () {
            let z = Buffer.from('96c05619d56c328ab95fe84b18264b08725b85e33fd34f08', 'hex');
            let result = kdfX963(z, 32, Buffer.alloc(0));
            expect(result.toString('hex')).to.equal('443024c3dae66b95e6f5670601558f719ed3a643e77c96a6f2a709b732b036cc');
            expect(result.length).to.equal(32);
        });
    });
});

// ---------------------------------------------------------------------------
// Misuse and edge-case tests
// ---------------------------------------------------------------------------

describe('kdfX963 - misuse and edge cases', function () {
    it('should return an empty buffer when keyLength is 0', function () {
        let z = Buffer.from('aabbccdd', 'hex');
        let result = kdfX963(z, 0, Buffer.alloc(0));
        expect(result).to.be.an.instanceOf(Buffer);
        expect(result.length).to.equal(0);
    });

    it('should return exactly the requested length for non-block-aligned sizes', function () {
        let z = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef', 'hex');
        // 33 bytes: requires 2 SHA-256 blocks but only 33 bytes returned
        let result = kdfX963(z, 33, Buffer.alloc(0));
        expect(result.length).to.equal(33);

        // 1 byte
        let result1 = kdfX963(z, 1, Buffer.alloc(0));
        expect(result1.length).to.equal(1);

        // 31 bytes (just under one block)
        let result31 = kdfX963(z, 31, Buffer.alloc(0));
        expect(result31.length).to.equal(31);
    });

    it('should produce different output for different shared secrets', function () {
        let otherInfo = Buffer.from('shared', 'utf8');
        let a = kdfX963(Buffer.from('aa', 'hex'), 32, otherInfo);
        let b = kdfX963(Buffer.from('bb', 'hex'), 32, otherInfo);
        expect(a.toString('hex')).to.not.equal(b.toString('hex'));
    });

    it('should produce different output for different otherInfo', function () {
        let z = Buffer.from('deadbeef', 'hex');
        let a = kdfX963(z, 32, Buffer.from('info1', 'utf8'));
        let b = kdfX963(z, 32, Buffer.from('info2', 'utf8'));
        expect(a.toString('hex')).to.not.equal(b.toString('hex'));
    });

    it('should be deterministic (same inputs produce same output)', function () {
        let z = Buffer.from('cafebabe', 'hex');
        let info = Buffer.from('test', 'utf8');
        let a = kdfX963(z, 64, info);
        let b = kdfX963(z, 64, info);
        expect(a.toString('hex')).to.equal(b.toString('hex'));
    });

    it('should handle a 1-byte shared secret', function () {
        let result = kdfX963(Buffer.from('ff', 'hex'), 32, Buffer.alloc(0));
        expect(result).to.be.an.instanceOf(Buffer);
        expect(result.length).to.equal(32);
    });

    it('should handle a large shared secret (512 bytes)', function () {
        let z = Buffer.alloc(512, 0x42);
        let result = kdfX963(z, 32, Buffer.alloc(0));
        expect(result).to.be.an.instanceOf(Buffer);
        expect(result.length).to.equal(32);
    });

    it('should handle large key derivation (1024 bytes across many blocks)', function () {
        let z = Buffer.from('deadbeef', 'hex');
        let result = kdfX963(z, 1024, Buffer.alloc(0));
        expect(result.length).to.equal(1024);
        // Verify first 32 bytes match a single-block derivation
        let first = kdfX963(z, 32, Buffer.alloc(0));
        expect(result.subarray(0, 32).toString('hex')).to.equal(first.toString('hex'));
    });

    it('prefix of longer derivation must match shorter derivation', function () {
        let z = Buffer.from('0102030405060708', 'hex');
        let info = Buffer.from('ctx', 'utf8');
        let short = kdfX963(z, 16, info);
        let long = kdfX963(z, 128, info);
        expect(long.subarray(0, 16).toString('hex')).to.equal(short.toString('hex'));
    });

    it('should not mutate the input z buffer', function () {
        let z = Buffer.from('aabbccdd', 'hex');
        let zCopy = Buffer.from(z);
        kdfX963(z, 32, Buffer.alloc(0));
        expect(z.toString('hex')).to.equal(zCopy.toString('hex'));
    });

    it('should not mutate the input otherInfo buffer', function () {
        let info = Buffer.from('test-info', 'utf8');
        let infoCopy = Buffer.from(info);
        kdfX963(Buffer.from('aabb', 'hex'), 32, info);
        expect(info.toString('hex')).to.equal(infoCopy.toString('hex'));
    });
});
