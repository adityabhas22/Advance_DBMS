# Bigtable: A Distributed Storage System for Structured Data

Source: Chang, Dean, Ghemawat, Hsieh, Wallach, Burrows, Chandra, Fikes, Gruber. "Bigtable: A Distributed Storage System for Structured Data." OSDI 2006, Google Inc.
Verified paper PDF: https://research.google.com/archive/bigtable-osdi06.pdf
Section and figure references below point into that paper text.

## What problem this paper solves and why it mattered

Google needed one storage system that could hold petabytes of structured data across thousands of commodity machines and serve workloads as different as backend batch indexing and latency-sensitive user-facing serving (Abstract; Section 1). Relational/parallel databases (the paper cites parallel databases and main-memory databases, refs [14], [13]) gave a full relational model with transactions but did not give the elasticity, the operational simplicity at this scale, or the direct control over physical data layout that Google wanted. Bigtable's answer was to drop the full relational model and offer a deliberately simpler interface: a sparse, distributed, persistent, multidimensional sorted map keyed by (row, column, timestamp), where every value is an uninterpreted byte array (Section 2). Clients reason about data locality directly through their choice of row keys and column-family/locality-group schema, and can choose whether data is served from memory or disk (Section 1). It mattered because it became the production substrate for more than sixty Google products (Section 1, 8) and the architectural template that NoSQL wide-column stores (HBase, Cassandra's storage engine, and the broader LSM-tree storage lineage) copied directly.

## The core mechanism (from first principles)

### The data model: a sparse sorted map (Section 2)

The fundamental abstraction is one map:

`(row:string, column:string, time:int64) -> string`

The value is an uninterpreted array of bytes; Bigtable does not parse it (Section 2). Three indexing dimensions:

- Rows. Row keys are arbitrary strings, currently up to 64KB, though 10 to 100 bytes is typical (Section 2, "Rows"). Data is held in lexicographic order by row key. The critical invariant: every read or write under a single row key is atomic regardless of how many columns are touched. There is no cross-row atomicity in the base model. Because rows are sorted, a client controls locality by choosing keys; the Webtable example reverses hostnames so `maps.google.com/index.html` is stored as `com.google.maps/index.html`, putting a domain's pages in contiguous rows.
- Column families. Column keys are grouped into column families, the basic unit of access control and of disk/memory accounting (Section 2, "Column Families"). A family must be created before any key in it is written. Families are meant to be few (hundreds at most) and stable; the number of columns within a family is unbounded. Column keys are named `family:qualifier`; family names must be printable, qualifiers can be arbitrary bytes. Data in one family is usually the same type and is compressed together.
- Timestamps. Each cell can hold multiple versions indexed by a 64-bit timestamp, either Bigtable-assigned real time in microseconds or client-assigned (Section 2, "Timestamps"). Versions are stored in decreasing timestamp order so the newest is read first. Two per-family garbage-collection settings: keep only the last n versions, or keep only versions newer than some age.

### Building blocks (Section 4)

Bigtable does not implement storage, locking, or coordination itself; it composes three lower services:

- GFS (Google File System, ref [17]) stores both the log files and the data files.
- SSTable, the on-disk file format. An SSTable is a persistent, ordered, immutable map from key to value, both arbitrary byte strings (Section 4). It is a sequence of blocks, typically 64KB each (configurable), with a block index stored at the end and loaded into memory when the SSTable is opened. A lookup is a single disk seek: binary-search the in-memory index to find the block, then read that one block. An SSTable can optionally be mapped fully into memory so lookups touch no disk. Immutability is the load-bearing property.
- Chubby, the distributed lock service (ref [8]). A Chubby cell is five replicas, one elected master, live when a majority can communicate; it uses Paxos (refs [9], [23]) to keep replicas consistent. It exposes a namespace of directories and small files; each can act as a lock, and reads/writes to a file are atomic. Clients hold sessions with leases and can register callbacks. Bigtable uses Chubby to: guarantee at most one active master; store the bootstrap location of the data (Section 5.1); discover tablet servers and finalize their deaths (Section 5.2); store schema (column-family info); and store access-control lists. If Chubby is down long enough, Bigtable is down. Measured unavailability attributable to Chubby across 14 clusters / 11 Chubby instances: 0.0047% average, 0.0326% for the worst single cluster (Section 4).

### Tablets and the three components (Section 5)

A table is range-partitioned by row key into tablets, the unit of distribution and load balancing (Section 2, "Rows"; Section 5). A table starts as one tablet and auto-splits as it grows; default tablet size is roughly 100 to 200 MB (Section 5). The implementation has three parts (Section 5):

