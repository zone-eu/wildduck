'use strict';

const http2 = require('node:http2');
const fs = require('node:fs');
const path = require('node:path');
const config = require('@zone-eu/wild-config');
const log = require('npmlog');
const consts = require('./consts');

const APN_HOST_PRODUCTION = 'api.push.apple.com';
const APN_HOST_SANDBOX = 'api.sandbox.push.apple.com';
const APN_CONNECT_TIMEOUT = 20000;
const APN_REQUEST_TIMEOUT = 30000;
const APN_PING_INTERVAL = 15 * 60 * 1000;
const APN_DEBOUNCE_DELAY = 2000;
// short cooldown after a failed connect so notification bursts don't hammer APNs
const APN_RECONNECT_DELAY = 5000;

class ApnClient {
    constructor(options) {
        this.topic = options.topic;
        this.host = options.sandbox ? APN_HOST_SANDBOX : APN_HOST_PRODUCTION;
        this.database = options.database;
        this.loggelf = options.loggelf || (() => false);

        this._cert = fs.readFileSync(options.certPath);
        this._key = fs.readFileSync(options.keyPath);
        this._session = null;
        this._pingTimer = null;
        this._pending = new Map();
        // timestamp until which reconnecting is held off; cleared on a successful connect
        this._reconnectAfter = 0;
    }

    // `session` is the session whose handler is calling in; only clear shared state if it is
    // still the current one, so a late event from an old session can't tear down a newer one
    _destroySession(session) {
        if (session && this._session && session !== this._session) {
            return;
        }
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        this._session = null;
    }

    // Hold off reconnecting briefly after a failed connect. Covers connect failures
    // only (not GOAWAY/close of a live session), so it is a throttle, not a breaker.
    _holdReconnect(reason) {
        // a failed connect emits both 'error' and 'close' (and a timeout adds a third
        // path); keep the first, most specific reason and log the hold only once
        if (this._reconnectAfter && Date.now() < this._reconnectAfter) {
            return;
        }
        this._reconnectAfter = Date.now() + APN_RECONNECT_DELAY;
        log.info('APN', 'Holding off reconnect reason=%s delay=%s ms', reason, APN_RECONNECT_DELAY);
        this.loggelf({
            short_message: '[APN] Holding off reconnect',
            _mail_action: 'apn_reconnect_hold',
            _reason: reason,
            _delay: APN_RECONNECT_DELAY
        });
    }

    _getSession() {
        if (this._session && !this._session.closed && !this._session.destroyed) {
            return this._session;
        }

        // still cooling down after a failed connect – skip reconnecting for now
        if (this._reconnectAfter && Date.now() < this._reconnectAfter) {
            return null;
        }

        // distinguishes a failed connect (apply cooldown) from a normal close
        let established = false;

        // operate on this captured reference, not this._session, so a late event from this
        // session can't act on a newer session that replaced it after a reconnect/close
        let session = http2.connect(`https://${this.host}`, {
            cert: this._cert,
            key: this._key
        });
        this._session = session;

        session.setTimeout(APN_CONNECT_TIMEOUT, () => {
            log.error('APN', 'HTTP/2 connection timed out timeout=%s ms', APN_CONNECT_TIMEOUT);
            this.loggelf({
                short_message: '[APN] HTTP/2 connection timed out',
                _mail_action: 'apn_connect_timeout',
                _timeout: APN_CONNECT_TIMEOUT
            });
            if (!established) {
                this._holdReconnect('connect timeout');
            }
            session.destroy(new Error('APNs connection timed out'));
        });

        session.on('goaway', (errorCode, lastStreamID) => {
            log.error('APN', 'HTTP/2 GOAWAY received errorCode=%s lastStreamID=%s', errorCode, lastStreamID);
            this.loggelf({
                short_message: '[APN] HTTP/2 GOAWAY received',
                _mail_action: 'apn_goaway',
                _errorCode: errorCode,
                _lastStreamID: lastStreamID
            });
            session.destroy();
        });

        session.on('connect', () => {
            // connection established, clear the connect timeout and any reconnect cooldown
            session.setTimeout(0);
            established = true;
            this._reconnectAfter = 0;

            log.info('APN', 'HTTP/2 session established host=%s', this.host);
            this.loggelf({
                short_message: '[APN] HTTP/2 session established',
                _mail_action: 'apn_connected',
                _host: this.host
            });

            // start periodic health pings
            this._pingTimer = setInterval(() => {
                if (session.closed || session.destroyed) {
                    this._destroySession(session);
                    return;
                }
                session.ping(err => {
                    if (err) {
                        log.error('APN', 'HTTP/2 ping failed: %s', err.message);
                        this.loggelf({
                            short_message: '[APN] HTTP/2 ping failed',
                            _mail_action: 'apn_ping_error',
                            _error: err.message
                        });
                        session.destroy();
                    }
                });
            }, APN_PING_INTERVAL);
            this._pingTimer.unref();
        });

        session.on('error', err => {
            log.error('APN', 'HTTP/2 session error: %s (code=%s)', err.message, err.code);
            this.loggelf({
                short_message: '[APN] HTTP/2 session error',
                _mail_action: 'apn_session_error',
                _error: err.message,
                _code: err.code
            });
            if (!established) {
                this._holdReconnect('session error');
            }
            this._destroySession(session);
        });

        session.on('close', () => {
            if (!established) {
                this._holdReconnect('closed before connect');
            }
            this._destroySession(session);
        });

        return session;
    }

