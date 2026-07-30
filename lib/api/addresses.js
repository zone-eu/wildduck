'use strict';

const config = require('@zone-eu/wild-config');
const { objectIdSchema } = require('../schemas/json-schemas');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const consts = require('../consts');
const roles = require('../roles');
const libmime = require('libmime');
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
const {
    GetAddressesResult,
    GetUserAddressesResult,
    GetUserAddressesregisterResult,
    AddressLimits,
    AutoreplyInfo
} = require('../schemas/response/addresses-schemas');
const { Autoreply } = require('../schemas/request/addresses-schemas');

const userId = { $ref: 'wd:userId' };
const sessSchema = { $ref: 'wd:sess' };
const sessIPSchema = { $ref: 'wd:ip' };
const nextPageCursorSchema = { $ref: 'wd:cursor', description: 'Cursor value for next page, retrieved from nextCursor response value' };
const previousPageCursorSchema = { $ref: 'wd:cursor', description: 'Cursor value for previous page, retrieved from previousCursor response value' };

const addressId = objectIdSchema('ID of the Address', { wdRequired: true });

// email address or wildcard address ("*@example.com", "user@*")
const addressEmailOrWildcard = {
    type: 'string',
    anyOf: [{ wdAssert: 'email' }, { pattern: '^(?:[^@\\s]*\\*[^@\\s]*@[^@\\s]+|[^@\\s]+@\\*)$' }],
    description: 'E-mail Address or wildcard address'
};

const identityName = {
    type: 'string',
    maxLength: 128,
    minLength: 1,
    wdTrim: true,
    wdEmpty: true,
    description: 'Identity name'
};

const tagsArraySchema = {
    type: 'array',
    items: { type: 'string', maxLength: 128, minLength: 1, wdTrim: true },
    description: 'A list of tags associated with this address'
};

const forwardTargetsSchema = description => ({
    type: 'array',
    items: {
        type: 'string',
        anyOf: [{ wdAssert: 'email' }, { wdAssert: 'webhookUrl' }]
    },
    description
});

const metaDataOptional = description => ({ $ref: 'wd:metaData', description });

const { mongopagingFindWrapper } = require('../mongopaging-find-wrapper');

