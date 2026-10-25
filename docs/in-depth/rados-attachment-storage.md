# RADOS storage for deduplicated message attachments

WildDuck can keep deduplicated attachment payloads directly in Ceph RADOS pools, on one or more Ceph clusters, next to the GridFS and S3 backends. As with S3, the attachment catalog stays in MongoDB's `attachments.files` collection: deduplication, reference counting and garbage collection work the same way, and only the payload bytes move.

Every payload lives in one pool of one cluster, and its catalog record names both, by cluster fsid and pool name. Records on several clusters coexist, so attachments can be spread over clusters the way MongoDB spreads documents over shards, and a cluster can be emptied and retired while mail keeps flowing.

## Object layout

A payload is striped the way RGW stripes an object. The head object holds the first stripe and the manifest, and tail objects hold the rest:

```
<prefix>/attachments/v1/<aa>/<bb>/<sha256>.<generation>      head: stripe 0, xattrs wd.sha256 + wd.manifest
<prefix>/attachments/v1/<aa>/<bb>/<sha256>.<generation>.1    tail: stripe 1, xattrs wd.sha256 + wd.head
<prefix>/attachments/v1/<aa>/<bb>/<sha256>.<generation>.2    ...
```

All objects of a payload live in one pool and RADOS namespace (`wildduck` by default). `stripeSize` (4 MiB by default) bounds every object, far below `osd_max_object_size`, so a 64 MiB attachment becomes 16 objects that recover and rebalance like any other small object.

The xattrs:

| xattr | Object | Content |
| --- | --- | --- |
| `wd.sha256` | every object | SHA-256 of the bytes of that object, so a scrub can check any object on its own |
| `wd.manifest` | head | JSON `{ v, length, stripeSize, sha256, stripes: [sha256 of every stripe] }` |
| `wd.head` | tails | name of the head, so a tail whose head does not exist can be found and removed |

The catalog record stores the locator:

```js
metadata.storage = {
    version: 1,
    backend: 'rados',
    fsid: '5f8e2c1a-7b3d-4e9f-a6c0-d1b2e3f4a5b6', // the cluster
    pool: 'wildduck.attachments',
    namespace: 'wildduck',
    key: 'production/attachments/v1/3e/e7/3ee7…5ab.5fd2c63ed632ba8b', // the head
    length: 10485883,
    stripeSize: 4194304,
    stripes: 3
};
```

Readers check the head's manifest against the locator before serving data.

## Clusters and placement

Clusters are configured by a label of your choice, with the fsid of the cluster:

```toml
type="rados"
minObjectSize=262144 # smaller payloads stay in GridFS, 0 sends all to RADOS

[rados]
prefix="production"
namespace="wildduck"
# where new payloads go, "<cluster>/<pool>:<weight>"
placement=["ams1/wildduck.attachments:2", "ams2/wildduck.attachments:1"]

[rados.clusters.ams1]
fsid="5f8e2c1a-7b3d-4e9f-a6c0-d1b2e3f4a5b6"
conf="/etc/ceph/ams1.conf"
user="client.wildduck"
keyring="/etc/ceph/ams1.client.wildduck.keyring"

[rados.clusters.ams2]
fsid="9c1f2d3e-0a1b-4c2d-8e3f-112233445566"
monHost="[v2:[2001:db8::21]:3300] [v2:[2001:db8::22]:3300] [v2:[2001:db8::23]:3300]"
user="client.wildduck"
keyring="/etc/ceph/ams2.client.wildduck.keyring"
```

- **fsid.** On connecting, the process asks the cluster for its fsid and refuses a cluster that answers with another one (`EFSIDMISMATCH`). A `ceph.conf` that points to the wrong cluster can therefore never send payloads to a cluster the catalog records do not name.
- **Reading.** A process reads payloads on every cluster in `rados.clusters`, in any pool unless `pools = ["…"]` lists the pools it may read. A record on a cluster the process does not know is refused rather than read from the wrong place. Every process that reads messages needs every cluster that holds payloads, including the processes that use WildDuck as a library (`kirin-plugin-wildduck`/`haraka-plugin-wildduck`, `zonemta-wildduck`).
- **Writing.** New payloads are spread over the `placement` targets by weighted rendezvous hashing of the attachment id: every target gets a share in proportion to its weight, and adding or removing a target only moves the share that target gains or loses. A target with weight `0` takes no new payloads but stays readable. A write that hits an outage (timeout, lost connection, a full or degraded cluster) moves on to the next target in line (`writeAttempts`, 2 by default), and the failed target goes to the back of the line for `downTime` ms. A refusal (no access, wrong fsid) is not retried elsewhere, since it needs fixing.
- **Small payloads.** Payloads smaller than `minObjectSize` bytes (256 KiB in the shipped configuration, measured after base64 decoding) stay in GridFS. Every RADOS object costs OSD metadata and a BlueStore minimum allocation, and with replication three times over; GridFS keeps such a payload in one chunk next to its record. An attachment that is already stored gets a reference wherever it is, so changing the threshold never moves or duplicates payloads. `minObjectSize=0` sends every new payload to RADOS.
- **Connections.** A cluster is connected on first use. When connecting fails, calls fail at once for `reconnectDelay` ms instead of each waiting for the timeout, then the next call tries again. `opTimeout` (30 s by default) bounds every RADOS and monitor operation; librados waits forever without it.
- **Environment variables.** The settings can also come from `APPCONF_attachments_rados_*` variables, for example `APPCONF_attachments_rados_clusters_ams1_fsid`. Use cluster labels without underscores. `placement` takes a comma separated list. `CEPH_ARGS` is ignored, since with several clusters in one process it would apply to all of them.

