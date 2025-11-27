'use strict';
/* global db, log */
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
    const sourceCollection = db.collection('addresses');
    const targetCollection = db.collection('domaincache');

    let processedCount = 0;
    let insertedCount = 0;

    const docs = await sourceCollection.find({}, { address: true, _id: true }).toArray();

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
            }
        }

        if (processedCount % 1000 === 0) {
            log(`Processed ${processedCount} documents, inserted ${insertedCount} domains`);
        }
    }

    log(`Addresses collection migration complete. Processed ${processedCount} documents, inserted ${insertedCount} domains`);
}

if (ENABLED) {
    return migrateAddressesToCache();
}
