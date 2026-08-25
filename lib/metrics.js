'use strict';

const cluster = require('cluster');
const promClient = require('prom-client');
const config = require('@zone-eu/wild-config');
const packageData = require('../package.json');

const DEFAULT_METRICS_SYMBOL = Symbol.for('wildduck.metrics.defaultMetrics');
const MASTER_LISTENER_SYMBOL = Symbol.for('wildduck.metrics.masterListener');

const CLUSTER_REQ = 'wildduck:metrics:req';
const CLUSTER_RES = 'wildduck:metrics:res';
const CLUSTER_COLLECTOR = 'wildduck:metrics:collector';

const DEFAULT_SERVICE = 'unknown';
const DEFAULT_RESULT = 'unknown';
const METRICS_ENABLED = config.metrics?.enabled === true;
const configuredCollectCacheTtl = Number(config.metrics?.collectCacheTtl);
const COLLECT_CACHE_TTL = Number.isFinite(configuredCollectCacheTtl) && configuredCollectCacheTtl >= 0 ? configuredCollectCacheTtl : 10 * 1000;
const AUTH_SERVICES = new Set(['api', 'imap', 'pop3', 'smtp', 'lmtp', DEFAULT_SERVICE]);
const AUTH_SCOPES = new Set(['master', 'imap', 'pop3', 'smtp', 'unknown']);
const AUTH_RESULTS = new Set(['success', 'fail', 'ratelimited', 'error', DEFAULT_RESULT]);
const IMAP_COMMANDS = new Set([
    'noop',
    'capability',
    'logout',
    'id',
    'starttls',
    'login',
    'authenticate_plain',
    'authenticate_plain-clienttoken',
    'namespace',
    'list',
    'xlist',
    'lsub',
    'subscribe',
    'unsubscribe',
    'create',
    'delete',
    'rename',
    'select',
    'examine',
    'idle',
    'check',
    'status',
    'append',
    'store',
    'uid_store',
    'expunge',
    'uid_expunge',
    'close',
    'unselect',
    'copy',
    'uid_copy',
    'move',
    'uid_move',
    'fetch',
    'uid_fetch',
    'search',
    'uid_search',
    'enable',
    'getquotaroot',
    'setquota',
    'getquota',
    'compress',
    'xapplepushservice'
]);
const POP3_COMMANDS = new Set(['capa', 'user', 'pass', 'auth', 'noop', 'quit', 'stat', 'list', 'uidl', 'dele', 'rset', 'retr', 'top', 'stls']);
const COMMAND_RESULTS = new Set(['ok', 'no', 'bad', 'error']);
const MESSAGE_SOURCES = new Map([
    ['api', 'api'],
    ['rest', 'api'],
    ['upload', 'api'],
    ['imap', 'imap'],
    ['append', 'imap'],
    ['pop3', 'pop3'],
    ['lmtp', 'lmtp'],
    ['mx', 'lmtp'],
    ['smtp', 'smtp'],
    ['esmtp', 'smtp'],
    ['esmtps', 'smtp'],
    ['esmtpa', 'smtp'],
    ['esmtpsa', 'smtp'],
    ['task', 'task'],
    ['auto', 'auto'],
    ['unknown', 'unknown']
]);
const KNOWN_SERVICES = ['tasks', 'webhooks', 'search_indexer', 'imap', 'pop3', 'lmtp', 'api', 'metrics'];
const NOOP = () => false;
const NOOP_START = () => NOOP;
const NOOP_GET_METRICS = async () => '';
const enabledHandler = (handler, fallback = NOOP) => (METRICS_ENABLED ? handler : fallback);
const NOOP_METRIC = {
    inc() {},
    observe() {},
    reset() {},
    set() {}
};

const activeConnections = new Map();
const serviceStates = new Map(KNOWN_SERVICES.map(service => [service, 0]));
const bullQueues = new Map();
let taskDatabase = false;
let requestSeq = 0;
let workerListenerAdded = false;
let expensiveCollectorEnabled = !cluster.isWorker;
const pendingRequests = new Map();
const taskCountsCache = { value: [], expires: 0, pending: false };
const bullQueueCountsCache = { value: [], expires: 0, pending: false };

if (METRICS_ENABLED && !global[DEFAULT_METRICS_SYMBOL]) {
    promClient.collectDefaultMetrics();
    global[DEFAULT_METRICS_SYMBOL] = true;
}

