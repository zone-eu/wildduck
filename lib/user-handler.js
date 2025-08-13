'use strict';

const config = require('wild-config');
const log = require('npmlog');
const hashes = require('./hashes');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const tools = require('./tools');
const consts = require('./consts');
const counters = require('./counters');
const ObjectId = require('mongodb').ObjectId;
const generatePassword = require('generate-password');
const os = require('os');
const crypto = require('crypto');
const mailboxTranslations = require('./translations');
const MailComposer = require('nodemailer/lib/mail-composer');
const humanname = require('humanname');
const UserCache = require('./user-cache');
const isemail = require('isemail');
const util = require('util');
const TaskHandler = require('./task-handler');
const { SettingsHandler } = require('./settings-handler');
const { encrypt, decrypt } = require('./encrypt');
const { Fido2Lib } = require('fido2-lib');

const {
    publish,
    ASP_CREATED,
    ASP_DELETED,
    USER_CREATED,
    USER_DELETE_STARTED,
    MFA_TOTP_ENABLED,
    MFA_TOTP_DISABLED,
    MFA_CUSTOM_ENABLED,
    MFA_CUSTOM_DISABLED,
    MFA_FIDO_REGISTERED,
    MFA_FIDO_REMOVED,
    MFA_DISABLED,
    USER_ACTIVATED,
    USER_PASSWORD_CHANGED,
    USER_DELETE_CANCELLED
} = require('./events');

const TOTP_SETUP_TTL = 6 * 3600 * 1000;

class UserHandler {
    constructor(options) {
        this.database = options.database;
        this.users = options.users || options.database;
        this.redis = options.redis;

        this.loggelf = options.loggelf || (() => false);

        this.messageHandler = options.messageHandler;
        this.counters = this.messageHandler ? this.messageHandler.counters : counters(this.redis);

        this.settingsHandler = new SettingsHandler({ db: this.database });

        this.userCache = new UserCache({
            users: this.users,
            redis: this.redis,
            settingsHandler: this.settingsHandler
        });

        this.flushUserCache = util.promisify(this.userCache.flush.bind(this.userCache));

        this.taskHandler = new TaskHandler({ database: this.database });
    }

    resolveAddress(address, options, callback) {
        if (!callback) {
            return this.asyncResolveAddress(address, options);
        }
        this.asyncResolveAddress(address, options)
            .catch(err => callback(err))
            .then(result => callback(null, result));
    }

