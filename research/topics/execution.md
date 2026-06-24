# Query execution operators and joins (weeks 9-10)

Research note for the executor layer: the iterator model, the physical operators, the three join families, external sorting, aggregation, and where the pipeline must stop and materialize. Grounded in the Volcano paper, the CMU 15-445 join lecture, the PostgreSQL executor and docs, and the SQLite query planner docs. Cost numbers say where they come from.

## 1. The core problem

The optimizer hands the executor a tree of physical operators (a plan). The executor has to turn that tree into actual tuples. The naive approach is to fully compute each operator into a temporary table, then feed that whole table to the next operator. That is correct but it has two fatal costs.

The first cost is memory and IO. If every operator materializes its full output, a five operator plan over a billion row table writes and rereads the billion rows four times. You pay for intermediate results that nobody asked for.

The second cost is uniformity. A join operator should not need to know whether its input came from a sequential scan, an index scan, another join, or a sort. If each operator hard codes how it reads its children, you cannot freely compose or reorder operators, and you cannot add a new operator without touching the others.

The executor needs an abstraction where every operator looks the same from the outside (so they compose), and where tuples flow through without forcing a full materialization at every step (so memory and IO stay bounded). That abstraction is the iterator model, and the cases where it cannot avoid materialization are the pipeline breakers. The Volcano paper's contribution was exactly this: a single dataflow interface between operators so that operators and parallelism could be added without rewriting the engine (Graefe, IEEE TKDE 6(1), 1994).

The second hard problem inside this layer is the join. A join of R and S is conceptually the Cartesian product filtered by a predicate. Done literally that is |R| times |S| comparisons. For two million row tables that is 10^12 comparisons. The whole job of join algorithms is to avoid the product: use sortedness, use a hash table, or use an index, so that work drops from quadratic toward linear.

## 2. Mechanisms

### 2.1 The Volcano iterator model (pull based)

Every operator implements the same three function interface:

- `open()`: set up state, open children, allocate buffers or hash tables.
- `next()`: return the next tuple, or a null/end marker when exhausted.
- `close()`: release state, close children.

A plan is a tree of these operators. Execution is demand driven and top down: the consumer at the root calls `next()`, that call recurses down to the leaves, and one tuple bubbles back up per call. The PostgreSQL executor README states the contract plainly: "Each node, when called, will produce the next tuple in its output sequence, or NULL if no more tuples are available," and if a node is not a leaf scan "it will have child node(s) that it calls in turn to obtain input tuples." This is a pull model: parents pull from children, children never push.

Why this is the right abstraction:

- Composability. A join's `next()` just calls its children's `next()`. It does not care what the child is.
- Bounded memory for streaming operators. Filter, projection, and the probe side of a hash join hold one tuple at a time, not the whole input.
- Pipelining. A tuple can travel scan to filter to projection to join probe without ever being written to disk.

The cost of the pull model is one function call per operator per tuple. For a billion tuples that is billions of virtual calls, which is why modern analytic engines move to the alternatives below.

### 2.2 The push and vectorized alternatives

Two refinements attack the per tuple call overhead of pull.

Vectorized execution keeps the iterator interface but changes the unit. `next()` returns a batch of tuples (a vector, typically 1024 or 2048 values per column) instead of one tuple. The per call overhead is now amortized over a thousand tuples, and the inner loops over a column vector are tight and SIMD friendly. This is the MonetDB/X100 lineage and is standard in column stores.

Push based (data centric) execution inverts control flow: instead of a consumer pulling, a producer pushes tuples up to its parent's processing function. The compiler can then fuse a whole pipeline of operators into one tight loop with the tuple living in CPU registers, which is the basis of query compilation (the HyPer/LLVM approach). Pull is easier to reason about and to implement; push and vectorization win on raw throughput for scan heavy analytic queries.

For the exam, the key contrast: pull means the parent drives and asks the child; push means the child drives and hands tuples to the parent. Volcano is pull, one tuple per call.

### 2.3 Access and streaming operators

