'use strict';
/* global db, print */
// MongoDB Migration Script: addresses to domaincache

const ENABLED = false;

// Function to extract domain from email address
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

// Main migration function
async function migrateAddressesToCache() {
    // Get the source and target collections
    const sourceCollection = db.collection('addresses');
    const targetCollection = db.collection('domaincache');

    // Counter for tracking progress
    let processedCount = 0;
    let insertedCount = 0;

    // Process each document in the source collection
    const docs = await sourceCollection.find({}, { address: true, _id: true }).toArray();

    for (const doc of docs) {
        processedCount++;

        // Extract the domain from the address field
        const domain = extractDomain(doc.address);

        // print(`Address: ${doc.address}, Domain: ${domain}`);
        if (!domain) {
            continue;
        }

        // Create the new document for the cache
        const cacheDoc = {
            domain
        };

        // Insert into the target collection
        // The unique index will handle duplicates automatically
        try {
            await targetCollection.insertOne(cacheDoc);
            insertedCount++;
        } catch (e) {
            // print(e.toString());

            // Duplicate key errors are expected and can be ignored
            if (e.code !== 11000) {
                print(`Error inserting document: ${e}`);
            }
        }

        // Print progress every 1000 documents
        if (processedCount % 1000 === 0) {
            print(`Processed ${processedCount} documents, inserted ${insertedCount} domains`);
        }
        // print('---');
    }

    print(`Addresses collection migration complete. Processed ${processedCount} documents, inserted ${insertedCount} domains`);
}

if (ENABLED) {
    return migrateAddressesToCache();
}
