# Concurrency control: strict 2PL, deadlock, MVCC

Course week 13. This note covers two families of concurrency control: lock-based serialization (two-phase locking and its strict and rigorous variants, the lock manager, multi-granularity locking, deadlock handling) and multi-version concurrency control (MVCC), with PostgreSQL and SQLite internals and a comparison of 2PL, MVCC, and optimistic concurrency control.

## 1. The core problem

A database serves many transactions at once. If their reads and writes interleave with no control, you get anomalies that a single serial execution would never produce. The classic four, in increasing strictness of the level that prevents them (Gray and Reuter formalize these as isolation degrees; PostgreSQL tabulates them in its isolation docs):

- Dirty read: T2 reads a row T1 wrote but has not committed. If T1 aborts, T2 read a value that never existed.
- Nonrepeatable read: T1 reads a row, T2 commits an update to it, T1 reads again and gets a different value within the same transaction.
- Phantom read: T1 runs a range query, T2 inserts a new row matching the range and commits, T1 reruns the query and a new row appears.
- Lost update: T1 and T2 both read x, both compute x+1, both write back; one update is silently overwritten.

The correctness target is serializability: a concurrent schedule is correct if it is equivalent to some serial order of the same transactions. The usual practical proxy is conflict serializability, checked by the precedence (conflict) graph: nodes are transactions, an edge T_i to T_j exists when T_i has an operation that conflicts with and precedes one of T_j on the same data item (two operations conflict when they touch the same item and at least one is a write). A schedule is conflict serializable if and only if this graph is acyclic. (CMU 15-445 concurrency control notes.)

Two questions then drive every design. First, how do you force the schedule to be (conflict) serializable? Second, how do you do it without making readers and writers wait on each other so much that throughput collapses? Lock-based methods answer the first by blocking; MVCC answers the second by keeping old versions so reads never need to block.

A second correctness concern is recoverability. Even a serializable schedule can be unrecoverable: if T2 reads T1's uncommitted write and T2 commits before T1, then T1 aborting leaves a committed transaction that depended on a rolled-back value. The stricter property, avoiding cascading aborts (ACA), requires that a transaction reads only committed data. That property is exactly what strict 2PL buys you for free, which is why it is the default in lock-based systems.

## 2. Mechanisms

### 2.1 Two-phase locking (2PL)

2PL is a protocol on lock acquisition order. Each transaction has two phases (CMU 15-445 concurrency control notes):

- Growing phase: the transaction may acquire locks but may not release any.
- Shrinking phase: the transaction may release locks but may not acquire any new ones.

The single rule "no lock acquired after the first release" is enough to guarantee conflict-serializable schedules. Locks come in modes; the minimal set is shared (S, read) and exclusive (X, write), with the compatibility rule that S is compatible with S, and X is compatible with nothing.

2PL by itself does not prevent dirty reads or cascading aborts, because a transaction is allowed to release a write lock during its shrinking phase before it commits, letting another transaction read the uncommitted value. Two stricter variants fix this:

- Strict 2PL: hold all exclusive (write) locks until the transaction commits or aborts. This means no other transaction can read or overwrite a value a transaction wrote until that transaction finishes, so dirty reads and cascading aborts cannot happen. (CMU notes: "A transaction must hold all of its WRITE locks until it commits/aborts.")
- Rigorous 2PL (also called strong strict 2PL): hold both shared and exclusive locks until commit or abort. Rigorous 2PL has the extra property that the serialization order equals the commit order, which simplifies reasoning and recovery. (CMU notes describe rigorous 2PL as holding both read and write locks until commit/abort.)

The invariant chain to remember: 2PL gives conflict serializability; strict 2PL additionally gives recoverability and avoids cascading aborts; rigorous 2PL additionally makes commit order equal serialization order. The cost of strict and rigorous variants is reduced concurrency, because locks are held longer, and the possibility of deadlock.

### 2.2 The lock manager and lock table

