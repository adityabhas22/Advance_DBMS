# ARIES: A Transaction Recovery Method

Citation: C. Mohan, Don Haderle, Bruce Lindsay, Hamid Pirahesh, Peter Schwarz. "ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging." ACM Transactions on Database Systems, Vol. 17, No. 1, March 1992, pages 94-162. ARIES stands for Algorithm for Recovery and Isolation Exploiting Semantics.

Source read for this note: the extracted text of the paper (abstract, Section 1 Introduction, Section 2 Goals, Section 3 overview, Section 4 data structures, Section 5 normal processing, Section 6 the three restart passes). Section and figure references below point at that text. The PDF OCR reflowed the two-column layout, so wording is paraphrased faithfully rather than quoted verbatim.

## What problem this paper solves and why it mattered

Before ARIES, write-ahead logging (WAL) recovery methods in shipping systems (IBM IMS, DB2, Tandem NonStop SQL, AS/400) all had defects that the paper enumerates in Section 1 and Section 2: some would undo the same logged action multiple times, some undid updates that were never actually present on the page, some undid committed updates that had already reached disk and then redid them, and rollbacks could generate an unbounded amount of new log if failures cascaded during recovery. None of them cleanly supported fine granularity (record level) locking together with operation logging (for example increment and decrement, where semantically commuting operations from uncommitted transactions touch the same page). ARIES gives a single method that supports steal and no-force buffer policies, partial rollbacks, fine-granularity locking, operation and value logging, fuzzy checkpoints, media recovery, and parallelism during restart, while keeping the amount of work bounded and the page state always precisely correlated with the log. It became the de facto standard recovery algorithm and was implemented in DB2, OS/2 Extended Edition Database Manager, Starburst, QuickSilver, and the University of Wisconsin EXODUS and Gamma systems (abstract and Section 1).

## The core mechanism

ARIES guarantees the atomicity and durability properties of transactions in the face of process, transaction, system, and media failures (Section 3). It does so from a few first principles.

### Write-ahead logging and the LSN

In WAL systems an updated page is written back in place, to the same nonvolatile location it was read from (Section 1.1). This contrasts with the shadow page technique of System R and SQL/DS, where the new version of a page goes to a different location and the old version is kept for recovery (Figure 1). In-place updating means the log, not a shadow copy, is the source of truth for recovery.

Every log record gets a log sequence number (LSN), a monotonically increasing identifier (Section 1.1 and Section 4). Each database page carries a page_LSN field, defined in Section 4.2 as the LSN of the log record that describes the most recent update to that page (this record may be a normal update record or a Compensation Log Record). The page_LSN is what lets ARIES correlate the exact state of a page with the logged actions that have or have not been applied to it. This is the precise tracking that operation logging requires (Section 2): you may not redo an operation whose effect is already present, and you may not undo an operation whose effect is not present.

The WAL protocol (Section 1.1, restated in Section 4.2) has two parts:
1. Before a changed page is written to the durable database, the log records describing the changes must already be on stable storage, at least the undo portions. ARIES expects the buffer manager to enforce this. To do so the buffer manager may have to force the log up to the page_LSN of a dirty page before writing that page out.
2. A transaction is not considered committed until its commit record and all of its log up to that LSN have been forced to stable storage (Section 1.1).

These two rules are what make steal and no-force safe. Steal means a page dirtied by an uncommitted transaction may be written to the database before commit, which is why undo work can be needed at restart. No-force means a committing transaction need not push its dirtied pages to the database, which is why redo work can be needed at restart (definitions in Section 4 on buffer management, around the steal and no-force discussion). ARIES places no restriction on the page replacement policy beyond enforcing WAL.

### Logging changes during undo: Compensation Log Records

When ARIES undoes an update, it logs that undo as a Compensation Log Record (CLR) (Section 3, Figures 3 to 5). CLRs are redo-only: they are never themselves undone (Section 3 and Section 4.1). Each CLR carries an UndoNxtLSN field, present only in CLRs (Section 4.1), which points to the predecessor of the log record that the CLR just compensated, that is, the next log record of that transaction still to be undone. In the worked example (Figure 5) the CLR for log record 3 has UndoNxtLSN pointing at log record 2.

