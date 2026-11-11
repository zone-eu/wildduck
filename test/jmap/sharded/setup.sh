#!/bin/sh
# Starts the sharded test cluster and initialises replica sets and shards. Idempotent.
set -e
cd "$(dirname "$0")"
docker compose -p wildduck-jmap-sharded up -d
wait_for() {
    for i in $(seq 1 60); do
        if docker compose -p wildduck-jmap-sharded exec -T "$1" mongosh --quiet --port "$2" --eval 'db.adminCommand({ ping: 1 }).ok' >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    echo "$1 did not start" >&2
    exit 1
}
init_rs() {
    docker compose -p wildduck-jmap-sharded exec -T "$1" mongosh --quiet --port "$2" --eval "try { rs.status() } catch (err) { rs.initiate({ _id: '$3', $4 members: [{ _id: 0, host: '$1:$2' }] }) }" >/dev/null
}
wait_for config 27019
init_rs config 27019 cfg 'configsvr: true,'
wait_for shard1 27018
init_rs shard1 27018 shard1 ''
wait_for shard2 27018
init_rs shard2 27018 shard2 ''
wait_for mongos 27017
docker compose -p wildduck-jmap-sharded exec -T mongos mongosh --quiet --file /dev/stdin < init.js
echo "sharded cluster ready on mongodb://127.0.0.1:27117"
