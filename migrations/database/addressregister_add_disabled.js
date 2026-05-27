'use strict';
/* global db, log, loggelf */
// MongoDB Migration Script: addressregister add disabled field to all current addressregister entries in DB
const config = require('@zone-eu/wild-config');

const migrationConfig = config?.migrations?.database?.addressregisterAddDisabled || {};
const ENABLED = process.env.NODE_ENV === 'test' ? false : !!migrationConfig.enabled;
const BATCH_SIZE = getNonNegativeInteger(migrationConfig.batchSize, 1000);
const THROTTLE_MS = getNonNegativeInteger(migrationConfig.throttleMs, 100);

function getNonNegativeInteger(value, defaultValue) {
    const numericValue = Number(value);
    return Number.isSafeInteger(numericValue) && numericValue >= 0 ? numericValue : defaultValue;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function addDisabledToAddressregister() {
    const started = Date.now();

    log('Starting migration: Adding disabled field to addressregister collection');
    loggelf({
        short_message: '[MIGRATION] addressregister add disabled started',
        _migration_event: 'started',
        _collection: 'addressregister',
        _batch_size: BATCH_SIZE,
        _throttle_ms: THROTTLE_MS
    });

    try {
        const collection = db.collection('addressregister');

        // Get current max id
        const maxIdDoc = await collection.find({}).sort({ _id: -1 }).limit(1).toArray();
        const maxIdAtStart = maxIdDoc.length > 0 ? maxIdDoc[0]._id : null;

        if (!maxIdAtStart) {
            log('No documents found. Migration skipped.');
            loggelf({
                short_message: '[MIGRATION] addressregister add disabled skipped',
                _migration_event: 'skipped',
                _collection: 'addressregister',
                _skip_reason: 'no-documents',
                _duration_ms: Date.now() - started
            });
            return;
        }

        const totalToMigrate = await collection.countDocuments({
            disabled: { $exists: false },
            _id: { $lte: maxIdAtStart } // Only count documents that exist now
        });

        if (totalToMigrate === 0) {
            log('All documents already have disabled field. Migration skipped.');
            loggelf({
                short_message: '[MIGRATION] addressregister add disabled skipped',
                _migration_event: 'skipped',
                _collection: 'addressregister',
                _skip_reason: 'already-migrated',
                _duration_ms: Date.now() - started
            });
            return;
        }

        log(`Migrating ${totalToMigrate} documents (up to _id: ${maxIdAtStart}) in batches of ${BATCH_SIZE} with ${THROTTLE_MS}ms throttle...`);
        loggelf({
            short_message: '[MIGRATION] addressregister add disabled running',
            _migration_event: 'running',
            _collection: 'addressregister',
            _total: totalToMigrate,
            _batch_size: BATCH_SIZE,
            _throttle_ms: THROTTLE_MS
        });

        let processedCount = 0;
        let batchNumber = 0;
        let lastId = null;
        let running = true;

        while (running) {
            const query = {
                disabled: { $exists: false },
                _id: { $lte: maxIdAtStart } // Cap at migration start
            };

            // cursor based pagination
            if (lastId) {
                query._id.$gt = lastId;
            }

            // Find batch of documents without the field and capped at max id
            const batch = await collection
                .find(query, {
                    projection: { _id: true }
                })
                .sort({ _id: 1 })
                .limit(BATCH_SIZE || 1)
                .toArray();

            if (batch.length === 0) {
                running = false;
                break;
            }

            // Update this batch
            const ids = batch.map(doc => doc._id);
            const result = await collection.updateMany({ _id: { $in: ids } }, { $set: { disabled: false } });

            processedCount += result.modifiedCount;
            batchNumber++;

            // Update lastId for next iteration
            lastId = batch[batch.length - 1]._id;

            if (totalToMigrate < 50000 || batchNumber % 10 === 0) {
                log(`Progress: Batch ${batchNumber} - ${processedCount}/${totalToMigrate} (${((processedCount / totalToMigrate) * 100).toFixed(1)}%)`);
                loggelf({
                    short_message: '[MIGRATION] addressregister add disabled progress',
                    _migration_event: 'progress',
                    _collection: 'addressregister',
                    _batch: batchNumber,
                    _processed: processedCount,
                    _total: totalToMigrate,
                    _progress: Number(((processedCount / totalToMigrate) * 100).toFixed(1))
                });
            }

            if (THROTTLE_MS > 0 && batch.length === BATCH_SIZE) {
                await sleep(THROTTLE_MS);
            }
        }

        log(`Migration complete! Updated ${processedCount} documents`);
        loggelf({
            short_message: '[MIGRATION] addressregister add disabled completed',
            _migration_event: 'completed',
            _collection: 'addressregister',
            _processed: processedCount,
            _total: totalToMigrate,
            _batches: batchNumber,
            _duration_ms: Date.now() - started
        });
    } catch (err) {
        loggelf({
            short_message: '[MIGRATION] addressregister add disabled failed',
            _migration_event: 'failed',
            _collection: 'addressregister',
            _error: err.message,
            _duration_ms: Date.now() - started
        });
        throw err;
    }
}

if (ENABLED) {
    return addDisabledToAddressregister();
}
