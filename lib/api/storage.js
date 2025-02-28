'use strict';

const Joi = require('joi');
const MongoPaging = require('mongo-cursor-pagination');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const roles = require('../roles');
const consts = require('../consts');
const { nextPageCursorSchema, previousPageCursorSchema, pageNrSchema, sessSchema, sessIPSchema, booleanSchema } = require('../schemas');
const { userId } = require('../schemas/request/general-schemas');
const { successRes, totalRes, pageRes, previousCursorRes, nextCursorRes } = require('../schemas/response/general-schemas');

module.exports = (db, server, storageHandler) => {
    server.post(
        {
            path: '/users/:user/storage',
            tags: ['Storage'],
            summary: 'Upload file',
            name: 'uploadFile',
            description: 'This method allows to upload an attachment to be linked from a draft',
            validationObjs: {
                requestBody: {
                    filename: Joi.string().empty('').max(255).description('Name of the file'),
                    contentType: Joi.string().empty('').max(255).description('MIME type of the file. Is detected from the file name by default'),
                    encoding: Joi.string()
                        .empty('')
                        .valid('base64')
                        .description(
                            'Encoding of the file content. Useful if you want to upload the file in base64 encoded format. Valid options "base64", "hex", "utf8"'
                        ),

                    content: Joi.binary().max(consts.MAX_ALLOWED_MESSAGE_SIZE).empty('').required().description('File content in binary'),
                    cid: Joi.string().empty('').max(255).description('content ID'),

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
                            id: Joi.string().required().description('File ID')
                        }).$_setFlag('objectName', 'UploadFileResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...requestBody,
                ...queryParams,
                ...pathParams
            });

            if (!req.params.content && req.body && (Buffer.isBuffer(req.body) || typeof req.body === 'string')) {
                req.params.content = req.body;
            }

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
                req.validate(roles.can(req.role).createOwn('storage'));
            } else {
                req.validate(roles.can(req.role).createAny('storage'));
            }

            let user = new ObjectId(result.value.user);

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

            let id = await storageHandler.add(user, result.value);

            return res.json({
                success: !!id,
                id
            });
        })
    );

    server.get(
        {
            path: '/users/:user/storage',
            tags: ['Storage'],
            summary: 'List stored files',
            name: 'getFiles',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    query: Joi.string().trim().empty('').max(255).description('partial match of a filename'),
                    limit: Joi.number().default(20).min(1).max(250).description('How many records to return'),
                    next: nextPageCursorSchema,
                    previous: previousPageCursorSchema,
                    page: pageNrSchema,
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
                            total: totalRes,
                            page: pageRes,
                            previousCursor: previousCursorRes,
                            nextCursor: nextCursorRes,
                            results: Joi.array()
                                .items(
                                    Joi.object({
                                        id: Joi.string().required().description('File ID'),
                                        filename: Joi.alternatives()
                                            .try(Joi.string().required(), booleanSchema.required())
                                            .required()
                                            .description('Filename. False if none'),
                                        contentType: Joi.alternatives()
                                            .try(Joi.string().required(), booleanSchema.required())
                                            .required()
                                            .description('Content-Type of the file. False if none'),
                                        cid: Joi.string().description('Content ID'),
                                        size: Joi.number().required().description('File size'),
                                        created: Joi.date().required().description('Created datestring'),
                                        md5: Joi.string().description('md5 hash').required()
                                    })
                                        .required()
                                        .$_setFlag('objectName', 'GetFilesResult')
                                )
                                .required()
                                .description('File listing')
                        }).$_setFlag('objectName', 'GetFilesResponse')
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...requestBody,
                ...queryParams,
                ...pathParams
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
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).readOwn('storage'));
            } else {
                req.validate(roles.can(req.role).readAny('storage'));
            }

            let user = new ObjectId(result.value.user);

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

            let query = result.value.query;
            let limit = result.value.limit;
            let page = result.value.page;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;

            let filter = (query && {
                'metadata.user': user,
                filename: {
                    $regex: tools.escapeRegexStr(query),
                    $options: ''
                }
            }) || {
                'metadata.user': user
            };

            let total = await db.gridfs.collection('storage.files').countDocuments(filter);

            let opts = {
                limit,
                query: filter,
                paginatedField: 'filename',
                sortAscending: true
            };

            if (pageNext) {
                opts.next = pageNext;
            } else if ((!page || page > 1) && pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listing;
            try {
                listing = await MongoPaging.find(db.gridfs.collection('storage.files'), opts);
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
                results: (listing.results || []).map(fileData => ({
                    id: fileData._id.toString(),
                    filename: fileData.filename || false,
                    contentType: fileData.contentType || false,
                    cid: fileData.metadata?.cid,
                    size: fileData.length,
                    created: fileData.uploadDate.toISOString(),
                    md5: fileData.md5
                }))
            };

            return res.json(response);
        })
    );

    server.del(
        {
            path: '/users/:user/storage/:file',
            tags: ['Storage'],
            summary: 'Delete a File',
            name: 'deleteFile',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: sessSchema,
                    ip: sessIPSchema
                },
                pathParams: {
                    user: userId,
                    file: Joi.string().hex().lowercase().length(24).required().description('ID of the File')
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

            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...requestBody,
                ...queryParams,
                ...pathParams
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
                req.validate(roles.can(req.role).deleteOwn('storage'));
            } else {
                req.validate(roles.can(req.role).deleteAny('storage'));
            }

            let file = new ObjectId(result.value.file);
            await storageHandler.delete(user, file);

            return res.json({
                success: true
            });
        })
    );

    server.get(
        {
            path: '/users/:user/storage/:file',
            name: 'getFile',
            tags: ['Storage'],
            summary: 'Download File',
            description: 'This method returns stored file contents in binary form',
            responseType: 'application/octet-stream',
            validationObjs: {
                requestBody: {},
                queryParams: {},
                pathParams: {
                    user: userId,
                    file: Joi.string().hex().lowercase().length(24).required().description('ID of the File')
                },
                response: {
                    200: {
                        description: 'Success',
                        model: Joi.binary()
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const { requestBody, queryParams, pathParams } = req.route.spec.validationObjs;

            const schema = Joi.object({
                ...requestBody,
                ...queryParams,
                ...pathParams
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
                req.validate(roles.can(req.role).readOwn('storage'));
            } else {
                req.validate(roles.can(req.role).readAny('storage'));
            }

            let user = new ObjectId(result.value.user);
            let file = new ObjectId(result.value.file);

            let fileData;
            try {
                fileData = await db.gridfs.collection('storage.files').findOne({
                    _id: file,
                    'metadata.user': user
                });
            } catch (err) {
                res.status(500);
                return res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!fileData) {
                res.status(404);
                return res.json({
                    error: 'This file does not exist',
                    code: 'FileNotFound'
                });
            }

            res.writeHead(200, {
                'Content-Type': fileData.contentType || 'application/octet-stream'
            });

            let stream = storageHandler.gridstore.openDownloadStream(file);

            stream.once('error', err => {
                try {
                    res.end(err.message);
                } catch (err) {
                    //ignore
                }
            });

            stream.pipe(res);
        })
    );
};
