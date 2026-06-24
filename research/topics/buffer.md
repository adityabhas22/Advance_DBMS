# Buffer pool and replacement policies

Course weeks 4-5. Topic cluster: buffer pool and replacement policies.

This note is grounded in the CMU 15-445 buffer pool lecture, the O'Neil/O'Neil/Weikum LRU-K paper (1993 SIGMOD), the PostgreSQL source tree and manual, and the SQLite manual. Numbers and invariants are attributed inline. URLs are in the Citations section.

## 1. The core problem

A disk-oriented database stores its primary copy of data on persistent storage (HDD or SSD), but the CPU can only operate on data that is in main memory. The gap between the two is large: a random read from an HDD is on the order of milliseconds, an SSD read is tens of microseconds, and a DRAM access is tens of nanoseconds. That is roughly five to six orders of magnitude for a spinning disk. The database is also usually larger than RAM. So the engine cannot simply load everything once and keep it; it must move pages back and forth and decide what to keep.

The buffer pool is the component that does this. The CMU 15-445 lecture describes it as making it "appear as if the entire database resides in memory, when in reality the database might occupy more space than the available memory." The execution engine asks for a page by id and gets a pointer to a memory location; it does not have to know whether that page was already resident or had to be read from disk.

What breaks without it:

- Without caching, every tuple access is a disk I/O. Repeated access to the same hot page (a B+tree root, a small dimension table) would pay the full disk latency every time instead of once.
- Without a fixed-size pool and an eviction policy, a database larger than RAM cannot be queried at all, because there is nowhere to put pages once memory fills.
- Without pinning, the engine could not safely hold a pointer into a frame while another thread reused that frame for a different page. The data under the pointer would change.
- Without a dirty flag and write-back discipline, the engine would either lose modifications or pay a write to disk on every mutation.

Two control problems the buffer manager optimizes for, per the CMU lecture: spatial control (where pages sit on disk, so related pages are physically close and prefetchable) and temporal control (when pages are read in and written back, to minimize stalls).

A natural question is why not just use the operating system's page cache via `mmap`. The CMU lecture lists concrete reasons the DBMS wants its own pool: the OS can flush dirty pages at any time (a transaction-safety hazard), the DBMS does not know which pages are in memory so it cannot avoid I/O stalls it could have scheduled around, a page fault that fails surfaces as a `SIGBUS` the DBMS must handle, and there is internal OS contention and TLB shootdowns. The DBMS can flush dirty pages in the right order (needed for recovery, see section 5), do specialized prefetching, and use replacement policies that exploit knowledge of the query plan. PostgreSQL is the notable system that does still rely on the OS page cache in addition to its own pool, which is why its `shared_buffers` advice caps out well below total RAM (section 3).

## 2. Mechanisms

### 2.1 Frames, the page table, and the page directory

The buffer pool is a large region of memory organized as an array of fixed-size slots called frames. Each frame holds one page. When the engine requests a page, the buffer pool checks whether it is already resident; if not, it reads it from disk into a free frame.

Two mappings are easy to confuse, and the CMU lecture draws the distinction explicitly:

- The page directory is the mapping from page ids to page locations in the on-disk database files. All changes to it must be persisted, because the DBMS reads it to find a physical page on restart.
- The page table is an in-memory hash table mapping page id to the frame that currently holds a copy of that page. It is purely in memory and does not need to survive a restart, because it only describes the current cache contents.

So: page directory tells you where a page lives on disk; page table tells you whether and where it is cached. Lookup in the page table is O(1) average (hash table).

### 2.2 Per-frame metadata: pin count, dirty flag, reference bit

Each frame carries metadata the buffer pool needs for correctness and for replacement decisions:

- Pin / reference counter. The number of threads currently using the page (reading or modifying). A thread increments it before touching the page. Per the CMU lecture: "If a page's pin count is greater than zero, then the storage manager is not allowed to evict that page." Pinning does not block other threads from also accessing the page; it only blocks eviction. When all users unpin and the count returns to zero, the frame becomes an eviction candidate.
- Dirty flag. Set by a thread whenever it modifies the page. It tells the storage manager the page must be written back to disk before the frame is reused. The buffer pool is a write-back (not write-through) cache: mutations are buffered in memory and only flushed on eviction or by a background writer.
- Reference bit (or usage count). Used by CLOCK-family policies to approximate recency. Set to 1 (or incremented) on access; cleared/decremented by the eviction scan.

### 2.3 The fetch / pin / unpin / evict cycle

