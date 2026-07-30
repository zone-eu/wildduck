#!/bin/bash

# Golden capture run for the Restify to Fastify migration.
# Clears the test DB/Redis, starts the API server, places the recording proxy
# in front of it, then records (1) the deterministic invalid-input sweep and
# (2) the full api test suite traffic.
# Usage: migration/capture-run.sh <output.jsonl>
# Temporary tooling, delete after migration.

set -e

OUT="$1"
if [ -z "$OUT" ]; then
    echo "Usage: migration/capture-run.sh <output.jsonl>"
    exit 1
fi

SERVER_PORT=8081
PROXY_PORT=8090
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"

rm -f "$OUT"

if lsof -nP -i :$SERVER_PORT -i :$PROXY_PORT 2> /dev/null | grep -q LISTEN; then
    echo "ERROR: port $SERVER_PORT or $PROXY_PORT already in use, refusing to capture against a stale server" >&2
    lsof -nP -i :$SERVER_PORT -i :$PROXY_PORT >&2
    exit 1
fi

echo "== clearing test db + redis"
mongosh --eval 'db.dropDatabase()' wildduck-test > /dev/null
redis-cli -n 13 flushdb > /dev/null

echo "== starting server on :$SERVER_PORT"
APPCONF_api_port=$SERVER_PORT NODE_ENV=test node server.js > "$OUT.server.log" 2>&1 &
SERVER_PID=$!

echo "== starting recording proxy :$PROXY_PORT -> :$SERVER_PORT"
node migration/record-proxy.js $PROXY_PORT $SERVER_PORT "$OUT" > "$OUT.proxy.log" 2>&1 &
PROXY_PID=$!

cleanup() {
    kill $SERVER_PID $PROXY_PID 2> /dev/null || true
}
trap cleanup EXIT

echo "== waiting for server readiness"
for i in $(seq 1 60); do
    if curl -s -o /dev/null "http://127.0.0.1:$SERVER_PORT/health"; then
        break
    fi
    if [ "$i" = "60" ]; then
        echo "server did not become ready" >&2
        exit 1
    fi
    sleep 1
done
sleep 2

echo "== invalid-input sweep (recorded)"
node migration/invalid-sweep.js $PROXY_PORT

echo "== api test suite through recording proxy"
APPCONF_api_port=$PROXY_PORT NODE_ENV=test ./node_modules/.bin/mocha 'test/**/*-test.js' --reporter dot --exit

echo "== done, recording in $OUT"
wc -l "$OUT"
