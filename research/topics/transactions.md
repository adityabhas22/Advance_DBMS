# Transactions, ACID, and isolation levels

Course week 12. Topic cluster: transactions, ACID, isolation levels. This note is grounded in the ANSI critique paper (Berenson, Bernstein, Gray, Melton, O'Neil, O'Neil, SIGMOD 1995), the PostgreSQL "Transaction Isolation" documentation, the SQLite locking and isolation documentation, and the CMU 15-445 concurrency control lectures. Specific URLs are in the Citations section. Where a number or invariant appears, the source is named inline.

## The core problem

A transaction is a unit of work that the database promises to treat as a single logical step even though it is built from many small physical steps (read this page, write that row, append this log record). Two things threaten that promise: failures (the machine crashes halfway through) and concurrency (other transactions run at the same time and touch the same data). ACID is the name for the four guarantees that close those threats.

ACID, defined precisely:

- Atomicity. Either all of a transaction's effects happen or none do. There is no partial transaction visible after the fact. Mechanically this is the job of the log and the abort/undo path, not of locking.
- Consistency. A transaction moves the database from one state that satisfies all declared integrity rules to another such state. This is partly the application's responsibility (the transaction logic is correct) and partly the engine's (it enforces constraints and does not corrupt structures). Consistency is the weakest of the four as an engine guarantee, because the engine cannot know the application's intended invariants beyond declared constraints.
- Isolation. Concurrent transactions produce a result as if they had run in some serial order. This is the property that concurrency control delivers, and it is the subject of this note.
- Durability. Once a transaction commits, its effects survive crashes. Mechanically this is write-ahead logging plus forcing the log at commit, covered in the WAL/ARIES material.

Why concurrency control is needed at all: if you ran transactions strictly one at a time you would get isolation for free, but throughput would collapse because a transaction that blocks on disk would idle the whole CPU. Interleaving transactions reclaims that throughput. The cost is that naive interleaving produces wrong answers. The classic anomalies are the catalog of wrong answers. The notation below follows the critique paper: `w1[x]` is transaction 1 writing item x, `r2[x]` is transaction 2 reading x, `c1` is transaction 1 committing, `a1` is transaction 1 aborting. A subscript identifies the transaction.

- Dirty write. `w1[x] ... w2[x] ...` then both commit. Two transactions write the same item with one write interleaved between the other's read and write, so it becomes impossible to undo cleanly to a consistent state. The critique paper labels this P0 and notes that even the loosest isolation level must forbid it, otherwise rollback is ill-defined (critique paper, section 3).
- Dirty read. `w1[x] ... r2[x] ...` where T2 reads a value T1 wrote but has not committed. If T1 later aborts, T2 read a value that never officially existed. This is P1 in the paper.
- Non-repeatable read (fuzzy read). `r1[x] ... w2[x] ... c2 ... r1[x]`. T1 reads x, T2 modifies x and commits, T1 reads x again and gets a different value inside the same transaction. This is P2.
- Phantom. `r1[P] ... w2[y in P] ... c2 ... r1[P]`. T1 runs a query over a predicate P (for example, all employees in department 5), T2 inserts or deletes a row that matches P and commits, and T1's second evaluation of the same predicate returns a different set of rows. The difference from a non-repeatable read is that the changed thing is which rows exist, not the value of a row T1 already saw. This is P3. It matters because preventing it requires locking the predicate or the gap, not just the rows that currently exist.
- Lost update. `r1[x] ... r2[x] ... w1[x] ... w2[x]`. Both read x = 10, both compute x + 1, both write 11. One increment is lost. This is the canonical reason "read, modify, write" without protection is unsafe.
- Write skew. Two transactions read an overlapping set, each checks a constraint that currently holds, then each writes a different item. Individually each write keeps the constraint true given what that transaction read, but together they violate it. The textbook example: two doctors on call, a rule that at least one must remain on call, both read "two on call, fine," each takes themselves off call, and now zero are on call. The critique paper labels this A5B and uses it specifically to show that snapshot isolation is not serializable (critique paper, section 4.2).

