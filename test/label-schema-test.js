/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { labelSchema } = require('../lib/schemas');

describe('Label schema', () => {
    it('accepts Unicode atom characters, including characters whose low byte is CR or LF', () => {
        const { error, value } = labelSchema.validate('safe\u010a\u010d-čau-😀');

        expect(error).not.to.exist;
        expect(value).to.equal('safe\u010a\u010d-čau-😀');
    });

    it('accepts label names that are not valid IMAP atoms', () => {
        for (const label of ['Work Projects', '50% done', 'Review (later)', 'A[B]{C}*']) {
            expect(labelSchema.validate(label).error).not.to.exist;
        }
    });

    it('rejects internal and system flags as custom labels', () => {
        for (const label of ['$Forwarded', '$forwarded', '$label1', '\\Seen']) {
            expect(labelSchema.validate(label).error).to.exist;
        }
    });
});
