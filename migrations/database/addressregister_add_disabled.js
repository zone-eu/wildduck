'use strict';
/* global db, log */
// MongoDB Migration Script: addressregister add disabled field to all current addressregister entries in DB

const ENABLED = true;

// Main migration function
async function addDisabledToAddressregister() {
    log('Starting migration: Adding disabled field to addressregister collection');

    const collection = db.collection('addressregister');

    const totalCount = await collection.countDocuments();
    if (totalCount === 0) {
        log('addressregister collection is empty. Migration skipped.');
        return;
    }

    const documentsToUpdate = await collection.countDocuments({
        disabled: { $exists: false }
    });

    if (documentsToUpdate === 0) {
        log('All documents already have disabled field. Migration skipped.');
        return;
    }

    log(`Updating ${documentsToUpdate} documents...`);

    try {
        const result = await collection.updateMany({ disabled: { $exists: false } }, { $set: { disabled: false } });

        log(`Migration complete!`);
        log(`- Documents matched: ${result.matchedCount}`);
        log(`- Documents modified: ${result.modifiedCount}`);

        if (result.matchedCount === result.modifiedCount) {
            log('✅ All matched documents were successfully updated');
        } else {
            log(`${result.matchedCount - result.modifiedCount} matched documents were not modified`);
        }
    } catch (e) {
        log(`❌ Migration failed: ${e}`);
        throw e;
    }
}

if (ENABLED) {
    return addDisabledToAddressregister();
}