SeqScan reads every page of a heap in physical order. Cost is the number of pages, M. It is the universal fallback: PostgreSQL notes "a sequential scan plan is always created" so there is always at least one viable plan.

IndexScan walks an index (usually a B+ tree) to find matching keys, then for each match follows a pointer to fetch the heap tuple. It wins when the predicate is selective. It can lose badly when it is not, because each heap fetch is a potentially random IO; reading 60 percent of a table through an index can be slower than a sequential scan that reads it all in order. A variant, index only scan, answers the query from the index alone when the index covers all needed columns, skipping the heap fetch entirely.

Filter (selection) evaluates a predicate and drops tuples that fail. It is fully streaming: one tuple in, zero or one tuple out, O(1) state.

Projection drops or computes columns. Also streaming, O(1) state. Both Filter and Projection are pure pipeline members; they never need to see more than the current tuple.

### 2.4 Nested loop join

The naive form is two for loops: for each tuple of the outer R, scan all of inner S and compare. With M pages in R holding m tuples, and N pages in S:

- Naive nested loop cost: M + (m times N). (CMU 15-445 spring 2025 join notes, "Cost Analysis".)

The m times N term is the killer: you reread all of S once per outer tuple. The same CMU notes give a worked example with M = 1000, m = 100000, N = 500, B = 100 buffers, 0.1 ms per IO. Naive nested loop there is about 1.4 hours.

Block nested loop reads S once per outer block instead of per outer tuple. Give the outer scan B - 2 buffer frames (one frame holds an inner page, one holds output):

- Block nested loop cost: M + (ceil(M / (B - 2)) times N). (CMU 15-445, "Block Nested Loop Join".)

On the same example this drops to about 6.5 seconds. The lesson: the inner table is reread once per outer block, so making the block bigger (more buffers) directly cuts the rereads.

Index nested loop replaces the inner scan with an index probe. For each outer tuple, probe an index on S's join column at constant cost C:

- Index nested loop cost: M + (m times C). (CMU 15-445, "Index Nested Loop Join".)

This is excellent when S has an index on the join key and R is small or the join is selective. It is exactly the case PostgreSQL flags: nested loop "can be a good strategy" specifically "if the right relation can be scanned with an index scan" (PostgreSQL planner optimizer doc).

### 2.5 Sort-merge join

Sort both inputs on the join key, then walk two cursors forward in lockstep and emit matches, like the merge step of merge sort. Most keys are mostly unique so the merge is roughly M + N. The worst case is every tuple sharing one join value, where the merge degrades to M times N because each outer page must rescan the whole inner table for that value (CMU 15-445, "Sort-Merge Join").

- Sort cost of R with B buffers: 2M times (1 + ceil(log_{B-1}(M / B))).
- Sort cost of S: 2N times (1 + ceil(log_{B-1}(N / B))).
- Merge cost: M + N.
- Total: sort + merge.

On the CMU example the sort costs are R = 4000 and S = 2000 IOs, and the whole join is about 0.75 seconds.

When sortedness is reused: if an input already arrives sorted on the join key (for example from a clustered index scan, or because an earlier sort-merge or an ORDER BY already sorted it), that input's sort cost is zero and you keep only the M + N merge. Merge join is also attractive when the query needs the output sorted on the join key anyway, because the join hands the sort order to the next operator for free. PostgreSQL describes it as each relation sorted on the join attributes then "scanned in parallel," noting "each relation has to be scanned only once" (planner optimizer doc).

### 2.6 Hash join (build and probe, grace and partitioned)

In memory hash join has two phases. Build: scan the smaller (build) input and insert each tuple into a hash table keyed on the join attribute. Probe: scan the larger (probe) input, hash each tuple, and look up matches in the hash table, re-checking the actual join values because hash buckets can collide. Cost is roughly M + N when the build side fits in memory. On the CMU example, about 0.45 seconds, the fastest of the lot.

Two hard constraints from the CMU notes:

