'use strict';
/* global db, print */
// MongoDB Migration Script: addressregister add disabled field to all current addressregister entries in DB

// Main migration function
async function addDisabledToAddressregister() {
    print('Starting migration: Adding disabled field to addressregister collection');

    const collection = db.collection('addressregister');

    // Check if collection has documents
    const totalCount = await collection.countDocuments();
    if (totalCount === 0) {
        print('addressregister collection is empty. Migration skipped.');
        return;
    }

    // Count documents without disabled field
    const documentsToUpdate = await collection.countDocuments({
        disabled: { $exists: false }
    });

    if (documentsToUpdate === 0) {
        print('All documents already have disabled field. Migration skipped.');
        return;
    }

    print(`Updating ${documentsToUpdate} documents...`);

    try {
        // Update all documents that don't have disabled field
        const result = await collection.updateMany({ disabled: { $exists: false } }, { $set: { disabled: false } });

        print(`Migration complete!`);
        print(`- Documents matched: ${result.matchedCount}`);
        print(`- Documents modified: ${result.modifiedCount}`);

        if (result.matchedCount === result.modifiedCount) {
            print('✅ All matched documents were successfully updated');
        } else {
            print(`${result.matchedCount - result.modifiedCount} matched documents were not modified`);
        }
    } catch (e) {
        print(`❌ Migration failed: ${e}`);
        throw e;
    }
}

// Execute the migration
return addDisabledToAddressregister();