The unifying point: every anomaly is a way that an interleaved schedule can produce a result no serial schedule could. Concurrency control's job is to allow interleaving while forbidding exactly those results.

## Mechanisms

### Schedules and serializability

A schedule is an ordering of the read and write operations of a set of transactions. Useful classes, from the concurrency control theory material (CMU 15-445 Lecture 15; Gray and Reuter, Transaction Processing):

- Serial schedule. Transactions run one after another with no interleaving. Always correct by definition, but no concurrency.
- Serializable schedule. An interleaved schedule whose final effect equals some serial schedule. This is the target. "Equal" needs a definition, which gives two flavors below.
- Conflict-serializable schedule. A schedule that can be turned into a serial schedule by swapping adjacent non-conflicting operations. Two operations conflict if they are from different transactions, touch the same item, and at least one is a write. The three conflict types are write-read, read-write, and write-write. Conflict serializability is a sufficient (not necessary) condition for serializability and is the one engines actually test, because it is decidable in polynomial time. View serializability is strictly more permissive but is NP-complete to test, so no engine uses it.

The precedence graph (also conflict graph or serialization graph) is how you test conflict serializability. Build a directed graph with one node per committed transaction. Draw an edge Ti to Tj whenever an operation of Ti conflicts with and precedes a later operation of Tj on the same item (Ti reads/writes x, then Tj writes x, or Ti writes x then Tj reads x). Theorem: a schedule is conflict-serializable if and only if its precedence graph is acyclic (CMU 15-445 Lecture 15; Gray and Reuter chapter on isolation). If acyclic, any topological sort of the graph is an equivalent serial order. A cycle means there is no consistent serial order, which is exactly the failure mode behind write skew (the graph has a cycle between the two transactions).

Cost note: a topological sort and cycle check is O(V + E) in the number of transactions and conflict edges. The graph is not usually materialized in lock-based systems, which prevent cycles dynamically instead. It is materialized (conceptually) in serializable snapshot isolation, which detects dangerous structures in the dependency graph.

### Recoverability

Serializability is about correctness under concurrency. Recoverability is a separate axis about correctness under aborts. Three nested classes:

- Recoverable schedule. A transaction commits only after every transaction whose data it read has already committed. If T2 read a value T1 wrote, T2 must not commit before T1. If it did and T1 then aborted, you have a committed transaction that read garbage, which is unrecoverable. Every real system requires at least this.
- Cascadeless schedule (avoids cascading aborts, ACA). Transactions read only values written by committed transactions. This prevents one abort from forcing a chain of dependent aborts. Stronger than recoverable.
- Strict schedule. No transaction may read or overwrite an item until the transaction that last wrote it has committed or aborted. This makes undo simple: the before-image to restore is always the value that existed before this transaction's write. Strict 2PL produces strict schedules, which is why production locking systems use it.

The containment is strict schedules subset cascadeless subset recoverable. Serializability and recoverability are independent: a schedule can be serializable but not recoverable, and vice versa.

### Two-phase locking (2PL)

2PL is the dominant lock-based protocol for guaranteeing conflict serializability. The rule has two phases per transaction:

- Growing phase. The transaction may acquire locks but may not release any.
- Shrinking phase. Once the transaction releases its first lock, it may release more but may not acquire any.

The single point where the last lock is acquired and the first is about to be released is the lock point. Theorem (Gray and Reuter; CMU 15-445 Lecture 16): if every transaction in a schedule obeys 2PL, the schedule is conflict-serializable. The intuition for why: order transactions by their lock points. If Ti's operation conflicts with and precedes Tj's, then Ti held the lock before Tj could acquire it, so Ti's lock point precedes Tj's. The lock-point order is therefore a valid topological order of the precedence graph, so the graph is acyclic. 2PL is sufficient for conflict serializability but not necessary: some conflict-serializable schedules are not producible under 2PL.

