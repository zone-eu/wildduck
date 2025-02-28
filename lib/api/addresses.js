'use strict';

const config = require('wild-config');
const Joi = require('joi');
const MongoPaging = require('mongo-cursor-pagination');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const consts = require('../consts');
const roles = require('../roles');
const libmime = require('libmime');
const { nextPageCursorSchema, previousPageCursorSchema, pageNrSchema, sessSchema, sessIPSchema, booleanSchema, metaDataSchema } = require('../schemas');
const log = require('npmlog');
const isemail = require('isemail');
const {
    publish,
    ADDRESS_USER_CREATED,
    ADDRESS_USER_DELETED,
    ADDRESS_FORWARDED_CREATED,
    ADDRESS_FORWARDED_DELETED,
    ADDRESS_DOMAIN_RENAMED
} = require('../events');
const { successRes } = require('../schemas/response/general-schemas');
const {
    GetAddressesResult,
    GetUserAddressesResult,
    GetUserAddressesregisterResult,
    AddressLimits,
    AutoreplyInfo
} = require('../schemas/response/addresses-schemas');
const { userId, addressEmail, addressId } = require('../schemas/request/general-schemas');
const { Autoreply } = require('../schemas/request/addresses-schemas');

module.exports = (db, server, userHandler, settingsHandler) => {
    server.get(
        {
            path: '/addresses',
            summary: 'List registered Addresses',
            name: 'getAddresses',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    query: Joi.string().trim().empty('').max(255).description('Partial match of an address'),
                    forward: Joi.string().trim().empty('').max(255).description('Partial match of a forward email address or URL'),
                    tags: Joi.string().trim().empty('').max(1024).description('Comma separated list of tags. The Address must have at least one to be set'),
                    requiredTags: Joi.string()
                        .trim()
                        .empty('')
                        .max(1024)
                        .description('Comma separated list of tags. The Address must have all listed tags to be set'),
                    metaData: booleanSchema.description('If true, then includes metaData in the response'),
                    internalData: booleanSchema.description('If true, then includes internalData in the response. Not shown for user-role tokens.'),
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
                            query: Joi.string().required().description('Partial match of an address'),
                            total: Joi.number().required().description('How many results were found'),
                            page: Joi.number().required().description('Current page number. Derived from page query argument'),
                            previousCursor: Joi.alternatives()
                                .try(Joi.string(), booleanSchema)
                                .required()
                                .description('Either a cursor string or false if there are not any previous results'),
                            nextCursor: Joi.alternatives()
                                .try(Joi.string(), booleanSchema)
                                .required()
                                .description('Either a cursor string or false if there are not any next results'),
                            results: Joi.array().items(GetAddressesResult).required().description('Address listing')
                        }).$_setFlag('objectName', 'GetAddressesResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
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
            permission = roles.can(req.role).readAny('addresslisting');
            if (!permission.granted && req.user && ObjectId.isValid(req.user)) {
                permission = roles.can(req.role).readOwn('addresslisting');
                if (permission.granted) {
                    ownOnly = true;
                }
            }
            // permissions check
            req.validate(permission);

            let query = result.value.query;
            let forward = result.value.forward;
            let limit = result.value.limit;
            let page = result.value.page;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;

            let filter =
                (query && {
                    address: {
                        // cannot use dotless version as this would break domain search
                        $regex: tools.escapeRegexStr(query),
                        $options: ''
                    }
                }) ||
                {};

            if (forward) {
                filter['targets.value'] = {
                    $regex: tools.escapeRegexStr(forward),
                    $options: ''
                };
            }

            let tagSeen = new Set();

            let requiredTags = (result.value.requiredTags || '')
                .split(',')
                .map(tag => tag.toLowerCase().trim())
                .filter(tag => {
                    if (tag && !tagSeen.has(tag)) {
                        tagSeen.add(tag);
                        return true;
                    }
                    return false;
                });

            let tags = (result.value.tags || '')
                .split(',')
                .map(tag => tag.toLowerCase().trim())
                .filter(tag => {
                    if (tag && !tagSeen.has(tag)) {
                        tagSeen.add(tag);
                        return true;
                    }
                    return false;
                });

            let tagsview = {};
            if (requiredTags.length) {
                tagsview.$all = requiredTags;
            }
            if (tags.length) {
                tagsview.$in = tags;
            }

            if (requiredTags.length || tags.length) {
                filter.tagsview = tagsview;
            }

            if (ownOnly) {
                filter.user = new ObjectId(req.user);
            }

            let total = await db.users.collection('addresses').countDocuments(filter);
            let opts = {
                limit,
                query: filter,
                fields: {
                    addrview: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection: {
                        _id: true,
                        address: true,
                        addrview: true,
                        name: true,
                        user: true,
                        tags: true,
                        tagsview: true,
                        targets: true,
                        forwardedDisabled: true
                    }
                },
                paginatedField: 'addrview',
                sortAscending: true
            };

            if (result.value.metaData) {
                opts.fields.projection.metaData = true;
            }

            if (result.value.internalData) {
                opts.fields.projection.internalData = true;
            }

            if (pageNext) {
                opts.next = pageNext;
            } else if ((!page || page > 1) && pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listing;
            try {
                listing = await MongoPaging.find(db.users.collection('addresses'), opts);
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

            let response = {
                success: true,
                query,
                total,
                page,
                previousCursor: listing.hasPrevious ? listing.previous : false,
                nextCursor: listing.hasNext ? listing.next : false,
                results: (listing.results || []).map(addressData => {
                    let values = {
                        id: addressData._id.toString(),
                        name: addressData.name || false,
                        address: addressData.address,
                        user: addressData.user && addressData.user.toString(),
                        forwarded: !!addressData.targets,
                        forwardedDisabled: !!(addressData.targets && addressData.forwardedDisabled),
                        targets: addressData.targets && addressData.targets.map(target => target && target.value).filter(target => target),
                        tags: addressData.tags || []
                    };

                    if (addressData.metaData) {
                        values.metaData = tools.formatMetaData(addressData.metaData);
                    }

                    if (addressData.internalData) {
                        values.internalData = tools.formatMetaData(addressData.internalData);
                    }

                    return permission.filter(values);
                })
            };

            return res.json(response);
        })
    );

    server.post(
        {
            path: '/users/:user/addresses',
            summary: 'Create new Address',
            name: 'createUserAddress',
            description:
                'Add a new email address for a User. Addresses can contain unicode characters. Dots in usernames are normalized so no need to create both "firstlast@example.com" and "first.last@example.com" Special addresses `*@example.com`, `*suffix@example.com` and `username@*` catches all emails to these domains or users without a registered destination (requires allowWildcard argument)',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {
                    address: Joi.alternatives()
                        .try(addressEmail, Joi.string().regex(/^\w+@\*$/, 'special address'))
                        .description('E-mail Address'),
                    name: Joi.string().empty('').trim().max(128).description('Identity name'),
                    main: booleanSchema.description('Indicates if this is the default address for the User'),
                    allowWildcard: booleanSchema.description(
                        'If true then address value can be in the form of `*@example.com`, `*suffix@example.com` and `username@*`, otherwise using * is not allowed. Static suffix can be up to 32 characters long.'
                    ),
                    tags: Joi.array().items(Joi.string().trim().max(128)).description('A list of tags associated with this address'),

                    metaData: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataSchema
                        .label('internalData')
                        .description(
                            'Optional metadata for internal use, must be an object or JSON formatted string of an object. Not available for user-role tokens'
                        ),

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
                            id: Joi.string().required().description('ID of the address')
                        }).$_setFlag('objectName', 'CreateUserAddressResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
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

            let user = new ObjectId(result.value.user);

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).createOwn('addresses'));
            } else {
                req.validate(roles.can(req.role).createAny('addresses'));
            }

            let main = result.value.main;
            let name = result.value.name;
            let address = tools.normalizeAddress(result.value.address);

            if (address.indexOf('+') >= 0) {
                res.status(400);
                return res.json({
                    error: 'Address can not contain +',
                    code: 'InputValidationError'
                });
            }

            let wcpos = address.indexOf('*');

            if (wcpos >= 0) {
                if (!result.value.allowWildcard) {
                    res.status(400);
                    return res.json({
                        error: 'Address can not contain *',
                        code: 'InputValidationError'
                    });
                }

                // wildcard in the beginning of username
                if (address.charAt(0) === '*') {
                    let partial = address.substr(1);

                    try {
                        // only one wildcard allowed
                        if (partial.indexOf('*') >= 0) {
                            throw new Error('Invalid wildcard address');
                        }

                        // for validation we need a correct email
                        if (partial.charAt(0) === '@') {
                            partial = 'test' + partial;
                        }

                        // check if wildcard username is not too long
                        if (partial.substr(0, partial.indexOf('@')).length > consts.MAX_ALLOWED_WILDCARD_LENGTH) {
                            throw new Error('Invalid wildcard address');
                        }

                        // result neewds to be a valid email
                        if (!isemail.validate(partial)) {
                            throw new Error('Invalid wildcard address');
                        }
                    } catch (err) {
                        res.status(400);
                        return res.json({
                            error: 'Invalid wildcard address, use "*@domain" or "user@*"',
                            code: 'InputValidationError'
                        });
                    }
                }

                if (address.charAt(address.length - 1) === '*') {
                    let partial = address.substr(0, address.length - 1);

                    try {
                        // only one wildcard allowed
                        if (partial.indexOf('*') >= 0) {
                            throw new Error('Invalid wildcard address');
                        }

                        // for validation we need a correct email
                        partial += 'example.com';

                        if (!isemail.validate(partial)) {
                            throw new Error('Invalid wildcard address');
                        }
                    } catch (err) {
                        res.status(400);
                        return res.json({
                            error: 'Invalid wildcard address, use "*@domain" or "user@*"',
                            code: 'InputValidationError'
                        });
                    }
                }

                if (/[^@]\*|\*[^@]/.test(result.value) || wcpos !== address.lastIndexOf('*')) {
                    res.status(400);
                    return res.json({
                        error: 'Invalid wildcard address, use "*@domain" or "user@*"',
                        code: 'InputValidationError'
                    });
                }

                if (main) {
                    res.status(400);
                    return res.json({
                        error: 'Main address can not contain *',
                        code: 'InputValidationError'
                    });
                }
            }

            if (result.value.tags) {
                let tagSeen = new Set();
                let tags = result.value.tags
                    .map(tag => tag.trim())
                    .filter(tag => {
                        if (tag && !tagSeen.has(tag.toLowerCase())) {
                            tagSeen.add(tag.toLowerCase());
                            return true;
                        }
                        return false;
                    })
                    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

                result.value.tags = tags;
                result.value.tagsview = tags.map(tag => tag.toLowerCase());
            }

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            address: true
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

            let addressData;
            try {
                addressData = await db.users.collection('addresses').findOne({
                    addrview: tools.uview(address)
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (addressData) {
                res.status(400);
                return res.json({
                    error: 'This email address already exists',
                    code: 'AddressExistsError'
                });
            }

            addressData = {
                user,
                name,
                address,
                addrview: tools.uview(address),
                created: new Date()
            };

            if (result.value.tags) {
                addressData.tags = result.value.tags;
                addressData.tagsview = result.value.tags.map(tag => tag.toLowerCase());
            }

            if (result.value.metaData) {
                addressData.metaData = result.value.metaData;
            }

            if (result.value.internalData) {
                addressData.internalData = result.value.internalData;
            }

            let r;
            // insert alias address to email address registry
            try {
                r = await db.users.collection('addresses').insertOne(addressData);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let insertId = r.insertedId;

            if (!userData.address || main) {
                // register this address as the default address for that user
                try {
                    await db.users.collection('users').updateOne(
                        {
                            _id: user
                        },
                        {
                            $set: {
                                address
                            }
                        }
                    );
                } catch (err) {
                    // ignore
                }
            }

            await publish(db.redis, {
                ev: ADDRESS_USER_CREATED,
                user,
                address: insertId,
                value: addressData.address
            });

            return res.json({
                success: !!insertId,
                id: insertId
            });
        })
    );

    server.get(
        {
            path: '/users/:user/addresses',
            summary: 'List registered Addresses for a User',
            name: 'getUserAddresses',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    metaData: booleanSchema.description('If true, then includes metaData in the response'),
                    internalData: booleanSchema.description('If true, then includes internalData in the response. Not shown for user-role tokens.'),
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
                            results: Joi.array().items(GetUserAddressesResult).required().description('Address listing')
                        }).$_setFlag('objectName', 'GetUserAddressesResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
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

            let user = new ObjectId(result.value.user);

            // permissions check
            let permission;
            if (req.user && req.user === result.value.user) {
                permission = roles.can(req.role).readOwn('addresses');
            } else {
                permission = roles.can(req.role).readAny('addresses');
            }

            // permissions check
            req.validate(permission);

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            name: true,
                            address: true
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

            let addresses;

            try {
                addresses = await db.users
                    .collection('addresses')
                    .find({
                        user
                    })
                    .sort({
                        addrview: 1
                    })
                    .toArray();
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!addresses) {
                addresses = [];
            }

            return res.json({
                success: true,

                results: addresses.map(addressData => {
                    let values = {
                        id: addressData._id.toString(),
                        name: addressData.name || false,
                        address: addressData.address,
                        main: addressData.address === userData.address,
                        tags: addressData.tags || [],
                        created: addressData.created
                    };

                    if (result.value.metaData && addressData.metaData) {
                        values.metaData = tools.formatMetaData(addressData.metaData);
                    }

                    if (result.value.internalData && addressData.internalData) {
                        values.internalData = tools.formatMetaData(addressData.internalData);
                    }

                    return permission.filter(values);
                })
            });
        })
    );

    server.get(
        {
            path: '/users/:user/addresses/:address',
            summary: 'Request Addresses information',
            name: 'getUserAddress',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    address: addressId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: addressId,
                            name: Joi.string().required().description('Identity name'),
                            address: addressEmail,
                            main: booleanSchema.required().description('Indicates if this is the default address for the User'),
                            created: Joi.date().required().description('Datestring of the time the address was created'),
                            tags: Joi.array().items(Joi.string()).required().description('List of tags associated with the Address'),
                            metaData: Joi.object({}).description('Metadata object (if available)'),
                            internalData: Joi.object({}).description('Internal metadata object (if available), not included for user-role requests')
                        }).$_setFlag('objectName', 'GetUserAddressResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
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

            let user = new ObjectId(result.value.user);

            // permissions check
            let permission;
            if (req.user && req.user === result.value.user) {
                permission = roles.can(req.role).readOwn('addresses');
            } else {
                permission = roles.can(req.role).readAny('addresses');
            }
            req.validate(permission);

            let address = new ObjectId(result.value.address);

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            name: true,
                            address: true
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

            let addressData;
            try {
                addressData = await db.users.collection('addresses').findOne({
                    _id: address,
                    user
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }
            if (!addressData) {
                res.status(404);
                return res.json({
                    error: 'Invalid or unknown address',
                    code: 'AddressNotFound'
                });
            }

            let value = {
                success: true,
                id: addressData._id.toString(),
                name: addressData.name || false,
                address: addressData.address,
                main: addressData.address === userData.address,
                tags: addressData.tags || [],
                created: addressData.created
            };

            if (addressData.metaData) {
                value.metaData = tools.formatMetaData(addressData.metaData);
            }

            if (addressData.internalData) {
                value.internalData = tools.formatMetaData(addressData.internalData);
            }

            return res.json(permission.filter(value));
        })
    );

    server.put(
        {
            path: '/users/:user/addresses/:id',
            summary: 'Update Address information',
            name: 'updateUserAddress',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {
                    name: Joi.string().empty('').trim().max(128).description('Identity name'),
                    address: Joi.string()
                        .email({ tlds: false })
                        .description(
                            'New address if you want to rename existing address. Only affects normal addresses, special addresses that include * can not be changed'
                        ),
                    main: booleanSchema.description('Indicates if this is the default address for the User'),
                    tags: Joi.array().items(Joi.string().trim().max(128)).description('A list of tags associated with this address'),

                    metaData: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataSchema
                        .label('internalData')
                        .description(
                            'Optional metadata for internal use, must be an object or JSON formatted string of an object. Not available for user-role tokens'
                        ),

                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {
                    user: userId,
                    id: addressId
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
                ...queryParams,
                ...requestBody
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

            let user = new ObjectId(result.value.user);

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).updateOwn('addresses'));
            } else {
                req.validate(roles.can(req.role).updateAny('addresses'));
            }

            let id = new ObjectId(result.value.id);
            let main = result.value.main;

            if (main === false) {
                res.status(400);
                return res.json({
                    error: 'Cannot unset main status',
                    code: 'InputValidationError'
                });
            }

            let updates = {};

            if (result.value.address) {
                let address = tools.normalizeAddress(result.value.address);
                let addrview = tools.uview(address);

                updates.address = address;
                updates.addrview = addrview;
            }

            if (result.value.name) {
                updates.name = result.value.name;
            }

            if (result.value.tags) {
                let tagSeen = new Set();
                let tags = result.value.tags
                    .map(tag => tag.trim())
                    .filter(tag => {
                        if (tag && !tagSeen.has(tag.toLowerCase())) {
                            tagSeen.add(tag.toLowerCase());
                            return true;
                        }
                        return false;
                    })
                    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

                updates.tags = tags;
                updates.tagsview = tags.map(tag => tag.toLowerCase());
            }

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            address: true
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

            let addressData;
            try {
                addressData = await db.users.collection('addresses').findOne({
                    _id: id
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!addressData || !addressData.user || addressData.user.toString() !== user.toString()) {
                res.status(404);
                return res.json({
                    error: 'Invalid or unknown email address identifier',
                    code: 'AddressNotFound'
                });
            }

            if (addressData.address.indexOf('*') >= 0 && result.value.address && result.value.address !== addressData.address) {
                res.status(400);
                return res.json({
                    error: 'Can not change special address',
                    code: 'ChangeNotAllowed'
                });
            }

            if (result.value.address && result.value.address.indexOf('*') >= 0 && result.value.address !== addressData.address) {
                res.status(400);
                return res.json({
                    error: 'Can not change special address',
                    code: 'ChangeNotAllowed'
                });
            }

            if ((result.value.address || addressData.address).indexOf('*') >= 0 && main) {
                res.status(400);
                return res.json({
                    error: 'Can not set wildcard address as default',
                    code: 'WildcardNotPermitted'
                });
            }

            if (result.value.address && addressData.address === userData.address && result.value.address !== addressData.address) {
                // main address was changed, update user data as well
                main = true;
                addressData.address = result.value.address;
            }

            for (let key of ['metaData', 'internalData']) {
                if (result.value[key]) {
                    updates[key] = result.value[key];
                }
            }

            if (Object.keys(updates).length) {
                try {
                    await db.users.collection('addresses').updateOne(
                        {
                            _id: addressData._id
                        },
                        {
                            $set: updates
                        }
                    );
                } catch (err) {
                    if (err.code === 11000) {
                        res.status(400);
                        return res.json({
                            error: 'Address already exists',
                            code: 'AddressExistsError'
                        });
                    }
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }
            }

            if (!main) {
                // nothing to do anymore
                return res.json({
                    success: true
                });
            }

            let r;
            try {
                r = await db.users.collection('users').updateOne(
                    {
                        _id: user
                    },
                    {
                        $set: {
                            address: addressData.address
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

            return res.json({
                success: !!r.matchedCount
            });
        })
    );

    server.del(
        {
            path: '/users/:user/addresses/:address',
            name: 'deleteUserAddress',
            summary: 'Delete an Address',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {},
                pathParams: {
                    user: userId,
                    address: addressId
                },
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
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
                ...queryParams,
                ...requestBody
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

            let user = new ObjectId(result.value.user);

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).deleteOwn('addresses'));
            } else {
                req.validate(roles.can(req.role).deleteAny('addresses'));
            }

            let address = new ObjectId(result.value.address);

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            address: true
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

            let addressData;
            try {
                addressData = await db.users.collection('addresses').findOne({
                    _id: address
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!addressData || addressData.user.toString() !== user.toString()) {
                res.status(404);
                return res.json({
                    error: 'Invalid or unknown email address identifier',
                    code: 'AddressNotFound'
                });
            }

            if (addressData.address === userData.address) {
                res.status(400);
                return res.json({
                    error: 'Can not delete main address',
                    code: 'NotPermitted'
                });
            }

            // delete address from email address registry
            let r;
            try {
                r = await db.users.collection('addresses').deleteOne({
                    _id: address
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (r.deletedCount) {
                await publish(db.redis, {
                    ev: ADDRESS_USER_DELETED,
                    user,
                    address,
                    value: addressData.address
                });
            }

            return res.json({
                success: !!r.deletedCount
            });
        })
    );

    server.get(
        {
            path: '/users/:user/addressregister',
            summary: 'List addresses from communication register',
            name: 'getUserAddressregister',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    query: Joi.string().trim().empty('').max(255).required().description('Prefix of an address or a name').example('`query=john`'),
                    limit: Joi.number().default(20).min(1).max(250).description('How many records to return').example('`limit=25`'),
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
                            results: Joi.array().items(GetUserAddressesregisterResult).required().description('Address listing')
                        }).$_setFlag('objectName', 'GetUserAddressregisterResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
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

            let user = new ObjectId(result.value.user);

            // permissions check
            let permission;
            if (req.user && req.user === result.value.user) {
                permission = roles.can(req.role).readOwn('addresses');
            } else {
                permission = roles.can(req.role).readAny('addresses');
            }

            // permissions check
            req.validate(permission);

            let query = result.value.query;
            let limit = result.value.limit;

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            _id: true,
                            name: true,
                            address: true
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

            let addresses;
            try {
                addresses = await db.database
                    .collection('addressregister')
                    .find(
                        {
                            user,
                            $or: [
                                {
                                    address: {
                                        // cannot use dotless version as this would break domain search
                                        $regex: '^' + tools.escapeRegexStr(query),
                                        $options: ''
                                    }
                                },
                                {
                                    name: {
                                        // cannot use dotless version as this would break domain search
                                        $regex: '^' + tools.escapeRegexStr(query),
                                        $options: 'i'
                                    }
                                }
                            ]
                        },
                        {
                            sort: { updated: -1 },
                            projection: {
                                name: true,
                                address: true
                            },
                            limit
                        }
                    )
                    .toArray();
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!addresses) {
                addresses = [];
            }

            return res.json({
                success: true,

                results: addresses.map(addressData => {
                    let name = addressData.name || false;
                    try {
                        // try to decode
                        if (name) {
                            name = libmime.decodeWords(name);
                        }
                    } catch (E) {
                        // ignore
                    }
                    return {
                        id: addressData._id.toString(),
                        name: addressData.name || false,
                        address: addressData.address
                    };
                })
            });
        })
    );

    server.post(
        {
            path: '/addresses/forwarded',
            summary: 'Create new forwarded Address',
            name: 'createForwardedAddress',
            description:
                'Add a new forwarded email address. Addresses can contain unicode characters. Dots in usernames are normalized so no need to create both "firstlast@example.com" and "first.last@example.com" Special addresses `*@example.com` and `username@*` catches all emails to these domains or users without a registered destination (requires allowWildcard argument)',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {
                    address: Joi.alternatives()
                        .try(addressEmail, Joi.string().regex(/^\w+@\*$/, 'special address'))
                        .required()
                        .description('E-mail Address'),
                    name: Joi.string().empty('').trim().max(128).description('Identity name'),
                    targets: Joi.array()
                        .items(
                            Joi.string().email({ tlds: false }),
                            Joi.string().uri({
                                scheme: [/smtps?/, /https?/],
                                allowRelative: false,
                                relativeOnly: false
                            })
                        )
                        .description(
                            'An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to'
                        ),
                    forwards: Joi.number().min(0).default(0).description('Daily allowed forwarding count for this address'),
                    allowWildcard: booleanSchema.description(
                        'If true then address value can be in the form of `*@example.com`, otherwise using * is not allowed'
                    ),
                    autoreply: Autoreply,
                    tags: Joi.array().items(Joi.string().trim().max(128)).description('A list of tags associated with this address'),
                    metaData: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataSchema
                        .label('internalData')
                        .description(
                            'Optional metadata for internal use, must be an object or JSON formatted string of an object. Not available for user-role tokens'
                        ),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({ success: successRes, id: addressId }).$_setFlag('objectName', 'CreateForwardedAddressResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
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
            req.validate(roles.can(req.role).createAny('addresses'));

            let address = tools.normalizeAddress(result.value.address);
            let addrview = tools.uview(address);
            let name = result.value.name;

            let targets = result.value.targets || [];
            let forwards = result.value.forwards;

            if (result.value.autoreply) {
                if (!result.value.autoreply.name && 'name' in req.params.autoreply) {
                    result.value.autoreply.name = '';
                }

                if (!result.value.autoreply.subject && 'subject' in req.params.autoreply) {
                    result.value.autoreply.subject = '';
                }

                if (!result.value.autoreply.text && 'text' in req.params.autoreply) {
                    result.value.autoreply.text = '';
                    if (!result.value.autoreply.html) {
                        // make sure we also update html part
                        result.value.autoreply.html = '';
                    }
                }

                if (!result.value.autoreply.html && 'html' in req.params.autoreply) {
                    result.value.autoreply.html = '';
                    if (!result.value.autoreply.text) {
                        // make sure we also update plaintext part
                        result.value.autoreply.text = '';
                    }
                }
            } else {
                result.value.autoreply = {
                    status: false
                };
            }

            if (result.value.tags) {
                let tagSeen = new Set();
                let tags = result.value.tags
                    .map(tag => tag.trim())
                    .filter(tag => {
                        if (tag && !tagSeen.has(tag.toLowerCase())) {
                            tagSeen.add(tag.toLowerCase());
                            return true;
                        }
                        return false;
                    })
                    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

                result.value.tags = tags;
                result.value.tagsview = tags.map(tag => tag.toLowerCase());
            }

            // needed to resolve users for addresses
            let addrlist = [];
            let cachedAddrviews = new WeakMap();

            for (let i = 0, len = targets.length; i < len; i++) {
                let target = targets[i];
                if (!/^smtps?:/i.test(target) && !/^https?:/i.test(target) && target.indexOf('@') >= 0) {
                    // email
                    let addr = tools.normalizeAddress(target);
                    let addrv = addr.substr(0, addr.indexOf('@')).replace(/\./g, '') + addr.substr(addr.indexOf('@'));
                    if (addrv === addrview) {
                        res.status(400);
                        return res.json({
                            error: 'Can not forward to self "' + target + '"',
                            code: 'InputValidationError'
                        });
                    }
                    targets[i] = {
                        id: new ObjectId(),
                        type: 'mail',
                        value: target
                    };
                    cachedAddrviews.set(targets[i], addrv);
                    addrlist.push(addrv);
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

            if (address.indexOf('+') >= 0) {
                res.status(400);
                return res.json({
                    error: 'Address can not contain +',
                    code: 'InputValidationError'
                });
            }

            let wcpos = address.indexOf('*');

            if (wcpos >= 0) {
                if (!result.value.allowWildcard) {
                    res.status(400);
                    return res.json({
                        error: 'Address can not contain *',
                        code: 'InputValidationError'
                    });
                }

                if (/[^@]\*|\*[^@]/.test(result.value) || wcpos !== address.lastIndexOf('*')) {
                    res.status(400);
                    return res.json({
                        error: 'Invalid wildcard address, use "*@domain" or "user@*"',
                        code: 'InputValidationError'
                    });
                }
            }

            let addressData;
            try {
                addressData = await db.users.collection('addresses').findOne({
                    addrview
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (addressData) {
                res.status(400);
                return res.json({
                    error: 'This email address already exists',
                    code: 'AddressExistsError'
                });
            }

            if (addrlist.length) {
                let addressList;
                try {
                    addressList = await db.users
                        .collection('addresses')
                        .find({
                            addrview: { $in: addrlist }
                        })
                        .toArray();
                } catch (err) {
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }
                let map = new Map(addressList.filter(addr => addr.user).map(addr => [addr.addrview, addr.user]));
                targets.forEach(target => {
                    let addrv = cachedAddrviews.get(target);
                    if (addrv && map.has(addrv)) {
                        target.user = map.get(addrv);
                    }
                });
            }

            // insert alias address to email address registry
            addressData = {
                name,
                address,
                addrview: tools.uview(address),
                targets,
                forwards,
                autoreply: result.value.autoreply,
                created: new Date()
            };

            if (result.value.tags) {
                addressData.tags = result.value.tags;
                addressData.tagsview = result.value.tags.map(tag => tag.toLowerCase());
            }

            if (result.value.metaData) {
                addressData.metaData = result.value.metaData;
            }

            if (result.value.internalData) {
                addressData.internalData = result.value.internalData;
            }

            let r;

            try {
                r = await db.users.collection('addresses').insertOne(addressData);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let insertId = r.insertedId;

            await publish(db.redis, {
                ev: ADDRESS_FORWARDED_CREATED,
                address: insertId,
                value: addressData.address
            });

            return res.json({
                success: !!insertId,
                id: insertId
            });
        })
    );

    server.put(
        {
            path: '/addresses/forwarded/:id',
            summary: 'Update forwarded Address information',
            name: 'updateForwardedAddress',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {
                    address: Joi.string()
                        .email({ tlds: false })
                        .description('New address. Only affects normal addresses, special addresses that include * can not be changed'),
                    name: Joi.string().empty('').trim().max(128).description('Identity name'),
                    targets: Joi.array()
                        .items(
                            Joi.string().email({ tlds: false }),
                            Joi.string().uri({
                                scheme: [/smtps?/, /https?/],
                                allowRelative: false,
                                relativeOnly: false
                            })
                        )
                        .description(
                            'An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to. If set then overwrites previous targets array'
                        ),
                    forwards: Joi.number().min(0).description('Daily allowed forwarding count for this address'),
                    autoreply: Autoreply,
                    tags: Joi.array().items(Joi.string().trim().max(128)).description('A list of tags associated with this address'),
                    metaData: metaDataSchema.label('metaData').description('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataSchema
                        .label('internalData')
                        .description(
                            'Optional metadata for internal use, must be an object or JSON formatted string of an object. Not available for user-role tokens'
                        ),
                    forwardedDisabled: booleanSchema.description('If true then disables forwarded address (stops forwarding messages)'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: { id: addressId },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({ success: successRes }).$_setFlag('objectName', 'SuccessResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
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
            req.validate(roles.can(req.role).updateAny('addresses'));

            let id = new ObjectId(result.value.id);
            let updates = {};
            if (result.value.address) {
                let address = tools.normalizeAddress(result.value.address);
                let addrview = tools.uview(address);

                updates.address = address;
                updates.addrview = addrview;
            }

            if (result.value.forwards) {
                updates.forwards = result.value.forwards;
            }

            if (result.value.name) {
                updates.name = result.value.name;
            }

            if (result.value.forwardedDisabled !== undefined) {
                updates.forwardedDisabled = result.value.forwardedDisabled;
            }

            if (result.value.autoreply) {
                if (!result.value.autoreply.name && 'name' in req.params.autoreply) {
                    result.value.autoreply.name = '';
                }

                if (!result.value.autoreply.subject && 'subject' in req.params.autoreply) {
                    result.value.autoreply.subject = '';
                }

                if (!result.value.autoreply.text && 'text' in req.params.autoreply) {
                    result.value.autoreply.text = '';
                    if (!result.value.autoreply.html) {
                        // make sure we also update html part
                        result.value.autoreply.html = '';
                    }
                }

                if (!result.value.autoreply.html && 'html' in req.params.autoreply) {
                    result.value.autoreply.html = '';
                    if (!result.value.autoreply.text) {
                        // make sure we also update plaintext part
                        result.value.autoreply.text = '';
                    }
                }

                Object.keys(result.value.autoreply).forEach(key => {
                    updates['autoreply.' + key] = result.value.autoreply[key];
                });
            }

            if (result.value.tags) {
                let tagSeen = new Set();
                let tags = result.value.tags
                    .map(tag => tag.trim())
                    .filter(tag => {
                        if (tag && !tagSeen.has(tag.toLowerCase())) {
                            tagSeen.add(tag.toLowerCase());
                            return true;
                        }
                        return false;
                    })
                    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

                updates.tags = tags;
                updates.tagsview = tags.map(tag => tag.toLowerCase());
            }

            if (result.value.metaData) {
                updates.metaData = result.value.metaData;
            }

            if (result.value.internalData) {
                updates.internalData = result.value.internalData;
            }

            let addressData;

            try {
                addressData = await db.users.collection('addresses').findOne({
                    _id: id
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!addressData || !addressData.targets || addressData.user) {
                res.status(404);
                return res.json({
                    error: 'Invalid or unknown email address identifier',
                    code: 'AddressNotFound'
                });
            }

            if (addressData.address.indexOf('*') >= 0 && result.value.address && result.value.address !== addressData.address) {
                res.status(400);
                return res.json({
                    error: 'Can not change special address',
                    code: 'ChangeNotAllowed'
                });
            }

            if (result.value.address && result.value.address.indexOf('*') >= 0 && result.value.address !== addressData.address) {
                res.status(400);
                return res.json({
                    error: 'Can not change special address',
                    code: 'ChangeNotAllowed'
                });
            }

            let targets = result.value.targets;
            let addrlist = [];
            let cachedAddrviews = new WeakMap();

            if (targets) {
                // needed to resolve users for addresses

                for (let i = 0, len = targets.length; i < len; i++) {
                    let target = targets[i];
                    if (!/^smtps?:/i.test(target) && !/^https?:/i.test(target) && target.indexOf('@') >= 0) {
                        // email
                        let addr = tools.normalizeAddress(target);
                        let addrv = addr.substr(0, addr.indexOf('@')).replace(/\./g, '') + addr.substr(addr.indexOf('@'));
                        if (addrv === addressData.addrview) {
                            res.status(400);
                            return res.json({
                                error: 'Can not forward to self "' + target + '"',
                                code: 'InputValidationError'
                            });
                        }
                        targets[i] = {
                            id: new ObjectId(),
                            type: 'mail',
                            value: target
                        };
                        cachedAddrviews.set(targets[i], addrv);
                        addrlist.push(addrv);
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

                updates.targets = targets;
            }

            if (targets && addrlist.length) {
                let addressList;
                try {
                    addressList = await db.users
                        .collection('addresses')
                        .find({
                            addrview: { $in: addrlist }
                        })
                        .toArray();
                } catch (err) {
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }
                let map = new Map(addressList.filter(addr => addr.user).map(addr => [addr.addrview, addr.user]));
                targets.forEach(target => {
                    let addrv = cachedAddrviews.get(target);
                    if (addrv && map.has(addrv)) {
                        target.user = map.get(addrv);
                    }
                });
            }

            // insert alias address to email address registry
            let r;
            try {
                r = await db.users.collection('addresses').updateOne(
                    {
                        _id: addressData._id
                    },
                    {
                        $set: updates
                    }
                );
            } catch (err) {
                if (err.code === 11000) {
                    res.status(400);
                    return res.json({
                        error: 'Address already exists',
                        code: 'AddressExistsError'
                    });
                }

                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            return res.json({
                success: !!r.matchedCount
            });
        })
    );

    server.del(
        {
            path: '/addresses/forwarded/:address',
            summary: 'Delete a forwarded Address',
            name: 'deleteForwardedAddress',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: { address: addressId },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({ success: successRes }).$_setFlag('objectName', 'SuccessResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
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
            req.validate(roles.can(req.role).deleteAny('addresses'));

            let address = new ObjectId(result.value.address);

            let addressData;
            try {
                addressData = await db.users.collection('addresses').findOne({
                    _id: address
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!addressData || !addressData.targets || addressData.user) {
                res.status(404);
                return res.json({
                    error: 'Invalid or unknown email address identifier',
                    code: 'AddressNotFound'
                });
            }

            // delete address from email address registry
            let r;
            try {
                r = await db.users.collection('addresses').deleteOne({
                    _id: address
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (r.deletedCount) {
                await publish(db.redis, {
                    ev: ADDRESS_FORWARDED_DELETED,
                    address,
                    value: addressData.address
                });
            }

            return res.json({
                success: !!r.deletedCount
            });
        })
    );

    server.get(
        {
            path: '/addresses/forwarded/:address',
            summary: 'Request forwarded Addresses information',
            name: 'getForwardedAddress',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {},
                queryParams: { sess: sessSchema, ip: sessIPSchema },
                pathParams: { address: addressId },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: addressId,
                            address: addressEmail,
                            name: Joi.string().required().description('Identity name'),
                            targets: Joi.array().items(Joi.string()).description('List of forwarding targets'),
                            limits: AddressLimits,
                            autoreply: AutoreplyInfo,
                            created: Joi.date().required().description('Datestring of the time the address was created'),
                            tags: Joi.array().items(Joi.string()).required().description('List of tags associated with the Address'),
                            metaData: Joi.object({}).description('Metadata object (if available)'),
                            internalData: Joi.object({}).description('Internal metadata object (if available), not included for user-role requests'),
                            forwardedDisabled: booleanSchema.description('Specifies whether forwarding is disabled')
                        }).$_setFlag('objectName', 'GetForwardedAddressResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
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
            const permission = roles.can(req.role).readAny('addresses');
            req.validate(permission);

            let address = new ObjectId(result.value.address);

            let addressData;
            try {
                addressData = await db.users.collection('addresses').findOne({
                    _id: address
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }
            if (!addressData || !addressData.targets || addressData.user) {
                res.status(404);
                return res.json({
                    error: 'Invalid or unknown address',
                    code: 'AddressNotFound'
                });
            }

            let response;
            try {
                response = await db.redis
                    .multi()
                    // sending counters are stored in Redis
                    .get('wdf:' + addressData._id.toString())
                    .ttl('wdf:' + addressData._id.toString())
                    .exec();
            } catch (err) {
                // ignore
            }

            let settings = await settingsHandler.getMulti(['const:max:forwards']);

            let forwards = Number(addressData.forwards) || config.maxForwards || settings['const:max:forwards'];

            let forwardsSent = Number(response && response[0] && response[0][1]) || 0;
            let forwardsTtl = Number(response && response[1] && response[1][1]) || 0;

            const values = {
                success: true,
                id: addressData._id.toString(),
                name: addressData.name || false,
                address: addressData.address,
                targets: addressData.targets && addressData.targets.map(t => t.value),
                limits: {
                    forwards: {
                        allowed: forwards,
                        used: forwardsSent,
                        ttl: forwardsTtl >= 0 ? forwardsTtl : false
                    }
                },
                autoreply: addressData.autoreply || { status: false },
                tags: addressData.tags || [],
                forwardedDisabled: addressData.targets && addressData.forwardedDisabled,
                created: addressData.created
            };

            if (addressData.metaData) {
                values.metaData = tools.formatMetaData(addressData.metaData);
            }

            if (addressData.internalData) {
                values.internalData = tools.formatMetaData(addressData.internalData);
            }

            return res.json(permission.filter(values));
        })
    );

    server.get(
        {
            path: '/addresses/resolve/:address',
            summary: 'Get Address info',
            name: 'resolveAddress',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {},
                queryParams: {
                    allowWildcard: booleanSchema.description('If true then resolves also wildcard addresses'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    address: Joi.alternatives().try(addressId, addressEmail).required().description('ID of the Address or e-mail address string')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            id: addressId,
                            address: addressEmail,
                            name: Joi.string().required().description('Identity name'),
                            targets: Joi.array().items(Joi.string()).description('List of forwarding targets if this is a Forwarded address'),
                            limits: AddressLimits,
                            autoreply: AutoreplyInfo,
                            tags: Joi.array().items(Joi.string()).required().description('List of tags associated with the Address'),
                            created: Joi.date().required().description('Datestring of the time the address was created'),
                            metaData: Joi.object({}).description('Metadata object (if available)'),
                            internalData: Joi.object({}).description('Internal metadata object (if available), not included for user-role requests')
                        }).$_setFlag('objectName', 'ResolveAddressResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
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
            const permission = roles.can(req.role).readAny('addresses');
            req.validate(permission);

            let addressData;
            try {
                if (result.value.address.indexOf('@') >= 0) {
                    addressData = await userHandler.asyncResolveAddress(result.value.address, {
                        wildcard: result.value.allowWildcard,
                        projection: false
                    });
                } else {
                    addressData = await db.users.collection('addresses').findOne({
                        _id: new ObjectId(result.value.address)
                    });
                }
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!addressData) {
                res.status(404);
                return res.json({
                    error: 'Invalid or unknown address',
                    code: 'AddressNotFound'
                });
            }

            if (addressData.user) {
                const values = {
                    success: true,
                    id: addressData._id.toString(),
                    address: addressData.address,
                    user: addressData.user.toString(),
                    tags: addressData.tags || [],
                    created: addressData.created
                };

                if (addressData.metaData) {
                    values.metaData = tools.formatMetaData(addressData.metaData);
                }

                if (addressData.internalData) {
                    values.internalData = tools.formatMetaData(addressData.internalData);
                }

                return res.json(permission.filter(values));
            }

            let response;
            try {
                response = await db.redis
                    .multi()
                    // sending counters are stored in Redis
                    .get('wdf:' + addressData._id.toString())
                    .ttl('wdf:' + addressData._id.toString())
                    .exec();
            } catch (err) {
                // ignore
            }

            let settings = await settingsHandler.getMulti(['const:max:forwards']);

            let forwards = Number(addressData.forwards) || config.maxForwards || settings['const:max:forwards'];

            let forwardsSent = Number(response && response[0] && response[0][1]) || 0;
            let forwardsTtl = Number(response && response[1] && response[1][1]) || 0;

            const values = {
                success: true,
                id: addressData._id.toString(),
                name: addressData.name || '',
                address: addressData.address,
                targets: addressData.targets && addressData.targets.map(t => t.value),
                limits: {
                    forwards: {
                        allowed: forwards,
                        used: forwardsSent,
                        ttl: forwardsTtl >= 0 ? forwardsTtl : false
                    }
                },
                autoreply: addressData.autoreply || { status: false },
                tags: addressData.tags || [],
                created: addressData.created
            };

            if (addressData.metaData) {
                values.metaData = tools.formatMetaData(addressData.metaData);
            }

            if (addressData.internalData) {
                values.internalData = tools.formatMetaData(addressData.internalData);
            }

            return res.json(permission.filter(values));
        })
    );

    server.put(
        {
            path: '/addresses/renameDomain',
            summary: 'Rename domain in addresses',
            name: 'renameDomain',
            description: 'Renames domain names for addresses, DKIM keys and Domain Aliases',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {
                    oldDomain: Joi.string().required().description('Old Domain Name'),
                    newDomain: Joi.string().required().description('New Domain Name'),
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.object({
                            success: successRes,
                            modifiedAddresses: Joi.number().required().description('Number of modified addresses'),
                            modifiedUsers: Joi.number().required().description('Number of modified users'),
                            modifiedDkim: Joi.number().required().description('Number of modified DKIM keys'),
                            modifiedAliases: Joi.number().required().description('Number of modified Domain Aliases')
                        }).$_setFlag('objectName', 'ResolveDomainAddressesResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { pathParams, requestBody, queryParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...pathParams,
                ...queryParams,
                ...requestBody
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
            req.validate(roles.can(req.role).updateAny('addresses'));

            let oldDomain = tools.normalizeDomain(result.value.oldDomain);
            let newDomain = tools.normalizeDomain(result.value.newDomain);

            let updateAddresses = [];
            let updateUsers = [];

            let cursor = await db.users.collection('addresses').find({
                addrview: {
                    $regex: '@' + tools.escapeRegexStr(oldDomain) + '$'
                }
            });

            let response = {
                success: true,
                modifiedAddresses: 0,
                modifiedUsers: 0,
                modifiedDkim: 0,
                modifiedAliases: 0
            };

            let addressData;
            try {
                while ((addressData = await cursor.next())) {
                    updateAddresses.push({
                        updateOne: {
                            filter: {
                                _id: addressData._id
                            },
                            update: {
                                $set: {
                                    address: addressData.address.replace(/@.+$/, () => '@' + newDomain),
                                    addrview: addressData.addrview.replace(/@.+$/, () => '@' + newDomain)
                                }
                            }
                        }
                    });

                    updateUsers.push({
                        updateOne: {
                            filter: {
                                _id: addressData.user,
                                address: addressData.address
                            },
                            update: {
                                $set: {
                                    address: addressData.address.replace(/@.+$/, () => '@' + newDomain)
                                }
                            }
                        }
                    });
                }

                await cursor.close();
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (updateAddresses.length) {
                try {
                    let r = await db.users.collection('addresses').bulkWrite(updateAddresses, {
                        ordered: false,
                        writeConcern: 1
                    });
                    response.modifiedAddresses = r.modifiedCount;
                } catch (err) {
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }

                try {
                    let r = await db.users.collection('users').bulkWrite(updateUsers, {
                        ordered: false,
                        writeConcern: 1
                    });
                    response.modifiedUsers = r.modifiedCount;
                } catch (err) {
                    res.status(500);
                    return res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                }
            }

            // UPDATE DKIM
            try {
                let r = await db.database.collection('dkim').updateMany(
                    {
                        domain: oldDomain
                    },
                    {
                        $set: {
                            domain: newDomain
                        }
                    }
                );
                response.modifiedDkim = r.modifiedCount;
            } catch (err) {
                log.error('RenameDomain', 'DKIMERR old=%s new=%s error=%s', oldDomain, newDomain, err.message);
            }

            // UPDATE ALIASES
            try {
                let r = await db.users.collection('domainaliases').updateMany(
                    {
                        domain: oldDomain
                    },
                    {
                        $set: {
                            domain: newDomain
                        }
                    }
                );
                response.modifiedAliases = r.modifiedCount;
            } catch (err) {
                log.error('RenameDomain', 'ALIASERR old=%s new=%s error=%s', oldDomain, newDomain, err.message);
            }

            await publish(db.redis, {
                ev: ADDRESS_DOMAIN_RENAMED,
                previous: oldDomain,
                current: newDomain
            });

            return res.json(response);
        })
    );
};
