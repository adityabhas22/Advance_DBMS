# Storage engine: pages, records, heap files

Course weeks 2-3. This note covers the lowest layer of a disk-oriented DBMS: how bytes on a block device become rows the executor can read and write. It grounds every number in PostgreSQL source and docs, the SQLite file format spec, and the CMU 15-445 storage lecture.

## 1. The core problem

A database has to store more data than fits in RAM, survive power loss, and still answer queries fast. That forces three constraints that shape everything below.

First, the persistent device is not byte-addressable the way memory is. To read one value, the hardware must pull in a whole block. The CMU 15-445 notes put it plainly: non-volatile storage "is also block/page addressable. This means that in order to read a value at a particular offset, the program first has to load the 4 KB page into memory" (CMU 15-445 Lecture 03). So the DBMS cannot operate on disk data in place. It must move fixed-size chunks between disk and a buffer pool in memory, and every design choice is about minimizing how many of those chunk transfers (I/Os) a query needs.

Second, disk latency dominates. The same notes give the intuition: if an L1 cache reference took one second, reading from an SSD would take 4.4 hours and an HDD 3.3 weeks. The unit of work is therefore the page, not the byte, and sequential access is far cheaper than random access because it amortizes seek and rotational cost (HDD) or maps to large flash reads (SSD).

Third, without a page-and-record layer you cannot do several things at once: pack many variable-length rows densely into a block, give each row a stable address an index can point at, reclaim space when rows are deleted, and update a row without rewriting the whole file. A naive "append each row to the end of a flat file" design (the strawman the CMU notes describe) breaks the moment rows are deleted or have variable length: you get holes you cannot reuse and you cannot address a row by position. The slotted page plus heap file plus free space map exists to solve exactly these failures.

A note on why the DBMS does this itself instead of leaning on the OS. You could `mmap` the file and let virtual memory page it in. The CMU notes warn against it: on a page fault "the process will be blocked," and the DBMS "always wants to control things itself and can do a better job at it since it knows more about the data being accessed." The OS cannot make eviction, prefetch, or write-ordering decisions that respect transaction boundaries. So the storage manager owns the file layout and the buffer pool owns memory.

## 2. Mechanisms

### The page (block) abstraction

The DBMS organizes each file into fixed-size pages. Fixed size is deliberate: variable-size pages mean deleting one leaves a hole the system cannot easily refill, per the CMU notes. There are three distinct "page" concepts (CMU 15-445 Lecture 03):

- Hardware page, usually 4 KB. The device guarantees an atomic write only at this granularity. "If the hardware page is 4 KB and the system tries to write 4 KB to the disk, either all 4 KB will be written, or none of it will."
- OS page, typically 4 KB.
- Database page, commonly 1 KB to 16 KB.

The atomicity gap matters: if the database page (say 8 KB) is larger than the hardware page (4 KB), a crash mid-write can leave a torn page (half old, half new). PostgreSQL defends against this with full-page writes to the WAL; this is also why `pd_lsn` lives in the page header.

Page size is a tradeoff. Larger pages mean fewer I/Os for a sequential scan and a smaller index fanout cost, but more wasted space for small random reads and more contention on a hot page. PostgreSQL fixes 8 KB at compile time. SQLite lets you pick a power of two.

### Slotted page layout

The dominant within-page layout is the slotted page, "the most common approach used in DBMSs today" (CMU 15-445). The structure:

```
+----------------------------------------------------+
| page header                                        |
+----------------------------------------------------+
| slot 0 | slot 1 | slot 2 | ...     -> grows down    |
|                                                     |
|                  free space                         |
|                                                     |
|     <- grows up      ... | tuple 2 | tuple 1 | tuple 0
+----------------------------------------------------+
```

The header records the number of used slots and the offset of the start of the last used slot. The slot array maps each slot index to the byte offset where that tuple begins. To insert: the slot array grows from the front toward the end while tuple data grows from the end toward the front; the page is full when the two meet (CMU 15-445 Lecture 03, section 7). A free-space pointer (or the pair of pointers PostgreSQL uses) marks the boundary.

The reason for the indirection: a record's external identity is `record id = (page id, slot number)`, but the slot can point anywhere inside the page. So the DBMS can compact tuple data within a page, or move a tuple to defragment, and only the in-page slot offset changes. The stable record id an index holds never has to change. The CMU notes stress an application "cannot rely on these ids to mean anything"; they are internal addresses.

