'use strict';

const log = require('npmlog');
const config = require('wild-config');
const db = require('./lib/db');
const consts = require('./lib/consts');
const RedFour = require('ioredfour');
const yaml = require('js-yaml');
const fs = require('fs');
const { Queue } = require('bullmq');
const MessageHandler = require('./lib/message-handler');
const MailboxHandler = require('./lib/mailbox-handler');
const CertHandler = require('./lib/cert-handler');
const AuditHandler = require('./lib/audit-handler');
const TaskHandler = require('./lib/task-handler');

const { getCertificate, acquireCert } = require('./lib/acme/certs');

const setupIndexes = yaml.load(fs.readFileSync(__dirname + '/indexes.yaml', 'utf8'));
const Gelf = require('gelf');
const os = require('os');

const taskRestore = require('./lib/tasks/restore');
const taskUserDelete = require('./lib/tasks/user-delete');
const taskQuota = require('./lib/tasks/quota');
const taskAudit = require('./lib/tasks/audit');
const taskAcme = require('./lib/tasks/acme');
const taskAcmeUpdate = require('./lib/tasks/acme-update');
const taskClearFolder = require('./lib/tasks/clear-folder');
const taskSearchApply = require('./lib/tasks/search-apply');
const taskUserIndexing = require('./lib/tasks/user-indexing');

let messageHandler;
let mailboxHandler;
let auditHandler;
let taskHandler;
let certHandler;
let backlogIndexingQueue;
let gcTimeout;
let taskTimeout;
let gcLock;
let loggelf;

