'use strict';

const log = require('npmlog');
const config = require('@zone-eu/wild-config');
const Gelf = require('gelf');
const os = require('os');
const { Queue, Worker } = require('bullmq');
const db = require('./lib/db');
const tools = require('./lib/tools');
const { ObjectId } = require('mongodb');
const axios = require('axios');
const packageData = require('./package.json');
const { MARKED_SPAM, MARKED_HAM } = require('./lib/events');

let loggelf;
let queueWorkers = {};

async function postWebhook(webhook, data) {
    let res;

    try {
        res = await axios.post(webhook.url, data, {
            headers: {
                'User-Agent': `wildduck/${packageData.version}`
            }
        });
    } catch (err) {
        loggelf({
            short_message: '[WH] ' + data.ev,
            _mail_action: 'webhook',
            _wh_id: data.id,
            _wh_type: data.ev,
            _wh_user: data.user,
            _wh_url: webhook.url,
            _wh_success: 'no',
            _error: err.message
        });
        throw err;
    }

    if (!res) {
        throw new Error(`Failed to POST request to ${webhook.url}`);
    }

    loggelf({
        short_message: '[WH] ' + data.ev,
        _mail_action: 'webhook',
        _wh_id: data.id,
        _wh_type: data.ev,
        _wh_user: data.user,
        _wh_url: webhook.url,
        _wh_res: res.status,
        _wh_success: res.status >= 200 && res.status < 300 ? 'yes' : 'no'
    });

    log.verbose('Webhooks', 'Posted %s to %s with status %s', data.ev, webhook.url, res.status);

    if (res.status === 410) {
        // autodelete
        try {
            await db.users.collection('webhooks').deleteOne({
                _id: new ObjectId(webhook._id)
            });
        } catch (err) {
            // ignore
        }
        return false;
    }

    if (!res.status || res.status < 200 || res.status >= 300) {
        throw new Error(`Invalid response status ${res.status}`);
    }

    return true;
}

module.exports.start = callback => {
    if (!(config.webhooks && config.webhooks.enabled)) {
        return setImmediate(() => callback(null, false));
    }

    const component = config.log.gelf.component || 'wildduck';
    const hostname = config.log.gelf.hostname || os.hostname();
    const gelf =
        config.log.gelf && config.log.gelf.enabled
            ? new Gelf(config.log.gelf.options)
            : {
                  // placeholder
                  emit: (key, message) => log.info('Gelf', JSON.stringify(message))
              };

    loggelf = message => {
        if (typeof message === 'string') {
            message = {
                short_message: message
            };
        }

        message = message || {};

        if (!message.short_message || message.short_message.indexOf(component.toUpperCase()) !== 0) {
            message.short_message = component.toUpperCase() + ' ' + (message.short_message || '');
        }

        message.facility = component; // facility is deprecated but set by the driver if not provided
        message.host = hostname;
        message.timestamp = Date.now() / 1000;
        message._component = component;
        Object.keys(message).forEach(key => {
            if (!message[key]) {
                delete message[key];
            }
        });
        try {
            gelf.emit('gelf.log', message);
        } catch (err) {
            log.error('Gelf', err);
        }
    };

    const webhooksPostQueue = new Queue('webhooks_post', db.queueConf);

    queueWorkers.webhooks = new Worker(
        'webhooks',
        async job => {
            try {
                if (!job || !job.data || !job.data.ev) {
                    return false;
                }

                const data = job.data;

                let evtList = ['*'];
                let typeParts = data.ev.split('.');
                typeParts.pop();
                for (let i = 1; i <= typeParts.length; i++) {
                    evtList.push(typeParts.slice(0, i) + '.*');
                }
                evtList.push(data.ev);

                const query = { type: { $in: evtList } };
                if (data.user) {
                    query.user = { $in: [new ObjectId(data.user), null] };
                }

                let whid = new ObjectId();
                let count = 0;

                let webhooks = await db.users.collection('webhooks').find(query).toArray();

                if (!webhooks.length) {
                    // ignore this event
                    return;
                }

                if ([MARKED_SPAM, MARKED_HAM].includes(data.ev)) {
                    let message = new ObjectId(data.message);
                    data.message = data.id;
                    delete data.id;

                    let messageData = await db.database.collection('messages').findOne(
                        { _id: message },
                        {
                            projection: {
                                _id: true,
                                uid: true,
                                msgid: true,
                                subject: true,
                                mailbox: true,
                                mimeTree: true,
                                idate: true
                            }
                        }
                    );

                    if (!messageData) {
                        // message already deleted?
                        return;
                    }

                    let parsedHeader = (messageData.mimeTree && messageData.mimeTree.parsedHeader) || {};

                    let from = parsedHeader.from ||
                        parsedHeader.sender || [
                            {
                                name: '',
                                address: (messageData.meta && messageData.meta.from) || ''
                            }
                        ];

                    let addresses = {
                        to: [].concat(parsedHeader.to || []),
                        cc: [].concat(parsedHeader.cc || []),
                        bcc: [].concat(parsedHeader.bcc || [])
                    };

                    tools.decodeAddresses(from);
                    tools.decodeAddresses(addresses.to);
                    tools.decodeAddresses(addresses.cc);
                    tools.decodeAddresses(addresses.bcc);

                    if (from && from[0]) {
                        data.from = from[0];
                    }
                    for (let addrType of ['to', 'cc', 'bcc']) {
                        if (addresses[addrType] && addresses[addrType].length) {
                            data[addrType] = addresses[addrType];
                        }
                    }

                    data.messageId = messageData.msgid;
                    data.subject = messageData.subject;
                    data.date = messageData.idate.toISOString();
                }

                for (let webhook of webhooks) {
                    count++;
                    try {
                        await webhooksPostQueue.add(
                            'webhook',
                            { data: Object.assign({ id: `${whid.toHexString()}:${count}` }, data), webhook },
                            {
                                removeOnComplete: true,
                                removeOnFail: 500,
                                attempts: 5,
                                backoff: {
                                    type: 'exponential',
                                    delay: 2000
                                }
                            }
                        );
                    } catch (err) {
                        // ignore?
                        log.error('Events', err);
                    }
                }
            } catch (err) {
                log.error('Webhooks', err);
                throw err;
            }
        },
        Object.assign(
            {
                concurrency: 1
            },
            db.queueConf
        )
    );

    queueWorkers.webhooksPost = new Worker(
        'webhooks_post',
        async job => {
            if (!job || !job.data) {
                return false;
            }
            const { data, webhook } = job.data;
            return await postWebhook(webhook, data);
        },
        Object.assign(
            {
                concurrency: 1
            },
            db.queueConf
        )
    );

    callback();
};
