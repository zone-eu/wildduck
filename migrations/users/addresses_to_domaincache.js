'use strict';
/* global db, log, loggelf */
// MongoDB Migration Script: addresses to domaincache
const config = require('@zone-eu/wild-config');

const ENABLED = process.env.NODE_ENV === 'test' ? false : !!config?.migrations?.users?.addressesToDomaincache?.enabled;

// Extract domain from email address
function extractDomain(email) {
    const atIndex = email.indexOf('@');
    if (atIndex === -1) return null; // if no @ found, return as is
    const domain = email.substring(atIndex + 1);

    // Wildcard domain
    if (domain.includes('*')) {
        return null;
    }
    return domain;
}

async function migrateAddressesToCache() {
    const started = Date.now();

    const sourceCollection = db.collection('addresses');
    const targetCollection = db.collection('domaincache');

    let processedCount = 0;
    let insertedCount = 0;

    try {
        log('Starting migration: addresses to domaincache');
        loggelf({
            short_message: '[MIGRATION] addresses to domaincache started',
            _migration_event: 'started',
            _source_collection: 'addresses',
            _target_collection: 'domaincache'
        });

        const docs = await sourceCollection.find({}, { address: true, _id: true }).toArray();

        if (!docs.length) {
            log('No address documents found. Migration skipped.');
            loggelf({
                short_message: '[MIGRATION] addresses to domaincache skipped',
                _migration_event: 'skipped',
                _source_collection: 'addresses',
                _target_collection: 'domaincache',
                _skip_reason: 'no-documents',
                _duration_ms: Date.now() - started
            });
            return;
        }

        loggelf({
            short_message: '[MIGRATION] addresses to domaincache running',
            _migration_event: 'running',
            _source_collection: 'addresses',
            _target_collection: 'domaincache',
            _total: docs.length
        });

        for (const doc of docs) {
            processedCount++;

            const domain = extractDomain(doc.address);

            if (!domain) {
                continue;
            }

            const cacheDoc = {
                domain
            };

            try {
                await targetCollection.insertOne(cacheDoc);
                insertedCount++;
            } catch (e) {
                // Duplicate key errors are expected and can be ignored
                if (e.code !== 11000) {
                    log(`Error inserting document: ${e}`);
                    loggelf({
                        short_message: '[MIGRATION] addresses to domaincache insert failed',
                        _migration_event: 'insert-failed',
                        _source_collection: 'addresses',
                        _target_collection: 'domaincache',
                        _processed: processedCount,
                        _inserted: insertedCount,
                        _domain: domain,
                        _error: e.message
                    });
                }
            }

            if (processedCount % 1000 === 0) {
                log(`Processed ${processedCount} documents, inserted ${insertedCount} domains`);
                loggelf({
                    short_message: '[MIGRATION] addresses to domaincache progress',
                    _migration_event: 'progress',
                    _source_collection: 'addresses',
                    _target_collection: 'domaincache',
                    _processed: processedCount,
                    _inserted: insertedCount,
                    _total: docs.length
                });
            }
        }

        log(`Addresses collection migration complete. Processed ${processedCount} documents, inserted ${insertedCount} domains`);
        loggelf({
            short_message: '[MIGRATION] addresses to domaincache completed',
            _migration_event: 'completed',
            _source_collection: 'addresses',
            _target_collection: 'domaincache',
            _processed: processedCount,
            _inserted: insertedCount,
            _total: docs.length,
            _duration_ms: Date.now() - started
        });
    } catch (err) {
        loggelf({
            short_message: '[MIGRATION] addresses to domaincache failed',
            _migration_event: 'failed',
            _source_collection: 'addresses',
            _target_collection: 'domaincache',
            _processed: processedCount,
            _inserted: insertedCount,
            _error: err.message,
            _duration_ms: Date.now() - started
        });
        throw err;
    }
}

if (ENABLED) {
    return migrateAddressesToCache();
}
