'use strict';

const log = require('npmlog');
const { objectIdSchema } = require('../schemas/json-schemas');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const roles = require('../roles');
const { publish, FILTER_DELETED, FILTER_CREATED, FORWARD_ADDED } = require('../events');
const { GetAllFiltersResult, GetFiltersResult } = require('../schemas/response/filters-schemas');
const { FilterQuery, FilterAction } = require('../schemas/request/filters-schemas');
const { mongopagingFindWrapper } = require('../mongopaging-find-wrapper');

const filterIdParam = objectIdSchema('ID of the Filter', { wdRequired: true });

// Joi treated .default({}).required() as required when the key is absent
// (default never satisfies required); Ajv useDefaults fills before the
// required check, so the create route uses the schema without the default
const requiredFilterObject = base => {
    const schema = Object.assign({}, base, { wdRequired: true });
    delete schema.default;
    return schema;
};

const filterNameSchema = {
    type: 'string',
    maxLength: 255,
    minLength: 1,
    wdTrim: true,
    wdEmpty: true,
    description: 'Name of the Filter'
};

const successResponse = title => ({
    200: {
        description: 'Success',
        model: {
            type: 'object',
            title,
            properties: { success: { $ref: 'wd:successRes' } },
            required: ['success']
        }
    }
});

module.exports = (db, server, userHandler, settingsHandler) => {
    server.route({
        method: 'GET',
        url: '/filters',
        schema: {
            summary: 'List all Filters',
            tags: ['Filters']
        },
        config: {
            name: 'getAllFilters',
            allowUnknown: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    forward: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        description: 'Partial match of a forward email address or URL'
                    },
                    metaData: { $ref: 'wd:boolean', description: 'If true, then includes metaData in the response' },
                    limit: { $ref: 'wd:pageLimit' },
                    next: { $ref: 'wd:cursor', description: 'Cursor value for next page, retrieved from nextCursor response value' },
                    previous: { $ref: 'wd:cursor', description: 'Cursor value for previous page, retrieved from previousCursor response value' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetAllFiltersResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                total: { $ref: 'wd:totalRes' },
                                page: { $ref: 'wd:pageRes' },
                                previousCursor: { $ref: 'wd:previousCursorRes' },
                                nextCursor: { $ref: 'wd:nextCursorRes' },
                                results: { type: 'array', items: GetAllFiltersResult, description: 'Address listing' }
                            },
                            required: ['success', 'total', 'page', 'previousCursor', 'nextCursor', 'results']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

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

            let forward = values.forward;
            let limit = values.limit;
            let pageNext = values.next;
            let pagePrevious = values.previous;

            let includeMetaData = values.metaData;

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
            }
            if (pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listingWrapper;
            try {
                listingWrapper = await mongopagingFindWrapper(db.database.collection('filters'), opts);
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let mailboxList = Array.from(
                new Set(
                    (listingWrapper.listing.results || [])
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
                    return reply.code(500).send({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }
            }

            let response = {
                success: true,
                total,
                page: listingWrapper.page,
                previousCursor: listingWrapper.previousCursor,
                nextCursor: listingWrapper.nextCursor,
                results: (listingWrapper.listing.results || []).map(filterData => {
                    let descriptions = getFilterStrings(filterData, mailboxes, { preserveTargetUrls: true });

                    let values = {
                        id: filterData._id.toString(),
                        user: filterData.user.toString(),
                        name: filterData.name,
                        query: descriptions.query,
                        action: descriptions.action,
                        originalQuery: {},
                        originalAction: {},
                        disabled: !!filterData.disabled,
                        created: filterData.created,
                        targets: filterData.action && filterData.action.targets && filterData.action.targets.map(t => t.value)
                    };

                    Object.keys((filterData.query && filterData.query.headers) || {}).forEach(key => {
                        values.originalQuery[key] = filterData.query.headers[key];
                    });

                    Object.keys(filterData.query || {}).forEach(key => {
                        if (key !== 'headers') {
                            values.originalQuery[key] = filterData.query[key];
                        }
                    });

                    Object.keys(filterData.action || {}).forEach(key => {
                        if (key === 'targets') {
                            values.originalAction.targets = filterData.action.targets.map(target => target.value);
                            return;
                        }

                        switch (key) {
                            case 'mailbox':
                                // cast ObjectId value to a string, otherwise `permission.filter` will mess up the value
                                values.originalAction[key] = filterData.action[key].toString();
                                break;
                            default:
                                values.originalAction[key] = filterData.action[key];
                        }
                    });

                    if (includeMetaData && filterData.metaData) {
                        values.metaData = tools.formatMetaData(filterData.metaData);
                    }

                    return permission.filter(values);
                })
            };

            return reply.send(response);
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/filters',
        schema: {
            summary: 'List Filters for a User',
            tags: ['Filters']
        },
        config: {
            name: 'getFilters',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    metaData: { $ref: 'wd:boolean', description: 'If true, then includes metaData in the response' },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetFiltersResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                limits: {
                                    type: 'object',
                                    description: 'Filter usage limits for the user account',
                                    properties: {
                                        allowed: { type: 'number', description: 'How many filters are allowed' },
                                        used: { type: 'number', description: 'How many filters have been created' }
                                    }
                                },
                                results: { type: 'array', items: GetFiltersResult, description: 'Filter description' }
                            },
                            required: ['success', 'limits', 'results']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            let permission;
            if (req.user && req.user === values.user) {
                permission = roles.can(req.role).readOwn('filters');
            } else {
                permission = roles.can(req.role).readAny('filters');
            }
            req.validate(permission);

            let user = new ObjectId(values.user);

            let includeMetaData = values.metaData;

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
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!userData) {
                return reply.code(404).send({
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
                return reply.code(500).send({
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
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!filters) {
                filters = [];
            }

            return reply.send({
                success: true,

                limits: {
                    allowed: maxFilters,
                    used: filters.length
                },

                results: filters.map(filterData => {
                    let descriptions = getFilterStrings(filterData, mailboxes, { preserveTargetUrls: true });

                    const values = {
                        id: filterData._id.toString(),
                        name: filterData.name,
                        query: descriptions.query,
                        action: descriptions.action,
                        originalQuery: {},
                        originalAction: {},
                        disabled: !!filterData.disabled,
                        created: filterData.created
                    };

                    Object.keys((filterData.query && filterData.query.headers) || {}).forEach(key => {
                        values.originalQuery[key] = filterData.query.headers[key];
                    });

                    Object.keys(filterData.query || {}).forEach(key => {
                        if (key !== 'headers') {
                            values.originalQuery[key] = filterData.query[key];
                        }
                    });

                    Object.keys(filterData.action || {}).forEach(key => {
                        if (key === 'targets') {
                            values.originalAction.targets = filterData.action.targets.map(target => target.value);
                            return;
                        }

                        switch (key) {
                            case 'mailbox':
                                // cast ObjectId value to a string, otherwise `permission.filter` will mess up the value
                                values.originalAction[key] = filterData.action[key].toString();
                                break;
                            default:
                                values.originalAction[key] = filterData.action[key];
                        }
                    });

                    if (includeMetaData && filterData.metaData) {
                        values.metaData = tools.formatMetaData(filterData.metaData);
                    }

                    return permission.filter(values);
                })
            });
        }
    });

    server.route({
        method: 'GET',
        url: '/users/:user/filters/:filter',
        schema: {
            summary: 'Request Filter information',
            tags: ['Filters']
        },
        config: {
            name: 'getFilter',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    filter: filterIdParam
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetFilterResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Filter' },
                                name: { type: 'string', description: 'Name for the filter' },
                                created: { type: 'string', format: 'date-time', description: 'Datestring of the time the filter was created' },
                                query: { type: 'object', additionalProperties: true, description: 'Rules that a message must match' },
                                action: { type: 'object', additionalProperties: true, description: 'Action to take with a matching message' },
                                disabled: { type: 'boolean', description: 'If true, then this filter is ignored' },
                                metaData: { description: 'Custom metadata value' }
                            },
                            required: ['success', 'id', 'created', 'query', 'action', 'disabled']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            let permission;
            if (req.user && req.user === values.user) {
                permission = roles.can(req.role).readOwn('filters');
            } else {
                permission = roles.can(req.role).readAny('filters');
            }
            req.validate(permission);

            let user = new ObjectId(values.user);
            let filter = new ObjectId(values.filter);

            let filterData;
            try {
                filterData = await db.database.collection('filters').findOne({
                    _id: filter,
                    user
                });
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!filterData) {
                return reply.code(404).send({
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
                return reply.code(500).send({
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

            return reply.send(permission.filter(response));
        }
    });

    server.route({
        method: 'DELETE',
        url: '/users/:user/filters/:filter',
        schema: {
            summary: 'Delete a Filter',
            tags: ['Filters']
        },
        config: {
            name: 'deleteFilter',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    filter: filterIdParam
                },
                response: successResponse('SuccessResponse')
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).deleteOwn('filters'));
            } else {
                req.validate(roles.can(req.role).deleteAny('filters'));
            }

            let user = new ObjectId(values.user);
            let filter = new ObjectId(values.filter);

            let r;

            try {
                r = await db.database.collection('filters').deleteOne({
                    _id: filter,
                    user
                });
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!r.deletedCount) {
                return reply.code(404).send({
                    error: 'Filter was not found',
                    code: 'FilterNotFound'
                });
            }

            await publish(db.redis, {
                ev: FILTER_DELETED,
                user,
                filter
            });

            return reply.send({
                success: true
            });
        }
    });

    server.route({
        method: 'POST',
        url: '/users/:user/filters',
        schema: {
            summary: 'Create a new Filter',
            tags: ['Filters']
        },
        config: {
            name: 'createFilter',
            validationObjs: {
                requestBody: {
                    name: filterNameSchema,

                    query: requiredFilterObject(FilterQuery),
                    action: requiredFilterObject(FilterAction),

                    disabled: { $ref: 'wd:boolean', default: false, description: 'If true then this filter is ignored' },

                    metaData: { $ref: 'wd:metaData', description: 'Optional metadata, must be an object or JSON formatted string' },

                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {
                    user: { $ref: 'wd:userId' }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'UpdateFilterResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID for the created filter' }
                            },
                            required: ['success', 'id']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).createOwn('filters'));
            } else {
                req.validate(roles.can(req.role).createAny('filters'));
            }

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
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!userData) {
                return reply.code(404).send({
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
                return reply.code(403).send({
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
                        return reply.code(400).send({
                            error: 'Unknown target type "' + target + '"',
                            code: 'InputValidationError'
                        });
                    }
                }

                filterData.action.targets = targets;
            }

            let targetMailboxData;
            if (values.action.mailbox) {
                try {
                    targetMailboxData = await db.database.collection('mailboxes').findOne({
                        _id: new ObjectId(values.action.mailbox),
                        user
                    });
                } catch (err) {
                    return reply.code(500).send({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }

                if (!targetMailboxData) {
                    return reply.code(404).send({
                        error: 'This mailbox does not exist',
                        code: 'NoSuchMailbox'
                    });
                }

                filterData.action.mailbox = targetMailboxData._id;
            }

            let r;
            try {
                r = await db.database.collection('filters').insertOne(filterData);
            } catch (err) {
                return reply.code(500).send({
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
                _mailbox_path: targetMailboxData && targetMailboxData.path,
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

            return reply.send({
                success: r.acknowledged,
                id: filterData._id.toString()
            });
        }
    });

    server.route({
        method: 'PUT',
        url: '/users/:user/filters/:filter',
        schema: {
            summary: 'Update Filter information',
            tags: ['Filters']
        },
        config: {
            name: 'updateFilter',
            validationObjs: {
                requestBody: {
                    name: filterNameSchema,

                    query: FilterQuery,
                    action: FilterAction,

                    disabled: { $ref: 'wd:boolean', description: 'If true then this filter is ignored' },

                    metaData: { $ref: 'wd:metaData', description: 'Optional metadata, must be an object or JSON formatted string' },

                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    filter: filterIdParam
                },
                response: successResponse('UpdateFilterResponse')
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            if (req.user && req.user === values.user) {
                req.validate(roles.can(req.role).updateOwn('filters'));
            } else {
                req.validate(roles.can(req.role).updateAny('filters'));
            }

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

            if (req.rawParams.query) {
                ['from', 'to', 'subject', 'listId'].forEach(key => {
                    if (values.query[key]) {
                        $set['query.headers.' + key] = values.query[key].replace(/\s+/g, ' ');
                        hasChanges = true;
                    } else if (key in req.rawParams.query) {
                        // delete empty values
                        $unset['query.headers.' + key] = true;
                        hasChanges = true;
                    }
                });

                if (values.query.text) {
                    $set['query.text'] = values.query.text.replace(/\s+/g, ' ');
                    hasChanges = true;
                } else if ('text' in req.rawParams.query) {
                    $unset['query.text'] = true;
                    hasChanges = true;
                }

                if (typeof values.query.ha === 'boolean') {
                    $set['query.ha'] = values.query.ha;
                    hasChanges = true;
                } else if ('ha' in req.rawParams.query) {
                    $unset['query.ha'] = true;
                    hasChanges = true;
                }

                if (values.query.size) {
                    $set['query.size'] = values.query.size;
                    hasChanges = true;
                } else if ('size' in req.rawParams.query) {
                    $unset['query.size'] = true;
                    hasChanges = true;
                }
            }

            let targets;

            if (req.rawParams.action) {
                ['seen', 'flag', 'delete', 'spam'].forEach(key => {
                    if (typeof values.action[key] === 'boolean') {
                        $set['action.' + key] = values.action[key];
                        hasChanges = true;
                    } else if (key in req.rawParams.action) {
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
                            return reply.code(400).send({
                                error: 'Unknown target type "' + target + '"',
                                code: 'InputValidationError'
                            });
                        }
                    }

                    $set['action.targets'] = targets;
                    hasChanges = true;
                } else if ('targets' in req.rawParams.action) {
                    $unset['action.targets'] = true;
                    hasChanges = true;
                }

                if (values.action) {
                    if (!values.action.mailbox) {
                        if ('mailbox' in req.rawParams.action) {
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
                            return reply.code(500).send({
                                error: 'MongoDB Error: ' + err.message,
                                code: 'InternalDatabaseError'
                            });
                        }

                        if (!mailboxData) {
                            return reply.code(404).send({
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
                return reply.send({
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
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!r || !r.value || !r.value._id) {
                return reply.code(404).send({
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

            return reply.send({
                success: true
            });
        }
    });
};

function getFilterStrings(filter, mailboxes, options) {
    options = options || {};

    let query = Object.keys(filter.query.headers || {}).map(key => [key, '(' + filter.query.headers[key] + ')']);

    if (filter.query.ha && filter.query.ha > 0) {
        query.push(['has attachment']);
    } else if (filter.query.ha && filter.query.ha < 0) {
        query.push(['no attachments']);
    }

    if (filter.query.text) {
        query.push(['text', '"' + filter.query.text + '"']);
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
                                    if (target.type === 'http' && !options.preserveTargetUrls) {
                                        try {
                                            let parsed = new URL(target.value);
                                            return parsed.hostname || parsed.host || target.value;
                                        } catch (err) {
                                            return target.value;
                                        }
                                    }

                                    return target.value;
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
