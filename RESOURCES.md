# Advanced DBMS Resources

Curated high-trust sources for this course. Per-topic citations (with verified URLs) live alongside each topic note in `research/topics/*.md`; this file is the short list of the sources worth returning to again and again.

## The four assigned papers (viva)

- [Architecture of a Database System (Hellerstein, Stonebraker, Hamilton, 2007)](https://dsf.berkeley.edu/papers/fntdb07-architecture.pdf)
  The map of the whole system. Read chapters 1 to 4. Use for: the process model, the query processor pipeline, and how the components fit. Grounds week 1. Summary in `research/papers/architecture.md`.
- [Volcano: An Extensible and Parallel Query Evaluation System (Graefe, 1994)](https://paperhub.s3.amazonaws.com/dace52a42c07f7f8348b08dc2b186061.pdf)
  The iterator model that almost every executor still uses. Use for: open-next-close, demand-driven dataflow. Grounds weeks 9 to 10. Summary in `research/papers/volcano.md`.
- [Bigtable: A Distributed Storage System for Structured Data (Google, 2006)](https://static.googleusercontent.com/media/research.google.com/en//archive/bigtable-osdi06.pdf)
  The LSM lineage and a real distributed store. Use for: SSTables, tablets, compaction, the sorted-map data model. Grounds weeks 15 to 16. Summary in `research/papers/bigtable.md`.
- [ARIES: A Transaction Recovery Method (Mohan et al., 1992)](https://web.stanford.edu/class/cs345d-01/rl/aries.pdf)
  Crash recovery done right. Read the abstract and the algorithm; skip the exhaustive 69 pages. Use for: WAL, repeating history, CLRs, the three passes. Grounds week 14. Summary in `research/papers/aries.md`.

## Knowledge

- [CMU 15-445/645 Database Systems (Andy Pavlo)](https://15445.courses.cs.cmu.edu/)
  The single best free course on this exact material, with recorded lectures and notes. Use for: essentially every week. The build-it milestones in this syllabus mirror its projects.
- [PostgreSQL documentation: Internals](https://www.postgresql.org/docs/current/internals.html)
  Authoritative reference for how a production engine actually does it. Use for: page layout, MVCC, the planner, WAL.
- [SQLite Database File Format](https://www.sqlite.org/fileformat2.html)
  A small, fully documented on-disk format. Use for: pages, cell pointer arrays, overflow pages, B-tree layout.
- [Database Internals, Alex Petrov (O'Reilly)](https://www.databass.dev/)
  Storage engines and distributed systems in one book. Use for: B-trees vs LSM, buffer management, replication.
- [Designing Data-Intensive Applications, Martin Kleppmann](https://dataintensive.net/)
  The standard text for the distributed and modern weeks. Use for: replication, partitioning, consistency, CAP.
- [Readings in Database Systems, 5th ed (the Red Book)](http://www.redbook.io/)
  Curated classic papers with commentary. Use for: deeper context on optimization, transactions, and architecture.

## Wisdom (communities)

- [r/databases](https://www.reddit.com/r/databases/) and [r/Database](https://www.reddit.com/r/Database/)
  Use for: sanity-checking mental models and real-world war stories.
- [CMU Database Group talks (YouTube)](https://www.youtube.com/@CMUDatabaseGroup)
  Use for: how working systems people think about these problems.
- [dbdb.io Database of Databases](https://dbdb.io/)
  Use for: comparing how different real systems made each design choice.

## Gaps

This list is intentionally short. Specific, verified per-topic URLs (PostgreSQL function names, exact doc pages, the System R and ANSI-isolation and LSM papers) are recorded in the matching `research/topics/*.md` note as they are confirmed.