The lock manager is the in-memory subsystem that decides whether a lock request is granted now or queued. It owns the lock table: a hash table keyed by the locked object identifier (table OID, page, tuple id, or a hashed key). Each entry holds, conceptually:

- the granted group: the set of (transaction, mode) pairs currently holding the lock,
- a wait queue of pending requests in arrival order,
- the current granted mode (the strongest mode held).

A request is granted if its mode is compatible with every mode in the granted group and (to prevent starvation) with everything ahead of it in the queue; otherwise the requester blocks. Lock table entries are themselves protected by short-duration latches (mutexes), not by locks, because the lock table is shared mutable state. The distinction between locks (logical, transaction-duration, deadlock-detectable) and latches (physical, short, not deadlock-tracked) is a common exam point.

### 2.3 Multi-granularity (hierarchical) locking and intention locks

Locking every tuple individually has high overhead for a transaction that touches a whole table; locking the whole table kills concurrency for transactions that touch one row. Multi-granularity locking lets a transaction lock at the level that fits, over a hierarchy database -> table -> page -> tuple. To make coarse and fine locks coexist safely, intention locks announce intent at ancestor nodes before a descendant is locked (CMU notes):

- IS (intention shared): the transaction intends to take S locks somewhere below this node.
- IX (intention exclusive): the transaction intends to take X (or finer IX) locks below.
- SIX (shared and intention exclusive): S on the whole subtree (read everything) plus IX to modify specific descendants.

The protocol: to get S or IS on a node, hold IS or IX on its parent; to get X, IX, or SIX on a node, hold IX or SIX on its parent. Locks are acquired root to leaf and released leaf to root. The compatibility matrix is the load-bearing fact: IS conflicts only with X; IX conflicts with S, SIX, and X; S conflicts with IX, SIX, and X. So two transactions can both hold IX on the same table (both intend to modify, just different rows) without conflict, while a transaction wanting S on the whole table will conflict with anyone holding IX.

### 2.4 Deadlock: detection vs prevention

Locking can deadlock: T1 holds A and waits for B, T2 holds B and waits for A. Two strategies.

Detection. Build a waits-for graph: a node per active transaction, a directed edge T_i to T_j whenever T_i is blocked waiting for a lock held by T_j. A deadlock exists exactly when this graph has a cycle. The system periodically runs cycle detection (a depth-first search, O(V+E)); on finding a cycle it picks a victim and aborts it, releasing its locks. Victim selection weighs how long the transaction has run, how much work it would waste, and how many cycles it breaks. Detection lets transactions proceed optimistically and only pays when a cycle actually forms. (CMU notes: "Detection: Uses a waits-for graph to identify cycles after deadlocks occur, then selects a victim to abort.")

Prevention. Assign each transaction a timestamp at start; older means smaller timestamp and higher priority. When transaction T requests a lock held by transaction H, decide by relative age, never forming a cycle (CMU notes):

- Wait-Die (non-preemptive): if T is older than H, T waits; if T is younger, T dies (aborts and restarts later with its original timestamp). Older transactions wait, younger ones abort. The waiter is always older than the holder, so waits only point from old to young and cannot cycle.
- Wound-Wait (preemptive): if T is older than H, T wounds H (H aborts) and T takes the lock; if T is younger, T waits. Here a waiter is always younger than the holder, so again no cycle.

Keeping the original timestamp across restarts is what guarantees liveness: a transaction that keeps dying eventually becomes the oldest in the system and is allowed to wait. The mnemonic: in both schemes the older transaction never aborts in the "wait" branch, and reusing the timestamp prevents starvation.

Timeouts. The cheapest scheme is no graph at all: if a lock wait exceeds a timeout, assume deadlock and abort the waiter. It is simple and needs no bookkeeping, but it produces false positives (aborting transactions that were merely slow, not deadlocked) and the timeout value is a guess.

### 2.5 MVCC: the multi-version idea

