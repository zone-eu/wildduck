'use strict';

const { validateSvg } = require('mailauth/lib/bimi/validate-svg');
const { vmc } = require('@postalsys/vmc');
const { formatDomain, getAlignment } = require('mailauth/lib/tools');
const { bimi: bimiLookup } = require('mailauth/lib/bimi');
const crypto = require('crypto');
const log = require('npmlog');

const FETCH_TIMEOUT = 5 * 1000;

// Use fake User-Agent to pass UA checks for Akamai
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:60.0) Gecko/20100101 Firefox/81.0';

const { fetch: fetchCmd, Agent } = require('undici');
const fetchAgent = new Agent({ connect: { timeout: FETCH_TIMEOUT } });

class BimiHandler {
    static create(options = {}) {
        return new BimiHandler(options);
    }

    constructor(options) {
        this.options = options || {};

        this.database = options.database;
        this.loggelf = options.loggelf || (() => false);
    }

    async download(url, bimiDocument, bimiType, bimiDomain) {
        if (!url) {
            return false;
        }

        bimiDocument = bimiDocument || {};

        const parsedUrl = new URL(url);

        switch (parsedUrl.protocol) {
            case 'https:':
                break;

            case 'http:': {
                let error = new Error(`Only HTTPS addresses are allowed`);
                error.code = 'PROTO_NOT_HTTPS';

                error.source = 'pre-request';
                throw error;
            }

            default: {
                let error = new Error(`Unknown protocol ${parsedUrl.protocol}`);
                error.code = 'UNKNOWN_PROTO';

                error.source = 'pre-request';
                throw error;
            }
        }

        const headers = {
            // Comment: AKAMAI does some strange UA based filtering that messes up the request
            // 'User-Agent': `${packageData.name}/${packageData.version} (+${packageData.homepage}`
            'User-Agent': USER_AGENT
        };

        if (bimiDocument.etag) {
            headers['If-None-Match'] = bimiDocument.etag;
        }

        if (bimiDocument.lastModified) {
            headers['If-Modified-Since'] = bimiDocument.lastModified;
        }

        let res = await fetchCmd(parsedUrl, {
            headers,
            redirect: 'manual',
            dispatcher: fetchAgent
        });

        if (res.status === 304) {
            // no changes
            let err = new Error('No changes');
            err.code = 'NO_CHANGES';
            throw err;
        }

        if (!res.ok) {
            let error = new Error(`Request failed with status ${res.status}`);
            error.code = 'HTTP_REQUEST_FAILED';

            this.loggelf({
                short_message: `[BIMI FETCH] ${url}`,
                _mail_action: 'bimi_fetch',
                _bimi_url: url,
                _bimi_type: bimiType,
                _bimi_domain: bimiDomain,
                _req_etag: bimiDocument.etag,
                _req_last_modified: bimiDocument.lastModified,
                _failure: 'yes',
                _error: error.message,
                _err_code: error.code
            });

            throw error;
        }

        const arrayBufferValue = await res.arrayBuffer();
        const content = Buffer.from(arrayBufferValue);

        this.loggelf({
            short_message: `[BIMI FETCH] ${url}`,
            _mail_action: 'bimi_fetch',
            _bimi_url: url,
            _bimi_type: bimiType,
            _bimi_domain: bimiDomain,
            _status_code: res.status,
            _req_etag: bimiDocument.etag,
            _req_last_modified: bimiDocument.lastModified,
            _res_etag: res.headers.get('ETag'),
            _res_last_modified: res.headers.get('Last-Modified')
        });

        if (!res.status || res.status < 200 || res.status >= 300) {
            let err = new Error(`Invalid response code ${res.status || '-'}`);

            if (res.headers.get('Location') && res.status >= 300 && res.status < 400) {
                err.code = 'REDIRECT_NOT_ALLOWED';
            } else {
                err.code = 'HTTP_STATUS_' + (res.status || 'NA');
            }

            err.details = err.details || {
                code: res.status,
                url,
                etag: bimiDocument.etag,
                lastModified: bimiDocument.lastModified,
                location: res.headers.get('Location')
            };

            throw err;
        }
        return {
            content,
            etag: res.headers.get('ETag'),
            lastModified: res.headers.get('Last-Modified')
        };
    }

