'use strict';

const autoreplyBoundary = description => ({
    wdEmpty: true,
    anyOf: [{ wdType: 'date', wdInstanceof: 'Date' }, { const: false }],
    description
});

const autoreplyText = (maxLength, description) => ({
    type: 'string',
    maxLength,
    minLength: 1,
    wdTrim: true,
    wdEmpty: true,
    description
});

const Autoreply = {
    type: 'object',
    title: 'Autoreply',
    additionalProperties: false,
    description: 'Autoreply information',
    properties: {
        status: { $ref: 'wd:boolean', default: true, description: 'If true, then autoreply is enabled for this address' },
        start: autoreplyBoundary('Either a date string or boolean false to disable start time checks'),
        end: autoreplyBoundary('Either a date string or boolean false to disable end time checks'),
        name: autoreplyText(128, 'Name that is used for the From: header in autoreply message'),
        subject: autoreplyText(2 * 1024, 'Autoreply subject line'),
        text: autoreplyText(128 * 1024, 'Autoreply plaintext content'),
        html: autoreplyText(128 * 1024, 'Autoreply HTML content')
    }
};

module.exports = { Autoreply };