Lookup cost: given a record id, one page read, then O(1) slot-array indexing to the offset. Insert: O(1) if there is room. Delete: mark the slot, leave a gap to be compacted later.

### Records (tuples): fixed vs variable length, headers, NULLs, alignment

A tuple is "essentially a sequence of bytes" that only the DBMS knows how to decode (CMU 15-445). It carries:

- A tuple header with concurrency/visibility metadata (which transaction created or deleted it) and a NULL bitmap. The DBMS does not store schema metadata per tuple; the table catalog holds that.
- The attribute data, stored in the column order declared at `CREATE TABLE`.

Fixed-length attributes (an `int`, a `char(8)`) sit at a computable offset. Variable-length attributes (`varchar`, `text`, `bytea`) force either a length prefix or an in-tuple offset array, because you cannot compute the start of column N+1 without knowing the length of column N.

NULL handling uses a bitmap rather than a sentinel value, because any sentinel could be a legal value. One bit per column says present-or-null; the column's bytes are then omitted from the data area when null.

Alignment and padding: CPUs read aligned words faster, and some require alignment. So the DBMS pads fields to natural boundaries and aligns the start of user data to a platform boundary. In PostgreSQL this is MAXALIGN, typically 8 bytes. A practical consequence: column order changes the on-disk size of a row because of padding gaps. Putting an 8-byte `bigint` after a 1-byte `bool` can waste 7 bytes of pad that disappears if you reorder.

### Heap file organization

A heap file is "an unordered collection of pages where tuples are stored in random order" (CMU 15-445). The engine needs a way to find a page given a `page_id`. Two schemes:

1. Linked list of pages. A header page holds a pointer to a list of free pages and a list of data pages. Finding a page with enough free space means walking the data-page list: a sequential scan, O(number of pages) in the worst case.
2. Page directory. Special directory pages map each `page_id` to its location and record how much free space that page has. A lookup is then a directory probe rather than a list walk.

PostgreSQL is effectively the page-directory style at the file level (relation files plus a separate free space map fork). SQLite stores everything in B-trees in one file.

### Free space management

To insert a row the engine must find a page with enough room without scanning every page. That is the free space map's job. The granularity tradeoff: tracking exact free bytes per page is precise but large; tracking coarse buckets is compact but can send you to a page that turns out too small. PostgreSQL's FSM (see below) quantizes free space to one byte per page (256 levels) and arranges it as a tree so a search for "a page with at least N free bytes" is logarithmic in the number of pages, not linear.

### Tuple deletion: tombstones and vacuum

You generally do not physically erase a deleted row immediately, for two reasons. Under MVCC, concurrent transactions may still need to see the old version. And physical removal mid-page means immediate compaction, which is expensive and conflicts with readers. So deletion writes a tombstone: the row is marked dead (in PostgreSQL via the deleting transaction id `t_xmax`, plus the line pointer eventually moving to a dead state), and a later background pass reclaims the space. That pass is VACUUM in PostgreSQL. The cost model: deletes and updates are cheap and non-blocking, at the price of bloat that a separate maintenance process must clean up, and at the price of readers having to skip dead versions until then.

## 3. How real systems do it

### PostgreSQL

Page size is 8 KB, fixed at server compile time (PostgreSQL docs, "Database Page Layout"). A page has five parts: PageHeaderData, the ItemId (line pointer) array, free space, the items (tuples), and special space (used by index access methods, empty for ordinary heap tables).

PageHeaderData is 24 bytes (Table 66.3 in the docs). Key fields:

- `pd_lsn` (8 bytes): the WAL position of the last change to this page. The buffer manager will not flush this page to disk until the WAL up to `pd_lsn` is durable. This is the write-ahead rule enforced at the page level.
- `pd_checksum` (2 bytes), `pd_flags` (2 bytes).
- `pd_lower` (2 bytes): offset to the start of free space (end of the line pointer array).
- `pd_upper` (2 bytes): offset to the end of free space (start of tuple data).
- `pd_special` (2 bytes), `pd_pagesize_version` (2 bytes), `pd_prune_xid` (4 bytes): oldest unpruned XMAX, or zero.