Plain 2PL still allows dirty reads and cascading aborts, because a transaction can release a lock (entering the shrinking phase) and commit later, and another transaction can read that just-unlocked, uncommitted-author item. Two stronger variants fix this:

- Strict 2PL. Hold all exclusive (write) locks until commit or abort. Eliminates dirty reads of written data and produces strict schedules.
- Rigorous 2PL (strong strict 2PL). Hold all locks, both shared and exclusive, until commit or abort. The shrinking phase collapses to a single instant at commit. This is what most textbooks mean by "the locking implementation" and what the critique paper assumes when it derives the locking versions of the isolation levels.

2PL does not by itself prevent deadlock. Two transactions can each hold a lock the other wants. Systems handle this either with deadlock detection (build a waits-for graph, find a cycle, abort a victim) or deadlock prevention (timeouts, or wait-die / wound-wait timestamp schemes). Deadlock detection is the common choice; the waits-for graph is checked periodically, and the cost is O(V + E) per check.

### Lock modes and compatibility

The two basic modes (CMU 15-445 Lecture 16):

- Shared (S). Held for reads. Many transactions can hold S on the same item simultaneously.
- Exclusive (X). Held for writes. Only one transaction can hold X, and not while any other transaction holds S.

Lock compatibility matrix:

|        | S held | X held |
|--------|--------|--------|
| S req  | yes    | no     |
| X req  | no     | no     |

A lock request that is incompatible with a currently held lock blocks until the holder releases. Real systems extend this with more modes for hierarchical (multi-granularity) locking: intention locks IS, IX, and SIX let a transaction lock a table coarsely to signal it will lock rows inside finely, so the lock manager can detect a table-level X request conflicting with row-level locks without scanning every row. The lock manager itself is a hash table keyed by lockable object id, with each entry holding a granted-modes set and a FIFO wait queue, all protected by latches (short-term mutexes distinct from locks).

### Snapshot isolation (SI) and write skew

Snapshot isolation is not a lock-based protocol and is not on the ANSI ladder. Each transaction reads from a consistent snapshot of the database as of its start, so it never sees another transaction's uncommitted or concurrently-committed changes. Writes are buffered and checked at commit. The standard conflict rule is First-Committer-Wins: if two concurrent transactions wrote the same item, the first to commit wins and the second aborts (critique paper, section 4.1; many implementations use the equivalent First-Updater-Wins via row locks).

SI forbids dirty read, non-repeatable read, lost update, and even the simple phantom, because everything is read from a frozen snapshot. What it does not forbid is write skew (A5B) and a particular read-only anomaly. The reason is that First-Committer-Wins only catches write-write conflicts on the same item. Write skew is two transactions writing different items after reading an overlapping set, so there is no write-write conflict to catch, yet the precedence graph has a cycle. This is the headline result of the critique paper: SI sits outside the ANSI levels because it forbids P3-style phantoms that Repeatable Read allows, yet it is weaker than Serializable because it permits write skew (critique paper, section 4.2 and the level-comparison figure). SI is therefore incomparable with Repeatable Read, not simply above or below it.

The fix that makes SI serializable is Serializable Snapshot Isolation (SSI, Cahill, Rohm, Fekete 2008). SSI runs SI but additionally tracks read-write dependencies (rw-antidependencies) and aborts a transaction when it detects a "dangerous structure": a transaction with both an incoming and an outgoing rw-antidependency edge, which is a necessary condition for a serialization-graph cycle. This is what PostgreSQL ships as its Serializable level (PostgreSQL docs, Transaction Isolation).

## How real systems do it

### PostgreSQL

