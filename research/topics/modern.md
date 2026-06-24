# Modern and distributed architectures (weeks 15-16)

Research note for the Advanced DBMS Internals course. Scope: LSM trees as the write-optimized
alternative to B-trees, columnar storage for OLAP, and the building blocks of distributed databases
(sharding, replication, two-phase commit, the CAP theorem and PACELC, consensus). Numbers and
invariants are attributed inline. Full URLs are in the Citations section. This is the lesson that
ties the prior single-node material (B+trees, WAL, MVCC, buffer pool, the iterator model) to the
question the course mission asks last: B-tree versus LSM, row versus column, single-node versus
distributed, and when each wins.

## 1. The core problem

Three separate pressures break the comfortable single-node B+tree-on-a-buffer-pool design, and each
gives rise to one branch of this note.

The first is write amplification on an update-in-place B+tree. A B+tree leaf is mutated in place. A
single logical insert of a small row can force a page read, an in-memory modification, and a page
write, plus a WAL record, plus eventual checkpoint flushing. Under a write-heavy workload the leaf
you need is rarely the leaf in cache, so inserts turn into random reads followed by random writes.
On spinning disks random writes are catastrophic, and even on flash they cost endurance and trigger
the device's own garbage collection. The question is whether a structure can turn small random
writes into large sequential ones. That is the log-structured merge tree.

The second pressure is the analytic scan. A row-store keeps each tuple's columns contiguous, which
is ideal when a query reads whole rows (OLTP: fetch this order, update this account). An analytic
query (OLAP) does the opposite: it touches two or three columns of a billion-row table and
aggregates them. A row-store drags every other column through the memory hierarchy to get at the
two it needs, wasting bandwidth and cache. The question is whether laying data out by column instead
of by row changes the economics. That is columnar storage, and the engine that exploits it best is a
vectorized one.

The third pressure is that one machine has finite disk, finite memory, and a single failure domain.
When the data or the request rate exceeds one node, or when downtime is unacceptable, you must spread
data across machines (partitioning) and keep copies (replication). Doing so introduces the network,
which can drop and delay messages arbitrarily, and now a write that used to be a local fsync becomes
a distributed agreement problem. The questions are how to split data, how to keep replicas in
agreement, how to commit a transaction that spans nodes, and what you are forced to give up when the
network partitions. Those are sharding, consensus, two-phase commit, and the CAP theorem.

## 2. Mechanisms

### LSM tree: structure and the read/write amplification trade-off

The log-structured merge tree was introduced by Patrick O'Neil, Edward Cheng, Dieter Gawlick, and
Elizabeth O'Neil, "The log-structured merge-tree (LSM-tree)", Acta Informatica 33(4):351-385, 1996.
The original framing is a multi-component structure: a memory-resident component C0 and one or more
disk-resident components C1, C2, and so on, with a rolling merge that continuously migrates entries
from the smaller component to the larger one. The point is to defer and batch index changes so that
many logical inserts are amortized into one large sequential disk pass, trading the random I/O of an
in-place tree for sequential I/O.

The modern incarnation (RocksDB, LevelDB, Cassandra, Bigtable) has settled on these concrete pieces:

- Memtable: an in-memory sorted structure (commonly a skip list) that absorbs all writes. A write is
  an append to the memtable plus an append to the write-ahead log. Both are cheap and sequential.
- Write-ahead log (WAL): an on-disk append-only log written before (or together with) the memtable
  update so that an in-memory memtable can be recovered after a crash. This is the same durability
  idea as a relational WAL, used here only to protect the volatile memtable, not to undo/redo pages.
- Immutable SSTables (sorted string tables): when the memtable fills, it is frozen (made immutable),
  a fresh memtable takes over, and the frozen one is flushed to disk as an SSTable. An SSTable is a
  persistent, ordered, immutable map from key to value (the exact definition from the Bigtable
  paper, Chang et al. 2006). Immutability is the whole trick: files are written once, sequentially,
  and never updated in place. Updates and deletes are new entries in newer SSTables; a delete writes
  a tombstone marker.
- Compaction: a background process that merges SSTables, drops superseded versions and tombstones,
  and keeps the number of files (and so the read cost) bounded.

The write path is therefore: append to WAL, insert into memtable, and occasionally flush an SSTable.
All sequential. The cost is paid on reads and on compaction.

The read path is the price. A point lookup must check the memtable, then potentially several
SSTables from newest to oldest, because the key could live in any of them and the newest copy wins.
Without help, a read touches O(number of sorted runs) files. Two mechanisms cut this down:

- Per-SSTable index plus a sparse block index, so within one file a key is found with a binary
  search rather than a scan.
- Bloom filter per SSTable (see below) so most SSTables that do not contain the key are skipped
  without any I/O.

