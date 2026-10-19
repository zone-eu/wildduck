'use strict';

const Joi = require('joi');
const { booleanSchema } = require('../../schemas');

const Autoreply = Joi.object({
    status: booleanSchema.default(true).description('If true, then autoreply is enabled for this address'),
    start: Joi.date().empty('').allow(false).description('Either a date string or boolean false to disable start time checks'),
    end: Joi.date().empty('').allow(false).description('Either a date string or boolean false to disable end time checks'),
    name: Joi.string().empty('').trim().max(128).description('Name that is used for the From: header in autoreply message'),
    subject: Joi.string()
        .empty('')
        .trim()
        .max(2 * 1024)
        .description('Autoreply subject line'),
    text: Joi.string()
        .empty('')
        .trim()
        .max(128 * 1024)
        .description('Autoreply plaintext content'),
    html: Joi.string()
        .empty('')
        .trim()
        .max(128 * 1024)
        .description('Autoreply HTML content')
})
    .description('Autoreply information')
    .$_setFlag('objectName', 'Autoreply');

module.exports = { Autoreply };
