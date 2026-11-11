'use strict';

// Web Push delivery for PushSubscriptions (RFC 8620 7.2), through the BullMQ queue `jmap_push`.
//
// Change detection. One JMAP worker at a time is the dispatcher (a Redis lock renewed every few
// seconds). It holds a change listener on the notifier for every user with a verified subscription, so
// change notifications reach it in either notifier mode (broadcast or per worker channels). A change
// queues one delayed `user` job per user; further changes in that delay are folded into it.
//
// Jobs, run by every JMAP worker:
//   verify {id}       posts the PushVerification, retried with backoff a limited number of times
//   user {user}       reads the states once and queues `send` for each subscription with something new
//   send {id, retry}  posts a StateChange with the states of the moment it runs, so a retry always
//                     carries the newest state. One send per subscription runs at a time (a lock); a
//                     send that finds the lock taken leaves a mark the running one picks up
//
// Job data holds ids only; push URLs and keys stay in the subscription record, so removing a record
// removes them everywhere.

const crypto = require('crypto');
const os = require('os');
const log = require('npmlog');
const { ObjectId } = require('mongodb');
const { Queue, Worker, UnrecoverableError } = require('bullmq');
const metrics = require('../../metrics');
const { formatId } = require('../ids');
const webpush = require('./webpush');
const { pushSettings } = require('./settings');
const store = require('./subscriptions');

const QUEUE = 'jmap_push';
const LEADER_KEY = 'jmap:push:leader';
const LEADER_TTL = 15;
const RESYNC_INTERVAL = 5 * 60 * 1000;
const RESYNC_TIME_MS = 60 * 1000;
// notifier "user" of the control messages for the dispatcher
const CONTROL = 'jmap-push';
const CREDENTIAL_COMMANDS = new Set(['LOGOUT', 'ASPDELETE', 'CREDENTIALS']);
const MAX_RETRY_AFTER = 3600;
const MAX_SUBSCRIPTIONS_READ = 1000;

const pendingKey = user => `jmap:push:pend:${user}`;
const dirtyKey = id => `jmap:push:dirty:${id}`;
const lockKey = id => `jmap:push:lock:${id}`;

const JOB_OPTIONS = { removeOnComplete: true, removeOnFail: true };

/** The seconds of a Retry-After header (delta seconds or an HTTP date), or 0 */
function retryAfterOf(value) {
    if (!value) {
        return 0;
    }
    const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER) : 0;
}

/**
 * Classifies the answer of a push service: ok (any 2xx), gone (404, 410: the subscription is dead),
 * throttled (429), retry (5xx, connection errors, timeouts) or failed (redirects, other 4xx).
 */
function outcomeOf(result) {
    if (result.error) {
        return { kind: result.error instanceof webpush.TargetError ? 'failed' : 'retry', retryAfter: 0 };
    }
    const status = result.status;
    const retryAfter = retryAfterOf(result.headers && result.headers['retry-after']);
    if (status >= 200 && status < 300) {
        return { kind: 'ok' };
    }
    if (status === 404 || status === 410) {
        return { kind: 'gone' };
    }
    if (status === 429) {
        return { kind: 'throttled', retryAfter };
    }
    if (status >= 500) {
        return { kind: 'retry', retryAfter };
    }
    return { kind: 'failed' };
}

/** Delay before retry number `attempt` (1 based), in seconds */
const backoff = (settings, attempt) => Math.min(settings.retryDelay * 2 ** Math.max(attempt - 1, 0), settings.maxRetryDelay);

/** The types whose state differs from the last push, limited to the subscribed types */
function changedTypes(states, doc) {
    const pushed = doc.pushed || {};
    return Object.keys(states).filter(type => (!doc.types || doc.types.includes(type)) && states[type] !== pushed[type]);
}

class PushService {
    /**
     * @param {Object} deps the service dependencies (database, users, redis, notifier, modules, queueConf)
     * @param {Object} options the [jmap] options plus accessSecret, tokenLifetime
     * @param {VapidKeys} vapid
     */
    constructor(deps, options, vapid) {
        this.deps = deps;
        this.options = options;
        this.settings = pushSettings(options);
        this.vapid = vapid;
        this.redis = deps.redis;
        this.identity = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
        this.leading = false;
        this.listeners = new Map();
        this.pushModules = (deps.modules || []).filter(module => module.pushStates);
    }