PostgreSQL uses MVCC. Readers do not block writers and writers do not block readers, because each row version (tuple) carries `xmin` and `xmax` system columns (the inserting and deleting/updating transaction ids), and a transaction sees a tuple version based on a snapshot of which transaction ids were committed when its snapshot was taken.

- It exposes all four ANSI levels but implements only three. The docs state plainly: "internally only three distinct isolation levels are implemented, i.e., PostgreSQL's Read Uncommitted mode behaves like Read Committed." Dirty reads are never possible in PostgreSQL, even at Read Uncommitted (PostgreSQL docs, Table 13.1).
- Read Committed is the default. Each statement takes a fresh snapshot, so a SELECT "sees only data committed before the query began." Successive statements in one transaction can see different committed data.
- Repeatable Read is implemented as snapshot isolation. The snapshot is taken at the first non-transaction-control statement of the transaction and held for the whole transaction. The docs say it "is implemented using a technique known in academic database literature and in some other database products as Snapshot Isolation." Because it is SI, a write conflict raises `ERROR: could not serialize access due to concurrent update`, and applications must retry. PostgreSQL's Repeatable Read does not exhibit phantom reads even though the ANSI standard would allow it, because the snapshot freezes the visible row set (PostgreSQL docs).
- Serializable is implemented as SSI. The docs: "implemented using a technique known in academic database literature as Serializable Snapshot Isolation, which builds on Snapshot Isolation by adding checks for serialization anomalies." It works exactly like Repeatable Read but also monitors for dangerous read/write dependency structures and aborts with `ERROR: could not serialize access due to read/write dependencies among transactions`. It uses predicate locking via SIRead locks, visible in `pg_locks` with `mode = SIReadLock`. These locks never block and never cause deadlock; they only record that a read happened so a later conflicting write can be detected (PostgreSQL docs, "Serializable Isolation Level"). A `SERIALIZABLE READ ONLY DEFERRABLE` transaction is the one case where a Serializable transaction can block, waiting until it can guarantee a safe snapshot.
- Caveat the exam likes: changes to a sequence (the counter behind `serial`) are immediately visible to all transactions and are not rolled back on abort, so gaps in serial ids are normal (PostgreSQL docs). Separately, even Serializable can raise a unique constraint violation that no serial order would, because constraint checks can fire before the SSI conflict check (PostgreSQL docs).

### SQLite

SQLite's model is far simpler and depends on the journaling mode.

- Isolation level. The docs state: "Except in the case of shared cache database connections with PRAGMA read_uncommitted turned on, all transactions in SQLite show 'serializable' isolation," and "SQLite implements serializable transactions by actually serializing the writes. There can only be a single writer at a time." So SQLite gets serializability the brute-force way, by allowing only one writer.
- Rollback-journal mode (the historical default) uses file locks with five states (SQLite "File Locking And Concurrency" doc): UNLOCKED (no access), SHARED (many readers, no writer), RESERVED (one transaction intends to write but is still only reading, new readers still allowed), PENDING (writer is waiting for existing readers to finish, no new readers allowed), and EXCLUSIVE (the writer has the file, no other lock of any kind allowed). A writer climbs UNLOCKED to SHARED to RESERVED to PENDING to EXCLUSIVE. The PENDING state exists specifically to prevent writer starvation: it lets current readers drain while blocking new ones. Quote: "Any number of processes can hold SHARED locks at the same time ... But no other thread or process is allowed to write to the database file while one or more SHARED locks are active."
- WAL mode (since version 3.7.0) changes the picture. Writers append to a separate write-ahead log instead of overwriting the main file, so "WAL mode permits simultaneous readers and writers." In WAL mode "SQLite exhibits 'snapshot isolation': when a read transaction starts, that reader continues to see an unchanging 'snapshot' of the database file as it existed at the moment in time when the read transaction started" (SQLite isolation doc). There is still only one writer at a time.
- Same-connection caveat: "there is no isolation between operations that occur within the same database connection." A SELECT sees committed and uncommitted changes made earlier on its own connection, and modifying a table while stepping a SELECT over it on the same connection is undefined (SQLite isolation doc). This is a favorite gotcha.

