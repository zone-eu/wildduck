'use strict';

const cluster = require('cluster');
const promClient = require('prom-client');
const packageData = require('../package.json');

const DEFAULT_METRICS_SYMBOL = Symbol.for('wildduck.metrics.defaultMetrics');
const MASTER_LISTENER_SYMBOL = Symbol.for('wildduck.metrics.masterListener');

const CLUSTER_REQ = 'wildduck:metrics:req';
const CLUSTER_RES = 'wildduck:metrics:res';

const DEFAULT_SERVICE = 'unknown';
const DEFAULT_RESULT = 'unknown';

const activeConnections = new Map();
const serviceStates = new Map();
const bullQueues = new Map();
let taskDatabase = false;
let requestSeq = 0;
let workerListenerAdded = false;
const pendingRequests = new Map();

if (!global[DEFAULT_METRICS_SYMBOL]) {
    promClient.collectDefaultMetrics();
    global[DEFAULT_METRICS_SYMBOL] = true;
}

const aggregatorRegistry = new promClient.AggregatorRegistry();

function getMetric(Type, options) {
    let existing = promClient.register.getSingleMetric(options.name);
    if (existing) {
        return existing;
    }
    return new Type(options);
}

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

function cleanStatus(statusCode) {
    statusCode = Number(statusCode) || 0;
    if (statusCode < 100 || statusCode > 999) {
        return '000';
    }
    return String(statusCode);
}

function cleanStatusClass(statusCode) {
    statusCode = Number(statusCode) || 0;
    if (statusCode < 100 || statusCode > 999) {
        return 'unknown';
    }
    return Math.floor(statusCode / 100) + 'xx';
}

function cleanRoute(route) {
    route = (route || '').toString().trim();
    if (!route || route.length > 160) {
        return 'unknown';
    }
    return route.replace(/\?.*$/, '');
}

function normalizeSource(options) {
    let source = false;

    if (typeof options === 'string') {
        source = options;
    } else if (options && options.meta) {
        source = options.meta.source || options.meta.transtype || options.meta.origin || false;
    }

    if (!source && options && options.session) {
        if (options.session.writeStream) {
            source = 'imap';
        } else if (options.session.listing) {
            source = 'pop3';
        }
    }

    source = cleanLabel(source, 'unknown');

    switch (source) {
        case 'append':
            return 'imap';
        case 'mx':
            return 'lmtp';
        case 'rest':
            return 'api';
        default:
            return source;
    }
}

function durationSeconds(start) {
    let diff = process.hrtime(start);
    return diff[0] + diff[1] / 1e9;
}

getMetric(promClient.Gauge, {
    name: 'wildduck_info',
    help: 'WildDuck build information',
    labelNames: ['version'],
    aggregator: 'first',
    collect() {
        this.reset();
        this.set({ version: packageData.version }, 1);
    }
});

