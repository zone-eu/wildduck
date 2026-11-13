'use strict';

const MailComposer = require('nodemailer/lib/mail-composer');
const MessageSplitter = require('./message-splitter');
const errors = require('./errors');
const { SettingsHandler } = require('./settings-handler');
const addressparser = require('nodemailer/lib/addressparser');
const tools = require('./tools');
const consts = require('./consts');

// RFC 3834 2: a personal responder answers only mail that names the user as a recipient
const RECIPIENT_HEADERS = ['To', 'Cc', 'Bcc', 'Resent-To', 'Resent-Cc', 'Resent-Bcc'];
// header addresses checked against the user's addresses, enough for any personal message
const MAX_CHECKED_ADDRESSES = 50;
// addresses of a user read for the check; a user has a handful
const MAX_USER_ADDRESSES = 1000;

const lookupForm = address => tools.normalizeAddress(address, false, { removeLabel: true, removeDots: true });
const splitAddress = address => {
    const atPos = address.lastIndexOf('@');
    return [address.substr(0, atPos), address.substr(atPos + 1)];
};

// the recipient addresses of the message headers, in lookup form
function listedAddresses(headers) {
    let listed = [];
    for (let key of RECIPIENT_HEADERS) {
        for (let header of headers.getDecoded(key)) {
            let value = Buffer.from(header.value, 'binary').toString();
            for (let entry of addressparser(value, { flatten: true })) {
                if (entry.address && entry.address.includes('@')) {
                    listed.push(lookupForm(entry.address));
                }
            }
        }
    }
    return [...new Set(listed)].slice(0, MAX_CHECKED_ADDRESSES);
}

// the user's fromWhitelist: from the delivery's user data, which carries it, or read when it does not
async function fromWhitelistOf(options, user) {
    let userData = options.userData;
    if (!('fromWhitelist' in userData)) {
        userData = await options.db.users
            .collection('users')
            .findOne({ _id: user }, { projection: { fromWhitelist: true }, maxTimeMS: consts.DB_MAX_TIME_USERS });
    }
    return ((userData && userData.fromWhitelist) || []).map(entry => (entry.startsWith('*@') ? entry.toLowerCase() : lookupForm(entry)));
}

/**
 * True when a recipient header names the user: the address the message was delivered to, an entry of
 * the user's fromWhitelist, or an address of the user (also through a wildcard address or an alias
 * domain of its domain).
 */
async function isExplicitRecipient(options, headers) {
    const listed = listedAddresses(headers);
    if (!listed.length) {
        return false;
    }
    const recipient = options.recipient ? lookupForm(options.recipient) : null;
    if (recipient && listed.includes(recipient)) {
        return true;
    }
    const user = options.userData && options.userData._id;

    if (user) {
        const whitelist = await fromWhitelistOf(options, user);
        if (listed.some(address => whitelist.includes(address) || whitelist.includes('*@' + splitAddress(address)[1]))) {
            return true;
        }
    }

    // the addresses that stand for the recipient: the delivery address (also for a forwarded address, which
    // has no user, and may itself be a *@domain or partial wildcard) and the user's own addresses (on the
    // user index); and the domains the header domains are aliases of
    const domains = [...new Set(listed.map(address => splitAddress(address)[1]))];
    const [addresses, aliases] = await Promise.all([
        user
            ? options.db.users
                  .collection('addresses')
                  .find({ user }, { projection: { _id: false, addrview: true }, limit: MAX_USER_ADDRESSES, maxTimeMS: consts.DB_MAX_TIME_USERS })
                  .toArray()
            : [],
        options.db.users
            .collection('domainaliases')
            .find({ alias: { $in: domains } }, { projection: { _id: false, alias: true, domain: true }, maxTimeMS: consts.DB_MAX_TIME_USERS })
            .toArray()
    ]);
    const own = new Set(addresses.map(addressData => addressData.addrview));
    if (recipient) {
        own.add(recipient);
    }
    const targets = new Map(aliases.map(aliasData => [aliasData.alias, aliasData.domain]));
    return listed.some(address => {
        const [local, domain] = splitAddress(address);
        // the address as written and, for an alias domain, as the address of the domain it stands for
        return [domain, targets.get(domain)]
            .filter(Boolean)
            .some(target => own.has(`${local}@${target}`) || tools.getWildcardAddresses(local, target).some(wildcard => own.has(wildcard)));
    });
}

/** True when the sender was answered within the autoreply interval: such a delivery costs nothing more */
async function alreadyReplied(options, autoreplyData, interval) {
    try {
        const score = await options.db.redis.zscore('war:' + autoreplyData._id, options.sender);
        return score !== null && Number(score) > Date.now() - interval;
    } catch {
        // the reply bookkeeping below decides
        return false;
    }
}

