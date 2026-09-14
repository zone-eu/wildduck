'use strict';

const log = require('npmlog');
const fs = require('fs').promises;
const path = require('path');
const { createRequire } = require('module');
const RedFour = require('ioredfour');

const MIGRATIONS_FOLDER = './migrations';
const DATABASE_MIGRATIONS_FOLDER = `${MIGRATIONS_FOLDER}/database`;
const USERS_MIGRATIONS_FOLDER = `${MIGRATIONS_FOLDER}/users`;
const MIGRATION_FOLDERS = [MIGRATIONS_FOLDER, DATABASE_MIGRATIONS_FOLDER, USERS_MIGRATIONS_FOLDER];
const MIGRATION_LOCK_KEY = 'migrations:run';
const MIGRATION_LOCK_TTL = 10 * 60 * 1000;
const MIGRATION_LOCK_RENEW_INTERVAL = Math.round(MIGRATION_LOCK_TTL / 2);

let activeMigrationRun = false;
let migrationLockClient;

async function getMigrationFiles() {
    for (const folderName of MIGRATION_FOLDERS) {
        try {
            await fs.access(folderName);
        } catch (err) {
            const dbName = folderName.split('/').at(-1);
            log.info('Tasks', `${dbName || ''} Migrations folder '${folderName}' does not exist`);
            return [];
        }
    }

    const allMigrationFiles = [];
    for (const folderName of MIGRATION_FOLDERS) {
        const files = (await fs.readdir(folderName)).filter(file => file.endsWith('.js'));

        const fullPaths = files.map(file => path.join(folderName, file));
        allMigrationFiles.push(...fullPaths);
    }
    allMigrationFiles.sort();

    return allMigrationFiles;
}

async function executeMigration(filePath, db, loggelf, task) {
    const fileName = path.basename(filePath);
    const fileNameWithoutExtension = path.basename(fileName, path.extname(fileName));
    log.info('Tasks', `Executing migration: ${fileNameWithoutExtension}`);

    try {
        const migrationContent = await fs.readFile(filePath, 'utf8');
        const migrationRequire = createRequire(path.resolve(filePath));

        // Run the migration script as a JS function
        const migrationFunction = new Function('db', 'log', 'require', 'loggelf', migrationContent);

        let currentDb = db.database;

        if (path.dirname(filePath).includes('users')) {
            currentDb = db.users;
        }

        const prefixedLog = (...args) => {
            const prefix = `MIGRATION [${fileNameWithoutExtension}]:`;

            log.info('Tasks', prefix, ...args);
        };

        const migrationLoggelf = message =>
            loggelf({ _task_action: 'run-migrations', _task_id: task._id.toString(), _migration: fileNameWithoutExtension, ...message });

        loggelf({
            short_message: '[MIGRATION] executing',
            _task_action: 'run-migrations',
            _task_id: task._id.toString(),
            _migration: fileNameWithoutExtension,
            _migration_file: filePath,
            _migration_event: 'executing'
        });

        await migrationFunction(currentDb, prefixedLog, migrationRequire, migrationLoggelf);

        log.info('Tasks', `Migration completed: ${fileNameWithoutExtension}`);
        loggelf({
            short_message: '[MIGRATION] completed',
            _task_action: 'run-migrations',
            _task_id: task._id.toString(),
            _migration: fileNameWithoutExtension,
            _migration_file: filePath,
            _migration_event: 'completed',
            _task_result: 'success'
        });
    } catch (error) {
        log.error('Tasks', `Migration failed: ${fileNameWithoutExtension}`);
        log.error('Tasks', `Error: ${error.message}`);
        loggelf({
            short_message: '[MIGRATION] failed',
            _task_action: 'run-migrations',
            _task_id: task._id.toString(),
            _migration: fileNameWithoutExtension,
            _migration_file: filePath,
            _migration_event: 'failed',
            _task_result: 'fail',
            _error: error.message
        });
        throw error;
    }
}