getMetric(promClient.Gauge, {
    name: 'wildduck_service_up',
    help: 'WildDuck service startup state',
    labelNames: ['service'],
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
    async collect() {
        this.reset();
        if (!taskDatabase) {
            return;
        }
        let rows;
        try {
            rows = await taskDatabase
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
                .toArray();
        } catch {
            return;
        }
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
    async collect() {
        this.reset();
        for (let [queueName, queue] of bullQueues) {
            let counts;
            try {
                counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed', 'paused', 'waiting-children');
            } catch {
                continue;
            }
            Object.keys(counts || {}).forEach(state => {
                this.set({ queue: queueName, state: cleanLabel(state, 'unknown') }, Number(counts[state]) || 0);
            });
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

const indexerLockOwner = getMetric(promClient.Gauge, {
    name: 'wildduck_indexer_lock_owner',
    help: 'Whether this process owns the live indexing change stream lock',
    aggregator: 'sum'
});

const indexerChanges = getMetric(promClient.Counter, {
    name: 'wildduck_indexer_changes_total',
    help: 'Indexer change stream entries',
    labelNames: ['command', 'result']
});

function incActiveConnection(service) {
    service = cleanLabel(service, DEFAULT_SERVICE);
    activeConnections.set(service, (activeConnections.get(service) || 0) + 1);
}

function decActiveConnection(service) {
    service = cleanLabel(service, DEFAULT_SERVICE);
    activeConnections.set(service, Math.max((activeConnections.get(service) || 0) - 1, 0));
}

function addWorkerResponseListener() {
    if (workerListenerAdded || !cluster.isWorker || typeof process.on !== 'function') {
        return;
    }
    workerListenerAdded = true;
    process.on('message', message => {
        if (!message || message.type !== CLUSTER_RES || !pendingRequests.has(message.id)) {
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

function initClusterMaster() {
    if (!cluster.isMaster || global[MASTER_LISTENER_SYMBOL]) {
        return;
    }

    global[MASTER_LISTENER_SYMBOL] = true;

    cluster.on('message', (worker, message) => {
        if (!message || message.type !== CLUSTER_REQ || !worker || !worker.isConnected()) {
            return;
        }

        aggregatorRegistry
            .clusterMetrics()
            .then(metrics => {
                if (worker.isConnected()) {
                    worker.send({ type: CLUSTER_RES, id: message.id, metrics });
                }
            })
            .catch(err => {
                if (worker.isConnected()) {
                    worker.send({ type: CLUSTER_RES, id: message.id, error: err.message });
                }
            });
    });
}

async function getMetrics() {
    if (cluster.isWorker) {
        return await requestClusterMetrics();
    }

    if (cluster.isMaster && cluster.workers && Object.keys(cluster.workers).length) {
        return await aggregatorRegistry.clusterMetrics();
    }

    return await promClient.register.metrics();
}

module.exports = {
    client: promClient,
    register: promClient.register,
    contentType: promClient.register.contentType,
    initClusterMaster,
    getMetrics,
    normalizeSource,
    cleanLabel,
    cleanRoute,
    cleanStatus,
    cleanStatusClass,

    setServiceUp(service, up) {
        serviceStates.set(cleanLabel(service, DEFAULT_SERVICE), up ? 1 : 0);
    },

    recordApiRequest(method, route, statusCode, seconds) {
        let labels = {
            method: cleanLabel(method, 'unknown').toUpperCase(),
            route: cleanRoute(route),
            status: cleanStatus(statusCode)
        };
        apiRequests.inc(labels);
        if (typeof seconds === 'number' && isFinite(seconds)) {
            apiRequestDuration.observe(labels, seconds);
        }
    },

    recordApiError(method, route, code) {
        apiErrors.inc({
            method: cleanLabel(method, 'unknown').toUpperCase(),
            route: cleanRoute(route),
            code: cleanLabel(code, 'unknown')
        });
    },

    recordAuthAttempt(service, scope, result) {
        authAttempts.inc({
            service: cleanLabel(service, DEFAULT_SERVICE),
            scope: cleanLabel(scope, 'unknown'),
            result: cleanLabel(result, DEFAULT_RESULT)
        });
    },

    connectionStarted(service, secure) {
        service = cleanLabel(service, DEFAULT_SERVICE);
        incActiveConnection(service);
        connectionCounter.inc({
            service,
            secure: secure ? 'yes' : 'no'
        });
    },

    connectionClosed(service) {
        decActiveConnection(service);
    },

    startImapCommand(command) {
        let start = process.hrtime();
        command = cleanLabel(command, 'unknown');
        return result => {
            module.exports.recordImapCommand(command, result, durationSeconds(start));
        };
    },

    recordImapCommand(command, result, seconds) {
        command = cleanLabel(command, 'unknown');
        result = cleanLabel(result, DEFAULT_RESULT);
        imapCommands.inc({ command, result });
        if (typeof seconds === 'number' && isFinite(seconds)) {
            imapCommandDuration.observe({ command, result }, seconds);
        }
    },

    startPop3Command(command) {
        let start = process.hrtime();
        command = cleanLabel(command, 'unknown');
        return result => {
            module.exports.recordPop3Command(command, result, durationSeconds(start));
        };
    },

    recordPop3Command(command, result, seconds) {
        command = cleanLabel(command, 'unknown');
        result = cleanLabel(result, DEFAULT_RESULT);
        pop3Commands.inc({ command, result });
        if (typeof seconds === 'number' && isFinite(seconds)) {
            pop3CommandDuration.observe({ command, result }, seconds);
        }
    },

    recordLmtpRecipient(result) {
        lmtpRecipients.inc({ result: cleanLabel(result, DEFAULT_RESULT) });
    },

    recordLmtpMessage(result, size) {
        result = cleanLabel(result, DEFAULT_RESULT);
        lmtpMessages.inc({ result });
        if (typeof size === 'number' && isFinite(size) && size >= 0) {
            lmtpMessageSize.observe({ result }, size);
        }
    },

    startMessageOperation(operation, source) {
        let start = process.hrtime();
        operation = cleanLabel(operation, 'unknown');
        source = cleanLabel(source, 'unknown');
        return result => {
            result = cleanLabel(result, DEFAULT_RESULT);
            messageOperations.inc({ operation, source, result });
            messageOperationDuration.observe({ operation, source, result }, durationSeconds(start));
        };
    },

    recordMessageSize(source, size) {
        if (typeof size === 'number' && isFinite(size) && size >= 0) {
            messageSize.observe({ source: cleanLabel(source, 'unknown') }, size);
        }
    },

    recordJournalEntries(entries) {
        [].concat(entries || []).forEach(entry => {
            if (entry && entry.command) {
                journalEntries.inc({ command: cleanLabel(entry.command, 'unknown') });
            }
        });
    },

    recordNotification(mode) {
        notificationsPublished.inc({ mode: cleanLabel(mode, 'unknown') });
    },

    setNotificationListenerCounts(users, listeners) {
        notificationUsersGauge.set(Number(users) || 0);
        notificationListenersGauge.set(Number(listeners) || 0);
    },

    recordEvent(event) {
        eventsPublished.inc({ event: cleanLabel(event, 'unknown') });
    },

    registerTaskDatabase(database) {
        taskDatabase = database;
    },

    startTask(type) {
        let start = process.hrtime();
        type = cleanLabel(type, 'unknown');
        return result => {
            result = cleanLabel(result, DEFAULT_RESULT);
            tasksProcessed.inc({ type, result });
            taskDuration.observe({ type, result }, durationSeconds(start));
        };
    },

    registerBullQueue(name, queue) {
        if (name && queue && typeof queue.getJobCounts === 'function') {
            bullQueues.set(cleanLabel(name, 'unknown'), queue);
        }
    },

    trackBullWorker(name, worker) {
        name = cleanLabel(name, 'unknown');
        if (!worker || typeof worker.on !== 'function') {
            return;
        }
        worker.on('completed', () => bullmqJobsProcessed.inc({ queue: name, result: 'completed' }));
        worker.on('failed', () => bullmqJobsProcessed.inc({ queue: name, result: 'failed' }));
    },

    recordWebhookPost(event, result, statusCode) {
        webhookPosts.inc({
            event: cleanLabel(event, 'unknown'),
            result: cleanLabel(result, DEFAULT_RESULT),
            status_class: cleanStatusClass(statusCode)
        });
    },

    setIndexerLockOwner(owner) {
        indexerLockOwner.set(owner ? 1 : 0);
    },

    recordIndexerChange(command, result) {
        indexerChanges.inc({
            command: cleanLabel(command, 'unknown'),
            result: cleanLabel(result, DEFAULT_RESULT)
        });
    }
};
