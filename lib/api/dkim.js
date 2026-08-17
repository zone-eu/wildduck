'use strict';

const config = require('@zone-eu/wild-config');
const { objectIdSchema } = require('../schemas/json-schemas');
const ObjectId = require('mongodb').ObjectId;
const DkimHandler = require('../dkim-handler');
const tools = require('../tools');
const roles = require('../roles');
const { mongopagingFindWrapper } = require('../mongopaging-find-wrapper');

const dkimIdParam = objectIdSchema('ID of the DKIM', { wdRequired: true });

const dnsTxtResponse = {
    type: 'object',
    title: 'DnsTxt',
    description: 'Value for DNS TXT entry',
    properties: {
        name: { type: 'string', description: 'Is the domain name of TXT' },
        value: { type: 'string', description: 'Is the value of TXT' }
    },
    required: ['name', 'value']
};

const dkimKeyResponseProperties = {
    id: { type: 'string', description: 'ID of the DKIM' },
    domain: { type: 'string', description: 'The domain this DKIM key applies to' },
    selector: { type: 'string', description: 'DKIM selector' },
    description: { type: 'string', description: 'Key description' },
    fingerprint: { type: 'string', description: 'Key fingerprint (SHA1)' },
    publicKey: { type: 'string', description: 'Public key in DNS format (no prefix/suffix, single line)' },
    dnsTxt: dnsTxtResponse
};