- Hash join works only for equi-joins on the full join key. There is no hash that turns `R.a < S.b` into bucket equality, so range and inequality joins fall back to nested loop or merge.
- You build on the smaller input so the hash table is more likely to fit in memory.

Grace / partitioned hash join handles the build side not fitting in memory. Phase 1, partition: hash both inputs with h1 into the same set of partitions written to disk, so that R partition i can only match S partition i. Phase 2, probe: for each partition pair, build a hash table on the smaller side and probe with the other. If a single partition still does not fit, recursively repartition it with a different hash function h2 (h2 not equal to h1) until it does.

- Partition phase cost: 2 times (M + N) (read once, write once).
- Probe phase cost: M + N.
- Total grace hash join cost: 3 times (M + N). (CMU 15-445, "Grace Hash Join / Partitioned Hash Join".)

Hybrid hash join (the form PostgreSQL implements) keeps one partition resident in memory and probes it immediately instead of spilling it, blending in memory and grace behavior. The edge case the CMU notes call out: if one join key has so many matching rows that they alone overflow memory, no hash repartition helps (they all hash identically), so fall back to a block nested loop for that key to trade random IO for sequential.

### 2.7 External merge sort

When data to sort exceeds memory you cannot sort in place. External merge sort has two parts.

Run generation (pass 0): read the input B pages at a time, sort each chunk in memory, write it out as a sorted run. This produces ceil(file_size / B) sorted runs.

Multi-way merge: merge runs B - 1 at a time (one input buffer per run, one output buffer), repeatedly, until one run remains. Each merge pass reduces the run count by a factor of B - 1.

The total number of passes and IO, for N pages and B buffers (CMU 15-445 and standard texts):

- Passes = 1 + ceil(log_{B-1}(ceil(N / B))).
- Total IO = 2N times (passes), because every pass reads and writes all N pages.

The "1 +" is run generation; the log term is the merge passes. Two takeaways: more buffers cut passes logarithmically (a bigger merge fan-in), and a single pass only happens when the data already fits in B pages. Two-pass sort is the common case and works whenever the number of initial runs is at most B - 1.

### 2.8 Hash aggregation versus sort-based aggregation

To compute GROUP BY (or DISTINCT) you must bring equal keys together.

Sort-based: sort on the grouping key, then scan once and break into groups whenever the key changes. State is one running group at a time. Output comes out sorted on the key, which is free if the next operator wants that order. Cost is dominated by the external sort.

Hash-based: build a hash table keyed on the grouping key; each incoming tuple updates its group's running aggregate state in place. State is one entry per distinct group, so it is cheap when there are few groups and expensive (or it must spill) when there are many. Output is in no particular order. When the hash table exceeds the memory budget, a disk-based hash aggregation spills overflow groups to per-partition files and processes them in extra passes, mirroring grace hash join.

Rule of thumb: hash aggregation wins when the number of distinct groups is small relative to the input; sort aggregation wins when the input is already sorted on the group key or the output needs to be sorted anyway.

### 2.9 Pipelining versus materialization (pipeline breakers)

A pipelined operator emits output tuples as it consumes input, holding O(1) or small bounded state: Filter, Projection, the probe phase of hash join, merge join's merge step, index nested loop.

A pipeline breaker must consume its entire input before it can emit its first output tuple. The classic breakers:

- Sort: cannot know the first sorted tuple until it has seen the last input tuple.
- The build side of a hash join: the hash table must be fully built before any probe can match.
- Hash and sort aggregation, and DISTINCT: the last input tuple might belong to the first group.

Breakers force materialization and set the memory budget for the query, because that is where a whole input (or a hash table, or sorted runs) has to live. They are also the natural points where work_mem limits bite and spilling to disk begins.

## 3. How real systems do it

### 3.1 PostgreSQL

PostgreSQL is a textbook pull-based Volcano executor. A plan is a tree of `Plan` nodes; at execution each becomes a `PlanState`. `ExecInitNode` recursively initializes the tree (the `open` step), `ExecProcNode` pulls the next tuple from a node (the `next` step), and `ExecEndNode` tears down (the `close` step). Tuples travel between operators in a `TupleTableSlot`. The dispatch in `execProcnode.c` is a switch over node types that returns a `TupleTableSlot`, one tuple per call, exactly the iterator contract.