MVCC keeps multiple physical versions of each logical row. The defining property (PostgreSQL MVCC docs): "in MVCC locks acquired for querying (reading) data do not conflict with locks acquired for writing data, and so reading never blocks writing and writing never blocks reading." CMU 15-445 calls MVCC "the most widely used scheme" and notes it is "now used in almost every new DBMS implemented in the last 10 years."

Core mechanics (CMU 15-445 MVCC lecture; Wu et al. survey):

- Each write to a logical row creates a new physical version rather than overwriting in place. Versions of one row form a version chain.
- Each version carries the timestamp (or transaction id) of the transaction that created it, plus a marker for when it ceased to be current.
- A transaction reads against a snapshot: a logical point in time. It sees the version of each row that was the latest committed version as of its snapshot, ignoring versions created by transactions not yet committed at snapshot time and versions created after.

Because old versions stick around, a reader never has to wait for a writer; it just reads the version its snapshot can see. This is the central trade: you swap lock contention for storage of old versions and the cost of reclaiming them later (garbage collection). MVCC is orthogonal to the concurrency-control protocol used for write/write conflicts: a system can layer timestamp ordering, OCC, or 2PL on top of multiversioning to order conflicting writers (CMU MVCC lecture lists exactly these three protocol options).

The Wu et al. survey decomposes MVCC into four design decisions:

1. Concurrency control protocol: timestamp ordering, optimistic, or two-phase locking, used to serialize writers.
2. Version storage: how versions are laid out. Append-only (new versions appended, used by PostgreSQL and MySQL/InnoDB), time-travel (main table holds current data, old versions in a separate store, used by Oracle and SAP HANA), and delta storage (store only the changed columns as deltas, used by MemSQL/SingleStore and NuoDB).
3. Garbage collection: tuple-level (reclaim individual dead versions once no active snapshot can see them) vs transaction-level (reclaim once the whole creating transaction is no longer visible to anyone). Both depend on the oldest active snapshot: a version is removable only when no live transaction could still need it.
4. Index management: indexes point either with logical pointers (to a row identity, then chase the version chain) or physical pointers (straight to a physical version). A consequence: an index entry can map to multiple physical versions, so MVCC indexes must support duplicate keys across snapshots.

IO and cost intuition. MVCC reads are cheap and lock-free but can chase a version chain (more IO when chains are long and GC lags). Writes always allocate a new version, which inflates table and index size until GC runs. The fundamental new cost relative to 2PL is space plus the background work of garbage collection.

## 3. How real systems do it

### 3.1 PostgreSQL: append-only MVCC on the heap

PostgreSQL stores versions inline in the heap (append-only version storage). Each heap tuple has a header, HeapTupleHeaderData, whose visibility-relevant fields are (PostgreSQL page layout docs, Table 66.4):

- t_xmin (4 bytes): the insert XID, the transaction id that created this version.
- t_xmax (4 bytes): the delete XID, the transaction id that deleted or superseded this version (zero while still live).
- t_cid (4 bytes): command id, distinguishing statements within one transaction.
- t_ctid (6 bytes): a tuple id pointing to "the current TID of this or newer row version," used to follow the update chain.

Why updates are delete-plus-insert. PostgreSQL does not modify a row in place. An UPDATE writes a new tuple version and sets the old version's t_xmax to the updating transaction's XID; a DELETE just sets t_xmax. The routine-vacuuming docs state it directly: "In PostgreSQL, an UPDATE or DELETE of a row does not immediately remove the old version of the row. This approach is necessary to gain the benefits of multiversion concurrency control (MVCC)." The old version stays visible to snapshots that began before the update committed.

Visibility rule (simplified). A tuple is visible to a transaction's snapshot when: its xmin committed and is in the past relative to the snapshot, and either xmax is unset, or xmax did not commit, or xmax is in the future relative to the snapshot. A snapshot records the set of in-progress XIDs at its start (plus the XID horizon), so "committed before my snapshot" is decided per tuple by checking xmin/xmax against that set and the commit log (pg_xact / clog). xmax doing double duty also encodes row locks: SELECT FOR UPDATE and friends record a locker in xmax without creating a new version.

