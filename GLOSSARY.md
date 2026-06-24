# Advanced DBMS Glossary

The canonical language for this course. Every lesson uses these terms with these meanings. When several words exist for one concept, this file picks one and lists the rest as aliases to avoid, so the vocabulary compresses as you learn.

Terms are promoted here once they are understood and used correctly, not on first exposure. The glossary grows as the lessons are built and as learning records accumulate. It is grouped by subsystem to mirror the structure of the engine.

## Storage

**Page**:
The fixed-size unit of transfer between disk and memory, typically 4KB to 16KB. The database reads and writes whole pages, never individual bytes of disk.
_Avoid_: block (reserve "block" for the OS or device level)

**Slotted page**:
A page layout where a slot array grows in from one end and variable-length tuple data grows in from the other, with free space in the middle, so records can move within the page without changing their external identifier.
_Avoid_: page directory (that is a file-level structure)

**Tuple**:
One physical record stored on a page. Its on-disk identity is a record id.
_Avoid_: row (reserve "row" for the logical/SQL level), object

**Record id (RID)**:
The physical address of a tuple, usually (page number, slot number). Indexes and pointers store RIDs, not byte offsets, so a tuple can be moved within its page.
_Avoid_: pointer, address, ctid (ctid is the PostgreSQL spelling)

## Buffer pool

**Buffer pool**:
The in-memory cache of disk pages, divided into frames. All reads and writes of data go through it.
_Avoid_: cache (too generic), buffer cache

**Pin**:
A count of how many callers currently need a page to stay in memory. A frame with a nonzero pin count cannot be evicted.
_Avoid_: lock (pinning is not locking), reference hold

**Dirty page**:
A cached page whose in-memory copy has been modified and differs from the on-disk copy, so it must be written back before its frame is reused.
_Avoid_: modified buffer

## Index

**B+tree**:
A balanced, high-fanout search tree where all keys live in the leaves, the leaves are linked in sorted order, and every path from root to leaf has the same length. The default index structure in most relational databases.
_Avoid_: B-tree (in a B-tree internal nodes also carry data; this course means B+tree unless it says otherwise)

**Fanout**:
The number of children a tree node can point to. High fanout is what keeps a disk-resident tree shallow.
_Avoid_: branching factor, degree

## Transactions and concurrency

**Transaction**:
A unit of work that is atomic, consistent, isolated, and durable (ACID). It either commits in full or aborts with no trace.

**Schedule**:
An interleaving of the operations of several transactions. A schedule is serializable if its effect equals some serial order of those transactions.
_Avoid_: interleaving (use as a verb, not the noun for this)

**MVCC (multiversion concurrency control)**:
A concurrency method where each write creates a new version of a tuple rather than overwriting it, so readers see a consistent snapshot without blocking writers.
_Avoid_: versioning, snapshotting

## Recovery

**WAL (write-ahead log)**:
The rule and the file behind it: the log record describing a change must reach stable storage before the changed data page does. This is what makes crash recovery possible.
_Avoid_: redo log, journal, transaction log (use WAL consistently)

**LSN (log sequence number)**:
A monotonically increasing address of a log record. Each page records the LSN of the last log record that modified it, which is how recovery knows whether a change is already on the page.
_Avoid_: log id, sequence id
