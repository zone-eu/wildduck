/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { keywordSchema } = require('../lib/schemas');

describe('Keyword schema', () => {
    it('accepts Unicode atom characters, including characters whose low byte is CR or LF', () => {
        const { error, value } = keywordSchema.validate('safe\u010a\u010d-čau-😀');

        expect(error).not.to.exist;
        expect(value).to.equal('safe\u010a\u010d-čau-😀');
    });

    it('rejects internal and system flags as custom keywords', () => {
        for (const keyword of ['$Forwarded', '$forwarded', '\\Seen']) {
            expect(keywordSchema.validate(keyword).error).to.exist;
        }
    });
});