VACUUM is mandatory, not optional. Because dead versions accumulate, PostgreSQL must vacuum. The docs list four reasons VACUUM runs: recover or reuse disk space from dead row versions, update planner statistics, update the visibility map, and protect against transaction id wraparound. Standard VACUUM "removes dead row versions in tables and indexes and marks the space available for future reuse" but does not generally return space to the OS.

The visibility map is a bitmap with bits per heap page marking pages where all tuples are visible to all transactions. It serves two ends: VACUUM skips all-visible pages, and an index-only scan checks the map first and skips the heap fetch when the page is all-visible. The docs note "the visibility map is vastly smaller than the heap, so it can easily be cached even when the heap is very large."

Transaction id wraparound. XIDs are 32-bit, and PostgreSQL compares them modulo 2^32: "for every normal XID, there are two billion XIDs that are 'older' and two billion that are 'newer'." If a cluster runs more than about 4 billion transactions without maintenance, old committed rows would suddenly appear to be in the future and become invisible: silent data loss. The defense is freezing: VACUUM marks sufficiently old, all-visible tuples as frozen. The docs define a reserved XID, FrozenTransactionId, that "does not follow the normal XID comparison rules and is always considered older than every normal XID"; frozen rows "will appear to be 'in the past' to all normal transactions regardless of wraparound issues." Since PostgreSQL 9.4 freezing sets a flag bit rather than overwriting xmin, "preserving the row's original xmin for possible forensic use." vacuum_freeze_min_age controls how old an XID must be before its rows are frozen; relfrozenxid in pg_class tracks the oldest unfrozen XID per table; autovacuum force-vacuums any table whose relfrozenxid is older than autovacuum_freeze_max_age. The hard requirement: vacuum every table in every database at least once every two billion transactions.

Isolation levels. PostgreSQL exposes the four SQL levels but implements three distinct ones; Read Uncommitted behaves like Read Committed (transaction isolation docs). Read Committed is the default and takes a fresh snapshot at the start of each statement. Repeatable Read takes one snapshot at transaction start and, unlike the bare SQL standard, does not allow phantoms. Serializable adds Serializable Snapshot Isolation (SSI), "which builds on Snapshot Isolation by adding checks for serialization anomalies"; on detecting a dangerous structure it aborts a transaction with a serialization failure.

Locking and deadlocks in PostgreSQL. Alongside MVCC, PostgreSQL has explicit locks: eight table-level modes from ACCESS SHARE (conflicts only with ACCESS EXCLUSIVE) up to ACCESS EXCLUSIVE (conflicts with everything), and four row-level modes (FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE, FOR KEY SHARE). PostgreSQL uses deadlock detection, not prevention: "PostgreSQL automatically detects deadlock situations and resolves them by aborting one of the transactions involved." A transaction "seeking either a table-level or row-level lock will wait indefinitely for conflicting locks to be released" so long as no deadlock is detected.

### 3.2 SQLite: file locks and WAL

SQLite is a single-file embedded database, and its concurrency story is much coarser. In the default rollback-journal mode it uses five whole-file lock states (SQLite file locking doc): UNLOCKED, SHARED (many simultaneous readers, no writer), RESERVED (one transaction intends to write but is still only reading; coexists with readers), PENDING (a writer is waiting for readers to drain and blocks new readers), and EXCLUSIVE (the writer holds it; "no other locks of any kind are allowed to coexist"). The PENDING state exists specifically to prevent writer starvation by blocking new readers once a writer is queued. The model is many readers or one writer, never readers and a writer at the same time.