The contrast to teach: PostgreSQL buys high concurrency with version visibility and SSI conflict detection; SQLite buys simplicity and serializability by serializing writers outright. Both reach serializable, by opposite routes.

## Common exam traps and misconceptions

These are framed as the false statement an MCQ would offer, followed by the correction.

- False: "ANSI isolation levels are defined by which locking they use." They are defined by which phenomena they forbid (P1, P2, P3), not by an implementation. The whole point of the critique paper is that the phenomenon-based definitions are ambiguous and fail to pin down the locking implementations, which is why the paper adds dirty write (P0) and the strict-vs-loose interpretations.
- False: "Snapshot isolation is the same as Serializable" or "SI is a stronger Repeatable Read." SI is incomparable with Repeatable Read and weaker than Serializable. It permits write skew (A5B) and a read-only anomaly. PostgreSQL even labels its SI level "Repeatable Read," which fuels this confusion, but PostgreSQL Repeatable Read is SI, not the ANSI Serializable.
- False: "Serializable means transactions actually run one at a time." Serializable means the result is equivalent to some serial order, not that execution is serial. PostgreSQL's Serializable runs transactions concurrently and only aborts the ones that would break equivalence.
- False: "Conflict serializability and view serializability are the same, and engines test serializability exactly." Conflict serializability is a sufficient condition that engines test in polynomial time; view serializability is broader but NP-complete to test, so it is never used in practice. Some serializable schedules are rejected by conflict-based tests.
- False: "Two-phase locking means lock in phase one, do work in phase two." The two phases are growing (acquire only) and shrinking (release only). Work happens throughout. Plain 2PL also does not prevent deadlock and does not by itself prevent cascading aborts; you need strict or rigorous 2PL for cascadelessness.
- False: "A phantom is just a non-repeatable read." A non-repeatable read is a changed value of an already-seen row; a phantom is a changed set of rows matching a predicate (an insert or delete). Preventing phantoms needs predicate or range/gap locking, not just row locks. This is why Repeatable Read (which forbids P2) can still allow P3.
- False: "Repeatable Read in PostgreSQL allows phantoms because the standard permits them." PostgreSQL's Repeatable Read does not show phantoms; the standard only sets a floor (which anomalies must not occur), and a stronger implementation is allowed (PostgreSQL docs, Table 13.1 note).
- False: "Recoverable implies serializable, or serializable implies recoverable." They are independent axes. Recoverability constrains commit order relative to reads; serializability constrains the equivalent serial order. A schedule can satisfy one and not the other.
- False: "Lost update is the same as dirty write." Lost update is two read-modify-write cycles where one overwrite silently discards the other's committed effect, and it can occur with no dirty read. Dirty write (P0) is overlapping writes that break rollback. SI prevents lost update via First-Committer-Wins but still allows write skew.
- False: "PostgreSQL Read Uncommitted lets you see dirty data." It does not; it behaves identically to Read Committed, so dirty reads are impossible in PostgreSQL at any level.
- False: "SQLite supports multiple concurrent writers in WAL mode." WAL mode allows concurrent readers with one writer; it never allows two simultaneous writers. The single-writer rule is how SQLite stays serializable.

## Good simulator ideas

These are for the interactive lessons the learner wants. Each names what the learner manipulates and what they observe.

1. Interleaving sandbox with a live precedence graph. The learner drags operations from two or three transactions (`r1[x]`, `w2[y]`, `c1`, ...) onto a shared timeline to build a schedule. The simulator continuously draws the precedence graph and colors it green when acyclic (serializable, with the equivalent serial order shown as a topological sort) and red when a cycle appears, highlighting the conflicting edges. A side panel classifies the schedule as recoverable, cascadeless, or strict, updating as the learner moves operations. The payoff: the learner feels why a cycle equals "no serial order exists" and sees write skew show up as a two-node cycle.