module.exports = (db, server, userHandler, settingsHandler) => {
    server.get(
        {
            path: '/addresses',
            summary: 'List registered Addresses',
            name: 'getAddresses',
            tags: ['Addresses'],
            allowUnknown: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    query: { type: 'string', maxLength: 255, wdTrim: true, wdEmpty: true, default: '', description: 'Partial match of an address' },
                    forward: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        description: 'Partial match of a forward email address or URL'
                    },
                    tags: {
                        type: 'string',
                        maxLength: 1024,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        description: 'Comma separated list of tags. The Address must have at least one to be set'
                    },
                    requiredTags: {
                        type: 'string',
                        maxLength: 1024,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        description: 'Comma separated list of tags. The Address must have all listed tags to be set'
                    },
                    metaData: { $ref: 'wd:boolean', description: 'If true, then includes metaData in the response' },
                    internalData: { $ref: 'wd:boolean', description: 'If true, then includes internalData in the response. Not shown for user-role tokens.' },
                    limit: { $ref: 'wd:pageLimit' },
                    next: nextPageCursorSchema,
                    previous: previousPageCursorSchema,
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetAddressesResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                query: { type: 'string', description: 'Partial match of an address' },
                                total: { $ref: 'wd:totalRes' },
                                page: { $ref: 'wd:pageRes' },
                                previousCursor: { $ref: 'wd:previousCursorRes' },
                                nextCursor: { $ref: 'wd:nextCursorRes' },
                                results: { type: 'array', items: GetAddressesResult, description: 'Address listing' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
            }
            if (pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listingWrapper;
            try {
                listingWrapper = await mongopagingFindWrapper(db.users.collection('addresses'), opts);
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            let response = {
                success: true,
                query,
                total,
                page: listingWrapper.page,
                previousCursor: listingWrapper.previousCursor,
                nextCursor: listingWrapper.nextCursor,
                results: (listingWrapper.listing.results || []).map(addressData => {
                    let values = {
                        id: addressData._id.toString(),
                        name: addressData.name || undefined,
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
                'Add a new email address for a User. Addresses can contain unicode characters. Dots in usernames are normalized so no need to create both "firstlast@example.com" and "first.last@example.com" Special addresses `*@example.com` and `username@*` catch all emails to these domains or users without a registered destination (requires allowWildcard argument)',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {
                    address: Object.assign({}, addressEmailOrWildcard, {
                        wdRequired: true,
                        description: 'String. Either an e-mail address or a wildcard address'
                    }),
                    name: identityName,
                    main: { $ref: 'wd:boolean', description: 'Indicates if this is the default address for the User' },
                    allowWildcard: {
                        $ref: 'wd:boolean',
                        description:
                            'If true then address value can be in the form of `*@example.com`, `*suffix@example.com` and `username@*`, otherwise using * is not allowed. Static suffix can be up to 32 characters long.'
                    },
                    tags: tagsArraySchema,

                    metaData: metaDataOptional('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataOptional(
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
                        model: {
                            type: 'object',
                            title: 'CreateUserAddressResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the address' }
                            },
                            required: ['success', 'id']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
                try {
                    const domain = addressData.address.split('@')[1];
                    if (domain && !domain.includes('*')) {
                        await db.users.collection('domaincache').insertOne({ domain });
                    }
                } catch {
                    // ignore
                }
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
                    metaData: { $ref: 'wd:boolean', description: 'If true, then includes metaData in the response' },
                    internalData: { $ref: 'wd:boolean', description: 'If true, then includes internalData in the response. Not shown for user-role tokens.' },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetUserAddressesResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                results: { type: 'array', items: GetUserAddressesResult, description: 'Address listing' }
                            },
                            required: ['success', 'results']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
                        name: addressData.name || undefined,
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
                        model: {
                            type: 'object',
                            title: 'GetUserAddressResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Address' },
                                name: { type: 'string', description: 'Identity name' },
                                address: { type: 'string', description: 'E-mail address string' },
                                main: { type: 'boolean', description: 'Indicates if this is the default address for the User' },
                                created: { description: 'Datestring of the time the address was created' },
                                tags: { type: 'array', items: { type: 'string' }, description: 'List of tags associated with the Address' },
                                metaData: { description: 'Metadata object (if available)' },
                                internalData: { description: 'Internal metadata object (if available), not included for user-role requests' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
                name: addressData.name || undefined,
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
                    name: identityName,
                    address: {
                        type: 'string',
                        wdValidator: 'email',
                        description:
                            'New address if you want to rename existing address. Only affects normal addresses, special addresses that include * can not be changed'
                    },
                    main: { $ref: 'wd:boolean', description: 'Indicates if this is the default address for the User' },
                    tags: tagsArraySchema,

                    metaData: metaDataOptional('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataOptional(
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
                        model: {
                            type: 'object',
                            title: 'SuccessResponse',
                            properties: { success: { $ref: 'wd:successRes' } },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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

            try {
                const domain = addressData.address.split('@')[1];
                if (domain && !domain.includes('*')) {
                    await db.users.collection('domaincache').insertOne({ domain });
                }
            } catch {
                // ignore
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
                        model: {
                            type: 'object',
                            title: 'SuccessResponse',
                            properties: { success: { $ref: 'wd:successRes' } },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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

            if (!addressData || !addressData.user || addressData.user.toString() !== user.toString()) {
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
                    query: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        wdRequired: true,
                        description: 'Prefix of an address or a name'
                    },
                    limit: { $ref: 'wd:pageLimit' },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetUserAddressregisterResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                results: { type: 'array', items: GetUserAddressesregisterResult, description: 'Address listing' }
                            },
                            required: ['success', 'results']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
                                        // only look at domain part (positive lookback for @ symbol)
                                        $regex: tools.escapeRegexStr(query),
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
                            ],
                            disabled: false // get addresses that are not disabled
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
                    let name = addressData.name || undefined;
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
                        name: addressData.name || undefined,
                        address: addressData.address
                    };
                })
            });
        })
    );

    server.put(
        {
            path: '/users/:user/addressregister/:id',
            summary: 'Update an address in the addressregister',
            name: 'updateAddressAddressregister',
            tags: ['Addresses'],
            validationObjs: {
                requestBody: {
                    disabled: {
                        $ref: 'wd:boolean',
                        wdRequired: true,
                        description:
                            'Disable the address in the register. Disabled addresses are not updated on email receival and sending. Disabled addresses are not included in the response for listing addresses in the register.'
                    },
                    name: { type: 'string', maxLength: 255, minLength: 1, description: 'Address header name' }
                },
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    id: addressId
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SuccessResponse',
                            properties: { success: { $ref: 'wd:successRes' } },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            let user = new ObjectId(result.value.user);
            let addressId = new ObjectId(result.value.id);

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).createOwn('addresses'));
            } else {
                req.validate(roles.can(req.role).createAny('addresses'));
            }

            let userData;
            try {
                userData = await db.users.collection('users').findOne(
                    {
                        _id: user
                    },
                    {
                        projection: {
                            _id: true
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

            const update = {
                disabled: result.value.disabled,
                updated: new Date()
            };

            if (result.value.name) {
                update.name = result.value.name;
                try {
                    // try to decode
                    update.name = libmime.decodeWords(update.name);
                } catch {
                    // ignore
                }
            }

            let response;
            try {
                response = await db.database.collection('addressregister').updateOne(
                    {
                        user: userData._id,
                        _id: addressId
                    },
                    {
                        $set: update
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
                success: !!response.matchedCount
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
                    address: Object.assign({}, addressEmailOrWildcard, { wdRequired: true, description: 'E-mail address or wildcard address' }),
                    name: identityName,
                    targets: forwardTargetsSchema(
                        'An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to'
                    ),
                    forwards: { type: 'number', minimum: 0, default: 0, wdType: 'number', description: 'Daily allowed forwarding count for this address' },
                    allowWildcard: {
                        $ref: 'wd:boolean',
                        description: 'If true then address value can be in the form of `*@example.com` or `username@*`, otherwise using * is not allowed'
                    },
                    autoreply: Autoreply,
                    tags: tagsArraySchema,
                    metaData: metaDataOptional('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataOptional(
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
                        model: {
                            type: 'object',
                            title: 'CreateForwardedAddressResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Address' }
                            },
                            required: ['success', 'id']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

            // permissions check
            req.validate(roles.can(req.role).createAny('addresses'));

            let address = tools.normalizeAddress(result.value.address);
            let addrview = tools.uview(address);
            let name = result.value.name;

            let targets = result.value.targets || [];
            let forwards = result.value.forwards;

            if (result.value.autoreply) {
                if (!result.value.autoreply.name && 'name' in req.rawParams.autoreply) {
                    result.value.autoreply.name = '';
                }

                if (!result.value.autoreply.subject && 'subject' in req.rawParams.autoreply) {
                    result.value.autoreply.subject = '';
                }

                if (!result.value.autoreply.text && 'text' in req.rawParams.autoreply) {
                    result.value.autoreply.text = '';
                    if (!result.value.autoreply.html) {
                        // make sure we also update html part
                        result.value.autoreply.html = '';
                    }
                }

                if (!result.value.autoreply.html && 'html' in req.rawParams.autoreply) {
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

                try {
                    const domain = addressData.address.split('@')[1];
                    if (domain && !domain.includes('*')) {
                        await db.users.collection('domaincache').insertOne({ domain });
                    }
                } catch {
                    // ignore
                }
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
                    address: {
                        type: 'string',
                        wdValidator: 'email',
                        description: 'New address. Only affects normal addresses, special addresses that include * can not be changed'
                    },
                    name: identityName,
                    targets: forwardTargetsSchema(
                        'An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25") or an URL where mail contents are POSTed to. If set then overwrites previous targets array'
                    ),
                    forwards: { type: 'number', minimum: 0, wdType: 'number', description: 'Daily allowed forwarding count for this address' },
                    autoreply: Autoreply,
                    tags: tagsArraySchema,
                    metaData: metaDataOptional('Optional metadata, must be an object or JSON formatted string'),
                    internalData: metaDataOptional(
                        'Optional metadata for internal use, must be an object or JSON formatted string of an object. Not available for user-role tokens'
                    ),
                    forwardedDisabled: { $ref: 'wd:boolean', description: 'If true then disables forwarded address (stops forwarding messages)' },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: { id: addressId },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SuccessResponse',
                            properties: { success: { $ref: 'wd:successRes' } },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
                if (!result.value.autoreply.name && 'name' in req.rawParams.autoreply) {
                    result.value.autoreply.name = '';
                }

                if (!result.value.autoreply.subject && 'subject' in req.rawParams.autoreply) {
                    result.value.autoreply.subject = '';
                }

                if (!result.value.autoreply.text && 'text' in req.rawParams.autoreply) {
                    result.value.autoreply.text = '';
                    if (!result.value.autoreply.html) {
                        // make sure we also update html part
                        result.value.autoreply.html = '';
                    }
                }

                if (!result.value.autoreply.html && 'html' in req.rawParams.autoreply) {
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

                try {
                    const domain = addressData.address.split('@')[1];
                    if (domain && !domain.includes('*')) {
                        await db.users.collection('domaincache').insertOne({ domain });
                    }
                } catch {
                    // ignore
                }
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
                        model: {
                            type: 'object',
                            title: 'SuccessResponse',
                            properties: { success: { $ref: 'wd:successRes' } },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
                        model: {
                            type: 'object',
                            title: 'GetForwardedAddressResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Address' },
                                address: { type: 'string', description: 'E-mail address string' },
                                name: { type: 'string', description: 'Identity name' },
                                targets: { type: 'array', items: { type: 'string' }, description: 'List of forwarding targets' },
                                limits: AddressLimits,
                                autoreply: AutoreplyInfo,
                                created: { description: 'Datestring of the time the address was created' },
                                tags: { type: 'array', items: { type: 'string' }, description: 'List of tags associated with the Address' },
                                metaData: { description: 'Metadata object (if available)' },
                                internalData: { description: 'Internal metadata object (if available), not included for user-role requests' },
                                forwardedDisabled: { type: 'boolean', description: 'Specifies whether forwarding is disabled' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
                name: addressData.name || undefined,
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
                    allowWildcard: { $ref: 'wd:boolean', description: 'If true then resolves also wildcard addresses' },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    address: {
                        type: 'string',
                        wdLowercase: true,
                        wdRequired: true,
                        anyOf: [{ pattern: '^[0-9a-f]{24}$' }, { wdAssert: 'email' }, { pattern: '^(?:[^@\\s]*\\*[^@\\s]*@[^@\\s]+|[^@\\s]+@\\*)$' }],
                        description: 'ID of the Address or e-mail address string (including wildcard addresses)'
                    }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'ResolveAddressResponse',
                            additionalProperties: true,
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'ID of the Address' },
                                address: { type: 'string', description: 'E-mail address string' },
                                user: { type: 'string', description: 'User ID this address belongs to if this is a User address' },
                                name: { type: 'string', description: 'Identity name' },
                                targets: { type: 'array', items: { type: 'string' }, description: 'List of forwarding targets if this is a Forwarded address' },
                                limits: AddressLimits,
                                autoreply: AutoreplyInfo,
                                tags: { type: 'array', items: { type: 'string' }, description: 'List of tags associated with the Address' },
                                created: { description: 'Datestring of the time the address was created' },
                                metaData: { description: 'Metadata object (if available)' },
                                internalData: { description: 'Internal metadata object (if available), not included for user-role requests' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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
                    oldDomain: { type: 'string', minLength: 1, wdRequired: true, description: 'Old Domain Name' },
                    newDomain: { type: 'string', minLength: 1, wdRequired: true, description: 'New Domain Name' },
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'ResolveDomainAddressesResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                modifiedAddresses: { type: 'number', description: 'Number of modified addresses' },
                                modifiedUsers: { type: 'number', description: 'Number of modified users' },
                                modifiedDkim: { type: 'number', description: 'Number of modified DKIM keys' },
                                modifiedAliases: { type: 'number', description: 'Number of modified Domain Aliases' }
                            },
                            required: ['success', 'modifiedAddresses', 'modifiedUsers', 'modifiedDkim', 'modifiedAliases']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const result = { value: req.params };

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

            try {
                const domain = newDomain;
                if (domain && !domain.includes('*')) {
                    await db.users.collection('domaincache').insertOne({ domain });
                }
            } catch {
                // ignore
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