Two consequences follow. First, the UndoNxtLSN of the most recently written CLR tells you exactly how far rollback has progressed, so if a system failure or a nested rollback interrupts undo, recovery resumes from that point and skips records already undone. This is what bounds logging during rollback even under repeated failures or nested rollbacks (abstract and Section 3), which contrasts with IMS undoing the same non-CLR multiple times and with DB2 and others that undo CLRs as well (Section 3, Figure 4). Second, because CLRs record what the undo actually did, the undo action need not be the exact physical inverse of the original on the same page. That enables logical undo, which supports high concurrency (Section 3).

Every log record (including a CLR) also carries a PrevLSN field pointing to the most recent preceding log record written by the same transaction (Section 4.1), which chains a transaction's records into a backward list with the first record holding a zero PrevLSN.

### Repeating history

The central new paradigm is repeating history during redo (abstract and Section 3). On restart ARIES first redoes all updates logged on stable storage whose effects did not reach the nonvolatile database before the failure. Crucially this is done for the updates of all transactions, including the losers (transactions that had neither committed nor reached the in-doubt state of two-phase commit). This reestablishes the exact database state as of the moment of the system failure, including the losers' updates, and only then does it roll the losers back (Section 3). Repeating history is what guarantees that ARIES never undoes an update that is not present and never has to undo then redo a committed change that already reached disk (the goals in Section 2 that explicitly rule out competing methods).

### The three data structures (Section 4)

- Page_LSN: per-page field, the LSN of the latest update to that page (Section 4.2).
- Transaction Table: tracks active transactions (Section 4.3). Key fields: TransID, State (for example commit, or prepared/in-doubt 'P', or unprepared/undoable 'U'), LastLSN (the LSN of the latest log record written by the transaction), and UndoNxtLSN (the next record to process during rollback; if the transaction's most recent record is a CLR this is taken from that CLR's UndoNxtLSN, otherwise it equals LastLSN).
- Dirty Pages Table: tracks dirty buffer pages (Section 4.4). Each entry is PageID and RecLSN (recovery LSN). When a clean page is first fixed with intent to modify, RecLSN is set to the current end-of-log LSN, the LSN of the next record to be written. RecLSN marks the point in the log from which updates to that page may not yet be on disk. When a page is written to disk its entry is removed.

Both tables are written into checkpoint records and reconstructed at restart, the Transaction Table and Dirty Pages Table both being initialized from the latest checkpoint and then brought up to date during the analysis pass.

### The three restart passes (Section 6)

1. Analysis (Section 6.1). Scan forward from the most recent checkpoint to the end of the log. Rebuild the Transaction Table and Dirty Pages Table up to end of log. Determine the set of loser transactions to undo, and compute RedoLSN, the LSN at which the redo pass must start, as the minimum RecLSN over all entries in the Dirty Pages Table (Section 4.4 and Section 6.1). For each in-progress transaction the LSN of its most recent log record is also recovered.

2. Redo (Section 6.2, pseudocode in Figure 11). Scan forward from RedoLSN to end of log, repeating history. For each update or compensation log record that is redoable and whose PageID is in the Dirty Pages Table and whose LSN is greater than or equal to that page's RecLSN, fix and latch the page and compare. Redo is conditional on the page_LSN: only if Page.LSN < LogRec.LSN is the update reapplied, after which page_LSN is set to LogRec.LSN. If the page's LSN already covers the record, the update is skipped (it already reached disk). No logging is performed during redo. The redo pass also acquires locks to protect the uncommitted updates of in-doubt (prepared) distributed transactions that will survive restart.