2. Isolation-level phenomenon checker. The learner picks an isolation level (read uncommitted, read committed, repeatable read, serializable, or snapshot isolation as a separate choice) and one anomaly scenario (dirty read, non-repeatable read, phantom, lost update, write skew). The simulator runs the canonical two-transaction script under that level's rules and shows step by step whether the anomaly is blocked (lock wait, abort with the real PostgreSQL error string, or snapshot hides the change) or allowed (the wrong value appears). A matrix at the bottom fills in as the learner explores, eventually reproducing both the ANSI Table 13.1 grid and the critique paper's extended grid where SI is its own row that breaks on write skew.

3. Lock manager and 2PL stepper. The learner steps two transactions through reads and writes; the simulator shows the lock table (object id, granted modes, wait queue), enforces the S/X compatibility matrix, and marks the growing and shrinking phases and the lock point of each transaction. The learner can toggle between plain 2PL, strict 2PL, and rigorous 2PL and watch how holding write locks until commit removes a cascading abort that plain 2PL allowed. Constructing a deadlock makes a waits-for cycle light up and the simulator picks and aborts a victim, which connects locking back to the abort/undo machinery.

## Citations

- PostgreSQL documentation, "Transaction Isolation": https://www.postgresql.org/docs/current/transaction-iso.html . The authoritative source for which ANSI levels PostgreSQL implements (three of four, Read Uncommitted behaves as Read Committed), Table 13.1 of phenomena per level, Repeatable Read as snapshot isolation, Serializable as SSI with SIRead predicate locks, the exact serialization-failure error strings, and the sequence and unique-constraint caveats.
- Berenson, Bernstein, Gray, Melton, O'Neil, O'Neil, "A Critique of ANSI SQL Isolation Levels," SIGMOD 1995 (Microsoft Research TR MSR-TR-95-51). CMU course mirror: https://www.cs.cmu.edu/~15721-f24/papers/Critique_of_ANSI_Isolation_Levels.pdf . arXiv copy: https://arxiv.org/abs/cs/0701157 . Source for P0 dirty write, the loose vs strict phenomenon interpretations, the definition of snapshot isolation with First-Committer-Wins, A5A read skew and A5B write skew, and the argument that the anomaly-based ANSI definitions are underspecified.
- SQLite documentation, "File Locking And Concurrency In SQLite Version 3": https://www.sqlite.org/lockingv3.html . Source for the five rollback-journal lock states (UNLOCKED, SHARED, RESERVED, PENDING, EXCLUSIVE), the write lock-escalation order, and the PENDING-lock writer-starvation fix.
- SQLite documentation, "Isolation In SQLite": https://www.sqlite.org/isolation.html . Source for serializable isolation by default, serialization of writers (single writer), WAL-mode snapshot isolation, and the no-isolation-within-a-single-connection caveat.
- CMU 15-445/645 Intro to Database Systems, Fall 2023 schedule: https://15445.courses.cs.cmu.edu/fall2023/schedule.html . Lecture 15 Concurrency Control Theory, Lecture 16 Two-Phase Locking, Lecture 17 Timestamp Ordering, Lecture 18 Multi-Version Concurrency Control. Source for schedule classes, the precedence graph acyclicity theorem, the 2PL phases and serializability proof sketch, and the S/X lock compatibility matrix.
- Gray and Reuter, "Transaction Processing: Concepts and Techniques" (Morgan Kaufmann, 1993). Standard reference text for the ACID definitions, serializability theory, recoverability classes, and the lock-based isolation theorems. Cited from the course reading list, not fetched online.

## Glossary terms

