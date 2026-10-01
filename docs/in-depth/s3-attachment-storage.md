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
# maxAttempts=3
```

`prefix` must be unique for installations sharing a bucket and must not change after objects have been written. WildDuck stores the bucket and key in each `attachments.files` record, but a stable prefix makes retries and maintenance predictable. Credentials come from the AWS SDK's default credential provider chain. Give the process read, write, copy, head, multipart upload/abort, and delete permissions only for the configured prefix. Keep the bucket private. The provider must support conditional destination copies (`If-None-Match: *`) and conditional multipart completion; the implementation uses these to avoid overwriting an object that another worker published.

The object key is `<prefix>/attachments/v1/<first-hash-byte>/<second-hash-byte>/<encoded-body-sha256>`. The key is independent of users, messages, and filenames. `attachments.files` remains the authoritative deduplication and reference-count record. Records without `metadata.storage` are GridFS records. S3 records have `metadata.storage` containing the version, backend, bucket, key, and stored-byte length. S3 records have no `attachments.chunks` documents.

## Rollout and migration

Deploy backend-aware code to every API, IMAP, POP3, LMTP, and task process before changing `type` to `s3`. Mixed mode is automatic: an existing GridFS hash is reused even when new hashes go to S3. For large datasets, start migration with a short hash prefix or limit, then expand. The migration uses the configured `db.gridfs`, which may be separate from the main MongoDB database.

```bash
NODE_ENV=production node scripts/migrate-attachments-to-s3.js --dry-run --prefix=00 --limit=100
NODE_ENV=production node scripts/migrate-attachments-to-s3.js --migrate --prefix=00 --concurrency=2 --throttle-ms=50
NODE_ENV=production node scripts/migrate-attachments-to-s3.js --verify-only --prefix=00
NODE_ENV=production node scripts/migrate-attachments-to-s3.js --cleanup-chunks --yes --prefix=00 --grace-hours=24
NODE_ENV=production node scripts/migrate-attachments-to-s3.js --cleanup-staging --yes --prefix=00 --grace-hours=24
NODE_ENV=production node scripts/migrate-attachments-to-s3.js --cleanup-unreferenced-s3 --yes --prefix=00 --grace-hours=24
```

Run every prefix from `00` through `ff`, or omit `--prefix` to scan all attachment IDs. `--prefix` accepts one to four lowercase hex characters. Each operation can be restarted: the file record determines whether the payload is still GridFS or is now S3. The migration reads and hashes the stored GridFS bytes, uploads them to a staging object, verifies the published S3 bytes, and atomically switches the file record to S3 without changing reference counters. It retains GridFS chunks until the separate `--cleanup-chunks --yes` pass has verified both copies and the reader grace period has elapsed. Keep S3 objects and MongoDB catalog backups together.

`--cleanup-staging --yes` removes old staging objects left by interrupted uploads. It rechecks object age while holding the hash lock. Use a grace period comfortably longer than the longest expected upload.

`--cleanup-unreferenced-s3 --yes` removes old final-key objects that have no matching S3 locator in `attachments.files`, such as a completed upload interrupted before catalog insertion. It checks the file record and object age again under the hash lock. Run it only after all WildDuck processes use this lock protocol and with a grace period longer than the longest expected upload and migration.

The CLI also accepts `--gridfs-bucket`, `--s3-bucket`, `--s3-prefix`, and `--s3-endpoint` for a specifically targeted run. Review those overrides carefully before using `--cleanup-chunks`. Progress and failures are printed to stdout and stderr; a failed entry makes the process exit nonzero. Re-run after resolving failures. An incomplete migration is supported: WildDuck continues to read both backends.

Value options accept both `--prefix=00` and `--prefix 00`. Unknown, duplicate or missing arguments are rejected before connecting to storage. Verification checks the S3 locator using the same rules as message readers, and requires a recorded payload checksum or retained GridFS chunks. If neither exists, the entry fails verification. When cleanup verifies against GridFS without a recorded checksum, it saves the established checksum before deleting the chunks so future verification remains possible.

## Verification

The focused tests are:

```bash
NODE_ENV=test ./node_modules/.bin/mocha --exit test/attachment-s3-test.js test/attachment-s3-http-test.js
S3_TEST_ENDPOINT=http://127.0.0.1:19000 NODE_ENV=test ./node_modules/.bin/mocha --exit test/attachment-s3-moto-test.js
S3_TEST_ENDPOINT=http://127.0.0.1:19000 npm run test:s3
```

The Moto test requires a local S3-compatible endpoint and the configured test MongoDB and Redis services. It creates an isolated temporary bucket and GridFS bucket and removes them afterward. The test also exercises the migration, verification, and delayed chunk cleanup command. The default test suite skips this endpoint-dependent test when `S3_TEST_ENDPOINT` is unset.

The protocol suite reuses `test/attachment-s3-helpers.js` to start isolated WildDuck API and IMAP servers for both GridFS and S3. It uploads synthetic MIME messages through the API and IMAP APPEND, compares RFC822 bytes, BODYSTRUCTURE and attachment sizes across backends, and verifies decoded attachment downloads and partial BODY fetches. It also covers simultaneous uploads, deduplication counters, COPY/MOVE, inline CID images, forwarding, draft replacement/deletion and delayed orphan collection. Every run creates its own MongoDB databases and S3 bucket; it does not flush Redis or drop the configured test database. MongoDB, Redis and Moto must already be running. The binary MIME fixture avoids bare CR/LF because the existing MIME parser canonicalizes line endings; base64 fixtures cover all 256 byte values.