1. A client library linked into every client.
2. One master server: assigns tablets to tablet servers, detects tablet-server arrival/expiration, balances load, garbage-collects GFS files, and handles schema changes.
3. Many tablet servers (typically ten to a thousand tablets each): serve reads/writes for their loaded tablets and split tablets that grow too large.

A key design point: client data does not flow through the master. Clients talk directly to tablet servers, cache tablet locations, and therefore rarely contact the master, which stays lightly loaded (Section 5).

### Three-level tablet location hierarchy (Section 5.1, Figure 4)

Tablet locations form a B+-tree-like three-level structure:

1. A file in Chubby holds the location of the root tablet.
2. The root tablet (the first tablet of a special METADATA table, never split so the hierarchy stays at three levels) holds the locations of all other METADATA tablets.
3. Each other METADATA tablet holds the locations of a set of user tablets.

A METADATA row keys a tablet location by an encoding of (table identifier, end row) and holds about 1KB in memory per row. With a 128 MB limit on METADATA tablets, the scheme addresses up to 2^34 tablets, i.e. 2^61 bytes of user data in 128 MB tablets (Section 5.1). Clients cache locations: a cold cache costs three round-trips including one Chubby read; a stale cache costs up to six because stale entries are only found on a miss. The client library prefetches more than one tablet's metadata per METADATA read to reduce this.

### Tablet assignment and failure handling (Section 5.2)

Each tablet is assigned to exactly one tablet server at a time. Tablet-server liveness is tracked through Chubby: on startup a tablet server creates and takes an exclusive lock on a uniquely named file in a Chubby "servers" directory; the master watches that directory. A server stops serving if it loses its lock (for example a network partition expiring its Chubby session). If its file still exists it tries to reacquire; if the file is gone it kills itself. The master periodically asks each server for its lock status; if a server reports losing the lock, or is unreachable, the master tries to grab that server's lock, and if it succeeds it deletes the server's file (ensuring that server can never serve again) and moves its tablets to the unassigned set. The master kills itself if its own Chubby session expires, but master death does not change tablet assignments. Master startup steps: (1) grab a unique master lock in Chubby; (2) scan the servers directory for live servers; (3) ask each live server what it already serves; (4) scan METADATA to learn all tablets, adding unassigned ones to the unassigned set (and adding the root tablet first if its assignment was not found, since the root names all METADATA tablets). Tablet splits are special: the tablet server initiates a split and commits it by recording the new tablet in METADATA, then notifies the master; if the notification is lost, the master discovers the split when it next asks a server to load a tablet that now covers only part of the requested range.

### The write path and tablet serving (Section 5.3, Figure 5)

A tablet's persistent state lives in GFS as a commit log (redo records) plus a sequence of SSTables. Recently committed updates sit in memory in a sorted buffer called the memtable.

Write path:
1. Check the mutation is well-formed and the sender is authorized (authorization reads a list of permitted writers from a Chubby file, almost always a Chubby-cache hit).
2. Write the mutation to the commit log. Group commit is used to push many small mutations efficiently (refs [13], [16]).
3. After the write is committed, insert its contents into the memtable.

Read path: a read executes over a merged view of the SSTable sequence plus the memtable. Because both the SSTables and the memtable are lexicographically sorted, this merge is efficient. Reads and writes can continue while tablets split and merge.

Recovery: a server reads the tablet's metadata from METADATA, which lists the tablet's SSTables and a set of redo points (pointers into commit logs). It reads the SSTable indices into memory and rebuilds the memtable by replaying committed updates after the redo points.

### Compaction: the LSM mechanism (Section 5.4)

This is the log-structured merge-tree pattern, and the paper says so in related work: the use of memtables and SSTables "is analogous to the way that the Log-Structured Merge Tree [26] stores updates" (Section 10).

- Minor compaction: when the memtable hits a size threshold it is frozen, a new memtable starts, and the frozen one is written to GFS as a new SSTable. Goals: shrink tablet-server memory and shrink the commit-log replay needed on recovery.
- Merging compaction: because every minor compaction makes a new SSTable, reads would eventually have to merge arbitrarily many SSTables. A background merging compaction reads a few SSTables plus the memtable and writes one new SSTable, then discards the inputs.
- Major compaction: a merging compaction that rewrites all SSTables into exactly one. Non-major compactions can leave special deletion entries that suppress deleted data still present in older live SSTables; a major compaction produces an SSTable with no deletion entries and no deleted data. Bigtable regularly major-compacts every tablet to reclaim space and to make deleted data actually disappear in bounded time (important for sensitive data).

