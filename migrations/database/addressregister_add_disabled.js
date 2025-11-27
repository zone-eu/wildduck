'use strict';
/* global db, log */
// MongoDB Migration Script: addressregister add disabled field to all current addressregister entries in DB
const config = require('@zone-eu/wild-config');

const ENABLED = process.env.NODE_ENV === 'test' ? false : !!config?.migrations?.database?.addressregisterAddDisabled?.enabled;
const BATCH_SIZE = 1000;

async function addDisabledToAddressregister() {
    log('Starting migration: Adding disabled field to addressregister collection');

    const collection = db.collection('addressregister');

    // Get current max id
    const maxIdDoc = await collection.find({}).sort({ _id: -1 }).limit(1).toArray();
    const maxIdAtStart = maxIdDoc.length > 0 ? maxIdDoc[0]._id : null;

    if (!maxIdAtStart) {
        log('No documents found. Migration skipped.');
        return;
    }

    const totalToMigrate = await collection.countDocuments({
        disabled: { $exists: false },
        _id: { $lte: maxIdAtStart } // Only count documents that exist now
    });

    if (totalToMigrate === 0) {
        log('All documents already have disabled field. Migration skipped.');
        return;
    }

    log(`Migrating ${totalToMigrate} documents (up to _id: ${maxIdAtStart}) in batches of ${BATCH_SIZE}...`);

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
            .limit(BATCH_SIZE)
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
        }
    }

    log(`✅ Migration complete! Updated ${processedCount} documents`);
}

if (ENABLED) {
    return addDisabledToAddressregister();
}