## Write once, head last

Payloads are never modified. Every upload gets a new random generation, so an object name is written once, and two processes storing the same new attachment write separate copies. The catalog insert that loses deletes its own copy, as with S3.

An upload writes the tails first, then the head. The head write is the commit point: a head only exists once every tail does, so a reader can never see a half-written payload. With a binding that supports compound write operations, the head is written with `rados_write_op_create(LIBRADOS_CREATE_EXCLUSIVE)`, `write_full` and `setxattr` in one operation. The current client (`lib/attachments/rados-client.js` on top of `node-librados`) has no write operations, so it writes the data and then the xattrs one at a time, with the manifest last. In that case the manifest xattr is the commit point, and a head without one reads as missing.

When an upload fails, the tails it wrote are removed. Tails left by a process that stopped mid-upload have no head, and a sweep (not written yet) can find them by listing the namespace and checking `wd.head`.

Deletion removes the head first, so the payload stops being readable at once, then the tails. Objects that are already gone count as deleted, so an interrupted deletion runs again from its tombstone, the same way S3 deletions do.

## Garbage collection

Orphaned attachments are collected as for S3: a tombstone in `attachments.trash` describes the payload (including its fsid and pool) before the record goes, so the payload is deleted even if the process stops in between. Failures are tracked per cluster: an outage of one cluster makes the rest of the pass leave that cluster alone, while records and tombstones on other clusters are still collected. Records and tombstones on clusters a process does not have are left to a process that has them.

## Integrity

RADOS has no equivalent of the S3 checksum header. The SHA-256 of the payload is checked against the attachment hash before writing, and every stripe's SHA-256 is stored in the manifest. A read checks every stripe it reads in full. Partial reads of a stripe (an IMAP partial FETCH) are not checked by default, because that would mean reading the whole stripe. `verifyPartialStripes = true` reads and checks whole stripes for those too. A mismatch fails the read with `EBADMSG`. A missing head answers `ENOENT`, which the indexer serves as a placeholder, like a missing GridFS file or S3 object.

## Ceph setup

One pool per cluster, with the `wildduck` application, and a user limited to the pool and namespace:

```sh
ceph osd pool create wildduck.attachments 32
ceph osd pool application enable wildduck.attachments wildduck
ceph auth get-or-create client.wildduck \
  mon 'profile simple-rados-client' \
  osd 'allow rw pool=wildduck.attachments namespace=wildduck'
```

The client's librados has to understand the cluster's keys. Ceph 21 (Umbrella) creates type 2 keys (32-byte secret), which older librados versions reject as malformed, so container images take `librados2` from the cluster's release on download.ceph.com. A RADOS client talks to the monitors (3300, 6789) and directly to every OSD (6800-7300).

`node-librados` is not a dependency of WildDuck, so installations without RADOS need no Ceph libraries. Install it next to WildDuck wherever RADOS attachments are read or written (`npm install node-librados`), together with `librados2`, and `librados-dev` when npm has to build the addon. Without it, the first RADOS operation fails with an error that says so.

## Limitations

- **Binding.** `node-librados` 1.0.3 runs every call as a blocking librados call on the libuv threadpool, has no `rados_aio_*` and no compound write operations, and ships prebuilt binaries without provenance. Set `UV_THREADPOOL_SIZE` well above the expected number of concurrent RADOS operations. A purpose-built addon would do `rados_aio_write_op_operate` (exclusive create + write_full + setxattrs), `rados_aio_read`, `rados_aio_getxattr`, `rados_aio_remove` and paged `rados_nobjects_list`.
- **No orphan tail sweep**, and no script that moves existing payloads from GridFS or S3 to RADOS, or from RADOS back to GridFS: `scripts/migrate-attachments-to-gridfs.js` handles S3 records only. New payloads go to RADOS once `type="rados"` is set, and existing ones stay readable where they are.
- **Whole payload in memory** while writing, as with the other backends (attachments are at most 64 MiB).