WAL mode changes this. With write-ahead logging the writer appends changes to a separate WAL file instead of overwriting the database, and readers read a consistent end mark. The WAL docs state "WAL provides more concurrency as readers do not block writers and a writer does not block readers. Reading and writing can proceed concurrently," because "writers do nothing that would interfere with the actions of readers." This is effectively a lightweight MVCC: a reader's end mark is its snapshot. But the single-writer rule remains: "since there is only one WAL file, there can only be one writer at a time." So SQLite-WAL gives readers-do-not-block-writers, yet never allows two concurrent writers, which is the opposite end of the spectrum from PostgreSQL's full MVCC with concurrent writers serialized by row locks.

## 4. Common exam traps and misconceptions

- "2PL guarantees serializability, so it also avoids cascading aborts." False. Plain 2PL gives conflict serializability but can release write locks before commit, permitting dirty reads and therefore cascading aborts. You need strict 2PL (hold write locks to commit) for that.
- "Strict 2PL and rigorous 2PL are the same thing." False. Strict 2PL holds only write (X) locks to commit; rigorous 2PL holds both read and write locks to commit. Rigorous additionally makes serialization order equal commit order.
- "Wait-die and wound-wait are deadlock detection schemes." False. They are prevention schemes based on timestamps; no waits-for graph is built and no cycle ever forms. Detection is the waits-for-graph cycle search done after the fact.
- "In wait-die the older transaction aborts." False. In wait-die the older transaction waits and the younger one dies. In wound-wait the older transaction preempts (wounds) the younger. The older transaction never aborts in either scheme.
- "PostgreSQL prevents deadlocks." False. PostgreSQL detects deadlocks and aborts a victim; it does not prevent them. It also does not let you predict which transaction will be the victim.
- "MVCC means no locks at all." False. MVCC removes read-write blocking, but writers still need to be serialized against each other, by locks, timestamp ordering, or OCC. PostgreSQL still has a full lock manager and can deadlock on writes.
- "In MVCC, readers can block writers if a read is long enough." False, that is the whole point: under MVCC reading never blocks writing and writing never blocks reading. A long reader instead holds back garbage collection (it keeps an old snapshot alive), which is a space problem, not a blocking problem.
- "An UPDATE in PostgreSQL modifies the row in place." False. It writes a new tuple version and stamps the old one's xmax. This is why heavy update workloads bloat tables and why VACUUM is needed.
- "VACUUM is just a disk-space optimization you can skip." False. It also advances relfrozenxid to prevent transaction id wraparound; skipping it long enough risks the database shutting down to avoid wraparound data loss. The 32-bit XID space wraps after ~4 billion transactions; you must vacuum within two billion.
- "Snapshot isolation is the same as serializable." False. Plain snapshot isolation permits write-skew anomalies. PostgreSQL Serializable adds SSI checks on top of snapshot isolation to catch them.
- "PostgreSQL Repeatable Read allows phantom reads (per the SQL standard)." False for PostgreSQL specifically. Its Repeatable Read uses a transaction-level snapshot and does not exhibit phantoms, which is allowed because the standard only sets a floor on what must be prevented.
- "SQLite in WAL mode supports multiple concurrent writers." False. WAL lets readers and a writer run concurrently, but there is still only one writer at a time.
- "Phantom reads are stopped by row locks." False. A phantom is a row that does not exist yet, so there is no row to lock; you need range or predicate locks (or snapshot/serializable isolation) to prevent phantoms.

## 5. Good simulator ideas

1. Lock table and deadlock playground. The learner drives two or three transactions step by step, issuing read(x) and write(x) on a small set of items. The simulator shows the lock table (granted group and wait queue per item) and a live waits-for graph. When a cycle appears it highlights it and lets the learner pick the victim, then shows locks releasing. A toggle switches between strict 2PL, rigorous 2PL, and prevention modes (wait-die, wound-wait, timeout), so the learner sees the same interleaving produce a deadlock under detection but an immediate abort under prevention, and can read off which transaction aborts and why. Observable: which requests block, when a cycle forms, who the victim is.

