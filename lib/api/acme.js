'use strict';

const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const Joi = require('joi');
const AcmeChallenge = require('../acme/acme-challenge');
const { responseWrapper, validationErrors, getHostname, normalizeIp } = require('../tools');

module.exports = (db, server, routeOptions) => {
    routeOptions = routeOptions || {};

    const acmeChallenge = AcmeChallenge.create({ db: db.database });

    server.get(
        { name: 'acmeToken', path: '/.well-known/acme-challenge/:token', excludeRoute: true },
        responseWrapper(async (req, res) => {
            res.charSet('utf-8');

            const ip = normalizeIp(res.socket.remoteAddress);
            const domain = getHostname(req);

            const schema = Joi.object().keys({
                token: Joi.string().empty('').max(256).required()
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
                    details: validationErrors(result)
                });
            }

            const token = result.value.token;

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
