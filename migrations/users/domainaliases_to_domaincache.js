'use strict';
/* global db, print */

const ENABLED = false;

async function migrateDomainAliasesToCache() {
    // Get the source and target collections
    const sourceCollection = db.collection('domainaliases');
    const targetCollection = db.collection('domaincache');

    // Counter for tracking progress
    let processedCount = 0;
    let insertedCount = 0;

    // Process each document in the source collection
    const docs = await sourceCollection.find({}, { alias: true, _id: true, domain: true }).toArray();

    for (const doc of docs) {
        processedCount++;

        const aliasDomain = doc.alias;
        const domain = doc.domain;

        // print(`Domain Alias: ${aliasDomain}, Domain: ${domain}`);

        if (aliasDomain) {
            try {
                await targetCollection.insertOne({ domain: aliasDomain });
                insertedCount++;
            } catch (e) {
                // print(e.toString());

                // Duplicate key errors are expected and can be ignored
                if (e.code !== 11000) {
                    print(`Error inserting document: ${e}`);
                }
            }
        }

        if (domain) {
            try {
                await targetCollection.insertOne({ domain });
                insertedCount++;
            } catch (e) {
                // print(e.toString());

                // Duplicate key errors are expected and can be ignored
                if (e.code !== 11000) {
                    print(`Error inserting document: ${e}`);
                }
            }
        }

        // Print progress every 1000 documents
        if (processedCount % 1000 === 0) {
            print(`Processed ${processedCount} documents, inserted ${insertedCount} domains`);
        }
        // print('---');
    }

    print(`Domainaliases migration complete. Processed ${processedCount} documents, inserted ${insertedCount} domains`);
}

if (ENABLED) {
    return migrateDomainAliasesToCache();
}
