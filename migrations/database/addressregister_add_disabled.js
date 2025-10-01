'use strict';
/* global db, log */
// MongoDB Migration Script: addressregister add disabled field to all current addressregister entries in DB
const ENABLED = true;
const BATCH_SIZE = 1000;

async function addDisabledToAddressregister() {
    log('Starting migration: Adding disabled field to addressregister collection');

    const collection = db.collection('addressregister');

    const totalToMigrate = await collection.countDocuments({ disabled: { $exists: false } });

    if (totalToMigrate === 0) {
        log('All documents already have disabled field. Migration skipped.');
        return;
    }

    log(`Migrating ${totalToMigrate} documents in batches of ${BATCH_SIZE}...`);

    let processedCount = 0;
    let batchNumber = 0;

    let running = true;

    while (running) {
        // Find batch of documents without the field
        const batch = await collection
            .find(
                { disabled: { $exists: false } },
                {
                    projection: {
                        _id: true
                    }
                }
            )
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

        if (batchNumber % 10 === 0) {
            log(`Progress: ${processedCount}/${totalToMigrate} (${((processedCount / totalToMigrate) * 100).toFixed(1)}%)`);
        }
    }

    log(`✅ Migration complete! Updated ${processedCount} documents`);
}

if (ENABLED) {
    return addDisabledToAddressregister();
}