3. Undo (Section 6.3). Roll back all loser transactions in reverse chronological order in a single sweep of the log, by repeatedly taking the maximum of the next-to-be-undone LSNs across all not-yet-fully-undone losers, until none remain. For each undone update a CLR is written. Unlike redo, undo is unconditional: ARIES does not compare the page's LSN against the log record's LSN to decide whether to undo (Section 3 and Section 6.3). When a CLR is encountered during undo, ARIES jumps to the record named by the CLR's UndoNxtLSN, skipping already-undone work.

## Key facts and figures

- ARIES = Algorithm for Recovery and Isolation Exploiting Semantics (abstract).
- Published ACM TODS Vol. 17 No. 1, March 1992, pages 94 to 162.
- The LSN is a monotonically increasing log record identifier; each page stores the page_LSN of the log record for its most recent update (Section 1.1, Section 4.2).
- WAL protocol: log (at least undo portions) must reach stable storage before the dirty page is written to the database; commit requires forcing the log up to the commit record's LSN (Section 1.1).
- ARIES supports the steal and no-force buffer policies; it imposes no page replacement restriction beyond WAL (Section 4.2 and buffer management discussion in Section 4).
- Three principles: write-ahead logging, repeating history during redo, and logging changes during undo via CLRs (abstract and Section 3).
- CLRs are redo-only, never undone, and carry UndoNxtLSN; non-CLR records and CLRs carry PrevLSN (Section 3, Section 4.1).
- UndoNxtLSN of the last CLR records rollback progress and bounds logging under nested rollbacks and repeated failures (Section 3).
- Three restart passes: Analysis, Redo, Undo. The redo pass starts at RedoLSN = minimum RecLSN of the Dirty Pages Table (Section 6.1, Section 4.4).
- Redo is conditional (redo only if page_LSN < log LSN); undo is unconditional (Section 6.2 Figure 11, Section 6.3).
- Repeating history redoes updates of all transactions including losers, to reestablish the exact state at the time of failure before undoing losers (Section 3).
- Losers are transactions that had neither committed nor reached the in-doubt (prepared) state of two-phase commit at failure time (Section 3).
- Logical undo is possible because CLRs describe the undo done, so undo need not be the physical inverse of the original action on the same page (Section 3).
- Compared against and shown superior to the WAL methods of DB2, IMS, and Tandem (abstract, Section 1, Figure 6).

## Trade-offs and limitations

- Repeating history can redo work that will immediately be undone for losers, that is, ARIES re-applies a loser's updates during redo and then compensates them during undo. The paper accepts this so that the database is in a known precise state before undo and so that operation and logical undo are sound. The cost is some redundant page touches relative to a method that skipped loser redo.
- The buffer manager must enforce WAL, including forcing the log up to a page's page_LSN before stealing that page (Section 4.2), which adds log force I/O coupling to page write-back.
- Correctness depends on accurate per-page page_LSN bookkeeping and on the Dirty Pages Table RecLSN values. If page_LSN or RecLSN are wrong, the conditional redo test breaks. ARIES intentionally couples the recovery method, the locking granularity, and the storage management scheme; Section 1 warns these cannot be chosen independently and still be correct and efficient.
- CLR logging adds log volume during rollback, although the UndoNxtLSN chaining keeps it bounded rather than unbounded.
- The full algorithm is intricate; the authors note the paper is long because of comprehensive coverage and that recovery is error-prone (Section 2, Simplicity goal).
- The paper assumes WAL with in-place updating; it explicitly argues the System R shadow-page recovery paradigms are inappropriate in the WAL context (Section 1.1 and Section 10).

## How it maps to the course

- Week 14 (the week this note grounds): crash recovery and logging. ARIES is the canonical reference for any lesson on WAL, the redo/undo model, steal/no-force, checkpointing, and restart recovery.
- Lessons that should cite this paper:
  - The WAL protocol and the page_LSN invariant (lesson on durability and the log).
  - Steal/no-force buffer management and why each implies undo or redo respectively.
  - The three-pass restart (Analysis, Redo, Undo) and the repeating-history paradigm.
  - Compensation Log Records and how logging undo work makes rollback idempotent and bounded.
  - Comparison of WAL recovery to shadow paging (ties back to System R material).

