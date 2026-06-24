# A Field Guide to the Database Engine

A complete, deeply-researched set of study notes for a 16-week Advanced DBMS course, built as interactive HTML lessons. Every lesson leads with intuition, derives designs from first principles, includes at least one simulator you can play with, and ends with MCQ-style retrieval practice. The four assigned research papers get dedicated viva preparation.

This is a teaching workspace, not a codebase. It was built using the `teach` skill (structure and pedagogy) and the `humanizer` skill (prose), with the heavy research and authoring fanned out across parallel agents.

## How to read this

Open `index.html` in any browser. It is the map of the whole engine: it shows how a single query flows through every layer and links each layer to the lesson that explains it. Start there, then work through the lessons in order, or jump to whatever you need.

No build step, no server, no dependencies. Just open the HTML files.

```
open index.html          # macOS
xdg-open index.html      # Linux
```

## What is here

| Path | What it holds |
|------|---------------|
| `index.html` | Landing page and map of the whole database engine |
| `lessons/` | The 16 lessons, one per syllabus week, `NNNN-slug.html` |
| `reference/` | Print-friendly cheat sheets and the exam/viva prep banks |
| `assets/` | Shared stylesheet (`course.css`), component library (`components.js`), and the lesson template |
| `research/` | The grounding research: paper summaries, topic notes, the course spine, lesson blueprints, and the build methodology |
| `MISSION.md` | Why this course exists, and what success looks like |
| `GLOSSARY.md` | Canonical terminology used across every lesson |
| `RESOURCES.md` | Curated high-trust sources |
| `NOTES.md` | Teaching preferences |
| `learning-records/` | Records of what has been learned, to steer future sessions |

## The 16 weeks

1. DBMS architecture: the query processing pipeline, PostgreSQL and SQLite internals
2. Storage engine: disk layout, page structure, byte-level records, slotted pages
3. Storage engine: heap files, free space management, variable-length records, deletion
4. Buffer pool: page table, pin counts, dirty flags, replacement policy theory
5. Buffer pool: LRU-K, sequential flooding, prefetching
6. Index structures: B+tree invariants, search, insertion, page splits
7. Index structures: B+tree deletion, merges, bulk loading, composite keys, hashing
8. Query parsing: lexing, parsing, AST, logical plan generation
9. Query execution: the Volcano model, scans, filter, projection, nested loop join
10. Query execution: sort-merge join, hash join, external sort, hash aggregation
11. Query optimization: cost estimation, selectivity, join ordering, predicate pushdown
12. Transactions: ACID, anomalies, isolation levels, two-phase locking
13. Concurrency: strict 2PL, deadlock detection, MVCC
14. Logging and recovery: WAL, log record format, the ARIES algorithm
15. Modern architectures: LSM trees, columnar storage, DuckDB, RocksDB compaction
16. Distributed databases: partitioning, replication, two-phase commit, CAP

## How this was built

See `research/methodology.md` for the full account: the research phase that read the four papers and nine topic clusters, the course spine that ties the weeks together, the per-lesson blueprints, and the parallel build. The workflow scripts that orchestrated it are in `research/_wf_research.js` and `research/_wf_build.js`.
