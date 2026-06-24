# Course spine: the one story that connects all 16 weeks

This document is the connective tissue for the Advanced DBMS Internals course. The mission is explicit
that the single most requested outcome is to stop seeing 16 islands and instead trace one query, and
one transaction, end to end through the engine. Every lesson should open by placing itself on one of
the two journeys below and close by handing off to the next layer. The landing page is a map of these
two journeys.

The engine has a layered shape that the "Architecture of a Database System" survey fixes for us
(Hellerstein, Stonebraker, Hamilton 2007, Figure 1.1): client communications, process manager,
relational query processor (parser, rewriter, optimizer, executor), transactional storage manager
(access methods, buffer manager, lock manager, log manager), and shared catalog and memory. The
course walks that stack twice. The first walk follows a read (SELECT) downward through the layers. The
second walk follows a write (UPDATE inside a transaction) through concurrency control, logging, and
recovery, which are the layers a read never has to think hard about.

## Journey 1: a single SELECT, top to bottom

The query is deliberately simple so the same example can recur in every lesson:

    SELECT name FROM emp WHERE salary > 75000 ORDER BY name;

Follow it down the stack. Each step names the week that owns that layer and what it hands to the next.

1. Arrival and the five components (week 1, query layer). The string reaches the server through the
   client communications manager, the process manager assigns a worker and runs admission control, and
   the relational query processor takes over. This is the survey's gate-agent walkthrough. Week 1
   establishes the whole map so the learner knows where every later week sits. Hand-off: a raw SQL
   string enters the query processor.

2. Parse, bind, rewrite (week 8, query layer). The lexer turns the string into tokens, the grammar
   builds a raw parse tree using only syntactic rules (no catalog access, because catalog lookups need
   a transaction), then analysis resolves `emp` to a real table, types `salary` and `75000`, checks
   authorization, and produces a typed query tree. The rewriter expands views and folds constants. The
   tree is translated to a logical plan: projection(name) over selection(salary > 75000) over
   scan(emp), with a sort for ORDER BY. Hand-off: a logical, relational-algebra plan that says what,
   not how.

3. Optimize (week 11, query layer). The optimizer turns the logical plan into a physical plan. It
   estimates how many rows survive `salary > 75000` using statistics (histograms, most-common-values),
   costs the alternatives (sequential scan versus an index scan on salary), decides whether the sort
   can be skipped because an index already supplies order, and picks the cheapest plan. This is the
   System R / Selinger cost model and dynamic program, plus predicate pushdown applied as a heuristic
   rewrite. Hand-off: a physical plan, a tree of concrete operators.

4. Execute with the iterator model (weeks 9 and 10, query layer). The executor runs the physical plan
   as a tree of open / next / close iterators in the Volcano style. The root (sort, then projection)
   pulls tuples from selection, which pulls from the scan. One tuple bubbles up per next() call;
   nothing materializes except the sort, which is a pipeline breaker and may spill to disk via external
   merge sort. If the query had a join, week 10 owns the join algorithm choice (nested loop, sort
   merge, hash). Hand-off: the scan operator asks the access method for tuples.

5. Find the rows through an access method (weeks 6 and 7, index layer). If the optimizer chose an
   index scan, the executor descends a B+tree on salary: a few page reads from root to leaf, then a
   walk along linked leaves for the range, returning row ids (TIDs). If it chose a sequential scan,
   the access method just asks for every heap page in order. The SARG (the `salary > 75000` predicate)
   is pushed into the access method so filtering happens a page at a time. Hand-off: a request for
   specific pages by page id.

6. Get pages from the buffer pool (weeks 4 and 5, buffer layer). Every page the access method or scan
   wants is requested from the buffer pool by page id. A hit returns a frame pointer and bumps the pin
   count; a miss evicts an unpinned victim (writing it back if dirty), reads the page from disk, and
   pins it. The replacement policy (clock-sweep with a usage count in PostgreSQL, or LRU-K in theory)
   decides the victim, and a ring buffer keeps this scan from flooding the pool. Hand-off: a request to
   the storage manager to read a page from a file.

7. Read bytes off disk (weeks 2 and 3, storage layer). The storage manager locates the page in the
   heap file (via the free space map and page directory), reads the fixed-size page, and the slotted
   page layout lets it find each tuple through the slot array. The tuple header and NULL bitmap and
   alignment decode the bytes into the `name` and `salary` columns. This is the floor of the stack.
   Hand-off: decoded tuples flow back up.

8. Unwind the stack. Tuples flow back up: storage to buffer pool (pinned), access method tests the
   SARG, executor filters and projects and sorts, optimizer's plan shape is now irrelevant, and the
   communications manager ships `name` values to the client. The survey calls this "unwinding the
   stack."

The spine to memorize: query (w1) to parser (w8) to optimizer (w11) to executor (w9, w10) to index
(w6, w7) to buffer (w4, w5) to storage (w2, w3), then back up.

## Journey 2: a single UPDATE inside a transaction, through concurrency, logging, recovery

The second journey is the one a SELECT never forces you to confront: what happens when the row is
written, other transactions are running, and the machine can crash. The statement:

    BEGIN;
    UPDATE account SET balance = balance - 100 WHERE id = 42;
    COMMIT;

Follow the write.

1. Why a transaction at all (week 12, txn layer). BEGIN opens a transaction, the unit that gets
   atomicity, isolation, and durability. Concurrency is needed for throughput, but naive interleaving
   produces anomalies (dirty read, lost update, write skew). Isolation levels and serializability
   theory (conflict graphs, the precedence graph acyclicity test) define what interleavings are legal.
   Hand-off: this UPDATE must run under some isolation level, enforced by a concurrency mechanism.