## Viva question bank

1. Q: What does the page_LSN field store and why is it essential?
   A: The page_LSN is the LSN of the log record describing the most recent update applied to that page (Section 4.2). It lets ARIES test, during redo, whether a logged update is already reflected on the page, so the system never redoes an effect already present and never undoes an effect not present. Without it operation logging would be unsound.

2. Q: State the WAL protocol precisely.
   A: Before a dirty page is written to the durable database, the log records describing its changes (at least the undo portions) must already be on stable storage; and a transaction is not committed until its commit record and all earlier log up to that LSN are forced to stable storage (Section 1.1). The buffer manager enforces this, sometimes by forcing the log up to a page's page_LSN before stealing it.

3. Q: Why do steal and no-force respectively force ARIES to do undo and redo at restart?
   A: Steal lets an uncommitted transaction's dirty page reach disk before commit, so on a crash those uncommitted changes must be undone. No-force lets a committed transaction's dirty pages stay in the buffer, so on a crash those committed changes may be missing from disk and must be redone (buffer management discussion in Section 4).

4. Q: What is "repeating history" and why does ARIES redo even the losers' updates?
   A: Repeating history means the redo pass reapplies every logged update whose effect did not reach disk, for all transactions including losers (Section 3). This reestablishes the exact database state as of the failure. Only then are losers undone. This guarantees ARIES never has to undo an update that is absent and never undoes-then-redoes a committed update already on disk, the failures it criticizes in other methods (Section 2).

5. Q: What is a Compensation Log Record and why is it redo-only?
   A: A CLR is the log record written when ARIES undoes an update (Section 3). It is redo-only because it is never itself undone; its UndoNxtLSN points to the predecessor of the record it compensated, so once undo work is logged it is permanent and rollback proceeds forward through the remaining records to undo (Section 4.1).

6. Q: How does UndoNxtLSN bound the amount of logging during repeated or nested rollbacks?
   A: UndoNxtLSN in the last-written CLR records exactly how far rollback has progressed. If a failure interrupts rollback, recovery resumes at UndoNxtLSN and skips records already undone, so no record is undone twice and no extra CLRs are generated for already-compensated work (Section 3). Contrast IMS, which can undo the same non-CLR multiple times.

7. Q: What are the three restart passes and what does each produce?
   A: Analysis scans forward from the last checkpoint, rebuilds the Transaction Table and Dirty Pages Table, identifies losers, and computes RedoLSN (Section 6.1). Redo scans forward from RedoLSN repeating history (Section 6.2). Undo scans backward rolling back losers and writing CLRs (Section 6.3).

8. Q: How is RedoLSN, the start of the redo pass, computed?
   A: RedoLSN is the minimum RecLSN over all entries in the Dirty Pages Table (Section 4.4 and Section 6.1). RecLSN for a page is the end-of-log LSN at the moment the page was first dirtied, marking the earliest log point whose updates might not yet be on disk. The minimum across all dirty pages is therefore the earliest point redo could matter.

9. Q: Why is redo conditional but undo unconditional?
   A: Redo checks the page: it reapplies a record only if the page's page_LSN is less than the record's LSN, otherwise the update already reached disk and is skipped (Figure 11). Undo does not consult the page_LSN to decide whether to undo, because after repeating history every loser update is known to be present and must be reversed (Section 3, Section 6.3).

10. Q: What is logical undo and what makes it possible in ARIES?
    A: Logical undo means the undo of an action need not be the exact physical inverse on the same page(s) as the original. It is possible because the CLR describes what the undo actually did, so the system has a precise record independent of the original page layout (Section 3). This supports high-concurrency operations such as record-level changes that may move data across pages.

11. Q: Which transactions are "losers" and where does the loser set come from?
    A: Losers are transactions that at the time of the failure had neither committed nor reached the in-doubt (prepared) state of two-phase commit (Section 3). The set is determined by the analysis pass from the Transaction Table state (Section 6.1).

