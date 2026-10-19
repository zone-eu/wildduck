'use strict';
/* global db, log, loggelf */
// MongoDB Migration Script: mark messages stored while \Deleted kept them out of the fulltext index
//
// RFC 3501 2.3.2 makes \Deleted only a marker, and 6.4.4 has BODY and TEXT match any message that
// holds the string, so a message stays searchable until it is expunged. Earlier versions unset
// "searchable" when \Deleted was set, which dropped the message out of the partial fulltext index.
// Messages written since then keep the field; this backfills the ones that lost it.
const config = require('@zone-eu/wild-config');

const migrationConfig = config?.migrations?.database?.messagesSearchableBackfill || {};
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

async function backfillSearchable() {
    const started = Date.now();

    log('Starting migration: marking messages that are missing the searchable field');
    loggelf({
        short_message: '[MIGRATION] messages searchable backfill started',
        _migration_event: 'started',
        _collection: 'messages',
        _batch_size: BATCH_SIZE,
        _throttle_ms: THROTTLE_MS
    });

    try {
        const collection = db.collection('messages');

        // messages added while the migration runs already carry the field
        const maxIdDoc = await collection.find({}).sort({ _id: -1 }).limit(1).toArray();
        const maxIdAtStart = maxIdDoc.length > 0 ? maxIdDoc[0]._id : null;

        if (!maxIdAtStart) {
            log('No documents found. Migration skipped.');
            loggelf({
                short_message: '[MIGRATION] messages searchable backfill skipped',
                _migration_event: 'skipped',
                _collection: 'messages',
                _skip_reason: 'no-documents',
                _duration_ms: Date.now() - started
            });
            return;
        }

        let processedCount = 0;
        let batchNumber = 0;
        let lastId = null;
        let running = true;

        while (running) {
            const query = {
                searchable: { $exists: false },
                _id: { $lte: maxIdAtStart }
            };

            // cursor based pagination
            if (lastId) {
                query._id.$gt = lastId;
            }

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

            const ids = batch.map(doc => doc._id);
            const result = await collection.updateMany({ _id: { $in: ids } }, { $set: { searchable: true } });

            processedCount += result.modifiedCount;
            batchNumber++;

            lastId = batch[batch.length - 1]._id;

            if (batchNumber % 10 === 0) {
                log(`Progress: Batch ${batchNumber} - ${processedCount} documents updated`);
                loggelf({
                    short_message: '[MIGRATION] messages searchable backfill progress',
                    _migration_event: 'progress',
                    _collection: 'messages',
                    _batch: batchNumber,
                    _processed: processedCount
                });
            }

            if (THROTTLE_MS > 0 && batch.length === BATCH_SIZE) {
                await sleep(THROTTLE_MS);
            }
        }

        log(`Migration complete! Updated ${processedCount} documents`);
        loggelf({
            short_message: '[MIGRATION] messages searchable backfill completed',
            _migration_event: 'completed',
            _collection: 'messages',
            _processed: processedCount,
            _batches: batchNumber,
            _duration_ms: Date.now() - started
        });
    } catch (err) {
        loggelf({
            short_message: '[MIGRATION] messages searchable backfill failed',
            _migration_event: 'failed',
            _collection: 'messages',
            _error: err.message,
            _duration_ms: Date.now() - started
        });
        throw err;
    }
}

if (ENABLED) {
    return backfillSearchable();
}