### Refinements (Section 6)

- Locality groups: clients group families that are accessed together; each locality group gets its own SSTable per tablet, so a read of one group does not scan the others. A locality group can be declared in-memory (lazily loaded, then served without disk), used internally for the METADATA location family.
- Two-level caching: the Scan Cache caches key-value pairs at the SSTable interface (helps repeated reads of the same data); the Block Cache caches SSTable blocks read from GFS (helps spatially close reads).
- Bloom filters: optional per-locality-group Bloom filters (ref [7]) let a read ask whether an SSTable might contain a given row/column, so most lookups for nonexistent rows or columns avoid disk entirely.
- Commit-log implementation: one commit log per tablet server (not per tablet) to avoid many concurrent GFS files and to keep group-commit batches large. The cost is recovery complexity, because one log co-mingles many tablets' mutations. Recovery sorts log entries by (table, row name, log sequence number) so each tablet's mutations become contiguous and readable with one seek plus a sequential read; the sort is parallelized over 64 MB log segments, coordinated by the master. To survive GFS latency spikes, each tablet server runs two log-writing threads to two files, switching when the active one stalls; sequence numbers let recovery elide duplicates from a switch.
- Speeding tablet recovery: before moving a tablet, the source server does a minor compaction, stops serving, then does a second (fast) minor compaction to absorb mutations that arrived during the first, so the destination needs no log recovery.
- Exploiting immutability: because SSTables are immutable, reads need no file-system synchronization, so row concurrency control is cheap. The only mutable structure read and written together is the memtable, whose rows are made copy-on-write so reads and writes run in parallel. Permanent deletion of data becomes garbage collection of obsolete SSTables, done as mark-and-sweep with METADATA as the roots (ref [25]). Splits are cheap because child tablets share the parent's SSTables instead of rewriting them.

## Key facts and figures (examiner-quizzable)

- Data model: `(row, column, time) -> string`; sparse, distributed, persistent, multidimensional sorted map; values are uninterpreted bytes (Section 2).
- Row keys: arbitrary strings up to 64KB, 10 to 100 bytes typical; single-row read/write is atomic; no general multi-row transactions in the base API (Section 2; Section 3).
- Timestamps: 64-bit integers, microseconds if Bigtable-assigned; versions newest-first; GC by last-n-versions or by age (Section 2).
- Default tablet size: ~100 to 200 MB; a table starts as one tablet (Section 5).
- SSTable block size: typically 64KB, configurable; block index at end of file; one disk seek per lookup (Section 4).
- Chubby cell: 5 replicas, one master, live with a majority, uses Paxos (Section 4).
- Chubby-caused Bigtable unavailability: 0.0047% average over 14 clusters / 11 Chubby instances; 0.0326% worst single cluster (Section 4).
- Tablet location: three levels (Chubby file -> root tablet -> METADATA tablets -> user tablets); root tablet is never split (Section 5.1).
- Addressing capacity: each METADATA row ~1KB in memory; with 128 MB METADATA tablets, addresses 2^34 tablets = 2^61 bytes (Section 5.1).
- Location lookup cost: 3 round-trips on a cold cache (one is a Chubby read), up to 6 on a stale cache (Section 5.1).
- Three components: one master, many tablet servers (10 to 1000 tablets each), and a client library; client data bypasses the master (Section 5).
- Compaction trio: minor (memtable -> SSTable), merging (few SSTables -> one), major (all SSTables -> one, drops deletion entries) (Section 5.4).
- Compression: two-pass scheme (Bentley-McIlroy long-common-strings [6] then a fast 16KB-window pass); encodes 100 to 200 MB/s, decodes 400 to 1000 MB/s; achieved 10-to-1 on Webtable contents versus 3-to-1 or 4-to-1 for Gzip on HTML (Section 6).
- Performance, single tablet server (1000-byte values, Figure 6): random reads ~1212/s (slowest, each read pulls a 64KB block, ~75 MB/s from GFS, saturates CPU/network); random reads from memory ~10811/s; random writes ~8850/s; sequential writes ~8547/s; sequential reads ~4425/s; scans ~15385/s.
- Scaling: aggregate throughput grows by over 100x going from 1 to 500 tablet servers, but not linearly; random reads scale worst (~100x) because each read ships a 64KB block over shared 1 Gbps links (Section 7).
- Production scale (August 2006): 388 non-test clusters, ~24,500 tablet servers; one group of 14 busy clusters (8069 servers) saw >1.2 million requests/s, ~741 MB/s in, ~16 GB/s out (Section 8).
- Codebase: about 100,000 lines of non-test code; roughly seven person-years before April 2005 production launch (Section 9; Section 11).
- Example tables (Table 2): Crawl ~800 TB / 11% compression / 1000B cells / 16 families; Google Analytics raw click ~200 TB compresses to 14%; Personalized Search has 93 column families.