module.exports.start = callback => {
    if (!config.tasks.enabled) {
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

    gcLock = new RedFour({
        redis: db.redis,
        namespace: 'wildduck'
    });

    messageHandler = new MessageHandler({
        users: db.users,
        database: db.database,
        redis: db.redis,
        gridfs: db.gridfs,
        attachments: config.attachments,
        loggelf: message => loggelf(message)
    });

    mailboxHandler = new MailboxHandler({
        database: db.database,
        users: db.users,
        redis: db.redis,
        notifier: messageHandler.notifier,
        loggelf: message => loggelf(message)
    });

    auditHandler = new AuditHandler({
        database: db.database,
        users: db.users,
        gridfs: db.gridfs,
        bucket: 'audit',
        loggelf: message => loggelf(message)
    });

    taskHandler = new TaskHandler({
        database: db.database
    });

    certHandler = new CertHandler({
        cipher: config.certs && config.certs.cipher,
        secret: config.certs && config.certs.secret,
        database: db.database,
        redis: db.redis,
        users: db.users,
        acmeConfig: config.acme,
        loggelf: message => loggelf(message)
    });

    backlogIndexingQueue = new Queue('backlog_indexing', db.queueConf);

    let start = () => {
        // setup ready

        setImmediate(() => {
            gcTimeout = setTimeout(clearExpiredMessages, consts.GC_INTERVAL);
            gcTimeout.unref();

            // start processing pending tasks in 5 minuytes after start
            taskTimeout = setTimeout(runTasks, consts.TASK_STARTUP_INTERVAL);
            taskTimeout.unref();
        });

        return callback();
    };

    let collections = setupIndexes.collections;
    let collectionpos = 0;
    let ensureCollections = next => {
        if (collectionpos >= collections.length) {
            log.info('Setup', 'Setup %s collections in MongoDB', collections.length);
            return next();
        }
        let collection = collections[collectionpos++];
        db[collection.type || 'database'].createCollection(collection.collection, collection.options, err => {
            if (err && err.codeName !== 'NamespaceExists') {
                log.error('Setup', 'Failed creating collection %s %s. %s', collectionpos, JSON.stringify(collection.collection), err.message);
            }

            ensureCollections(next);
        });
    };

    let deleteindexes = setupIndexes.deleteindexes;
    let deleteindexpos = 0;
    let deleteIndexes = next => {
        if (deleteindexpos >= deleteindexes.length) {
            return next();
        }
        let index = deleteindexes[deleteindexpos++];
        db[index.type || 'database'].collection(index.collection).dropIndex(index.index, (err, r) => {
            if (r && r.ok) {
                log.info('Setup', 'Deleted index %s from %s', index.index, index.collection);
            }

            if (err && err.codeName !== 'IndexNotFound' && err.codeName !== 'NamespaceNotFound') {
                log.error('Setup', 'Failed to delete index %s %s. %s', deleteindexpos, JSON.stringify(index.collection + '.' + index.index), err.message);
            }

            deleteIndexes(next);
        });
    };

    let indexes = setupIndexes.indexes;
    let indexpos = 0;
    let ensureIndexes = next => {
        if (indexpos >= indexes.length) {
            log.info('Setup', 'Setup indexes for %s collections', indexes.length);
            return next();
        }
        let index = indexes[indexpos++];
        db[index.type || 'database'].collection(index.collection).createIndexes([index.index], (err, r) => {
            if (err && err.codeName !== 'IndexOptionsConflict') {
                log.error('Setup', 'Failed creating index %s %s. %s', indexpos, JSON.stringify(index.collection + '.' + index.index.name), err.message);
            } else if (!err && r.numIndexesAfter !== r.numIndexesBefore) {
                log.verbose('Setup', 'Created index %s %s', indexpos, JSON.stringify(index.collection + '.' + index.index.name));
            }

            ensureIndexes(next);
        });
    };

    gcLock.acquireLock('db_indexes', 5 * 60 * 1000, (err, lock) => {
        if (err) {
            log.error('GC', 'Failed to acquire lock error=%s', err.message);
            return start();
        } else if (!lock.success) {
            return start();
        }

        ensureCollections(() => {
            deleteIndexes(() => {
                ensureIndexes(() => {
                    // Do not release the indexing lock immediately
                    setTimeout(() => {
                        gcLock.releaseLock(lock, err => {
                            if (err) {
                                log.error('GC', 'Failed to release lock error=%s', err.message);
                            }
                        });
                    }, 60 * 1000);
                    return start();
                });
            });
        });
    });
};

function clearExpiredMessages() {
    clearTimeout(gcTimeout);
    let startTime = Date.now();

    // First, acquire the lock. This prevents multiple connected clients for deleting the same messages
    gcLock.acquireLock('gc_expired', Math.round(consts.GC_INTERVAL * 1.2) /* Lock expires if not released */, (err, lock) => {
        if (err) {
            log.error('GC', 'Failed to acquire lock error=%s', err.message);
            gcTimeout = setTimeout(clearExpiredMessages, consts.GC_INTERVAL);
            gcTimeout.unref();
            return;
        }

        if (!lock.success) {
            log.verbose('GC', 'Lock already acquired');
            gcTimeout = setTimeout(clearExpiredMessages, consts.GC_INTERVAL);
            gcTimeout.unref();
            return;
        }

        log.verbose('GC', 'Got lock for garbage collector');

        let done = () => {
            gcLock.releaseLock(lock, err => {
                if (err) {
                    log.error('GC', 'Failed to release lock error=%s', err.message);
                }
                gcTimeout = setTimeout(clearExpiredMessages, consts.GC_INTERVAL);
                gcTimeout.unref();
            });
        };

        if (config.imap.disableRetention) {
            // delete all attachments that do not have any active links to message objects
            // do not touch expired messages
            return messageHandler.attachmentStorage.deleteOrphaned(() => done(null, true));
        }

        let deleteOrphaned = next => {
            // delete all attachments that do not have any active links to message objects
            messageHandler.attachmentStorage.deleteOrphaned(() => {
                next(null, true);
            });
        };

        let archiveExpiredMessages = next => {
            log.verbose('GC', 'Archiving expired messages');

            // find and delete all messages that are expired
            // NB! scattered query, searches over all mailboxes and thus over all shards
            let cursor = db.database.collection('messages').find({
                exp: true,
                rdate: {
                    $lte: Date.now()
                }
            });

            let deleted = 0;
            let clear = () =>
                cursor.close(() => {
                    if (deleted) {
                        log.verbose('GC', 'Deleted %s messages', deleted);
                    }
                    return deleteOrphaned(next);
                });

            let processNext = () => {
                if (Date.now() - startTime > consts.GC_INTERVAL * 0.8) {
                    // deleting expired messages has taken too long time, cancel
                    return clear();
                }

                cursor.next((err, messageData) => {
                    if (err) {
                        return done(err);
                    }
                    if (!messageData) {
                        return clear();
                    }

                    messageHandler.del(
                        {
                            messageData,
                            // do not archive messages of deleted users
                            archive: !messageData.userDeleted && !messageData.copied
                        },
                        err => {
                            if (err) {
                                log.error('GC', 'Failed to delete expired message id=%s. %s', messageData._id, err.message);
                                return cursor.close(() => done(err));
                            }
                            log.verbose('GC', 'Deleted expired message id=%s', messageData._id);
                            deleted++;
                            if (consts.GC_DELAY_DELETE) {
                                setTimeout(processNext, consts.GC_DELAY_DELETE);
                            } else {
                                setImmediate(processNext);
                            }
                        }
                    );
                });
            };

            processNext();
        };

        let purgeExpiredMessages = next => {
            log.verbose('GC', 'Purging archived messages');

            // find and delete all messages that are expired
            // NB! scattered query, searches over all mailboxes and thus over all shards
            let cursor = db.database
                .collection('archived')
                .find({
                    exp: true,
                    rdate: {
                        $lte: Date.now()
                    }
                })
                .project({
                    _id: true,
                    user: true,
                    mailbox: true,
                    uid: true,
                    size: true,
                    'mimeTree.attachmentMap': true,
                    'meta.queueId': true,
                    magic: true,
                    unseen: true
                });

            let deleted = 0;
            let clear = () =>
                cursor.close(() => {
                    if (deleted) {
                        log.verbose('GC', 'Purged %s messages', deleted);
                    }
                    return deleteOrphaned(() => {
                        auditHandler
                            .cleanExpired()
                            .then(() => {
                                try {
                                    next();
                                } catch (err) {
                                    // ignore, only needed to prevent calling next() twice
                                }
                            })
                            .catch(next);
                    });
                });

            let processNext = () => {
                if (Date.now() - startTime > consts.GC_INTERVAL * 0.8) {
                    // deleting expired messages has taken too long time, cancel
                    return clear();
                }

                cursor.next((err, messageData) => {
                    if (err) {
                        return done(err);
                    }
                    if (!messageData) {
                        return clear();
                    }

                    db.database.collection('archived').deleteOne({ _id: messageData._id }, err => {
                        if (err) {
                            //failed to delete
                            log.error(
                                'GC',
                                'Failed to delete archived message user=%s mailbox=%s uid=%ss id=%s. %s',
                                messageData.user,
                                messageData.mailbox,
                                messageData.uid,
                                messageData._id,
                                err.message
                            );
                            return cursor.close(() => done(err));
                        }

                        log.verbose(
                            'GC',
                            'Deleted archived message user=%s mailbox=%s uid=%s id=%s',
                            messageData.user,
                            messageData.mailbox,
                            messageData.uid,
                            messageData._id
                        );

                        loggelf({
                            short_message: '[DELARCH] Deleted archived message',
                            _mail_action: 'delete_archived',
                            _service: 'wd_tasks',
                            _user: messageData.user,
                            _mailbox: messageData.mailbox,
                            _uid: messageData.uid,
                            _archived_id: messageData._id
                        });

                        let attachmentIds = Object.keys(messageData.mimeTree.attachmentMap || {}).map(key => messageData.mimeTree.attachmentMap[key]);

                        if (!attachmentIds.length) {
                            // no stored attachments
                            deleted++;
                            if (consts.GC_DELAY_DELETE) {
                                setTimeout(processNext, consts.GC_DELAY_DELETE);
                            } else {
                                setImmediate(processNext);
                            }
                            return;
                        }

                        messageHandler.attachmentStorage.updateMany(attachmentIds, -1, -messageData.magic, err => {
                            if (err) {
                                // should we care about this error?
                            }
                            deleted++;
                            if (consts.GC_DELAY_DELETE) {
                                setTimeout(processNext, consts.GC_DELAY_DELETE);
                            } else {
                                setImmediate(processNext);
                            }
                        });
                    });
                });
            };

            processNext();
        };

        archiveExpiredMessages(() => purgeExpiredMessages(done));
    });
}

function timer(ttl) {
    return new Promise(done => {
        let t = setTimeout(done, ttl);
        t.unref();
    });
}

async function runTasks() {
    let pendingCheckTime = 0;

    let done = false;
    log.verbose('Tasks', 'Starting task poll loop');
    while (!done) {
        if (Date.now() - pendingCheckTime > consts.TASK_RELEASE_DELAYED_INTERVAL) {
            // Once in a while release pending tasks
            try {
                await taskHandler.releasePending();
            } catch (err) {
                log.error('Tasks', 'Failed releasing expired tasks. error=%s', err.message);
                await timer(consts.TASK_IDLE_INTERVAL);
            }

            // and run recurring ACME checks
            try {
                await new Promise((resolve, reject) => {
                    // run pseudo task
                    processTask({ type: 'acme-update', _id: 'acme-update-id', lock: 'acme-update-lock', silent: true }, {}, err => {
                        if (err) {
                            return reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
            } catch (err) {
                log.error('Tasks', 'Failed running recurring ACME checks. error=%s', err.message);
                await timer(consts.TASK_IDLE_INTERVAL);
            }

            pendingCheckTime = Date.now();
        }

        try {
            let { data, task } = await taskHandler.getNext();
            if (!task) {
                await timer(consts.TASK_IDLE_INTERVAL);
                continue;
            }

            try {
                await new Promise((resolve, reject) => {
                    processTask(task, data, err => {
                        if (err) {
                            return reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
                await taskHandler.release(task, true);
            } catch (err) {
                await taskHandler.release(task, false);
            }
        } catch (err) {
            log.error('Tasks', 'Failed to process task queue error=%s', err.message);
        } finally {
            await timer(consts.TASK_IDLE_INTERVAL);
        }
    }

    // probably should never be reached as the loop should take forever
    return runTasks();
}

function processTask(task, data, callback) {
    if (!data.silent) {
        log.verbose('Tasks', 'type=%s id=%s data=%s', task.type, task._id, JSON.stringify(data));
    }

    switch (task.type) {
        case 'restore':
            return taskRestore(
                task,
                data,
                {
                    messageHandler,
                    mailboxHandler,
                    loggelf
                },
                (err, result) => {
                    if (err) {
                        loggelf({
                            short_message: '[TASKFAIL] restore',
                            _task_action: 'restore',
                            _task_id: task._id.toString(),
                            _user: data.user.toString(),
                            _task_result: 'error',
                            _error: err.message
                        });

                        return callback(err);
                    }

                    loggelf({
                        short_message: '[TASKOK] restore',
                        _task_action: 'restore',
                        _task_id: task._id.toString(),
                        _user: data.user.toString(),
                        _task_result: 'finished',
                        _restored_messages: result.restoredMessages
                    });

                    // release
                    callback(null, true);
                }
            );

        case 'user-delete':
            return taskUserDelete(task, data, { loggelf }, err => {
                if (err) {
                    return callback(err);
                }
                // release
                callback(null, true);
            });

        case 'quota':
            return taskQuota(task, data, { loggelf }, err => {
                if (err) {
                    return callback(err);
                }
                // release
                callback(null, true);
            });

        case 'audit':
            return taskAudit(
                task,
                data,
                {
                    messageHandler,
                    auditHandler,
                    loggelf
                },
                err => {
                    if (err) {
                        return callback(err);
                    }
                    // release
                    callback(null, true);
                }
            );

        case 'acme':
            return taskAcme(
                task,
                data,
                {
                    certHandler,
                    getCertificate,
                    loggelf
                },
                err => {
                    if (err) {
                        return callback(err);
                    }
                    // release
                    callback(null, true);
                }
            );

        case 'acme-update':
            return taskAcmeUpdate(
                task,
                data,
                {
                    certHandler,
                    acquireCert,
                    loggelf
                },
                err => {
                    if (err) {
                        return callback(err);
                    }
                    // release
                    callback(null, true);
                }
            );

        case 'clear-folder':
            return taskClearFolder(
                task,
                data,
                {
                    messageHandler,
                    loggelf
                },
                err => {
                    if (err) {
                        return callback(err);
                    }
                    // release
                    callback(null, true);
                }
            );

        case 'search-apply':
            return taskSearchApply(
                task,
                data,
                {
                    messageHandler,
                    mailboxHandler,
                    loggelf
                },
                err => {
                    if (err) {
                        return callback(err);
                    }
                    // release
                    callback(null, true);
                }
            );

        case 'user-indexing':
            return taskUserIndexing(
                task,
                data,
                {
                    backlogIndexingQueue,
                    messageHandler,
                    mailboxHandler,
                    loggelf
                },
                err => {
                    if (err) {
                        return callback(err);
                    }
                    // release
                    callback(null, true);
                }
            );

        default:
            // release task by returning true
            return callback(null, true);
    }
}