Operators map to node types: `SeqScan`, `IndexScan` and `IndexOnlyScan`, plus the three joins PostgreSQL exposes and explicitly documents: nested loop, merge join, hash join (planner optimizer doc). The hash join (`nodeHashjoin.c`, with the hash table in `nodeHash.c`) is a hybrid hash join in the Zeller/Gray lineage: if the build side does not fit it splits into batches, each batch spilled to temporary files, and probe tuples are routed to the matching batch.

Memory is governed by `work_mem`: per the docs it is "the base maximum amount of memory to be used by a query operation (such as a sort or hash table) before writing to temporary disk files," default 4MB, and it is per operator per session, so one query with several sorts and hashes can use many multiples of it. Hash operations get `work_mem` times `hash_mem_multiplier` (default 2.0, so 8MB by default) because, as the docs put it, they are "more sensitive to memory availability than equivalent sort-based operations." Sorts above the budget become external merge sorts; `EXPLAIN ANALYZE` shows whether a Sort node ran "Memory" or "Disk".

Aggregation has both shapes: `GroupAggregate` (sort based, input pre-sorted) and `HashAggregate` (hash table keyed on the group). Since version 13, hash aggregation can spill to disk when the groups exceed the hash memory limit, via the spill machinery in `nodeAgg.c` (`hashagg_spill_init`, `hashagg_spill_tuple`, `hash_agg_set_limits`); before 13 a misestimated HashAgg could overrun memory rather than spill.

### 3.2 SQLite

SQLite compiles each statement to bytecode for a virtual machine (the VDBE); the executor is that bytecode interpreter, not a tree of C++ operator objects. Joins are uniform: "SQLite implements joins as nested loops," with the outer table from the left of FROM and the inner on the right, one nesting level per joined table (optoverview.html). There is no hash join and no merge join in SQLite; an index on the inner table turns the inner loop into an index nested loop, which is how SQLite makes joins fast.

Because the only join is nested loop, the join order is the whole game. SQLite uses "an efficient polynomial-time graph algorithm" for join ordering and can "plan queries with 50- or 60-way joins in a matter of microseconds" (optoverview.html; the cost model is the Next Generation Query Planner). A programmer can pin the order: "SQLite chooses to never reorder tables in a CROSS JOIN," so writing CROSS JOIN forces the nesting.

SQLite avoids separate sort and aggregation operators when an index already supplies order. It "attempts to use an index to satisfy the ORDER BY clause," and for GROUP BY and DISTINCT, if the nested loops arrange equal rows to be consecutive, it decides group membership and distinctness "simply by comparing the current row to the previous row" (optoverview.html). That is sort-based grouping with the sort supplied for free by an index.

## 4. Common exam traps and misconceptions

- "The Volcano model pushes tuples from producers up to consumers." False. Volcano is pull/demand driven: the consumer calls `next()`, the producer responds. Push is the opposite control flow and is the alternative model, not Volcano.
- "Hash join can do any join condition." False. Hash join is restricted to equi-joins on the full join key. Range or inequality joins cannot be hashed and use nested loop or merge.
- "You build the hash table on the larger relation." False. You build on the smaller relation so the hash table is more likely to fit in memory; you probe with the larger one.
- "Grace hash join costs the same as nested loop because both spill to disk." False. Grace hash join is 3 times (M + N), linear. Naive nested loop is M + m times N, effectively quadratic. CMU's worked example shows 0.45 s for hash join versus about 1.4 hours for naive nested loop.
- "Sort-merge join always has to sort both inputs." False. If an input already arrives sorted on the join key (clustered index, prior sort), that sort cost is zero and only the M + N merge remains.
- "Block nested loop rereads the inner table once per outer tuple." False. That is the naive form. Block nested loop rereads the inner once per outer block, which is why more buffer frames cut its cost.
- "An index scan is always faster than a sequential scan." False. For low selectivity predicates the random heap fetches per match make an index scan slower than a single ordered sequential pass. PostgreSQL always keeps a SeqScan plan available for this reason.
- "External merge sort is one pass." Usually false. It is 1 + ceil(log_{B-1}(ceil(N / B))) passes. One pass only when the data fits in B pages; two passes is the common realistic case.
- "Sort is a pipelined operator, it streams tuples through." False. Sort is a pipeline breaker: it must read all input before emitting the first output tuple. So is the build side of a hash join.
- "Projection and Filter need to buffer the whole input." False. Both are streaming, O(1) state, one tuple at a time.
- "SQLite uses hash joins for big joins." False. SQLite only ever does nested loop joins; it makes them fast with indexes and good join ordering.
- "Hash aggregation output is sorted by the group key." False. Hash aggregation output is in no particular order; sort-based aggregation is the one that comes out sorted.

