'use strict';

const log = require('npmlog');
const Joi = require('joi');
const ObjectId = require('mongodb').ObjectId;
const MongoPaging = require('mongo-cursor-pagination');
const urllib = require('url');
const tools = require('../tools');
const roles = require('../roles');
const { nextPageCursorSchema, previousPageCursorSchema, pageNrSchema, sessSchema, sessIPSchema, booleanSchema, metaDataSchema } = require('../schemas');
const { publish, FILTER_DELETED, FILTER_CREATED, FORWARD_ADDED } = require('../events');
const { successRes, totalRes, previousCursorRes, nextCursorRes } = require('../schemas/response/general-schemas');
const { GetAllFiltersResult, GetFiltersResult } = require('../schemas/response/filters-schemas');
const { FilterQuery, FilterAction } = require('../schemas/request/filters-schemas');
const { userId, filterId } = require('../schemas/request/general-schemas');

module.exports = (db, server, userHandler, settingsHandler) => {
    server.get(
        {
            name: 'getAllFilters',
            path: '/filters',
            summary: 'List all Filters',
            tags: ['Filters'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    forward: Joi.string().trim().empty('').max(255).description('Partial match of a forward email address or URL'),
                    metaData: booleanSchema.description('If true, then includes metaData in the response'),
                    limit: Joi.number().default(20).min(1).max(250).description('How many records to return'),
                    next: nextPageCursorSchema,
                    previous: previousPageCursorSchema,
                    page: pageNrSchema,
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            total: totalRes,
                            page: Joi.number().required().description('Current page number. Derived from page query argument.'),
                            previousCursor: previousCursorRes,
                            nextCursor: nextCursorRes,
                            results: Joi.array().items(GetAllFiltersResult).required().description('Address listing')
                        }).$_setFlag('objectName', 'GetAllFiltersResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true,
                allowUnknown: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            let permission;
            let ownOnly = false;
            permission = roles.can(req.role).readAny('filters');
            if (!permission.granted && req.user && ObjectId.isValid(req.user)) {
                permission = roles.can(req.role).readOwn('filters');
                if (permission.granted) {
                    ownOnly = true;
                }
            }
            // permissions check
            req.validate(permission);

            let forward = result.value.forward;
            let limit = result.value.limit;
            let page = result.value.page;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;

            let includeMetaData = result.value.metaData;

            let filter = {};

            if (forward) {
                filter['action.targets.value'] = {
                    $regex: tools.escapeRegexStr(forward),
                    $options: ''
                };
            }

            if (ownOnly) {
                filter.user = new ObjectId(req.user);
            }

            let total = await db.database.collection('filters').countDocuments(filter);
            let opts = {
                limit,
                query: filter,
                paginatedField: '_id',
                sortAscending: true
            };

            if (pageNext) {
                opts.next = pageNext;
            } else if ((!page || page > 1) && pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listing;
            try {
                listing = await MongoPaging.find(db.database.collection('filters'), opts);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!listing.hasPrevious) {
                page = 1;
            }

            let mailboxList = Array.from(
                new Set(
                    (listing.results || [])
                        .map(filterData => {
                            if (filterData.action && filterData.action.mailbox) {
                                return filterData.action.mailbox.toString();
                            }
                            return false;
                        })
                        .filter(mailbox => mailbox)
                )
            ).map(mailbox => new ObjectId(mailbox));

            let mailboxes = [];
            if (mailboxList.length) {
                try {
                    mailboxes = await db.database
                        .collection('mailboxes')
                        .find({
                            _id: { $in: mailboxList }
                        })
                        .project({ _id: 1, path: 1 })
                        .sort({ _id: 1 })
                        .toArray();
                } catch (err) {
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }
            }

            let response = {
                success: true,
                total,
                page,
                previousCursor: listing.hasPrevious ? listing.previous : false,
                nextCursor: listing.hasNext ? listing.next : false,
                results: (listing.results || []).map(filterData => {
                    let descriptions = getFilterStrings(filterData, mailboxes);

                    let values = {
                        id: filterData._id.toString(),
                        user: filterData.user.toString(),
                        name: filterData.name,
                        query: descriptions.query,
                        action: descriptions.action,
                        disabled: !!filterData.disabled,
                        created: filterData.created,
                        targets: filterData.action && filterData.action.targets && filterData.action.targets.map(t => t.value)
                    };

                    if (includeMetaData && filterData.metaData) {
                        values.metaData = tools.formatMetaData(filterData.metaData);
                    }

                    return permission.filter(values);
                })
            };

            return res.json(response);
        })
    );

    server.get(
        {
            path: '/users/:user/filters',
            summary: 'List Filters for a User',
            name: 'getFilters',
            tags: ['Filters'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    metaData: booleanSchema.description('If true, then includes metaData in the response'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            limits: Joi.object({
                                allowed: Joi.number().description('How many filters are allowed'),
                                used: Joi.number().description('How many filters have been created')
                            })
                                .required()
                                .description('Filter usage limits for the user account'),
                            results: Joi.array().items(GetFiltersResult).required().description('Filter description')
                        }).$_setFlag('objectName', 'GetFiltersResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            let permission;
            if (req.user && req.user === result.value.user) {
                permission = roles.can(req.role).readOwn('filters');
            } else {
                permission = roles.can(req.role).readAny('filters');
            }
            req.validate(permission);

            let user = new ObjectId(result.value.user);

            let includeMetaData = result.value.metaData;

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            filters: true
                        }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!userData) {
                res.status(404);
                return res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
            }

            let settings = await settingsHandler.getMulti(['const:max:filters']);
            let maxFilters = Number(userData.filters) || settings['const:max:filters'];

            let mailboxes;
            try {
                mailboxes = await db.database
                    .collection('mailboxes')
                    .find({
                        user
                    })
                    .project({ _id: 1, path: 1 })
                    .sort({ _id: 1 })
                    .toArray();
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!mailboxes) {
                mailboxes = [];
            }

            let filters;
            try {
                filters = await db.database
                    .collection('filters')
                    .find({
                        user
                    })
                    .sort({
                        _id: 1
                    })
                    .toArray();
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!filters) {
                filters = [];
            }

            return res.json({
                success: true,

                limits: {
                    allowed: maxFilters,
                    used: filters.length
                },

                results: filters.map(filterData => {
                    let descriptions = getFilterStrings(filterData, mailboxes);

                    const values = {
                        id: filterData._id.toString(),
                        name: filterData.name,
                        query: descriptions.query,
                        action: descriptions.action,
                        disabled: !!filterData.disabled,
                        created: filterData.created
                    };

                    if (includeMetaData && filterData.metaData) {
                        values.metaData = tools.formatMetaData(filterData.metaData);
                    }

                    return permission.filter(values);
                })
            });
        })
    );

    server.get(
        {
            path: '/users/:user/filters/:filter',
            summary: 'Request Filter information',
            name: 'getFilter',
            tags: ['Filters'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    filter: filterId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: filterId,
                            name: Joi.string().required().description('Name for the filter'),
                            created: Joi.date().required().description('Datestring of the time the filter was created'),
                            query: FilterQuery.required(),
                            action: FilterAction.required(),
                            disabled: booleanSchema.required().description('If true, then this filter is ignored'),
                            metaData: Joi.object().description('Custom metadata value')
                        }).$_setFlag('objectName', 'GetFilterResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            let permission;
            if (req.user && req.user === result.value.user) {
                permission = roles.can(req.role).readOwn('filters');
            } else {
                permission = roles.can(req.role).readAny('filters');
            }
            req.validate(permission);

            let user = new ObjectId(result.value.user);
            let filter = new ObjectId(result.value.filter);

            let filterData;
            try {
                filterData = await db.database.collection('filters').findOne({
                    _id: filter,
                    user
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!filterData) {
                res.status(404);
                return res.json({
                    error: 'This filter does not exist',
                    code: 'FilterNotFound'
                });
            }

            let mailboxes;
            try {
                mailboxes = await db.database
                    .collection('mailboxes')
                    .find({
                        user
                    })
                    .project({ _id: 1, path: 1 })
                    .sort({ _id: 1 })
                    .toArray();
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!mailboxes) {
                mailboxes = [];
            }

            let response = {
                success: true,
                id: filterData._id.toString(),
                name: filterData.name,
                query: {},
                action: {},
                disabled: !!filterData.disabled,
                created: filterData.created
            };

            Object.keys((filterData.query && filterData.query.headers) || {}).forEach(key => {
                response.query[key] = filterData.query.headers[key];
            });

            Object.keys(filterData.query || {}).forEach(key => {
                if (key !== 'headers') {
                    response.query[key] = filterData.query[key];
                }
            });

            Object.keys(filterData.action || {}).forEach(key => {
                if (key === 'targets') {
                    response.action.targets = filterData.action.targets.map(target => target.value);
                    return;
                }

                switch (key) {
                    case 'mailbox':
                        // cast ObjectId value to a string, otherwise `permission.filter` will mess up the value
                        response.action[key] = filterData.action[key].toString();
                        break;
                    default:
                        response.action[key] = filterData.action[key];
                }
            });

            if (filterData.metaData) {
                response.metaData = tools.formatMetaData(filterData.metaData);
            }

            return res.json(permission.filter(response));
        })
    );

    server.del(
        {
            path: '/users/:user/filters/:filter',
            summary: 'Delete a Filter',
            name: 'deleteFilter',
            tags: ['Filters'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    filter: filterId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes
                        }).$_setFlag('objectName', 'SuccessResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).deleteOwn('filters'));
            } else {
                req.validate(roles.can(req.role).deleteAny('filters'));
            }

            let user = new ObjectId(result.value.user);
            let filter = new ObjectId(result.value.filter);

            let r;

            try {
                r = await db.database.collection('filters').deleteOne({
                    _id: filter,
                    user
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!r.deletedCount) {
                res.status(404);
                return res.json({
                    error: 'Filter was not found',
                    code: 'FilterNotFound'
                });
            }

            await publish(db.redis, {
                ev: FILTER_DELETED,
                user,
                filter
            });

            return res.json({
                success: true
            });
        })
    );

    server.post(
        {
            path: '/users/:user/filters',
            summary: 'Create a new Filter',
            name: 'createFilter',
            tags: ['Filters'],
            validationObjs: {
                requestBody: {
                    name: Joi.string().trim().max(255).empty('').description('Name of the Filter'),

                    query: FilterQuery.required(),
                    action: FilterAction.required(),

                    disabled: booleanSchema.default(false).description('If true then this filter is ignored'),

                    metaData: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),

                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    user: userId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: Joi.string().required().description('ID for the created filter')
                        }).$_setFlag('objectName', 'UpdateFilterResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).createOwn('filters'));
            } else {
                req.validate(roles.can(req.role).createAny('filters'));
            }

            let values = result.value;

            let user = new ObjectId(values.user);

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            filters: true
                        }
                    }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!userData) {
                res.status(404);
                return res.json({
                    error: 'This user does not exist',
                    code: 'UserNotFound'
                });
            }

            let settings = await settingsHandler.getMulti(['const:max:filters']);
            let maxFilters = Number(userData.filters) || settings['const:max:filters'];
            const filtersCount = await db.database.collection('filters').countDocuments({
                user
            });

            if (filtersCount >= maxFilters) {
                res.status(403);
                return res.json({
                    error: 'Maximum filters limit reached',
                    code: 'TooMany',
                    allowed: maxFilters
                });
            }

            let filterData = {
                _id: new ObjectId(),
                user,
                query: {
                    headers: {}
                },
                action: {},
                disabled: values.disabled,
                created: new Date()
            };

            if (values.name) {
                filterData.name = values.name;
            }

            if (values.metaData) {
                filterData.metaData = values.metaData;
            }

            ['from', 'to', 'subject', 'listId'].forEach(key => {
                if (values.query[key]) {
                    filterData.query.headers[key] = values.query[key].replace(/\s+/g, ' ');
                }
            });

            if (values.query.text) {
                filterData.query.text = values.query.text.replace(/\s+/g, ' ');
            }

            if (typeof values.query.ha === 'boolean') {
                filterData.query.ha = values.query.ha;
            }

            if (values.query.size) {
                filterData.query.size = values.query.size;
            }

            ['seen', 'flag', 'delete', 'spam'].forEach(key => {
                if (typeof values.action[key] === 'boolean') {
                    filterData.action[key] = values.action[key];
                }
            });

            let targets = values.action.targets;
            if (targets) {
                for (let i = 0, len = targets.length; i < len; i++) {
                    let target = targets[i];
                    if (!/^smtps?:/i.test(target) && !/^https?:/i.test(target) && target.indexOf('@') >= 0) {
                        // email
                        targets[i] = {
                            id: new ObjectId(),
                            type: 'mail',
                            value: target
                        };
                    } else if (/^smtps?:/i.test(target)) {
                        targets[i] = {
                            id: new ObjectId(),
                            type: 'relay',
                            value: target
                        };
                    } else if (/^https?:/i.test(target)) {
                        targets[i] = {
                            id: new ObjectId(),
                            type: 'http',
                            value: target
                        };
                    } else {
                        res.status(400);
                        return res.json({
                            error: 'Unknown target type "' + target + '"',
                            code: 'InputValidationError'
                        });
                    }
                }

                filterData.action.targets = targets;
            }

            if (values.action.mailbox) {
                let mailboxData;
                try {
                    mailboxData = await db.database.collection('mailboxes').findOne({
                        _id: new ObjectId(values.action.mailbox),
                        user
                    });
                } catch (err) {
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }

                if (!mailboxData) {
                    res.status(404);
                    return res.json({
                        error: 'This mailbox does not exist',
                        code: 'NoSuchMailbox'
                    });
                }

                filterData.action.mailbox = mailboxData._id;
            }

            let r;
            try {
                r = await db.database.collection('filters').insertOne(filterData);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (r.acknowledged) {
                await publish(db.redis, {
                    ev: FILTER_CREATED,
                    user,
                    filter: filterData._id
                });
            }

            if (targets) {
                for (let target of targets) {
                    // log as new redirect targets
                    try {
                        await userHandler.logAuthEvent(user, {
                            action: 'filter forward added',
                            result: 'success',
                            target: target.value,
                            filter: filterData._id,
                            protocol: 'API',
                            sess: values.sess,
                            ip: values.ip
                        });
                    } catch (err) {
                        log.error('API', err);
                    }

                    await publish(db.redis, {
                        ev: FORWARD_ADDED,
                        user,
                        type: 'filter',
                        filter: filterData._id,
                        target: target.value
                    });
                }
            }

            const filterStrings = getFilterStrings(filterData);

            // Log added filter to graylog
            userHandler.loggelf({
                short_message: '[FILTERS] Added new filter',
                _user: user,
                _mailbox: filterData.action.mailbox,
                _filter_id: filterData._id.toString(),
                _filter_query: filterStrings.query.map(item => item.filter(val => val).join(': ')).join(', '),
                _filter_action: filterStrings.action.map(item => item.filter(val => val).join(': ')).join(', '),
                _filter_name: filterData.name,
                _filter_created: filterData.created,
                _filter_disabled: filterData.disabled
            });

            // Log added filter to authlog as well
            try {
                await userHandler.logAuthEvent(user, {
                    action: 'filter added',
                    result: 'success',
                    filter: filterData._id,
                    protocol: 'API',
                    sess: values.sess,
                    ip: values.ip
                });
            } catch (err) {
                log.error('API [Filter]', err);
            }

            return res.json({
                success: r.acknowledged,
                id: filterData._id.toString()
            });
        })
    );

    server.put(
        {
            path: '/users/:user/filters/:filter',
            summary: 'Update Filter information',
            name: 'updateFilter',
            tags: ['Filters'],
            validationObjs: {
                requestBody: {
                    name: Joi.string().trim().max(255).empty('').description('Name of the Filter'),

                    query: FilterQuery,
                    action: FilterAction,

                    disabled: booleanSchema.description('If true then this filter is ignored'),

                    metaData: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),

                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    user: userId,
                    filter: filterId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes
                        }).$_setFlag('objectName', 'UpdateFilterResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...requestBody,
                ...queryParams
            });

            const result = schema.validate(req.params, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                return res.json({
                    error: result.error.message,
                    code: 'InputValidationError',
                    details: tools.validationErrors(result)
                });
            }

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).updateOwn('filters'));
            } else {
                req.validate(roles.can(req.role).updateAny('filters'));
            }

            let values = result.value;

            let user = new ObjectId(values.user);
            let filter = new ObjectId(values.filter);

            let $set = {};
            let $unset = {};

            let hasChanges = false;

            if (values.name) {
                $set.name = values.name;
                hasChanges = true;
            }

            if (typeof values.disabled === 'boolean') {
                $set.disabled = values.disabled;
                hasChanges = true;
            }

            if (values.metaData) {
                $set.metaData = values.metaData;
                hasChanges = true;
            }

            if (req.params.query) {
                ['from', 'to', 'subject', 'listId'].forEach(key => {
                    if (values.query[key]) {
                        $set['query.headers.' + key] = values.query[key].replace(/\s+/g, ' ');
                        hasChanges = true;
                    } else if (key in req.params.query) {
                        // delete empty values
                        $unset['query.headers.' + key] = true;
                        hasChanges = true;
                    }
                });

                if (values.query.text) {
                    $set['query.text'] = values.query.text.replace(/\s+/g, ' ');
                    hasChanges = true;
                } else if ('text' in req.params.query) {
                    $unset['query.text'] = true;
                    hasChanges = true;
                }

                if (typeof values.query.ha === 'boolean') {
                    $set['query.ha'] = values.query.ha;
                    hasChanges = true;
                } else if ('ha' in req.params.query) {
                    $unset['query.ha'] = true;
                    hasChanges = true;
                }

                if (values.query.size) {
                    $set['query.size'] = values.query.size;
                    hasChanges = true;
                } else if ('size' in req.params.query) {
                    $unset['query.size'] = true;
                    hasChanges = true;
                }
            }

            let targets;

            if (req.params.action) {
                ['seen', 'flag', 'delete', 'spam'].forEach(key => {
                    if (typeof values.action[key] === 'boolean') {
                        $set['action.' + key] = values.action[key];
                        hasChanges = true;
                    } else if (key in req.params.action) {
                        $unset['action.' + key] = true;
                        hasChanges = true;
                    }
                });

                targets = values.action.targets;

                if (targets) {
                    for (let i = 0, len = targets.length; i < len; i++) {
                        let target = targets[i];
                        if (!/^smtps?:/i.test(target) && !/^https?:/i.test(target) && target.indexOf('@') >= 0) {
                            // email
                            targets[i] = {
                                id: new ObjectId(),
                                type: 'mail',
                                value: target
                            };
                        } else if (/^smtps?:/i.test(target)) {
                            targets[i] = {
                                id: new ObjectId(),
                                type: 'relay',
                                value: target
                            };
                        } else if (/^https?:/i.test(target)) {
                            targets[i] = {
                                id: new ObjectId(),
                                type: 'http',
                                value: target
                            };
                        } else {
                            res.status(400);
                            return res.json({
                                error: 'Unknown target type "' + target + '"',
                                code: 'InputValidationError'
                            });
                        }
                    }

                    $set['action.targets'] = targets;
                    hasChanges = true;
                } else if ('targets' in req.params.action) {
                    $unset['action.targets'] = true;
                    hasChanges = true;
                }

                if (values.action) {
                    if (!values.action.mailbox) {
                        if ('mailbox' in req.params.action) {
                            // clear target mailbox
                            $unset['action.mailbox'] = true;
                            hasChanges = true;
                        }
                    } else {
                        let mailboxData;
                        try {
                            mailboxData = await db.database.collection('mailboxes').findOne({
                                _id: new ObjectId(values.action.mailbox),
                                user
                            });
                        } catch (err) {
                            res.status(500);
                            return res.json({
                                error: 'MongoDB Error: ' + err.message,
                                code: 'InternalDatabaseError'
                            });
                        }

                        if (!mailboxData) {
                            res.status(404);
                            return res.json({
                                error: 'This mailbox does not exist',
                                code: 'NoSuchMailbox'
                            });
                        }

                        $set['action.mailbox'] = mailboxData._id;
                        hasChanges = true;
                    }
                }
            }

            if (!hasChanges) {
                return res.json({
                    success: true
                });
            }

            let update = {};

            if (Object.keys($set).length) {
                update.$set = $set;
            }

            if (Object.keys($unset).length) {
                update.$unset = $unset;
            }

            let r;
            try {
                r = await db.database.collection('filters').findOneAndUpdate(
                    {
                        _id: filter,
                        user
                    },
                    update,
                    { returnDocument: 'before' }
                );
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!r || !r.value || !r.value._id) {
                res.status(404);
                return res.json({
                    error: 'Filter was not found',
                    code: 'FilterNotFound'
                });
            }

            let existingFilterData = r.value;
            let existingTargets = ((existingFilterData.action && existingFilterData.action.targets) || []).map(target => target.value);
            // compare new forwards against existing ones
            if (targets) {
                for (let target of targets) {
                    if (!existingTargets.includes(target.value)) {
                        // found new forward
                        try {
                            await userHandler.logAuthEvent(user, {
                                action: 'filter forward added',
                                result: 'success',
                                target: target.value,
                                filter: existingFilterData._id,
                                protocol: 'API',
                                sess: values.sess,
                                ip: values.ip
                            });
                        } catch (err) {
                            log.error('API', err);
                        }

                        await publish(db.redis, {
                            ev: FORWARD_ADDED,
                            user,
                            type: 'filter',
                            filter: existingFilterData._id,
                            target: target.value
                        });
                    }
                }
            }

            return res.json({
                success: true
            });
        })
    );
};