const aggregatorRegistry = METRICS_ENABLED ? new promClient.AggregatorRegistry() : false;

/**
 * Gets an existing Prometheus metric by name or creates it when missing.
 *
 * @param {Function} Type Prometheus metric constructor to instantiate when the metric is not registered yet.
 * @param {Object} options Prometheus metric options, including the metric name.
 * @returns {Object} Existing or newly created Prometheus metric instance.
 */
function getMetric(Type, options) {
    if (!METRICS_ENABLED) {
        return NOOP_METRIC;
    }
    let existing = promClient.register.getSingleMetric(options.name);
    if (existing) {
        return existing;
    }
    return new Type(options);
}

/**
 * Normalizes a metric label value into a bounded Prometheus-safe label.
 *
 * @param {*} value Raw label value.
 * @param {String} fallback Label value to use when the raw value is empty or invalid.
 * @returns {String} Normalized label value.
 */
function cleanLabel(value, fallback) {
    value = (value || fallback || '').toString().trim().toLowerCase();
    if (!value) {
        return fallback || DEFAULT_RESULT;
    }
    value = value.replace(/[^a-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
    if (!value || value.length > 64) {
        return fallback || DEFAULT_RESULT;
    }
    return value;
}

/**
 * Normalizes a protocol command into a fixed-cardinality label.
 *
 * @param {*} command Raw protocol command.
 * @param {Set<String>} allowedCommands Commands implemented by the protocol server.
 * @returns {String} Known command label, or "other" for malformed and unsupported input.
 */
function cleanCommand(command, allowedCommands) {
    command = cleanLabel(command, 'other');
    return allowedCommands.has(command) ? command : 'other';
}

/**
 * Normalizes a protocol command result into a fixed-cardinality label.
 *
 * @param {*} result Raw command result.
 * @returns {String} Protocol result label.
 */
function cleanCommandResult(result) {
    result = cleanLabel(result, 'error');
    return COMMAND_RESULTS.has(result) ? result : 'error';
}

/**
 * Normalizes an HTTP status code for use as a metric label.
 *
 * @param {*} statusCode Raw HTTP status code.
 * @returns {String} Three-digit status code, or "000" when invalid.
 */
function cleanStatus(statusCode) {
    statusCode = Number(statusCode) || 0;
    if (statusCode < 100 || statusCode > 999) {
        return '000';
    }
    return String(statusCode);
}

/**
 * Converts an HTTP status code into a status class label.
 *
 * @param {*} statusCode Raw HTTP status code.
 * @returns {String} Status class such as "2xx", or "unknown" when invalid.
 */
function cleanStatusClass(statusCode) {
    statusCode = Number(statusCode) || 0;
    if (statusCode < 100 || statusCode > 999) {
        return 'unknown';
    }
    return Math.floor(statusCode / 100) + 'xx';
}

/**
 * Normalizes an API route label and removes query parameters.
 *
 * @param {*} route Raw route value.
 * @returns {String} Route label, or "unknown" when invalid.
 */
function cleanRoute(route) {
    route = (route || '').toString().trim();
    if (!route || route.length > 160) {
        return 'unknown';
    }
    return route.replace(/\?.*$/, '');
}

/**
 * Resolves a message operation source from direct input, metadata, or session details.
 *
 * @param {String|Object} options Source string or options object containing metadata/session fields.
 * @returns {String} Normalized source label.
 */
function normalizeSource(options) {
    let source = false;

    if (typeof options === 'string') {
        source = options;
    } else if (options && options.meta) {
        source = options.meta.source || options.meta.transtype || false;
    }

    if (!source && options && options.session) {
        if (options.session.writeStream) {
            source = 'imap';
        } else if (options.session.listing) {
            source = 'pop3';
        }
    }

    source = cleanLabel(source, 'unknown');
    return MESSAGE_SOURCES.get(source) || 'unknown';
}

/**
 * Calculates elapsed seconds from a process.hrtime start tuple.
 *
 * @param {Array<Number>} start Start tuple returned by process.hrtime().
 * @returns {Number} Elapsed time in seconds.
 */
function durationSeconds(start) {
    let diff = process.hrtime(start);
    return diff[0] + diff[1] / 1e9;
}

/**
 * Loads an expensive collector value at most once per cache interval and shares concurrent refreshes.
 * Failed refreshes retain the last successful value and are retried after the same interval.
 *
 * @param {Object} cache Mutable cache state.
 * @param {Function} loader Async value loader.
 * @returns {Promise<Array>} Cached or freshly loaded collector rows.
 */
function getCachedCollectorRows(cache, loader) {
    if (cache.expires > Date.now()) {
        return Promise.resolve(cache.value);
    }

    if (cache.pending) {
        return cache.pending;
    }

    cache.pending = Promise.resolve()
        .then(loader)
        .then(value => {
            cache.value = Array.isArray(value) ? value : [];
            return cache.value;
        })
        .catch(() => cache.value)
        .finally(() => {
            cache.expires = Date.now() + COLLECT_CACHE_TTL;
            cache.pending = false;
        });

    return cache.pending;
}

getMetric(promClient.Gauge, {
    name: 'wildduck_info',
    help: 'WildDuck build information',
    labelNames: ['version'],
    aggregator: 'first',
    /**
     * Publishes static WildDuck build information.
     *
     * @returns {void}
     */
    collect() {
        this.reset();
        this.set({ version: packageData.version }, 1);
    }
});

getMetric(promClient.Gauge, {
    name: 'wildduck_service_up',
    help: 'WildDuck service startup state',
    labelNames: ['service'],
    aggregator: 'min',
    /**
     * Publishes current startup state for known WildDuck services.
     *
     * @returns {void}
     */
    collect() {
        this.reset();
        for (let [service, value] of serviceStates) {
            this.set({ service }, value ? 1 : 0);
        }
    }
});

const apiRequests = getMetric(promClient.Counter, {
    name: 'wildduck_api_requests_total',
    help: 'WildDuck API requests',
    labelNames: ['method', 'route', 'status']
});

const apiRequestDuration = getMetric(promClient.Histogram, {
    name: 'wildduck_api_request_duration_seconds',
    help: 'WildDuck API request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});

const apiErrors = getMetric(promClient.Counter, {
    name: 'wildduck_api_errors_total',
    help: 'WildDuck API errors',
    labelNames: ['method', 'route', 'code']
});

const authAttempts = getMetric(promClient.Counter, {
    name: 'wildduck_auth_attempts_total',
    help: 'Authentication attempts',
    labelNames: ['service', 'scope', 'result']
});

getMetric(promClient.Gauge, {
    name: 'wildduck_connections',
    help: 'Active protocol connections',
    labelNames: ['service'],
    /**
     * Publishes active protocol connection counts by service.
     *
     * @returns {void}
     */
    collect() {
        this.reset();
        for (let [service, count] of activeConnections) {
            this.set({ service }, count);
        }
    }
});

const connectionCounter = getMetric(promClient.Counter, {
    name: 'wildduck_connections_total',
    help: 'Accepted protocol connections',
    labelNames: ['service', 'secure']
});

const imapCommands = getMetric(promClient.Counter, {
    name: 'wildduck_imap_commands_total',
    help: 'IMAP commands',
    labelNames: ['command', 'result']
});

const imapCommandDuration = getMetric(promClient.Histogram, {
    name: 'wildduck_imap_command_duration_seconds',
    help: 'IMAP command duration',
    labelNames: ['command', 'result'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});

const pop3Commands = getMetric(promClient.Counter, {
    name: 'wildduck_pop3_commands_total',
    help: 'POP3 commands',
    labelNames: ['command', 'result']
});

const pop3CommandDuration = getMetric(promClient.Histogram, {
    name: 'wildduck_pop3_command_duration_seconds',
    help: 'POP3 command duration',
    labelNames: ['command', 'result'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
});

const lmtpRecipients = getMetric(promClient.Counter, {
    name: 'wildduck_lmtp_recipients_total',
    help: 'LMTP recipients',
    labelNames: ['result']
});

const lmtpMessages = getMetric(promClient.Counter, {
    name: 'wildduck_lmtp_messages_total',
    help: 'LMTP messages',
    labelNames: ['result']
});

const lmtpMessageSize = getMetric(promClient.Histogram, {
    name: 'wildduck_lmtp_message_size_bytes',
    help: 'LMTP message sizes',
    labelNames: ['result'],
    buckets: [1024, 10 * 1024, 100 * 1024, 1024 * 1024, 10 * 1024 * 1024, 50 * 1024 * 1024, 100 * 1024 * 1024]
});

const messageOperations = getMetric(promClient.Counter, {
    name: 'wildduck_message_operations_total',
    help: 'Message storage operations',
    labelNames: ['operation', 'source', 'result']
});

const messageOperationDuration = getMetric(promClient.Histogram, {
    name: 'wildduck_message_operation_duration_seconds',
    help: 'Message storage operation duration',
    labelNames: ['operation', 'source', 'result'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]
});

const messageSize = getMetric(promClient.Histogram, {
    name: 'wildduck_message_size_bytes',
    help: 'Stored message sizes',
    labelNames: ['source'],
    buckets: [1024, 10 * 1024, 100 * 1024, 1024 * 1024, 10 * 1024 * 1024, 50 * 1024 * 1024, 100 * 1024 * 1024]
});

const journalEntries = getMetric(promClient.Counter, {
    name: 'wildduck_journal_entries_total',
    help: 'IMAP journal entries',
    labelNames: ['command']
});

const notificationsPublished = getMetric(promClient.Counter, {
    name: 'wildduck_notifications_published_total',
    help: 'IMAP notifications published',
    labelNames: ['mode']
});

const notificationUsersGauge = getMetric(promClient.Gauge, {
    name: 'wildduck_imap_notification_users',
    help: 'Users with active IMAP notification listeners',
    aggregator: 'sum'
});

const notificationListenersGauge = getMetric(promClient.Gauge, {
    name: 'wildduck_imap_notification_listeners',
    help: 'Active IMAP notification listeners',
    aggregator: 'sum'
});

const eventsPublished = getMetric(promClient.Counter, {
    name: 'wildduck_events_published_total',
    help: 'WildDuck events queued for webhooks',
    labelNames: ['event']
});

getMetric(promClient.Gauge, {
    name: 'wildduck_tasks',
    help: 'MongoDB task queue size',
    labelNames: ['type', 'status'],
    aggregator: 'first',
    /**
     * Publishes MongoDB task counts grouped by task type and status.
     *
     * @returns {Promise<void>} Resolves after task counts have been collected.
     */
    async collect() {
        this.reset();
        if (!expensiveCollectorEnabled || !taskDatabase) {
            return;
        }
        let rows = await getCachedCollectorRows(taskCountsCache, async () =>
            await taskDatabase
                .collection('tasks')
                .aggregate([
                    {
                        $group: {
                            _id: {
                                type: '$task',
                                status: '$status'
                            },
                            count: { $sum: 1 }
                        }
                    }
                ])
                .toArray()
        );
        for (let row of rows) {
            this.set(
                {
                    type: cleanLabel(row._id && row._id.type, 'unknown'),
                    status: cleanLabel(row._id && row._id.status, 'unknown')
                },
                row.count
            );
        }
    }
});

const tasksProcessed = getMetric(promClient.Counter, {
    name: 'wildduck_tasks_processed_total',
    help: 'Processed MongoDB tasks',
    labelNames: ['type', 'result']
});

const taskDuration = getMetric(promClient.Histogram, {
    name: 'wildduck_task_duration_seconds',
    help: 'MongoDB task processing duration',
    labelNames: ['type', 'result'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900]
});

getMetric(promClient.Gauge, {
    name: 'wildduck_bullmq_jobs',
    help: 'BullMQ jobs by queue and state',
    labelNames: ['queue', 'state'],
    aggregator: 'first',
    /**
     * Publishes BullMQ job counts grouped by queue name and state.
     *
     * @returns {Promise<void>} Resolves after all registered queue counts have been collected.
     */
    async collect() {
        this.reset();
        if (!expensiveCollectorEnabled) {
            return;
        }
        let rows = await getCachedCollectorRows(bullQueueCountsCache, async () => {
            let queueRows = await Promise.all(
                Array.from(bullQueues).map(async ([queueName, queue]) => {
                    let counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed', 'paused', 'waiting-children');
                    return Object.keys(counts || {}).map(state => ({ queueName, state, count: counts[state] }));
                })
            );
            return queueRows.flat();
        });
        for (let row of rows) {
            this.set({ queue: row.queueName, state: cleanLabel(row.state, 'unknown') }, Number(row.count) || 0);
        }
    }
});

const bullmqJobsProcessed = getMetric(promClient.Counter, {
    name: 'wildduck_bullmq_jobs_processed_total',
    help: 'Processed BullMQ jobs',
    labelNames: ['queue', 'result']
});

const webhookPosts = getMetric(promClient.Counter, {
    name: 'wildduck_webhook_posts_total',
    help: 'Webhook POST attempts',
    labelNames: ['event', 'result', 'status_class']
});

const searchIndexerLockOwner = getMetric(promClient.Gauge, {
    name: 'wildduck_search_indexer_lock_owner',
    help: 'Whether this process owns the search indexing change stream lock',
    aggregator: 'sum'
});

const searchIndexerChanges = getMetric(promClient.Counter, {
    name: 'wildduck_search_indexer_changes_total',
    help: 'Search indexer change stream entries',
    labelNames: ['command', 'result']
});

/**
 * Increments the in-memory active connection count for a service.
 *
 * @param {*} service Service name to increment.
 * @returns {void}
 */
function incActiveConnection(service) {
    service = cleanLabel(service, DEFAULT_SERVICE);
    activeConnections.set(service, (activeConnections.get(service) || 0) + 1);
}

/**
 * Decrements the in-memory active connection count for a service without going below zero.
 *
 * @param {*} service Service name to decrement.
 * @returns {void}
 */
function decActiveConnection(service) {
    service = cleanLabel(service, DEFAULT_SERVICE);
    activeConnections.set(service, Math.max((activeConnections.get(service) || 0) - 1, 0));
}

/**
 * Installs a worker-side IPC listener for cluster metrics responses.
 *
 * @returns {void}
 */
function addWorkerResponseListener() {
    if (workerListenerAdded || !cluster.isWorker || typeof process.on !== 'function') {
        return;
    }
    workerListenerAdded = true;
    process.on('message', message => {
        if (!message) {
            return;
        }

        if (message.type === CLUSTER_COLLECTOR) {
            let wasEnabled = expensiveCollectorEnabled;
            expensiveCollectorEnabled = message.enabled === true;
            if (expensiveCollectorEnabled && !wasEnabled) {
                taskCountsCache.expires = 0;
                bullQueueCountsCache.expires = 0;
            }
            return;
        }

        if (message.type !== CLUSTER_RES || !pendingRequests.has(message.id)) {
            return;
        }

        let entry = pendingRequests.get(message.id);
        pendingRequests.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
            return entry.reject(new Error(message.error));
        }
        entry.resolve(message.metrics || '');
    });
}

if (METRICS_ENABLED) {
    addWorkerResponseListener();
}

/**
 * Requests aggregated cluster metrics from the master process when running as a worker.
 *
 * @returns {Promise<String>} Metrics exposition text from the local registry or aggregated cluster registry.
 */
function requestClusterMetrics() {
    if (!cluster.isWorker || typeof process.send !== 'function') {
        return promClient.register.metrics();
    }

    addWorkerResponseListener();

    return new Promise((resolve, reject) => {
        let id = ++requestSeq;
        let timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error('Timed out while waiting for aggregated metrics'));
        }, 6500);
        timer.unref();

        pendingRequests.set(id, { resolve, reject, timer });

        try {
            process.send({ type: CLUSTER_REQ, id });
        } catch (err) {
            pendingRequests.delete(id);
            clearTimeout(timer);
            reject(err);
        }
    });
}

/**
 * Installs the master-side IPC listener that serves aggregated metrics to workers.
 *
 * @returns {void}
 */
function initClusterMaster() {
    if (!cluster.isMaster || global[MASTER_LISTENER_SYMBOL]) {
        return;
    }

    global[MASTER_LISTENER_SYMBOL] = true;

    let collectorWorkerId = false;

    let sendToWorker = (worker, message) => {
        if (!worker || !worker.isConnected()) {
            return;
        }
        try {
            worker.send(message, () => false);
        } catch (err) {
            // The worker may disconnect between isConnected() and send().
        }
    };

    let assignCollectorWorker = () => {
        let workers = Object.values(cluster.workers || {})
            .filter(worker => worker && worker.isConnected())
            .sort((a, b) => Number(a.id) - Number(b.id));
        collectorWorkerId = workers.length ? workers[0].id : false;
        workers.forEach(worker => sendToWorker(worker, { type: CLUSTER_COLLECTOR, enabled: worker.id === collectorWorkerId }));
    };

    cluster.on('online', assignCollectorWorker);
    cluster.on('disconnect', assignCollectorWorker);
    cluster.on('exit', assignCollectorWorker);

    cluster.on('message', (worker, message) => {
        if (!message || message.type !== CLUSTER_REQ || !worker || !worker.isConnected()) {
            return;
        }

        // IPC preserves message order. Assigning the collector immediately before
        // prom-client requests registries ensures only one worker queries backends.
        assignCollectorWorker();

        aggregatorRegistry
            .clusterMetrics()
            .then(metrics => {
                if (worker.isConnected()) {
                    sendToWorker(worker, { type: CLUSTER_RES, id: message.id, metrics });
                }
            })
            .catch(err => {
                if (worker.isConnected()) {
                    sendToWorker(worker, { type: CLUSTER_RES, id: message.id, error: err.message });
                }
            });
    });

    assignCollectorWorker();
}

/**
 * Collects Prometheus metrics for the current process or the full cluster.
 *
 * @returns {Promise<String>} Metrics exposition text.
 */
async function getMetrics() {
    if (cluster.isWorker) {
        return await requestClusterMetrics();
    }

    if (cluster.isMaster && cluster.workers && Object.keys(cluster.workers).length) {
        return await aggregatorRegistry.clusterMetrics();
    }

    return await promClient.register.metrics();
}

/**
 * Records whether a WildDuck service has started successfully.
 *
 * @param {*} service Service name.
 * @param {*} up Truthy when the service is up.
 * @returns {void}
 */
function setServiceUp(service, up) {
    serviceStates.set(cleanLabel(service, DEFAULT_SERVICE), up ? 1 : 0);
}

/**
 * Records an API request count and, when provided, request duration.
 *
 * @param {*} method HTTP method.
 * @param {*} route Route pattern or URL.
 * @param {*} statusCode HTTP status code.
 * @param {Number} seconds Request duration in seconds.
 * @returns {void}
 */
function recordApiRequest(method, route, statusCode, seconds) {
    let labels = {
        method: cleanLabel(method, 'unknown').toUpperCase(),
        route: cleanRoute(route),
        status: cleanStatus(statusCode)
    };
    apiRequests.inc(labels);
    if (typeof seconds === 'number' && isFinite(seconds)) {
        apiRequestDuration.observe(labels, seconds);
    }
}

/**
 * Records an API error by method, route, and application error code.
 *
 * @param {*} method HTTP method.
 * @param {*} route Route pattern or URL.
 * @param {*} code Error code label.
 * @returns {void}
 */
function recordApiError(method, route, code) {
    apiErrors.inc({
        method: cleanLabel(method, 'unknown').toUpperCase(),
        route: cleanRoute(route),
        code: cleanLabel(code, 'unknown')
    });
}

/**
 * Records an authentication attempt for a service and scope.
 *
 * @param {*} service Service that handled authentication.
 * @param {*} scope Authentication scope.
 * @param {*} result Authentication result label.
 * @returns {void}
 */
function recordAuthAttempt(service, scope, result) {
    service = cleanLabel(service, DEFAULT_SERVICE);
    scope = cleanLabel(scope, 'unknown');
    result = cleanLabel(result, DEFAULT_RESULT);

    authAttempts.inc({
        service: AUTH_SERVICES.has(service) ? service : 'other',
        scope: AUTH_SCOPES.has(scope) ? scope : 'other',
        result: AUTH_RESULTS.has(result) ? result : DEFAULT_RESULT
    });
}

/**
 * Records a newly accepted protocol connection and increments the active connection gauge source.
 * The secure label describes the socket when accepted; later STARTTLS/STLS upgrades do not change this counter observation.
 *
 * @param {*} service Protocol service name.
 * @param {*} secure Truthy when the accepted connection uses TLS.
 * @returns {void}
 */
function connectionStarted(service, secure) {
    service = cleanLabel(service, DEFAULT_SERVICE);
    incActiveConnection(service);
    connectionCounter.inc({
        service,
        secure: secure ? 'yes' : 'no'
    });
}

/**
 * Records a closed protocol connection and decrements the active connection gauge source.
 *
 * @param {*} service Protocol service name.
 * @returns {void}
 */
function connectionClosed(service) {
    decActiveConnection(service);
}

/**
 * Records a protocol command count and, when provided, command duration.
 *
 * @param {Object} counter Prometheus counter for command counts.
 * @param {Object} duration Prometheus histogram for command duration.
 * @param {Set<String>} allowedCommands Commands implemented by the protocol server.
 * @param {*} command Protocol command name.
 * @param {*} result Command result label.
 * @param {Number} seconds Command duration in seconds.
 * @returns {void}
 */
function recordCommand(counter, duration, allowedCommands, command, result, seconds) {
    command = cleanCommand(command, allowedCommands);
    result = cleanCommandResult(result);
    counter.inc({ command, result });
    if (typeof seconds === 'number' && isFinite(seconds)) {
        duration.observe({ command, result }, seconds);
    }
}

/**
 * Records an IMAP command count and, when provided, command duration.
 *
 * @param {*} command IMAP command name.
 * @param {*} result Command result label.
 * @param {Number} seconds Command duration in seconds.
 * @returns {void}
 */
function recordImapCommand(command, result, seconds) {
    recordCommand(imapCommands, imapCommandDuration, IMAP_COMMANDS, command, result, seconds);
}

/**
 * Records a POP3 command count and, when provided, command duration.
 *
 * @param {*} command POP3 command name.
 * @param {*} result Command result label.
 * @param {Number} seconds Command duration in seconds.
 * @returns {void}
 */
function recordPop3Command(command, result, seconds) {
    recordCommand(pop3Commands, pop3CommandDuration, POP3_COMMANDS, command, result, seconds);
}

/**
 * Records an LMTP recipient outcome.
 *
 * @param {*} result Recipient result label.
 * @returns {void}
 */
function recordLmtpRecipient(result) {
    lmtpRecipients.inc({ result: cleanLabel(result, DEFAULT_RESULT) });
}

/**
 * Records an LMTP message outcome and, when provided, message size.
 *
 * @param {*} result Message result label.
 * @param {Number} size Message size in bytes.
 * @returns {void}
 */
function recordLmtpMessage(result, size) {
    result = cleanLabel(result, DEFAULT_RESULT);
    lmtpMessages.inc({ result });
    if (typeof size === 'number' && isFinite(size) && size >= 0) {
        lmtpMessageSize.observe({ result }, size);
    }
}

/**
 * Starts a message storage operation timer.
 *
 * @param {*} operation Message operation name.
 * @param {*} source Source that triggered the operation.
 * @returns {Function} Completion callback that accepts a result label and records operation duration.
 */
function startMessageOperation(operation, source) {
    let start = process.hrtime();
    operation = cleanLabel(operation, 'unknown');
    source = normalizeSource(source);
    return result => {
        result = cleanLabel(result, DEFAULT_RESULT);
        messageOperations.inc({ operation, source, result });
        messageOperationDuration.observe({ operation, source, result }, durationSeconds(start));
    };
}

/**
 * Records a stored message size.
 *
 * @param {*} source Source that stored the message.
 * @param {Number} size Message size in bytes.
 * @returns {void}
 */
function recordMessageSize(source, size) {
    if (typeof size === 'number' && isFinite(size) && size >= 0) {
        messageSize.observe({ source: normalizeSource(source) }, size);
    }
}

/**
 * Records IMAP journal entries by command name.
 *
 * @param {Array|Object} entries Journal entry or list of journal entries.
 * @returns {void}
 */
function recordJournalEntries(entries) {
    [].concat(entries || []).forEach(entry => {
        if (entry && entry.command) {
            journalEntries.inc({ command: cleanLabel(entry.command, 'unknown') });
        }
    });
}

/**
 * Records an IMAP notification publish attempt.
 *
 * @param {*} mode Notification mode label.
 * @returns {void}
 */
function recordNotification(mode) {
    notificationsPublished.inc({ mode: cleanLabel(mode, 'unknown') });
}

/**
 * Sets current IMAP notification listener gauges.
 *
 * @param {*} users Number of users with active listeners.
 * @param {*} listeners Number of active listeners.
 * @returns {void}
 */
function setNotificationListenerCounts(users, listeners) {
    notificationUsersGauge.set(Number(users) || 0);
    notificationListenersGauge.set(Number(listeners) || 0);
}

/**
 * Records a WildDuck event queued for webhook processing.
 *
 * @param {*} event Event name.
 * @returns {void}
 */
function recordEvent(event) {
    eventsPublished.inc({ event: cleanLabel(event, 'unknown') });
}

/**
 * Registers the MongoDB database used for task queue gauges.
 *
 * @param {Object} database MongoDB database handle.
 * @returns {void}
 */
function registerTaskDatabase(database) {
    taskDatabase = database;
    taskCountsCache.expires = 0;
}

/**
 * Starts a MongoDB task processing timer.
 *
 * @param {*} type Task type.
 * @returns {Function} Completion callback that accepts a result label and records task duration.
 */
function startTask(type) {
    let start = process.hrtime();
    type = cleanLabel(type, 'unknown');
    return result => {
        result = cleanLabel(result, DEFAULT_RESULT);
        tasksProcessed.inc({ type, result });
        taskDuration.observe({ type, result }, durationSeconds(start));
    };
}

/**
 * Registers a BullMQ queue for job count gauges.
 *
 * @param {*} name Queue name.
 * @param {Object} queue BullMQ queue instance with getJobCounts().
 * @returns {void}
 */
function registerBullQueue(name, queue) {
    if (name && queue && typeof queue.getJobCounts === 'function') {
        bullQueues.set(cleanLabel(name, 'unknown'), queue);
        bullQueueCountsCache.expires = 0;
    }
}

/**
 * Tracks BullMQ worker completed and failed events.
 *
 * @param {*} name Queue name associated with the worker.
 * @param {Object} worker BullMQ worker or worker-like event emitter.
 * @returns {void}
 */
function trackBullWorker(name, worker) {
    name = cleanLabel(name, 'unknown');
    if (!worker || typeof worker.on !== 'function') {
        return;
    }
    worker.on('completed', () => bullmqJobsProcessed.inc({ queue: name, result: 'completed' }));
    worker.on('failed', () => bullmqJobsProcessed.inc({ queue: name, result: 'failed' }));
}

/**
 * Records a webhook POST attempt.
 *
 * @param {*} event Webhook event name.
 * @param {*} result POST result label.
 * @param {*} statusCode HTTP response status code.
 * @returns {void}
 */
function recordWebhookPost(event, result, statusCode) {
    webhookPosts.inc({
        event: cleanLabel(event, 'unknown'),
        result: cleanLabel(result, DEFAULT_RESULT),
        status_class: cleanStatusClass(statusCode)
    });
}

/**
 * Records whether this process currently owns the search indexing lock.
 *
 * @param {*} owner Truthy when this process owns the lock.
 * @returns {void}
 */
function setSearchIndexerLockOwner(owner) {
    searchIndexerLockOwner.set(owner ? 1 : 0);
}

/**
 * Records a search indexer change-stream or indexing action result.
 *
 * @param {*} command Change stream command or indexing action.
 * @param {*} result Processing result label.
 * @returns {void}
 */
function recordSearchIndexerChange(command, result) {
    searchIndexerChanges.inc({
        command: cleanLabel(command, 'unknown'),
        result: cleanLabel(result, DEFAULT_RESULT)
    });
}

module.exports = {
    enabled: METRICS_ENABLED,
    client: promClient,
    register: promClient.register,
    contentType: promClient.register.contentType,
    initClusterMaster: enabledHandler(initClusterMaster),
    getMetrics: enabledHandler(getMetrics, NOOP_GET_METRICS),
    normalizeSource,
    cleanLabel,
    cleanRoute,
    cleanStatus,
    cleanStatusClass,
    setServiceUp: enabledHandler(setServiceUp),
    recordApiRequest: enabledHandler(recordApiRequest),
    recordApiError: enabledHandler(recordApiError),
    recordAuthAttempt: enabledHandler(recordAuthAttempt),
    connectionStarted: enabledHandler(connectionStarted),
    connectionClosed: enabledHandler(connectionClosed),
    recordImapCommand: enabledHandler(recordImapCommand),
    recordPop3Command: enabledHandler(recordPop3Command),
    recordLmtpRecipient: enabledHandler(recordLmtpRecipient),
    recordLmtpMessage: enabledHandler(recordLmtpMessage),
    startMessageOperation: enabledHandler(startMessageOperation, NOOP_START),
    recordMessageSize: enabledHandler(recordMessageSize),
    recordJournalEntries: enabledHandler(recordJournalEntries),
    recordNotification: enabledHandler(recordNotification),
    setNotificationListenerCounts: enabledHandler(setNotificationListenerCounts),
    recordEvent: enabledHandler(recordEvent),
    registerTaskDatabase: enabledHandler(registerTaskDatabase),
    startTask: enabledHandler(startTask, NOOP_START),
    registerBullQueue: enabledHandler(registerBullQueue),
    trackBullWorker: enabledHandler(trackBullWorker),
    recordWebhookPost: enabledHandler(recordWebhookPost),
    setSearchIndexerLockOwner: enabledHandler(setSearchIndexerLockOwner),
    recordSearchIndexerChange: enabledHandler(recordSearchIndexerChange)
};
