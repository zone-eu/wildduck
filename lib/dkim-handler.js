'use strict';

const ObjectId = require('mongodb').ObjectId;
const fingerprint = require('key-fingerprint').fingerprint;
const crypto = require('crypto');
const tools = require('./tools');
const { publish, DKIM_CREATED, DKIM_UPDATED, DKIM_DELETED } = require('./events');
const { encrypt, decrypt } = require('./encrypt');

const { promisify } = require('util');
const generateKeyPair = promisify(crypto.generateKeyPair);

const ASN1_PADDING = 'MC4CAQAwBQYDK2VwBCIEIA==';

class DkimHandler {
    constructor(options) {
        options = options || {};
        this.cipher = options.cipher;
        this.secret = options.secret;

        this.database = options.database;
        this.redis = options.redis;

        this.loggelf = options.loggelf || (() => false);
    }

    async generateKey(keyBits, keyExponent) {
        const { privateKey, publicKey } = await generateKeyPair('rsa', {
            modulusLength: keyBits || 2048, // options
            publicExponent: keyExponent || 65537,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem'
            }
        });

        return { privateKey, publicKey };
    }

    async set(options) {
        const domain = tools.normalizeDomain(options.domain);
        const selector = options.selector;
        const description = options.description;

        let privateKeyPem = options.privateKey;
        let publicKeyPem;
        let publicKeyDer;

        if (!privateKeyPem) {
            let keyPair = await this.generateKey();
            if (!keyPair || !keyPair.privateKey || !keyPair.publicKey) {
                let err = new Error('Failed to generate key pair');
                err.responseCode = 500;
                err.code = 'KeyGenerateError';
                throw err;
            }
            privateKeyPem = keyPair.privateKey;
            publicKeyPem = keyPair.publicKey;
        }

        // extract public key from private key

        // 1) check that privateKeyPem is ED25519 raw key, which length is 44
        if (privateKeyPem.length === 44) {
            // privateKeyPem is actually a raw ED25519 base64 string with length of 44
            // convert raw ED25519 key to PEM formatted private key
            privateKeyPem = `-----BEGIN PRIVATE KEY-----
${Buffer.concat([Buffer.from(ASN1_PADDING, 'base64'), Buffer.from(privateKeyPem, 'base64')]).toString('base64')}
-----END PRIVATE KEY-----`;
        }

        const publicKey = crypto.createPublicKey({ key: privateKeyPem, format: 'pem' });

        publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

        if (publicKey.asymmetricKeyType === 'ed25519') {
            publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
        } else if (publicKey.asymmetricKeyType === 'rsa') {
            publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
        }

        if (!publicKeyPem && !publicKeyDer) {
            let err = new Error('Failed to generate public key');
            err.responseCode = 500;
            err.code = 'KeyGenerateError';
            throw err;
        }

        let fp;
        try {
            fp = fingerprint(privateKeyPem, 'sha256', true);

            const testData = Buffer.from('secretvalue');
            const signature = crypto.sign(null, testData, privateKeyPem);
            const verificationResult = crypto.verify(null, testData, publicKeyPem, signature);

            if (!verificationResult) {
                throw new Error('Was not able to use key for encryption');
            }
        } catch (E) {
            let err = new Error('Invalid or incompatible private key. ' + E.message);
            err.responseCode = 400;
            err.code = 'InputValidationError';
            throw err;
        }

        // encrypt if needed
        privateKeyPem = await encrypt(privateKeyPem, this.secret);

        let dkimData = {
            domain,
            selector,
            privateKey: privateKeyPem,
            publicKey: publicKeyPem,
            publicKeyDer,
            fingerprint: fp,
            created: new Date(),
            latest: true
        };

        if (description) {
            dkimData.description = description;
        }

        let r;

        try {
            r = await this.database.collection('dkim').findOneAndReplace(
                {
                    domain
                },
                dkimData,
                { includeResultMetadata: true, upsert: true, returnDocument: 'after' }
            );
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!r.value) {
            let err = new Error('Failed to insert DKIM key');
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (this.redis) {
            if (r.lastErrorObject.upserted) {
                try {
                    await publish(this.redis, {
                        ev: DKIM_CREATED,
                        dkim: r.value._id,
                        domain,
                        selector,
                        fingerprint: fp
                    });
                } catch (err) {
                    // ignore?
                }
            } else if (r.lastErrorObject.updatedExisting) {
                try {
                    await publish(this.redis, {
                        ev: DKIM_UPDATED,
                        dkim: r.value._id,
                        domain,
                        selector,
                        fingerprint: fp
                    });
                } catch (err) {
                    // ignore?
                }
            }
        }

        return {
            id: r.value._id.toString(),
            domain: dkimData.domain,
            selector: dkimData.selector,
            description: dkimData.description,
            fingerprint: dkimData.fingerprint,
            publicKey: dkimData.publicKey,
            dnsTxt: {
                name: dkimData.selector + '._domainkey.' + dkimData.domain,
                value: 'v=DKIM1;t=s;p=' + dkimData.publicKeyDer
            }
        };
    }

    async get(options, includePrivateKey) {
        let query = {};
        options = options || {};

        if (options.domain) {
            query.domain = tools.normalizeDomain(options.domain);
        } else if (options._id && tools.isId(options._id)) {
            query._id = new ObjectId(options._id);
        } else {
            let err = new Error('Invalid or unknown DKIM key');
            err.responseCode = 404;
            err.code = 'DkimNotFound';
            throw err;
        }

        let dkimData;
        try {
            dkimData = await this.database.collection('dkim').findOne(query);
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }
        if (!dkimData) {
            let err = new Error('Invalid or unknown DKIM key');
            err.responseCode = 404;
            err.code = 'DkimNotFound';
            throw err;
        }

        let privateKey;
        if (includePrivateKey) {
            privateKey = await decrypt(dkimData.privateKey, this.secret, this.cipher);
        }

        return {
            id: dkimData._id.toString(),
            domain: dkimData.domain,
            selector: dkimData.selector,
            description: dkimData.description,
            fingerprint: dkimData.fingerprint,
            publicKey: dkimData.publicKey,
            privateKey,
            dnsTxt: {
                name: dkimData.selector + '._domainkey.' + dkimData.domain,
                value: 'v=DKIM1;t=s;p=' + dkimData.publicKey.replace(/^-.*-$/gm, '').replace(/\s/g, '')
            },
            created: dkimData.created
        };
    }

    async del(options) {
        let query = {};

        if (options.domain) {
            query.domain = tools.normalizeDomain(options.domain);
        } else if (options._id && tools.isId(options._id)) {
            query._id = new ObjectId(options._id);
        } else {
            let err = new Error('Invalid or unknown DKIM key');
            err.responseCode = 404;
            err.code = 'DkimNotFound';
            throw err;
        }

        // delete dkim key from database
        let r;
        try {
            r = await this.database.collection('dkim').findOneAndDelete(query, { includeResultMetadata: true });
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!r.value) {
            let err = new Error('Invalid or unknown DKIM key');
            err.responseCode = 404;
            err.code = 'DkimNotFound';
            throw err;
        }

        try {
            await publish(this.redis, {
                ev: DKIM_DELETED,
                dkim: r.value._id,
                domain: r.value.domain,
                selector: r.value.selector,
                fingerprint: r.value.fingerprint
            });
        } catch (err) {
            // ignore?
        }

        return true;
    }
}

module.exports = DkimHandler;