12. Q: What does the Transaction Table track, and what are its key fields?
    A: It tracks the state of active transactions (Section 4.3). Key fields: TransID, State (for example prepared/in-doubt 'P' or unprepared 'U'), LastLSN (latest log record of the transaction), and UndoNxtLSN (next record to undo; taken from the last CLR's UndoNxtLSN if the latest record is a CLR, else equal to LastLSN).

13. Q: How does ARIES differ from System R shadow paging, and why does that matter for recovery?
    A: System R writes the updated page to a new location and keeps the old version as a shadow for recovery; ARIES updates in place and relies on the log (Section 1.1, Figure 1). The paper argues (Section 10) that System R's logging and recovery paradigms are inappropriate in the WAL context, and that shadowing causes large space overhead and major perturbations during checkpoint and image copy.

14. Q: During undo, what happens when the undo scan encounters a CLR?
    A: It skips to the record identified by that CLR's UndoNxtLSN rather than processing the compensated record again (Section 3, Section 6.3). This is how the backward sweep avoids redoing undo work and how the single-sweep, max-LSN driving of multiple losers stays efficient.

15. Q: After a redoable record is reapplied during redo, what is set, and what is logged?
    A: The affected page's page_LSN is set to the redone log record's LSN, and nothing is logged during redo (Figure 11, Section 6.2). Logging is unnecessary because redo only repeats already-logged history.

## Glossary terms introduced

- ARIES: Algorithm for Recovery and Isolation Exploiting Semantics; the WAL-based recovery method of this paper.
- WAL (write-ahead logging): protocol requiring log records to reach stable storage before the corresponding dirty data page, and before commit (Section 1.1).
- LSN (log sequence number): monotonically increasing identifier of a log record (Section 1.1).
- page_LSN: per-page field holding the LSN of the most recent update to that page (Section 4.2).
- Steal: buffer policy allowing a page dirtied by an uncommitted transaction to be written to the database before commit; implies undo may be needed.
- No-force: buffer policy not requiring a committing transaction's dirty pages to be written to the database; implies redo may be needed.
- CLR (Compensation Log Record): redo-only log record written when undoing an update; carries UndoNxtLSN (Section 3, Section 4.1).
- UndoNxtLSN: field present only in CLRs, pointing to the predecessor of the compensated record, that is, the next record still to be undone (Section 4.1).
- PrevLSN: field in every log record pointing to the previous log record written by the same transaction (Section 4.1).
- Repeating history: redoing all logged updates not yet on disk, including losers', to reestablish the failure-time state before undo (Section 3).
- Loser transaction: a transaction not committed and not in the in-doubt (prepared) state at failure time (Section 3).
- Transaction Table: in-memory table of active transactions (TransID, State, LastLSN, UndoNxtLSN), checkpointed and rebuilt at restart (Section 4.3).
- Dirty Pages Table: in-memory table of dirty buffer pages (PageID, RecLSN), checkpointed and rebuilt at restart (Section 4.4).
- RecLSN (recovery LSN): per-dirty-page LSN set when the page is first dirtied, marking the earliest log point whose updates may not yet be on disk (Section 4.4).
- RedoLSN: the LSN where the redo pass begins, the minimum RecLSN across the Dirty Pages Table (Section 6.1).
- Analysis pass: first restart pass; rebuilds the tables, finds losers, computes RedoLSN (Section 6.1).
- Redo pass: second restart pass; repeats history forward from RedoLSN, conditional on page_LSN (Section 6.2).
- Undo pass: third restart pass; rolls back losers in reverse, writing CLRs (Section 6.3).
- Logical undo: undo whose effect need not be the physical inverse of the original action, enabled by CLRs (Section 3).
- Fuzzy checkpoint: a checkpoint taken without quiescing the system, recording the Transaction and Dirty Pages tables (Section 3, goals in Section 2).
