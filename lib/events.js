'use strict';

// Pushes events to processing queue

const { Queue } = require('bullmq');
const log = require('npmlog');

let webhooksQueue;

module.exports = {
    DKIM_CREATED: 'dkim.created',
    DKIM_UPDATED: 'dkim.updated',
    DKIM_DELETED: 'dkim.deleted',
    CERT_CREATED: 'cert.created',
    CERT_UPDATED: 'cert.updated',
    CERT_DELETED: 'cert.deleted',
    DOMAINALIAS_CREATED: 'domainalias.created',
    DOMAINALIAS_DELETED: 'domainalias.deleted',
    ADDRESS_USER_CREATED: 'address.user.created',
    ADDRESS_USER_DELETED: 'address.user.deleted',
    ADDRESS_FORWARDED_CREATED: 'address.forwarded.created',
    ADDRESS_FORWARDED_DELETED: 'address.forwarded.deleted',
    ADDRESS_DOMAIN_RENAMED: 'address.domain.renamed',
    FILTER_DELETED: 'filter.deleted',
    FILTER_CREATED: 'filter.created',
    ASP_CREATED: 'asp.created',
    ASP_DELETED: 'asp.deleted',
    USER_CREATED: 'user.created',
    USER_ACTIVATED: 'user.activated',
    USER_PASSWORD_CHANGED: 'user.password.changed',
    USER_DELETE_STARTED: 'user.delete.started',
    USER_DELETE_COMPLETED: 'user.delete.completed',
    USER_DELETE_CANCELLED: 'user.delete.cancelled',
    AUTOREPLY_USER_ENABLED: 'autoreply.user.enabled',
    AUTOREPLY_USER_DISABLED: 'autoreply.user.disabled',
    MFA_TOTP_ENABLED: 'mfa.totp.enabled',
    MFA_TOTP_DISABLED: 'mfa.totp.disabled',
    MFA_CUSTOM_ENABLED: 'mfa.custom.enabled',
    MFA_CUSTOM_DISABLED: 'mfa.custom.disabled',
    MFA_FIDO_REGISTERED: 'mfa.webauthn.registered',
    MFA_FIDO_REOVED: 'mfa.webauthn.removed',
    MFA_DISABLED: 'mfa.disabled',
    MAILBOX_CREATED: 'mailbox.created',
    MAILBOX_RENAMED: 'mailbox.renamed',
    MAILBOX_DELETED: 'mailbox.deleted',
    MARKED_SPAM: 'marked.spam',
    MARKED_HAM: 'marked.ham',

    FORWARD_ADDED: 'forward added',

    async publish(redisClient, data) {
        if (!data || typeof data !== 'object' || !redisClient) {
            return;
        }

        if (!webhooksQueue) {
            webhooksQueue = new Queue('webhooks', {
                connection: redisClient,
                prefix: `wd:bull`
            });
        }

        data = Object.assign({ time: Date.now() }, data);
        Object.keys(data).forEach(key => {
            if (data[key] && typeof data[key] === 'object' && typeof data[key].toHexString === 'function') {
                // convert ObjectId to string
                data[key] = data[key].toHexString();
            }
        });

        try {
            let job = await webhooksQueue.add('wehook', data, {
                removeOnComplete: true,
                removeOnFail: 500,
                attempts: 5,
                backoff: {
                    type: 'exponential',
                    delay: 2000
                }
            });
            return job;
        } catch (err) {
            // ignore?
            log.error('Events', err);
        }
        return false;
    }
};