    async start() {
        this.queue = new Queue(QUEUE, this.deps.queueConf);
        metrics.registerBullQueue(QUEUE, this.queue);
        this.worker = new Worker(QUEUE, job => this.process(job), Object.assign({ concurrency: this.settings.concurrency }, this.deps.queueConf));
        this.worker.on('error', err => log.error('JMAP', 'push worker error=%s', err.message));
        metrics.trackBullWorker(QUEUE, this.worker);
        await this.tick();
        this.timer = setInterval(() => this.tick(), (LEADER_TTL / 3) * 1000);
        this.timer.unref();
    }

    async stop() {
        clearInterval(this.timer);
        await this.resign();
        await Promise.all([this.worker && this.worker.close(), this.queue && this.queue.close()]);
    }

    // ---------------------------------------------------------------- dispatcher

    async tick() {
        if (this.ticking) {
            return;
        }
        this.ticking = true;
        try {
            const held = await this.deps.notifier.counters.processlock(LEADER_KEY, this.identity, LEADER_TTL);
            if (held && !this.leading) {
                await this.lead();
            } else if (!held && this.leading) {
                this.dropListeners();
            } else if (held && Date.now() - this.synced > RESYNC_INTERVAL) {
                await this.resync();
            }
        } catch (err) {
            log.error('JMAP', 'push dispatcher error=%s', err.message);
        } finally {
            this.ticking = false;
        }
    }

    async lead() {
        this.leading = true;
        this.control = message => this.onControl(message).catch(err => log.error('JMAP', 'push control error=%s', err.message));
        this.deps.notifier.addListener({ id: 'jmap-push', user: { id: CONTROL } }, this.control);
        await this.resync();
        log.info('JMAP', 'push dispatcher started id=%s users=%s', this.identity, this.listeners.size);
    }

    async resign() {
        if (!this.leading) {
            return;
        }
        this.dropListeners();
        if ((await this.redis.get(LEADER_KEY).catch(() => null)) === this.identity) {
            await this.redis.del(LEADER_KEY).catch(() => false);
        }
    }

    dropListeners() {
        this.leading = false;
        for (const user of [...this.listeners.keys()]) {
            this.unlisten(user);
        }
        if (this.control) {
            this.deps.notifier.removeListener({ id: 'jmap-push', user: { id: CONTROL } }, this.control);
            this.control = null;
        }
    }

    /** Listens for every user with a verified subscription, and for no other */
    async resync() {
        this.synced = Date.now();
        const users = new Set(
            (await store.collection(this.deps).distinct('user', { verified: true }, { maxTimeMS: RESYNC_TIME_MS })).map(user => user.toString())
        );
        for (const user of users) {
            this.listen(user);
        }
        for (const user of [...this.listeners.keys()]) {
            if (!users.has(user)) {
                this.unlisten(user);
            }
        }
    }

    /** Starts listening for a user; answers true when it was not listening before */
    listen(user) {
        if (!this.leading || this.listeners.has(user)) {
            return false;
        }
        const handler = payload => this.onUserEvent(user, payload).catch(err => log.error('JMAP', 'push dispatch user=%s error=%s', user, err.message));
        this.listeners.set(user, handler);
        this.deps.notifier.addListener({ id: 'jmap-push', user: { id: user } }, handler);
        return true;
    }

    unlisten(user) {
        const handler = this.listeners.get(user);
        if (handler) {
            this.listeners.delete(user);
            this.deps.notifier.removeListener({ id: 'jmap-push', user: { id: user } }, handler);
        }
    }

    async onControl(message) {
        if (!message || message.command !== 'JMAPPUSH' || !/^[0-9a-f]{24}$/.test(message.user || '')) {
            return;
        }
        const verified = await store
            .collection(this.deps)
            .countDocuments({ user: new ObjectId(message.user), verified: true }, { limit: 1, maxTimeMS: store.MAX_TIME_MS });
        if (!verified) {
            return this.unlisten(message.user);
        }
        if (this.listen(message.user)) {
            // a change made between the verification and this point found no listener
            await this.onUserEvent(message.user);
        }
    }

    async onUserEvent(user, payload) {
        if (payload && CREDENTIAL_COMMANDS.has(payload.command)) {
            await store.removeRevoked(this.deps, new ObjectId(user), { tokenLifetime: this.options.tokenLifetime });
            return this.onControl({ command: 'JMAPPUSH', user });
        }
        if (payload) {
            return;
        }
        const delay = Math.round(this.settings.coalesce * 1000);
        if (await this.redis.set(pendingKey(user), '1', 'PX', delay + 60 * 1000, 'NX')) {
            await this.queue.add('user', { user }, Object.assign({ delay }, JOB_OPTIONS));
        }
    }

    // ---------------------------------------------------------------- API side

