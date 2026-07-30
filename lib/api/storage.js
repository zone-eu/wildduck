'use strict';

const log = require('npmlog');
const ObjectId = require('mongodb').ObjectId;
const tools = require('../tools');
const roles = require('../roles');
const consts = require('../consts');
const { mongopagingFindWrapper } = require('../mongopaging-find-wrapper');

const fileIdParam = {
    type: 'string',
    pattern: '^[0-9a-f]{24}$',
    minLength: 24,
    maxLength: 24,
    wdLowercase: true,
    wdRequired: true,
    description: 'ID of the File'
};

const optionalShortString = description => ({
    type: 'string',
    maxLength: 255,
    minLength: 1,
    wdEmpty: true,
    description
});

module.exports = (db, server, storageHandler) => {
    server.post(
        {
            path: '/users/:user/storage',
            tags: ['Storage'],
            summary: 'Upload file',
            name: 'uploadFile',
            description: 'This method allows to upload an attachment to be linked from a draft',
            jsonSchema: true,
            rawBodyParam: 'content',
            validationObjs: {
                requestBody: {
                    filename: optionalShortString('Name of the file'),
                    contentType: optionalShortString('MIME type of the file. Is detected from the file name by default'),
                    encoding: {
                        type: 'string',
                        enum: ['base64'],
                        wdEmpty: true,
                        description: 'Encoding of the file content. Useful if you want to upload the file in base64 encoded format. Valid option "base64"'
                    },

                    content: {
                        wdType: 'binary',
                        wdInstanceof: 'Buffer',
                        wdMaxBytes: consts.MAX_ALLOWED_MESSAGE_SIZE,
                        wdEmpty: true,
                        wdRequired: true,
                        description: 'File content in binary'
                    },
                    cid: optionalShortString('content ID'),

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
                            title: 'UploadFileResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'File ID' }
                            },
                            required: ['success', 'id']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

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
            jsonSchema: true,
            allowUnknown: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    query: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdTrim: true,
                        wdEmpty: true,
                        description: 'partial match of a filename'
                    },
                    limit: { $ref: 'wd:pageLimit' },
                    next: { $ref: 'wd:cursor', description: 'Cursor value for next page, retrieved from nextCursor response value' },
                    previous: { $ref: 'wd:cursor', description: 'Cursor value for previous page, retrieved from previousCursor response value' },
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
                            title: 'GetFilesResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                query: { type: 'string', description: 'Additional query string' },
                                total: { $ref: 'wd:totalRes' },
                                page: { $ref: 'wd:pageRes' },
                                previousCursor: { $ref: 'wd:previousCursorRes' },
                                nextCursor: { $ref: 'wd:nextCursorRes' },
                                results: {
                                    type: 'array',
                                    description: 'File listing',
                                    items: {
                                        type: 'object',
                                        title: 'GetFilesResult',
                                        properties: {
                                            id: { type: 'string', description: 'File ID' },
                                            filename: { type: 'string', description: 'Filename' },
                                            contentType: { type: 'string', description: 'Content-Type of the file' },
                                            cid: { type: 'string', description: 'Content ID' },
                                            size: { type: 'number', description: 'File size' },
                                            created: { type: 'string', format: 'date-time', description: 'Created datestring' },
                                            md5: { type: 'string', description: 'md5 hash' }
                                        },
                                        required: ['id', 'size', 'created']
                                    }
                                }
                            },
                            required: ['success', 'total', 'page', 'previousCursor', 'nextCursor', 'results']
                        }
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

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
            }
            if (pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listingWrapper;
            try {
                listingWrapper = await mongopagingFindWrapper(db.gridfs.collection('storage.files'), opts);
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
                results: (listingWrapper.listing.results || []).map(fileData => ({
                    id: fileData._id.toString(),
                    filename: fileData.filename || undefined,
                    contentType: fileData.contentType || undefined,
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
            jsonSchema: true,
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    file: fileIdParam
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
            const result = { value: req.params };

            let user = new ObjectId(result.value.user);

            // permissions check
            if (req.user && req.user === result.value.user) {
                req.validate(roles.can(req.role).deleteOwn('storage'));
            } else {
                req.validate(roles.can(req.role).deleteAny('storage'));
            }

            let file = new ObjectId(result.value.file);
            try {
                await storageHandler.delete(user, file);
            } catch (err) {
                log.error('API', 'STORAGEDELFAIL user=%s file=%s error=%s', user, file, err.message);
                throw err;
            }

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
            jsonSchema: true,
            // the restify-era handler never called res.charSet()
            charset: false,
            validationObjs: {
                requestBody: {},
                queryParams: {},
                pathParams: {
                    user: { $ref: 'wd:userId' },
                    file: fileIdParam
                },
                response: {
                    200: {
                        description: 'Success'
                    }
                }
            }
        },
        tools.responseWrapper(async (req, res) => {
            const result = { value: req.params };

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
