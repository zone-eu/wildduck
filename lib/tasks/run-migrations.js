'use strict';

const log = require('npmlog');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const MIGRATIONS_FOLDER = './migrations';
const DATABASE_MIGRATIONS_FOLDER = `${MIGRATIONS_FOLDER}/database`;
const USERS_MIGRATIONS_FOLDER = `${MIGRATIONS_FOLDER}/users`;
const MIGRATION_FOLDERS = [MIGRATIONS_FOLDER, DATABASE_MIGRATIONS_FOLDER, USERS_MIGRATIONS_FOLDER];

function getMigrationFiles() {
    for (const folderName of MIGRATION_FOLDERS) {
        if (!fs.existsSync(folderName)) {
            const dbName = folderName.split('/').at(-1);
            log.info('Tasks', `📁 ${dbName || ''} Migrations folder '${MIGRATIONS_FOLDER}' does not exist`);
            return [];
        }
    }

    const allMigrationFiles = [];
    for (const folderName of MIGRATION_FOLDERS) {
        const files = fs.readdirSync(folderName).filter(file => file.endsWith('.js'));

        const fullPaths = files.map(file => path.join(folderName, file));
        allMigrationFiles.push(...fullPaths);
    }
    allMigrationFiles.sort();

    return allMigrationFiles;
}

async function executeMigration(filePath, db) {
    const fileName = path.basename(filePath);
    const fileNameWithoutExtension = path.basename(fileName, path.extname(fileName));
    log.info('Tasks', `\n🔄 Executing migration: ${fileNameWithoutExtension}`);

    try {
        const migrationContent = fs.readFileSync(filePath, 'utf8');
        const migrationRequire = createRequire(path.resolve(filePath));

        // Run the migration script as a JS function
        const migrationFunction = new Function('db', 'log', 'require', migrationContent);

        let currentDb = db.database;

        if (path.dirname(filePath).includes('users')) {
            currentDb = db.users;
        }

        const prefixedLog = (...args) => {
            const prefix = `MIGRATION [${fileNameWithoutExtension}]:`;

            log.info('Tasks', prefix, ...args);
        };

        await migrationFunction(currentDb, prefixedLog, migrationRequire);

        log.info('Tasks', `✅ Migration completed: ${fileNameWithoutExtension}`);
    } catch (error) {
        log.error('Tasks', `❌ Migration failed: ${fileNameWithoutExtension}`);
        log.error('Tasks', `Error: ${error.message}`);
        throw error;
    }
}

async function runMigrations(task, data, options) {
    log.info('Tasks', '🚀 Starting MongoDB Migrations');
    log.info('Tasks', '='.repeat(50));

    const db = options.db;

    try {
        const migrationFiles = getMigrationFiles();

        if (migrationFiles.length === 0) {
            log.info('Tasks', '📭 No migration files found');
            return;
        }

        log.info('Tasks', `📋 Found ${migrationFiles.length} migration files`);

        if (migrationFiles.length === 0) {
            log.info('Tasks', '✨ No migrations to execute');
            return;
        }

        log.info('Tasks', `⏳ ${migrationFiles.length} pending migrations to execute`);
        log.info('Tasks', 'Pending migrations:', migrationFiles.join(', '));

        for (const filepath of migrationFiles) {
            await executeMigration(filepath, db);
        }

        log.info('Tasks', '\n🎉 All migrations completed successfully!');
    } catch (error) {
        log.error('Tasks', '\n💥 Migration process failed:', error.message);
        process.exit(1);
    }
}

module.exports = (task, data, options, callback) => {
    runMigrations(task, data, options)
        .then(result => callback(null, result))
        .catch(err => {
            log.error('Tasks', 'task=run-migrations id=%s error=%s', task._id, err.message);
            callback(err);
        });
};