    /** Queues the PushVerification of a new subscription */
    async verificationCreated(id) {
        await this.queue.add(
            'verify',
            { id: id.toString() },
            Object.assign({ attempts: this.settings.verifyAttempts, backoff: { type: 'exponential', delay: this.settings.retryDelay * 1000 } }, JOB_OPTIONS)
        );
    }

    /** Tells the dispatcher that a user gained or may have lost verified subscriptions */
    changed(user) {
        this.deps.notifier.fire(CONTROL, { command: 'JMAPPUSH', user: user.toString() });
    }

    /** The current push states of a user, as the event source reads them */
    async statesOf(user, userData) {
        const context = {
            account: { id: formatId('account', user), user, userData: userData || { _id: user } },
            deps: this.deps,
            options: this.options,
            limits: {},
            cache: {}
        };
        const parts = await Promise.all(this.pushModules.map(module => module.pushStates(context)));
        return Object.assign({}, ...parts);
    }

    // ---------------------------------------------------------------- jobs

    async process(job) {
        switch (job.name) {
            case 'verify':
                return this.verify(job);
            case 'user':
                return this.userChanged(job.data.user);
            case 'send':
                return this.send(job.data.id, !!job.data.retry);
        }
    }

    async loadLive(id) {
        if (!/^[0-9a-f]{24}$/.test(id || '')) {
            return null;
        }
        const doc = await store.collection(this.deps).findOne({ _id: new ObjectId(id) }, { maxTimeMS: store.MAX_TIME_MS });
        if (!doc) {
            return null;
        }
        // a subscription that expired, or was made under a VAPID key that has been rotated away (RFC 9749 5)
        if (!store.alive(doc, new Date()) || (doc.vapid && this.vapid.current && doc.vapid !== this.vapid.current.id)) {
            await this.remove(doc);
            return null;
        }
        return doc;
    }

    async remove(doc) {
        await store.collection(this.deps).deleteOne({ _id: doc._id, user: doc.user });
        await this.redis.del(dirtyKey(doc._id), lockKey(doc._id)).catch(() => false);
        if (doc.verified) {
            this.changed(doc.user);
        }
    }

    async verify(job) {
        const doc = await this.loadLive(job.data.id);
        if (!doc || doc.verified) {
            return;
        }
        const payload = { '@type': 'PushVerification', pushSubscriptionId: formatId('pushSubscription', doc._id), verificationCode: doc.verificationCode };
        const outcome = outcomeOf(await this.post(doc, payload, {}));
        if (outcome.kind === 'ok') {
            return;
        }
        if (outcome.kind === 'gone') {
            return this.remove(doc);
        }
        if (outcome.kind === 'failed') {
            // RFC 9749 6: a rejected PushVerification is not retried
            throw new UnrecoverableError('push verification rejected');
        }
        throw new Error('push verification failed');
    }

    async userChanged(user) {
        await this.redis.del(pendingKey(user));
        const userId = new ObjectId(user);
        const docs = await store
            .collection(this.deps)
            .find({ user: userId, verified: true }, { projection: { _id: true, types: true, pushed: true }, maxTimeMS: store.MAX_TIME_MS })
            .limit(MAX_SUBSCRIPTIONS_READ)
            .toArray();
        if (!docs.length) {
            return this.changed(userId);
        }
        const states = await this.statesOf(userId);
        const due = docs.filter(doc => changedTypes(states, doc).length);
        if (due.length) {
            await this.queue.addBulk(due.map(doc => ({ name: 'send', data: { id: doc._id.toString() }, opts: JOB_OPTIONS })));
        }
    }

    /**
     * Pushes the newest states to one subscription. Sends of the same subscription never overlap: the
     * mark (dirty key) is set first, and whoever holds the lock keeps sending while a mark is there.
     */
    async send(id, retry) {
        const token = crypto.randomBytes(8).toString('hex');
        const lockTtl = (this.settings.timeout + 30) * 1000;
        await this.redis.set(dirtyKey(id), '1', 'PX', 3600 * 1000);
        for (;;) {
            if (!(await this.redis.set(lockKey(id), token, 'PX', lockTtl, 'NX'))) {
                // the holder sees the mark
                return;
            }
            try {
                while (await this.redis.del(dirtyKey(id))) {
                    await this.redis.pexpire(lockKey(id), lockTtl);
                    await this.deliver(id, retry);
                    retry = false;
                }
            } finally {
                if ((await this.redis.get(lockKey(id))) === token) {
                    await this.redis.del(lockKey(id));
                }
            }
            // a mark set between the last check and the release
            if (!(await this.redis.exists(dirtyKey(id)))) {
                return;
            }
        }
    }

