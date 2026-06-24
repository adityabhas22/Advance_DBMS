# B+trees and hash indexes (weeks 6-7)

Research note for the Advanced DBMS Internals course. Scope: why a balanced disk tree, B+tree
structure and algorithms, hash indexes, the range-versus-point trade-off, and how PostgreSQL and
SQLite implement these. Numbers and invariants are attributed inline; full URLs are in the
Citations section.

## 1. The core problem

An index exists to avoid reading the whole table. Without one, a point lookup or a range query is a
full heap scan: O(N) pages of I/O. The question is what data structure turns that into something
sublinear when the data lives on disk and not in RAM.

A balanced binary search tree (AVL, red-black) gives O(log2 N) comparisons, but that is the wrong
cost model for disk. The dominant cost is not comparisons, it is page reads. A disk or SSD reads a
fixed-size block (commonly 4 KB or 8 KB) per I/O. A binary tree node holds one key and two
pointers, so each step down the tree costs one page read and discards all but one bit of branching
per read. For a billion keys that is roughly 30 page reads.

The fix is to widen each node so one page read makes a high-fanout decision. If a node holds a few
hundred keys, the branching factor (fanout) per page read is a few hundred instead of two, so the
tree height collapses. This is the first-principles reason a database uses a B+tree and not a
binary tree: the structure is tuned to minimize the number of block transfers, not the number of
comparisons. CMU 15-445 frames the B+tree as an "M-way search tree" precisely to make fanout the
central parameter (Lecture 08, Tree Indexes).

The second problem is what happens on update. A static sorted file gives O(log N) binary search but
O(N) insertion because everything after the insertion point shifts. The B+tree keeps search cost
near the static-sorted-file ideal while making insert and delete local operations that touch a
logarithmic number of pages and keep the tree balanced automatically.

The third problem is range and ordered access. A hash table answers equality in expected O(1) but
cannot answer "all rows with key between 10 and 50" or "rows ordered by key" without scanning every
bucket. A B+tree answers both because its leaves are sorted and linked. That tension, point access
versus range and order, is the reason both index families coexist.

## 2. Mechanisms

### Fanout, height, and I/O cost

Let the page hold up to m children (the order or fanout). A tree of height h indexes up to about
m^h keys at the leaves. Inverting, the height to index N keys is about log_m(N). With m around a
few hundred, three to four levels index hundreds of millions to billions of rows. The number of
page reads for a point lookup is the height, so the cost is O(log_m N) I/Os, and because m is large
the constant and the log base are both favorable. A common concrete figure: with fanout 100, three
levels reach 100^3 = one million leaf entries, four levels reach 100 million.

Two further savings in practice. The root and often the entire upper levels stay cached in the
buffer pool because every search touches them, so the marginal I/O of a lookup is closer to one or
two leaf reads than the full height. And because leaves are linked, a range scan after the initial
descent is sequential leaf-to-leaf reads, not repeated root-to-leaf descents.

### B+tree invariants

A B+tree of order m maintains the following. These are the standard properties as stated in the
B-tree literature (Comer, "The Ubiquitous B-Tree", ACM Computing Surveys 11(2), 1979) and CMU
15-445 Lecture 08.

- All data entries live in the leaves. Internal (interior) nodes hold only separator keys and child
  pointers; they route, they do not store record payloads or row pointers to data. This is the
  defining difference from a plain B-tree (see section 4).
- Leaves are linked into a doubly or singly linked list in key order, so a range scan walks leaves
  sequentially without going back up the tree. PostgreSQL keeps leaves as a doubly linked list of
  pages (PostgreSQL docs, B-Tree Implementation).
- The tree is height-balanced: every root-to-leaf path has the same length. Balance is a structural
  invariant, not a periodic rebuild.
- Every node except the root is at least half full. For order m, a non-root node holds between
  ceil(m/2) - 1 and m - 1 keys (equivalently between ceil(m/2) and m children for internal nodes).
  The root may hold as few as one key (two children), or zero when the tree is a single leaf. CMU
  15-445 states the rule operationally: a deletion that leaves a node less than half full forces a
  merge or redistribution to re-balance (Lecture 08).

