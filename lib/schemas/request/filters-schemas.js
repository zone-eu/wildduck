'use strict';

// booleanSchema.allow(null): lenient boolean conversion, null clears the action
const nullableBoolean = description => ({
    wdType: 'boolean',
    wdEmpty: true,
    anyOf: [{ type: 'boolean' }, { type: 'null' }],
    description
});

const FilterAction = {
    type: 'object',
    title: 'Action',
    description: 'Action to take with a matching message',
    default: {},
    additionalProperties: false,
    properties: {
        seen: nullableBoolean('If true then mark matching messages as Seen (null clears action)'),
        flag: nullableBoolean('If true then mark matching messages as Flagged (null clears action)'),
        delete: nullableBoolean('If true then do not store matching messages (null clears action)'),
        spam: nullableBoolean('If true then store matching messages to Junk Mail folder (null clears action)'),
        mailbox: {
            type: 'string',
            pattern: '^[0-9a-f]{24}$',
            minLength: 24,
            maxLength: 24,
            wdLowercase: true,
            wdEmpty: true,
            description: 'Mailbox ID to store matching messages to'
        },
        targets: {
            type: 'array',
            wdEmpty: true,
            items: {
                type: 'string',
                anyOf: [{ wdAssert: 'email' }, { wdAssert: 'webhookUrl' }]
            },
            description:
                'An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to'
        }
    }
};

const filterTextQuery = (description, examples) => {
    const schema = {
        type: 'string',
        maxLength: 255,
        minLength: 1,
        wdTrim: true,
        wdEmpty: true,
        description
    };
    if (examples) {
        schema.examples = examples;
    }
    return schema;
};

const FilterQuery = {
    type: 'object',
    title: 'Query',
    description: 'Rules that a message must match',
    default: {},
    additionalProperties: false,
    properties: {
        from: filterTextQuery('Partial match for the From: header (case insensitive)'),
        to: filterTextQuery('Partial match for the To:/Cc: headers (case insensitive)'),
        subject: filterTextQuery('Partial match for the Subject: header (case insensitive)'),
        listId: filterTextQuery('Partial match for the List-ID: header (case insensitive)'),
        text: filterTextQuery(
            'Fulltext search against message text. Implements boolean logic where terms like OR and AND are treated as boolean operators. Space and commas are to be treated as AND terms as there is no separate "AND" term. Supports exact matches enclosed in double quotes "exact match text".',
            ['urgent,immediate OR deadline OR meeting standup']
        ),
        ha: { $ref: 'wd:boolean', description: 'Does a message have to have an attachment or not' },
        size: {
            type: 'number',
            wdType: 'number',
            wdEmpty: true,
            description:
                'Message size in bytes. If the value is a positive number then message needs to be larger, if negative then message needs to be smaller than abs(size) value'
        }
    }
};

module.exports = { FilterAction, FilterQuery };
