/*eslint prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const { acquireSearchDebounce } = require('../lib/search-debounce');

const expect = chai.expect;

describe('Search debounce tests', function () {
    it('should acquire a per-user debounce window', async () => {
        const calls = [];
        const redis = {
            async set(...args) {
                calls.push(args);
                return 'OK';
            }
        };

        const result = await acquireSearchDebounce(redis, 'user-id', 750);

        expect(result).to.deep.equal({ success: true, retryAfterMs: 0 });
        expect(calls).to.deep.equal([['search-debounce:user-id', '1', 'PX', 750, 'NX']]);
    });

    it('should reject a search while the debounce window is active', async () => {
        const redis = {
            async set() {
                return null;
            },
            async pttl() {
                return 425;
            }
        };

        const result = await acquireSearchDebounce(redis, 'user-id', 750);

        expect(result).to.deep.equal({ success: false, retryAfterMs: 425 });
    });

    it('should reacquire when the debounce key expires during the check', async () => {
        let setCalls = 0;
        const redis = {
            async set() {
                setCalls++;
                return setCalls === 2 ? 'OK' : null;
            },
            async pttl() {
                return -2;
            }
        };

        const result = await acquireSearchDebounce(redis, 'user-id', 750);

        expect(result).to.deep.equal({ success: true, retryAfterMs: 0 });
        expect(setCalls).to.equal(2);
    });

    it('should be disabled for a non-positive window', async () => {
        const redis = {
            set() {
                throw new Error('Redis should not be called');
            }
        };

        expect(await acquireSearchDebounce(redis, 'user-id', 0)).to.deep.equal({ success: true, retryAfterMs: 0 });
    });
});