So `pd_lower` grows down and `pd_upper` grows up; their gap is the free space, exactly the slotted-page invariant.

Line pointers (ItemIdData) are 4 bytes each, defined in `src/include/storage/itemid.h` as bitfields:

```c
typedef struct ItemIdData
{
    unsigned lp_off:15,   /* offset to tuple (from start of page) */
             lp_flags:2,  /* state of line pointer, see below */
             lp_len:15;   /* byte length of tuple */
} ItemIdData;
```

The 2-bit `lp_flags` is one of four states (itemid.h):

```c
#define LP_UNUSED   0  /* unused (should always have lp_len=0) */
#define LP_NORMAL   1  /* used (should always have lp_len>0) */
#define LP_REDIRECT 2  /* HOT redirect (should have lp_len=0) */
#define LP_DEAD     3  /* dead, may or may not have storage */
```

`LP_REDIRECT` supports HOT (heap-only tuple) update chains: the line pointer redirects to a newer version on the same page, so indexes need not be updated. `LP_DEAD` is set during pruning; the slot can be reclaimed by VACUUM. The 15-bit `lp_off` is why a single heap page tops out at 32 KB of addressable offset (2^15), which is consistent with PostgreSQL's 8 KB or 16 KB build options but not larger.

HeapTupleHeaderData (Table 66.4, source in `src/include/access/htup_details.h`):

- `t_xmin` (4 bytes): inserting transaction id.
- `t_xmax` (4 bytes): deleting transaction id (zero if live). This is the tombstone marker.
- `t_cid` / `t_xvac` (4 bytes, overlaid).
- `t_ctid` (6 bytes): the tuple id of this or a newer version of the row; the update chain pointer.
- `t_infomask2` (2 bytes): attribute count plus flag bits.
- `t_infomask` (2 bytes): flag bits, including `HEAP_HASNULL`.
- `t_hoff` (1 byte): offset to user data; must be a multiple of MAXALIGN.

The documented minimum header size is 23 bytes on most machines. The NULL bitmap appears only if `HEAP_HASNULL` is set in `t_infomask`, sits right after the fixed header, and uses 1 bit per column (1 means not-null, 0 means null). User data starts at `t_hoff`, aligned to MAXALIGN (typically 8 bytes).

TOAST (The Oversized-Attribute Storage Technique), PostgreSQL docs "TOAST": because a tuple cannot span pages, a row wider than about 2 KB (TOAST_TUPLE_THRESHOLD, roughly the 8 KB page divided by 4) triggers TOAST. There are four per-column strategies:

- PLAIN: no compression, no out-of-line; the only option for non-TOAST-able types.
- EXTENDED: both allowed; the default. Compression is tried first, then out-of-line if still too big.
- EXTERNAL: out-of-line allowed, compression off. Makes substring operations on wide `text`/`bytea` faster.
- MAIN: compression allowed, out-of-line only as a last resort.

Out-of-line values move to a separate TOAST table with columns `(chunk_id, chunk_seq, chunk_data)`, split into chunks of about 2000 bytes (TOAST_MAX_CHUNK_SIZE), sized so four chunks fit on a page. The in-line pointer datum is 18 bytes and records the TOAST table OID, the value OID, the logical size, and the physical size. The maximum logical size of a TOAST-able field is 1 GB (2^30 minus 1 bytes). Compression default is set by `default_toast_compression` (pglz or lz4 in recent versions).

Free space map (PostgreSQL docs "Free Space Map"): stored as a separate fork file named `<filenode>_fsm`. The bottom level stores one byte of free-space info per heap or index page. Within each FSM page is a binary tree, one byte per node, where each non-leaf node holds the larger of its children, so the root holds the maximum free space in that subtree. Upper FSM levels aggregate lower ones. A search for a page with enough room walks down this tree. Detail is in `src/backend/storage/freespace/README`. The related visibility map is a separate `_vm` fork.

VACUUM (PostgreSQL docs "Routine Vacuuming") has four jobs: reclaim space from dead tuples (left by UPDATE/DELETE under MVCC), update planner statistics (via ANALYZE), update the visibility map (which lets later vacuums skip clean pages and lets index-only scans avoid heap fetches), and prevent transaction id wraparound. XIDs are 32-bit, so every table must be vacuumed at least once every roughly two billion transactions; VACUUM freezes old rows with `FrozenTransactionId`, which compares as older than every normal XID. Plain VACUUM marks dead space reusable in place and generally does not return space to the OS (except when whole trailing pages become empty); it takes a SHARE UPDATE EXCLUSIVE lock and runs alongside queries. VACUUM FULL rewrites the entire table into a new file, returns space to the OS, but takes an ACCESS EXCLUSIVE lock that blocks all access. The docs recommend avoiding VACUUM FULL in routine operation.