The half-full rule is what bounds the height. If nodes could empty out arbitrarily the tree could
degenerate; forcing at least 50 percent occupancy guarantees that N keys need at most about
log_{m/2}(N) levels, so the logarithmic I/O bound holds in the worst case, not just on average.

### Search

Start at the root. In each internal node, binary-search the separator keys to pick the child whose
key range contains the search key, following the invariant Ki < v <= Ki+1 between adjacent
separators (this exact inequality is stated in the PostgreSQL nbtree README). Descend until a leaf,
then binary-search the leaf. Cost: one page read per level, O(log_m N) I/Os. A range scan does this
descent once to find the lower bound, then follows leaf links rightward until the upper bound.

### Insertion with node splits

1. Descend to the target leaf as in search.
2. If the leaf has room, insert the entry in sorted position. Done. No structural change.
3. If the leaf is full, split it. Allocate a new leaf, move the upper half of the entries into it,
   and link it into the leaf chain. Copy up the first key of the new right leaf as a separator into
   the parent. Note "copy up" for a leaf split: the separator key still exists in the leaf, because
   all data must remain in leaves.
4. Inserting that separator may overflow the parent internal node. Split it too, but here the
   middle key is pushed up (moved, not copied) into the grandparent, because internal nodes only
   route and need not retain a copy.
5. Splits propagate upward only as far as overflow continues. If the root splits, allocate a new
   root with the two halves as children. This is the only way the tree grows in height, and it
   grows from the top, which is why all leaves stay at the same depth.

Cost: O(log_m N) I/Os, dominated by the descent; splits are rare amortized because a split leaves
both halves about half full, so many subsequent inserts fit without splitting.

### Deletion with merge or redistribute

1. Descend to the leaf and remove the entry.
2. If the leaf still has at least the minimum (half full), done.
3. If it underflows (fewer than ceil(m/2) - 1 keys), restore the invariant using a sibling:
   - Redistribute (also called rotate or borrow): if an adjacent sibling has more than the minimum,
     move one entry across and update the separator key in the parent. The tree shape is unchanged.
   - Merge (coalesce): if no sibling can spare an entry, combine the underflowing node with a
     sibling into one node and remove the now-unused separator from the parent.
4. A merge removes a key from the parent, which can make the parent underflow, so the merge or
   redistribute step propagates upward exactly like split propagation. If the root ends with a
   single child, that child becomes the new root and the tree shrinks in height.

Many production systems relax full deletion rebalancing because it is expensive and concurrency
hostile, and instead let pages drift below half full, reclaiming space lazily (see PostgreSQL in
section 3). The textbook half-full underflow rule is the correctness baseline that those systems
optimize around, not always the literal runtime behavior.

### Bulk loading bottom up

Inserting N keys one at a time costs N descents and causes many random splits. If the keys are
already sorted (or can be sorted first), build the tree bottom up instead. Sort the entries, pack
them into leaves left to right up to a target fill (the fillfactor, leaving slack for later
inserts), link the leaves, then build the parent level from the first key of each leaf, and repeat
upward until one root remains. This is sequential I/O, fills pages to a controlled density, and
produces a denser, shallower tree than repeated insertion. CMU 15-445 covers this as the standard
bulk-load optimization (Lecture 08).

### Composite (multi-column) keys and ordering

A composite key (a, b, c) is ordered lexicographically: compare a first, then b, then c. The
consequence for query planning is the leftmost-prefix rule. The index efficiently serves predicates
that constrain a contiguous left prefix: a = ?, or a = ? AND b = ?, or a = ? AND b > ?. It cannot
do an efficient ranged seek on b alone, because rows with a given b value are scattered across the
whole key space. Column order in the index definition therefore matters and is not symmetric. Each
index column also has a sort direction (ASC or DESC) and a null placement (NULLS FIRST or LAST);
matching the index ordering to an ORDER BY lets the planner skip a sort and read leaves in order.

### Clustered versus unclustered (secondary) indexes