    async deliver(id, retry) {
        const doc = await this.loadLive(id);
        const now = new Date();
        if (!doc || !doc.verified || (!retry && doc.retryAt && doc.retryAt > now)) {
            // a scheduled retry carries this change too
            return;
        }
        const binding = await store.bindingOf(this.deps, doc, { tokenLifetime: this.options.tokenLifetime });
        if (binding === 'revoked') {
            return this.remove(doc);
        }
        if (binding === 'inactive') {
            return;
        }
        const states = await this.statesOf(doc.user);
        const types = changedTypes(states, doc);
        if (!types.length) {
            if (doc.retryAt) {
                await store.collection(this.deps).updateOne({ _id: doc._id }, { $set: { retryAt: null, attempt: 0 } });
            }
            return;
        }
        const changed = Object.fromEntries(types.map(type => [type, states[type]]));
        const payload = { '@type': 'StateChange', changed: { [formatId('account', doc.user)]: changed } };
        const headers = { urgency: types.includes('EmailDelivery') ? 'high' : 'normal', topic: true };
        const outcome = outcomeOf(await this.post(doc, payload, headers));
        return this.record(doc, outcome, states);
    }

    /** Records the outcome of a push: success, retry later, a failed push, or the end of the subscription */
    async record(doc, outcome, states) {
        const subscriptions = store.collection(this.deps);
        const settings = this.settings;
        if (outcome.kind === 'ok') {
            await subscriptions.updateOne({ _id: doc._id }, { $set: { pushed: states, failures: 0, attempt: 0, retryAt: null } });
            return;
        }
        if (outcome.kind === 'gone') {
            return this.remove(doc);
        }
        const attempt = (doc.attempt || 0) + 1;
        // 429 is never given up (the interval keeps growing up to the ceiling); other errors are
        // retried a few times and then count as one failed push
        if (outcome.kind === 'throttled' || (outcome.kind === 'retry' && attempt < settings.attempts)) {
            const delay = Math.max(backoff(settings, attempt), outcome.retryAfter || 0);
            const retryAt = new Date(Date.now() + delay * 1000);
            await subscriptions.updateOne({ _id: doc._id }, { $set: { attempt, retryAt } });
            await this.queue.add('send', { id: doc._id.toString(), retry: true }, Object.assign({ delay: delay * 1000 }, JOB_OPTIONS));
            return;
        }
        const failures = (doc.failures || 0) + 1;
        if (failures >= settings.failureLimit) {
            log.info('JMAP', 'push subscription removed after %s failed pushes user=%s', failures, doc.user);
            return this.remove(doc);
        }
        await subscriptions.updateOne({ _id: doc._id }, { $set: { failures, attempt: 0, retryAt: null } });
    }

    /**
     * POSTs a push message to the subscription URL: JSON, encrypted when the subscription has keys,
     * signed with VAPID. Answers {status, headers} or {error}.
     */
    async post(doc, payload, options) {
        const settings = this.settings;
        try {
            const url = webpush.parsePushUrl(doc.url);
            if (!url) {
                throw new webpush.TargetError('invalid push URL');
            }
            const target = await webpush.resolveTarget(url, { allowHosts: settings.allowHosts, resolve: settings.resolve });
            let body = Buffer.from(JSON.stringify(payload));
            const headers = { 'Content-Type': 'application/json', TTL: String(settings.ttl) };
            if (doc.keys) {
                body = webpush.encrypt(body, doc.keys);
                headers['Content-Encoding'] = 'aes128gcm';
            }
            if (this.vapid.current) {
                headers.Authorization = webpush.vapidAuthorization(this.vapid.current, doc.url, settings.vapidSubject);
            }
            if (options.urgency) {
                headers.Urgency = options.urgency;
            }
            if (options.topic) {
                // one Topic per subscription: a push service keeps only the newest undelivered StateChange
                headers.Topic = crypto
                    .createHmac('sha256', this.options.accessSecret || '')
                    .update(doc._id.toString())
                    .digest('base64url')
                    .slice(0, 22);
            }
            return await webpush.post(url, target, body, headers, { timeout: settings.timeout * 1000, ca: settings.tlsCa });
        } catch (err) {
            log.verbose('JMAP', 'push subscription=%s user=%s error=%s', doc._id, doc.user, err.message);
            return { error: err };
        }
    }
}

module.exports = { PushService, outcomeOf, retryAfterOf, changedTypes, backoff, QUEUE };