    async getBimiData(url, type, bimiDomain) {
        if (!url) {
            return false;
        }

        const now = new Date();

        let bimiDocument = await this.database.collection('bimi').findOne({ url, type });

        let bimiTtl = bimiDocument?.error ? 1 * 3600 * 1000 : 24 * 3600 * 1000;

        if (bimiDocument && bimiDocument?.updated > new Date(now.getTime() - bimiTtl)) {
            if (
                bimiDocument.error &&
                // ignore errors if a valid VMC is cached
                !(type === 'authority' && bimiDocument?.vmc?.certificate?.validTo && new Date(bimiDocument?.vmc?.certificate?.validTo) >= now)
            ) {
                let error = new Error(bimiDocument.error.message);
                if (bimiDocument.error.details) {
                    error.details = bimiDocument.error.details;
                }
                if (bimiDocument.error.code) {
                    error.code = bimiDocument.error.code;
                }

                error.source = 'db';
                throw error;
            }

            if (bimiDocument?.content?.buffer) {
                bimiDocument.content = bimiDocument.content.buffer;
            }

            bimiDocument.source = 'db';
            bimiDocument.error = null; // override existing error if using a cached valid VMC
            return bimiDocument;
        }

        let bimiDocumentUpdate = {
            updated: now
        };

        // Step 1. Download

        let file;
        try {
            let { content, etag, lastModified } = await this.download(url, bimiDocument, type, bimiDomain);
            bimiDocumentUpdate.etag = etag || null;
            bimiDocumentUpdate.lastModified = lastModified || null;

            file = content;
        } catch (err) {
            if (err.code === 'NO_CHANGES') {
                if (bimiDocument?.content?.buffer && bimiDocument.error?.type === 'download') {
                    // download failed last time, so run validations again
                    file = bimiDocument.content.buffer;
                } else {
                    // existing document is good enough, proceed to checkout
                    let r = await this.database.collection('bimi').findOneAndUpdate(
                        {
                            type,
                            url
                        },
                        {
                            $set: bimiDocumentUpdate,
                            $setOnInsert: {
                                url,
                                type,
                                created: new Date()
                            }
                        },
                        { includeResultMetadata: true, upsert: true, returnDocument: 'after' }
                    );

                    let updatedBimiDocument = r?.value;
                    if (updatedBimiDocument?.content?.buffer) {
                        updatedBimiDocument.content = updatedBimiDocument.content.buffer;
                    }

                    if (bimiDocument.error) {
                        let error = new Error(bimiDocument.error.message);
                        if (bimiDocument.error.details) {
                            error.details = bimiDocument.error.details;
                        }
                        if (bimiDocument.error.code) {
                            error.code = bimiDocument.error.code;
                        }

                        error.source = 'cache-hit';
                        throw error;
                    }

                    updatedBimiDocument.source = 'cache-hit';
                    return updatedBimiDocument;
                }
            } else {
                bimiDocumentUpdate.error = {
                    message: err.message,
                    details: err.details,
                    code: err.code,
                    type: 'download',
                    time: now
                };

                try {
                    await this.database.collection('bimi').updateOne(
                        {
                            url,
                            type
                        },
                        {
                            $set: bimiDocumentUpdate,
                            $setOnInsert: {
                                type,
                                url,
                                created: new Date()
                            }
                        },
                        { upsert: true }
                    );
                } catch (err) {
                    // ignore
                }

                err.source = 'post-request';
                throw err;
            }
        }

        // Step 2. Validate VMC
        if (type === 'authority') {
            try {
                let vmcData = await vmc(file);

                if (!vmcData.logoFile) {
                    let error = new Error('VMC does not contain a logo file');
                    error.code = 'MISSING_VMC_LOGO';

                    error.source = 'post-request';
                    throw error;
                }

                if (vmcData?.mediaType?.toLowerCase() !== 'image/svg+xml') {
                    let error = new Error('Invalid media type for the logo file');
                    error.details = {
                        mediaType: vmcData.mediaType
                    };
                    error.code = 'INVALID_MEDIATYPE';

                    error.source = 'post-request';
                    throw error;
                }

                if (!vmcData.validHash) {
                    let error = new Error('VMC hash does not match logo file');
                    error.details = {
                        hashAlgo: vmcData.hashAlgo,
                        hashValue: vmcData.hashValue,
                        logoFile: vmcData.logoFile
                    };
                    error.code = 'INVALID_LOGO_HASH';

                    error.source = 'post-request';
                    throw error;
                }

                bimiDocumentUpdate.content = Buffer.from(vmcData.logoFile, 'base64');
                bimiDocumentUpdate.vmc = vmcData;
            } catch (err) {
                bimiDocumentUpdate.error = {
                    message: err.message,
                    details: err.details,
                    code: err.code,
                    type: 'vmc',
                    time: now
                };

                try {
                    await this.database.collection('bimi').updateOne(
                        {
                            type,
                            url
                        },
                        {
                            $set: bimiDocumentUpdate,
                            $setOnInsert: {
                                type,
                                url,
                                created: new Date()
                            }
                        },
                        { upsert: true }
                    );
                } catch (err) {
                    // ignore
                }

                err.source = err.source || 'post-request';
                throw err;
            }
        } else {
            bimiDocumentUpdate.content = file;
        }

        // Step 3. Validate SVG

        try {
            validateSvg(bimiDocumentUpdate.content);
        } catch (err) {
            let error = new Error('VMC logo SVG validation failed');
            error.details = Object.assign(
                {
                    message: err.message
                },
                error.details || {},
                err.code ? { code: err.code } : {}
            );
            error.code = 'SVG_VALIDATION_FAILED';

            bimiDocumentUpdate.error = {
                message: error.message,
                details: error.details,
                code: error.code,
                type: 'svg',
                time: now
            };

            try {
                await this.database.collection('bimi').updateOne(
                    {
                        type,
                        url
                    },
                    {
                        $set: bimiDocumentUpdate,
                        $setOnInsert: {
                            type,
                            url,
                            created: new Date()
                        }
                    },
                    { upsert: true }
                );
            } catch (err) {
                // ignore
            }

            error.source = 'post-request';
            throw error;
        }

        // clear pending errors
        bimiDocumentUpdate.error = null;

        let r = await this.database.collection('bimi').findOneAndUpdate(
            {
                type,
                url
            },
            {
                $set: bimiDocumentUpdate,
                $setOnInsert: {
                    type,
                    url,
                    created: new Date()
                }
            },
            { includeResultMetadata: true, upsert: true, returnDocument: 'after' }
        );

        let updatedBimiDocument = r?.value;

        if (updatedBimiDocument?.content?.buffer) {
            updatedBimiDocument.content = updatedBimiDocument.content.buffer;
        }

        updatedBimiDocument.source = 'new';
        return updatedBimiDocument;
    }