## Trade-offs and limitations

- No full relational model and no general multi-row/cross-row transactions. Only single-row transactions (atomic read-modify-write under one key) are supported; cross-row writes can only be batched at the client (Section 3). The lessons section explains this was deliberate: they delayed transactions because most apps needed only single-row atomicity, and the main demand for distributed transactions was secondary indexes, which they planned to serve with a narrower mechanism (Section 9).
- Hard dependency on Chubby. Extended Chubby unavailability means Bigtable unavailability (Section 4). This concentrates a coordination single point of failure even though the data plane is decentralized.
- Single logical master. The master is lightly loaded because clients bypass it, and master failure does not move tablets, but it is still one master per cluster (Section 5).
- Read amplification and disk-seek cost. A read may have to merge many SSTables plus the memtable; that is why merging/major compaction, Bloom filters, and block caching exist (Sections 5.3, 5.4, 6). Random small reads are the worst case: shipping a full 64KB block to return 1000 bytes saturates the network and CPU, which is why apps often drop block size to 8KB (Section 7).
- Schema rigidity for families. Column families are meant to be few and rarely changed, which pushes flexibility into qualifiers and timestamps rather than into the family layer (Section 2).
- Values are opaque. Bigtable does no type checking, no server-side joins, and no query optimization; the client owns serialization and locality design (Section 1; Section 10 notes "no complex queries to execute or optimize").
- Operational fragility from rare failures. The lessons (Section 9) list memory/network corruption, large clock skew, hung machines, asymmetric partitions, bugs in dependencies, GFS quota overflow; they responded with RPC checksums and by removing cross-component assumptions, and they emphasize that an over-complex tablet-membership protocol was scrapped for a simpler one depending only on widely used Chubby features.

## How it maps to the course

Week 15 (LSM trees, RocksDB compaction):
- Bigtable is the canonical production LSM-tree storage engine. Use Section 5.3 (memtable + commit log + immutable SSTables, merged read view) and Section 5.4 (minor, merging, major compaction) as the original-source definition of the write path that RocksDB and HBase inherit. The paper itself draws the lineage to O'Neil's LSM-tree (ref [26]) in Section 10.
- Tombstones and space reclamation: Section 5.4's "deletion entries" suppressing live older data, with major compaction as the step that physically removes deleted data, is the direct ancestor of RocksDB tombstones and full compaction. Good anchor for a lesson on read amplification, write amplification, and compaction policy.
- Bloom filters and block/scan caching (Section 6) ground the read-path optimizations a RocksDB lesson covers: per-table Bloom filters, block cache, and the seek-avoidance argument.
- SSTable format (Section 4): the 64KB block + in-memory index + single-seek lookup is the same SSTable concept RocksDB uses; cite it when introducing on-disk sorted-string tables.

Week 16 (partitioning, replication):
- Range partitioning: tablets are dynamic range partitions on the lexicographic row key (Section 2, Section 5). Contrast this with hash partitioning when teaching partitioning strategies; the Webtable reversed-hostname trick (Section 2) is a clean locality example.
- Partition metadata and routing: the three-level B+-tree-like location hierarchy with client-side caching and prefetch (Section 5.1) is a strong case study in how a partitioned system locates and routes to partitions without a metadata bottleneck.
- Membership, failure detection, and assignment via a lock service: Section 5.2 (Chubby leases, master detecting and fencing dead tablet servers by deleting their Chubby file, master self-fencing on session loss) grounds lessons on failure detection and fencing.
- Replication: replication is below Bigtable (GFS replicates SSTables and logs; Chubby replicates via Paxos) rather than in Bigtable's own data plane. Section 8.3 shows Personalized Search moving from client-side eventual-consistency replication to a server-side replication subsystem, and Section 11 mentions planned cross-data-center multi-master replication. Use this to distinguish storage-layer replication from application-visible cross-cluster replication.

## Viva question bank

