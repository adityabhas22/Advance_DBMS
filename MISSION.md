# Mission: Advanced DBMS Internals

## Why
I want to genuinely understand how a database works on the inside, deeply enough that the whole picture ties together rather than sitting in my head as 16 disconnected topics. I already know what a database, an index, and a transaction *are*; I want to know *how* and *why* they work at the level of pages, pointers, latches, and log records. Concretely, this also has to carry me through the course exam (MCQs only) and a viva (oral defense) on four assigned research papers.

## Success looks like
- I can trace a single SQL query end to end through the engine — parser, optimizer, executor, access methods, buffer pool, disk — and say what each layer hands the next and why.
- I can explain, from first principles, why each design exists: why slotted pages, why a B+tree instead of a binary tree, why WAL before the data page, why MVCC instead of locking everything.
- I can answer MCQ-style questions quickly and correctly across all 16 topics, including the tricky "which of these is *false*" framings.
- I can defend the four papers in a viva: Architecture of a Database System (ch. 1–4), the Volcano/Iterator model, BigTable, and ARIES — what problem each solves, the core mechanism, and the trade-offs.
- I can hold the modern landscape in view: B-tree vs LSM, row vs column, single-node vs distributed, and when each wins.

## Constraints
- Intermediate starting point: comfortable with SQL and the *idea* of indexes/transactions, new to the internals. Don't re-teach the relational basics; spend the depth on mechanism.
- Study format is reading-first: rich HTML lessons I return to, with interactive simulators I can play with, strong diagrams, and retrieval practice built in.
- Code is illustrative: language-agnostic pseudocode grounded in how PostgreSQL and SQLite actually do it. Not a from-scratch coding course.
- Exam reality: the graded assessment is MCQ + a paper viva, so every lesson should build toward fast, accurate recall and the papers get dedicated viva prep.

## Out of scope (for now)
- Writing a production storage engine in C++/Rust from scratch.
- SQL language tutorials, schema design, normalization theory.
- Database administration, tuning knobs, cloud operations.
- ORMs and application-layer data access patterns.
