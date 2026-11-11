/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { parseStrict, JsonError, MAX_DEPTH } = require('../../../lib/jmap/json');

const parse = text => parseStrict(Buffer.isBuffer(text) ? text : Buffer.from(text));
const fails = text => {
    try {
        parse(text);
    } catch (err) {
        return err instanceof JsonError;
    }
    return false;
};

describe('strict JSON for JMAP requests', () => {
    it('parses ordinary JSON, including keys and strings with quotes, escapes and brackets', () => {
        expect(parse('{"a":1,"b":[1,{"c":"x\\"}{,"}],"d":{"a":2}}')).to.deep.equal({ a: 1, b: [1, { c: 'x"}{,' }], d: { a: 2 } });
        expect(parse('{"k\\u0041":"\\\\"}')).to.deep.equal({ kA: '\\' });
        expect(parse('[]')).to.deep.equal([]);
        expect(parse('"ä"')).to.equal('ä');
    });

    it('allows the same name in different objects and as a value', () => {
        expect(parse('{"a":{"a":"a"},"b":[{"a":1},{"a":2}]}')).to.deep.equal({ a: { a: 'a' }, b: [{ a: 1 }, { a: 2 }] });
    });

    it('rejects duplicate member names, also when spelled with escapes', () => {
        expect(fails('{"a":1,"a":2}')).to.be.true;
        expect(fails('{"a":1,"b":{"x":1,"x":2}}')).to.be.true;
        expect(fails('{"A":1,"\\u0041":2}')).to.be.true;
        expect(fails('[{"a":1,"a":1}]')).to.be.true;
    });

    it('rejects invalid UTF-8 and invalid JSON', () => {
        expect(fails(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))).to.be.true;
        expect(fails('{"a":}')).to.be.true;
        expect(fails('{"a":1')).to.be.true;
        expect(fails('"open')).to.be.true;
        expect(fails('')).to.be.true;
    });

    it('rejects nesting deeper than the limit without exhausting the stack', () => {
        expect(fails('['.repeat(MAX_DEPTH + 1) + ']'.repeat(MAX_DEPTH + 1))).to.be.true;
        expect(fails('['.repeat(100000))).to.be.true;
        expect(parse('['.repeat(MAX_DEPTH) + ']'.repeat(MAX_DEPTH))).to.be.an('array');
    });

    it('rejects escapes that leave a surrogate unpaired, accepts a pair', () => {
        expect(fails('{"a":"\\ud800"}')).to.be.true;
        expect(fails('{"a":"x\\udc00y"}')).to.be.true;
        expect(fails('{"\\ud800":1}')).to.be.true;
        expect(fails('{"a":"\\ud800\\u0041"}')).to.be.true;
        expect(parse('{"a":"\\ud834\\udd1e"}')).to.deep.equal({ a: '\ud834\udd1e' });
        expect(parse('{"a":"\\\\ud800"}')).to.deep.equal({ a: '\\ud800' });
    });

    it('answers a JsonError, not a SyntaxError, for a member name with control characters', () => {
        expect(fails(Buffer.from('{"a\u0000b":1}'))).to.be.true;
        expect(fails(Buffer.from(JSON.stringify({ using: [] }), 'utf16le'))).to.be.true;
    });
});
