'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const AcmeChallenge = require('../acme/acme-challenge');
const { responseWrapper, getHostname, normalizeIp } = require('../tools');

module.exports = (db, server, routeOptions) => {
    routeOptions = routeOptions || {};

    const acmeChallenge = AcmeChallenge.create({ db: db.database });

    server.get(
        {
            name: 'acmeToken',
            path: '/.well-known/acme-challenge/:token',
            excludeRoute: true,
            jsonSchema: true,
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
        responseWrapper(async (req, res) => {
            const ip = normalizeIp(res.socket.remoteAddress);
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

            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain');
            res.send(challenge.keyAuthorization);
        })
    );

    if (!routeOptions.disableRedirect) {
        server.on('NotFound', (req, res, err, cb) => {
            let remoteAddress = ((req.socket || req.connection).remoteAddress || '').replace(/^::ffff:/, '');
            log.http('ACME', `${remoteAddress} ${req.method} ${req.url} 302 [redirect=${config.acme.agent.redirect}]`);
            res.redirect(302, config.acme.agent.redirect, cb);
        });
    }
};
