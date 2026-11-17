'use strict';

const { expect } = require('chai');
const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const { ApiDownload, createApiDownloadLimiter } = require('../lib/api-download');
const { MAX_API_DOWNLOAD } = require('../lib/consts');

function counter() {
    const state = { used: 0 };
    state.spend = async (key, bytes, allowed) => {
        await new Promise(resolve => setImmediate(resolve));
        const success = !allowed || (state.used < allowed && bytes <= allowed - state.used);
        if (success) {
            state.used += bytes;
        }
        return { success, value: state.used, ttl: 86400 };
    };
    return state;
}

async function download(state, chunks, allowed) {
    const received = [];
    await pipeline(
        Readable.from(chunks),
        new ApiDownload(state.spend, 'adw:user', allowed),
        new Writable({ write(chunk, encoding, done) { received.push(chunk); done(); } })
    );
    return Buffer.concat(received);
}

describe('API attachment download metering', () => {
    it('counts every output chunk immediately and accepts the exact allowance', async () => {
        const state = counter();
        expect((await download(state, [Buffer.from('abc'), Buffer.from('de')], 5)).toString()).to.equal('abcde');
        expect(state.used).to.equal(5);
    });

    it('does not spend rejected chunks or exceed the shared allowance', async () => {
        const state = counter();
        const error = await download(state, [Buffer.from('abc'), Buffer.from('def')], 5).catch(err => err);
        expect(error.code).to.equal('ApiDownloadLimitExceeded');
        expect(error.responseCode).to.equal(429);
        expect(state.used).to.equal(3);
    });

    it('arbitrates concurrent downloads before their bytes leave the limiter', async () => {
        const state = counter();
        const results = await Promise.allSettled([download(state, [Buffer.alloc(3)], 5), download(state, [Buffer.alloc(3)], 5)]);
        expect(results.filter(result => result.status === 'fulfilled')).to.have.length(1);
        expect(state.used).to.equal(3);
    });

    it('releases the source and retains consumed traffic when the receiver disconnects', async () => {
        const state = counter();
        let released = false;
        const source = new Readable({
            read() { this.push(Buffer.alloc(3)); },
            destroy(err, done) { released = true; done(err); }
        });
        const error = await pipeline(
            source,
            new ApiDownload(state.spend, 'adw:user', 100),
            new Writable({ write(chunk, encoding, done) { done(new Error('Client disconnected')); } })
        ).catch(err => err);
        expect(error.message).to.equal('Client disconnected');
        expect(released).to.equal(true);
        expect(state.used).to.be.greaterThan(0);
    });

    it('fails closed when accounting is unavailable', async () => {
        let bytes = 0;
        const error = await pipeline(
            Readable.from([Buffer.from('abc')]),
            new ApiDownload(async () => { throw new Error('Redis unavailable'); }, 'adw:user', 5),
            new Writable({ write(chunk, encoding, done) { bytes += chunk.length; done(); } })
        ).catch(err => err);
        expect(error.message).to.equal('Redis unavailable');
        expect(bytes).to.equal(0);
    });

    it('defaults to unlimited downloads without spending a Redis counter', async () => {
        expect(MAX_API_DOWNLOAD).to.equal(0);
        const db = {
            users: { collection: () => ({ findOne: async () => ({ apiMaxDownload: 0 }) }) },
            redis: {
                defineCommand() {},
                spendcounter() { throw new Error('Unlimited downloads must not spend a counter'); }
            }
        };
        const prepare = createApiDownloadLimiter(db, { get: async () => MAX_API_DOWNLOAD });
        const limiter = await prepare('user', Number.MAX_SAFE_INTEGER);
        let bytes = 0;
        await pipeline(Readable.from([Buffer.alloc(10)]), limiter, new Writable({ write(chunk, encoding, done) { bytes += chunk.length; done(); } }));
        expect(bytes).to.equal(10);
    });

    it('checks known lengths before opening storage and resolves a user override', async () => {
        const state = counter();
        const db = {
            users: { collection: () => ({ findOne: async () => ({ apiMaxDownload: 5 }) }) },
            redis: {
                defineCommand() {},
                spendcounter: async (key, count, max) => {
                    const result = await state.spend(key, count, max);
                    return [Number(result.success), result.value, result.ttl];
                }
            }
        };
        const prepare = createApiDownloadLimiter(db, { get: async () => 100 });
        const error = await prepare('user', 6).catch(err => err);
        expect(error.code).to.equal('ApiDownloadLimitExceeded');
        expect(state.used).to.equal(0);
        expect((await prepare('user', 5)).allowed).to.equal(5);
    });
});