    /**
     * Send a push notification for a single device token
     * @param {String} deviceToken
     * @param {String} accountId
     * @returns {Promise<{status: number, reason: string|null}>}
     */
    _push(deviceToken, accountId) {
        if (!/^[0-9a-fA-F]{64}$/.test(deviceToken)) {
            let err = new Error('Invalid device token format');
            log.error('APN', 'Invalid device token format token=%s...', deviceToken.slice(0, 4));
            this.loggelf({
                short_message: '[APN] Invalid device token format',
                _mail_action: 'apn_invalid_token',
                _deviceToken: (deviceToken || '').slice(0, 4) + '...',
                _error: err.message
            });
            return Promise.reject(err);
        }

        let session = this._getSession();
        if (!session) {
            return Promise.reject(new Error('APNs reconnect on cooldown'));
        }
        let payload = JSON.stringify({ aps: { 'account-id': accountId } });

        return new Promise((resolve, reject) => {
            let req = session.request({
                ':method': 'POST',
                ':path': `/3/device/${deviceToken}`,
                'content-type': 'application/json',
                'apns-topic': this.topic,
                'apns-push-type': 'background',
                'apns-priority': '5',
                'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400),
                'apns-collapse-id': accountId
            });

            let timeout = setTimeout(() => {
                req.close();
                let err = new Error('APNs request timed out');
                log.error('APN', 'APNs request timed out token=%s...', deviceToken.slice(0, 4));
                this.loggelf({
                    short_message: '[APN] APNs request timed out',
                    _mail_action: 'apn_request_timeout',
                    _deviceToken: (deviceToken || '').slice(0, 4) + '...',
                    _error: err.message
                });
                reject(err);
            }, APN_REQUEST_TIMEOUT);

            req.setEncoding('utf8');

            let status;
            let body = '';

            req.on('response', headers => {
                status = headers[':status'];
            });

            req.on('data', chunk => {
                body += chunk;
            });

            req.on('end', () => {
                clearTimeout(timeout);
                let reason = null;
                if (body) {
                    try {
                        reason = JSON.parse(body).reason || null;
                    } catch (e) {
                        reason = body;
                    }
                }
                resolve({ status, reason });
            });

            req.on('error', err => {
                clearTimeout(timeout);
                reject(err);
            });

            req.end(payload);
        });
    }

    /**
     * Debounced notification entry point. Collects mailbox IDs per user
     * and flushes after a short delay to coalesce bursts.
     *
     * @param {ObjectId} user
     * @param {ObjectId} mailboxId
     */
    notify(user, mailboxId) {
        let userId = user.toString();

        if (!this._pending.has(userId)) {
            // keyed by id string to dedupe, value keeps the ObjectId for the query
            this._pending.set(userId, { user, mailboxIds: new Map() });
        }

        let entry = this._pending.get(userId);
        entry.mailboxIds.set(mailboxId.toString(), mailboxId);

        if (entry.timer) {
            clearTimeout(entry.timer);
        }

        entry.timer = setTimeout(() => {
            this._pending.delete(userId);
            this._flushNotifications(entry.user, [...entry.mailboxIds.values()]).catch(err => {
                log.error('APN', 'Flush error for user=%s: %s', userId, err.message);
                this.loggelf({
                    short_message: '[APN] Flush error',
                    _mail_action: 'apn_flush_error',
                    _user: userId,
                    _error: err.message
                });
            });
        }, APN_DEBOUNCE_DELAY);
        entry.timer.unref();
    }

