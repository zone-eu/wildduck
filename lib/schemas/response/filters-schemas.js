'use strict';

const Joi = require('joi');
const { booleanSchema } = require('../../schemas');
const { FilterQuery, FilterAction } = require('../request/filters-schemas');

const filterStringValue = Joi.alternatives().try(Joi.string(), Joi.number());

const GetAllFiltersResult = Joi.object({
    id: Joi.string().required().description('Filter ID'),
    user: Joi.string().description('User ID'),
    name: Joi.string().description('Name for the filter'),
    created: Joi.date().required().description('Datestring of the time the filter was created'),
    query: Joi.array().items(Joi.array().items(filterStringValue)).required().description('Filter query strings'),
    action: Joi.array().items(Joi.array().items(Joi.string())).required().description('Filter action strings'),
    disabled: booleanSchema.required().description('If true, then this filter is ignored'),
    metaData: Joi.object().description('Custom metadata value. Included if metaData query argument was true'),
    targets: Joi.array().items(Joi.string()).description('List of forwarding targets'),
    originalQuery: FilterQuery.required(),
    originalAction: FilterAction.required()
}).$_setFlag('objectName', 'GetAllFiltersResult');

const GetFiltersResult = Joi.object({
    id: Joi.string().required().description('Filter ID'),
    name: Joi.string().description('Name for the filter'),
    created: Joi.date().required().description('Datestring of the time the filter was created'),
    query: Joi.array().items(Joi.array().items(filterStringValue)).required().description('Filter query strings'),
    action: Joi.array().items(Joi.array().items(Joi.string())).required().description('Filter action strings'),
    disabled: booleanSchema.required().description('If true, then this filter is ignored'),
    metaData: Joi.object().description('Custom metadata value. Included if metaData query argument was true'),
    originalQuery: FilterQuery.required(),
    originalAction: FilterAction.required()
}).$_setFlag('objectName', 'GetFiltersResult');

module.exports = { GetAllFiltersResult, GetFiltersResult };
