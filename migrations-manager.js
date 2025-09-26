'use strict';

const config = require('wild-config');
const mongodb = require('mongodb');
const fs = require('fs');
const path = require('path');

const MongoClient = mongodb.MongoClient;
const database = config.dbs.mongo;

if (!database) {
    throw new Error('Cannot run migrations if missing mongo url');
}

// Initialize other db url variables
const usersDatabase = config.dbs.mongo || database;
// const gridFsDatabase = config.dbs.gridfs || database;
// const senderDatabase = config.dbs.sender || database;

const MIGRATIONS_FOLDER = './migrations';
const DATABASE_MIGRATIONS_FOLDER = `${MIGRATIONS_FOLDER}/database`;
const USERS_MIGRATIONS_FOLDER = `${MIGRATIONS_FOLDER}/users`;
const MIGRATION_FOLDERS = [MIGRATIONS_FOLDER, DATABASE_MIGRATIONS_FOLDER, USERS_MIGRATIONS_FOLDER];

const mongoClients = {};
let db;
let usersDb;

async function initializeDatabase() {
    // General DB
    try {
        console.log('Connecting to MongoDB...');
        mongoClients.database = new MongoClient(database, {
            useNewUrlParser: true,
            useUnifiedTopology: true
        });

        await mongoClients.database.connect();
        db = mongoClients.database.db();

        console.log('✅ Connected to MongoDB');
    } catch (error) {
        console.error('❌ Failed to connect to MongoDB:', error.message);
        throw error;
    }

    // Users db
    if (usersDatabase !== database) {
        try {
            console.log('Connecting to Users Database...');
            mongoClients.users = new MongoClient(usersDatabase, {
                useNewUrlParser: true,
                useUnifiedTopology: true
            });

            await mongoClients.users.connect();
            usersDb = mongoClients.users.db();

            console.log('✅ Connected to Users Database');
        } catch (error) {
            console.error('❌ Failed to connect to Users Database:', error.message);
            throw error;
        }
    } else {
        usersDb = db;
    }
}

function getMigrationFiles() {
    for (const folderName of MIGRATION_FOLDERS) {
        if (!fs.existsSync(folderName)) {
            const dbName = folderName.split('/').at(-1);
            console.log(`📁 ${dbName || ''} Migrations folder '${MIGRATIONS_FOLDER}' does not exist`);
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

async function executeMigration(filePath) {
    const fileName = path.basename(filePath);
    const fileNameWithoutExtension = path.basename(fileName, path.extname(fileName));
    console.log(`\n🔄 Executing migration: ${fileNameWithoutExtension}`);

    try {
        // Read the migration file content
        const migrationContent = fs.readFileSync(filePath, 'utf8');

        // Execute the migration script
        const migrationFunction = new Function('db', 'print', migrationContent);

        // Call the migration with the database context
        let currentDb = db;

        if (filePath.includes('users')) {
            currentDb = usersDb;
        }

        const prefixedPrint = (...args) => {
            // The file name provides context for the specific migration run
            const prefix = `MIGRATION [${fileNameWithoutExtension}]:`;

            // Log the prefix followed by the migration's arguments
            console.log(prefix, ...args);
        };

        await migrationFunction(currentDb, prefixedPrint);

        console.log(`✅ Migration completed: ${fileNameWithoutExtension}`);
    } catch (error) {
        console.error(`❌ Migration failed: ${fileNameWithoutExtension}`);
        console.error(`Error: ${error.message}`);
        throw error;
    }
}

async function runMigrations() {
    console.log('🚀 Starting MongoDB Migrations');
    console.log('='.repeat(50));

    try {
        // Initialize database connection
        await initializeDatabase();

        // Get all migration files
        const migrationFiles = getMigrationFiles();

        if (migrationFiles.length === 0) {
            console.log('📭 No migration files found');
            return;
        }

        console.log(`📋 Found ${migrationFiles.length} migration files`);

        // Filter out already executed migrations
        const pendingMigrations = migrationFiles;

        if (pendingMigrations.length === 0) {
            console.log('✨ No migrations to execute');
            return;
        }

        console.log(`⏳ ${pendingMigrations.length} pending migrations to execute`);
        console.log('Pending migrations:', pendingMigrations.join(', '));

        // Execute each pending migration
        for (const filepath of pendingMigrations) {
            await executeMigration(filepath);
        }

        console.log('\n🎉 All migrations completed successfully!');
    } catch (error) {
        console.error('\n💥 Migration process failed:', error.message);
        process.exit(1);
    } finally {
        // Close database connection

        for (const client of Object.values(mongoClients)) {
            if (client && client.topology && client.topology.isConnected()) {
                await client.close();
                console.log('🔌 Database connection closed');
            } else {
                console.log('🔌 Database connection already closed');
            }
        }
    }
}

(async () => {
    await runMigrations();
})();