1. What exactly is the Bigtable data model, and what is the key type?
   It is a sparse, distributed, persistent, multidimensional sorted map (Section 2). The key is the triple (row:string, column:string, time:int64) and the value is an uninterpreted array of bytes. Sparse means absent cells cost nothing; sorted means rows are stored in lexicographic row-key order.

2. What atomicity does Bigtable guarantee, and what does it not?
   Every read or write under a single row key is atomic across any number of columns (Section 2). It does not provide general cross-row or distributed transactions in the base API; clients can only batch cross-row writes (Section 3). They deferred general transactions deliberately because most applications needed only single-row atomicity (Section 9).

3. Walk through the write path.
   The tablet server checks the mutation is well-formed and the writer is authorized (reading permitted-writers from a Chubby file, usually a cache hit), writes the mutation to the per-server commit log using group commit, and only after the commit inserts it into the in-memory sorted memtable (Section 5.3). The data is durable once the log write commits; the memtable insert just makes it readable.

4. Walk through the read path and explain why the merge is cheap.
   A read runs over a merged view of the memtable plus the tablet's sequence of SSTables (Section 5.3). Both structures are lexicographically sorted, so the merge is an efficient merge of sorted streams. Bloom filters and the block/scan caches reduce how many SSTables actually get touched (Section 6).

5. Define the three compaction types and what each is for.
   Minor compaction freezes a full memtable and writes it to GFS as a new SSTable, shrinking memory and recovery cost. Merging compaction folds a few SSTables plus the memtable into one new SSTable to bound the number of files a read must merge. Major compaction rewrites all SSTables into exactly one and drops all deletion entries and deleted data, reclaiming space and ensuring timely physical deletion (Section 5.4).

6. Why are SSTables immutable, and what does that buy?
   Immutability means reads need no file-system locking, so row concurrency control is cheap; the only mutable shared structure is the memtable, made copy-on-write (Section 6, "Exploiting immutability"). It turns deletion into garbage collection of obsolete SSTables (mark-and-sweep with METADATA as roots), and it makes tablet splits fast because children share the parent's SSTables instead of rewriting them.

7. Describe the three-level tablet location hierarchy and its addressing capacity.
   Level one is a Chubby file pointing to the root tablet; the root tablet (first METADATA tablet, never split) points to all other METADATA tablets; each METADATA tablet points to user tablets (Section 5.1, Figure 4). With ~1KB per METADATA row and 128 MB METADATA tablets, it addresses 2^34 tablets, i.e. 2^61 bytes. The root is never split precisely to cap the hierarchy at three levels.

8. A client has a stale location cache. How many round-trips can a lookup take and why?
   Up to six round-trips, versus three for a cold cache (Section 5.1). Stale entries are only discovered on a miss, so the client may chase a wrong location, miss, and have to walk back up the hierarchy, doubling the worst-case path. Prefetching multiple tablets' metadata per METADATA read mitigates this.

9. How does Bigtable detect a dead tablet server and prevent split-brain?
   Each tablet server holds an exclusive Chubby lock on a uniquely named file (Section 5.2). The master periodically checks lock status; if a server is unreachable or reports losing its lock, the master tries to acquire that lock and, on success, deletes the server's file so the server can never serve again, then reassigns its tablets. The master also kills itself if its own Chubby session expires, and master death does not reassign tablets, so there is no split brain.

10. Why one commit log per tablet server rather than one per tablet, and what is the recovery cost?
    A log per tablet would create huge numbers of concurrent GFS files, cause many disk seeks, and shrink group-commit batches (Section 6). The cost is that one log co-mingles many tablets' mutations, so recovery sorts entries by (table, row name, log sequence number) to make each tablet's mutations contiguous, parallelized over 64 MB segments coordinated by the master, avoiding re-reading the whole log once per recovering server.

11. What does Chubby provide to Bigtable, and what is the risk?
    Chubby ensures a single active master, stores the bootstrap location, discovers and fences tablet servers, and stores schema and ACLs (Section 4). It is five Paxos replicas, live with a majority. The risk is a hard dependency: if Chubby is unavailable long enough, Bigtable is unavailable; measured unavailability from Chubby was 0.0047% on average across 14 clusters.

12. What are locality groups and how do they differ from column families?
    A column family is the unit of access control and accounting, grouping related column keys (Section 2). A locality group groups several families that are accessed together so each group gets its own SSTable per tablet, letting a read skip groups it does not need (Section 6). A locality group can also be marked in-memory and given its own compression settings.

