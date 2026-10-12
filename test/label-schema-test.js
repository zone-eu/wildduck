/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { isValidLabelName } = require('../lib/label-handler');

describe('Label schema', () => {
    it('accepts Unicode atom characters, including characters whose low byte is CR or LF', () => {
        expect(isValidLabelName('safe\u010a\u010d-čau-😀')).to.be.true;
    });

    it('accepts label names that are not valid IMAP atoms', () => {
        for (const label of ['Work Projects', '50% done', 'Review (later)', 'A[B]{C}*']) {
            expect(isValidLabelName(label)).to.be.true;
        }
    });

    it('rejects internal and system flags as custom labels', () => {
        for (const label of ['$Forwarded', '$forwarded', '$label1', '\\Seen']) {
            expect(isValidLabelName(label)).to.be.false;
        }
    });
});
