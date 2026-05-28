'use strict';
/* global db, log, loggelf */
const config = require('@zone-eu/wild-config');

const ENABLED = process.env.NODE_ENV === 'test' ? false : !!config?.migrations?.users?.domainaliasesToDomaincache?.enabled;

async function migrateDomainAliasesToCache() {
    const started = Date.now();

    const sourceCollection = db.collection('domainaliases');
    const targetCollection = db.collection('domaincache');

    let processedCount = 0;
    let insertedCount = 0;

    try {
        log('Starting migration: domainaliases to domaincache');
        loggelf({
            short_message: '[MIGRATION] domainaliases to domaincache started',
            _migration_event: 'started',
            _source_collection: 'domainaliases',
            _target_collection: 'domaincache'
        });

        const docs = await sourceCollection.find({}, { alias: true, _id: true, domain: true }).toArray();

        if (!docs.length) {
            log('No domainalias documents found. Migration skipped.');
            loggelf({
                short_message: '[MIGRATION] domainaliases to domaincache skipped',
                _migration_event: 'skipped',
                _source_collection: 'domainaliases',
                _target_collection: 'domaincache',
                _skip_reason: 'no-documents',
                _duration_ms: Date.now() - started
            });
            return;
        }

        loggelf({
            short_message: '[MIGRATION] domainaliases to domaincache running',
            _migration_event: 'running',
            _source_collection: 'domainaliases',
            _target_collection: 'domaincache',
            _total: docs.length
        });

        for (const doc of docs) {
            processedCount++;

            const aliasDomain = doc.alias;
            const domain = doc.domain;

            log(`Processing | Domain Alias: ${aliasDomain}, Domain: ${domain}`);

            if (aliasDomain) {
                try {
                    await targetCollection.insertOne({ domain: aliasDomain });
                    insertedCount++;
                } catch (e) {
                    // Duplicate key errors are expected and can be ignored
                    if (e.code !== 11000) {
                        log(`Error inserting document: ${e}`);
                        loggelf({
                            short_message: '[MIGRATION] domainaliases to domaincache insert failed',
                            _migration_event: 'insert-failed',
                            _source_collection: 'domainaliases',
                            _target_collection: 'domaincache',
                            _processed: processedCount,
                            _inserted: insertedCount,
                            _domain: aliasDomain,
                            _error: e.message
                        });
                    }
                }
            }

            if (domain) {
                try {
                    await targetCollection.insertOne({ domain });
                    insertedCount++;
                } catch (e) {
                    // Duplicate key errors are expected and can be ignored
                    if (e.code !== 11000) {
                        log(`Error inserting document: ${e}`);
                        loggelf({
                            short_message: '[MIGRATION] domainaliases to domaincache insert failed',
                            _migration_event: 'insert-failed',
                            _source_collection: 'domainaliases',
                            _target_collection: 'domaincache',
                            _processed: processedCount,
                            _inserted: insertedCount,
                            _domain: domain,
                            _error: e.message
                        });
                    }
                }
            }

            if (processedCount % 1000 === 0) {
                log(`Processed ${processedCount} documents, inserted ${insertedCount} domains`);
                loggelf({
                    short_message: '[MIGRATION] domainaliases to domaincache progress',
                    _migration_event: 'progress',
                    _source_collection: 'domainaliases',
                    _target_collection: 'domaincache',
                    _processed: processedCount,
                    _inserted: insertedCount,
                    _total: docs.length
                });
            }
        }

        log(`Domainaliases migration complete. Processed ${processedCount} documents, inserted ${insertedCount} domains`);
        loggelf({
            short_message: '[MIGRATION] domainaliases to domaincache completed',
            _migration_event: 'completed',
            _source_collection: 'domainaliases',
            _target_collection: 'domaincache',
            _processed: processedCount,
            _inserted: insertedCount,
            _total: docs.length,
            _duration_ms: Date.now() - started
        });
    } catch (err) {
        loggelf({
            short_message: '[MIGRATION] domainaliases to domaincache failed',
            _migration_event: 'failed',
            _source_collection: 'domainaliases',
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
    return migrateDomainAliasesToCache();
}