13. Why are small random reads the worst-performing and worst-scaling operation?
    Each random read must fetch a full 64KB SSTable block from GFS over the network even though only a 1000-byte value is wanted; at ~1212 reads/s that is ~75 MB/s and it saturates the tablet server CPU and the network (Section 7). When scaling out, these block transfers saturate shared 1 Gbps links, so random reads scale only ~100x across 500 servers while random reads from memory scale ~300x. Apps mitigate by lowering block size to ~8KB.

14. How is Bigtable related to the LSM-tree, and where does the paper say so?
    Bigtable's memtable-plus-immutable-SSTable design with compaction is an LSM-tree storage engine: writes buffer in a sorted in-memory structure, flush to immutable sorted files, and reads merge memory and disk. Section 10 states explicitly that this is "analogous to the way that the Log-Structured Merge Tree [26] stores updates," citing O'Neil et al. 1996.

15. Bigtable does not replicate data itself in its data plane. So how is durability and cross-cluster availability achieved?
    Durability comes from below Bigtable: GFS replicates the commit log and SSTable files, and Chubby replicates coordination state via Paxos (Section 4). Cross-cluster availability is handled above the single-cluster data plane; for example Personalized Search first used client-side eventual-consistency replication and then a server-side replication subsystem (Section 8.3), and the paper notes planned cross-data-center multi-master replication (Section 11).

16. How does Bigtable delete data, given that SSTables are immutable?
    A delete writes a deletion entry (tombstone) into a new SSTable that suppresses older live values during the merged read (Section 5.4). The data is only physically removed when a major compaction rewrites all SSTables into one without any deletion entries or deleted data; Bigtable cycles major compactions over all tablets so deleted data disappears in bounded time, which matters for sensitive data.

## Glossary terms introduced

- Bigtable: a distributed storage system providing a sparse, distributed, persistent, multidimensional sorted map for structured data, scaling to petabytes over thousands of commodity servers.
- Row key: an arbitrary string (up to 64KB) that indexes a row; data is stored sorted by row key, and single-row operations are atomic.
- Column family: a named group of column keys that is the basic unit of access control, accounting, and same-type compression; created before use and meant to be few and stable.
- Column key: an individual column named `family:qualifier`; families are bounded and printable, qualifiers are unbounded arbitrary bytes.
- Timestamp: a 64-bit integer versioning a cell (microsecond real time if Bigtable-assigned), with versions stored newest-first and garbage-collected by count or age.
- Cell: the value at a given (row, column) pair, possibly holding multiple timestamped versions.
- Tablet: a contiguous row range, the unit of distribution and load balancing; default ~100 to 200 MB; assigned to one tablet server at a time.
- Tablet server: a server that loads and serves reads/writes for a set of tablets (typically 10 to 1000) and splits oversized tablets.
- Master: the single server that assigns tablets, detects tablet-server arrival/death, balances load, garbage-collects GFS files, and handles schema changes; off the client data path.
- METADATA table: the special table whose tablets store user-tablet locations; its first tablet is the never-split root tablet.
- Root tablet: the first METADATA tablet, never split, holding locations of all other METADATA tablets; pointed to by a Chubby file.
- GFS (Google File System): the underlying distributed file system that stores Bigtable's commit logs and SSTable files and provides replication.
- SSTable: an immutable, persistent, ordered map from byte-string keys to byte-string values, built from ~64KB blocks plus an in-memory block index allowing single-seek lookups.
- Chubby: a Paxos-based distributed lock and small-file service (five replicas) used for master election, bootstrap location, tablet-server discovery and fencing, schema, and ACLs.
- Memtable: the in-memory sorted buffer holding recently committed updates before they are flushed to an SSTable.
- Commit log: the per-tablet-server GFS log of redo records written (with group commit) before updates enter the memtable; replayed from redo points during recovery.
- Redo point: a pointer into a commit log marking where recovery must begin replaying updates for a tablet.
- Minor compaction: flushing a frozen memtable to a new SSTable on GFS.
- Merging compaction: combining a few SSTables plus the memtable into one new SSTable to bound the SSTable count.
- Major compaction: rewriting all of a tablet's SSTables into exactly one with no deletion entries or deleted data, reclaiming space.
- Deletion entry (tombstone): a marker in a newer SSTable that suppresses deleted data in older live SSTables until a major compaction removes it.
- Locality group: a client-defined grouping of column families stored together in their own SSTable per tablet, with optional in-memory and compression settings.
- Group commit: batching many small mutations into one commit-log write to raise throughput.
- Single-row transaction: an atomic read-modify-write under one row key, the only transactional unit Bigtable's base API supports.
