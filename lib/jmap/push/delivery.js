'use strict';

// Web Push delivery for PushSubscriptions (RFC 8620 7.2), through the BullMQ queue `jmap_push`.
//
// Change detection is done on the write side. The Redis set jmap:push:users holds every user with a
// verified subscription. ImapNotifier.fire, which every change of a user goes through in every process,
// checks that set in one Lua call and, for a member, adds the user to the sorted set jmap:push:due (the
// first change wins, later ones are folded in). Every JMAP worker polls that sorted set, claims the
// users whose first change is `coalesce` seconds old (atomically, so each one is claimed once) and
// queues a `user` job for them. Nothing listens per user, nothing is registered per user, and the work
// is spread over all workers by the queue.
//
// The set is kept up to date where subscriptions change: a verification adds the user, a removal or a
// `user` job that finds no verified subscription removes it (and adds it back when one was verified in
// between). As a safety net, for example after Redis lost its data, one worker at a time (a marker key
// with a time to live) adds every user with a verified subscription again, reading them with an index
// backed cursor; a failed run is tried again with backoff.
//
// Jobs, run by every JMAP worker:
//   verify {id}               posts the PushVerification, retried with backoff a limited number of times
//   user {user}               reads the states once (of the subscribed types only) and queues `send`
//                             for each subscription with something new, with those states
//   revoke {user}             removes the subscriptions whose credentials are gone
//   send {id, states, retry}  posts a StateChange. One send per subscription runs at a time (a lock); a
//                             send that finds the lock taken leaves its states in a mark the running one
//                             picks up. A retry reads the states of the moment it runs, so it always
//                             carries the newest state
//
// Push URLs and keys stay in the subscription record, so removing a record removes them everywhere.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('npmlog');
const { ObjectId } = require('mongodb');
const { Queue, Worker, UnrecoverableError } = require('bullmq');
const metrics = require('../../metrics');
const { formatId } = require('../ids');
const webpush = require('./webpush');
const { pushSettings } = require('./settings');
const { readStates } = require('./states');
const { USERS_KEY, DUE_KEY } = require('./keys');
const store = require('./subscriptions');

const QUEUE = 'jmap_push';
// present while the users set is known to be complete; whoever creates it runs the full sync
const SYNC_KEY = 'jmap:push:synced';
const SYNC_INTERVAL = 3600;
const SYNC_TIME_MS = 5 * 60 * 1000;
const SYNC_BATCH = 1000;
const SYNC_RETRY_MIN = 5;
const SYNC_TICK = 5000;
const CLAIM_BATCH = 500;
const MAX_RETRY_AFTER = 3600;
const MAX_SUBSCRIPTIONS_READ = 1000;
const CLAIM_SCRIPT = fs.readFileSync(path.join(__dirname, '..', '..', 'lua', 'jmap-push-claim.lua'), 'utf-8');
// the user fields a push reads: the credential binding and the Quota state
const PUSH_USER_PROJECTION = Object.assign({ quota: true, storageUsed: true }, store.USER_PROJECTION);

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