- A clustered index determines the physical order of the table rows. There can be at most one per
  table because a table has one physical order. A range scan on a clustered index reads the table
  rows in sorted, mostly sequential order, which is fast. In some systems the table rows live
  directly in the clustered index leaves (an index-organized table).
- An unclustered (secondary) index has its own key order independent of the table's physical
  layout. Its leaves hold the key plus a row pointer (a TID or primary-key value). A range scan
  reads index leaves in order but then jumps to scattered heap pages, so it can incur close to one
  random heap I/O per matching row. The clustering factor, how well index order matches heap order,
  is what makes a secondary range scan cheap or expensive.

### Hash indexes

A hash index maps key to bucket via a hash function, giving expected O(1) point lookup but no
ordering and so no range or sorted scan. The design problem is how the bucket array grows.

Static hashing fixes the number of buckets up front. Collisions overflow into chained pages. When
the table grows past the bucket count, chains lengthen and lookups degrade toward O(chain length),
and the only repair is a full rebuild. CMU 15-445 Lecture 07 treats static schemes (linear probing,
chained) as the baseline.

Extendible hashing grows gracefully. A directory of 2^global_depth pointers maps the top
global_depth bits of the hash to a bucket. Each bucket has a local_depth telling how many bits it
actually distinguishes. On overflow of a bucket whose local_depth equals the global_depth, the
directory doubles (global_depth += 1) and the bucket splits into two, each with local_depth + 1,
redistributing entries by the newly examined bit. If the splitting bucket's local_depth was below
the global_depth, only that bucket splits and the directory is not doubled, because two directory
slots already point at it. Lookups stay O(1) and growth is incremental, at the cost of a directory
that can double in size (CMU 15-445 Lecture 07, global and local depth).

Linear hashing avoids a directory. It keeps a split pointer and splits buckets in a fixed round-
robin order whenever a load threshold is crossed, regardless of which bucket overflowed; overflow
chains absorb the temporary imbalance until the split pointer reaches that bucket. It grows one
bucket at a time with no directory doubling.

### B+tree versus hash, the central trade-off

| Property | B+tree | Hash index |
|---|---|---|
| Point lookup (=) | O(log_m N) I/O | expected O(1) I/O |
| Range / inequality (<, >, BETWEEN) | yes, ordered leaves | no |
| ORDER BY served without sort | yes | no |
| Prefix of composite key | yes (leftmost prefix) | no, needs full key |
| Worst case under skew | bounded by height | long overflow chains |

The one-line takeaway: hash wins pure equality on a single full key; B+tree wins everything that
needs order, ranges, or partial-key matching, which is most real workloads. CMU 15-445 notes that a
hash index requires all attributes of the search key, while a B+tree can use any left prefix
(Lecture 08).

## 3. How real systems do it

### PostgreSQL B-tree (nbtree)