    async asyncResolveAddress(address, options) {
        options = options || {};
        let wildcard = !!options.wildcard;

        address = tools.normalizeAddress(address, false, {
            removeLabel: true,
            removeDots: true
        });

        let atPos = address.indexOf('@');
        let username = address.substr(0, atPos);
        let domain = address.substr(atPos + 1);

        let projection = {
            user: true,
            targets: true
        };

        Object.keys(options.projection || {}).forEach(key => {
            projection[key] = true;
        });

        if (options.projection === false) {
            // do not use projection
            projection = false;
        }

        try {
            let addressData;
            // try exact match
            addressData = await this.users.collection('addresses').findOne(
                {
                    addrview: username + '@' + domain
                },
                {
                    projection,
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );

            if (addressData) {
                return addressData;
            }

            // try an alias
            let aliasDomain;
            let aliasData = await this.users.collection('domainaliases').findOne(
                { alias: domain },
                {
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );

            if (aliasData) {
                aliasDomain = aliasData.domain;

                addressData = await this.users.collection('addresses').findOne(
                    {
                        addrview: username + '@' + aliasDomain
                    },
                    {
                        projection,
                        maxTimeMS: consts.DB_MAX_TIME_USERS
                    }
                );

                if (addressData) {
                    return addressData;
                }
            }

            if (!wildcard) {
                // wildcard not allowed, so there is nothing else to check for
                return false;
            }

            // Add addrview to projection as we will need it down further for
            // matching the right wildcard partial address.
            projection.addrview = true;
            let partialWildcards = tools.getWildcardAddresses(username, domain);

            let query = {
                addrview: { $in: partialWildcards }
            };

            let sortedDomainPartials = partialWildcards.map(addr => addr.replace(/^\*/, '')).sort((a, b) => b.length - a.length);
            let sortedAliasPartials = [];

            if (aliasDomain) {
                // search for alias domain as well
                let aliasWildcards = tools.getWildcardAddresses(username, aliasDomain);
                query.addrview.$in = query.addrview.$in.concat(aliasWildcards);
                sortedAliasPartials = aliasWildcards.map(addr => addr.replace(/^\*/, '')).sort((a, b) => a.length - b.length);
            }

            let sortedPartials = sortedDomainPartials.concat(sortedAliasPartials);

            // try to find a catch-all address while preferring the longest match
            let addressMatches = await this.users
                .collection('addresses')
                .find(query, {
                    projection,
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                })
                .toArray();

            if (addressMatches && addressMatches.length) {
                let matchingPartials = new WeakMap();

                addressMatches.forEach(addressData => {
                    let partialMatch = sortedPartials.find(partial => addressData.addrview.indexOf(partial) >= 0);
                    if (partialMatch) {
                        matchingPartials.set(addressData, sortedPartials.indexOf(partialMatch));
                    }
                });

                addressData = addressMatches.sort((a, b) => {
                    let aPos = matchingPartials.has(a) ? matchingPartials.get(a) : Infinity;
                    let bPos = matchingPartials.has(b) ? matchingPartials.get(b) : Infinity;
                    return aPos - bPos;
                })[0];
            }

            if (addressData) {
                return addressData;
            }

            // try to find a catch-all user (eg. "postmaster@*")
            addressData = await this.users.collection('addresses').findOne(
                {
                    addrview: username + '@*'
                },
                {
                    projection,
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );

            if (addressData) {
                return addressData;
            }
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        // no match was found
        // create addresss and user id required for this address
        if (options.create) {
            await this.create({
                username,
                address,
                password: '',
                temp: true
            });

            let addressData = await this.asyncResolveAddress(address, options);
            return addressData;
        }

        return false;
    }

    /**
     * Resolve user by username/address
     *
     * @param {String} username Either username or email address
     * @param {Object} [extraFields] Optional projection fields object
     */
    get(username, extraFields, callback) {
        if (!callback && typeof extraFields === 'function') {
            callback = extraFields;
            extraFields = false;
        }
        if (!callback) {
            return this.asyncGet(username, extraFields);
        }
        this.asyncGet(username, extraFields)
            .catch(err => callback(err))
            .then(result => callback(null, result));
    }

    async asyncGet(username, extraFields) {
        let fields = {
            _id: true,
            quota: true,
            storageUsed: true,
            disabled: true,
            suspended: true
        };

        Object.keys(extraFields || {}).forEach(field => {
            fields[field] = true;
        });

        let addressData;
        let query;
        if (tools.isId(username)) {
            query = { _id: new ObjectId(username) };
        } else if (username.indexOf('@') < 0) {
            // assume regular username
            query = { unameview: tools.uview(username) };
        } else {
            addressData = await this.asyncResolveAddress(username, { projection: { name: true } });

            if (addressData.user) {
                query = { _id: addressData.user };
            }
        }

        if (!query) {
            return false;
        }

        try {
            let userData = await this.users.collection('users').findOne(query, {
                projection: fields,
                maxTimeMS: consts.DB_MAX_TIME_USERS
            });

            if (userData && fields.name && addressData && addressData.name) {
                // override name
                userData.name = addressData.name;
            }

            return userData;
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }
    }

    /**
     * rateLimitIP
     * if ip is not available will always return success object
     * @param  {Object}   meta
     * @param  {String}   meta.ip  request remote ip address
     * @param  {Integer}  count
     */
    async rateLimitIP(meta, count) {
        if (!meta || !meta.ip || !consts.IP_AUTH_FAILURES) {
            return { success: true };
        }

        let wlKey = 'rl-wl';
        // $ redis-cli
        // > SADD "rl-wl" "1.2.3.4"
        try {
            let isMember = await this.redis.sismember(wlKey, meta.ip);
            if (isMember) {
                // whitelisted IP
                return { success: true };
            }
        } catch (err) {
            log.error('Redis', 'SMFAIL key=%s value=%s error=%s', wlKey, meta.ip, err.message);
            // ignore errors
            return { success: true };
        }

        return await this.counters.asyncTTLCounter('auth_ip:' + meta.ip, count, consts.IP_AUTH_FAILURES, consts.IP_AUTH_WINDOW);
    }

    /**
     * rateLimitUser
     * @param  {String}   tokenID  user identifier
     * @param  {Object}   meta
     * @param  {Integer}  count
     */
    async rateLimitUser(tokenID, meta, count) {
        if (meta && meta.ip) {
            // check if whitelisted IP
            let wlKey = 'rl-wl';
            // $ redis-cli
            // > SADD "rl-wl" "1.2.3.4"
            try {
                let isMember = await this.redis.sismember(wlKey, meta.ip);
                if (isMember) {
                    // whitelisted IP, allow authentication attempt without rate limits
                    return { success: true };
                }
            } catch (err) {
                log.error('Redis', 'SMFAIL key=%s value=%s error=%s', wlKey, meta.ip, err.message);
                // ignore errors
            }
        }
        return await this.counters.asyncTTLCounter('auth_user:' + tokenID, count, consts.USER_AUTH_FAILURES, consts.USER_AUTH_WINDOW);
    }

    /**
     * rateLimitReleaseUser
     * @param  {String}   tokenID  user identifier
     * @param  {Integer}  count
     */
    async rateLimitReleaseUser(tokenID) {
        await this.redis.del('auth_user:' + tokenID);
    }

    /**
     * rateLimit
     * @param  {String}   tokenID  user identifier
     * @param  {Object}   meta
     * @param  {String}   meta.ip  request remote ip address
     * @param  {Integer}  count
     */
    async rateLimit(tokenID, meta, count) {
        let ipRes = await this.rateLimitIP(meta, count);

        let userRes = await this.rateLimitUser(tokenID, meta, count);
        if (!ipRes.success) {
            return ipRes;
        }
        return userRes;
    }

    /**
     * Authenticate user
     *
     * @param {String} username Either username or email address
     * @param {String} password Password for authentication
     * @param {String} [requiredScope="master"] Which scope to use
     * @param {Object} [meta] Additional meta info
     * @param {String} [meta.ip] IP address of the client
     * @param {String} [meta.session] Session ID
     */
    authenticate(username, password, requiredScope, meta, callback) {
        if (!callback) {
            return this.asyncAuthenticate(username, password, requiredScope, meta);
        }
        this.asyncAuthenticate(username, password, requiredScope, meta)
            .then(result => {
                if (!Array.isArray(result)) {
                    result = [].concat(result || [false, false]);
                }
                callback(null, ...result);
            })
            .catch(err => callback(err));
    }

    async asyncAuthenticate(username, password, requiredScope, meta) {
        meta = meta || {};
        requiredScope = requiredScope || 'master';

        username = (username || '').toString();
        let userDomain = username.indexOf('@') >= 0 ? username.split('@').pop() : '';

        let now = new Date();

        let passwordType = 'master'; // try 'master' first and 'asp' later
        let passwordId;

        meta = meta || {};
        meta.requiredScope = requiredScope;

        if (!password) {
            // do not allow signing in without a password
            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                _error: 'Empty password',
                _auth_result: 'fail',
                _username: username,
                _domain: userDomain,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });
            return [false, false];
        }

        // first check if client IP is not used too much
        let rateLimitRes;
        try {
            rateLimitRes = await this.rateLimitIP(meta, 0);
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                full_message: err.stack,
                _error: err.message,
                _code: err.code,
                _auth_result: 'error',
                _username: username,
                _domain: userDomain,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });
            // return as failed auth
            return [false, false];
        }
        if (!rateLimitRes.success) {
            // too many failed attempts from this IP
            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                _error: 'Rate limited',
                _auth_result: 'ratelimited',
                _username: username,
                _domain: userDomain,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });
            throw rateLimitResponse(rateLimitRes);
        }

        let userQuery;
        try {
            userQuery = await this.checkAddress(username);
        } catch (err) {
            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                _error: 'Unknown user',
                _auth_result: 'unknown',
                _username: username,
                _domain: userDomain,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });
            return [false, false];
        }

        if (!userQuery) {
            // nothing to do here
            return [false, false];
        }

        let userData;
        try {
            userData = await this.users.collection('users').findOne(userQuery, {
                projection: {
                    _id: true,
                    username: true,
                    address: true,
                    tempPassword: true,
                    password: true,
                    enabled2fa: true,
                    webauthn: true,
                    disabled: true,
                    suspended: true,
                    disabledScopes: true
                },
                maxTimeMS: consts.DB_MAX_TIME_USERS
            });
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                full_message: err.stack,
                _error: err.message,
                _code: err.code,
                _auth_result: 'error',
                _username: username,
                _domain: userDomain,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });
            // return as failed auth
            return [false, false];
        }

        if (!userData) {
            // User was not found

            // rate limit failed authentication attempts against non-existent users as well
            try {
                let ustring = (userQuery.unameview || userQuery._id || '').toString();
                rateLimitRes = await this.rateLimit(ustring, meta, 1);
            } catch (err) {
                err.responseCode = 500;
                err.code = 'InternalDatabaseError';
                this.loggelf({
                    short_message: '[AUTHFAIL] ' + username,
                    full_message: err.stack,
                    _error: err.message,
                    _code: err.code,
                    _auth_result: 'error',
                    _username: username,
                    _domain: userDomain,
                    _scope: requiredScope,
                    _ip: meta.ip,
                    _sess: meta.sess
                });
            }

            if (!rateLimitRes.success) {
                // does not really matter but respond with a rate limit error, not auth fail error
                this.loggelf({
                    short_message: '[AUTHFAIL] ' + username,
                    _error: 'Rate limited',
                    _auth_result: 'ratelimited',
                    _username: username,
                    _domain: userDomain,
                    _scope: requiredScope,
                    _ip: meta.ip,
                    _sess: meta.sess
                });
                throw rateLimitResponse(rateLimitRes);
            }

            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                _error: 'Unknown user',
                _auth_result: 'unknown',
                _username: username,
                _domain: userDomain,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });

            // return as failed auth
            return [false, false];
        }

        // make sure we use the primary domain if available
        userDomain = (userData.address || '').split('@').pop() || userDomain;

        try {
            // check if there are not too many auth attempts for that user
            rateLimitRes = await this.rateLimitUser(userData._id, meta, 0);
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            err.user = userData._id;
            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                full_message: err.stack,
                _error: err.message,
                _code: err.code,
                _auth_result: 'error',
                _username: username,
                _domain: userDomain,
                _user: userData._id,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });
            throw err;
        }

        if (!rateLimitRes.success) {
            // too many failed attempts for this user
            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                _error: 'Rate limited',
                _auth_result: 'ratelimited',
                _username: username,
                _domain: userDomain,
                _user: userData._id,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });

            let err = rateLimitResponse(rateLimitRes);
            err.user = userData._id;
            throw err;
        }

        if (userData.disabled) {
            // disabled users can not log in
            meta.result = 'disabled';
            // TODO: should we send some specific error message?
            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                _error: 'User is disabled',
                _auth_result: 'disabled',
                _username: username,
                _domain: userDomain,
                _user: userData._id,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });
            await this.logAuthEvent(userData._id, meta);
            return [false, userData._id];
        }

        if (userData.suspended) {
            // disabled users can not log in
            meta.result = 'suspended';
            // TODO: should we send some specific error message?
            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                _error: 'User is suspended',
                _auth_result: 'suspended',
                _username: username,
                _domain: userDomain,
                _user: userData._id,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });
            await this.logAuthEvent(userData._id, meta);
            return [false, userData._id];
        }

        let disabledScopes = userData.disabledScopes || [];
        if (disabledScopes.includes(requiredScope)) {
            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                _error: 'Required scope is disabled',
                _auth_result: 'scope_disabled',
                _username: username,
                _domain: userDomain,
                _user: userData._id,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });
            await this.logAuthEvent(userData._id, meta);
            let err = new Error('Access to requested service disabled');
            err.response = 'NO';
            err.responseCode = 403;
            err.code = 'InvalidAuthScope';
            err.user = userData._id;
            throw err;
        }

        try {
            let authSuccess = async authResponse => {
                // clear rate limit counter on success
                try {
                    await this.rateLimitReleaseUser(userData._id);
                } catch (err) {
                    //ignore
                }

                this.loggelf({
                    short_message: '[AUTHOK] ' + username,
                    _mail_action: 'auth',
                    _auth_result: 'success',
                    _username: username,
                    _domain: userDomain,
                    _user: userData._id,
                    _password_type: passwordType,
                    _password_id: passwordId,
                    _scope: requiredScope,
                    _ip: meta.ip,
                    _sess: meta.sess
                });

                return [authResponse, userData._id];
            };

            let enabled2fa = tools.getEnabled2fa(userData.enabled2fa);
            let requirePasswordChange = false;
            let usingTemporaryPassword = false;

            let success;
            if (userData.tempPassword && userData.tempPassword.created > new Date(now.getTime() - consts.TEMP_PASS_WINDOW)) {
                // try temporary password first

                try {
                    success = await hashes.compare(password, userData.tempPassword.password);
                } catch (err) {
                    err.responseCode = 500;
                    err.code = 'HashError';
                    throw err;
                }
                if (success) {
                    if (userData.tempPassword.validAfter && userData.tempPassword.validAfter > now) {
                        let err = new Error('Temporary password is not yet activated');
                        err.responseCode = 403;
                        err.code = 'TempPasswordNotYetValid';
                        throw err;
                    }

                    requirePasswordChange = true;
                    usingTemporaryPassword = true;
                }
            }

            if (!success && userData.password) {
                try {
                    // temporary password did not match, try actual password
                    success = await hashes.compare(password, userData.password);
                } catch (err) {
                    err.responseCode = 500;
                    err.code = 'HashError';
                    throw err;
                }
            }

            if (success) {
                // master password matched

                meta.result = 'success';
                meta.source = !usingTemporaryPassword ? 'master' : 'temporary';

                if (enabled2fa.length) {
                    meta.require2fa = enabled2fa.length ? enabled2fa.join(',') : false;
                }

                if (hashes.shouldRehash(userData.password)) {
                    // master password needs rehashing
                    let { algo } = hashes.checkHashSupport(userData.password);

                    let hash;
                    try {
                        hash = await hashes.hash(password);
                        if (!hash) {
                            // should this even happen???
                            throw new Error('Failed to rehash password');
                        }

                        try {
                            let r = await this.users.collection('users').updateOne(
                                {
                                    _id: userData._id
                                },
                                {
                                    $set: {
                                        password: hash
                                    }
                                },
                                { writeConcern: 'majority' }
                            );

                            if (r.modifiedCount) {
                                log.info('DB', 'REHASHED user=%s algo_from=%s algo_to=%s', userData._id, algo, consts.DEFAULT_HASH_ALGO);

                                this.loggelf({
                                    short_message: '[REHASH] ' + username,
                                    _mail_action: 'rehash',
                                    _username: username,
                                    _domain: userDomain,
                                    _user: userData._id,
                                    _password_type: passwordType,
                                    _password_id: passwordId,
                                    _scope: requiredScope,
                                    _algo_from: algo,
                                    _algo_to: consts.DEFAULT_HASH_ALGO,
                                    _ip: meta.ip,
                                    _sess: meta.sess
                                });
                            }
                        } catch (err) {
                            log.error('DB', 'DBFAIL rehash user=%s error=%s', userData._id, err.message);
                        }
                    } catch (err) {
                        log.error('DB', 'HASHFAIL rehash user=%s algo_from=%s algo_to=%s error=%s', userData._id, algo, consts.DEFAULT_HASH_ALGO, err.message);
                        // ignore DB error, rehash some other time
                    }
                }

                if (requiredScope !== 'master' && (enabled2fa.length || usingTemporaryPassword)) {
                    // master password can not be used for other scopes than 'master' if 2FA is enabled
                    // temporary password is also only valid for master
                    meta.result = 'fail';
                    await this.logAuthEvent(userData._id, meta);

                    let err = new Error('Authentication failed. Invalid scope');
                    err.responseCode = 403;
                    err.code = 'InvalidAuthScope';
                    err.response = 'NO'; // imap response code
                    throw err;
                }

                try {
                    let authEvent = await this.logAuthEvent(userData._id, meta);
                    await this.users.collection('users').updateOne(
                        {
                            _id: userData._id
                        },
                        {
                            $set: {
                                lastLogin: {
                                    time: now,
                                    authEvent,
                                    ip: meta.ip
                                }
                            }
                        },
                        {
                            maxTimeMS: consts.DB_MAX_TIME_USERS
                        }
                    );
                } catch (err) {
                    // ignore
                }

                let authResponse = {
                    user: userData._id,
                    username: userData.username,
                    scope: meta.requiredScope,
                    address: userData.address,
                    // if 2FA is enabled then require token validation
                    require2fa: enabled2fa.length && !usingTemporaryPassword ? enabled2fa : false,
                    requirePasswordChange // true, if password was reset and using temporary password
                };

                if (enabled2fa.length && !usingTemporaryPassword) {
                    authResponse.enabled2fa = enabled2fa;
                }

                return await authSuccess(authResponse);
            }

            if (requiredScope === 'master') {
                // only master password can be used for management tasks
                meta.result = 'fail';
                meta.source = 'master';
                await this.logAuthEvent(userData._id, meta);

                let err = new Error('Invalid Auth');
                err.responseCode = 403;
                err.code = 'AuthFail'; // will be returned as failed auth, not an error
                throw err;
            }

            // try application specific passwords
            password = password.replace(/\s+/g, '').toLowerCase();

            if (!/^[a-z]{16}$/.test(password)) {
                // does not look like an application specific password
                meta.result = 'fail';
                meta.source = 'master';
                await this.logAuthEvent(userData._id, meta);

                let err = new Error('Invalid Auth');
                err.responseCode = 403;
                err.code = 'AuthFail'; // will be returned as failed auth, not an error
                throw err;
            }

            let selector = getStringSelector(password);

            let asps;
            try {
                asps = await this.users
                    .collection('asps')
                    .find({
                        user: userData._id
                    })
                    .maxTimeMS(consts.DB_MAX_TIME_USERS)
                    .toArray();
            } catch (err) {
                err.responseCode = 500;
                err.code = 'InternalDatabaseError';
                throw err;
            }

            if (!asps || !asps.length) {
                // user does not have app specific passwords set
                meta.result = 'fail';
                meta.source = 'master';
                await this.logAuthEvent(userData._id, meta);

                let err = new Error('Invalid Auth');
                err.responseCode = 403;
                err.code = 'AuthFail'; // will be returned as failed auth, not an error
                throw err;
            }

            for (let asp of asps) {
                if (asp.selector && asp.selector !== selector) {
                    // no need to check, definitely a wrong one
                    continue;
                }

                let success;
                try {
                    success = await hashes.compare(password, asp.password);
                } catch (err) {
                    err.responseCode = 500;
                    err.code = 'HashError';
                    throw err;
                }

                if (!success) {
                    continue;
                }

                // Found a matching Application Specific Password

                meta.source = 'asp';
                meta.asp = asp._id;
                // store ASP name in case the ASP gets deleted and for faster listing
                meta.aname = asp.description;

                passwordType = 'asp';
                passwordId = asp._id.toString();

                // Check if passwords scope matches required scope
                if (!asp.scopes.includes('*') && !asp.scopes.includes(requiredScope)) {
                    meta.result = 'fail';

                    await this.logAuthEvent(userData._id, meta);

                    let err = new Error('Authentication failed. Invalid scope');
                    err.responseCode = 403;
                    err.code = 'InvalidAuthScope';
                    err.response = 'NO'; // imap response code
                    throw err;
                }

                // Everything checked out

                meta.result = 'success';

                let authEvent;
                try {
                    authEvent = await this.logAuthEvent(userData._id, meta);
                } catch (err) {
                    // don't really care
                }

                let aspUpdates = {
                    used: now,
                    authEvent,
                    authIp: meta.ip
                };

                if (asp.ttl) {
                    // extend temporary password ttl every time it is used
                    aspUpdates.expires = new Date(now.getTime() + asp.ttl * 1000);
                }

                try {
                    await this.users.collection('asps').updateOne(
                        {
                            _id: asp._id
                        },
                        {
                            $set: aspUpdates
                        },
                        {
                            maxTimeMS: consts.DB_MAX_TIME_USERS
                        }
                    );
                } catch (err) {
                    // ignore
                }

                return await authSuccess({
                    user: userData._id,
                    username: userData.username,
                    scope: requiredScope,
                    asp: asp._id.toString(),
                    require2fa: false // application scope never requires 2FA
                });
            }

            // no suitable password found
            meta.result = 'fail';
            meta.source = 'master';
            await this.logAuthEvent(userData._id, meta);

            let err = new Error('Invalid Auth');
            err.responseCode = 403;
            err.code = 'AuthFail'; // will be returned as failed auth, not an error
            throw err;
        } catch (err) {
            this.loggelf({
                short_message: '[AUTHFAIL] ' + username,
                full_message: err.stack,
                _error: err.message || 'Authentication failed',
                _code: err.code,
                _auth_result: 'fail',
                _username: username,
                _domain: userDomain,
                _user: userData._id,
                _password_type: passwordType,
                _password_id: passwordId,
                _scope: requiredScope,
                _ip: meta.ip,
                _sess: meta.sess
            });

            // increment rate limit counter on failure
            await this.rateLimit(userData._id, meta, 1);

            if (err.code !== 'AuthFail') {
                err.user = userData._id;
                throw err;
            }

            return [false, userData._id];
        }
    }

    async preAuth(username, requiredScope) {
        requiredScope = requiredScope || 'master';

        username = (username || '').toString();

        let userQuery;
        try {
            userQuery = await this.checkAddress(username);
        } catch (err) {
            return [false, false];
        }

        if (!userQuery) {
            // nothing to do here
            return [false, false];
        }

        let userData;
        try {
            userData = await this.users.collection('users').findOne(userQuery, {
                projection: {
                    _id: true,
                    username: true,
                    address: true,
                    enabled2fa: true,
                    webauthn: true,
                    disabled: true,
                    suspended: true,
                    disabledScopes: true
                },
                maxTimeMS: consts.DB_MAX_TIME_USERS
            });
        } catch (err) {
            // return as failed auth
            return [false, false];
        }

        if (!userData || userData.disabled || userData.suspended) {
            // return as failed auth
            return [false, false];
        }

        let disabledScopes = userData.disabledScopes || [];
        if (disabledScopes.includes(requiredScope)) {
            let err = new Error('Access to requested service disabled');
            err.response = 'NO';
            err.responseCode = 403;
            err.code = 'InvalidAuthScope';
            err.user = userData._id;
            throw err;
        }

        let enabled2fa = tools.getEnabled2fa(userData.enabled2fa);

        let authResponse = {
            user: userData._id,
            username: userData.username,
            address: userData.address,
            scope: requiredScope,
            // if 2FA is enabled then require token validation
            require2fa: requiredScope === 'master' && enabled2fa.length ? enabled2fa : false
        };

        return [authResponse, userData._id];
    }

    async generateASP(user, data) {
        let password =
            data.password ||
            generatePassword.generate({
                length: 16,
                uppercase: false,
                numbers: false,
                symbols: false
            });
        // We need a quick hash key that can be used to identify the password.
        // Otherwise, when authenticating, we'd need to check the password against all stored bcrypt
        // hashes which would make forever if the user has a longer list of application specific passwords
        let selector = getStringSelector(password);

        let allowedScopes = [...consts.SCOPES];
        let hasAllScopes = false;
        let scopeSet = new Set();
        let scopes = [].concat(data.scopes || []);

        scopes.forEach(scope => {
            scope = scope.toLowerCase().trim();
            if (scope === '*') {
                hasAllScopes = true;
            } else if (allowedScopes.includes(scope)) {
                scopeSet.add(scope);
            }
        });

        if (hasAllScopes || scopeSet.size === allowedScopes.length) {
            scopes = ['*'];
        } else {
            scopes = Array.from(scopeSet).sort((a, b) => a.localeCompare(b));
        }

        let hash;
        try {
            hash = await hashes.hash(password);
        } catch (err) {
            log.error('DB', 'HASHFAIL generateASP id=%s error=%s', user, err.message);
            err.responseCode = 500;
            err.code = 'HashError';
            throw err;
        }

        let aspData = {
            _id: new ObjectId(),
            user,
            description: data.description,
            scopes,
            password: hash,
            selector,
            used: false,
            authEvent: false,
            authIp: false,
            created: new Date()
        };

        if (data.ttl) {
            aspData.ttl = data.ttl;
            aspData.expires = new Date(Date.now() + data.ttl * 1000);
        }

        try {
            let userData = await this.users.collection('users').findOne(
                {
                    _id: user
                },
                {
                    projection: {
                        _id: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
            if (!userData) {
                let err = new Error('Could not find user data');
                err.responseCode = 404;
                err.code = 'UserNotFound';
                throw err;
            }
        } catch (err) {
            log.error('DB', 'DBFAIL generateASP id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to find user';
            err.responseCode = 404;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        let existingASPCount;

        try {
            existingASPCount = await this.users.collection('asps').countDocuments({ user });
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        let maxASPCount = await this.settingsHandler.get('const:asp:limit');
        if (existingASPCount >= maxASPCount) {
            let err = new Error('Maximum application password limit reached');
            err.responseCode = 403;
            err.code = 'TooMany';
            err.details = {
                allowed: maxASPCount
            };
            throw err;
        }

        try {
            await this.users.collection('asps').insertOne(aspData);
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        await this.logAuthEvent(user, {
            action: 'create asp',
            asp: aspData._id,
            aname: aspData.description,
            temporary: aspData.ttl ? true : false,
            result: 'success',
            sess: data.sess,
            ip: data.ip
        });

        await publish(this.redis, {
            ev: ASP_CREATED,
            user,
            asp: aspData._id,
            description: aspData.description
        });

        return {
            id: aspData._id.toString(),
            password
        };
    }

    async deleteASP(user, asp, data) {
        asp = new ObjectId(asp);

        let aspData;
        try {
            aspData = await this.users.collection('asps').findOne(
                {
                    _id: asp,
                    user
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!aspData) {
            let err = new Error('Application Specific Password was not found');
            err.responseCode = 404;
            err.code = 'AspNotFound';
            throw err;
        }

        let r;
        try {
            r = await this.users.collection('asps').deleteOne({ _id: asp });
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (r.deletedCount) {
            try {
                await this.logAuthEvent(user, {
                    action: 'delete asp',
                    asp: asp._id,
                    aname: asp.description,
                    result: 'success',
                    sess: data.sess,
                    ip: data.ip
                });
            } catch (err) {
                // ignore
            }

            await publish(this.redis, {
                ev: ASP_DELETED,
                user,
                asp: asp._id,
                description: aspData.description
            });
        }
        return true;
    }

    /**
     * Activate temporary user
     * @param {ObjectId} userId User ID
     * @param {Object} data User data
     * @return {Object} user
     **/
    async activateTemp(userId, data) {
        try {
            let hash;
            if (!data.password) {
                // Users with an empty password can not log in
                hash = '';
                throw new Error('Password is required');
            }
            try {
                if (data.hashedPassword) {
                    // try if the hashing library can handle it?
                    let algo = hashes.checkHashSupport(data.password);
                    if (algo.result) {
                        hash = data.password;
                    } else {
                        throw new Error('Invalid algo: ' + JSON.stringify(algo.algo));
                    }
                } else {
                    hash = await hashes.hash(data.password);
                }
            } catch (err) {
                log.error('DB', 'HASHFAIL user.create id=%s error=%s', data.username, err.message);
                err.responseCode = 500;
                err.code = 'HashError';
                throw err;
            }
            let updates = {
                name: data.name,
                password: hash,
                temp: false
            };

            let result = await this.users.collection('users').findOneAndUpdate(
                {
                    _id: userId,
                    temp: true
                },
                {
                    $set: updates
                },
                {
                    returnDocument: 'after',
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );

            return result.value;
        } catch (error) {
            log.error('DB', 'Activate Fail user=%s error=%s', user, error);
            error.responseCode = 500;
            throw error;
        }
    }

    async create(data) {
        // check if username is not already taken
        let existingUserData;
        try {
            existingUserData = await this.users.collection('users').findOne(
                {
                    username: data.username.replace(/\./g, '')
                },
                {
                    projection: {
            temp: true,
                        unameview: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'CREATEFAIL username=%s error=%s', data.username, err.message);
            err.message = 'Database Error, failed to create user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (existingUserData && !existingUserData.temp) {
            let err = new Error('This username already exists');
            err.responseCode = 400;
            err.code = 'UserExistsError';
            throw err;
        }

        if (existingUserData && existingUserData.temp) {
            const userData = await this.activateTemp(existingUserData._id, data);
            try {
                await this.logAuthEvent(user, {
                    action: 'account activated',
                    result: 'success',
                    sess: data.sess,
                    ip: data.ip
                });
            } catch (err) {
                // ignore
            }

            await publish(this.redis, {
                ev: USER_ACTIVATED,
                user: userData._id,
                username: userData.username,
                name: userData.name,
                address: userData.address
            });

            return userData._id;
        }

        let address = data.address && !data.emptyAddress ? data.address : '';
        let addrview;

        if (!data.emptyAddress) {
            if (!address) {
                try {
                    if (isemail.validate(data.username)) {
                        address = data.username;
                    }
                } catch (E) {
                    // ignore
                }

                if (!address) {
                    address = data.username.split('@').shift() + '@' + (config.emailDomain || os.hostname()).toLowerCase();
                }
            }
            address = tools.normalizeAddress(address, false, { removeLabel: true });
            addrview = tools.uview(address);
        }

        let allowedScopes = [...consts.SCOPES];
        let scopeSet = new Set();
        let disabledScopes = [].concat(data.disabledScopes || []);
        disabledScopes.forEach(scope => {
            scope = scope.toLowerCase().trim();
            if (allowedScopes.includes(scope)) {
                scopeSet.add(scope);
            }
        });
        disabledScopes = Array.from(scopeSet).sort((a, b) => a.localeCompare(b));

        if (addrview) {
            // check if address is not already taken
            let existingAddressData;
            try {
                existingAddressData = await this.users.collection('addresses').findOne(
                    {
                        addrview
                    },
                    {
                        projection: {
                            _id: true
                        },
                        maxTimeMS: consts.DB_MAX_TIME_USERS
                    }
                );
            } catch (err) {
                log.error('DB', 'CREATEFAIL username=%s address=%s error=%s', data.username, address, err.message);
                err.message = 'Database Error, failed to create user';
                err.responseCode = 500;
                err.code = 'InternalDatabaseError';
                throw err;
            }
            if (existingAddressData) {
                let err = new Error('This address already exists');
                err.responseCode = 400;
                err.code = 'AddressExistsError';
                throw err;
            }
        }

        let junkRetention = consts.JUNK_RETENTION;

        // Insert user data

        let hash;
        if (!data.password) {
            // Users with an empty password can not log in
            hash = '';
        } else {
            try {
                if (data.hashedPassword) {
                    // try if the hashing library can handle it?
                    let algo = hashes.checkHashSupport(data.password);
                    if (algo.result) {
                        hash = data.password;
                    } else {
                        throw new Error('Invalid algo: ' + JSON.stringify(algo.algo));
                    }
                } else {
                    hash = await hashes.hash(data.password);
                }
            } catch (err) {
                log.error('DB', 'HASHFAIL user.create id=%s error=%s', data.username, err.message);
                err.responseCode = 500;
                err.code = 'HashError';
                throw err;
            }
        }

        // spamLevel is from 0 (everything is spam) to 100 (accept everything)
        let spamLevel = 'spamLevel' in data && !isNaN(data.spamLevel) ? Number(data.spamLevel) : 50;
        if (spamLevel < 0) {
            spamLevel = 0;
        }
        if (spamLevel > 100) {
            spamLevel = 100;
        }

        let userData = {
            username: data.username,
            // dotless version
            unameview: tools.uview(data.username),

            name: data.name,

            // security
            password: '', // set this later. having no password prevents login

            enabled2fa: [],
            seed: '', // 2fa seed value
            pendingSeed: '',
            pendingSeedChanged: false,
            webauthn: { credentials: [] },

            // incremented every time password is changed
            authVersion: 1,

            // default email address
            address: '', // set this later

            language: data.language,

            // quota
            storageUsed: 0,
            quota: data.quota || 0,

            recipients: data.recipients || 0,
            forwards: data.forwards || 0,

            filters: data.filters || 0,

            imapMaxUpload: data.imapMaxUpload || 0,
            imapMaxDownload: data.imapMaxDownload || 0,
            pop3MaxDownload: data.pop3MaxDownload || 0,
            pop3MaxMessages: data.pop3MaxMessages || 0,
            imapMaxConnections: data.imapMaxConnections || 0,

            receivedMax: data.receivedMax || 0,

            targets: [].concat(data.targets || []).filter(target => target),

            // autoreply status
            // off by default, can be changed later by user through the API
            autoreply: false,

            uploadSentMessages: !!data.uploadSentMessages,
            pubKey: data.pubKey || '',
            encryptMessages: !!data.encryptMessages,
            encryptForwarded: !!data.encryptForwarded,

            spamLevel,

            // default retention for user mailboxes
            retention: data.retention || 0,

            disabledScopes,

            lastLogin: {
                time: false,
                authEvent: false,
                ip: false
            },

            metaData: data.metaData || '',
            internalData: data.internalData || '',

            // until setup value is not true, this account is not usable
            activated: false,
            disabled: true,
            suspended: false,
            temp: data.temp ?? false,

            featureFlags: data.featureFlags || {},

            created: new Date()
        };

        if (data.tags && data.tags.length) {
            userData.tags = data.tags;
            userData.tagsview = data.tagsview;
        }

        if (data.fromWhitelist && data.fromWhitelist.length) {
            userData.fromWhitelist = data.fromWhitelist;
        }

        let user;
        try {
            let r = await this.users.collection('users').insertOne(userData, { writeConcern: 'majority' });
            if (r.insertedId) {
                user = userData._id = r.insertedId;
            } else {
                throw new Error('Failed to insert data');
            }
        } catch (err) {
            log.error('DB', 'CREATEFAIL username=%s error=%s', data.username, err.message);

            let response;
            switch (err.code) {
                case 11000:
                    response = 'Selected user already exists';
                    err.responseCode = 400;
                    err.code = 'UserExistsError';
                    break;
                default:
                    response = 'Database Error, failed to create user';
                    err.responseCode = 500;
                    err.code = 'InternalDatabaseError';
            }

            err.message = response;
            throw err;
        }

        let mailboxes = this.getMailboxes(data.language, data.mailboxes).map(mailbox => {
            mailbox.user = user;

            if (['\\Trash', '\\Junk'].includes(mailbox.specialUse)) {
                mailbox.retention = data.retention ? Math.min(data.retention, junkRetention) : junkRetention;
            } else {
                mailbox.retention = data.retention;
            }

            return mailbox;
        });

        try {
            await this.database.collection('mailboxes').insertMany(mailboxes, {
                writeConcern: 'majority',
                ordered: false
            });
        } catch (err) {
            try {
                // try to rollback
                await this.users.collection('users').deleteOne({ _id: user });
            } catch (err) {
                // ignore?
            }

            log.error('DB', 'CREATEFAIL username=%s error=%s', data.username, err.message);
            err.message = 'Database Error, failed to create user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!data.emptyAddress) {
            let addressData = {
                user,
                address,
                // dotless version
                addrview,
                created: new Date()
            };

            if (data.tags && data.tags.length && data.addTagsToAddress) {
                addressData.tags = data.tags;
                addressData.tagsview = data.tagsview;
            }

            try {
                // insert alias address to email address registry
                await this.users.collection('addresses').insertOne(addressData, { writeConcern: 'majority' });
            } catch (err) {
                try {
                    // try to rollback
                    await this.users.collection('users').deleteOne({ _id: user });
                    await this.database.collection('mailboxes').deleteMany({ user });
                } catch (err) {
                    // ignore?
                }

                log.error('DB', 'CREATEFAIL username=%s error=%s', data.username, err.message);

                let response;
                switch (err.code) {
                    case 11000:
                        response = 'Selected email address already exists';
                        err.responseCode = 400;
                        err.code = 'AddressExistsError';
                        break;
                    default:
                        response = 'Database Error, failed to create user';
                        err.responseCode = 500;
                        err.code = 'InternalDatabaseError';
                }

                err.message = response;
                throw err;
            }
        }

        let updates = {
            address,
            activated: true,
            disabled: false
        };

        if (data.requirePasswordChange) {
            updates.tempPassword = {
                validAfter: new Date(),
                password: hash,
                created: new Date()
            };
        } else {
            updates.password = hash;
        }

        try {
            // register this address as the default address for that user
            let result = await this.users.collection('users').findOneAndUpdate(
                {
                    _id: user,
                    activated: false
                },
                {
                    $set: updates
                },
                {
                    returnDocument: 'after',
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
            // use updated user data
            userData = result.value;
        } catch (err) {
            // try to rollback
            try {
                await this.users.collection('users').deleteOne({ _id: user });
                await this.database.collection('mailboxes').deleteMany({ user });
                await this.users.collection('addresses').deleteOne({ user });
            } catch (err) {
                // ignore?
            }

            log.error('DB', 'CREATEFAIL username=%s error=%s', data.username, err.message);
            err.message = 'Database Error, failed to create user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (this.messageHandler && !data.emptyAddress) {
            try {
                let parsedName = humanname.parse(userData.name || '');
                await this.pushDefaultMessages(userData, {
                    NAME: userData.name || userData.username || address,
                    FNAME: parsedName.firstName,
                    LNAME: parsedName.lastName,
                    DOMAIN: address.substr(address.indexOf('@') + 1),
                    EMAIL: address
                });
            } catch (err) {
                log.error('DB', 'PARSEFAIL name=%s error=%s', userData.name, err.message);
                // ignore?
            }
        }

        if (data.featureFlags && Object.keys(data.featureFlags).length) {
            let req = this.redis.multi();
            for (let featureFlag of Object.keys(data.featureFlags)) {
                if (data.featureFlags[featureFlag]) {
                    req = req.sadd(`feature:${featureFlag}`, user.toString());
                }
            }
            try {
                await req.exec();
            } catch (err) {
                log.error('Redis', 'FEATUREFAIL failed to set feature flags id=%s error=%s', user, err.message);
            }
        }

        try {
            await this.logAuthEvent(user, {
                action: 'account created',
                result: 'success',
                sess: data.sess,
                ip: data.ip
            });
        } catch (err) {
            // ignore
        }

        await publish(this.redis, {
            ev: USER_CREATED,
            user: userData._id,
            username: userData.username,
            name: userData.name,
            address: userData.address
        });

        return userData._id;
    }

    // TODO: reset all existing user sessions
    async reset(user, data) {
        let password = generatePassword.generate({
            length: 12,
            uppercase: true,
            numbers: true,
            symbols: false
        });

        let hash;
        try {
            hash = await hashes.hash(password);
        } catch (err) {
            log.error('DB', 'HASHFAIL user.reset id=%s error=%s', user, err.message);
            err.responseCode = 500;
            err.code = 'HashError';
            throw err;
        }

        let result;
        try {
            result = await this.users.collection('users').updateOne(
                {
                    _id: user
                },
                {
                    $set: {
                        tempPassword: {
                            validAfter: data.validAfter || new Date(),
                            password: hash,
                            created: new Date()
                        }
                    }
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to reset user credentials';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!result || !result.matchedCount) {
            let err = new Error('Could not update user ' + user);
            err.responseCode = 500;
            err.code = 'UserUpdateFail';
            throw err;
        }

        try {
            await this.logAuthEvent(user, {
                action: 'reset',
                sess: data.sess,
                ip: data.ip
            });
        } catch (err) {
            // ignore?
        }

        return password;
    }

    async setupTotp(user, data) {
        let userData;
        try {
            userData = await this.users.collection('users').findOne(
                {
                    _id: user
                },
                {
                    projection: {
                        username: true,
                        enabled2fa: true,
                        seed: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to check user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!userData) {
            let err = new Error('Could not find user data');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        let enabled2fa = tools.getEnabled2fa(userData.enabled2fa);
        if (enabled2fa.includes('totp')) {
            let err = new Error('TOTP 2FA is already enabled for this user');
            err.responseCode = 400;
            err.code = 'TotpEnabled';
            throw err;
        }

        let secret = speakeasy.generateSecret({
            length: 20,
            name: userData.username
        });

        let seed = secret.base32;
        if (config.totp && config.totp.secret) {
            try {
                seed = await encrypt(seed, config.totp.secret);
            } catch (E) {
                log.error('DB', 'TOTPFAIL cipher failed id=%s error=%s', user, E.message);
                let err = new Error('Database Error, failed to update user');
                err.responseCode = 500;
                err.code = 'InternalDatabaseError';
                throw err;
            }
        }

        let result;
        try {
            result = await this.users.collection('users').updateOne(
                {
                    _id: user,
                    enabled2fa: { $not: { $eq: 'totp' } }
                },
                {
                    $set: {
                        pendingSeed: seed,
                        pendingSeedChanged: new Date()
                    }
                },
                { maxTimeMS: consts.DB_MAX_TIME_USERS }
            );
        } catch (err) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to update user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }
        if (!result || !result.matchedCount) {
            let err = new Error('Could not update user, check if 2FA is not already enabled');
            err.responseCode = 400;
            err.code = 'TotpEnabled';
            throw err;
        }

        let otpauth_url = speakeasy.otpauthURL({
            secret: secret.ascii,
            // label is part of URL and speakeasy as of v2.0.0 does not encode special characters
            label: encodeURIComponent(data.label || userData.username),
            issuer: data.issuer || 'WildDuck'
        });

        try {
            let dataUrl = await QRCode.toDataURL(otpauth_url);
            return {
                secret: secret.base32,
                dataUrl
            };
        } catch (err) {
            log.error('DB', 'QRFAIL id=%s error=%s', user, err.message);
            err.message = 'Failed to generate QR code';
            err.responseCode = 500;
            err.code = 'QRError';
            throw err;
        }
    }

    async enableTotp(user, data) {
        let userData;
        try {
            userData = await this.users.collection('users').findOne(
                {
                    _id: user
                },
                {
                    projection: {
                        enabled2fa: true,
                        username: true,
                        pendingSeed: true,
                        pendingSeedChanged: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'LOADFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to fetch user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }
        if (!userData) {
            let err = new Error('This username does not exist');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        let enabled2fa = tools.getEnabled2fa(userData.enabled2fa);
        let disabled2fa = !enabled2fa.length;

        if (enabled2fa.includes('totp')) {
            // 2fa not set up
            let err = new Error('TOTP 2FA is already enabled for this user');
            err.responseCode = 400;
            err.code = 'TotpEnabled';
            throw err;
        }

        if (!userData.pendingSeed || (userData.pendingSeedChanged && userData.pendingSeedChanged < new Date(Date.now() - TOTP_SETUP_TTL))) {
            // 2fa not set up
            let err = new Error('TOTP 2FA is not initialized for this user');
            err.responseCode = 400;
            err.code = 'TotpDisabled';
            throw err;
        }

        let secret = userData.pendingSeed;
        if (config.totp && config.totp.secret) {
            try {
                secret = await decrypt(secret, config.totp.secret, config.totp.cipher);
            } catch (E) {
                log.error('DB', 'TOTPFAIL decipher failed id=%s error=%s', user, E.message);
                let err = new Error('Can not use decrypted secret');
                err.responseCode = 500;
                err.code = 'InternalConfigError';
                throw err;
            }
        }

        let verified = speakeasy.totp.verify({
            secret,
            encoding: 'base32',
            token: data.token,
            window: consts.TOTP_WINDOW_SIZE
        });

        if (!verified) {
            try {
                await this.logAuthEvent(user, {
                    action: 'enable 2fa totp',
                    result: 'fail',
                    sess: data.sess,
                    ip: data.ip
                });
            } catch (err) {
                // ignore
            }
            return false;
        }

        let updateQuery = {
            $set: {
                seed: userData.pendingSeed,
                pendingSeed: '',
                pendingSeedChanged: false
            },
            $addToSet: {
                enabled2fa: 'totp'
            }
        };

        if (disabled2fa) {
            if (!updateQuery.$inc) {
                updateQuery.$inc = {};
            }
            updateQuery.$inc.authVersion = 1;
        }

        // token was valid, update user settings
        let result;
        try {
            result = await this.users.collection('users').updateOne(
                {
                    _id: user,
                    pendingSeed: userData.pendingSeed
                },
                updateQuery,
                { maxTimeMS: consts.DB_MAX_TIME_USERS }
            );
        } catch (err) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to update user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!result || !result.matchedCount) {
            let err = new Error('Failed to set up 2FA. Check if it is not already enabled');
            err.responseCode = 400;
            err.code = 'TotpEnabled';
            throw err;
        }

        if (disabled2fa) {
            // 2fa was previously disabled, log out other sessions
            await this.logout(user, 'Authentication required');
        }

        try {
            await this.logAuthEvent(user, {
                action: 'enable 2fa totp',
                result: 'success',
                sess: data.sess,
                ip: data.ip
            });
        } catch (err) {
            // ignore
        }

        await publish(this.redis, {
            ev: MFA_TOTP_ENABLED,
            user: userData._id
        });

        return { success: true, disabled2fa };
    }

    async disableTotp(user, data) {
        let userData;
        try {
            userData = await this.users.collection('users').findOne(
                {
                    _id: user
                },
                {
                    projection: {
                        enabled2fa: true,
                        username: true,
                        seed: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'LOADFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to update user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!userData) {
            let err = new Error('This username does not exist');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        let enabled2fa = tools.getEnabled2fa(userData.enabled2fa);
        if (!enabled2fa.includes('totp')) {
            let err = new Error('Could not update user, check if 2FA TOTP is not already disabled');
            err.responseCode = 400;
            err.code = 'TotpDisabled';
            throw err;
        }

        let update = {
            $set: {
                seed: '',
                pendingSeed: '',
                pendingSeedChanged: false
            },
            $pull: {
                enabled2fa: 'totp'
            }
        };

        let result;
        try {
            result = await this.users.collection('users').updateOne(
                {
                    _id: user
                },
                update,
                { maxTimeMS: consts.DB_MAX_TIME_USERS }
            );
        } catch (err) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to update user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!result || !result.matchedCount) {
            let err = new Error('This username does not exist');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        try {
            await this.logAuthEvent(user, {
                action: 'disable 2fa totp',
                sess: data.sess,
                ip: data.ip
            });
        } catch (err) {
            // ignore
        }

        await publish(this.redis, {
            ev: MFA_TOTP_DISABLED,
            user: userData._id
        });

        return true;
    }

    async checkTotp(user, data) {
        let userRlKey = `totp:${user}`;
        let totpSuccessKey = `totp:${user}:${data.token}`;

        try {
            let rateLimitRes = await this.rateLimit(userRlKey, data, 0);
            if (!rateLimitRes.success) {
                throw rateLimitResponse(rateLimitRes);
            }
        } catch (err) {
            err.responseCode = err.responseCode || 500;
            err.code = err.code || 'InternalDatabaseError';
            throw err;
        }

        try {
            let totpAlreadyUsed = await this.redis.exists(totpSuccessKey);
            if (totpAlreadyUsed) {
                let err = new Error('This code has already been used, please try again with a new code');
                err.response = 'NO';
                err.responseCode = 403;
                err.code = 'RateLimitedError';
                throw err;
            }
        } catch (err) {
            err.responseCode = err.responseCode || 500;
            err.code = err.code || 'InternalDatabaseError';
            throw err;
        }

        let userData;
        try {
            userData = await this.users.collection('users').findOne(
                {
                    _id: user
                },
                {
                    projection: {
                        username: true,
                        enabled2fa: true,
                        seed: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'LOADFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to find user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!userData) {
            let err = new Error('This user does not exist');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        let enabled2fa = tools.getEnabled2fa(userData.enabled2fa);
        if (!userData.seed || !enabled2fa.includes('totp')) {
            // 2fa not set up
            let err = new Error('2FA TOTP is not enabled for this user');
            err.responseCode = 400;
            err.code = 'TotpDisabled';
            throw err;
        }

        let secret = userData.seed;
        if (userData.seed.charAt(0) === '$' && config.totp && config.totp.secret) {
            try {
                secret = await decrypt(userData.seed, config.totp.secret, config.totp.cipher);
            } catch (E) {
                log.error('DB', 'TOTPFAIL decipher failed id=%s error=%s', user, E.message);
                let err = new Error('Can not use decrypted secret');
                err.responseCode = 500;
                err.code = 'InternalConfigError';
                throw err;
            }
        }

        let verified = speakeasy.totp.verify({
            secret,
            encoding: 'base32',
            token: data.token,
            window: consts.TOTP_WINDOW_SIZE
        });

        try {
            await this.logAuthEvent(user, {
                action: 'check 2fa totp',
                result: verified ? 'success' : 'fail',
                sess: data.sess,
                ip: data.ip
            });
        } catch (err) {
            // ignore?
        }

        try {
            if (verified) {
                await this.rateLimitReleaseUser(userRlKey);
            } else {
                await this.rateLimit(userRlKey, data, 1);
            }
        } catch (err) {
            // ignore
        }

        if (verified) {
            try {
                await this.redis
                    .multi()
                    .set(totpSuccessKey, Date.now())
                    .expire(totpSuccessKey, consts.TOTP_WINDOW_SIZE * 30)
                    .exec();
            } catch (err) {
                // ignore
            }
        }

        return verified;
    }

    async enableCustom2fa(user, data) {
        let userData;
        try {
            userData = await this.users.collection('users').findOne(
                {
                    _id: user
                },
                {
                    projection: {
                        enabled2fa: true,
                        username: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'LOADFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to fetch user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!userData) {
            let err = new Error('This username does not exist');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        // previous versions used {enabled2fa: true} for TOTP based 2FA
        let enabled2fa = tools.getEnabled2fa(userData.enabled2fa);
        let disabled2fa = !enabled2fa.length;

        if (enabled2fa.includes('custom')) {
            // 2fa not set up
            let err = new Error('Custom 2FA is already enabled for this user');
            err.responseCode = 400;
            err.code = 'CustomEnabled';
            throw err;
        }

        let updateQuery = {
            $addToSet: {
                enabled2fa: 'custom'
            }
        };

        if (disabled2fa) {
            if (!updateQuery.$inc) {
                updateQuery.$inc = {};
            }
            updateQuery.$inc.authVersion = 1;
        }

        // update user settings
        let result;
        try {
            result = await this.users.collection('users').updateOne(
                {
                    _id: user
                },
                updateQuery,
                { maxTimeMS: consts.DB_MAX_TIME_USERS }
            );
        } catch (err) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to update user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!result || !result.matchedCount) {
            let err = new Error('This username does not exist');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        if (disabled2fa) {
            // 2fa was previously disabled, log out other sessions
            await this.logout(user, 'Authentication required');
        }

        try {
            await this.logAuthEvent(user, {
                action: 'enable 2fa custom',
                result: 'success',
                sess: data.sess,
                ip: data.ip
            });
        } catch (err) {
            // ignore
        }

        await publish(this.redis, {
            ev: MFA_CUSTOM_ENABLED,
            user: userData._id
        });

        return { success: true, disabled2fa };
    }

    async disableCustom2fa(user, data) {
        let userData;
        try {
            userData = await this.users.collection('users').findOne(
                {
                    _id: user
                },
                {
                    projection: {
                        enabled2fa: true,
                        username: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'LOADFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to update user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!userData) {
            let err = new Error('This username does not exist');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        if (!Array.isArray(userData.enabled2fa) || !userData.enabled2fa.includes('custom')) {
            let err = new Error('Could not update user, check if custom 2FA is not already disabled');
            err.responseCode = 400;
            err.code = 'CustomDisabled';
            throw err;
        }

        let update = {
            $pull: {
                enabled2fa: 'custom'
            }
        };

        let result;
        try {
            result = await this.users.collection('users').updateOne(
                {
                    _id: user
                },
                update,
                {
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to update user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!result || !result.matchedCount) {
            let err = new Error('This username does not exist');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        try {
            await this.logAuthEvent(user, {
                action: 'disable 2fa custom',
                sess: data.sess,
                ip: data.ip
            });
        } catch (err) {
            // ignore
        }

        await publish(this.redis, {
            ev: MFA_CUSTOM_DISABLED,
            user: userData._id
        });

        return true;
    }

    async webauthnGetRegistrationOptions(user, data) {
        let userData;
        try {
            userData = await this.users.collection('users').findOne(
                { _id: user },
                {
                    projection: { _id: true, address: true, username: true, name: true, webauthn: true },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!userData) {
            let err = new Error('User was not found');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        const f2l = new Fido2Lib(
            Object.assign(
                {
                    authenticatorAttachment: data.authenticatorAttachment
                },
                config.webauthn,
                data.rpId ? { rpId: data.rpId } : {}
            )
        );
        const registrationOptions = await f2l.attestationOptions();

        registrationOptions.challenge = Buffer.from(registrationOptions.challenge).toString('hex');
        registrationOptions.user = {
            id: userData._id.toString(),
            name: userData.address || userData.username,
            displayName: userData.name || userData.username
        };

        registrationOptions.authenticatorSelection = Object.assign(registrationOptions.authenticatorSelection || {}, {
            authenticatorAttachment: data.authenticatorAttachment
        });

        if (userData.webauthn && userData.webauthn.credentials && userData.webauthn.credentials.length) {
            registrationOptions.excludeCredentials = userData.webauthn.credentials.reduce((excludedCredentials, credentialData) => {
                if (credentialData.authenticatorAttachment === data.authenticatorAttachment) {
                    excludedCredentials.push({
                        rawId: credentialData.rawId.toString('hex'), // hex value
                        type: credentialData.type,
                        transports: credentialData.authenticatorAttachment === 'platform' ? ['internal'] : ['usb', 'nfc', 'ble']
                    });
                }
                return excludedCredentials;
            }, []);
        }

        // store chalenge
        let challengeKey = `challenge:${userData._id.toString()}:reg:${registrationOptions.challenge}`;
        try {
            await this.redis
                .multi()
                .hmset(challengeKey, {
                    challenge: registrationOptions.challenge,
                    user: userData._id.toString(),
                    description: data.description,
                    origin: data.origin,
                    authenticatorAttachment: data.authenticatorAttachment,
                    created: new Date().toISOString(),
                    ttl: consts.WEBAUTHN_CHALLENGE_TTL
                })
                .expire(challengeKey, consts.WEBAUTHN_CHALLENGE_TTL)
                .exec();
        } catch (err) {
            log.error('DB', 'REDISFAIL id=%s error=%s', user, err.message);
            throw err;
        }

        return registrationOptions;
    }

    async webauthnAttestateRegistration(user, data) {
        const clientAttestationResponse = {
            rawId: Uint8Array.from(Buffer.from(data.rawId, 'hex')).buffer,
            response: {
                clientDataJSON: Uint8Array.from(Buffer.from(data.clientDataJSON, 'hex')).buffer,
                attestationObject: Uint8Array.from(Buffer.from(data.attestationObject, 'hex')).buffer
            }
        };

        let challengeKey = `challenge:${user.toString()}:reg:${data.challenge}`;
        let [[, challengeData]] = await this.redis.multi().hgetall(challengeKey).del(challengeKey).exec();

        if (!challengeData) {
            let err = new Error('Unknown challenge');
            err.responseCode = 404;
            err.code = 'ChallengeNotFound';
            throw err;
        }

        const attestationExpectations = {
            challenge: Uint8Array.from(Buffer.from(challengeData.challenge, 'hex')).buffer,
            origin: challengeData.origin,
            factor: 'either'
        };

        const f2l = new Fido2Lib(Object.assign({}, config.webauthn, data.rpId ? { rpId: data.rpId } : {}));

        const regResult = await f2l.attestationResult(clientAttestationResponse, attestationExpectations);

        let credentialData = {
            _id: new ObjectId(),
            rawId: Buffer.from(data.rawId, 'hex'),
            publicKey: regResult.authnrData.get('credentialPublicKeyPem'),
            counter: regResult.authnrData.get('counter'),
            type: 'public-key'
        };

        for (let key of ['description', 'origin', 'authenticatorAttachment', 'created']) {
            let value = challengeData[key];
            switch (key) {
                case 'created':
                    value = new Date(value);
                    break;
            }

            credentialData[key] = challengeData[key];
        }

        let r;
        let userData;
        try {
            r = await this.users.collection('users').findOneAndUpdate(
                { _id: user },
                {
                    $push: { 'webauthn.credentials': credentialData },
                    $addToSet: {
                        enabled2fa: 'webauthn'
                    }
                },
                {
                    returnDocument: 'after',
                    maxTimeMS: consts.DB_MAX_TIME_USERS,
                    projection: {
                        _id: true,
                        enabled2fa: true
                    }
                }
            );
            userData = r.value;
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!userData) {
            let err = new Error('User was not found');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        let enabled2fa = tools.getEnabled2fa(userData.enabled2fa);
        if (!enabled2fa) {
            // 2FA was previously disabled, log out other sessions
            await this.logout(user, 'Authentication required');
        }

        try {
            await this.logAuthEvent(user, {
                action: 'register webauthn',
                result: 'success',
                credential: {
                    id: credentialData._id,
                    rawId: credentialData.rawId,
                    description: credentialData.description,
                    authenticatorAttachment: credentialData.authenticatorAttachment
                },
                sess: data.sess,
                ip: data.ip
            });
        } catch (err) {
            // ignore
        }

        await publish(this.redis, {
            ev: MFA_FIDO_REGISTERED,
            user: userData._id,
            credential: {
                id: credentialData._id.toString(),
                rawId: credentialData.rawId.toString('hex'),
                description: credentialData.description,
                authenticatorAttachment: credentialData.authenticatorAttachment
            }
        });

        return {
            success: true,
            id: credentialData._id.toString(),
            rawId: credentialData.rawId.toString('hex'),
            description: credentialData.description,
            authenticatorAttachment: credentialData.authenticatorAttachment
        };
    }

    async webauthnGetAuthenticationOptions(user, data) {
        let userData;
        try {
            userData = await this.users.collection('users').findOne(
                { _id: user },
                {
                    projection: { _id: true, address: true, username: true, name: true, enabled2fa: true, webauthn: true },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!userData) {
            let err = new Error('User was not found');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        let enabled2fa = tools.getEnabled2fa(userData.enabled2fa);
        if (!enabled2fa.includes('webauthn') || !userData.webauthn || !userData.webauthn.credentials || !userData.webauthn.credentials.length) {
            let err = new Error('WebAuthn is not enabled for this user');
            err.responseCode = 400;
            err.code = 'WebAuthnDisabled';
            throw err;
        }

        const f2l = new Fido2Lib(
            Object.assign(
                {
                    authenticatorAttachment: data.authenticatorAttachment
                },
                config.webauthn,
                data.rpId ? { rpId: data.rpId } : {}
            )
        );

        const authenticationOptions = await f2l.assertionOptions();

        authenticationOptions.challenge = Buffer.from(authenticationOptions.challenge).toString('hex');

        authenticationOptions.allowCredentials = userData.webauthn.credentials
            .filter(credentialData => credentialData.authenticatorAttachment === data.authenticatorAttachment)
            .map(credentialData => ({
                rawId: credentialData.rawId.toString('hex'),
                type: credentialData.type
            }));

        // store chalenge
        let challengeKey = `challenge:${userData._id.toString()}:auth:${authenticationOptions.challenge}`;
        try {
            await this.redis
                .multi()
                .hmset(challengeKey, {
                    challenge: authenticationOptions.challenge,
                    user: userData._id.toString(),
                    origin: data.origin,
                    created: new Date().toISOString(),
                    ttl: consts.WEBAUTHN_CHALLENGE_TTL
                })
                .expire(challengeKey, consts.WEBAUTHN_CHALLENGE_TTL)
                .exec();
        } catch (err) {
            log.error('DB', 'REDISFAIL id=%s error=%s', user, err.message);
            throw err;
        }

        return authenticationOptions;
    }

    async webauthnAssertAuthentication(user, data) {
        const clientAssertionResponse = {
            rawId: Uint8Array.from(Buffer.from(data.rawId, 'hex')).buffer,
            response: {
                clientDataJSON: Uint8Array.from(Buffer.from(data.clientDataJSON, 'hex')).buffer,
                authenticatorData: Uint8Array.from(Buffer.from(data.authenticatorData, 'hex')).buffer,
                signature: Uint8Array.from(Buffer.from(data.signature, 'hex')).buffer
            }
        };

        let challengeKey = `challenge:${user.toString()}:auth:${data.challenge}`;
        let [[, challengeData]] = await this.redis.multi().hgetall(challengeKey).del(challengeKey).exec();

        if (!challengeData) {
            let err = new Error('Unknown challenge');
            err.responseCode = 404;
            err.code = 'ChallengeNotFound';
            throw err;
        }

        let userData;
        try {
            userData = await this.users.collection('users').findOne(
                { _id: user },
                {
                    projection: { _id: true, address: true, username: true, name: true, enabled2fa: true, webauthn: true },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!userData) {
            let err = new Error('User was not found');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        let enabled2fa = tools.getEnabled2fa(userData.enabled2fa);
        if (!enabled2fa.includes('webauthn') || !userData.webauthn || !userData.webauthn.credentials || !userData.webauthn.credentials.length) {
            let err = new Error('WebAuthn is not enabled for this user');
            err.responseCode = 400;
            err.code = 'WebAuthnDisabled';
            throw err;
        }

        let credentialData = userData.webauthn.credentials.find(credential => credential.rawId.toString('hex') === data.rawId);
        if (!credentialData) {
            let err = new Error('Credentials were not found');
            err.responseCode = 404;
            err.code = 'CredentialsNotFound';
            throw err;
        }

        const assertionExpectations = {
            challenge: Uint8Array.from(Buffer.from(challengeData.challenge, 'hex')).buffer,
            origin: challengeData.origin,
            factor: 'either',
            publicKey: credentialData.publicKey,
            prevCounter: credentialData.counter,
            userHandle: null,
            rpId: data.rpId || config.webauthn.rpId
        };

        const f2l = new Fido2Lib(Object.assign({}, config.webauthn, data.rpId ? { rpId: data.rpId } : {}));

        const authnResult = await f2l.assertionResult(clientAssertionResponse, assertionExpectations);

        if (authnResult) {
            let counter = authnResult.authnrData.get('counter');
            if (counter) {
                try {
                    // don't really care about the outcome
                    await this.users.collection('users').updateOne(
                        { _id: user, 'webauthn.credentials._id': credentialData._id },
                        {
                            $set: { 'webauthn.credentials.$.counter': counter }
                        },
                        {
                            returnDocument: 'after',
                            maxTimeMS: consts.DB_MAX_TIME_USERS
                        }
                    );
                } catch (err) {
                    err.responseCode = 500;
                    err.code = 'InternalDatabaseError';
                    throw err;
                }
            }
        }

        return {
            authenticated: true,
            credential: credentialData._id.toString()
        };
    }

    async webauthnRemove(user, credential, data) {
        let r;
        try {
            r = await this.users.collection('users').findOneAndUpdate(
                {
                    _id: user
                },
                {
                    $pull: {
                        'webauthn.credentials': { _id: credential }
                    }
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_USERS,
                    returnDocument: 'after',
                    projection: { _id: true, enabled2fa: true, webauthn: true }
                }
            );
        } catch (err) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to update user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!r || !r.value) {
            let err = new Error('Could not find user data');
            err.responseCode = 404;
            err.code = 'UserNotFound';
        }

        let userData = r.value;

        if (
            userData.enabled2fa &&
            userData.enabled2fa.includes('webauthn') &&
            (!userData.webauthn || !userData.webauthn.credentials || !userData.webauthn.credentials.length)
        ) {
            // disable webauthn
            try {
                await this.users.collection('users').updateOne(
                    {
                        _id: user
                    },
                    {
                        $set: {
                            webauthn: { credentials: [] }
                        },
                        $pull: {
                            enabled2fa: 'webauthn'
                        }
                    },
                    {
                        maxTimeMS: consts.DB_MAX_TIME_USERS
                    }
                );
            } catch (err) {
                // ignore?
            }
        }

        try {
            await this.logAuthEvent(user, {
                action: 'remove webauthn',
                result: 'success',
                credential,
                sess: data.sess,
                ip: data.ip
            });
        } catch (err) {
            // ignore
        }

        await publish(this.redis, {
            ev: MFA_FIDO_REMOVED,
            user: userData._id,
            credential: credential.toString()
        });

        return true;
    }

    async disable2fa(user, data) {
        let result;
        try {
            result = await this.users.collection('users').updateOne(
                {
                    _id: user
                },
                {
                    $set: {
                        enabled2fa: [],
                        seed: '',
                        pendingSeed: '',
                        pendingSeedChanged: false,
                        webauthn: {
                            credentials: []
                        }
                    }
                },
                {
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to update user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!result || !result.matchedCount) {
            let err = new Error('Could not find user data');
            err.responseCode = 404;
            err.code = 'UserNotFound';
        }

        try {
            await this.logAuthEvent(user, {
                action: 'disable 2fa',
                sess: data.sess,
                ip: data.ip
            });
        } catch (err) {
            // ignore
        }

        await publish(this.redis, {
            ev: MFA_DISABLED,
            user
        });

        return true;
    }

    async update(user, data) {
        let $set = {};
        let $push = {};

        let updates = false;
        let passwordChanged = false;
        let wasSuspended = false;

        // if some of the counter keys are modified, then reset the according value in Redis
        let resetKeys = new Map([
            ['recipients', 'wdr'],
            ['forwards', 'wdf'],
            ['imapMaxUpload', 'iup'],
            ['imapMaxDownload', 'idw'],
            ['pop3MaxDownload', 'pdw'],
            ['pop3MaxMessages', 'pxm'],
            ['receivedMax', 'rl:rcpt']
        ]);
        let flushKeys = [];
        let flushHKeys = [];

        Object.keys(data).forEach(key => {
            if (['user', 'existingPassword', 'hashedPassword', 'allowUnsafe', 'ip', 'sess'].includes(key)) {
                return;
            }

            if (resetKeys.has(key)) {
                flushKeys.push(resetKeys.get(key) + ':' + user);
            }
            if (key === 'imapMaxConnections') {
                flushHKeys.push({ key: 'lim:imap', value: user.toString() });
            }

            if (key === 'suspended' && data.suspended) {
                // force logout after updates
                wasSuspended = true;
            }

            if (key === 'password') {
                if (!data[key]) {
                    // removes current password (if set)
                    $set.password = '';
                } else {
                    $set.password = data[key]; // hashed below
                }

                $set.tempPassword = false;
                $set.passwordChange = new Date();
                passwordChanged = true;
                return;
            }

            if (key === 'disable2fa') {
                if (data.disable2fa) {
                    $set.enabled2fa = [];
                    $set.seed = '';
                    $set.pendingSeed = '';
                    $set.pendingSeedChanged = false;
                    $set.webauthn = {
                        credentials: []
                    };
                }
                updates = true;
                return;
            }

            if (key === 'spamLevel') {
                // spamLevel is from 0 (everything is spam) to 100 (accept everything)
                let spamLevel = !isNaN(data.spamLevel) ? Number(data.spamLevel) : 50;
                if (spamLevel < 0) {
                    spamLevel = 0;
                }
                if (spamLevel > 100) {
                    spamLevel = 100;
                }
                $set.spamLevel = data.spamLevel;
                updates = true;
                return;
            }

            if (key === 'disabledScopes') {
                let allowedScopes = [...consts.SCOPES];
                let scopeSet = new Set();
                let disabledScopes = [].concat(data.disabledScopes || []);
                disabledScopes.forEach(scope => {
                    scope = scope.toLowerCase().trim();
                    if (allowedScopes.includes(scope)) {
                        scopeSet.add(scope);
                    }
                });
                $set.disabledScopes = Array.from(scopeSet).sort((a, b) => a.localeCompare(b));
                updates = true;
                return;
            }

            $set[key] = data[key];
            updates = true;
        });

        if ($set.username) {
            $set.unameview = tools.uview($set.username);
        }

        if (!updates && !passwordChanged) {
            let err = new Error('Nothing was updated');
            err.responseCode = 400;
            err.code = 'NoUpdates';
            throw err;
        }

        if ($set.password) {
            try {
                if (data.hashedPassword) {
                    // try if the hashing library can handle it?
                    await hashes.compare('whatever', $set.password);
                    // did not throw, so probably OK, no need to update `$set.password`
                } else {
                    $set.password = await hashes.hash(data.password);
                }
            } catch (err) {
                log.error('DB', 'HASHFAIL user.update id=%s error=%s', data.username, err.message);
                err.responseCode = 500;
                err.code = 'HashError';
                throw err;
            }
        }

        let userData;
        try {
            userData = await this.users.collection('users').findOne(
                { _id: user, temp: false },
                {
                    projection: {
                        password: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to find user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!userData) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, 'User was not found');
            let err = new Error('User was not found');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        // push current password to old passwords list on password change (and not temporary password)
        if ($set.password && userData && userData.password) {
            $push.oldPasswords = {
                date: new Date(),
                hash: userData.password
            };
        }

        if (data.existingPassword && userData.password) {
            let success;
            try {
                success = await hashes.compare(data.existingPassword, userData.password);
            } catch (err) {
                log.error('DB', 'HASHFAIL user.update id=%s error=%s', data.username, err.message);
                err.responseCode = 500;
                err.code = err.code || 'HashError';
                throw err;
            }

            if (!success) {
                try {
                    await this.logAuthEvent(user, {
                        action: 'password change',
                        result: 'fail',
                        sess: data.sess,
                        ip: data.ip
                    });
                } catch (err) {
                    // ignore
                }
                let err = new Error('Password verification failed');
                err.responseCode = 403;
                err.code = 'AuthFail';
                throw err;
            }
        }

        let updateQuery = {
            $set
        };

        if (Object.keys($push).length) {
            updateQuery.$push = $push;
        }

        if (passwordChanged || wasSuspended) {
            if (!updateQuery.$inc) {
                updateQuery.$inc = {};
            }
            updateQuery.$inc.authVersion = 1;
        }

        let result;
        try {
            result = await this.users.collection('users').findOneAndUpdate(
                {
                    _id: user
                },
                updateQuery,
                {
                    returnDocument: 'after',
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );

            if ($set.featureFlags && Object.keys($set.featureFlags).length) {
                for (let featureFlag of Object.keys($set.featureFlags)) {
                    try {
                        if ($set.featureFlags[featureFlag]) {
                            let res = await this.redis.sadd(`feature:${featureFlag}`, user.toString());
                            if (res) {
                                // feature flag was enabled for a user
                                switch (featureFlag) {
                                    case 'indexing':
                                        await this.taskHandler.add('user-indexing', {
                                            user
                                        });
                                        break;
                                }
                            }
                        } else {
                            await this.redis.srem(`feature:${featureFlag}`, user.toString());
                        }
                    } catch (err) {
                        log.error('Redis', 'FEATUREFAIL failed to update feature flag user=%s featureFlag=%s error=%s', user, featureFlag, err.message);
                    }
                }
            }
        } catch (err) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to update user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        if (!result || !result.value) {
            log.error('DB', 'UPDATEFAIL id=%s error=%s', user, 'User was not found');
            let err = new Error('user was not found');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        // check if we need to reset any ttl counters
        if (flushKeys.length || flushHKeys.length) {
            let flushreq = this.redis.multi();

            flushKeys.forEach(key => {
                flushreq = flushreq.del(key);
            });

            flushHKeys.forEach(entry => {
                flushreq = flushreq.hdel(entry.key, entry.value);
            });

            // just call the operations and hope for the best, no problems if fails
            try {
                await flushreq.exec();
            } catch (err) {
                // ignore
            }
        }

        try {
            await this.flushUserCache(user);
        } catch (err) {
            // ignore
        }

        if (passwordChanged || wasSuspended) {
            try {
                if (passwordChanged) {
                    await this.logAuthEvent(user, {
                        action: 'password change',
                        result: 'success',
                        sess: data.sess,
                        ip: data.ip
                    });

                    await publish(this.redis, {
                        ev: USER_PASSWORD_CHANGED,
                        user: userData._id
                    });
                }

                await this.logout(user, 'Authentication required');
            } catch (err) {
                // ignore
            }
        }

        return { success: true, passwordChanged };
    }

    getMailboxes(language, defaults) {
        defaults = defaults || {};

        let lcode = (language || '').toLowerCase().split('_').shift();

        let translation = lcode && mailboxTranslations.hasOwnProperty(lcode) ? mailboxTranslations[lcode] : mailboxTranslations.en;

        let defaultMailboxes = [
            {
                path: 'INBOX'
            },
            {
                specialUse: '\\Sent'
            },
            {
                specialUse: '\\Trash'
            },
            {
                specialUse: '\\Drafts'
            },
            {
                specialUse: '\\Junk'
            }
        ];

        let uidValidity = Math.floor(Date.now() / 1000);

        return defaultMailboxes.map(mailbox => ({
            path: mailbox.path === 'INBOX' ? 'INBOX' : defaults[mailbox.specialUse] || translation[mailbox.specialUse || mailbox.path] || mailbox.path,
            specialUse: mailbox.specialUse,
            uidValidity,
            uidNext: 1,
            modifyIndex: 0,
            subscribed: true,
            flags: []
        }));
    }

    async logAuthEvent(user, entry) {
        let authlogTime = await this.settingsHandler.get('const:authlog:time', {});

        // only log auth events if we have a valid user id and logging is not disabled
        if (!user || !tools.isId(user) || !authlogTime) {
            return false;
        }

        let now = new Date();

        entry.user = typeof user === 'string' ? new ObjectId(user) : user;
        entry.action = entry.action || 'authentication';
        entry.created = now;

        // this entry expires in set days
        entry.expires = new Date(Date.now() + authlogTime);

        // key is for merging similar events
        entry.key = crypto
            .createHash('md5')
            .update([entry.protocol, entry.ip, entry.action, entry.result, entry.target].map(v => (v || '').toString()).join('^'))
            .digest();

        let r = await this.users.collection('authlog').findOneAndUpdate(
            {
                user: entry.user,
                created: {
                    // merge similar events into buckets of time
                    $gte: new Date(Date.now() - consts.AUTHLOG_BUCKET)
                },
                // events are merged based on this key
                key: entry.key
            },
            {
                $setOnInsert: entry,
                $inc: {
                    events: 1
                },
                $set: {
                    last: now
                }
            },
            {
                upsert: true,
                projection: { _id: true },
                returnDocument: 'after',
                maxTimeMS: consts.DB_MAX_TIME_USERS
            }
        );

        return r && r.value && r.value._id;
    }

    async logout(user, reason) {
        // register this address as the default address for that user
        let userData;
        try {
            userData = await this.users.collection('users').findOne(
                {
                    _id: new ObjectId(user)
                },
                {
                    projection: {
                        _id: true
                    },
                    maxTimeMS: consts.DB_MAX_TIME_USERS
                }
            );
        } catch (err) {
            log.error('DB', 'DBFAIL logout id=%s error=%s', user, err.message);
            err.message = 'Database Error, failed to find user';
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }
        if (!userData) {
            let err = new Error('User not found');
            err.responseCode = 404;
            err.code = 'UserNotFound';
            throw err;
        }

        if (!this.messageHandler || !this.messageHandler.notifier) {
            return false;
        }

        this.messageHandler.notifier.fire(userData._id, {
            command: 'LOGOUT',
            reason
        });

        return true;
    }

    // This method deletes non-expiring records from database
    async delete(user, options) {
        options = options || {};

        // clear limits in Redis
        try {
            await this.redis.del('limits:' + user);
        } catch (err) {
            // ignore
        }

        let result = {
            user: user.toString()
        };

        // disable user account by moving it to another collection
        let existingAccount = await this.users.collection('users').findOne({ _id: user });
        if (existingAccount) {
            existingAccount.deleteInfo = {
                deletedAt: new Date(),
                mainAddress: existingAccount.address
            };

            let addresses = await this.users.collection('addresses').find({ user }).toArray();
            existingAccount.deleteInfo.addresses = addresses;

            // is there somehow an old entry already present?
            let existingDeleted = await this.users.collection('deletedusers').findOne({ _id: user });
            if (existingDeleted) {
                // remove it
                await this.users.collection('deletedusers').deleteOne({ _id: user });
            }

            let r = await this.users.collection('deletedusers').insertOne(existingAccount);
            if (r.insertedId) {
                await this.users.collection('users').deleteOne({ _id: user });
            }

            // remove feature flag entries
            if (existingAccount.featureFlags && Object.keys(existingAccount.featureFlags).length) {
                let req = this.redis.multi();
                for (let featureFlag of Object.keys(existingAccount.featureFlags)) {
                    if (existingAccount.featureFlags[featureFlag]) {
                        req = req.srem(`feature:${featureFlag}`, user.toString());
                    }
                }
                try {
                    await req.exec();
                } catch (err) {
                    log.error('Redis', 'FEATUREFAIL failed to update feature flags id=%s error=%s', user, err.message);
                }
            }
        }

        try {
            let delRes = await this.users.collection('addresses').deleteMany({ user });
            result.addresses = { deleted: delRes.deletedCount };
        } catch (err) {
            log.error('USERDEL', 'Failed to delete addresses for id=%s error=%s', user, err.message);
            err.responseCode = 500;
            err.code = 'InternalDatabaseError';
            throw err;
        }

        // set up a task to delete user messages
        let now = new Date();

        let deleteAfter = options.deleteAfter ? options.deleteAfter : now;

        let existstingTask = await this.database.collection('tasks').findOne({ task: 'user-delete', user });
        if (existstingTask) {
            if (existstingTask.locked && existstingTask.status === 'delayed') {
                // can update scheduled time
                let r = await this.database.collection('tasks').findOneAndUpdate(
                    { _id: existstingTask._id, status: 'delayed' },
                    {
                        $set: {
                            lockedUntil: deleteAfter
                        }
                    },
                    { returnDocument: 'after' }
                );

                if (r && r.value) {
                    existstingTask = r.value;
                }
            }

            result.deleteAfter = existstingTask.lockedUntil.toISOString();
            result.task = existstingTask._id.toString();
        } else {
            let task = await this.taskHandler.add(
                'user-delete',
                {
                    user
                },
                {
                    wait: options.deleteAfter
                }
            );

            result.deleteAfter = deleteAfter.toISOString();
            result.task = task && task.toString();
        }

        try {
            await this.logAuthEvent(user, {
                action: 'delete user',
                result: 'success',
                sess: options.sess,
                ip: options.ip
            });
        } catch (err) {
            // ignore
        }

        await publish(this.redis, {
            ev: USER_DELETE_STARTED,
            user,
            result
        });

        return result;
    }

    // Return information about deleted user
    async restoreInfo(user) {
        let result = {
            user: user.toString()
        };

        let existingAccount = await this.users.collection('deletedusers').findOne({ _id: user });
        if (!existingAccount) {
            let err = new Error('Deleted account was not found');
            err.responseCode = 404;
            err.code = 'AccountNotFound';
            throw err;
        }

        result.username = existingAccount.username;
        result.storageUsed = existingAccount.storageUsed;
        result.tags = existingAccount.tags;

        result.deleted = existingAccount.deleteInfo.deletedAt.toISOString();

        // Step 2. restore addresses
        let recoverableAddresses = [];
        for (let address of existingAccount.deleteInfo.addresses || []) {
            let existingAddress = await this.users.collection('addresses').findOne(address);
            if (!existingAddress || existingAddress.user.equals(user)) {
                recoverableAddresses.push(address.address);
            }
        }

        result.recoverableAddresses = recoverableAddresses;

        return result;
    }

    // This method restores a user that is queued for deletion
    async restore(user, options) {
        options = options || {};

        let result = {
            user: user.toString()
        };

        let existstingTask = await this.database.collection('tasks').findOne({
            task: 'user-delete',
            $or: [
                { 'data.user': user },
                {
                    // legacy format
                    user
                }
            ]
        });

        if (existstingTask) {
            result.task = existstingTask._id.toString();

            if (existstingTask.status !== 'delayed') {
                let err = new Error('Deletion already in progress');
                err.responseCode = 400;
                err.code = 'DeleteInProgress';
                throw err;
            }

            let delRes = await this.database.collection('tasks').deleteOne({
                _id: existstingTask._id,
                status: 'delayed'
            });

            if (!delRes.deletedCount) {
                let err = new Error('Delete task not found');
                err.responseCode = 404;
                err.code = 'RestoreTaskNotFound';
                throw err;
            }
        }

        let existingAccount = await this.users.collection('deletedusers').findOne({ _id: user });
        if (!existingAccount) {
            let err = new Error('Deleted account was not found');
            err.responseCode = 404;
            err.code = 'AccountNotFound';
            throw err;
        }

        let accountDeleted = existingAccount.deleteInfo;
        delete existingAccount.deleteInfo;

        // Step 1. restore user entry
        try {
            existingAccount.address = ''; // clear for now, restore after address objects are successfully re-inserted
            let r = await this.users.collection('users').insertOne(existingAccount);
            if (r.insertedId) {
                try {
                    await this.users.collection('deletedusers').deleteOne({ _id: user });
                } catch (err) {
                    // actually we are not so much interested in this step as the user entry is already restored
                }
            }
        } catch (err) {
            if (err.code === 11000) {
                // duplicate key
                let err = new Error('Account was already restored');
                err.responseCode = 400;
                err.code = 'AccountFound';
                throw err;
            }
            throw err;
        }

        // Step 2. restore addresses
        let recoveredAddresses = [];
        for (let address of accountDeleted.addresses || []) {
            try {
                let r = await this.users.collection('addresses').insertOne(address);
                if (!r || !r.insertedId) {
                    throw new Error('Failed to insert');
                }
                recoveredAddresses.push(address);
                log.info('Restore', 'ADDRRESTORE user=%s address=%s email=%s', user, address._id, address.address);
            } catch (err) {
                log.error('Restore', 'ADDRFAIL user=%s address=%s email=%s error=%s', user, address._id, address.address, err.message);
            }
        }

        result.addresses = {
            recovered: recoveredAddresses.length
        };

        // Step 3. restore main address
        let mainAddress = recoveredAddresses.find(addr => addr.address === accountDeleted.mainAddress);
        if (!mainAddress && recoveredAddresses.length) {
            mainAddress = recoveredAddresses[0];
        }

        if (mainAddress) {
            try {
                await this.users.collection('users').updateOne({ _id: user }, { $set: { address: mainAddress.address } });
            } catch (err) {
                log.error('Restore', 'ADDRFAILMAIN user=%s address=%s email=% error=%s', user, mainAddress._id, mainAddress.address, err.message);
            }
            result.addresses.main = mainAddress.address;
        }

        try {
            await this.logAuthEvent(user, {
                action: 'restore user',
                result: 'success',
                sess: options.sess,
                ip: options.ip
            });
        } catch (err) {
            // ignore
        }

        await publish(this.redis, {
            ev: USER_DELETE_CANCELLED,
            user,
            result
        });

        return result;
    }

    async pushDefaultMessages(userData, tags) {
        let messages = await tools.getEmailTemplates(tags);
        if (!messages || !messages.length) {
            return false;
        }

        let encryptMessage = util.promisify(this.messageHandler.encryptMessage.bind(this.messageHandler));

        for (let data of messages) {
            let compiler = new MailComposer(data);
            let compiled = compiler.compile();
            let build = util.promisify(compiled.build.bind(compiled));

            try {
                let message = await build();
                let mailboxQueryKey = 'path';
                let mailboxQueryValue = 'INBOX';

                if (['sent', 'trash', 'junk', 'drafts', 'archive'].includes((data.mailbox || '').toString().toLowerCase())) {
                    mailboxQueryKey = 'specialUse';
                    mailboxQueryValue = '\\' + data.mailbox.toLowerCase().replace(/^./g, c => c.toUpperCase());
                }

                let flags = [];
                if (data.seen) {
                    flags.push('\\Seen');
                }
                if (data.flag) {
                    flags.push('\\Flagged');
                }

                let encrypted = await encryptMessage(userData.encryptMessages ? userData.pubKey : false, message);
                if (encrypted) {
                    message = encrypted;
                }

                await this.messageHandler.addAsync({
                    user: userData._id,
                    [mailboxQueryKey]: mailboxQueryValue,
                    meta: {
                        source: 'AUTO',
                        time: new Date()
                    },
                    flags,
                    raw: message
                });
            } catch (err) {
                // ignore
            }
        }
    }

    // returns a query to find a user based on address or username
    async checkAddress(username) {
        if (username.indexOf('@') < 0) {
            // not formatted as an address, assume regular username
            return {
                unameview: tools.uview(username)
            };
        }

        let addressData = await this.asyncResolveAddress(username, {
            wildcard: false,
            projection: {
                user: true
            }
        });

        if (addressData && !addressData.user) {
            // found a non-user address
            return false;
        }

        if (!addressData) {
            // fall back to username formatted as an address
            return {
                unameview: tools.normalizeAddress(username, false, {
                    removeLabel: true,
                    removeDots: true
                })
            };
        }

        return {
            _id: addressData.user
        };
    }

    async setAuthToken(user, accessToken) {
        let tokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');
        let key = 'tn:token:' + tokenHash;
        let ttl = config.api.accessControl.tokenTTL || consts.ACCESS_TOKEN_DEFAULT_TTL;

        let userData = await this.users.collection('users').findOne(
            {
                _id: new ObjectId(user)
            },
            { projection: { authVersion: true } }
        );
        let authVersion = Number(userData && userData.authVersion) || 0;

        let tokenData = {
            user: user.toString(),
            role: 'user',
            created: Date.now(),
            ttl,
            authVersion,
            // signature
            s: crypto
                .createHmac('sha256', config.api.accessControl.secret)
                .update(
                    JSON.stringify({
                        token: accessToken,
                        user: user.toString(),
                        authVersion,
                        role: 'user'
                    })
                )
                .digest('hex')
        };

        await this.redis.multi().hmset(key, tokenData).expire(key, ttl).exec();

        return accessToken;
    }

    async generateAuthToken(user) {
        let accessToken = crypto.randomBytes(20).toString('hex');
        return await this.setAuthToken(user, accessToken);
    }
}

function rateLimitResponse(res) {
    let err = new Error('Authentication was rate limited');
    err.response = 'NO';
    err.responseCode = 403;
    err.ttl = res.ttl;
    err.code = 'RateLimitedError';
    err.responseMessage = `Authentication was rate limited. Try again in ${tools.roundTime(res.ttl)}.`;
    return err;
}

// high collision hash function
function getStringSelector(str) {
    let hash = crypto.createHash('sha1').update(str).digest();
    let sum = 0;
    for (let i = 0, len = hash.length; i < len; i++) {
        sum += hash[i];
    }
    return (sum % 32).toString(16);
}

module.exports = UserHandler;