### SQLite

SQLite stores the whole database in a single file (SQLite "Database File Format"). Page size is a power of two from 512 to 65536 bytes (65536 since version 3.7.1, encoded as the value 1 at offset 16); the default for new databases is 4096. Page 1 starts with a 100-byte database header (magic string "SQLite format 3\0", page size at offset 16, file change counter, freelist trunk page and freelist page count at offsets 32 and 36, text encoding, and so on).

Every B-tree page (SQLite is B-tree-organized, not heap-organized) has this layout in order: the b-tree page header (8 bytes for a leaf, 12 for an interior page), the cell pointer array, unallocated space, the cell content area (which grows downward), and an optional reserved region. The page header fields:

- offset 0, 1 byte: page type. 0x0d table leaf, 0x05 table interior, 0x0a index leaf, 0x02 index interior.
- offset 1, 2 bytes: offset of the first freeblock, 0 if none.
- offset 3, 2 bytes: number of cells.
- offset 5, 2 bytes: offset to the start of the cell content area (0 means 65536).
- offset 7, 1 byte: number of fragmented free bytes.
- offset 8, 4 bytes: right-most child pointer (interior pages only).

This is the same slotted idea: the cell pointer array (2-byte big-endian offsets, one per cell, kept in key order) grows from the top while cell content grows up from the bottom. A "cell" is SQLite's record. A table leaf cell is `varint payload_size`, `varint rowid`, the payload, then an optional 4-byte first-overflow-page pointer.

Freeblocks are SQLite's in-page free list. When a cell is deleted and the gap is at least 4 bytes, it becomes a freeblock: a 4-byte header of `(next freeblock offset, size in bytes)`, chained in increasing-offset order. Gaps of 1 to 3 bytes are too small to chain and are counted as fragmented free bytes (offset 7); a well-formed page keeps fragmented bytes at or below 60. So SQLite reclaims intra-page space by chaining freeblocks and occasionally defragmenting, rather than running a separate VACUUM process (though SQLite also has a VACUUM command that rebuilds the whole file).

Overflow pages handle payloads too large for a page. SQLite computes a maximum on-page payload X and a minimum M from the usable page size U (page size minus reserved bytes at header offset 20). For a table leaf, X = U - 35 and M = ((U-12)*32/255) - 23. If payload P fits in X it stays on the page; otherwise the cell keeps the first K (or M) bytes and chains the rest through overflow pages, each of which starts with a 4-byte next-overflow-page number (0 at the end) followed by content. Freed pages go on the file-level freelist whose trunk page is recorded at header offset 32.

## 4. Common exam traps and misconceptions