async function autoreply(options, autoreplyData) {
    if (!options.sender || /mailer-daemon|no-?reply/gi.test(options.sender)) {
        return false;
    }

    // step 1. check if recipient is valid (non special address)
    // step 2. check if recipient not in cache list
    // step 3. parse headers, check if not automatic message
    // step 4. prepare message with special headers (in-reply-to, references, Auto-Submitted)

    let messageHeaders = false;
    let messageSplitter = new MessageSplitter();

    let settingsHandler = new SettingsHandler({ db: options.db.database });
    let maxAutoreplyInterval = await settingsHandler.get('const:autoreply:interval', {});

    if (await alreadyReplied(options, autoreplyData, maxAutoreplyInterval)) {
        return false;
    }

    return new Promise((resolve, reject) => {
        messageSplitter.once('headers', async headers => {
            messageHeaders = headers;

            let autoSubmitted = headers.getFirst('Auto-Submitted');
            if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') {
                // skip automatic messages
                return resolve(false);
            }
            let precedence = headers.getFirst('Precedence');
            if (precedence && ['list', 'junk', 'bulk'].includes(precedence.toLowerCase())) {
                return resolve(false);
            }
            let listUnsubscribe = headers.getFirst('List-Unsubscribe');
            if (listUnsubscribe) {
                return resolve(false);
            }
            let suppressAutoresponse = headers.getFirst('X-Auto-Response-Suppress');
            if (suppressAutoresponse && /OOF|AutoReply/i.test(suppressAutoresponse)) {
                return resolve(false);
            }

            try {
                if (!(await isExplicitRecipient(options, headers))) {
                    return resolve(false);
                }
            } catch (err) {
                return reject(err);
            }

            options.db.redis
                .multi()
                // delete all old entries
                .zremrangebyscore('war:' + autoreplyData._id, '-inf', Date.now() - maxAutoreplyInterval)
                // add new entry if not present
                .zadd('war:' + autoreplyData._id, 'NX', Date.now(), options.sender)
                // if no-one touches this key from now, then delete after max interval has passed
                .expire('war:' + autoreplyData._id, maxAutoreplyInterval)
                .exec((err, result) => {
                    if (err) {
                        errors.notify(err, { userId: autoreplyData._id });
                        return resolve(false);
                    }

                    if (!result || !result[1] || !result[1][1]) {
                        // already responded
                        return resolve(false);
                    }

                    // check limiting counters
                    options.messageHandler.counters.ttlcounter('wda:' + autoreplyData._id, 1, maxAutoreplyInterval, false, (err, result) => {
                        if (err || !result.success) {
                            return resolve(false);
                        }

                        let inReplyTo = Buffer.from(headers.getFirst('Message-ID'), 'binary').toString();

                        let data = {
                            envelope: {
                                from: '',
                                to: options.sender
                            },
                            from: {
                                name: autoreplyData.name || (options.userData && options.userData.name),
                                address: options.recipient
                            },
                            to: options.sender,
                            subject: (autoreplyData.subject && 'Auto: ' + autoreplyData.subject) || {
                                prepared: true,
                                value: 'Auto: Re: ' + Buffer.from(headers.getFirst('Subject'), 'binary').toString()
                            },
                            headers: {
                                'Auto-Submitted': 'auto-replied',
                                'X-WD-Autoreply-For': (options.parentId || options.queueId).toString()
                            },
                            inReplyTo,
                            references: (inReplyTo + ' ' + Buffer.from(headers.getFirst('References'), 'binary').toString()).trim(),
                            text: autoreplyData.text,
                            html: autoreplyData.html
                        };

                        let compiler = new MailComposer(data);
                        let message = options.maildrop.push(
                            {
                                parentId: options.parentId,
                                reason: 'autoreply',

                                // the queue ID of the autoreply is exposed to the user in the `outbound` array of the
                                // triggering message, so the entry must be owned by the user to stay manageable over the API
                                user: options.userData && options.userData._id,

                                from: '',
                                to: options.sender,
                                interface: 'autoreplies',
                                mtaRelay: options.userData?.mtaRelay || false
                            },
                            (err, ...args) => {
                                if (err || !args[0]) {
                                    if (err) {
                                        err.responseCode = 500;
                                        err.code = err.code || 'ERRCOMPOSE';
                                        return reject(err);
                                    }
                                    return resolve(false);
                                }

                                let logentry = {
                                    id: args[0].id,
                                    messageId: args[0].messageId,
                                    action: 'AUTOREPLY',
                                    from: '',
                                    to: options.sender,
                                    sender: options.recipient,
                                    created: new Date()
                                };

                                if (options.parentId) {
                                    logentry.parentId = options.parentId;
                                }
                                if (options.queueId) {
                                    logentry.queueId = options.queueId;
                                }

                                return resolve(args && args[0] && args[0].id);
                            }
                        );

                        if (message) {
                            compiler.compile().createReadStream().pipe(message);
                        }
                    });
                });
        });

        messageSplitter.on('error', err => reject(err));
        messageSplitter.on('data', () => false);
        messageSplitter.on('end', () => false);

        setImmediate(() => {
            let pos = 0;
            let writeNextChunk = () => {
                if (messageHeaders || pos >= options.chunks.length) {
                    return messageSplitter.end();
                }
                let chunk = options.chunks[pos++];
                if (!messageSplitter.write(chunk)) {
                    return messageSplitter.once('drain', writeNextChunk);
                } else {
                    setImmediate(writeNextChunk);
                }
            };
            setImmediate(writeNextChunk);
        });
    });
}

module.exports = autoreply;
// exported for the unit tests
module.exports.isExplicitRecipient = isExplicitRecipient;