The default and dominant index access method. It is a B+tree (all pointers to heap tuples live in
leaves) based on the Lehman and Yao high-concurrency algorithm (Lehman and Yao, "Efficient Locking
for Concurrent Operations on B-Trees", ACM TODS 6(4), 1981), as stated in the source-tree README
at src/backend/access/nbtree/README. Key implementation facts, all from that README and the
PostgreSQL docs:

- Every page carries a right-link to its right sibling and a high key that upper-bounds the keys
  allowed on the page. These two additions let a search detect a concurrent split (it can follow the
  right-link to the moved data) so searches need no read locks in the Lehman-Yao sense. PostgreSQL
  also stores a left-link for backward scans.
- Internal pages and leaf high keys use pivot tuples that exist only for navigation. Suffix
  truncation drops unneeded trailing attributes of a separator at split time, raising fanout.
- Keys are made unique by appending the heap TID as a tiebreaker, so duplicates have a defined
  order.
- Deletion is lazy and two-stage. A leaf is first marked half-dead with its downlink removed from
  the parent, then unlinked from its siblings and fully deleted; the rightmost page on a level is
  never deleted, which simplifies traversal. PostgreSQL does not do eager textbook merge on every
  underflow.
- Deduplication (default on since v13, parameter deduplicate_items): equal keys are stored once as a
  posting list of heap TIDs, applied lazily before a page would split, as a last line of defense
  against bloat (PostgreSQL docs, B-Tree Implementation; CYBERTEC writeup).
- fillfactor for B-tree defaults to 90 and ranges 10 to 100; it controls how full a leaf is packed
  during build or bulk load, leaving room for in-place inserts (PostgreSQL docs, B-Tree
  Implementation and CREATE INDEX).

Index-only scans and covering indexes. A B-tree index-only scan returns the answer from the index
without visiting the heap, but only if two conditions hold: every column the query needs is in the
index, and the heap page is marked all-visible in the visibility map so MVCC visibility can be
checked without reading the tuple. The visibility map is about four orders of magnitude smaller than
the heap, which is why the check is cheap (PostgreSQL docs, Index-Only Scans and Covering Indexes).
The INCLUDE clause adds non-key payload columns to a B-tree leaf so a query can be covered without
making those columns part of the search key or uniqueness constraint. INCLUDE columns need not be a
type the index can order, and expressions are not allowed as included columns.

PostgreSQL hash index. A real on-disk hash access method, made crash-safe and replicatable in
PostgreSQL 10 by adding WAL logging; before v10 it carried a warning and was not crash-safe
(PG 10 release notes; EDB writeup). It supports only the = operator, only single-column indexes, no
uniqueness checking, and its scans are lossy because only the hash value is stored, so the heap
tuple must be rechecked. Layout: a meta page (page zero) with control info, primary bucket pages,
overflow pages chained to a full bucket, and bitmap pages tracking reusable overflow pages. Bucket
expansion happens in the foreground and there is no shrink short of REINDEX (PostgreSQL docs, Hash
Indexes). In practice nbtree is preferred for almost everything; hash is a niche win for large
equality-only workloads with good key distribution.

### SQLite

SQLite stores the entire database, tables and indexes alike, as B-trees in a single file
(sqlite.org, Database File Format). It distinguishes two variants:

- A table b-tree is keyed by the 64-bit rowid. Interior pages hold only keys and child pointers;
  all row data lives in the leaves. That is a B+tree shape (data in leaves only) even though the
  spec calls it a b-tree.
- An index b-tree is keyed by an arbitrary-length key (the indexed columns plus the rowid as a
  tiebreaker) and holds no data, only keys, again with leaves at the bottom.

So a WITHOUT ROWID table is effectively a clustered (index-organized) layout: the row payload lives
in the primary-key index leaves. An ordinary table plus a secondary index is the unclustered case:
the index b-tree leaf holds the key and the rowid, and SQLite then does a second lookup into the
table b-tree by rowid to fetch the row. SQLite has no hash index access method; equality lookups go
through a b-tree.

## 4. Common exam traps and misconceptions

- "B-tree and B+tree are the same thing." False. In a B-tree, keys and their associated data or row
  pointers can sit in internal nodes too. In a B+tree, all data entries are in the leaves and
  internal nodes hold only separators; leaves are linked for range scans (Comer 1979). PostgreSQL
  nbtree and SQLite table b-trees are B+tree-shaped even when called "B-tree". An MCQ that says
  "B+tree stores records in internal nodes" is false.
- "A B+tree gives O(log2 N) lookups." Misleading. The base of the log is the fanout m, not 2. The
  whole point is log_m N with large m, which is what makes the height three or four for huge tables.
- "Every node is at least half full." False as stated for the root. The root is exempt; it can hold
  a single key. Only non-root nodes obey the half-full rule (ceil(m/2)-1 keys minimum).
- "On a leaf split the middle key moves up." False for leaf splits in a B+tree. The separator is
  copied up because the data must remain in the leaf. Keys move up (are removed from the child) only
  on internal-node splits. Confusing copy-up with push-up is a classic distractor.
- "Insertion always grows the tree taller." False. Height increases only when the root itself
  splits. Most inserts touch one leaf and stop.
- "A hash index is always faster than a B+tree because it is O(1)." False in context. It is O(1)
  only for full-key equality and cannot do ranges, ORDER BY, or prefix matches. Under skew or growth
  its overflow chains can make it slower than a B+tree (PostgreSQL docs, Hash Indexes).
- "You can have several clustered indexes on a table." False. The clustered index fixes the physical
  row order, so there is at most one. Secondary indexes are all unclustered.
- "A composite index on (a, b) helps a query that filters only on b." False. Lexicographic ordering
  means only a contiguous left prefix is seekable; b alone is scattered.
- "An index-only scan never touches the heap." False in PostgreSQL. It still must check the
  visibility map, and if the page is not all-visible it falls back to a heap fetch (PostgreSQL docs,
  Index-Only Scans).
- "PostgreSQL hash indexes were never safe to use." False as of PostgreSQL 10, which added WAL
  logging and made them crash-safe and replicatable (PG 10 release notes). The pre-10 warning no
  longer applies.
- "Hash indexes can enforce uniqueness or be multi-column in PostgreSQL." False. PostgreSQL hash
  indexes are single-column and do not support uniqueness (PostgreSQL docs, Hash Indexes).

## 5. Good simulator ideas

1. Animated B+tree insert and delete. The learner sets a small order (m = 3 or 4) and inserts or
   deletes keys one at a time. The widget animates the descent, the leaf split with copy-up versus
   the internal split with push-up shown as visibly different operations, propagation to a new root,
   and on delete the choice between redistribute and merge with the underflow threshold drawn on
   each node. A height counter and an I/O counter update per operation so the learner sees that
   height changes only on root split or root collapse. Make the half-full boundary a colored line so
   underflow is obvious.

2. Fanout and height calculator with a cache toggle. The learner drags fanout m and row count N and
   the tool reports tree height log_m N, leaf count, and estimated point-lookup I/Os, then lets them
   mark the top levels as cached to show the marginal I/O dropping to one or two leaf reads. A second
   panel contrasts the same N in a binary tree (height log2 N) so the disk-cost argument lands
   numerically.

3. Extendible-hash directory grower side by side with a B+tree range query. Left pane: insert keys,
   watch a bucket overflow, watch global and local depth tick up and the directory double, and watch
   a point lookup stay one or two reads. Right pane: run a range query BETWEEN x AND y and watch the
   hash side be forced to scan everything while the B+tree descends once and walks linked leaves.
   This makes the point-versus-range trade-off concrete in one screen.

## 6. Citations

- PostgreSQL nbtree README (source tree): https://github.com/postgres/postgres/blob/master/src/backend/access/nbtree/README
  Authoritative on the Lehman-Yao basis, right-links and high keys, pivot tuples and suffix
  truncation, heap-TID tiebreak uniqueness, two-stage half-dead page deletion, and the key-range
  invariant Ki < v <= Ki+1.
- PostgreSQL docs, B-Tree Implementation (current / v16): https://www.postgresql.org/docs/16/btree-implementation.html
  Multi-level structure, leaves as a doubly linked list, deduplication and posting lists,
  fillfactor default 90 (range 10 to 100), deduplicate_items default on.
- PostgreSQL docs, B-Tree Indexes (section 65.1): https://www.postgresql.org/docs/current/btree.html
  B-tree operator class provides exactly five comparison operators (<, <=, =, >=, >); why <> is
  excluded.
- PostgreSQL docs, Index-Only Scans and Covering Indexes: https://www.postgresql.org/docs/current/indexes-index-only-scans.html
  Conditions for index-only scans, the visibility map (about four orders of magnitude smaller than
  the heap), and the INCLUDE clause for covering indexes.
- PostgreSQL docs, Hash Indexes: https://www.postgresql.org/docs/current/hash-index.html
  Equality-only, single-column, no uniqueness, lossy scans, meta/bucket/overflow/bitmap page layout,
  foreground expansion, REINDEX to shrink.
- PostgreSQL 10 release notes: https://www.postgresql.org/docs/release/10.0/
  Hash indexes gained WAL logging in v10, making them crash-safe and replicatable; pre-10 warning
  removed.
- SQLite Database File Format: https://www.sqlite.org/fileformat2.html
  Table b-trees (rowid key, data only in leaves) versus index b-trees (arbitrary key, no data);
  interior pages hold K keys and K+1 child pointers; confirms data-in-leaves layout.
- CMU 15-445/645 Lecture 08, Tree Indexes (Fall 2023): https://15445.courses.cs.cmu.edu/fall2023/notes/08-trees.pdf
  B+tree as M-way search tree, fanout, half-full merge-on-delete rule, leftmost-prefix usability,
  bulk loading, hash needing the full key versus B+tree using a prefix.
- CMU 15-445/645 Lecture 07, Hash Tables (Fall 2023): https://15445.courses.cs.cmu.edu/fall2023/notes/07-hashtables.pdf
  Static hashing, extendible hashing with global and local depth and directory doubling, linear
  hashing.
- Douglas Comer, "The Ubiquitous B-Tree", ACM Computing Surveys 11(2), June 1979: https://carlosproal.com/ir/papers/p121-comer.pdf
  Canonical survey; defines the B+tree variant and the data-in-leaves distinction from the plain
  B-tree.

## 7. Glossary terms

- Fanout (order, m): maximum number of children per internal node; the branching factor per page
  read that drives the low tree height.
- Height: number of levels from root to leaf; equals the number of page reads per point lookup,
  about log_m N.
- B+tree: balanced disk tree with all data entries in linked leaves and internal nodes used only as
  separators.
- B-tree (plain): balanced tree that may store data or row pointers in internal nodes as well as
  leaves; leaves are not necessarily linked.
- Separator key: a key in an internal node used only to route a search to the correct child, not to
  store a record.
- Pivot tuple (PostgreSQL): nbtree's term for a separator or high-key tuple used for navigation,
  with attributes possibly suffix-truncated.
- High key (PostgreSQL nbtree): an upper bound on the keys allowed on a page; with the right-link it
  lets a search detect a concurrent split.
- Right-link / left-link (PostgreSQL nbtree): sibling pointers between pages on the same level
  enabling lock-light search and backward scans.
- Half-full invariant: every non-root node holds at least ceil(m/2)-1 keys; restored on delete by
  merge or redistribution.
- Node split: dividing a full node into two on insert; copy-up of the separator for leaves,
  push-up of the middle key for internal nodes.
- Merge (coalesce): combining an underflowing node with a sibling and removing a separator from the
  parent.
- Redistribute (rotate, borrow): moving an entry from a richer sibling into an underflowing node and
  updating the parent separator, without changing tree shape.
- Bulk loading: building a B+tree bottom up from sorted entries to a target fillfactor, using
  sequential I/O.
- fillfactor: target fraction a page is packed to at build time (PostgreSQL B-tree default 90),
  leaving slack for later inserts.
- Composite key: a multi-column key ordered lexicographically; only a contiguous left prefix is
  efficiently seekable.
- Clustered index: index that defines the table's physical row order; at most one per table.
- Unclustered (secondary) index: index whose order is independent of the table's physical layout;
  leaves hold key plus row pointer (TID or primary key).
- Clustering factor: how closely index key order matches heap physical order; determines secondary
  range-scan cost.
- Index-only scan (PostgreSQL): answering a query from the index alone when all needed columns are
  indexed and the heap page is all-visible per the visibility map.
- Covering index / INCLUDE: an index that carries extra payload columns (non-key in PostgreSQL's
  INCLUDE) so a query is answered without a heap fetch.
- Visibility map (PostgreSQL): per-heap-page bitmap marking pages whose tuples are visible to all
  transactions; enables index-only scans cheaply.
- Static hashing: fixed bucket count with overflow chains; degrades as data grows, needs full
  rebuild.
- Extendible hashing: directory of 2^global_depth pointers with per-bucket local_depth; overflow
  splits a bucket and doubles the directory only when local_depth equals global_depth.
- Linear hashing: directory-free scheme that splits buckets in round-robin order at a load
  threshold, using overflow chains to absorb temporary skew.
- Global depth / local depth: number of hash bits the directory uses versus the number a given
  bucket actually distinguishes.
- Lossy index scan (PostgreSQL hash): scan that stores only the hash value, so matching tuples must
  be rechecked against the heap.
- Lehman-Yao: high-concurrency B-tree algorithm using right-links and high keys; the basis of
  PostgreSQL nbtree.