    /**
     * Push to a user's devices for the given mailboxes, removing 410'd tokens.
     *
     * @param {ObjectId} user
     * @param {ObjectId[]} mailboxIds
     */
    async _flushNotifications(user, mailboxIds) {
        // on reconnect cooldown – skip quietly, the next new message re-triggers a flush
        if (this._reconnectAfter && Date.now() < this._reconnectAfter) {
            return;
        }

        let subscriptions;
        try {
            subscriptions = await this.database
                .collection('pushsubscriptions')
                .find(
                    {
                        user,
                        mailboxIds: mailboxIds.length === 1 ? mailboxIds[0] : { $in: mailboxIds }
                    },
                    {
                        maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
                    }
                )
                .toArray();
        } catch (err) {
            log.error('APN', 'Failed to query push subscriptions for user=%s: %s', user, err.message);
            this.loggelf({
                short_message: '[APN] Failed to query push subscriptions',
                _mail_action: 'apn_query_error',
                _user: user.toString(),
                _error: err.message
            });
            return;
        }

        if (!subscriptions.length) {
            return;
        }

        let staleTokenIds = [];

        let results = await Promise.allSettled(
            subscriptions.map(sub =>
                this._push(sub.deviceToken, sub.accountId).then(result => ({ sub, result }))
            )
        );

        for (let entry of results) {
            if (entry.status === 'rejected') {
                log.error('APN', 'Push notification error for user=%s: %s', user, entry.reason.message);
                this.loggelf({
                    short_message: '[APN] Push notification error',
                    _mail_action: 'apn_error',
                    _user: user.toString(),
                    _error: entry.reason.message
                });
                continue;
            }

            let { sub, result } = entry.value;

            if (result.status === 200) {
                log.verbose('APN', 'Push notification sent for user=%s token=%s...', user, sub.deviceToken.slice(0, 4));
                this.loggelf({
                    short_message: '[APN] Push notification sent',
                    _mail_action: 'apn_sent',
                    _user: user.toString(),
                    _deviceToken: sub.deviceToken.slice(0, 4) + '...'
                });
            } else if (result.status === 410) {
                // 410 Unregistered / ExpiredToken: APNs confirms the token is no longer valid for the topic
                log.info('APN', 'Device token expired, removing user=%s status=%s token=%s...', user, result.status, sub.deviceToken.slice(0, 4));
                this.loggelf({
                    short_message: '[APN] Device token expired, removing',
                    _mail_action: 'apn_token_expired',
                    _user: user.toString(),
                    _status: result.status,
                    _deviceToken: sub.deviceToken.slice(0, 4) + '...'
                });
                staleTokenIds.push(sub._id);
            } else if (result.status === 400 && result.reason === 'BadDeviceToken') {
                // 400 BadDeviceToken means this specific token is invalid (per-token, unlike topic/payload errors)
                log.info('APN', 'Bad device token, removing user=%s status=%s reason=%s token=%s...', user, result.status, result.reason, sub.deviceToken.slice(0, 4));
                this.loggelf({
                    short_message: '[APN] Bad device token, removing',
                    _mail_action: 'apn_token_invalid',
                    _user: user.toString(),
                    _status: result.status,
                    _reason: result.reason,
                    _deviceToken: sub.deviceToken.slice(0, 4) + '...'
                });
                staleTokenIds.push(sub._id);
            } else {
                log.error('APN', 'Push notification failed for user=%s status=%s reason=%s', user, result.status, result.reason);
                this.loggelf({
                    short_message: '[APN] Push notification failed',
                    _mail_action: 'apn_fail',
                    _user: user.toString(),
                    _status: result.status,
                    _reason: result.reason
                });
            }
        }

        if (staleTokenIds.length) {
            try {
                await this.database.collection('pushsubscriptions').deleteMany(
                    {
                        _id: { $in: staleTokenIds },
                        user
                    },
                    {
                        maxTimeMS: consts.DB_MAX_TIME_MAILBOXES
                    }
                );
            } catch (err) {
                log.error('APN', 'Failed to remove stale push tokens for user=%s: %s', user, err.message);
                this.loggelf({
                    short_message: '[APN] Failed to remove stale push tokens',
                    _mail_action: 'apn_cleanup_error',
                    _user: user.toString(),
                    _error: err.message
                });
            }
        }
    }

    close() {
        // clear pending debounce timers
        for (let entry of this._pending.values()) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
        }
        this._pending.clear();

        if (this._session) {
            this._session.close();
        }
        this._destroySession();
    }
}

module.exports = ApnClient;

let _instance = null;

/**
 * Get or create a shared ApnClient singleton.
 * Returns null if APS is not configured.
 *
 * @param {Object} options
 * @param {Object} options.config - imap.aps config section
 * @param {Object} options.database - MongoDB database handle
 * @param {Function} [options.loggelf] - Gelf logger
 * @returns {ApnClient|null}
 */
module.exports.get = function (options) {
    if (_instance) {
        return _instance;
    }

    let apsConfig = options.config || {};
    if (!apsConfig.enabled || !apsConfig.topic || !apsConfig.certPath || !apsConfig.keyPath) {
        return null;
    }

    let loggelf = options.loggelf || (() => false);

    // Relative cert/key paths are resolved against the configuration directory
    let resolvePath = p => (path.isAbsolute(p) ? p : path.join(config.configDirectory, p));

    try {
        _instance = new ApnClient({
            topic: apsConfig.topic,
            certPath: resolvePath(apsConfig.certPath),
            keyPath: resolvePath(apsConfig.keyPath),
            sandbox: apsConfig.sandbox || false,
            database: options.database,
            loggelf
        });
        log.info('APN', 'Apple Push Notification client initialized topic=%s mode=%s', apsConfig.topic, apsConfig.sandbox ? 'sandbox' : 'production');
        loggelf({
            short_message: '[APN] Apple Push Notification client initialized',
            _mail_action: 'apn_init',
            _topic: apsConfig.topic,
            _mode: apsConfig.sandbox ? 'sandbox' : 'production'
        });
    } catch (err) {
        log.error('APN', 'Failed to initialize APNs client: %s', err.message);
        loggelf({
            short_message: '[APN] Failed to initialize APNs client',
            _mail_action: 'apn_init_error',
            _error: err.message
        });
    }

    return _instance;
};