## 5. Good simulator ideas

### 5.1 Single-tuple iterator stepper

Show a small plan tree (SeqScan, Filter, Projection, then a Join) over two tiny tables. The learner clicks "next" at the root and watches one `next()` call propagate down to a leaf and one tuple bubble back up, with each operator's held state highlighted (current cursor, current probe tuple). A counter tallies `next()` calls per operator. The learner observes that Filter and Projection hold one tuple while the hash join's build side has to fill its whole table before the first probe emits anything. This makes pull direction and pipeline breakers visible rather than asserted.

### 5.2 Join algorithm cost playground

Let the learner set M, m, N, n, the number of buffer frames B, and per-IO time, then pick a join algorithm (naive NL, block NL, index NL, sort-merge, grace hash). The simulator computes and displays the IO cost using the exact formulas (M + m times N; M + ceil(M/(B-2)) times N; M + m times C; sort + merge; 3 times (M + N)) and an estimated wall time, and draws a bar chart comparing all five at the current settings. Sliders that matter: dragging B up should visibly cut block nested loop and the sort passes; making the join selective should make index nested loop win; making the build side bigger than memory should flip in-memory hash join to grace and add the partition pass.

### 5.3 External merge sort pass visualizer

The learner sets the number of data pages N and buffer pages B and watches run generation produce ceil(N/B) sorted runs, then watches merge passes combine B - 1 runs at a time until one run remains, with a live pass counter and total IO counter. The display should make the formula 1 + ceil(log_{B-1}(ceil(N/B))) emerge from the animation, and increasing B should visibly reduce the number of merge passes. A toggle to "feed this sorted output into a merge join" connects external sort to sort-merge join and to sortedness reuse.

## 6. Citations

- Graefe, G. "Volcano, an Extensible and Parallel Query Evaluation System," IEEE TKDE 6(1), 1994, https://doi.org/10.1109/69.273032 . The origin of the open/next/close iterator interface and the dataflow model that lets operators and parallelism compose. Open access PDF mirror: https://cs-people.bu.edu/mathan/reading-groups/papers-classics/volcano.pdf .
- CMU 15-445/645, Lecture 12 Join Algorithms (Spring 2025), https://15445.courses.cs.cmu.edu/spring2025/notes/12-joins.pdf . Source of the exact IO cost formulas (naive M + m·N, block M + ceil(M/(B-2))·N, index M + m·C, sort-merge sort+M+N, grace 3·(M+N)) and the worked timing example (M=1000, m=100000, N=500, B=100, 0.1 ms/IO).
- PostgreSQL, "Planner/Optimizer," https://www.postgresql.org/docs/current/planner-optimizer.html . The three join strategies (nested loop, merge join, hash join), the scan types, and that a sequential scan plan always exists.
- PostgreSQL executor README, https://github.com/postgres/postgres/blob/master/src/backend/executor/README . States the pull/demand model: each node returns the next tuple or NULL, and non-leaf nodes call their children for input.
- PostgreSQL, "Resource Consumption" (work_mem, hash_mem_multiplier), https://www.postgresql.org/docs/current/runtime-config-resource.html . Definition of work_mem as the per-operation memory before spilling, default 4MB, and hash_mem_multiplier default 2.0 for hash operations.
- PostgreSQL source, nodeHashjoin.c, https://doxygen.postgresql.org/nodeHashjoin_8c_source.html , and nodeAgg.c, https://doxygen.postgresql.org/nodeAgg_8c.html . Hybrid/batched hash join implementation and the version 13 disk-based hash aggregation spill machinery.
- SQLite, "The SQLite Query Optimizer Overview," https://sqlite.org/optoverview.html . That SQLite implements joins as nested loops only, uses a polynomial-time join ordering algorithm, never reorders CROSS JOIN, and uses indexes to satisfy ORDER BY, GROUP BY, and DISTINCT.

