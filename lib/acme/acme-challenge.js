'use strict';

const { normalizeDomain } = require('../tools');
const { randomUUID: uuid } = require('crypto');

// Unfinished challenges are deleted after this amount of time
const DEFAULT_TTL = 2 * 3600 * 1000; // milliseconds

class AcmeChallenge {
    static create(config = {}) {
        return new AcmeChallenge(config);
    }

    constructor(config) {
        this.config = config;
        const { db, ttl } = this.config;

        this.uuid = uuid();
        this.db = db;
        this.ttl = ttl || DEFAULT_TTL;
    }

    init(/*opts*/) {
        // not much to do here
        return null;
    }

    async set(opts) {
        const { challenge } = opts;
        const { altname, keyAuthorization, token } = challenge;

        const domainData = await this.db.collection('certs').findOneAndUpdate(
            {
                servername: normalizeDomain(altname)
            },
            {
                $set: {
                    '_acme.token': token,
                    '_acme.secret.value': keyAuthorization,
                    '_acme.secret.created': new Date(),
                    '_acme.secret.expires': new Date(Date.now() + this.ttl)
                }
            },
            { returnDocument: 'after' }
        );

        if (!domainData || !domainData.value) {
            let err = new Error('Domain not found');
            err.responseCode = 404;
            throw err;
        }

        return true;
    }

    async get(query) {
        const { challenge } = query;
        const { identifier, token } = challenge;
        const domain = identifier.value;

        const domainData = await this.db.collection('certs').findOne({
            servername: normalizeDomain(domain),
            '_acme.token': token
        });

        if (!domainData || !domainData._acme || !domainData._acme.secret || !domainData._acme.secret.value) {
            return null;
        }

        if (domainData._acme.secret.expires < new Date()) {
            await this.db.collection('certs').updateOne(
                {
                    _id: domainData._id
                },
                { $unset: { '_acme.secret': '' } }
            );
            return null;
        }

        return { keyAuthorization: domainData._acme.secret.value };
    }

    async remove(opts) {
        const { challenge } = opts;
        const { identifier, token } = challenge;
        const domain = identifier.value;

        await this.db.collection('certs').updateOne(
            {
                servername: normalizeDomain(domain),
                '_acme.token': token
            },
            { $unset: { '_acme.secret': '', '_acme.token': '' } }
        );

        return;
    }
}

module.exports = AcmeChallenge;
