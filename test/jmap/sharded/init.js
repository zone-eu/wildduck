/* global db, sh, sleep */
'use strict';

// Adds the shards and shards the messages collection like production. Run by setup.sh through mongos.
const shards = db.adminCommand({ listShards: 1 }).shards.map(shard => shard._id);
for (const name of ['shard1', 'shard2']) {
    if (!shards.includes(name)) {
        // the shard may take a moment to elect its primary after initiation
        for (let attempt = 0; ; attempt++) {
            const res = db.adminCommand({ addShard: `${name}/${name}:27018` });
            if (res.ok || attempt > 30) {
                break;
            }
            sleep(1000);
        }
    }
}
const dbName = 'wildduck-sharded';
sh.enableSharding(dbName);
const status = db.getSiblingDB('config').collections.findOne({ _id: `${dbName}.messages` });
if (!status) {
    sh.shardCollection(`${dbName}.messages`, { mailbox: 1, uid: 1 });
}
