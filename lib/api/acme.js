'use strict';

const log = require('npmlog');
const AcmeChallenge = require('../acme/acme-challenge');
const { getHostname, normalizeIp } = require('../tools');

module.exports = (db, server) => {
    const acmeChallenge = AcmeChallenge.create({ db: db.database });

    server.route({
        method: 'GET',
        url: '/.well-known/acme-challenge/:token',
        schema: {
            // the challenge route is not part of the documented API
            hide: true
        },
        config: {
            name: 'acmeToken',
            public: true,
            allowUnknown: true,
            validationObjs: {
                requestBody: {},
                queryParams: {},
                pathParams: {
                    token: { type: 'string', maxLength: 256, minLength: 1, wdEmpty: true, wdRequired: true }
                },
                response: {}
            }
        },
        async handler(req, reply) {
            const ip = normalizeIp(req.raw.socket.remoteAddress);
            const domain = getHostname(req);

            const token = req.params.token;

            let challenge;
            try {
                challenge = await acmeChallenge.get({
                    challenge: {
                        token,
                        identifier: { value: domain }
                    }
                });
            } catch (err) {
                log.error('ACME', `Error verifying challenge ${domain}: ${token} (${ip}, ${req.url}) ${err.message}`);

                let resErr = new Error(`Failed to verify authentication token`);
                resErr.responseCode = 500;
                throw resErr;
            }

            if (!challenge || !challenge.keyAuthorization) {
                log.error('ACME', `Unknown challenge ${domain}: ${token} (${ip}, ${req.url})`);

                let err = new Error(`Unknown challenge`);
                err.responseCode = 404;
                throw err;
            }

            return reply.code(200).header('Content-Type', 'text/plain').send(challenge.keyAuthorization);
        }
    });
};
