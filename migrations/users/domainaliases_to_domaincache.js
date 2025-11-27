'use strict';
/* global db, log */
const config = require('@zone-eu/wild-config');

const ENABLED = process.env.NODE_ENV === 'test' ? false : !!config?.migrations?.users?.domainaliasesToDomaincache?.enabled;

async function migrateDomainAliasesToCache() {
    const sourceCollection = db.collection('domainaliases');
    const targetCollection = db.collection('domaincache');

    let processedCount = 0;
    let insertedCount = 0;

    const docs = await sourceCollection.find({}, { alias: true, _id: true, domain: true }).toArray();

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
                }
            }
        }

        if (processedCount % 1000 === 0) {
            log(`Processed ${processedCount} documents, inserted ${insertedCount} domains`);
        }
    }

    log(`Domainaliases migration complete. Processed ${processedCount} documents, inserted ${insertedCount} domains`);
}

if (ENABLED) {
    return migrateDomainAliasesToCache();
}
