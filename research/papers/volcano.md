# Volcano: An Extensible and Parallel Query Evaluation System (Graefe, 1994)

Citation: Goetz Graefe, "Volcano: An Extensible and Parallel Query Evaluation System," IEEE Transactions on Knowledge and Data Engineering, Vol. 6, No. 1, February 1994, pp. 120-135. IEEE Log Number 9211308. DOI: 10.1109/69.273032 (https://doi.org/10.1109/69.273032). The work was done at the Oregon Graduate Institute and the University of Colorado at Boulder.

## What problem this paper solves and why it mattered

Before Volcano, query execution research forced a choice between two things that did not combine well. Systems built for parallelism (notably GAMMA) gave each operator its own process and relied on the operating system and network to synchronize producers and consumers with flow control, which works on a multiprocessor but cannot run inside one process without thread or pseudo-process machinery (Section II, "Related Work"). Systems built for single-process efficiency and extensibility (System R, Starburst, the E language in EXODUS) used the demand-driven iterator paradigm but had not combined it with parallelism (Section II). Graefe's contribution is a single dataflow query execution engine in which every algebra operator implements one uniform open-next-close iterator interface, all data-item semantics (predicates, hashing, comparison, projection) are imported as support functions, and all parallelism is confined to one operator, exchange. The payoff stated in the abstract and Section VII is that data manipulation and parallelism become orthogonal: an operator written and debugged in a single process can be parallelized just by inserting exchange into the plan, with no change to the operator. The paper claims Volcano is "the first implemented query execution engine that effectively combines extensibility and parallelism" (Abstract).

## The core mechanism

### Iterators and the open-next-close protocol (Section III.B)

Every algebra operator is implemented as an iterator that supports three procedures: open, next, and close. The paper frames this as providing "the iteration component of a loop, i.e., initialization, increment, loop termination condition, and final housekeeping" (Section III.B). Iteration over an operator's result looks the same as iteration over a file scan, which is the unifying idea.

Each iterator has an associated state record. The state record holds both arguments (for example the size of a hash table to allocate in open) and runtime state (for example the location of that hash table). A key invariant is stated explicitly: "All state information of an iterator is kept in its state record and there are no static variables; thus, an algorithm may be used multiple times in a query by including more than one state record" (Section III.B). This is what lets the same operator code (say, sort) appear several times in one plan.

Operators are composed by linking state records through input pointers, which are themselves stored in the state records. The protocol drives the whole tree top-down by control and bottom-up by data:

- open on the top operator instantiates its state (e.g., allocates a hash table) and recursively calls open on all of its inputs, so "all iterators in a query are initiated recursively" (Section III.B).
- next on the top operator is called repeatedly until it returns an end-of-stream indicator. An operator calls next on its input only when it needs more input to produce an output record (Section III.B). This is demand-driven, lazy evaluation.
- close recursively shuts down all iterators (Section III.B).

Because an operator never learns what kind of operator feeds it, the inputs are called anonymous inputs or streams. Graefe names two cornerstones of extensibility: the split of operators into algorithm shells plus support functions, and the stream abstraction that lets any operators be combined (Section III.B). The text states that iterators plus streams are "the most efficient execution model in terms of time (overhead for synchronizing operators) and space (number of records that must reside in memory concurrently) for single-process query evaluation" (Section III.B).

### Support functions (Introduction; Section III.A; Section IV)

Volcano's iterators are "empty algorithm shells that cannot perform any useful work" without support functions (Section III.B). A support function is passed as a function entry point plus a typeless pointer argument. The argument serves two execution styles with one mechanism: in compiled execution the argument carries a constant or pointer to constants (e.g., the search string for a comparison), and in interpreted execution the function entry point is the interpreter and the argument carries code for it to evaluate (Section III.A, "selective scans" example). Because all interpretation of data items is imported this way, Volcano has no type system for instances and is data-model independent; adding a new abstract data type "does not affect the Volcano software at all" (Section IV).

### Record passing and buffer ownership (Section III.B)

next returns a status indicator plus a Next-Record structure (an RID and a record address in the buffer pool), and the record is pinned in the buffer. The ownership invariant is: "Each record pinned in the buffer is owned by exactly one operator at any point in time." After receiving a record an operator may hold it (e.g., in a hash table), unfix it (e.g., when a predicate fails), or pass it on. Operators that build new records (such as join) must fix their output and unfix their inputs (Section III.B). To avoid one buffer call per record, the buffer interface was redesigned to need two buffer calls per cluster on the producer side and one per cluster on the consumer side, independent of how many records a cluster holds (Section III.B). Volcano deliberately does not use temporary files between operators; intermediate results live on virtual devices whose pages exist only in the buffer and vanish when unpinned (Section III.A, Section III.B).

### The operator set: scans, filter, functional join, one-to-one match (Section III.B.1 to III.B.3)

- File scan and B+-tree scan iterators are leaf operators; they wrap the file-system scans and carry an optional predicate (and bounds for B+-tree) in the state record (Section III.B.1).
- Functional join performs the RID lookup that retrieves data records for B+-tree leaf entries; index search and record retrieval are kept separate operators deliberately (Section III.B.1).
- Filter is a versatile single-input single-output operator with three optional support functions: a predicate function (selection), a transform function (projection without duplicate elimination, compression, code changes), and an apply function called once per record for side effects (updates, printing). It is also called the side-effect operator, and it makes plans serve as update plans, not just retrieval plans (Section III.B.1).
- One-to-one match is a single physical operator that realizes join, semi-join, outer join, anti-join, intersection, union, difference, anti-difference, aggregation, and duplicate elimination. The unifying principle (Fig. 3) is separating matching and non-matching subsets of two inputs R and S, where unary operations compare items of the same input and binary operations compare items of two inputs (Section III.B.2). There are two implementations: hybrid hash and sort-based merge join. For the hash version the three phases (build, probe, flush, where flush is Graefe's addition for aggregation) map onto open (build) and next (probe then flush); successive next calls switch automatically from probe to flush when the second input is exhausted (Section III.B.2).
- One-to-many match compares each item with many others; relational division is the example, with a native (sort-based) version and a hash-division version (Section III.B.3).

### Hybrid hash overflow management (Section III.B.2)

The hash one-to-one match handles inputs larger than memory with two controls in the state record: a packing threshold and a spilling threshold. The hash table points directly into buffer-resident records (no copying). When item count reaches the packing threshold, items are packed densely into overflow files but not yet written. When it reaches the spilling threshold, the first partition file is unfixed and written to disk, and the count is reduced; the cycle repeats and partitioning recurses with adjusted thresholds. Spilled-bucket portions of the table are reused for bit-vector filtering to save I/O. Setting both thresholds to zero gives Grace-style overflow avoidance (Section III.B.2). This is the concrete example of "mechanism, not policy": an optimizer sets thresholds based on estimated input-size distributions.

### Dynamic plans and the choose-plan meta-operator (Section V)

choose-plan is a meta-operator: it provides control, not data manipulation. It exposes the same open-next-close protocol, so it can be inserted anywhere. Its open calls a support function (passed the bindings parameter) to pick one of several equivalent subplans, then opens that subplan; next and close just forward to the chosen input (Section V). One choose-plan at the top of a plan gives a multiplan access module; several give a full dynamic plan. The decision can depend on bindings for query variables, on resource and contention state, or on user priority (Section V). The motivating case is an embedded query whose predicate constant is a program variable unknown at compile time (Fig. 4: choose between file scan and index scan plus functional join).

### Parallelism: the exchange meta-operator (Section VI)

Parallelism is "relatively easy to exploit" because queries are trees of operators that can run in separate processes connected by pipelines (inter-operator parallelism), and each operator consumes and produces sets that can be partitioned into disjoint subsets (intra-operator parallelism) (Section VI). Graefe calls his approach the operator model of parallelization: all parallelism is localized in one operator, exchange, which uses and provides the standard iterator interface to operators above and below it (Section VI). Exchange is itself an iterator with open, next, and close, so it can be placed at one or many points in a tree.

- Vertical parallelism / pipelining (Section VI.A): exchange.open creates a shared-memory data structure called a port for synchronization and data exchange, then forks a child process that is an exact duplicate of the parent. The parent is the consumer, the child is the producer. In the consumer, exchange acts as a normal iterator except its input arrives by inter-process communication rather than procedure calls. In the producer, exchange becomes the driver, calling open-next-close on the subtree below it and collecting next output into packets (arrays of Next-Record structures, size set between 1 and 32000 records in the state record). A filled packet is linked into the port and a semaphore signals the consumer.
- Dataflow paradigm switch (Section VI.A): all operators except exchange use demand-driven dataflow (lazy). Between processes exchange uses data-driven dataflow (eager) so it does not need request messages and so it composes well with partitioning. Exchange performs the translation between demand-driven dataflow within a process and data-driven dataflow between processes (Abstract, Section VI.A, Section VII).
- Flow control (Section VI.A): an optional run-time switch adds a flow-control semaphore (back pressure). A producer requests the semaphore after inserting a packet; a consumer releases it after removing a packet; the semaphore's initial value bounds how far producers may run ahead. The paper stresses that flow control is not the same as demand-driven dataflow: flow control allows slack and genuinely overlapped execution, whereas demand-driven dataflow is a rigid request-and-deliver structure in which the consumer waits while the producer makes its next output (Section VI.A).
- Horizontal parallelism (Section VI.B): two forms. Bushy parallelism runs different subtrees on different CPUs (a form of inter-operator parallelism with vertical parallelism). Intra-operator parallelism runs the same operator over different subsets, which requires data partitioning. Stored data is partitioned by using multiple files on different devices; intermediate results are partitioned by including multiple queues in a port, one per consumer process. A producer uses a partitioning support function to choose the destination queue, which allows round-robin, key-range, or hash partitioning (Section VI.B). The degree of parallelism is just an argument in the exchange state record (set to 2 or 3 in Fig. 7).
- Self-scheduling (Section VI.B): one process of a group is the master. The master forks the others, after which producers run without further synchronization except short-term locks on shared structures and a double synchronization when a group is both producer and consumer. Close propagates down through exchange operators and shuts the tree down in order, so the whole evaluation is self-scheduling.
- Variants (Section VI.C): exchange can broadcast or replicate a stream to all consumers (for fragment-and-replicate joins and hash-division), needing only extra pins on shared-buffer records rather than copies. A merge iterator (derived from sort) needed exchange to keep input records separated by producer, communicated by a third argument to next-exchange. The interchange variant lets exchange live in the middle of a process tree without forking: on next it requests records from its input, possibly sending them to other processes, until it finds a record for its own partition; this also makes flow control obsolete because a process produces for others only when it has nothing for its own consumer (Section VI.C).
- File-system changes for parallelism (Section VI.D): the buffer manager uses a two-level locking scheme, one lock per buffer pool (held only while searching or updating hash tables and chains, never during I/O) and one lock per descriptor (held during I/O or descriptor update). A found cluster is locked with an atomic test-and-lock; on failure the pool lock is released and the operation restarts (including the hash lookup). This restart scheme prevents the hold-and-wait deadlock condition; starvation is theoretically possible but made extremely unlikely after contention was reduced (Section VI.D).

## Key facts and figures

- Published in IEEE TKDE Vol. 6, No. 1, February 1994, pp. 120-135 (front matter). The encapsulation-of-parallelism ideas first appeared in the 1990 SIGMOD paper [20]; dynamic plans in the 1989 SIGMOD paper [17].
- Volcano is roughly two dozen modules and about 15000 lines of C code (Section III).
- Two layers: a file-system layer (records, files, B+-trees, scans, buffering) and a query-processing layer of nestable iterators (Section III, Fig. 1).
- Every operator is an iterator with open, next, close; the only exception is exchange's data-driven inter-process behavior (Abstract, Sections III.B and VI.A).
- State records hold all per-instance state; no static variables, which is what allows one algorithm to appear multiple times in a plan (Section III.B).
- File scans support open, next, close, rewind; next returns a pinned main-memory address, and staying within a cluster avoids buffer-manager calls (Section III.A).
- Buffer interface cost after redesign: two buffer calls per cluster on the producer side, one per cluster on the consumer side, regardless of records per cluster (Section III.B).
- One-to-one match implements join, semi-join, all three outer joins, anti-join, intersection, union, difference, anti-difference, aggregation, and duplicate elimination in one module (Section III.B.2, Section VII).
- Only two matching algorithm families are implemented, hybrid hash and sort-based merge join, to study the sort/hash duality (Section III.B.2).
- Hash overflow is controlled by packing and spilling thresholds; both set to zero gives Grace-style overflow avoidance (Section III.B.2).
- Packet size for exchange ranges from 1 to 32000 records (Section VI.A).
- Two meta-operators: choose-plan (dynamic plans, Section V) and exchange (parallelism, Section VI). Meta-operators provide control, not data manipulation.
- Exchange implements three parallelism forms in one module: vertical (pipelining), bushy, and intra-operator (Section VI, Section VII).
- Demand-driven dataflow within a process; data-driven dataflow between processes; exchange translates between them (Abstract, Section VII).
- Reported speedup of 14.9 on 16 CPUs for parallel sorting on a shared-memory machine, from reference [18] (Section VII).
- Exchange in this paper supports shared-memory only; distributed-memory and hierarchical (clusters of shared-memory nodes) are stated as future work (Section VI intro, Section VII).
- Volcano lacks a query language, an instance type system, a query optimizer, and catalogs; it is an experimental engine, not a complete DBMS (Introduction, Section IV).

## Trade-offs and limitations

- Records are fully materialized and copied between operators (join copies fields into new records). The paper acknowledges this can be argued to be "prohibitively expensive" and notes the alternative of composing Next-Record tuples (RID-pointer lists) is achievable via the filter iterator but is not implemented as a default (Section III.B).
- Demand-driven dataflow is rigid: the consumer blocks while the producer computes the next record, with no overlap. Overlap requires the data-driven path through exchange plus optional flow control (Section VI.A).
- No type system or type checking for support functions; Volcano assumes plans and support functions are already correct and pushes correctness to a higher level (Section IV). This is a deliberate scope cut, not a feature.
- Parallelism in this paper is shared-memory only; near-linear speedup was observed for limited degrees of parallelism (14.9 on 16 CPUs), not unbounded scaling (Section VII).
- Horizontal partitioning has a structural limit: data transfer between two joins in the same process group stays within the process, so partitioning-based parallel joins on different attributes are infeasible without the interchange variant (Section VI.B, VI.C).
- Single-user, no inter-query parallelism, and no transaction or recovery semantics; these are listed as desired future extensions (Section VII).
- Modules are not yet fail-fast / all-or-nothing; error encapsulation is noted as future work and flagged as tricky for exchange, especially in distributed memory (Section VII).
- File and record protection is minimal under concurrency (only each disk's volume table of contents is protected), and non-repetitive actions like device mounting must be done by the root process outside parallel evaluation (Section VI.D).

## How it maps to the course

Grounds Weeks 9 and 10.

- Week 9 (query execution model): the open-next-close iterator protocol, demand-driven (pull) dataflow, anonymous streams, the algorithm-shell plus support-function split, state records and buffer ownership. The course operators map directly to Volcano operators. SeqScan is the file-scan iterator (Section III.B.1). Filter is the filter operator's predicate function, and Project is the filter operator's transform function, so a lesson should note that Volcano fuses selection, projection, and side effects into one operator (Section III.B.1). Join is the one-to-one match operator (sort-merge and hybrid hash variants), with the build/probe/flush phases mapped onto open and next (Section III.B.2). Use this paper to justify why one uniform interface lets all four operators nest without knowing each other's identity.
- Week 10 (parallel and extensible execution): the exchange meta-operator, the operator model of parallelization, vertical/bushy/intra-operator parallelism, partitioning by support function, the demand-driven to data-driven translation, flow control versus pull, and self-scheduling. Also choose-plan and dynamic query evaluation plans for the late-binding/optimization-at-runtime topic. Use this paper to argue the orthogonality claim: parallelize an operator by inserting exchange, with zero changes to the operator.

Any lesson that introduces the iterator/Volcano model, pull-based execution, or the exchange operator should cite this paper as the primary source.

## Viva question bank

1. Q: What are the three procedures of the iterator interface and what does each do?
   A: open, next, and close. open initializes operator state (for example allocates a hash table) and recursively opens all inputs. next produces and returns one result record at a time, calling next on inputs only when more input is needed, and signals end-of-stream when exhausted. close releases resources and recursively shuts down the inputs (Section III.B).

2. Q: Why does demand-driven (pull) dataflow matter, and who initiates the work?
   A: The consumer pulls: the root operator's next is called repeatedly, and each operator calls next on its input only when it needs another record. This is lazy evaluation, so an operator never produces more than the consumer demands, which the paper says minimizes both time overhead (operator synchronization) and space (records resident in memory at once) for single-process execution (Section III.B).

3. Q: Why must every operator share exactly one interface? What does that buy?
   A: Because an operator only ever calls open-next-close on its input, it never needs to know what produces that input (anonymous streams). This lets any operators nest in any combination, lets new operators be added without touching existing ones, and lets exchange be inserted anywhere to add parallelism. Uniformity is the basis of both extensibility and the orthogonality of data manipulation and parallelism (Sections III.B, IV, VI).

4. Q: What is a support function and why is it the key to data-model independence?
   A: A support function is an imported function entry point plus a typeless argument that performs all item-level work (predicates, hashing, comparison, projection, side effects). Volcano's iterators are empty shells without them. Because all interpretation of data items is imported, Volcano needs no instance type system and works for any data type or model, which is why a new abstract data type does not change the Volcano code at all (Introduction, Section III.A, Section IV).

5. Q: What is a state record and why can the same operator appear multiple times in one plan?
   A: A state record holds an iterator instance's arguments and runtime state, and operators are linked by input pointers stored in state records. Because all state lives in the state record and there are no static variables, an algorithm such as sort can be instantiated several times in one query by giving each occurrence its own state record (Section III.B).

6. Q: How do SeqScan, Filter, Project, and Join in the course map onto Volcano operators?
   A: SeqScan is the file-scan iterator. Filter is the filter operator's predicate function and Project is its transform function, so Volcano fuses selection, projection, and side-effect/apply into one filter operator. Join is the one-to-one match operator, with hybrid hash and sort-merge implementations whose build/probe/flush phases map onto open (build) and next (probe then flush) (Sections III.B.1, III.B.2).

7. Q: Why is one-to-one match a single operator for so many logical operations?
   A: All of join, semi-join, outer joins, anti-join, intersection, union, difference, anti-difference, aggregation, and duplicate elimination reduce to the same step: separate the matching and non-matching subsets of two inputs and emit selected subsets, possibly transformed (Fig. 3). Unary operations compare items within one input; binary operations compare items across two. One general module is more compact and lets the same overflow and algorithm machinery serve all of them (Section III.B.2).

8. Q: What does the exchange operator do, and why is it called a meta-operator?
   A: Exchange encapsulates all parallelism: it forks processes, creates a shared-memory port, partitions or routes data, and drives the subtree below it as a producer while acting as an ordinary iterator to the consumer above. It is a meta-operator because it performs no data manipulation; it only provides control. Crucially it uses and provides the standard iterator interface, so the operators around it never know it is there (Section VI).

9. Q: Exchange uses a different dataflow paradigm internally. Which, and why?
   A: Within a process all operators use demand-driven (pull, lazy) dataflow. Between processes exchange uses data-driven (push, eager) dataflow, so it can collect output into packets and push them through the port. The two stated reasons are that data-driven flow composes more easily with horizontal partitioning and that it removes the need for request messages, which would add control overhead. Exchange translates between the two paradigms at the process boundary (Section VI.A).

10. Q: Follow-up: is flow control the same as demand-driven dataflow? Distinguish them.
    A: No. Flow control is an optional back-pressure semaphore on the data-driven path that bounds how far producers may run ahead of consumers, allowing slack and genuinely overlapped producer/consumer execution. Demand-driven dataflow is a rigid request-and-deliver discipline in which the consumer blocks while the producer computes the next record, so there is no overlap. Flow control limits eager production; pull simply never produces ahead at all (Section VI.A).

11. Q: Name the forms of parallelism exchange supports and how each is requested.
    A: Vertical parallelism (pipelining) between a producer process and a consumer process. Bushy parallelism, where different CPUs run different subtrees. Intra-operator parallelism, where several CPUs run the same operator on disjoint partitions. Vertical and bushy are inter-operator parallelism. Intra-operator parallelism is requested by setting the degree-of-parallelism argument in the exchange state record and supplying a partitioning support function; bushy parallelism is requested by inserting exchange operators between subtrees (Section VI.A, VI.B).

12. Q: How is data partitioned across consumers, and how is the partitioning policy chosen?
    A: A port can hold multiple queues, one per consumer process. The producer calls a partitioning support function to decide which queue (packet) each output record goes to. By supplying different support functions you get round-robin, key-range, or hash partitioning. As elsewhere, exchange provides the mechanism and the support function provides the policy (Section VI.B).

13. Q: What is the claimed benefit of orthogonalizing data manipulation and parallelism, and what evidence backs it?
    A: An operator is written, debugged, and tuned in a single process and then parallelized just by inserting exchange into the plan, with no change to the operator; even operators not yet designed can be parallelized if they use the iterator interface. To port to a new parallel machine only exchange changes. The evidence cited is near-linear speedup, specifically 14.9 on 16 CPUs for parallel sorting on shared memory (Abstract, Section VII, reference [18]).

14. Q: What is the choose-plan operator and when would you use it?
    A: choose-plan is a meta-operator with the standard open-next-close interface that selects among several equivalent subplans at runtime. Its open calls a support function (given the bindings parameter) to pick a plan, then opens it; next and close forward to the chosen input. It is used for dynamic query evaluation plans, for example an embedded query whose predicate constant is a program variable, so the plan can switch between an index scan and a full file scan depending on the actual value (Section V).

15. Q: Why does Volcano avoid temporary files between operators, and where do intermediate results live?
    A: Passing data through temporary files, as many textbooks suggest, has a substantial performance penalty and is used in neither real systems nor Volcano. Intermediate results (streams) live on virtual devices whose pages exist only in the buffer pool and disappear when unpinned, so the same file and buffer mechanisms serve both permanent and intermediate data while keeping data in memory (Introduction, Section III.A, Section III.B).

16. Q: How does Volcano keep buffer accounting correct as records flow between operators?
    A: Each pinned record is owned by exactly one operator at a time. On receiving a record an operator may keep it, unfix it (for example on predicate failure), or pass it on; operators that build new records must fix their outputs and unfix their inputs. To keep buffer-call counts low, the buffer interface needs two calls per cluster on the producer side and one per cluster on the consumer side, independent of records per cluster (Section III.B).

## Glossary terms introduced

- Iterator: an operator implementation that supports the open-next-close protocol, providing the initialization, increment, termination, and housekeeping of a loop over a result set (Section III.B).
- open-next-close protocol: the three-procedure control interface every Volcano operator shares; open initializes and recursively opens inputs, next produces one record on demand, close recursively shuts down (Section III.B).
- State record: the per-instance data structure holding an iterator's arguments and runtime state plus its input pointers; no static variables are used, so one operator can be instantiated many times in a plan (Section III.B).
- Support function: an imported function entry point plus a typeless argument that performs all item-level work (predicate, hashing, comparison, transform, apply, partitioning), keeping operators data-model independent (Introduction, Section III.A).
- Stream / anonymous input: the abstraction by which an operator consumes its input without knowing what produces it, enabling arbitrary composition of operators (Section III.B).
- Demand-driven dataflow (pull, lazy evaluation): the within-process model in which a consumer calls next to pull each record, and producers compute only on demand (Section III.B, Section VI.A).
- Data-driven dataflow (push, eager evaluation): the between-process model used by exchange in which producers push packets of records to consumers without request messages (Section VI.A).
- Meta-operator: an operator that provides control over query processing rather than data manipulation; choose-plan and exchange are the two meta-operators (Sections V, VI).
- Exchange operator: the meta-operator that encapsulates all parallelism (process creation, ports, partitioning, flow control) and translates between demand-driven and data-driven dataflow while presenting the standard iterator interface (Section VI).
- Operator model of parallelization: Graefe's approach of localizing all parallelism in the exchange operator so data manipulation and parallelism are orthogonal (Section VI).
- Port: the shared-memory structure created by exchange for synchronization and data exchange between producer and consumer processes; may hold multiple queues for partitioning (Sections VI.A, VI.B).
- Packet: an array of Next-Record structures (size 1 to 32000) that exchange fills and pushes through the port (Section VI.A).
- Vertical parallelism: pipelining between a producer process and a consumer process via exchange (Section VI.A).
- Bushy parallelism: inter-operator parallelism in which different CPUs execute different subtrees of a plan (Section VI.B).
- Intra-operator parallelism: running the same operator over disjoint data partitions on several CPUs, enabled by partitioning support functions (Section VI.B).
- Flow control / back pressure: an optional semaphore that bounds how far data-driven producers may run ahead of consumers, allowing overlapped execution; distinct from pull-based dataflow (Section VI.A).
- Interchange: a variant of exchange that lives in the middle of a process tree without forking, routing records to other processes until it finds one for its own partition, which makes flow control unnecessary (Section VI.C).
- choose-plan operator: the meta-operator that selects among equivalent subplans at runtime via a support function, realizing dynamic query evaluation plans (Section V).
- Dynamic query evaluation plan: a plan with one or more choose-plan operators that defers selected optimization decisions to runtime, useful for embedded or repetitive queries with free variables (Section V).
- One-to-one match: the single physical operator implementing join, semi-join, outer joins, anti-join, intersection, union, difference, anti-difference, aggregation, and duplicate elimination, with hash and sort-merge variants (Section III.B.2).
- One-to-many match: the operator that compares each item with many others, used for relational division (native and hash-division variants) (Section III.B.3).
- Filter (side-effect) operator: the single-input single-output operator carrying optional predicate (selection), transform (projection and other rewrites), and apply (side effects such as update and print) support functions (Section III.B.1).
- Functional join: the operator that retrieves data records by RID for B+-tree leaf entries, kept separate from the index scan (Section III.B.1).
- Packing and spilling thresholds: state-record parameters of the hash one-to-one match controlling when items are packed densely into overflow files and when partition files are written to disk; both zero gives Grace-style overflow avoidance (Section III.B.2).
- Virtual device: a device whose pages live only in the buffer and vanish when unpinned, used to hold intermediate streams without temporary files (Section III.A).
- Mechanism versus policy: the recurring design principle that Volcano implements mechanisms and leaves policy choices (overflow thresholds, partitioning scheme, plan choice, compiled versus interpreted predicates) to a human experimenter, an optimizer, or a support function (Introduction, Section III).