module.exports = (db, server) => {
    const dkimHandler = new DkimHandler({
        cipher: config.dkim.cipher,
        secret: config.dkim.secret,
        database: db.database,
        redis: db.redis
    });

    server.route({
        method: 'GET',
        url: '/dkim',
        schema: {
            summary: 'List registered DKIM keys',
            tags: ['DKIM']
        },
        config: {
            name: 'getDkimKeys',
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
                        description: 'Partial match of a Domain name'
                    },
                    limit: { $ref: 'wd:pageLimit' },
                    next: {
                        $ref: 'wd:cursor',
                        description: 'Cursor value for next page, retrieved from nextCursor response value'
                    },
                    previous: {
                        $ref: 'wd:cursor',
                        description: 'Cursor value for previous page, retrieved from previousCursor response value'
                    },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetDkimKeysResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                total: { $ref: 'wd:totalRes' },
                                page: { $ref: 'wd:pageRes' },
                                previousCursor: { $ref: 'wd:previousCursorRes' },
                                nextCursor: { $ref: 'wd:nextCursorRes' },
                                query: { type: 'string', description: 'Query string. Partial match of a Domain name' },
                                results: {
                                    type: 'array',
                                    description: 'DKIM listing',
                                    items: {
                                        type: 'object',
                                        title: 'GetDkimKeysResult',
                                        properties: {
                                            id: { type: 'string', description: 'ID of the DKIM' },
                                            domain: { type: 'string', description: 'The domain this DKIM key applies to' },
                                            selector: { type: 'string', description: 'DKIM selector' },
                                            description: { type: 'string', description: 'Key description' },
                                            fingerprint: { type: 'string', description: 'Key fingerprint (SHA1)' },
                                            created: { type: 'string', format: 'date-time', description: 'DKIM created datestring' }
                                        },
                                        // fingerprint/created are echoed from the db document and
                                        // may be absent on legacy records
                                        required: ['id', 'domain', 'selector']
                                    }
                                }
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
            req.validate(roles.can(req.role).readAny('dkim'));

            let query = values.query;
            let limit = values.limit;
            let pageNext = values.next;
            let pagePrevious = values.previous;

            let filter = query
                ? {
                      domain: {
                          $regex: tools.escapeRegexStr(query),
                          $options: ''
                      }
                  }
                : {};

            let total = await db.database.collection('dkim').countDocuments(filter);

            let opts = {
                limit,
                query: filter,
                paginatedField: 'domain',
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
                listingWrapper = await mongopagingFindWrapper(db.database.collection('dkim'), opts);
            } catch (err) {
                return reply.code(500).send({
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
                results: (listingWrapper.listing.results || []).map(dkimData => ({
                    id: dkimData._id.toString(),
                    domain: dkimData.domain,
                    selector: dkimData.selector,
                    description: dkimData.description,
                    fingerprint: dkimData.fingerprint,
                    created: dkimData.created
                }))
            };

            return reply.send(response);
        }
    });

    server.route({
        method: 'GET',
        url: '/dkim/resolve/:domain',
        schema: {
            summary: 'Resolve ID for a DKIM domain',
            tags: ['DKIM']
        },
        config: {
            name: 'resolveDkim',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    domain: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdRequired: true,
                        description: 'DKIM domain'
                    }
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'ResolveIdResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' },
                                id: { type: 'string', description: 'DKIM unique ID (24 byte hex)', examples: ['609d201236d1d936948f23b1'] }
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
            req.validate(roles.can(req.role).readAny('dkim'));

            let domain = tools.normalizeDomain(values.domain);

            let dkimData;

            try {
                dkimData = await db.database.collection('dkim').findOne(
                    {
                        domain
                    },
                    {
                        projection: { _id: 1 }
                    }
                );
            } catch (err) {
                return reply.code(500).send({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
            }

            if (!dkimData) {
                return reply.code(404).send({
                    error: 'This domain does not exist',
                    code: 'DkimNotFound'
                });
            }

            return reply.send({
                success: true,
                id: dkimData._id.toString()
            });
        }
    });

    server.route({
        method: 'POST',
        url: '/dkim',
        schema: {
            summary: 'Create or update DKIM key for domain',
            description: 'Add a new DKIM key for a Domain or update existing one. There can be single DKIM key registered for each domain name.',
            tags: ['DKIM']
        },
        config: {
            name: 'updateDkimKey',
            validationObjs: {
                requestBody: {
                    domain: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdRequired: true,
                        description:
                            'Domain name this DKIM key applies to. Use "*" as a special value that will be used for domains that do not have their own DKIM key set'
                    },
                    selector: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdTrim: true,
                        wdRequired: true,
                        description: 'Selector for the key'
                    },
                    privateKey: {
                        wdEmpty: true,
                        wdTrim: true,
                        anyOf: [
                            {
                                type: 'string',
                                pattern: '^-----BEGIN (RSA )?PRIVATE KEY-----',
                                description: 'PEM format RSA or ED25519 string'
                            },
                            {
                                type: 'string',
                                minLength: 44,
                                maxLength: 44,
                                pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
                                description: 'Raw ED25519 key 44 bytes long if using base64'
                            }
                        ],
                        description:
                            'Pem formatted DKIM private key, raw ED25519 is also allowed. If not set then a new 2048 bit RSA key is generated, beware though that it can take several seconds to complete.'
                    },
                    description: {
                        type: 'string',
                        maxLength: 255,
                        minLength: 1,
                        wdTrim: true,
                        description: 'Key description'
                    },
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                queryParams: {},
                pathParams: {},
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'UpdateDkimKeyResponse',
                            properties: Object.assign({ success: { $ref: 'wd:successRes' } }, dkimKeyResponseProperties),
                            required: ['success', 'id', 'domain', 'selector', 'fingerprint', 'publicKey', 'dnsTxt']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).createAny('dkim'));

            let response;

            try {
                response = await dkimHandler.set(values);
            } catch (err) {
                return reply.code(err.responseCode || 500).send({
                    error: err.message,
                    code: err.code
                });
            }

            if (response) {
                response.success = true;
            }

            return reply.send(response);
        }
    });

    server.route({
        method: 'GET',
        url: '/dkim/:dkim',
        schema: {
            summary: 'Request DKIM information',
            tags: ['DKIM']
        },
        config: {
            name: 'getDkimKey',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    dkim: dkimIdParam
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'GetDkimKeyResponse',
                            properties: Object.assign({ success: { $ref: 'wd:successRes' } }, dkimKeyResponseProperties, {
                                created: { type: 'string', format: 'date-time', description: 'DKIM created datestring' }
                            }),
                            // created is echoed straight from the dkim document (dkim-handler.js:244)
                            required: ['success', 'id', 'domain', 'selector', 'fingerprint', 'publicKey', 'dnsTxt']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).readAny('dkim'));

            let dkim = new ObjectId(values.dkim);

            let response;
            try {
                response = await dkimHandler.get({ _id: dkim }, false);
            } catch (err) {
                return reply.code(err.responseCode || 500).send({
                    error: err.message,
                    code: err.code
                });
            }

            if (response) {
                response.success = true;
            }

            return reply.send(response);
        }
    });

    server.route({
        method: 'DELETE',
        url: '/dkim/:dkim',
        schema: {
            summary: 'Delete a DKIM key',
            tags: ['DKIM']
        },
        config: {
            name: 'deleteDkimKey',
            validationObjs: {
                requestBody: {},
                queryParams: {
                    sess: { $ref: 'wd:sess' },
                    ip: { $ref: 'wd:ip' }
                },
                pathParams: {
                    dkim: dkimIdParam
                },
                response: {
                    200: {
                        description: 'Success',
                        model: {
                            type: 'object',
                            title: 'SuccessResponse',
                            properties: {
                                success: { $ref: 'wd:successRes' }
                            },
                            required: ['success']
                        }
                    }
                }
            }
        },
        async handler(req, reply) {
            const values = req.params;

            // permissions check
            req.validate(roles.can(req.role).deleteAny('dkim'));

            let dkim = new ObjectId(values.dkim);

            let response;

            try {
                response = await dkimHandler.del({ _id: dkim });
            } catch (err) {
                return reply.code(err.responseCode || 500).send({
                    error: err.message,
                    code: err.code
                });
            }

            return reply.send({
                success: response
            });
        }
    });
};
