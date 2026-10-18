/*eslint no-unused-expressions: 0, prefer-arrow-callback: 0 */

'use strict';

const chai = require('chai');
const DkimStream = require('../lib/dkim-stream');

const expect = chai.expect;
chai.config.includeStack = true;

const hashInChunks = chunks =>
    new Promise(resolve => {
        let stream = new DkimStream();
        stream.on('hash', hash => resolve(hash));
        stream.on('data', () => false);
        for (let chunk of chunks) {
            stream.write(Buffer.from(chunk, 'binary'));
        }
        stream.end();
    });

describe('DkimStream', function () {
    it('should hash trailing whitespace away from every line', async function () {
        // relaxed canonicalization: trailing WSP goes, inner runs of WSP become one space
        let canonical = await hashInChunks(['a b\r\nc\r\n']);
        expect(await hashInChunks(['a  \t  b \t\r\nc  \r\n'])).to.equal(canonical);
        expect(await hashInChunks(['a  \t ', ' b \t\r\nc ', ' \r\n'])).to.equal(canonical);
    });

    it('should trim trailing whitespace in linear time', async function () {
        this.timeout(10000); // eslint-disable-line no-invalid-this
        // a run of spaces inside a line, the regex that trimmed line ends retried the run
        // from every position in it, 40k spaces took 1.4 s
        let canonical = await hashInChunks(['a b\r\nc\r\n']);
        let start = Date.now();
        let hash = await hashInChunks(['a' + ' '.repeat(300000) + 'b  \r\nc\r\n']);
        expect(Date.now() - start).to.be.below(2000);
        expect(hash).to.equal(canonical);
    });
});
