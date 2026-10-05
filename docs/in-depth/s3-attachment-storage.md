# S3 storage for deduplicated message attachments

WildDuck can keep deduplicated message attachment payloads in S3 while retaining the attachment catalog in MongoDB's `attachments.files` collection. The default remains GridFS. This setting does not affect draft uploads in `storage.files` or audit files.

## Configuration

Set `type="s3"` in `config/attachments.toml` to direct **new** attachment hashes to S3. Existing hashes retain their backend, so GridFS and S3 attachments can coexist indefinitely. Every WildDuck process that reads messages needs the S3 settings while any S3-backed records exist, even if its preferred write type is `gridstore`.

```toml
type="s3"
bucket="attachments"
decodeBase64=true

[s3]
bucket="your-private-bucket"
prefix="your-stable-installation-name"
region="us-east-1"
# endpoint="https://s3.example.com"
# forcePathStyle=true
# accessKeyId="..."      # MinIO, Ceph, Garage; otherwise the AWS default credential chain
# secretAccessKey="..."
# maxAttempts=3
# connectionTimeout=5000 # ms
# requestTimeout=30000   # ms until the response headers; an upload also gets 2 s per MB of its size
# readTimeout=30000      # ms a read waits for S3 to send more data
# slowReaderTimeout=300000 # ms a read waits for a reader that stopped taking data
# maxSockets=50
```

`prefix` must be unique for installations sharing a bucket and must not change after objects have been written. WildDuck stores the bucket and key in each `attachments.files` record, but a stable prefix makes retries and maintenance predictable. Credentials come from `accessKeyId` and `secretAccessKey` (and optionally `sessionToken`) when set, otherwise from the AWS SDK's default credential provider chain. Every request has a connection and a request timeout, an upload gets 2 seconds per megabyte on top of the request timeout (a minimum rate of 512 KB/s), and a read fails when S3 sends nothing for `readTimeout` while the reader is waiting for data (a slow IMAP client is not mistaken for a stalled S3). So a stalled S3 connection fails the request instead of hanging a delivery or a FETCH. Give the process `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on the configured prefix, plus `s3:ListBucket` for the migration script's cleanup mode. A missing object is served as a placeholder and logged as `attachment_missing`, as a missing GridFS file is; without `s3:ListBucket` AWS answers 403 instead of 404 for a missing object, and the fetch fails instead. Keep the bucket private.

A new payload is uploaded with a single `PutObject` request that carries the SHA-256 of the stored bytes in `x-amz-checksum-sha256`. S3 rejects the upload with `BadDigest` when the received bytes do not match, so the object is never read back for verification. The provider must verify that header; AWS S3 and MinIO do. Moto, used by the test suite, accepts it without checking.

If the upload fails, the message is not stored and the delivery (or APPEND, or API call) fails with a temporary error, so it is retried later. With `type="s3"` new attachments go to S3 only.

The object key is `<prefix>/attachments/v1/<first-hash-byte>/<second-hash-byte>/<encoded-body-sha256>.<generation>`, where the generation is a random id chosen for every upload. A key is therefore written exactly once: two processes storing the same new attachment at the same time upload separate objects, and the one whose catalog insert loses deletes its own copy. The key is independent of users, messages, and filenames. `attachments.files` remains the authoritative deduplication and reference-count record, and readers always take the key from it. Records without `metadata.storage` are GridFS records. S3 records have `metadata.storage` containing the version, backend, bucket, key, and stored-byte length. S3 records have no `attachments.chunks` documents.

## Rollout and migration

Deploy backend-aware code to every API, IMAP, POP3, LMTP, and task process before changing `type` to `s3`. This includes the processes that use WildDuck as a library: `haraka-plugin-wildduck` rebuilds stored messages when it forwards mail, and `zonemta-wildduck` stores sent copies, so both need this WildDuck version and the same `s3` settings in the `attachments` block of their own configuration (`wildduck.yaml` for Haraka) before the first S3 record exists. Mixed mode is automatic: an existing GridFS hash is reused even when new hashes go to S3. For large datasets, start migration with a short hash prefix or limit, then expand. The migration uses the configured `db.gridfs`, which may be separate from the main MongoDB database.

```bash
NODE_ENV=production node scripts/migrate-attachments-to-s3.js --dry-run --prefix=00 --limit=100
NODE_ENV=production node scripts/migrate-attachments-to-s3.js --migrate --prefix=00 --concurrency=2 --throttle-ms=50
NODE_ENV=production node scripts/migrate-attachments-to-s3.js --verify-only --prefix=00
NODE_ENV=production node scripts/migrate-attachments-to-s3.js --cleanup-chunks --yes --prefix=00 --grace-hours=24
NODE_ENV=production node scripts/migrate-attachments-to-s3.js --cleanup-unreferenced-s3 --yes --prefix=00 --grace-hours=24
```