- ACID -> Atomicity, Consistency, Isolation, Durability: the four guarantees a transaction system provides.
- Atomicity -> all of a transaction's effects happen or none do; enforced by the log and the undo path.
- Durability -> committed effects survive crashes; enforced by write-ahead logging and forcing the log at commit.
- Isolation -> concurrent transactions produce a result equivalent to some serial order.
- Schedule -> an ordering of the read and write operations of a set of transactions.
- Serial schedule -> transactions run one after another with no interleaving.
- Serializable schedule -> an interleaved schedule whose effect equals some serial schedule.
- Conflict-serializable schedule -> a schedule reducible to a serial one by swapping adjacent non-conflicting operations; testable in polynomial time.
- Conflict -> two operations from different transactions on the same item where at least one is a write.
- Precedence graph (serialization graph) -> directed graph of transactions with edges for conflicts; the schedule is conflict-serializable iff the graph is acyclic.
- View serializability -> a broader correctness class than conflict serializability; testing it is NP-complete, so engines do not use it.
- Recoverable schedule -> a transaction commits only after every transaction whose data it read has committed.
- Cascadeless schedule (ACA) -> transactions read only values written by committed transactions; avoids cascading aborts.
- Strict schedule -> no transaction reads or overwrites an item until the last writer of it commits or aborts; makes undo trivial.
- Dirty write (P0) -> overlapping writes to the same item that break clean rollback; forbidden at every isolation level.
- Dirty read (P1) -> reading a value written by an uncommitted transaction.
- Non-repeatable read (P2) -> re-reading an item inside one transaction and getting a different committed value.
- Phantom (P3) -> re-evaluating a predicate query and getting a different set of rows because of concurrent inserts or deletes.
- Lost update -> two read-modify-write cycles where one transaction silently overwrites the other's committed update.
- Write skew (A5B) -> two transactions read an overlapping set, each writes a different item, and together they violate a constraint each kept individually.
- Read skew (A5A) -> a transaction reads parts of a multi-item update at different times and sees a mutually inconsistent combination.
- ANSI isolation levels -> Read Uncommitted, Read Committed, Repeatable Read, Serializable; defined by which phenomena each forbids.
- Read Committed -> forbids dirty reads; allows non-repeatable reads and phantoms.
- Repeatable Read -> forbids dirty and non-repeatable reads; ANSI allows phantoms (PostgreSQL implements it as SI, which blocks them).
- Serializable -> forbids all listed phenomena and any serialization anomaly.
- Snapshot isolation (SI) -> each transaction reads a consistent snapshot taken at its start; write conflicts resolved by First-Committer-Wins; permits write skew, so it is not serializable.
- First-Committer-Wins -> when two concurrent transactions write the same item, the first to commit succeeds and the second aborts.
- Serializable Snapshot Isolation (SSI) -> SI plus detection of dangerous read-write dependency structures, aborting transactions that would break serializability; PostgreSQL's Serializable level.
- Two-phase locking (2PL) -> a transaction first only acquires locks (growing phase), then only releases them (shrinking phase); guarantees conflict serializability.
- Lock point -> the moment a 2PL transaction holds all its locks, just before it releases the first.
- Strict 2PL -> holds all exclusive locks until commit or abort; produces strict schedules.
- Rigorous 2PL -> holds all locks, shared and exclusive, until commit or abort.
- Shared lock (S) -> read lock; multiple transactions may hold it on the same item.
- Exclusive lock (X) -> write lock; only one holder, incompatible with any S or X.
- Intention locks (IS, IX, SIX) -> coarse-granularity locks that signal finer-grained locking inside an object for multi-granularity locking.
- Deadlock -> a cycle of transactions each waiting on a lock the next holds; resolved by detection (waits-for graph) or prevention.
- Predicate locking -> locking a query predicate or range rather than existing rows, needed to prevent phantoms; in PostgreSQL the non-blocking SIReadLock records reads for SSI conflict checks.
- MVCC -> multi-version concurrency control; readers see an appropriate row version instead of blocking on writers (PostgreSQL's core method).