- "A tuple/record id like PostgreSQL's `(block, offset)` is a physical disk address you can compute arithmetic on." False. It is `(page id, slot/line-pointer index)`. The line pointer indirects to the actual in-page offset, which can move on compaction. CMU 15-445 says applications "cannot rely on these ids to mean anything."
- "In a slotted page, the slot array and tuple data both grow in the same direction." False. The slot/line-pointer array grows one way (down from the header) and tuple data grows the other (up from the page end); the page is full when they meet. In PostgreSQL `pd_lower` and `pd_upper` close from both sides.
- "DELETE immediately frees the disk space." False for MVCC systems. PostgreSQL marks the row dead via `t_xmax` and reclaims it later with VACUUM. Plain VACUUM marks space reusable in place and usually does not shrink the file; only VACUUM FULL (or trailing empty pages) returns space to the OS.
- "VACUUM FULL is the normal way to reclaim space and it is non-blocking." False on both counts. VACUUM FULL takes an ACCESS EXCLUSIVE lock and rewrites the table; the docs say to prefer plain VACUUM.
- "VACUUM is only about disk space." False. It also updates statistics, maintains the visibility map, and prevents 32-bit XID wraparound by freezing old rows. Skipping it can eventually force the database to stop accepting new write transactions.
- "A NULL is stored as a zero or a special sentinel value in the column's bytes." False. PostgreSQL uses a NULL bitmap in the tuple header (present only when `HEAP_HASNULL` is set), and a null column occupies no bytes in the data area.
- "Column order in CREATE TABLE has no effect on storage size." False. Alignment padding (MAXALIGN, typically 8 bytes in PostgreSQL) means poorly ordered columns waste pad bytes per row.
- "A big text value is stored inline and a row can span multiple pages." False for PostgreSQL. A tuple cannot span pages; values past ~2 KB are compressed and/or pushed out of line via TOAST into a separate table in ~2000-byte chunks, up to 1 GB per field.
- "PostgreSQL and SQLite both use heap files for table data." Half false. PostgreSQL tables are heap files. SQLite tables are B-trees keyed by rowid, stored in one file; there is no separate heap.
- "SQLite freeblocks and PostgreSQL's free space map are the same mechanism." False. SQLite freeblocks track free gaps within a single page (a chained in-page free list); PostgreSQL's FSM is a separate fork that tracks free space across pages of a relation.
- "The database page size must equal the OS or hardware page size." False. They are three independent concepts (hardware ~4 KB, OS ~4 KB, database 1 to 16 KB). When the DB page exceeds the hardware page, the system needs extra protection (full-page writes) against torn writes.
- "Larger database pages are always better." False. They cut I/O count for scans but waste buffer-pool space on point reads and increase contention; it is a workload-dependent tradeoff.

## 5. Good simulator ideas

1. Slotted page sandbox. The learner inserts, deletes, and updates variable-length rows on one page and watches the slot array grow down, the tuple data grow up, and the free-space pointer close the gap. Deleting a middle row leaves a hole; a "compact" button slides tuples up and rewrites slot offsets while keeping record ids stable, showing why the indirection exists. A counter shows bytes wasted to fragmentation, and the page rejects an insert when the array and data meet. Optional toggle to add MAXALIGN padding so the learner sees row size change as they reorder columns.

2. Heap file plus free space map insert router. The learner sees a row of pages each with a free-space bar, and inserts rows of chosen sizes. Mode A walks the page list linearly (linked-list heap) and highlights every page it touches; mode B queries an FSM tree and jumps straight to a fitting page. A live I/O counter shows linear vs logarithmic search cost. Deleting rows raises a page's free bar but the page stays allocated, illustrating bloat; a "VACUUM" button then makes the dead space reusable and, if a trailing page empties, returns it.

3. MVCC tombstone and VACUUM timeline. The learner runs INSERT, UPDATE, and DELETE under a couple of concurrent transactions with visible XIDs, watching `t_xmin`/`t_xmax` get stamped and `t_ctid` form an update chain (with a HOT redirect line pointer). Dead tuples accumulate and bloat the page. Advancing the transaction horizon past the readers, then pressing VACUUM, flips dead line pointers to reusable and frees space. A side panel shows the XID counter approaching the ~2 billion wraparound line and a freeze step that stamps old rows as frozen.

## 6. Citations