/** The types a set of subscriptions wants: null (all) when one of them has no types list */
function wantedTypes(docs) {
    if (docs.some(doc => !doc.types)) {
        return null;
    }
    return [...new Set(docs.flatMap(doc => doc.types))];
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
        this.syncRetry = SYNC_RETRY_MIN;
        if (typeof this.redis.jmapPushClaim !== 'function') {
            this.redis.defineCommand('jmapPushClaim', { numberOfKeys: 1, lua: CLAIM_SCRIPT });
        }
    }

    async start() {
        this.queue = new Queue(QUEUE, this.deps.queueConf);
        metrics.registerBullQueue(QUEUE, this.queue);
        this.worker = new Worker(QUEUE, job => this.process(job), Object.assign({ concurrency: this.settings.concurrency }, this.deps.queueConf));
        this.worker.on('error', err => log.error('JMAP', 'push worker error=%s', err.message));
        metrics.trackBullWorker(QUEUE, this.worker);
        this.running = true;
        // half the coalescing delay, so a change waits between one and one and a half times that delay
        this.pollTimer = setInterval(() => this.poll(), Math.max(100, Math.round((this.settings.coalesce * 1000) / 2)));
        this.pollTimer.unref();
        this.syncTimer = setInterval(() => this.syncTick(), SYNC_TICK);
        this.syncTimer.unref();
        await this.syncTick();
    }

    async stop() {
        this.running = false;
        clearInterval(this.pollTimer);
        clearInterval(this.syncTimer);
        await Promise.all([this.worker && this.worker.close(), this.queue && this.queue.close()]);
    }

    // ---------------------------------------------------------------- change detection

    /** Queues the checks whose first change is at least `coalesce` seconds old */
    async poll() {
        if (this.polling || !this.running) {
            return;
        }
        this.polling = true;
        try {
            const due = await this.redis.jmapPushClaim(DUE_KEY, Date.now() - Math.round(this.settings.coalesce * 1000), CLAIM_BATCH);
            if (due && due.length) {
                await this.queueClaimed(due);
            }
        } catch (err) {
            log.error('JMAP', 'push poll error=%s', err.message);
        } finally {
            this.polling = false;
        }
    }

    async queueClaimed(due) {
        const jobs = due.map(member =>
            member.startsWith('r:')
                ? { name: 'revoke', data: { user: member.slice(2) }, opts: JOB_OPTIONS }
                : { name: 'user', data: { user: member }, opts: JOB_OPTIONS }
        );
        try {
            await this.queue.addBulk(jobs);
        } catch (err) {
            // claimed but not queued: put them back for the next poll
            const now = Date.now();
            await this.redis.zadd(DUE_KEY, 'NX', ...due.flatMap(member => [now, member])).catch(() => false);
            throw err;
        }
    }

    /**
     * Runs the full sync of the users set when no worker did it within the sync interval (or Redis lost
     * the marker together with the set). A failed run lets another try after a growing delay.
     */
    async syncTick() {
        if (this.syncing || !this.running) {
            return;
        }
        this.syncing = true;
        try {
            if (await this.redis.set(SYNC_KEY, this.identity, 'EX', SYNC_INTERVAL, 'NX')) {
                try {
                    const count = await this.syncUsers();
                    this.syncRetry = SYNC_RETRY_MIN;
                    log.info('JMAP', 'push users synced id=%s users=%s', this.identity, count);
                } catch (err) {
                    log.error('JMAP', 'push users sync failed, retry in %ss error=%s', this.syncRetry, err.message);
                    await this.redis.set(SYNC_KEY, 'retry', 'EX', this.syncRetry).catch(() => false);
                    this.syncRetry = Math.min(this.syncRetry * 2, SYNC_INTERVAL);
                }
            }
        } catch (err) {
            log.error('JMAP', 'push sync error=%s', err.message);
        } finally {
            this.syncing = false;
        }
    }

    /** Adds every user with a verified subscription to the users set; answers how many there are */
    async syncUsers() {
        const cursor = store
            .collection(this.deps)
            .find({ verified: true }, { projection: { _id: false, user: true }, maxTimeMS: SYNC_TIME_MS })
            .sort({ user: 1 })
            .hint('verified_user');
        let batch = [];
        let last = null;
        let count = 0;
        for await (const doc of cursor) {
            const user = doc.user.toString();
            if (user === last) {
                continue;
            }
            last = user;
            batch.push(user);
            count++;
            if (batch.length >= SYNC_BATCH) {
                await this.redis.sadd(USERS_KEY, ...batch);
                batch = [];
            }
        }
        if (batch.length) {
            await this.redis.sadd(USERS_KEY, ...batch);
        }
        return count;
    }

    /**
     * Brings the users set in line with the subscriptions of one user. Removing is followed by a recount,
     * so a subscription verified at the same time is never left out.
     */
    async syncUser(user) {
        const userId = new ObjectId(user);
        const hasVerified = () =>
            store.collection(this.deps).countDocuments({ user: userId, verified: true }, { limit: 1, maxTimeMS: store.MAX_TIME_MS, hint: 'verified_user' });
        if (await hasVerified()) {
            await this.redis.sadd(USERS_KEY, userId.toString());
            return true;
        }
        await this.redis.srem(USERS_KEY, userId.toString());
        if (await hasVerified()) {
            await this.redis.sadd(USERS_KEY, userId.toString());
            return true;
        }
        return false;
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

    /** A user gained or may have lost verified subscriptions; a gained one is checked at once for changes */
    async changed(user) {
        if ((await this.syncUser(user)) && this.queue) {
            await this.queue.add('user', { user: user.toString() }, JOB_OPTIONS);
        }
    }

    /** The current push states of a user (of the given types, all when null) */
    statesOf(user, options = {}) {
        const context = {
            account: { id: formatId('account', user), user, userData: options.userData || { _id: user } },
            deps: this.deps,
            options: this.options,
            limits: {},
            cache: {}
        };
        // the Quota state reads the user document a push has already read
        return readStates(this.deps.modules, context, { types: options.types, cache: options.userData ? { quotaUser: options.userData } : {} });
    }

    // ---------------------------------------------------------------- jobs

    async process(job) {
        switch (job.name) {
            case 'verify':
                return this.verify(job);
            case 'user':
                return this.userChanged(job.data.user);
            case 'revoke':
                return this.revoke(job.data.user);
            case 'send':
                return this.send(job.data.id, !!job.data.retry, job.data.states || null);
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
            await this.syncUser(doc.user);
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

    /** Reads the states once (of the subscribed types) and queues a send for every subscription they change */
    async userChanged(user) {
        if (!/^[0-9a-f]{24}$/.test(user || '')) {
            return;
        }
        const userId = new ObjectId(user);
        const docs = await store
            .collection(this.deps)
            .find({ user: userId, verified: true }, { projection: { _id: true, types: true, pushed: true }, maxTimeMS: store.MAX_TIME_MS })
            .limit(MAX_SUBSCRIPTIONS_READ)
            .toArray();
        if (!docs.length) {
            await this.syncUser(userId);
            return;
        }
        const states = await this.statesOf(userId, { types: wantedTypes(docs) });
        const due = docs.filter(doc => changedTypes(states, doc).length);
        if (due.length) {
            await this.queue.addBulk(due.map(doc => ({ name: 'send', data: { id: doc._id.toString(), states }, opts: JOB_OPTIONS })));
        }
    }

    /** After a credential change: removes the subscriptions whose credentials are gone */
    async revoke(user) {
        if (!/^[0-9a-f]{24}$/.test(user || '')) {
            return;
        }
        if (await store.removeRevoked(this.deps, new ObjectId(user), { tokenLifetime: this.options.tokenLifetime })) {
            await this.syncUser(user);
        }
    }

    /**
     * Pushes the newest states to one subscription. Sends of the same subscription never overlap: the
     * mark (dirty key) is set first, and whoever holds the lock keeps sending while a mark is there. The
     * mark holds the states read by the `user` job ('1' when they are read when sending: retries).
     */
    async send(id, retry, states) {
        const token = crypto.randomBytes(8).toString('hex');
        const lockTtl = (this.settings.timeout + 30) * 1000;
        await this.redis.set(dirtyKey(id), states && !retry ? JSON.stringify(states) : '1', 'PX', 3600 * 1000);
        const takeMark = async () => {
            const [[, value]] = await this.redis.multi().get(dirtyKey(id)).del(dirtyKey(id)).exec();
            return value;
        };
        for (;;) {
            if (!(await this.redis.set(lockKey(id), token, 'PX', lockTtl, 'NX'))) {
                // the holder sees the mark
                return;
            }
            try {
                for (let mark = await takeMark(); mark; mark = await takeMark()) {
                    await this.redis.pexpire(lockKey(id), lockTtl);
                    await this.deliver(id, retry, mark === '1' ? null : JSON.parse(mark));
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

    /** Posts a StateChange with `states`, or with the states read now when null */
    async deliver(id, retry, states) {
        const doc = await this.loadLive(id);
        const now = new Date();
        if (!doc || !doc.verified || (!retry && doc.retryAt && doc.retryAt > now)) {
            // a scheduled retry carries this change too
            return;
        }
        const userData = await this.deps.users
            .collection('users')
            .findOne({ _id: doc.user }, { projection: PUSH_USER_PROJECTION, maxTimeMS: store.MAX_TIME_MS });
        const binding = await store.bindingOf(this.deps, doc, { tokenLifetime: this.options.tokenLifetime, userData });
        if (binding === 'revoked') {
            return this.remove(doc);
        }
        if (binding === 'inactive') {
            return;
        }
        if (!states) {
            states = await this.statesOf(doc.user, { types: doc.types, userData });
        }
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

module.exports = { PushService, outcomeOf, retryAfterOf, changedTypes, wantedTypes, backoff, QUEUE };