    async getInfo(bimiData) {
        let [
            { reason: locationError, value: locationValue, status: locationStatus },
            { reason: authorityError, value: authorityValue, status: authorityStatus }
        ] = await Promise.allSettled([
            this.getBimiData(bimiData.location, 'location', bimiData.status?.header?.d),
            this.getBimiData(bimiData.authority, 'authority', bimiData.status?.header?.d)
        ]);

        if (authorityError) {
            throw authorityError;
        }

        if (authorityStatus === 'fulfilled' && authorityValue) {
            let selector = bimiData.status?.header?.selector;
            let d = bimiData.status?.header?.d;

            // validate domain
            let selectorSet = [];
            let domainSet = [];
            authorityValue.vmc?.certificate?.subjectAltName?.map(formatDomain)?.forEach(domain => {
                if (/\b_bimi\./.test(domain)) {
                    selectorSet.push(domain);
                } else {
                    domainSet.push(domain);
                }
            });

            let domainVerified = false;

            if (selector && selectorSet.includes(formatDomain(`${selector}._bimi.${d}`))) {
                domainVerified = true;
            } else {
                let alignedDomain = getAlignment(d, domainSet, false);
                if (alignedDomain) {
                    domainVerified = true;
                }
            }

            if (!domainVerified) {
                let error = new Error('Domain can not be verified');
                error.details = {
                    subjectAltName: authorityValue.vmc?.certificate?.subjectAltName,
                    selector,
                    d
                };
                error.code = 'VMC_DOMAIN_MISMATCH';
                throw error;
            }

            if (locationStatus === 'fulfilled' && locationValue?.content && authorityValue.vmc?.hashAlgo && authorityValue.vmc?.validHash) {
                let hash = crypto
                    .createHash(authorityValue.vmc.hashAlgo)
                    //sss
                    .update(locationValue.content)
                    .digest('hex');
                if (hash === authorityValue.vmc.hashValue) {
                    // logo files match, so location URL is safe to use
                    authorityValue.locationUrl = bimiData.location;
                } else {
                    log.info(
                        'BIMI',
                        'Logo files from l= and a= do not match lh=%s ah=%s algo=%s d=%s',
                        hash,
                        authorityValue.vmc.hashValue,
                        authorityValue.vmc.hashAlgo,
                        d
                    );
                    authorityValue.locationUrl = bimiData.location;
                }
            }

            return authorityValue;
        }

        // If signed VMC was ok, then ignore any errors from regular SVG as this would not be used anyway
        if (locationError) {
            throw locationError;
        }

        return locationStatus === 'fulfilled' && locationValue;
    }

