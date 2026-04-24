'use strict';

const crypto = require('crypto');

const MESSAGE_INDEXING_QUEUE = 'message_indexing';
const LIVE_INDEXING_PRIORITY = 1;
const BACKLOG_INDEXING_PRIORITY = 10;
const INDEXING_STATE_TTL = 24 * 3600;

const DEFAULT_INDEXING_JOB_OPTS = {
    // Jobs must disappear immediately after finishing, otherwise the same messageId
    // can not be re-enqueued while BullMQ still keeps the completed/failed job around.
    removeOnComplete: true,
    removeOnFail: true,
    attempts: 5,
    backoff: {
        type: 'exponential',
        delay: 2000
    }
};

function normalizeObjectId(value) {
    if (!value) {
        return null;
    }

    return value.toString();
}

function createSyncToken() {
    return crypto.randomBytes(16).toString('hex');
}

function getSyncStateKey(message) {
    return `indexer:sync:${message}`;
}

function createSyncJobData(data) {
    return {
        action: 'sync',
        message: normalizeObjectId(data.message),
        mailbox: normalizeObjectId(data.mailbox),
        uid: data.uid,
        user: normalizeObjectId(data.user),
        modseq: Number.isFinite(data.modseq) ? data.modseq : null
    };
}

async function enqueueMessageSync(queue, redis, data, priority) {
    const jobData = createSyncJobData(data);
    const stateKey = getSyncStateKey(jobData.message);
    const version = createSyncToken();

    await redis.set(stateKey, version, 'EX', INDEXING_STATE_TTL);

    const job = await queue.add(
        'sync',
        jobData,
        {
            ...DEFAULT_INDEXING_JOB_OPTS,
            jobId: jobData.message,
            priority
        }
    );

    if (priority === LIVE_INDEXING_PRIORITY && job) {
        try {
            await job.changePriority({
                priority
            });
        } catch (err) {
            // ignore, the job might have been processed already
        }
    }

    return job;
}

module.exports = {
    MESSAGE_INDEXING_QUEUE,
    LIVE_INDEXING_PRIORITY,
    BACKLOG_INDEXING_PRIORITY,
    createSyncToken,
    getSyncStateKey,
    createSyncJobData,
    enqueueMessageSync
};