2. Acquire the right to write (week 13, txn layer). The row for id 42 is located exactly as in journey
   1 (optimizer to access method to buffer to storage), but now concurrency control governs the write.
   Under strict 2PL the transaction takes an exclusive lock on the row and holds it to commit. Under
   MVCC (PostgreSQL) the UPDATE does not overwrite: it writes a new tuple version, stamps the old
   version's xmax, and links the version chain, so readers on an older snapshot still see the old
   balance and never block. Writers are still serialized (locks, or SSI conflict checks at Serializable).
   Hand-off: a page is about to be modified in the buffer pool.

3. Log before you change the page (week 14, recovery layer). Before the dirty data page can ever reach
   disk, the write-ahead logging rule forces the log record describing the change to stable storage
   first. ARIES assigns the log record an LSN, stamps the page's page_LSN, and records redo and undo
   information. The buffer pool's freedom to evict (steal) is exactly why undo must be logged; the
   freedom not to flush at commit (no-force) is exactly why redo must be logged. This is where weeks 4
   and 5 (steal/no-force) connect to week 14. COMMIT forces the log up to the commit record; only then
   is the transaction durable. Hand-off: the modified page may now be written back lazily, and the log
   is the source of truth.

4. The page travels back down. The dirty page sits in the buffer pool (week 4) with its dirty flag set
   and is eventually written through the storage layer (week 2) to the heap file, possibly long after
   commit. The slotted page may need compaction; under MVCC the old version becomes dead and waits for
   VACUUM (week 3). The same storage and buffer machinery from journey 1 carries the write down.

5. Crash and recover (week 14, recovery layer). If the machine crashes, ARIES restarts in three passes.
   Analysis rebuilds the transaction table and dirty page table from the last checkpoint and finds the
   losers. Redo repeats history forward from the earliest RecLSN, reapplying every logged change not
   yet on disk (conditional on page_LSN), including losers, to reconstruct the exact crash-time state.
   Undo rolls back the losers in reverse, writing redo-only compensation log records so rollback is
   bounded and idempotent. After recovery the committed minus-100 survives and any uncommitted partial
   work is gone. This closes atomicity and durability.

The spine to memorize: transaction (w12) to concurrency control / MVCC (w13) to WAL and the page_LSN
invariant (w14) to buffer steal/no-force (w4, w5) to storage (w2, w3), and on crash the three ARIES
passes restore the exact state.

## Where the modern weeks attach

Weeks 15 and 16 do not add a new layer; they revisit the whole stack under new pressure and tie the
mission's final questions together (B-tree versus LSM, row versus column, single node versus
distributed).

- Week 15 (LSM, columnar, DuckDB, RocksDB) replaces the update-in-place storage and index layers
  (weeks 2, 3, 6, 7) with a write-optimized log-structured design: a memtable plus a WAL plus immutable
  SSTables plus compaction, which is the same write path Bigtable defined. Columnar storage replaces the
  row-oriented slotted page for analytic scans, and vectorized push-based execution contrasts with the
  pull-based Volcano model of week 9. The buffer pool, WAL durability idea, and MVCC all reappear in new
  clothes.
- Week 16 (partitioning, replication, 2PC, CAP) takes the single-node engine and spreads it across
  machines. Range versus hash partitioning is the week 6-7 index trade-off at cluster scale.
  Replication and quorums extend durability across nodes. Two-phase commit extends atomicity across
  nodes and exposes the blocking problem, which consensus (Raft) fixes by replicating the coordinator's
  log. Bigtable is the bridge: it shows the LSM write path of week 15 living inside a distributed,
  range-partitioned, lock-service-coordinated system.

## Reading order and dependencies

Read in week order; the two journeys are designed so each layer depends only on layers already covered.

- Week 1 first, always. It is the map. Every later lesson refers back to the five-component picture and
  to its place on journey 1 or journey 2.
- Storage (2, 3) before buffer (4, 5): the buffer pool caches pages whose layout storage defines.
- Buffer (4, 5) before index (6, 7) and before execution: every higher layer reads pages through the
  buffer pool, and the B+tree's low-I/O argument depends on the buffer caching upper levels.
- Index (6, 7) before execution (9, 10) and optimization (11): index scans and index nested loop joins
  assume the B+tree; the optimizer costs index versus sequential access.
- Parsing (8) before execution (9, 10) and optimization (11) in the pipeline order, though parsing is
  lighter; it produces the logical plan the optimizer consumes and the executor runs. Week 8 is
  Milestone M2.
- Execution (9, 10) and optimization (11) are mutually reinforcing: the optimizer chooses among the
  execution operators, so teach the operators (9, 10) then how they are chosen (11).
- Transactions (12) before concurrency (13): isolation levels and serializability theory frame the
  mechanisms (2PL, MVCC).
- Concurrency (13) before recovery (14): steal/no-force and the undo/redo split only make sense once
  MVCC and locking are in hand. Week 14 also depends on buffer (4, 5) for the steal/no-force link.
- Modern (15, 16) last: they recompose everything above. Week 15 needs storage, index, buffer, WAL, and
  execution; week 16 needs transactions, recovery, and partitioning intuition.

Milestones: M1 falls at week 5 (buffer pool complete), M2 at week 8 (front of the pipeline complete).

Paper vivas: Architecture of a Database System grounds week 1 and hosts its viva there. Volcano grounds
weeks 9 and 10 and hosts its viva at week 9. ARIES grounds week 14 and hosts its viva there. Bigtable
grounds week 15 and hosts its viva there. Each viva week should carry the paper's anticipated-question
bank from the corresponding research note.
