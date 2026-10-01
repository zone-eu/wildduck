'use strict';

const RedFour = require('ioredfour');
const log = require('npmlog');

const LOCK_TTL = 2 * 60 * 1000;
const LOCK_WAIT = 2 * 60 * 1000;

class AttachmentLock {
    constructor(redis) {
        this.lock = new RedFour({ redis, namespace: 'wildduck' });
    }

    async run(id, operation) {
        const name = `att.${id.toString('hex')}`;
        const lock = await this.lock.waitAcquireLock(name, LOCK_TTL, LOCK_WAIT);
        if (!lock.success) {
            throw new Error(`Timed out acquiring attachment lock for ${id.toString('hex')}`);
        }

        let lost = false;
        let renewing = false;
        let expiresAt = Date.now() + LOCK_TTL;
        const timer = setInterval(async () => {
            if (renewing || lost) {
                return;
            }
            const renewalStarted = Date.now();
            if (renewalStarted >= expiresAt) {
                lost = true;
                return;
            }
            renewing = true;
            try {
                const result = await this.lock.extendLock(lock, LOCK_TTL);
                if (!result.success) {
                    lost = true;
                } else {
                    expiresAt = renewalStarted + LOCK_TTL;
                }
            } catch (err) {
                lost = true;
            } finally {
                renewing = false;
            }
        }, LOCK_TTL / 4);
        timer.unref();

        const assertOwned = () => {
            // An event-loop pause can outlast the lease before the renewal timer runs.
            if (lost || Date.now() >= expiresAt) {
                lost = true;
                throw new Error(`Lost attachment lock for ${id.toString('hex')}`);
            }
        };

        try {
            return await operation(assertOwned);
        } finally {
            clearInterval(timer);
            try {
                await this.lock.releaseLock(lock);
            } catch (err) {
                log.error('AttachmentLock', 'Failed to release lock %s: %s', name, err.message);
            }
        }
    }
}

module.exports = AttachmentLock;