1. Engine requests page P. Buffer pool looks up P in the page table.
2. Hit: increment P's pin count, return the frame pointer.
3. Miss: find a free frame, or if none, run the replacement policy to choose a victim among unpinned frames. If the victim is dirty, write it back to disk first. Remove the victim from the page table, read P into the frame from disk (using the page directory to find it), insert P into the page table, pin it, return the pointer.
4. When the engine finishes, it unpins P (decrement count) and sets the dirty flag if it modified the page.

Key invariants:

- Only unpinned frames are eviction candidates. A pinned frame is never chosen.
- A dirty victim is written back before its frame is reused; a clean victim can be dropped with no I/O. The CMU lecture calls these the slow path and the fast path of eviction.
- If the pool is full and every frame is pinned, no victim exists. The CMU lecture states an out-of-memory error is thrown in that case.

I/O cost intuition: a cache hit costs no disk I/O. A miss costs one read; if it evicts a dirty page, one write plus one read. Background writing (a separate thread that walks the page table and flushes dirty pages, then either evicts them or just clears the dirty flag) exists to keep the eviction fast path common, so foreground queries rarely block on a write.

### 2.4 Replacement policy theory

When a victim must be chosen, a replacement policy decides which unpinned page to evict. The implementation goals (CMU lecture) are correctness, accuracy, speed, and low metadata overhead.