Run every prefix from `00` through `ff`, or omit `--prefix` to scan all attachment IDs. `--prefix` accepts one to four lowercase hex characters. Each operation can be restarted: the file record determines whether the payload is still GridFS or is now S3. The migration reads and hashes the stored GridFS bytes, uploads them with the checksum to a new object, and atomically switches the file record to S3 without changing reference counters. It retains GridFS chunks until the separate `--cleanup-chunks --yes` pass has verified both copies and the reader grace period has elapsed. Keep S3 objects and MongoDB catalog backups together.

`--cleanup-unreferenced-s3 --yes` removes old objects that have no matching S3 locator in `attachments.files`, such as an upload whose catalog insert failed with an unknown outcome. Every upload writes a new key, so an object older than the grace period that no record points to can not become referenced any more. Use a grace period comfortably longer than the longest expected upload.

The CLI also accepts `--gridfs-bucket`, `--s3-bucket`, `--s3-prefix`, and `--s3-endpoint` for a specifically targeted run. Review those overrides carefully before using `--cleanup-chunks`. Progress and failures are printed to stdout and stderr; a failed entry makes the process exit nonzero. Re-run after resolving failures. An incomplete migration is supported: WildDuck continues to read both backends.

The script lists attachment ids in pages of `--batch` (default 1000) rather than holding one cursor open for the whole run, which a server would time out on a large store, and it always waits for uploads and cutovers in progress before it exits, also after a failure. Value options accept both `--prefix=00` and `--prefix 00`. Unknown, duplicate or missing arguments are rejected before connecting to storage. Verification checks the S3 locator using the same rules as message readers, and requires a recorded payload checksum or retained GridFS chunks. If neither exists, the entry fails verification. When cleanup verifies against GridFS without a recorded checksum, it saves the established checksum before deleting the chunks so future verification remains possible.

## Verification

`npm run test:attachments` runs every attachment test; `npm run test:attachments-coverage` adds a coverage report for `lib/attachment-storage.js`, `lib/attachments/` and the migration script. The S3 parts need `S3_TEST_ENDPOINT` pointing to an S3-compatible service and `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` set to `test`; without it they are skipped. MongoDB and Redis must be running as for the rest of the test suite.

```bash
docker run -d -p 19000:5000 motoserver/moto
S3_TEST_ENDPOINT=http://127.0.0.1:19000 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test npm run test:attachments
```

Moto does not verify `x-amz-checksum-sha256`. To run the same tests against a store that does, use versitygw: `docker run -d -p 19200:7070 -e ROOT_ACCESS_KEY=test -e ROOT_SECRET_KEY=test versity/versitygw posix /data` and point `S3_TEST_ENDPOINT` at port 19200.

The tests come in layers:

- `attachment-s3-test.js`, `attachment-s3-http-test.js`, `attachment-storage-test.js`, `attachment-failure-paths-test.js`: units and failure paths, with stubbed clients, a local HTTP server that behaves like S3 (checksums, stalled responses), and fault injection (locks that can not be taken or are lost, uploads that keep failing, database errors).
- `attachment-lifecycle-test.js`: reference counting and garbage collection against real MongoDB and S3, including the races between storing and collecting, collections that stop halfway and S3 failing. `attachment-storage-contract-test.js` runs the indexer's scenario matrix against real GridFS.
- `attachment-stream-teardown-test.js`, `on-copy-uid-shift-test.js`: releasing storage reads when a client goes away, and IMAP COPY keeping attachment references right when an insert fails.
- `attachment-s3-moto-test.js`, `attachment-s3-migration-test.js`: the S3 store and the migration script end to end.
- `attachment-s3-protocol-test.js`: two complete WildDuck servers, one storing in GridFS and one in S3, compared byte for byte over IMAP and the API, plus disconnects mid-download and damaged payloads.
- `attachment-model-test.js`: model-based randomized testing. Seeded random sequences of operations (storing messages, copying, deleting, expiring, collecting with time passing, reading) run against the real store while faults are injected, and an in-memory model checks after every step that each referenced attachment reads back byte for byte with the right reference counts, and at the end that nothing is left behind. Collections run at the same time as stores, copies, deletions and a second collector, and stop between any two of their steps. `ATTACHMENT_MODEL_RUNS` and `ATTACHMENT_MODEL_STEPS` make a run longer, a failure prints `ATTACHMENT_MODEL_SEED` to replay it.
- `attachment-codec-fuzz-test.js`: property-based fuzzing of the base64 codec with random and damaged bodies: the whole body and random byte windows of it are served through a store that returns random chunk sizes and compared with the original. `ATTACHMENT_FUZZ_CASES` and `ATTACHMENT_FUZZ_SEED` control it.
