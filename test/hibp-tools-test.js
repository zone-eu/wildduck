/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0, no-console:0 */

'use strict';

const chai = require('chai');
const crypto = require('crypto');

const expect = chai.expect;
chai.config.includeStack = true;

const tools = require('../lib/tools');

describe('HIBP Tools', function () {
    it('should return count when suffix is present in cache', async () => {
        const password = 'test-password';
        const hash = crypto.createHash('sha1').update(password).digest('hex');
        const suffix = hash.substring(5).toUpperCase();
        const cache = `${suffix}:42\nABCDEF1234567890:1`;

        const result = await tools.checkPwnedPassword(password, { cache });

        expect(result.count).to.equal(42);
        expect(result.lines).to.equal(cache);
    });

    it('should return zero count when suffix is missing from cache', async () => {
        const password = 'another-password';
        const cache = 'ABCDEF1234567890:12\n1234567890ABCDEF:5';

        const result = await tools.checkPwnedPassword(password, { cache });

        expect(result.count).to.equal(0);
    });

    it('should reject non-string passwords', async () => {
        let error;
        try {
            await tools.checkPwnedPassword(123);
        } catch (err) {
            error = err;
        }

        expect(error).to.exist;
        expect(error.message).to.equal('Input password must be a string.');
    });
});