This is the read/write amplification trade-off versus a B-tree, stated plainly. A B+tree does
roughly one logarithmic-depth random write per insert and one logarithmic-depth random read per
lookup: balanced, update-in-place, read-optimized. An LSM tree makes writes cheap and sequential but
pays in two amplifications:

- Write amplification: a byte written once to the memtable is rewritten several times as compaction
  carries it down through levels. RocksDB's documentation notes leveled compaction's write
  amplification is "often larger than 10" (RocksDB wiki, Leveled Compaction).
- Read amplification: a lookup may probe multiple files and multiple levels.

There is a third axis, space amplification: dead (superseded) data sits in older SSTables until
compaction reclaims it. The three cannot all be minimized at once. RocksDB's compaction overview
states the styles as direct trade-offs: leveled "minimizes space amplification at the cost of read
and write amplification", universal (tiered) "minimizes write amplification at the cost of read and
space amplification" (RocksDB wiki, Compaction). This is the read-update-memory (RUM) conjecture in
practice: pick at most two.

### Leveled versus tiered (size-tiered) compaction

Two compaction policies sit at the ends of the trade-off.

Tiered (size-tiered, RocksDB's "universal") groups SSTables of similar size. When enough runs of one
size accumulate, they are merged into one larger run at the next tier. Each level holds several
sorted runs. Consequence: few rewrites per byte (low write amplification) but a read may have to
check many runs (high read amplification), and two copies of a large run can exist during a merge
(high transient space amplification).

Leveled organizes data into levels L0, L1, L2, and so on, where (except L0) each level is a single
sorted run, range-partitioned across many fixed-size SSTable files with non-overlapping key ranges
(RocksDB wiki, Leveled Compaction). L0 is special: its files come straight from memtable flushes and
may overlap each other, so an L0-to-L1 compaction must take all overlapping L0 files. Each level has
a size target a fixed multiplier larger than the one above it; the default multiplier
(max_bytes_for_level_multiplier) is 10, so with a 16384-byte base, L1, L2, L3, L4 targets are about
16 KB, 160 KB, 1.6 MB, 16 MB (RocksDB wiki, Leveled Compaction). Compaction is triggered by a score
per level (level size divided by target size); the highest-scoring level is compacted by picking a
file and merging it with the overlapping key range in the next level down. Consequence: each level
is one run, so a read checks at most one file per level (low read amplification) and dead data is
bounded (low space amplification), but a byte is rewritten roughly once per level it descends, so
write amplification grows with the number of levels (the >10 figure above).

The one-line summary: tiered favors write-heavy workloads and accepts slower reads; leveled favors
read-heavy workloads and accepts more write churn. RocksDB also offers a hybrid (tiered+leveled,
which it confusingly calls "Level" in code) that "has less write amplification than leveled and less
space amplification than tiered" (RocksDB wiki, Compaction).

### Bloom filters

A Bloom filter is a probabilistic set membership structure that answers "is key X possibly in this
SSTable?" with either "definitely not" or "maybe". It never produces false negatives, only false
positives. That asymmetry is exactly what an LSM read needs: a "definitely not" lets the reader skip
an entire SSTable with zero I/O, and a false positive only costs a wasted lookup that returns
nothing.

Mechanics: a bit array of m bits and k independent hash functions. To insert a key, hash it k ways
and set those k bits. To test a key, hash it k ways and check those k bits; if any is 0 the key is
absent, if all are 1 the key is probably present. The false-positive probability after inserting n
keys is approximately (1 - e^(-kn/m))^k, minimized at k = (m/n) ln 2; at that optimum the
false-positive rate is about (0.6185)^(m/n) (UTH algorithms course note on Bloom filter false
positive rate). RocksDB's common configuration is about 10 bits per key (m/n = 10), which gives a
false-positive rate near 1 percent. The takeaway for an exam: more bits per key lowers the false
positive rate, the structure cannot have false negatives, and you cannot delete a key by clearing
bits (that could clear a bit shared with another key), which is why standard Bloom filters are not
deletable.

### Columnar storage: row versus column layout

A row-store (n-ary storage model, NSM) stores the columns of one tuple contiguously: row 1's a, b,
c, then row 2's a, b, c. A column-store (decomposition storage model, DSM) stores all values of
column a contiguously, then all of column b, then all of column c. Logically identical table,
physically transposed.

Why columnar wins for OLAP (a scan-and-aggregate query over a few columns of a wide table):

- I/O and bandwidth: a query reading 2 of 50 columns reads only those 2 column segments. The
  row-store must read every page, which carries all 50 columns, to extract the 2. Column projection
  becomes free at the storage layer.
- Compression: a column holds values of one type and often low cardinality or sortedness, so
  run-length encoding, dictionary encoding, bit-packing, and frame-of-reference encoding all work
  far better than on a heterogeneous row. Better compression means fewer bytes moved and more data
  per cache line. DuckDB's dictionary vectors and the SSTable-style segment compression are concrete
  instances.
- Vectorized scans: with one type per column laid out contiguously, the engine processes a batch
  (vector) of values in a tight loop that the CPU can keep in registers and SIMD lanes, amortizing
  per-tuple interpreter overhead across the whole batch. This is the opposite of the
  one-tuple-at-a-time Volcano iterator (see the volcano.md note).
- Late materialization: operate on compressed column vectors and selection vectors as long as
  possible, and only stitch the surviving rows back into wide tuples at the end. A filter can run
  over a dictionary-encoded column directly, producing a selection vector of qualifying positions,
  without ever materializing full rows.

Row-stores still win OLTP: point insert/update/delete of a whole tuple touches one contiguous place,
whereas a column-store would scatter that one row across many column segments. This is why the row
versus column choice maps onto the OLTP versus OLAP split, and why hybrid (HTAP) systems keep both.

### DuckDB: a vectorized push-based engine

DuckDB is an in-process (embedded) analytical OLAP database, deliberately "SQLite for analytics": it
"does not run as a separate process, but completely embedded within a host process" (DuckDB,
why_duckdb). Its engine is a "columnar-vectorized query execution engine, where queries are still
interpreted, but a large batch of values (a vector) are processed in one operation" (same source).
Concretely:

- Vectors and DataChunks. The unit of work is a Vector (a single column's values) and a DataChunk (a
  set of vectors forming a horizontal slice of columns). The default STANDARD_VECTOR_SIZE is 2048
  tuples (DuckDB docs, Execution Format). Operators are written to process whole vectors, not single
  rows.
- Multiple physical vector encodings carried through execution: flat (uncompressed contiguous),
  constant (one repeated value), dictionary (a child vector plus a selection vector of indices), and
  sequence (an offset plus increment, used for row ids) (DuckDB docs, Execution Format). Keeping data
  dictionary-encoded inside the engine is late materialization in action.
- Push-based execution. Classic vectorized engines (including DuckDB before 2021) used the
  pull-based Volcano model where the root repeatedly calls next() down the tree. DuckDB moved to a
  push-based model, where source operators push chunks up into the pipeline, which makes it easier to
  add operators and to run several pipelines concurrently. This is the modern contrast to the
  Volcano iterator covered earlier in the course.
- Morsel-driven parallelism. Work is split into small "morsels" of a pipeline's input that worker
  threads grab dynamically, after the Leis et al. morsel-driven design (DuckDB, why_duckdb).
- Bulk-optimized MVCC for ACID transactions, inspired by HyPer-style serializable main-memory MVCC
  (DuckDB, why_duckdb). So DuckDB is columnar and analytic but still transactional.

### Horizontal partitioning (sharding): hash versus range

Horizontal partitioning splits a table's rows across partitions (shards) by a partition key. Two
strategies dominate:

- Hash partitioning: assign a row to shard hash(key) mod N (or to a slot on a hash ring). Spreads
  load evenly and avoids hotspots, but destroys key order, so a range query (key BETWEEN x AND y)
  must fan out to every shard. Good for point access and even distribution.
- Range partitioning: assign contiguous key ranges to shards (keys 0-1M to shard A, 1M-2M to shard
  B). Range queries hit a contiguous set of shards, and ordered scans work, but skewed inserts (for
  example, monotonically increasing timestamps) create a hotspot on the last shard, and ranges can
  grow uneven and need splitting. Good for range/ordered access.

The trade-off mirrors the hash-versus-B+tree index trade-off from week 6-7, now at the cluster level:
hash spreads but cannot range, range orders but can hotspot.

### Replication: leader/follower and quorums

Replication keeps copies of each partition on several nodes for fault tolerance and read scaling.

- Leader/follower (primary/replica, single-leader): one replica is the leader and takes all writes;
  it ships its change log to followers, which apply it. Reads can go to followers. This is exactly
  PostgreSQL streaming replication (section 3). The choice of synchronous versus asynchronous
  replication is the core trade-off: synchronous waits for a follower to acknowledge before the
  commit returns, so no committed data is lost on leader failure but commit latency rises;
  asynchronous returns immediately, so it is fast but can lose the last writes if the leader dies
  before they propagate. Asynchronous followers are also eventually consistent: a read on a follower
  may return stale data (replication lag).
- Quorum (used in leaderless or multi-leader systems like Dynamo-style stores): with N replicas, a
  write must be acknowledged by W of them and a read must consult R of them. If W + R > N, the read
  and write sets overlap in at least one node, so a read is guaranteed to see the latest acknowledged
  write. Tuning W and R trades write availability against read freshness; for example W = N gives
  durable writes but no write availability if one node is down, while W = 1 gives high write
  availability but weak guarantees.

### Two-phase commit (2PC) and its blocking problem

When a transaction modifies data on several nodes, a local commit per node is not enough: some could
commit while others abort, breaking atomicity. 2PC coordinates an all-or-nothing decision.

- Phase 1 (prepare/vote): a coordinator asks every participant to prepare. A participant that votes
  "yes" must durably log a prepare record and promise it can commit no matter what (it can no longer
  unilaterally abort). It is now in an uncertain (in-doubt) state, holding locks.
- Phase 2 (commit/abort): if all voted yes, the coordinator logs and broadcasts commit; otherwise
  abort. Participants apply the decision and release locks.

The blocking problem: a participant that has voted yes and is waiting for the decision cannot make
progress on its own. If the coordinator crashes after participants prepared but before delivering the
decision, prepared participants are stuck in-doubt, holding locks, unable to commit or abort, until
the coordinator recovers (Kleppmann, Designing Data-Intensive Applications, ch 9; survey literature
on 2PC blocking). They cannot decide alone because committing might violate atomicity if the
coordinator chose abort, and aborting might violate it if the coordinator chose commit. 2PC is
therefore not partition/failure tolerant in the availability sense: it blocks. Three-phase commit
(3PC) inserts a pre-commit phase to make the protocol non-blocking, but only under a synchronous
network with bounded message delay, an assumption real asynchronous networks violate, which is why
3PC is rarely used and why production systems instead replicate the coordinator's decision log with
a consensus protocol (see below).

### The CAP theorem and the PACELC refinement

CAP, conjectured by Eric Brewer and proven by Seth Gilbert and Nancy Lynch in 2002 ("Brewer's
Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services"), concerns
three properties of a distributed data store:

- Consistency: here this means linearizability (atomic consistency), "every read receives the most
  recent write or an error". This is not the C in ACID. The exam trap below depends on this.
- Availability: every request to a non-failing node gets a (non-error) response, with no guarantee it
  is the most recent value.
- Partition tolerance: the system keeps operating even when the network drops or delays an arbitrary
  number of messages between nodes.

The theorem: a distributed store can provide at most two of these three at the same time. The honest
operational reading: network partitions will happen and are not something you can opt out of, so when
one occurs you must choose between consistency and availability. Cancel the operation (preserve
consistency, lose availability) or proceed (stay available, risk inconsistency). When there is no
partition you can have both (CAP theorem, Wikipedia summary of Gilbert-Lynch).

PACELC (Daniel Abadi, 2010) refines this by pointing out CAP only describes behavior during a
partition. Its statement: if there is a Partition, trade Availability against Consistency (the CAP
case); Else (normal operation), trade Latency against Consistency. The "else" half captures the cost
that CAP ignores: even with a healthy network, stronger consistency (waiting for synchronous
replication or a quorum) costs latency, and you can buy lower latency by relaxing consistency. PACELC
classifies systems as, for example, PA/EL (Dynamo-style: available under partition, low latency
normally) versus PC/EC (a system that always prioritizes consistency).

### Consensus: Raft and Paxos at a high level

Consensus is how a set of nodes agree on a single value (or, more usefully, on an ordered log of
commands) despite crashes and message loss, as long as a majority survive. It is the principled
replacement for a single fragile coordinator: replicate the decision log via consensus and no single
crash blocks progress.

- Paxos (Lamport) is the foundational protocol; Multi-Paxos extends single-value agreement to a log.
  It is correct but famously hard to understand and to implement.
- Raft (Ongaro and Ousterhout, "In Search of an Understandable Consensus Algorithm", USENIX ATC
  2014) was designed for understandability and produces a result equivalent to Multi-Paxos. It
  decomposes consensus into leader election, log replication, and safety. One leader is elected per
  term; clients send commands to the leader; the leader appends to its log and replicates entries to
  followers; an entry is committed once a majority (quorum) has stored it, after which it is applied
  to the state machine. If the leader fails, a follower times out and stands for election in a new
  term. A majority quorum guarantees any two overlapping decisions share a node, which is what keeps
  the agreed log consistent. Raft tolerates failures of a minority: a 5-node cluster survives 2
  failures.

Connect the dots: replicated state machine over Raft is how modern systems (etcd, CockroachDB,
Spanner-style designs) make replication and even 2PC non-blocking. The coordinator state itself is a
Raft group, so a single machine crash no longer leaves transactions in-doubt.

## 3. How real systems do it

### PostgreSQL

- Streaming replication. PostgreSQL is single-leader. A primary streams its WAL records to standby
  servers, which replay them; this is "streaming replication" as opposed to file-based log shipping
  (PostgreSQL docs, High Availability / different replication solutions). Standbys in hot standby
  mode accept read-only queries while the primary runs, giving read scaling.
- Synchronous versus asynchronous. Replication "can be synchronous or asynchronous". With synchronous
  commit on, "primary failure will never lose data"; with it off, there is "no waiting for multiple
  servers" but "possible data loss during fail over" (PostgreSQL docs, comparison matrix). This is
  the CAP/PACELC latency-versus-consistency trade-off realized as a configuration knob
  (synchronous_commit, synchronous_standby_names).
- Declarative partitioning. PostgreSQL supports PARTITION BY RANGE, PARTITION BY LIST, and PARTITION
  BY HASH (PostgreSQL docs, Table Partitioning). The partitioned table is a virtual table with no
  storage of its own; each partition is an ordinary table holding the rows in its bounds, and
  partitions can be sub-partitioned and carry their own indexes. Partition pruning eliminates
  partitions that cannot match a WHERE clause, at plan time and at execution time, and is driven by
  the partition bounds themselves, not by indexes (controlled by enable_partition_pruning, default
  on). Note this is partitioning within one server; cross-node sharding needs an extension or fork
  (for example Citus, postgres_fdw with partitions, or CockroachDB's PostgreSQL-compatible design).
- 2PC primitives. PostgreSQL exposes prepared transactions (PREPARE TRANSACTION / COMMIT PREPARED /
  ROLLBACK PREPARED) so an external transaction manager can run two-phase commit across multiple
  PostgreSQL instances; a prepared transaction that is never resolved holds locks and is the concrete
  form of the in-doubt blocking problem.
- Storage engine note. Core PostgreSQL is a row-store with an update-in-place heap and a B+tree
  (nbtree), not an LSM tree; its MVCC keeps old row versions in the heap rather than in stacked
  SSTables. Columnar and LSM behavior in the PostgreSQL world come from extensions and forks (for
  example column-store extensions, or OrioleDB), which is itself a useful contrast: PostgreSQL chose
  read-optimized update-in-place, and pays the VACUUM cost, rather than the LSM write-optimized path.

### SQLite

- WAL mode. SQLite's WAL maps cleanly onto the LSM-style append idea even though SQLite is a B-tree
  store. In WAL mode, changes are appended to a separate WAL file rather than written in place, and a
  COMMIT is the act of appending a commit record to the WAL (SQLite docs, Write-Ahead Logging).
  Moving those pages back into the main database file is a checkpoint, which by default runs
  automatically when the WAL reaches 1000 pages. A wal-index in shared memory (an mmapped file) lets
  readers locate the latest version of each page in the WAL quickly. Each reader records an end mark
  (the last valid commit it should see) so it gets a consistent snapshot, and a page is read from the
  WAL if present before the end mark, else from the database file. There can be only one writer at a
  time (one WAL file), but writers do not block readers and readers do not block the writer, which is
  the closest single-file SQLite gets to MVCC-style read concurrency.
- Single node by design. SQLite is an in-process library with no built-in replication, partitioning,
  or distributed transactions. It is the canonical "embedded OLTP row-store" baseline that DuckDB
  consciously mirrors for OLAP. The pairing is a good exam mnemonic: SQLite is embedded row-store
  OLTP, DuckDB is embedded column-store OLAP.

### LSM and columnar systems for grounding

- RocksDB is the reference LSM implementation: memtable plus WAL plus immutable SSTables plus
  pluggable compaction (leveled, universal/tiered, FIFO) plus per-SSTable Bloom filters and a block
  cache (RocksDB wiki). It is the engine inside many distributed databases.
- Bigtable (Chang et al. 2006) is the assigned paper that grounds this: writes go to a commit log and
  a memtable, the memtable is flushed to an immutable SSTable when full, and reads merge the memtable
  with the relevant SSTables, with minor and major (merging) compactions reclaiming space. Bigtable
  is the bridge from the LSM mechanism to the distributed world (tablets, range partitioning across
  tablet servers, a single master, storage on GFS).

## 4. Common exam traps and misconceptions

- "The C in CAP is the same as the C in ACID." False. CAP consistency is linearizability (every read
  sees the most recent write), a property of distributed reads/writes. ACID consistency is the
  preservation of integrity constraints by a transaction. They are different concepts; an MCQ that
  conflates them is wrong (Gilbert-Lynch; CAP theorem references).
- "CAP says you pick two of the three, freely, at design time." Misleading. Partitions are not
  optional; the network can always partition. So partition tolerance is effectively mandatory for a
  distributed store, and the real choice is between C and A during a partition. The clean "pick any
  two" phrasing hides this.
- "A CP system is always unavailable / a CA system exists in practice." False/misleading. PACELC and
  Gilbert-Lynch make clear that during a partition a CP system rejects some requests (loses
  availability) only on the minority side, and a genuinely partition-intolerant CA distributed system
  is not realizable on an asynchronous network. Single-node systems are trivially CA only because
  they have no partitions.
- "LSM trees are strictly faster than B-trees." False. LSM trees optimize writes (sequential,
  low-amplification) at the cost of read amplification and space amplification, and compaction
  consumes background I/O and CPU. B+trees are better for read-heavy and point-lookup workloads. The
  right answer is workload-dependent.
- "Bloom filters can give false negatives." False. Bloom filters never give false negatives (a
  "definitely not" is always correct); they give only false positives. That is exactly why they are
  safe for skipping SSTables.
- "You can delete a key from a standard Bloom filter by clearing its bits." False. Clearing a bit
  might clear one shared with another key, introducing false negatives. Deletion needs a counting
  Bloom filter, not the standard one.
- "Leveled compaction has lower write amplification than tiered." False, it is the reverse. Leveled
  minimizes space and read amplification at higher write amplification (>10 in RocksDB); tiered
  (universal) minimizes write amplification at higher read and space amplification (RocksDB wiki,
  Compaction).
- "Columnar storage is always better." False. It wins OLAP scan/aggregate workloads; it is worse for
  OLTP single-row insert/update/delete, which scatter one row across many column segments. Row-stores
  still win transactional workloads.
- "Vectorized execution means compiling the query to machine code." False (at least for DuckDB).
  DuckDB queries are still interpreted; vectorization means processing a batch (a vector, default
  2048 values) per operator call to amortize interpreter overhead, distinct from query compilation
  (DuckDB, why_duckdb; Execution Format).
- "Two-phase commit guarantees the transaction never blocks." False. 2PC is exactly the protocol with
  the blocking problem: a coordinator crash after participants prepare leaves them in-doubt holding
  locks. 3PC reduces blocking but only under synchronous-network assumptions; consensus-replicated
  coordinators are the practical fix.
- "3PC is non-blocking on any network." False. 3PC's non-blocking property depends on bounded message
  delay (a synchronous network); on a real asynchronous network it can still fail to terminate, which
  is why it is rarely deployed.
- "Hash partitioning supports efficient range queries." False. Hashing destroys key order, so a range
  query must scan all shards. Range partitioning supports range queries but can create write hotspots
  on monotonically increasing keys.
- "Synchronous replication has no downside." False. It guarantees no committed data is lost on leader
  failure but raises commit latency because the commit waits for a follower acknowledgment. This is
  the PACELC "else: latency vs consistency" trade-off.
- "Quorum reads/writes always need a majority." Partly false. The requirement for read-your-writes
  via overlap is W + R > N, which can be satisfied without a strict majority on each side (for
  example N=3, W=3, R=1). Majority quorums (W=R=2 for N=3) are common but not the only valid choice.
- "Raft and Paxos give different consistency results." False. Raft was designed to be more
  understandable than Paxos but produces a result equivalent to Multi-Paxos; the difference is
  pedagogical and structural, not in the guarantee (Ongaro and Ousterhout 2014).
- "PostgreSQL partitioning shards data across machines." False. Declarative partitioning splits a
  table across partitions within a single server; cross-node sharding requires an extension or fork
  (PostgreSQL docs, Table Partitioning).

## 5. Good simulator ideas

1. LSM write/compaction visualizer. The learner sets memtable capacity, compaction policy (tiered vs
   leveled), and the level size multiplier, then streams in writes. The widget animates: writes
   filling the memtable, the flush to an immutable SSTable, and compaction merging SSTables (showing
   tiered accumulating runs per level versus leveled keeping one run per level). Live counters show
   write amplification (bytes rewritten / bytes inserted), read amplification (files probed per
   lookup), and space amplification (dead bytes / live bytes), so the learner can watch the three
   move in opposite directions as they switch policy. A toggle adds a per-SSTable Bloom filter and
   shows the drop in files actually read on a negative lookup, with a slider for bits-per-key that
   updates the false-positive rate via (0.6185)^(m/n). This makes the RUM trade-off and the
   B-tree-versus-LSM choice concrete.

2. Row versus column scan race. The learner picks a query (how many columns of how many it touches)
   over a fixed wide table, and the tool draws the bytes actually read under NSM (row) versus DSM
   (column) layouts, plus a compression slider (raw / dictionary / RLE) that shrinks the column
   segments. A second panel steps through vectorized execution: a vector of 2048 values flowing
   through a filter that emits a selection vector, then a projection, then an aggregate, with late
   materialization shown as the rows only being stitched together at the very end. The learner sees
   why columnar plus vectorization wins OLAP and why row layout still wins a single-row fetch.

3. CAP/PACELC partition sandbox. A small cluster of three to five replica nodes with a leader and a
   client. The learner can cut the network (inject a partition), toggle synchronous versus
   asynchronous replication, and set quorum W and R. Then they issue writes and reads on either side
   of the partition and observe the outcomes: under a partition, a CP setting refuses the
   minority-side request (consistency kept, availability lost) while an AP setting accepts it and
   later shows a conflict/stale read (availability kept, consistency lost). With no partition, the
   sync-vs-async toggle shows the latency cost of consistency (the PACELC "else" branch), and a
   W+R>N indicator lights up to show when reads are guaranteed to see the latest write. An optional
   2PC mode lets the learner kill the coordinator mid-protocol and watch prepared participants block
   in-doubt, then replace the coordinator with a Raft group and watch the block disappear.

## 6. Citations

- O'Neil, Cheng, Gawlick, O'Neil, "The log-structured merge-tree (LSM-tree)", Acta Informatica
  33(4):351-385, 1996 (Springer): https://link.springer.com/article/10.1007/s002360050048
  The original LSM paper: multi-component C0/C1 structure, rolling merge, deferring and batching
  index changes to amortize disk I/O for insert-heavy workloads.
- RocksDB wiki, Compaction: https://github.com/facebook/rocksdb/wiki/Compaction
  The three compaction styles and the explicit trade-offs: leveled minimizes space amplification at
  the cost of read/write amplification; universal (tiered) minimizes write amplification at the cost
  of read/space amplification; tiered+leveled hybrid.
- RocksDB wiki, Leveled Compaction: https://github.com/facebook/rocksdb/wiki/Leveled-Compaction
  L0 overlap, one sorted run per non-zero level, the default level size multiplier of 10 and the
  16KB/160KB/1.6MB/16MB example, scoring and the cascading merge, write amplification "often larger
  than 10".
- Bloom filter false positive rate (University of Thessaly ECE, algorithms course note):
  https://courses.e-ce.uth.gr/ECE216/lectures/BloomFilter_FalsePositiveRate.pdf
  Derivation of the (1 - e^(-kn/m))^k false-positive probability, optimal k = (m/n) ln 2, and the
  (0.6185)^(m/n) optimum used for the bits-per-key reasoning.
- DuckDB, "Why DuckDB": https://duckdb.org/why_duckdb
  Embedded in-process model ("SQLite for analytics"), columnar-vectorized interpreted engine
  processing a vector per operation, morsel-driven parallelism, bulk-optimized MVCC for ACID.
- DuckDB docs, Execution Format (internals): https://duckdb.org/docs/stable/internals/vector
  STANDARD_VECTOR_SIZE default 2048, Vector and DataChunk, and vector encodings (flat, constant,
  dictionary with a selection vector, sequence).
- Bigtable: Chang et al., "Bigtable: A Distributed Storage System for Structured Data", OSDI 2006
  (Google Research): https://research.google/pubs/bigtable-a-distributed-storage-system-for-structured-data-awarded-best-paper/
  SSTable as a persistent ordered immutable map, commit log plus memtable write path, flush to
  immutable SSTable, minor/major compaction; the bridge from LSM mechanics to a distributed store.
- Gilbert and Lynch, "Brewer's Conjecture and the Feasibility of Consistent, Available,
  Partition-Tolerant Web Services", 2002, summarized at CAP theorem (Wikipedia):
  https://en.wikipedia.org/wiki/CAP_theorem
  Formal definitions: consistency as linearizability (not ACID consistency), availability, partition
  tolerance; at most two of three; the during-partition C-vs-A choice; and the PACELC extension
  (Abadi 2010, else: latency vs consistency).
- Ongaro and Ousterhout, "In Search of an Understandable Consensus Algorithm" (Raft), USENIX ATC
  2014; project page and PDF: https://raft.github.io/
  Raft as understandable Multi-Paxos-equivalent consensus: leader election, log replication, safety,
  majority-quorum commit, leader failover by term.
- PostgreSQL docs, High Availability and replication comparison:
  https://www.postgresql.org/docs/current/different-replication-solutions.html
  Streaming replication (WAL records to standbys), primary/standby model, hot standby read replicas,
  synchronous ("primary failure will never lose data") versus asynchronous ("possible data loss")
  trade-off.
- PostgreSQL docs, Table Partitioning:
  https://www.postgresql.org/docs/current/ddl-partitioning.html
  PARTITION BY RANGE/LIST/HASH, partitioned table is a virtual table while partitions are ordinary
  tables, partition pruning at plan and execution time driven by partition bounds
  (enable_partition_pruning).
- SQLite docs, Write-Ahead Logging: https://www.sqlite.org/wal.html
  WAL-mode append-on-commit, checkpoint moving pages into the main file (auto at 1000 pages), the
  wal-index in shared memory, per-reader end marks for snapshot reads, single-writer concurrency.

## 7. Glossary terms

- LSM tree (log-structured merge tree): write-optimized structure that buffers writes in memory and
  flushes immutable sorted files to disk, merging them with background compaction; trades read/space
  amplification for cheap sequential writes.
- Memtable: in-memory sorted buffer (often a skip list) that absorbs all writes before they are
  flushed to an SSTable.
- WAL (in LSM context): append-only on-disk log written alongside the memtable so the volatile
  memtable can be recovered after a crash.
- SSTable (sorted string table): persistent, ordered, immutable on-disk map from key to value; once
  written it is never modified in place.
- Tombstone: a marker record that records a deletion in an LSM tree, since data is never overwritten
  in place; removed during compaction.
- Compaction: background merging of SSTables that drops superseded versions and tombstones and bounds
  the number of files (and thus read cost).
- Leveled compaction: policy where each non-zero level is a single sorted run, sized a fixed
  multiplier larger than the level above; low read/space amplification, higher write amplification.
- Tiered (size-tiered, RocksDB universal) compaction: policy that merges similarly sized runs into
  larger ones, keeping several runs per level; low write amplification, higher read/space
  amplification.
- Write amplification: bytes physically written divided by bytes logically inserted; high for LSM
  leveled compaction (often >10 in RocksDB).
- Read amplification: number of files or pages read to answer a lookup; high when many sorted runs
  must be probed.
- Space amplification: bytes stored on disk divided by bytes of live data; the dead-data cost LSM
  pays until compaction reclaims it.
- RUM conjecture: you can optimize at most two of read, update (write), and memory (space)
  amplification; the LSM compaction policies are points on this trade-off.
- Bloom filter: probabilistic set-membership structure with no false negatives and tunable false
  positives, used to skip SSTables that cannot contain a key.
- Row-store (NSM): layout storing each tuple's columns contiguously; good for OLTP whole-row access.
- Column-store (DSM): layout storing each column's values contiguously; good for OLAP scan/aggregate
  over few columns, enables strong compression and vectorized scans.
- Vectorized execution: processing a batch (vector) of values per operator call to amortize
  interpreter overhead; DuckDB's default vector is 2048 values.
- Push-based execution: model where source operators push data chunks up the pipeline (contrast the
  pull-based Volcano iterator); DuckDB's engine since 2021.
- Late materialization: deferring the reconstruction of full rows until the end of a query, operating
  on compressed column vectors and selection vectors as long as possible.
- Selection vector: an array of qualifying row positions produced by a filter, letting later
  operators work on a subset without materializing rows.
- Morsel-driven parallelism: splitting a pipeline's input into small morsels that worker threads grab
  dynamically for load-balanced parallel execution.
- Horizontal partitioning (sharding): splitting a table's rows across nodes by a partition key.
- Hash partitioning: assign rows to shards by a hash of the key; even spread, no efficient ranges.
- Range partitioning: assign contiguous key ranges to shards; supports range scans, risks write
  hotspots on monotonic keys.
- Partition pruning (PostgreSQL): planner/executor elimination of partitions that cannot match a
  query, driven by partition bounds, not indexes.
- Leader/follower (primary/standby) replication: single node takes writes and ships its log to read
  replicas; PostgreSQL streaming replication.
- Synchronous vs asynchronous replication: sync waits for a follower ack before commit (no data loss,
  higher latency); async returns immediately (lower latency, possible loss and stale reads).
- Quorum (W, R, N): with N replicas, a write to W and read from R; W + R > N guarantees the read sees
  the latest acknowledged write.
- Two-phase commit (2PC): prepare/vote then commit/abort protocol for atomic distributed commit; can
  block if the coordinator fails after participants prepare.
- In-doubt (uncertain) state: a 2PC participant that has voted yes and is waiting for the decision,
  holding locks and unable to decide alone.
- Three-phase commit (3PC): a 2PC variant with a pre-commit phase to reduce blocking, non-blocking
  only under a synchronous network with bounded delay.
- CAP theorem: a distributed store gives at most two of consistency (linearizability), availability,
  and partition tolerance; during a partition you must choose C or A.
- Linearizability: the CAP notion of consistency, where every read returns the most recent completed
  write; distinct from ACID consistency.
- PACELC: the CAP refinement; if Partition then trade A vs C, Else trade Latency vs C even with a
  healthy network.
- Consensus: agreement by a group of nodes on an ordered command log despite crashes, requiring a
  surviving majority.
- Raft: an understandable consensus algorithm (leader election, log replication, safety) equivalent
  in result to Multi-Paxos; commits an entry once a majority stores it.
- Paxos / Multi-Paxos: the foundational consensus protocol; Multi-Paxos agrees on a log of values.