## 7. Glossary terms

- Iterator (Volcano) model: execution where every operator exposes open/next/close and tuples are pulled one at a time from the root down to the leaves.
- Pull-based execution: the consumer requests the next tuple from the producer; control flows down, tuples flow up. The Volcano default.
- Push-based execution: the producer hands tuples to its parent's processing function; the basis of query compilation and operator fusion.
- Vectorized execution: an iterator that returns a batch (vector) of tuples per next() call to amortize per-call overhead and enable SIMD.
- SeqScan: an operator that reads every heap page in physical order; cost M pages; the universal fallback plan.
- IndexScan: an operator that walks an index to find matching keys then fetches the heap tuples; fast when selective, slow when not.
- Index-only scan: an index scan that answers from the index alone because it covers all needed columns, skipping the heap fetch.
- Filter (selection): a streaming operator that drops tuples failing a predicate; O(1) state.
- Projection: a streaming operator that drops or computes output columns; O(1) state.
- Naive nested loop join: for each outer tuple scan the whole inner table; cost M + m·N, effectively quadratic.
- Block nested loop join: for each outer block scan the whole inner table; cost M + ceil(M/(B-2))·N.
- Index nested loop join: for each outer tuple probe an index on the inner join key; cost M + m·C.
- Sort-merge join: sort both inputs on the join key then merge with two cursors; cost sort + (M+N); reuses existing sortedness.
- Hash join: build a hash table on the smaller input's join key, then probe with the larger; equi-joins only; in-memory cost about M+N.
- Build phase / probe phase: building the hash table from the smaller relation, then scanning the larger relation to look up matches.
- Grace (partitioned) hash join: hash both inputs into matching disk partitions, then join partition by partition; cost 3·(M+N); recursively repartitions a partition that still does not fit.
- Hybrid hash join: grace hash join that keeps one partition resident in memory and probes it directly instead of spilling; PostgreSQL's implementation.
- External merge sort: sort larger-than-memory data by generating sorted runs then multi-way merging; passes = 1 + ceil(log_{B-1}(ceil(N/B))), IO = 2N·passes.
- Run generation: pass 0 of external sort that reads B pages, sorts them in memory, and writes a sorted run.
- Multi-way merge: a pass that merges B-1 sorted runs at once using one buffer per run plus an output buffer.
- Hash aggregation: GROUP BY/DISTINCT via a hash table keyed on the group key, updating aggregate state per group; spills to disk when groups exceed memory.
- Sort-based aggregation: GROUP BY/DISTINCT by sorting on the group key then scanning and breaking on key changes; output comes out sorted.
- Pipelining: passing output tuples to the next operator as they are produced, holding small bounded state.
- Materialization: computing and storing an operator's full output before the next operator consumes it.
- Pipeline breaker: an operator that must consume all input before emitting any output (sort, hash table build, aggregation, DISTINCT).
- work_mem: PostgreSQL's per-operation memory budget before a sort or hash spills to temporary disk files (default 4MB).
- hash_mem_multiplier: PostgreSQL multiplier on work_mem for hash operations (default 2.0).
- TupleTableSlot: the PostgreSQL structure that carries a tuple between executor operators.
- VDBE: SQLite's bytecode virtual machine; the interpreter that runs the compiled query program.
