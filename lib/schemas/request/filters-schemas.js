'use strict';

const Joi = require('joi');
const { booleanSchema } = require('../../schemas');

const FilterAction = Joi.object({
    seen: booleanSchema.description('If true then mark matching messages as Seen'),
    flag: booleanSchema.description('If true then mark matching messages as Flagged'),
    delete: booleanSchema.description('If true then do not store matching messages'),
    spam: booleanSchema.description('If true then store matching messages to Junk Mail folder'),
    mailbox: Joi.string().hex().lowercase().length(24).empty('').description('Mailbox ID to store matching messages to'),
    targets: Joi.array()
        .items(
            Joi.string().email({ tlds: false }),
            Joi.string().uri({
                scheme: [/smtps?/, /https?/],
                allowRelative: false,
                relativeOnly: false
            })
        )
        .empty('')
        .description(
            'An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to'
        )
})
    .default({})
    .description('Action to take with a matching message')
    .$_setFlag('objectName', 'Action');

const FilterQuery = Joi.object({
    from: Joi.string().trim().max(255).empty('').description('Partial match for the From: header (case insensitive)'),
    to: Joi.string().trim().max(255).empty('').description('Partial match for the To:/Cc: headers (case insensitive)'),
    subject: Joi.string().trim().max(255).empty('').description('Partial match for the Subject: header (case insensitive)'),
    listId: Joi.string().trim().max(255).empty('').description('Partial match for the List-ID: header (case insensitive)'),
    text: Joi.string()
        .trim()
        .max(255)
        .empty('')
        .description(
            'Fulltext search against message text. Implements boolean logic where terms like OR and AND are treated as boolean operators. Space and commas are to be treated as AND terms as there is no separate "AND" term. Supports exact matches enclosed in double quotes "exact match text".'
        )
        .example('urgent,immediate OR deadline OR meeting standup'),
    ha: booleanSchema.description('Does a message have to have an attachment or not'),
    size: Joi.number()
        .empty('')
        .description(
            'Message size in bytes. If the value is a positive number then message needs to be larger, if negative then message needs to be smaller than abs(size) value'
        )
})
    .default({})
    .description('Rules that a message must match')
    .$_setFlag('objectName', 'Query');

const FilterActionUpdate = FilterAction.keys({
    spam: booleanSchema.allow(null).description('If true then store matching messages to Junk Mail folder (null clears action)')
});

module.exports = { FilterAction, FilterQuery, FilterActionUpdate };
