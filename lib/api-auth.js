'use strict';

const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const consts = require('./consts');

/**
 * Creates an authentication function for deferred token validation
 * @param {Object} config - The configuration object
 * @param {Object} db - The database object with redis connection
 * @param {Object} userHandler - The user handler instance
 * @returns {Function} Function that can authenticate a token
 */
function createAuthenticator(config, db, userHandler) {
    return async (accessToken) => {
        if (!accessToken) {
            return { authenticated: false, tokenRequired: false };
        }
        
        const result = await authenticateToken(accessToken, config, db, userHandler);
        return result;
    };
}

/**
 * Authenticates a token and returns user info
 * @param {String} accessToken - The access token to validate
 * @param {Object} config - The configuration object
 * @param {Object} db - The database object with redis connection
 * @param {Object} userHandler - The user handler instance
 * @returns {Promise<Object>} Authentication result with user, role, etc.
 */
async function authenticateToken(accessToken, config, db, userHandler) {
    let tokenRequired = false;
    let authenticated = false;
    let authData = {};

    // Check for hard coded master token
    if (config.api.accessToken) {
        tokenRequired = true;
        if (config.api.accessToken === accessToken) {
            authData.role = 'root';
            authData.user = 'root';
            authenticated = true;
            return { authenticated, tokenRequired, ...authData };
        }
    }

    // Check if access control is enabled
    if (config.api.accessControl.enabled || accessToken) {
        tokenRequired = true;
        
        if (accessToken && accessToken.length === 40 && /^[a-fA-F0-9]{40}$/.test(accessToken)) {
            let tokenData;
            let tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');

            try {
                let key = 'tn:token:' + tokenHash;
                tokenData = await db.redis.hgetall(key);
            } catch (err) {
                err.responseCode = 500;
                err.code = 'InternalDatabaseError';
                return { authenticated: false, tokenRequired, error: err };
            }

            if (tokenData && tokenData.user && tokenData.role && config.api.roles[tokenData.role]) {
                let signData;
                if ('authVersion' in tokenData) {
                    tokenData.authVersion = Number(tokenData.authVersion) || 0;
                    signData = {
                        token: accessToken,
                        user: tokenData.user,
                        authVersion: tokenData.authVersion,
                        role: tokenData.role
                    };
                } else {
                    signData = {
                        token: accessToken,
                        user: tokenData.user,
                        role: tokenData.role
                    };
                }

                let signature = crypto.createHmac('sha256', config.api.accessControl.secret).update(JSON.stringify(signData)).digest('hex');

                if (signature === tokenData.s) {
                    // Valid signature
                    if (tokenData.ttl && !isNaN(tokenData.ttl) && Number(tokenData.ttl) > 0) {
                        let tokenTTL = Number(tokenData.ttl);
                        let tokenLifetime = config.api.accessControl.tokenLifetime || consts.ACCESS_TOKEN_MAX_LIFETIME;

                        // Check if token is not too old
                        if ((Date.now() - Number(tokenData.created)) / 1000 < tokenLifetime) {
                            // Token is still usable, increase session length
                            try {
                                await db.redis
                                    .multi()
                                    .expire('tn:token:' + tokenHash, tokenTTL)
                                    .exec();
                            } catch (err) {
                                // ignore
                            }
                            
                            authData.role = tokenData.role;
                            authData.user = tokenData.user;

                            // Make a reference to original method
                            let setAuthToken = userHandler.setAuthToken.bind(userHandler);

                            authData.accessToken = {
                                hash: tokenHash,
                                user: tokenData.user,
                                update: async () => setAuthToken(tokenData.user, accessToken)
                            };
                            
                            authenticated = true;
                        } else {
                            // Expired token, clear it
                            try {
                                await db.redis
                                    .multi()
                                    .del('tn:token:' + tokenHash)
                                    .exec();
                            } catch (err) {
                                // ignore
                            }
                        }
                    } else {
                        // No TTL, token is valid
                        authData.role = tokenData.role;
                        authData.user = tokenData.user;
                        authenticated = true;
                    }

                    // Validate user auth version if needed
                    if (authenticated && /^[0-9a-f]{24}$/i.test(authData.user)) {
                        let tokenAuthVersion = Number(tokenData.authVersion) || 0;
                        let userData = await db.users.collection('users').findOne(
                            {
                                _id: new ObjectId(authData.user)
                            },
                            { projection: { authVersion: true } }
                        );
                        let userAuthVersion = Number(userData && userData.authVersion) || 0;
                        
                        if (!userData || tokenAuthVersion < userAuthVersion) {
                            // Unknown user or expired session
                            authenticated = false;
                            authData = {};
                        }
                    }
                }
            }
        }
    }

    return { authenticated, tokenRequired, ...authData };
}

/**
 * Authenticates a request using access token
 * @param {Object} req - The request object
 * @param {Object} config - The configuration object
 * @param {Object} db - The database object with redis connection
 * @param {Object} userHandler - The user handler instance
 * @returns {Promise<Object>} Authentication result
 */
async function authenticateRequest(req, config, db, userHandler) {
    // Extract access token from various sources
    let accessToken =
        req.query.accessToken ||
        req.headers['x-access-token'] ||
        (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '').trim() : false) ||
        false;

    // Clean up token from request
    if (req.query.accessToken) {
        delete req.query.accessToken;
    }
    if (req.params.accessToken) {
        delete req.params.accessToken;
    }
    if (req.headers['x-access-token']) {
        req.headers['x-access-token'] = '';
    }
    if (req.headers.authorization) {
        req.headers.authorization = '';
    }

    const result = await authenticateToken(accessToken, config, db, userHandler);
    
    // Apply authentication results to request
    if (result.authenticated) {
        req.role = result.role;
        req.user = result.user;
        if (result.accessToken) {
            req.accessToken = result.accessToken;
        }
        
        // Handle 'me' user parameter
        if (req.params && req.params.user === 'me' && /^[0-9a-f]{24}$/i.test(req.user)) {
            req.params.user = req.user;
        }
    }

    return result;
}

module.exports = { authenticateRequest, authenticateToken, createAuthenticator };