    /**
     * Helper method to fetch BIMI info for a domain name and selector
     * @param {String} domain
     * @param {String} [selector]
     * @returns {Object} BIMI record
     */
    async fetchByDomain(domain, selector) {
        const bimiVerificationResults = await bimiLookup({
            dmarc: {
                status: {
                    result: 'pass',
                    header: {
                        from: domain
                    }
                },
                domain,
                policy: 'reject'
            },

            headers: {
                parsed:
                    selector && selector !== 'default'
                        ? [
                              {
                                  key: 'bimi-selector',
                                  line: `v=BIMI1; s=${selector}`
                              }
                          ]
                        : []
            }
        });

        return await this.getInfo(bimiVerificationResults);
    }
}

module.exports = BimiHandler;

/*
const db = require('./db');
db.connect(() => {
    let bimi = BimiHandler.create({
        database: db.database
    });

    let zoneBimi = {
        status: {
            header: {
                selector: 'default',
                d: 'zone.ee'
            },
            result: 'pass'
        },
        rr: 'v=BIMI1; l=https://zone.ee/common/img/zone_profile_square_bimi.svg;a=https://zone.ee/.well-known/bimi.pem',
        location: 'https://zone.ee/common/img/zone_profile_square_bimi.svg',
        authority: 'https://zone.ee/.well-known/bimi.pem',
        info: 'bimi=pass header.selector=default header.d=zone.ee'
    };

    zoneBimi = {
        status: {
            header: {
                selector: 'default',
                d: 'ups.com'
            },
            result: 'pass'
        },
        rr: 'v=BIMI1; l=https://www.ups.com/assets/resources/bimi/ups_bimi_logo.svg;  a=https://www.ups.com/assets/resources/bimi/ups_bimi_vmc.pem;',
        location: 'https://www.ups.com/assets/resources/bimi/ups_bimi_logo.svg',
        authority: 'https://www.ups.com/assets/resources/bimi/ups_bimi_vmc.pem',
        info: 'bimi=pass header.selector=default header.d=ups.com'
    };

    bimi.getInfo(zoneBimi)
        .then(result => console.log(require('util').inspect(result, false, 22)))
        .catch(err => console.error(err))
        .finally(() => process.exit());
});
*/