Optimal (Belady's MIN/OPT). Evict the page whose next use is furthest in the future. This minimizes misses and is provably optimal, but it requires knowing the future reference string, so it is only a theoretical baseline used to measure how close a real policy gets. (Belady, IBM Systems Journal, 1966.)

LRU (least recently used). Track the time each page was last accessed; evict the page with the oldest timestamp. Often kept as a queue ordered by recency so eviction is O(1) at the tail and an access moves the page to the head. The CMU lecture notes the cost: keeping a sorted structure and storing a large timestamp per page has prohibitive overhead at scale.

CLOCK (second chance). An approximation of LRU that avoids per-page timestamps. Each page has a reference bit set to 1 on access. Pages sit in a circular buffer with a "clock hand." On eviction the hand sweeps: if the current page's bit is 1, set it to 0 and advance (giving it a second chance); if the bit is 0, evict it. The hand position is remembered between evictions. This is O(1) amortized metadata (one bit per page) and is what most engines actually use, including PostgreSQL with a small usage counter instead of a single bit.

The fundamental weaknesses of LRU and CLOCK, both stated in the CMU lecture and the LRU-K paper:

- Sequential flooding (cache swamping / pollution). A large sequential scan reads many pages once, in quick succession. Under LRU/CLOCK these freshly read pages have the most recent timestamps, so they push out genuinely hot pages that will be needed again. The scan pages themselves are unlikely to be reused. The LRU-K paper's Example 1.2 describes exactly this: batch sequential scans replace commonly referenced pages with pages unlikely to be referenced again, response time deteriorates, and long I/O queues build up. In this scenario the most recent timestamp is precisely the wrong signal.
- LRU ignores frequency. The LRU-K paper's core complaint is that LRU "decides which page to drop from buffer based on too little information, limiting itself to only the time of last reference." A page referenced 50 times is treated the same as a page referenced once if their last-access times match. The paper's Example 1.1 shows B+tree leaf pages (referenced ~once per 200 page references) and data pages (~once per 20,000) ending up with similar residency under LRU, even though the index pages deserve to stay.

Why MRU and scan resistance help. For a pure sequential scan that will not revisit pages, evicting the most recently used page (MRU) is better than LRU, because the just-read page is the one you are least likely to touch again, so it should give up its frame to let the scan continue without disturbing hot pages. More generally, scan-resistant policies detect or bound scan pages so a one-shot scan cannot evict the working set. PostgreSQL's ring buffers (section 3) are the practical form of this.

LRU-K (O'Neil, O'Neil, Weikum, 1993). Instead of remembering only the last reference, track the times of the last K references to each page and use them to estimate the page's reference interarrival time. The paper defines the Backward K-distance b_t(p, K) as the distance back to the K-th most recent reference to page p (and infinity if p has been referenced fewer than K times). The victim is the page whose Backward K-distance is the maximum, i.e. the page whose K-th-most-recent use is furthest in the past. When several pages have infinite K-distance (not yet seen K times), a subsidiary policy such as plain LRU breaks the tie. Classical LRU is exactly LRU-1 in this taxonomy.

Why LRU-K beats LRU: the paper argues LRU-2 already gives a large improvement because, by looking at the last two references, the system can for the first time measure an actual interarrival time rather than infer it from a single last-access time. A page referenced once and never again has a large 2nd-distance and is evicted quickly, even if it was just touched, which directly defeats sequential flooding. The paper notes LRU-K is fundamentally different from LFU (least frequently used): LRU-K has a built-in notion of aging (it only looks at the last K references), so it adapts to changing access patterns, whereas LFU cannot forget an old burst of popularity.

The Correlated Reference Period. LRU-K must avoid being fooled by references that are not independent, for example a transaction that reads a row then updates it milliseconds later (intra-transaction), a retried transaction, or successive operations in one process. The paper collapses references that fall within a Correlated Reference Period (a short time-out window, canonically a few seconds) into a single logical reference, so two correlated accesses do not look like evidence of long-term popularity. Without this, a page touched twice in quick succession by one transaction would be wrongly promoted.

Prefetching and read-ahead. The buffer pool can read pages it predicts will be needed before they are requested, overlapping I/O with computation. The CMU lecture gives two cases: sequential prefetch during a scan (read the next blocks while the current ones are processed) and index prefetch, where the next logical leaf page in an index scan is fetched even though it may not be the next physical page on disk. Read-ahead turns many small synchronous waits into fewer, larger, asynchronous transfers. Related optimizations from the lecture: scan sharing (synchronized scans), where a second query attaches its cursor to an in-progress scan of the same table and the engine tracks where it joined so it can wrap around and finish, and buffer pool bypass, where a scan operator reads into query-local memory and never inserts those pages into the shared pool at all (used for large one-shot reads and for temporary sort/join data).

## 3. How real systems do it

### 3.1 PostgreSQL

Sizing. `shared_buffers` sets the size of PostgreSQL's buffer pool. The manual states the default is typically 128MB, that a reasonable starting value on a dedicated server with 1GB or more of RAM is 25% of system memory, and that going above 40% of RAM is unlikely to help because PostgreSQL "also relies on the operating system cache." That double-buffering (a page can live in both `shared_buffers` and the OS page cache) is the trade-off PostgreSQL accepts by not using direct I/O for its main reads.

Clock-sweep with a usage count. PostgreSQL does not use plain LRU. The buffer manager (`src/backend/storage/buffer/freelist.c` and the `README` in that directory) uses a clock-sweep variant. Each buffer header has a `usage_count` that is incremented (up to a small ceiling, the constant `BM_MAX_USAGE_COUNT`, which is 5) each time the buffer is pinned. A shared atomic counter `nextVictimBuffer` is the clock hand; the README notes it "isn't a concrete buffer" and only ever increases, taken modulo `NBuffers` to get the actual buffer. The victim search is in `StrategyGetBuffer()` / `ClockSweepTick()`: free-list buffers are used first; otherwise the hand sweeps, and for each buffer that is unpinned, if its `usage_count` is greater than zero it is decremented (a second chance) and the hand moves on; a buffer with zero pin count and zero `usage_count` is taken as the victim. Because the hand only moves on an actual buffer request, hot pages keep getting their count bumped back up and survive many sweeps. The decrement uses compare-and-swap on the buffer state rather than a global lock, which is why ticking the clock no longer requires the strategy spinlock in modern versions.

Ring buffers for sequential scans (`BufferAccessStrategy`). To avoid sequential flooding of the whole pool, PostgreSQL uses a small ring of buffers for bulk operations, created by `GetAccessStrategy()`. The README explains the rationale directly: a page touched only by a large scan "is unlikely to be needed again soon, so instead of running the normal clock-sweep algorithm and blowing out the entire buffer cache," the operation recycles a bounded set of frames. Documented sizes: a 256KB ring for sequential scans (`BAS_BULKREAD`), small enough to fit in L2 cache; 16MB for bulk writes (`BAS_BULKWRITE`), capped at 1/8 of `shared_buffers`; and a VACUUM ring (`BAS_VACUUM`) controlled by the `vacuum_buffer_usage_limit` GUC. For VACUUM, dirty pages are not removed from the ring (they are written within the ring). `BAS_NORMAL` returns no strategy and uses the default clock-sweep.

Prefetch. `effective_io_concurrency` tells PostgreSQL how many concurrent storage I/O operations it can expect to run simultaneously; the manual says the default is 16 and that on systems with prefetch-advice support it also controls the prefetch distance. Historically this drove `posix_fadvise`-style read-ahead into the OS cache; more recent versions can issue asynchronous reads directly into shared buffers.

### 3.2 SQLite

SQLite's page cache sits below the pager. The default cache implementation is `pcache1.c` (the `PCache1` module), used unless an application supplies its own via the `sqlite3_pcache_methods2` interface. It uses an LRU eviction policy and stores cached pages in hash-table slots, each represented by a `PgHdr1`, bounded by a maximum count. Under memory pressure the pager calls a stress callback (`pagerStress()`) to spill: it evicts clean pages or writes dirty pages out to make room.

Sizing is via `PRAGMA cache_size`. The manual's exact semantics: "If the argument N is positive then the suggested cache size is set to N" pages; "If the argument N is negative, then the number of cache pages is adjusted to be a number of pages that would use approximately abs(N*1024) bytes of memory based on the current page size." The default is `-2000`, i.e. about 2,048,000 bytes (~2MB). The setting only lasts for the current connection. Separately, `PRAGMA mmap_size` controls memory-mapped I/O and is a distinct mechanism from the page cache.

### 3.3 The steal / no-force link to recovery

The buffer pool's freedom to evict and its discipline about flushing are tied to crash recovery. Two orthogonal policy choices:

- Steal vs no-steal. Steal allows a dirty page belonging to an uncommitted transaction to be written to disk (because the buffer pool chose to evict its frame). No-steal forbids that. Steal is what makes the buffer pool free to evict any unpinned frame, which is why real systems want it.
- Force vs no-force. Force means all of a transaction's dirty pages are written to disk at commit time. No-force means commit does not require those writes; the pages may still be in memory and get flushed later by the background writer or a checkpoint. No-force makes commits fast and avoids random write storms.

The performant combination is steal + no-force, used by ARIES-style recovery. It has consequences the recovery system must handle, and write-ahead logging (WAL) is what makes it safe:

- Steal means uncommitted changes can be on disk at crash time, so recovery must be able to UNDO them. This requires the old values (undo information) to be logged.
- No-force means committed changes might not be on disk at crash time, so recovery must be able to REDO them. This requires the new values (redo information) to be logged, and the log record must reach disk before commit is acknowledged.

The WAL rule that connects this back to the buffer pool: before a dirty data page is written to disk (a steal), the log records describing its changes must already be on disk. So the buffer manager and the log manager coordinate. A dirty data page cannot be flushed past its corresponding log record. This is why the engine wants to control flush ordering itself rather than let the OS flush whenever it likes. (Mohan et al., ARIES, ACM TODS 1992.)

## 4. Common exam traps and misconceptions

- "Pinning a page prevents other transactions from reading it." False. Pinning only prevents eviction. The CMU lecture is explicit: pinning does not prevent other transactions from accessing the page concurrently. Concurrency control (locks/latches) is a separate mechanism.
- "A dirty page is always written to disk immediately when modified." False. The buffer pool is write-back, not write-through. The dirty flag marks it for write-back on eviction or by the background writer; the write is deferred.
- "LRU is the optimal replacement policy." False. The optimal policy is Belady's MIN (evict the page used furthest in the future), which requires knowledge of future references and is only a theoretical bound. LRU is a heuristic and is beaten by LRU-K on database workloads.
- "CLOCK gives a different result from LRU, so it is a worse approximation of something else." Misleading. CLOCK is specifically an approximation of LRU using one reference bit per page instead of timestamps; it trades a little accuracy for far less metadata. It shares LRU's weaknesses (sequential flooding, frequency-blindness), not different ones.
- "For a one-pass sequential scan, LRU is the right choice." False. For a scan that never revisits pages, MRU (or a bounded ring) is better, because the most recently read scan page is the least likely to be needed again and should yield its frame. LRU would instead evict the hot working set.
- "LRU-K is just LFU (least frequently used)." False. The LRU-K paper stresses that LRU-K has built-in aging (it only considers the last K references and so adapts to changing patterns), whereas LFU cannot forget old popularity. They are different algorithms.
- "PostgreSQL uses LRU for its buffer pool." False. PostgreSQL uses a clock-sweep variant with a `usage_count` that saturates at `BM_MAX_USAGE_COUNT` (5), plus ring buffers for bulk operations.
- "Bigger `shared_buffers` is always better; set it to all your RAM." False. The PostgreSQL manual recommends ~25% and warns that above ~40% is unlikely to help, because PostgreSQL also uses the OS page cache and you would be double-buffering and starving that cache.
- "A negative `PRAGMA cache_size` is an error or means unlimited." False. In SQLite a negative N means a memory budget of about abs(N)*1024 bytes; the default is -2000 (~2MB). A positive N is a page count.
- "Recovery only needs the log to redo committed work." Incomplete. Under a steal policy you also need undo for uncommitted changes that reached disk. Steal forces UNDO capability; no-force forces REDO capability. Both are needed in ARIES.
- "Write-ahead logging means data pages are written before the log." Backwards. WAL writes the log record before the corresponding dirty data page is allowed to reach disk.
- "The page table and the page directory are the same thing." False. The page directory (on disk, persisted) maps page id to disk location; the page table (in memory, not persisted) maps page id to the cache frame currently holding it.

## 5. Good simulator ideas

1. Replacement-policy race on the same trace. Let the learner pick a buffer pool size (number of frames) and a reference string, either typed in or generated as "hot working set plus occasional sequential scan." Run OPT, LRU, CLOCK, and LRU-2 side by side on the same trace, animating the frames, reference bits / usage counts, and the clock hand, and tally hits and misses live. The payoff the learner should observe: LRU and CLOCK collapse when a scan is injected (sequential flooding), OPT is the unreachable floor, and LRU-2 keeps the hot set. Manipulated: pool size, trace, policy, scan length. Observed: hit ratio, which pages survive, the eviction each policy makes step by step.

2. PostgreSQL clock-sweep and ring-buffer sandbox. Show a circular array of frames each with a `usage_count` (0 to 5) and a pin flag, plus the `nextVictimBuffer` hand. The learner issues page accesses (which bump usage_count) and pins/unpins. They watch the hand sweep, decrement counts, and pick victims. Then toggle a "ring buffer for sequential scan" mode that confines a big scan to a 256KB-equivalent set of frames, and show the hot pages outside the ring staying put. Manipulated: access pattern, pin/unpin, ring on/off, ring size. Observed: which page is evicted, whether the working set survives a scan, the effect of the usage_count ceiling.

3. Steal/no-force and WAL ordering. A two-pane view: the buffer pool (frames with dirty flags, pin counts) and the on-disk log plus data file. The learner runs transactions that modify pages, then triggers an eviction or a commit, then a simulated crash. With steal+no-force the learner sees that an uncommitted dirty page can hit disk (so recovery must undo) and a committed page may still be in memory (so recovery must redo), and that flushing a dirty data page before its log record is refused by the WAL rule. Manipulated: steal/no-steal and force/no-force toggles, when to evict, when to crash. Observed: what is on disk at crash time, and which log records recovery needs to undo vs redo.

## 6. Citations

- CMU 15-445/645 Lecture #06, Buffer Pools (Fall 2024), Andy Pavlo. https://15445.courses.cs.cmu.edu/fall2024/notes/06-bufferpool.pdf . Primary source for: buffer pool definition, frames, page table vs page directory, pin/reference counter and dirty flag, LRU, CLOCK with reference bit, sequential flooding, LRU-K, localization and priority hints, background writing, prefetching, scan sharing, buffer pool bypass, and "why not use the OS." A Fall 2025 version of the same lecture exists at https://15445.courses.cs.cmu.edu/fall2025/notes/04-bufferpool.pdf .
- O'Neil, O'Neil, Weikum, "The LRU-K Page Replacement Algorithm for Database Disk Buffering," 1993 ACM SIGMOD. https://dl.acm.org/doi/10.1145/170035.170081 (ACM DL record); full PDF mirror at https://www.cs.cmu.edu/~natassa/courses/15-721/papers/p297-o_neil.pdf . Source for: Backward K-distance definition, LRU-2 vs LRU-1, the Correlated Reference Period, the frequency-blindness of LRU, the cache-swamping example, and the distinction from LFU.
- PostgreSQL source, `src/backend/storage/buffer/freelist.c`. https://github.com/postgres/postgres/blob/master/src/backend/storage/buffer/freelist.c . Source for: `StrategyGetBuffer`, `ClockSweepTick`, `nextVictimBuffer`, the free list, `GetAccessStrategy`, and ring sizes (256KB BULKREAD, 16MB BULKWRITE capped at 1/8 shared_buffers, VACUUM ring).
- PostgreSQL source, `src/backend/storage/buffer/README`. https://github.com/postgres/postgres/blob/master/src/backend/storage/buffer/README . Source for: the clock-sweep description, usage_count increment up to a limit on pin, the ring-buffer rationale ("blowing out the entire buffer cache"), and the L2-cache reasoning for the 256KB ring.
- PostgreSQL manual, Resource Consumption (current). https://www.postgresql.org/docs/current/runtime-config-resource.html . Source for: `shared_buffers` default 128MB and the 25% / 40%-of-RAM guidance with the OS-cache caveat, and `effective_io_concurrency` default 16 controlling concurrent I/O and prefetch distance.
- SQLite manual, PRAGMA statements. https://www.sqlite.org/pragma.html . Source for: `PRAGMA cache_size` positive (pages) vs negative (abs(N)*1024 bytes) semantics, default -2000 (~2MB), per-connection lifetime, and the separate `mmap_size` mechanism. SQLite's default page-cache module is `pcache1.c`; the application-defined cache interface is documented at https://www.sqlite.org/c3ref/pcache_methods2.html .

(Belady's MIN algorithm: L. A. Belady, "A study of replacement algorithms for a virtual-storage computer," IBM Systems Journal 5(2), 1966. ARIES steal/no-force recovery: C. Mohan et al., "ARIES: A Transaction Recovery Method...," ACM TODS 17(1), 1992. These are cited from standard literature, not fetched here.)

## 7. Glossary terms

- Buffer pool: an in-memory cache of disk pages, organized as an array of fixed-size frames, that lets the engine treat a larger-than-RAM database as if it were in memory.
- Frame: one fixed-size slot in the buffer pool that holds a single page plus its metadata.
- Page table: in-memory hash table mapping page id to the frame currently caching that page; not persisted.
- Page directory: on-disk, persisted mapping from page id to the page's location in the database files.
- Pin count (reference counter): number of threads currently using a page; a page with pin count greater than zero cannot be evicted.
- Dirty flag: per-frame bit indicating the page was modified in memory and must be written to disk before its frame is reused.
- Reference bit / usage count: per-frame recency signal set on access and cleared/decremented by the eviction scan; used by CLOCK-family policies.
- Write-back cache: a cache that buffers writes in memory and flushes them later, as opposed to write-through, which writes to disk on every mutation.
- Eviction (replacement): choosing an unpinned victim frame, writing it back if dirty, and reusing it for an incoming page.
- Belady's MIN (OPT): the optimal replacement policy; evicts the page whose next use is furthest in the future. Requires future knowledge, so it is a theoretical bound only.
- LRU (least recently used): evict the page with the oldest last-access time.
- CLOCK (second chance): an LRU approximation using a reference bit per page and a rotating hand that gives referenced pages a second chance before eviction.
- MRU (most recently used): evict the most recently accessed page; useful for one-pass scans that will not revisit pages.
- LRU-K: track the last K reference times per page and evict the page whose K-th most recent reference is furthest in the past (largest Backward K-distance); LRU-2 is the common choice.
- Backward K-distance: the distance back in the reference string to the K-th most recent reference to a page (infinity if seen fewer than K times); the LRU-K eviction key.
- Correlated Reference Period: a short time-out window within which multiple references to the same page (e.g. read then update in one transaction) are collapsed into one, so correlated accesses do not inflate a page's apparent popularity.
- Sequential flooding (cache swamping): pollution of the buffer pool by a large one-pass scan that evicts the hot working set under LRU/CLOCK.
- Prefetch / read-ahead: reading pages predicted to be needed (next scan blocks, next logical index leaf) before they are requested, overlapping I/O with computation.
- Scan sharing (synchronized scans): attaching a new query's scan to an in-progress scan of the same table so they share pages, wrapping around to complete.
- Buffer pool bypass: reading pages into query-local memory without inserting them into the shared pool, used for large one-shot reads and temporary data.
- shared_buffers: PostgreSQL's buffer pool size GUC; default 128MB, recommended ~25% of RAM, rarely useful above ~40%.
- Clock-sweep: PostgreSQL's CLOCK variant using a per-buffer usage_count (capped at BM_MAX_USAGE_COUNT = 5) and an atomic nextVictimBuffer hand.
- Ring buffer (BufferAccessStrategy): a small bounded set of frames PostgreSQL recycles for bulk reads, bulk writes, and VACUUM to avoid flooding the main pool.
- Steal policy: allows dirty pages of uncommitted transactions to be written to disk; requires UNDO capability in recovery.
- No-force policy: does not require a transaction's dirty pages to be flushed at commit; requires REDO capability in recovery.
- Write-ahead logging (WAL): the rule that a change's log record must reach disk before the corresponding dirty data page is written, making steal + no-force safe.