2. MVCC version chain and snapshot viewer. The learner issues BEGIN, UPDATE, DELETE, and COMMIT across two transactions on a few rows. The simulator renders each row as a chain of tuple boxes showing xmin and xmax, and a side panel shows each transaction's snapshot (the in-progress XID set). As the learner steps, the tool grays out tuples invisible to the selected transaction and highlights the one version it reads, demonstrating that an in-progress update does not block the other transaction's read. A "run VACUUM" button then shows dead versions (those no live snapshot can see) being reclaimed, with a counter of reclaimable vs pinned-by-old-snapshot versions to make the GC-versus-long-reader trade-off concrete.

3. 2PL vs MVCC vs OCC race. The learner sets a workload mix (read-heavy vs write-heavy, low vs high contention on a hot key) and runs the same transactions under three engines side by side. The dashboard reports, per scheme, transactions blocked, transactions aborted and retried, and effective throughput. The intended takeaways: 2PL blocks under contention and can deadlock; OCC wastes work via aborts when contention is high; MVCC keeps reads non-blocking but its abort or space cost grows with writer contention and lagging GC. A contention slider lets the learner find the crossover point where each scheme wins.

## 6. Citations

- PostgreSQL "Concurrency Control: Introduction" (https://www.postgresql.org/docs/current/mvcc-intro.html). Defines MVCC and states the readers-do-not-block-writers property and that proper MVCC use generally outperforms locking.
- PostgreSQL "Transaction Isolation" (https://www.postgresql.org/docs/current/transaction-iso.html). The four SQL levels, that PostgreSQL implements three distinctly (Read Uncommitted behaves as Read Committed), the phenomena table, Read Committed default, and Serializable via SSI.
- PostgreSQL "Explicit Locking" (https://www.postgresql.org/docs/current/explicit-locking.html). The eight table-level and four row-level lock modes, the conflict matrix, and that PostgreSQL detects deadlocks and aborts a victim rather than preventing them.
- PostgreSQL "Database Page Layout" (https://www.postgresql.org/docs/current/storage-page-layout.html). HeapTupleHeaderData fields t_xmin, t_xmax, t_cid, t_ctid and their meaning for visibility and update chains.
- PostgreSQL "Routine Vacuuming" (https://www.postgresql.org/docs/current/routine-vacuuming.html). Why UPDATE/DELETE leave dead versions, the four purposes of VACUUM, the visibility map, 32-bit XID wraparound and the two-billion-transaction bound, FrozenTransactionId and freezing, relfrozenxid, and autovacuum_freeze_max_age.
- SQLite "File Locking And Concurrency In SQLite Version 3" (https://www.sqlite.org/lockingv3.html). The five lock states (UNLOCKED, SHARED, RESERVED, PENDING, EXCLUSIVE), the many-readers-or-one-writer model, and PENDING for writer-starvation avoidance.
- SQLite "Write-Ahead Logging" (https://www.sqlite.org/wal.html). WAL gives readers-do-not-block-writers concurrency but still only one writer at a time.
- CMU 15-445/645 Lecture Notes 15, "Concurrency Control Theory" (https://15445.courses.cs.cmu.edu/fall2022/notes/15-concurrencycontrol.pdf). 2PL growing/shrinking phases, strict vs rigorous 2PL, cascading aborts, the lock manager, waits-for-graph detection vs wait-die/wound-wait prevention, and intention locks (IS, IX, SIX).
- CMU 15-445/645 Lecture, "Multi-Version Concurrency Control" (https://15445.courses.cs.cmu.edu/fall2024/slides/19-multiversioning.pdf). MVCC as the dominant modern scheme, version chains, snapshot reads, and the four design decisions; companion notes at https://15445.courses.cs.cmu.edu/fall2021/notes/18-multiversioning.pdf.
- Wu, Arulraj, Lin, Xian, Pavlo, "An Empirical Evaluation of In-Memory Multi-Version Concurrency Control," PVLDB 10(7), 2017 (https://www.vldb.org/pvldb/vol10/p781-Wu.pdf). The four MVCC design decisions, version storage taxonomy (append-only, time-travel, delta) with example systems, tuple-level vs transaction-level GC, and logical vs physical index pointers.
- Gray and Reuter, "Transaction Processing: Concepts and Techniques," Morgan Kaufmann, 1992 (https://books.google.com/books/about/Transaction_Processing.html?id=VFKbCgAAQBAJ). Foundational treatment of isolation degrees, lock implementation, and recoverability that underlies the 2PL material here.

## 7. Glossary terms

- Two-phase locking (2PL): a locking protocol with a growing phase (acquire only) then a shrinking phase (release only); guarantees conflict-serializable schedules.
- Strict 2PL: 2PL that holds all exclusive (write) locks until commit or abort; prevents dirty reads and cascading aborts.
- Rigorous 2PL: 2PL that holds both shared and exclusive locks until commit or abort; makes serialization order equal commit order.
- Cascading abort: when aborting one transaction forces others that read its uncommitted data to abort too; avoided by strict/rigorous 2PL.
- Conflict serializability: equivalence to a serial schedule judged by conflicting operation order; holds iff the precedence (conflict) graph is acyclic.
- Recoverable schedule: one in which a transaction commits only after every transaction whose data it read has committed.
- Lock manager: the subsystem that grants, queues, and releases locks, backed by the lock table.
- Lock table: a hash table keyed by locked object, storing the granted group and the wait queue for each object.
- Latch: a short-duration mutex protecting in-memory structures; unlike a lock it is not transaction-scoped and not tracked for deadlock.
- Intention lock (IS, IX, SIX): a coarse-level marker that a transaction will take finer S or X locks below, enabling safe multi-granularity locking.
- Multi-granularity locking: locking at the level (table, page, tuple) that fits the access, coordinated by intention locks.
- Waits-for graph: directed graph with an edge from a blocked transaction to the transaction holding the lock it needs; a cycle means deadlock.
- Deadlock detection: periodically searching the waits-for graph for a cycle and aborting a victim.
- Deadlock prevention: avoiding cycles up front via timestamp rules (wait-die, wound-wait) so waiting can never be circular.
- Wait-die: prevention rule where an older transaction waits for a younger holder and a younger requester aborts (dies).
- Wound-wait: prevention rule where an older requester preempts (wounds, aborts) a younger holder and a younger requester waits.
- MVCC (multi-version concurrency control): keeping multiple versions of each row so reads use a snapshot and never block writers.
- Snapshot: a logical point-in-time view of the database a transaction reads against, defined by the set of transactions visible to it.
- Version chain: the linked sequence of physical versions of one logical row, ordered by the transactions that created them.
- xmin / xmax: PostgreSQL tuple header fields recording the inserting XID and the deleting/superseding XID, used for visibility.
- Visibility map: a per-page bitmap marking heap pages where all tuples are visible to all transactions; speeds VACUUM and index-only scans.
- VACUUM: PostgreSQL maintenance that reclaims dead tuple space, updates stats and the visibility map, and freezes old XIDs.
- Transaction ID wraparound: the failure mode when the 32-bit XID counter cycles (after ~4 billion transactions) and old rows appear to be in the future; prevented by freezing.
- Freezing / FrozenTransactionId: marking a tuple so it is treated as always in the past, immune to wraparound.
- Snapshot isolation (SI): an isolation level where each transaction reads a consistent snapshot; permits write-skew, so not fully serializable.
- Serializable Snapshot Isolation (SSI): snapshot isolation plus runtime checks that abort transactions forming serialization anomalies; PostgreSQL's Serializable level.
- Optimistic concurrency control (OCC): a scheme that runs transactions on private copies and validates for conflicts at commit, aborting and retrying on conflict.
