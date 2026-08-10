'use strict';

// filter query/action description strings: arrays of [key, value] tuples where
// the value may be a string or a number
const filterStrings = description => ({
    type: 'array',
    items: {
        type: 'array',
        items: {
            anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }]
        }
    },
    description
});

const commonFilterResultProperties = {
    id: { type: 'string', description: 'Filter ID' },
    name: { type: 'string', description: 'Name for the filter' },
    created: { type: 'string', format: 'date-time', description: 'Datestring of the time the filter was created' },
    query: filterStrings('Filter query strings'),
    action: filterStrings('Filter action strings'),
    disabled: { type: 'boolean', description: 'If true, then this filter is ignored' },
    metaData: { description: 'Custom metadata value. Included if metaData query argument was true' },
    // raw stored query/action objects echoed back, shapes may predate the
    // current request schema so they stay unconstrained
    originalQuery: { type: 'object', additionalProperties: true },
    originalAction: { type: 'object', additionalProperties: true }
};

// `created` is echoed straight from the filter document and is absent on
// records written outside the API, so it is not part of the contract
const filterResultRequired = ['id', 'query', 'action', 'disabled', 'originalQuery', 'originalAction'];

const GetAllFiltersResult = {
    type: 'object',
    title: 'GetAllFiltersResult',
    properties: Object.assign({}, commonFilterResultProperties, {
        user: { type: 'string', description: 'User ID' },
        targets: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of forwarding targets'
        }
    }),
    required: filterResultRequired
};

const GetFiltersResult = {
    type: 'object',
    title: 'GetFiltersResult',
    properties: commonFilterResultProperties,
    required: filterResultRequired
};

module.exports = { GetAllFiltersResult, GetFiltersResult };
