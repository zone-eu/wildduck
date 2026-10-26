/* eslint no-unused-expressions: 0 */
'use strict';

const { expect } = require('chai');
const { isValidLabelName } = require('../lib/label-handler');
const { compileRouteValidator } = require('../lib/fastify/validation');
const { labelSchema, labelsSchema } = require('../lib/schemas/json-schemas');

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

    it('rejects unsanitized control characters in the handler predicate', () => {
        for (const label of ['bad\u0000name', 'bad\u0085name', 'bad\u007fname', 'bad\u2028name', 'bad\u2029name']) {
            expect(isValidLabelName(label)).to.be.false;
        }
    });

    it('sanitizes scalar and array labels during central validation', () => {
        const validate = compileRouteValidator({
            requestBody: { label: labelSchema(), labels: labelsSchema() }
        });
        const result = validate({ label: 'Pro\u0000jects/😀', labels: ['Pro\u0000jects/😀', 'Team\u0085😀'] });
        expect(result.error).to.equal(undefined);
        expect(result.value).to.deep.equal({ label: 'Projects/😀', labels: ['Projects/😀', 'Team😀'] });
    });

    it('rejects labels that sanitize to empty or reveal reserved prefixes with field paths', () => {
        const validate = compileRouteValidator({
            requestBody: { label: labelSchema(), labels: labelsSchema() }
        });
        const empty = validate({ label: '\u0000\u0085\u2028\u2029\u007f' });
        expect(empty.error).to.be.a('string');
        expect(empty.details).to.have.property('label');
        const reserved = validate({ label: '\u0000$wdlabel$123', labels: ['\u0000\\Seen'] });
        expect(reserved.error).to.be.a('string');
        expect(reserved.details).to.have.property('label');
        expect(reserved.details).to.have.property('labels,0');
    });
});