function getFilterStrings(filter, mailboxes) {
    let query = Object.keys(filter.query.headers || {}).map(key => [key, '(' + filter.query.headers[key] + ')']);

    if (filter.query.ha && filter.query.ha > 0) {
        query.push(['has attachment']);
    } else if (filter.query.ha && filter.query.ha < 0) {
        query.push(['no attachments']);
    }

    if (filter.query.text) {
        query.push([false, '"' + filter.query.text + '"']);
    }

    if (filter.query.size) {
        // let unit = 'B';
        let size = Math.abs(filter.query.size || 0);
        if (filter.query.size > 0) {
            query.push(['larger', size /*+ unit*/]);
        } else if (filter.query.size < 0) {
            query.push(['smaller', size /*+ unit*/]);
        }
    }

    // process actions
    let action = Object.keys(filter.action || {})
        .map(key => {
            switch (key) {
                case 'seen':
                    if (filter.action[key]) {
                        return ['mark as read'];
                    } else {
                        return ['do not mark as read'];
                    }
                case 'flag':
                    if (filter.action[key]) {
                        return ['flag it'];
                    } else {
                        return ['do not flag it'];
                    }
                case 'spam':
                    if (filter.action[key]) {
                        return ['mark it as spam'];
                    } else {
                        return ['do not mark it as spam'];
                    }
                case 'delete':
                    if (filter.action[key]) {
                        return ['delete it'];
                    } else {
                        return ['do not delete it'];
                    }
                case 'mailbox':
                    if (filter.action[key]) {
                        let target = mailboxes && mailboxes.find(mailbox => mailbox._id.toString() === filter.action[key].toString());
                        return ['move to folder', target ? '"' + target.path + '"' : filter.action[key].toString()];
                    } else {
                        return ['keep in INBOX'];
                    }
                case 'targets':
                    if (filter.action[key]) {
                        return [
                            'forward to',
                            filter.action[key]
                                .map(target => {
                                    switch (target.type) {
                                        case 'http': {
                                            let parsed = urllib.parse(target.value);
                                            return parsed.hostname || parsed.host;
                                        }

                                        default:
                                            return target.value;
                                    }
                                })
                                .join(', ')
                        ];
                    }
                    break;
            }
            return false;
        })
        .filter(str => str);
    return {
        query,
        action
    };
}