- PostgreSQL docs, "Database Page Layout": https://www.postgresql.org/docs/current/storage-page-layout.html . Authoritative source for the 8 KB page, the five-part page structure, the 24-byte PageHeaderData fields (`pd_lsn`, `pd_lower`, `pd_upper`, etc.), 4-byte ItemId line pointers, and the HeapTupleHeaderData fields (`t_xmin`, `t_xmax`, `t_ctid`, `t_hoff`) with the 23-byte minimum header and MAXALIGN rule.
- PostgreSQL source, `src/include/storage/itemid.h` (via doxygen): https://doxygen.postgresql.org/itemid_8h_source.html . Exact ItemIdData bitfield struct (lp_off:15, lp_flags:2, lp_len:15) and the four flag constants LP_UNUSED, LP_NORMAL, LP_REDIRECT, LP_DEAD.
- PostgreSQL docs, "TOAST": https://www.postgresql.org/docs/current/storage-toast.html . The ~2 KB TOAST_TUPLE_THRESHOLD, the four strategies (PLAIN, EXTENDED, EXTERNAL, MAIN), the TOAST table chunking (~2000-byte chunks, four per page), the 18-byte pointer, and the 1 GB per-field limit.
- PostgreSQL docs, "Free Space Map": https://www.postgresql.org/docs/current/storage-fsm.html . The `_fsm` fork, one byte of free space per page, and the per-page binary tree where non-leaf nodes hold the max of their children.
- PostgreSQL docs, "Routine Vacuuming": https://www.postgresql.org/docs/current/routine-vacuuming.html . The four purposes of VACUUM, the ~2 billion transaction XID wraparound limit and freezing, and the difference between plain VACUUM (in-place, SHARE UPDATE EXCLUSIVE) and VACUUM FULL (rewrite, ACCESS EXCLUSIVE).
- SQLite, "Database File Format": https://www.sqlite.org/fileformat2.html . The 512 to 65536 page sizes, the 100-byte database header, the 8/12-byte b-tree page header with page-type bytes (0x0d, 0x05, 0x0a, 0x02), the cell pointer array, the freeblock format and fragmented bytes, and the overflow-page spill formulas.
- CMU 15-445/645, Lecture 03 "Database Storage (Part I)" notes (Fall 2023): https://15445.courses.cs.cmu.edu/fall2023/notes/03-storage1.pdf . First-principles framing of the block/page abstraction, the DBMS vs OS/`mmap` argument, the three page concepts (hardware/OS/database) and atomic-write granularity, heap file linked-list vs page-directory organization, the slotted page invariant, and tuple layout including the NULL bitmap and `(page_id, slot)` record ids.

## 7. Glossary terms

- Page (block): the fixed-size unit of transfer between disk and the buffer pool; the DBMS reads and writes whole pages, not bytes.
- Hardware page: the unit the storage device writes atomically, usually 4 KB.
- Database page: the DBMS's logical page, commonly 1 to 16 KB; 8 KB in PostgreSQL, default 4 KB in SQLite.
- Torn page: a page partially written when a crash interrupts a write that spanned more than one hardware page; defended against by WAL full-page writes.
- Slotted page: a page layout with a header, a slot (line pointer) array growing one direction, and tuple data growing the other, with free space between.
- Slot / line pointer (ItemId): a small fixed-size entry mapping a slot index to the in-page byte offset and length of a tuple; lets tuples move without changing their record id.
- Record id / tuple id (TID): the stable external address of a row, `(page id, slot index)`, not a raw byte offset.
- Free-space pointer: the boundary between used and free space in a page; in PostgreSQL realized as the `pd_lower`/`pd_upper` pair.
- Heap file: an unordered collection of pages holding tuples in no particular order, located by linked list or page directory.
- Page directory: special pages mapping page ids to locations and per-page free space, replacing a linear page-list walk.
- Free space map (FSM): in PostgreSQL, a separate `_fsm` fork tracking free space per page as one byte, in a tree that supports fast "find a page with N free bytes" lookups.
- NULL bitmap: a bit per column in the tuple header marking which columns are null, so null columns store no data bytes.
- Alignment / padding: inserting unused bytes so fields start on natural boundaries (MAXALIGN, typically 8 bytes in PostgreSQL); affects row size and depends on column order.
- Tuple header: per-row metadata holding visibility/transaction info and the NULL bitmap; in PostgreSQL HeapTupleHeaderData with `t_xmin`, `t_xmax`, `t_ctid`, `t_hoff`.
- Tombstone: a dead-row marker (in PostgreSQL `t_xmax` plus an eventual dead line pointer) used instead of immediate physical deletion under MVCC.
- VACUUM: the PostgreSQL maintenance operation that reclaims dead-tuple space, updates statistics and the visibility map, and freezes old XIDs to prevent 32-bit wraparound.
- XID wraparound: the failure mode where the 32-bit transaction id counter laps, making old rows appear in the future; prevented by freezing rows within ~2 billion transactions.
- TOAST: PostgreSQL's technique for storing values too large for a page, by compressing and/or moving them out of line into a TOAST table in chunks, up to 1 GB per field.
- Cell (SQLite): SQLite's on-page record inside a B-tree page; large cells spill into overflow pages.
- Freeblock (SQLite): a chained free gap of at least 4 bytes within a B-tree page; smaller 1 to 3 byte gaps count as fragmented free bytes.
- Overflow page (SQLite): a page holding the tail of a cell payload too large to fit on its B-tree page, chained by a 4-byte next-page pointer.
