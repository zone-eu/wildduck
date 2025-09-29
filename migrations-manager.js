'use strict';

const log = require('npmlog');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_FOLDER = './migrations';
const DATABASE_MIGRATIONS_FOLDER = `${MIGRATIONS_FOLDER}/database`;
const USERS_MIGRATIONS_FOLDER = `${MIGRATIONS_FOLDER}/users`;
const MIGRATION_FOLDERS = [MIGRATIONS_FOLDER, DATABASE_MIGRATIONS_FOLDER, USERS_MIGRATIONS_FOLDER];

function getMigrationFiles() {
    for (const folderName of MIGRATION_FOLDERS) {
        if (!fs.existsSync(folderName)) {
            const dbName = folderName.split('/').at(-1);
            log.info('Migrations', `📁 ${dbName || ''} Migrations folder '${MIGRATIONS_FOLDER}' does not exist`);
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
    log.info('Migrations', `\n🔄 Executing migration: ${fileNameWithoutExtension}`);

    try {
        const migrationContent = fs.readFileSync(filePath, 'utf8');

        // Run the migration script as a JS function
        const migrationFunction = new Function('db', 'log', migrationContent);

        let currentDb = db.database;

        if (path.dirname(filePath).includes('users')) {
            currentDb = db.users;
        }

        const prefixedLog = (...args) => {
            const prefix = `MIGRATION [${fileNameWithoutExtension}]:`;

            log.info('Migrations', prefix, ...args);
        };

        await migrationFunction(currentDb, prefixedLog);

        log.info('Migrations', `✅ Migration completed: ${fileNameWithoutExtension}`);
    } catch (error) {
        console.error(`❌ Migration failed: ${fileNameWithoutExtension}`);
        console.error(`Error: ${error.message}`);
        throw error;
    }
}

async function runMigrations(db) {
    log.info('Migrations', '🚀 Starting MongoDB Migrations');
    log.info('Migrations', '='.repeat(50));

    try {
        const migrationFiles = getMigrationFiles();

        if (migrationFiles.length === 0) {
            log.info('Migrations', '📭 No migration files found');
            return;
        }

        log.info('Migrations', `📋 Found ${migrationFiles.length} migration files`);

        if (migrationFiles.length === 0) {
            log.info('Migrations', '✨ No migrations to execute');
            return;
        }

        log.info('Migrations', `⏳ ${migrationFiles.length} pending migrations to execute`);
        log.info('Migrations', 'Pending migrations:', migrationFiles.join(', '));

        for (const filepath of migrationFiles) {
            await executeMigration(filepath, db);
        }

        log.info('Migrations', '\n🎉 All migrations completed successfully!');
    } catch (error) {
        console.error('\n💥 Migration process failed:', error.message);
        process.exit(1);
    }
}

module.exports = runMigrations;
