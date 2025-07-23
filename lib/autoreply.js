'use strict';

const MailComposer = require('nodemailer/lib/mail-composer');
const MessageSplitter = require('./message-splitter');
const errors = require('./errors');
const { SettingsHandler } = require('./settings-handler');
const { ChunkedPassthrough } = require('mailsplit');

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

    const chunkedPassthrough = new ChunkedPassthrough();

    let settingsHandler = new SettingsHandler({ db: options.db.database });
    let maxAutoreplyInterval = await settingsHandler.get('const:autoreply:interval', {});

    return new Promise((resolve, reject) => {
        messageSplitter.once('headers', headers => {
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

        chunkedPassthrough.on('error', err => messageSplitter.emit('error', err));
        messageSplitter.on('error', err => reject(err));
        messageSplitter.on('data', () => false);
        messageSplitter.on('end', () => false);

        setImmediate(() => {
            let pos = 0;
            let writeNextChunk = () => {
                if (messageHeaders || pos >= options.chunks.length) {
                    return chunkedPassthrough.end();
                }
                let chunk = options.chunks[pos++];
                if (!chunkedPassthrough.write(chunk)) {
                    return chunkedPassthrough.once('drain', writeNextChunk);
                } else {
                    setImmediate(writeNextChunk);
                }
            };
            setImmediate(writeNextChunk);
        });
    });
}

module.exports = autoreply;