async function acquireMigrationLock(redis) {
    if (!redis) {
        return false;
    }

    if (!migrationLockClient) {
        migrationLockClient = new RedFour({
            redis,
            namespace: 'wildduck'
        });
    }

    const lock = await migrationLockClient.acquireLock(MIGRATION_LOCK_KEY, MIGRATION_LOCK_TTL);

    if (!lock.success) {
        return false;
    }

    const renewTimer = setInterval(() => {
        migrationLockClient
            .extendLock(lock, MIGRATION_LOCK_TTL)
            .then(result => {
                if (!result.success) {
                    log.error('Tasks', 'Failed to renew migration lock: lock conflict');
                }
            })
            .catch(err => log.error('Tasks', 'Failed to renew migration lock: %s', err.message));
    }, MIGRATION_LOCK_RENEW_INTERVAL);
    renewTimer.unref();

    return { lock, renewTimer };
}

async function releaseMigrationLock(lock) {
    if (!lock) {
        return;
    }

    clearInterval(lock.renewTimer);

    try {
        const result = await migrationLockClient.releaseLock(lock.lock);
        if (!result.success) {
            log.error('Tasks', 'Failed to release migration lock: %s', result.result);
        }
    } catch (err) {
        log.error('Tasks', 'Failed to release migration lock: %s', err.message);
    }
}

async function runMigrations(task, options) {
    log.info('Tasks', 'Starting MongoDB migrations');
    log.info('Tasks', '='.repeat(50));

    const db = options.db;
    const loggelf = typeof options.loggelf === 'function' ? options.loggelf : () => {};

    loggelf({
        short_message: '[MIGRATION] task started',
        _task_action: 'run-migrations',
        _task_id: task._id.toString(),
        _migration_event: 'task-started'
    });

    const lock = await acquireMigrationLock(db.redis);

    if (!lock) {
        log.info('Tasks', 'MongoDB migrations are already running');
        loggelf({
            short_message: '[MIGRATION] already running',
            _task_action: 'run-migrations',
            _task_id: task._id.toString(),
            _migration_event: 'already-running'
        });
        return;
    }

    try {
        const migrationFiles = await getMigrationFiles();

        if (migrationFiles.length === 0) {
            log.info('Tasks', 'No migration files found');
            loggelf({
                short_message: '[MIGRATION] no files',
                _task_action: 'run-migrations',
                _task_id: task._id.toString(),
                _migration_event: 'no-files',
                _migration_files: 0
            });
            return;
        }

        log.info('Tasks', `Found ${migrationFiles.length} migration files`);
        log.info('Tasks', `${migrationFiles.length} pending migrations to execute`);
        log.info('Tasks', 'Pending migrations:', migrationFiles.join(',\n'));
        loggelf({
            short_message: '[MIGRATION] files found',
            _task_action: 'run-migrations',
            _task_id: task._id.toString(),
            _migration_event: 'files-found',
            _migration_files: migrationFiles.length
        });

        for (const filepath of migrationFiles) {
            await executeMigration(filepath, db, loggelf, task);
        }

        log.info('Tasks', 'All migrations completed successfully');
        loggelf({
            short_message: '[MIGRATION] task completed',
            _task_action: 'run-migrations',
            _task_id: task._id.toString(),
            _migration_event: 'task-completed',
            _task_result: 'success'
        });
    } finally {
        await releaseMigrationLock(lock);
    }
}

module.exports = (task, data, options, callback) => {
    options = options || {};
    const loggelf = typeof options.loggelf === 'function' ? options.loggelf : () => {};

    if (activeMigrationRun) {
        log.info('Tasks', 'MongoDB migrations are already running in this worker');
        loggelf({
            short_message: '[MIGRATION] already running in worker',
            _task_action: 'run-migrations',
            _task_id: task._id.toString(),
            _migration_event: 'already-running-worker'
        });
        return setImmediate(callback, null, true);
    }

    activeMigrationRun = true;

    runMigrations(task, { loggelf, ...options })
        .then(() => {
            callback(null, true);
        })
        .catch(err => {
            log.error('Tasks', 'task=run-migrations id=%s error=%s', task._id, err.message);
            loggelf({
                short_message: '[MIGRATION] task failed',
                _task_action: 'run-migrations',
                _task_id: task._id.toString(),
                _migration_event: 'task-failed',
                _task_result: 'fail',
                _error: err.message
            });
            callback(err);
        })
        .finally(() => {
            activeMigrationRun = false;
        });
};
