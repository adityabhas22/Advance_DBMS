export const meta = {
  name: 'dbms-research',
  description: 'Deep research for an Advanced DBMS course: read 4 papers + 9 topic clusters, then plan 16 lesson blueprints',
  phases: [
    { title: 'Research', detail: 'read 4 papers (local text) + 9 topic clusters (web-grounded)' },
    { title: 'Plan', detail: 'synthesize course spine + 16 lesson blueprints' },
  ],
}

const REPO = '/home/xspecies/aditya/Advance_DBMS'
const PDFS = '/tmp/claude-1000/-home-xspecies-aditya-Advance-DBMS/735cecf3-cbbb-4acf-abb0-4206d926e2c0/scratchpad/pdfs'

const RESEARCH_RETURN = {
  type: 'object',
  required: ['path_written', 'title', 'key_claims'],
  properties: {
    path_written: { type: 'string' },
    title: { type: 'string' },
    key_claims: { type: 'array', items: { type: 'string' }, minItems: 5 },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
}

const COMMON_RULES = `
WRITING RULES (a humanizer pass runs later, but write clean now):
- No em dashes or en dashes anywhere. Use periods, commas, colons, or parentheses.
- No emojis. Sentence case headings. No "rule of three" padding, no promotional vocabulary.
- Plain, precise, technical voice. Cite real URLs you actually verified.
You are producing a RESEARCH NOTE in Markdown (a study/teaching source, not a chat reply).
Ground claims in authoritative sources. Where you state a number or invariant, say where it comes from.
Your returned text is structured data consumed by a program, not shown to a human.`

// ---------- PAPER AGENTS ----------
const PAPERS = [
  {
    key: 'architecture', file: `${PDFS}/architecture.txt`,
    title: 'Architecture of a Database System (Hellerstein, Stonebraker, Hamilton)',
    focus: `Focus on chapters 1-4 only: (1) Introduction and the five components; (2) Process Models and the DBMS process/thread architecture, admission control; (3) Parallel Architecture (shared-memory/nothing/disk); (4) Relational Query Processor: parsing, authorization, query rewrite, optimizer (System R, Selinger), executor (iterator model), access methods. Connect each part to the course weeks it maps to.`,
    weeks: '1, 8, 9, 10, 11',
  },
  {
    key: 'volcano', file: `${PDFS}/volcano.txt`,
    title: 'Volcano: An Extensible and Parallel Query Evaluation System (Graefe)',
    focus: `Focus on the iterator/Volcano model: the open-next-close protocol, demand-driven dataflow (pull), why every operator shares one interface, the support functions, and the exchange operator for parallelism. Explain how this maps to SeqScan/Filter/Project/Join in the course.`,
    weeks: '9, 10',
  },
  {
    key: 'bigtable', file: `${PDFS}/bigtable.txt`,
    title: 'Bigtable: A Distributed Storage System for Structured Data (Google)',
    focus: `Data model (row key, column families, timestamps, the sparse sorted map). Building blocks: GFS, SSTable file format, Chubby. Tablets, tablet servers, the three-level METADATA hierarchy. The write path: memtable + commit log + minor/merging/major compaction. This is the LSM-tree lineage. Connect to weeks 15 (LSM, RocksDB compaction) and 16 (partitioning, replication).`,
    weeks: '15, 16',
  },
  {
    key: 'aries', file: `${PDFS}/aries.txt`,
    title: 'ARIES: A Transaction Recovery Method (Mohan et al.)',
    focus: `Do NOT read all 69 pages. Read the abstract, introduction, and the sections that define the algorithm. Cover: WAL, the LSN, the three guarantees (steal/no-force support), the page LSN, the Dirty Page Table and Transaction Table, the three core principles (write-ahead logging, repeating history during redo, logging changes during undo via Compensation Log Records / CLRs), and the three passes: Analysis, Redo, Undo. Keep it to the algorithm and its rationale.`,
    weeks: '14',
  },
]

// ---------- TOPIC CLUSTER AGENTS ----------
const TOPICS = [
  { key: 'storage', weeks: '2-3', title: 'Storage engine: pages, records, heap files',
    scope: `Disk vs memory and the block/page abstraction. Page size choices. Slotted page layout (header, slot array growing down, tuple data growing up, free-space pointer). Fixed vs variable length records, NULL bitmap, record header, alignment/padding. Heap file organization (linked list of pages vs page directory). Free space management (free space map). Tuple deletion (tombstones, vacuum). PostgreSQL specifics: 8KB pages, page header, ItemId/line pointers, HeapTupleHeader, TOAST for large values, VACUUM. SQLite specifics: page structure, cell pointer array, freeblocks, overflow pages.`,
    sources: `PostgreSQL docs "Database Page Layout" and "TOAST"; SQLite "Database File Format"; CMU 15-445 storage lectures; book "Database Internals" (Petrov) ch 3-4.` },
  { key: 'buffer', weeks: '4-5', title: 'Buffer pool and replacement policies',
    scope: `Why a buffer pool exists (the memory/disk gap, page caching). Frames, the page table (page_id -> frame), pin count, dirty flag, reference bit. Pinning/unpinning, eviction only of unpinned frames, write-back of dirty pages. Replacement policy theory: optimal (Belady), LRU, CLOCK (second chance), LRU-K and why it beats LRU, the sequential flooding problem and why MRU/scan-resistance helps, prefetching and read-ahead. PostgreSQL specifics: shared_buffers, clock-sweep with usage_count, ring buffers for sequential scans. The steal/no-force policy link to recovery.`,
    sources: `CMU 15-445 buffer pool lecture; the LRU-K paper (O'Neil, Weikum); PostgreSQL source/docs on clock sweep and ring buffers; "Database Internals" buffer management.` },
  { key: 'indexing', weeks: '6-7', title: 'B+trees and hash indexes',
    scope: `Why a balanced tree over disk: fanout, height, logarithmic IO. B+tree invariants (all values in leaves, leaves linked, half-full nodes, balanced height). Search, insertion with node splits, propagation to root, deletion with merge/redistribute, the half-full underflow rule. Bulk loading bottom-up. Composite/multi-column keys and ordering. Clustered vs unclustered/secondary indexes. Hash indexes (static vs extendible/linear hashing) and the B+tree vs hash comparison (range vs point). PostgreSQL specifics: nbtree, fillfactor, index-only scans, hash index. Difference between B-tree and B+tree.`,
    sources: `CMU 15-445 tree/hash index lectures; PostgreSQL nbtree README and docs; "Database Internals" ch 2; the B-tree literature (Comer, "The Ubiquitous B-Tree").` },
  { key: 'parsing', weeks: '8', title: 'Query parsing and logical plans',
    scope: `The front of the pipeline: lexing/tokenizing SQL, parsing to a syntax tree (grammar, recursive descent vs LALR), AST construction. Semantic analysis / binding: name resolution against the catalog, type checking. Query rewrite. Translating to a logical plan (relational algebra tree). The boundary between logical (what) and physical (how) plans. PostgreSQL specifics: flex/bison grammar, parse tree -> Query (analyze/rewrite) -> plan. SQLite tokenizer/parser (Lemon).`,
    sources: `PostgreSQL docs "Overview of PostgreSQL Internals" and parser stage; CMU 15-445; "Architecture of a Database System" section 4.1-4.2; relational algebra references.` },
  { key: 'execution', weeks: '9-10', title: 'Query execution operators and joins',
    scope: `The Volcano iterator model (open/next/close, pull-based) and the alternative push/vectorized model. Operators: SeqScan, IndexScan, Filter, Projection. Join algorithms in depth: nested loop join (naive, block, index), sort-merge join (and when sortedness is reused), hash join (build/probe, grace/partitioned hash join when it does not fit in memory). External merge sort (run generation, multi-way merge, IO cost in passes). Hash aggregation vs sort-based aggregation. Pipelining vs materialization (pipeline breakers).`,
    sources: `Volcano paper (Graefe); CMU 15-445 execution and join lectures; "Architecture of a Database System" 4.4; Goetz Graefe "Query Evaluation Techniques" survey.` },
  { key: 'optimization', weeks: '11', title: 'Query optimization',
    scope: `Why optimization is needed (the plan space is huge). Cost estimation: IO + CPU cost models. Selectivity estimation: predicate selectivity, histograms (equi-width, equi-depth), the uniformity and independence assumptions and how they fail. Join ordering: left-deep vs bushy trees, the System R / Selinger dynamic programming algorithm, interesting orders. Heuristic rewrites: predicate pushdown, projection pushdown, join elimination. Cost-based vs rule-based. PostgreSQL specifics: pg_statistic, n_distinct, ANALYZE, the genetic optimizer for many joins, EXPLAIN.`,
    sources: `Selinger et al. 1979 System R optimizer paper; CMU 15-445 optimization lectures; PostgreSQL docs "How the Planner Uses Statistics"; "Architecture of a Database System" 4.3.` },
  { key: 'transactions', weeks: '12', title: 'Transactions, ACID, isolation levels',
    scope: `ACID defined precisely. Why concurrency control: the anomalies (dirty read, non-repeatable read, phantom, lost update, write skew). Schedules: serial, serializable, conflict-serializable, the precedence/conflict graph. Recoverable vs cascadeless schedules. ANSI isolation levels (read uncommitted, read committed, repeatable read, serializable) defined by which anomalies they forbid, and the critique that they are defined by anomalies. Snapshot isolation and write skew. Two-phase locking (2PL) theory: growing/shrinking phases, why 2PL gives serializability. Lock modes (S/X), lock compatibility.`,
    sources: `Gray and Reuter "Transaction Processing"; the "A Critique of ANSI SQL Isolation Levels" paper (Berenson et al.); CMU 15-445 concurrency lectures; PostgreSQL docs "Transaction Isolation".` },
  { key: 'concurrency', weeks: '13', title: 'Concurrency control: strict 2PL, deadlock, MVCC',
    scope: `Strict 2PL and rigorous 2PL (hold locks to commit) and why, cascading aborts avoided. Lock manager, lock table, intention locks and multi-granularity locking. Deadlock: detection via waits-for graph and cycle detection, deadlock prevention (wait-die, wound-wait), timeouts. MVCC in depth: readers do not block writers, each write creates a new version, visibility rules, snapshots. PostgreSQL MVCC specifics: xmin/xmax on each tuple, transaction snapshots, the visibility map, the need for VACUUM, why updates are delete+insert. Comparison of 2PL vs MVCC vs optimistic (OCC).`,
    sources: `CMU 15-445 MVCC lecture and the Wu et al. MVCC survey; PostgreSQL docs "Concurrency Control" and MVCC internals; Gray and Reuter.` },
  { key: 'modern', weeks: '15-16', title: 'Modern and distributed architectures',
    scope: `LSM trees: memtable + immutable SSTables + WAL, the read/write amplification trade-off vs B-trees, leveled vs tiered (size-tiered) compaction, bloom filters, RocksDB. Columnar storage: row vs column layout, why columnar wins for OLAP (compression, vectorized scans, late materialization), DuckDB and its vectorized push-based engine. Distributed: horizontal partitioning/sharding (hash vs range), replication (leader/follower, quorums), two-phase commit (2PC) and its blocking problem, the CAP theorem (and the PACELC refinement), consensus (Raft/Paxos at a high level).`,
    sources: `O'Neil et al. LSM-tree paper; RocksDB wiki on compaction; DuckDB papers/docs; Kleppmann "Designing Data-Intensive Applications" ch 5-6-9; the CAP theorem (Brewer/Gilbert-Lynch); Bigtable and Spanner papers.` },
]

phase('Research')
const paperThunks = PAPERS.map(p => () => agent(
  `${COMMON_RULES}

You are reading a real research paper to produce a deep study note for a graduate Advanced DBMS course.
The paper's extracted text is on disk. READ IT with the Read tool: ${p.file}
(It may be long. Read in chunks. ${p.focus})

Paper: ${p.title}
Course weeks it grounds: ${p.weeks}

Write a Markdown research note to: ${REPO}/research/papers/${p.key}.md
Structure it as:
1. One-paragraph "what problem this paper solves and why it mattered".
2. "The core mechanism" explained from first principles, with the key invariants/algorithms. Use concrete detail from the actual text (cite section names/numbers).
3. "Key facts and figures" as a bullet list (the things an examiner could quiz).
4. "Trade-offs and limitations".
5. "How it maps to the course" (which weeks, which lessons should cite it).
6. "Viva question bank": 10-15 examiner-style questions WITH model answers (2-5 sentences each). Anticipate the tricky follow-ups an oral examiner asks.
7. "Glossary terms introduced": term -> tight definition.

Be rigorous and faithful to the actual paper text. This note will ground lessons, so accuracy matters more than breadth.
Return the structured summary per the schema.`,
  { label: `paper:${p.key}`, phase: 'Research', agentType: 'general-purpose', schema: RESEARCH_RETURN }
))

const topicThunks = TOPICS.map(t => () => agent(
  `${COMMON_RULES}

You are a DBMS internals expert writing a grounded research note for these course weeks: ${t.weeks}.
Topic cluster: ${t.title}

Scope to cover thoroughly:
${t.scope}

Suggested authoritative sources (verify before citing; use WebSearch/WebFetch via ToolSearch to confirm 3-6 real URLs, especially PostgreSQL/SQLite docs and the named papers):
${t.sources}

Write a Markdown research note to: ${REPO}/research/topics/${t.key}.md
Structure it as:
1. "The core problem" (first principles: what breaks without this).
2. "Mechanisms" with the real algorithms, invariants, data layouts, and complexity/IO costs. Be concrete and correct.
3. "How real systems do it" (PostgreSQL and SQLite specifics, named functions/structures where possible).
4. "Common exam traps and misconceptions" (the false statements an MCQ would use, and why they are false).
5. "Good simulator ideas" for teaching this interactively (2-3 concrete ideas: what the learner manipulates and observes).
6. "Citations": the real URLs you verified, each annotated with what it covers.
7. "Glossary terms": term -> tight definition.

Only cite URLs you actually fetched or are highly confident are stable canonical pages. Prefer primary sources. Return the structured summary per the schema.`,
  { label: `topic:${t.key}`, phase: 'Research', agentType: 'general-purpose', schema: RESEARCH_RETURN }
))

const research = (await parallel([...paperThunks, ...topicThunks])).filter(Boolean)
log(`research notes written: ${research.length}/${PAPERS.length + TOPICS.length}`)

// ---------- PLANNING ----------
phase('Plan')

const BLUEPRINT_SCHEMA = {
  type: 'object',
  required: ['spine_written', 'blueprints'],
  properties: {
    spine_written: { type: 'string', description: 'path to the course-spine.md written' },
    blueprints: {
      type: 'array', minItems: 16, maxItems: 16,
      items: {
        type: 'object',
        required: ['week','slug','title','layer','part','hook','arc','simulator','diagrams','mcq_themes','glossary_terms','primary_source','research_refs','viva'],
        properties: {
          week: { type: 'integer' },
          slug: { type: 'string', description: 'filename like 0002-storage-engine-disk-pages.html' },
          title: { type: 'string' },
          layer: { type: 'string', enum: ['storage','buffer','index','query','txn','recovery','modern'] },
          part: { type: 'string', description: 'e.g. "Part II - Storage"' },
          hook: { type: 'string', description: 'the single question the lesson answers' },
          arc: { type: 'array', items: { type: 'string' }, description: 'first-principles beats in order' },
          simulator: {
            type: 'object',
            required: ['name','what_it_does','controls','observe'],
            properties: {
              name: { type: 'string' },
              what_it_does: { type: 'string' },
              controls: { type: 'array', items: { type: 'string' } },
              observe: { type: 'string', description: 'what insight the learner gains by playing' },
            },
          },
          diagrams: { type: 'array', items: { type: 'string' }, description: '2-3 SVG diagram ideas' },
          mcq_themes: { type: 'array', items: { type: 'string' }, minItems: 4 },
          glossary_terms: { type: 'array', items: { type: 'string' } },
          primary_source: {
            type: 'object',
            required: ['title','url','why'],
            properties: { title: { type: 'string' }, url: { type: 'string' }, why: { type: 'string' } },
          },
          research_refs: { type: 'array', items: { type: 'string' }, description: 'paths under research/ this lesson should read' },
          viva: { type: 'boolean', description: 'true if this week has an assigned paper viva' },
        },
      },
    },
  },
}

const SLUGS = [
  '0001-dbms-architecture','0002-storage-engine-disk-pages','0003-storage-engine-heap-files',
  '0004-buffer-pool-design','0005-buffer-pool-lru-k','0006-btree-search-insert',
  '0007-btree-delete-hash','0008-query-parsing','0009-query-execution-volcano',
  '0010-query-execution-joins','0011-query-optimization','0012-transactions-isolation',
  '0013-concurrency-mvcc','0014-logging-recovery-aries','0015-modern-architectures-lsm',
  '0016-distributed-databases',
]

const plan = await agent(
  `${COMMON_RULES}

You are the lead course designer. Research notes are on disk in ${REPO}/research/papers/ and ${REPO}/research/topics/.
READ them (Read tool) before planning. They are the ground truth.

Course: Advanced DBMS, 16 weekly lessons. The learner knows what a DB/index/transaction IS but not deeply; the goal is intuitive mastery that TIES THE WHOLE PICTURE TOGETHER, plus an MCQ exam and a viva on 4 papers.

Two deliverables:

(A) Write ${REPO}/research/course-spine.md : the unifying narrative for the whole course. The "one story" that connects all 16 weeks, told two ways: (1) follow a single SELECT query top to bottom through the engine, naming which week owns each layer; (2) follow a single UPDATE inside a transaction through concurrency control, logging, and recovery. Make the connective tissue explicit so the learner never sees 16 islands. Also include a short "reading order and dependencies" note.

(B) Return 16 lesson blueprints (one per week) as structured data. Use exactly these slugs in order (week 1..16):
${SLUGS.map((s,i)=>`  week ${i+1}: ${s}.html`).join('\n')}

Layer assignment: w1 query; w2-3 storage; w4-5 buffer; w6-7 index; w8-11 query; w12-13 txn; w14 recovery; w15-16 modern.
Syllabus per week (cover these exactly):
 1 DBMS architecture: system overview, query processing pipeline, tour of PostgreSQL/SQLite internals
 2 Storage engine: disk layout, page structure, byte-level record encoding, slotted pages
 3 Storage engine 2: heap file structure, free space management, variable-length records, tuple deletion
 4 Buffer pool: design, page table, pin counts, dirty flags, replacement policy theory
 5 Buffer pool 2: LRU-K, sequential flooding, prefetching (Milestone M1)
 6 Index structures: B+tree invariants, search, insertion, page splits, height balancing
 7 Index structures 2: B+tree deletion, merges, bulk loading, composite keys, hash index comparison
 8 Query parsing: lexing, parsing, AST construction, logical plan generation (Milestone M2)
 9 Query execution: Volcano model, SeqScan, Filter, Projection, nested loop join
 10 Query execution 2: sort-merge join, hash join, external sort, hash aggregation
 11 Query optimization: cost estimation, selectivity, join ordering, predicate pushdown
 12 Transactions: ACID, concurrency anomalies, isolation levels, 2PL theory
 13 Concurrency: strict 2PL, deadlock detection, MVCC overview
 14 Logging and recovery: WAL, log record format, ARIES (Analysis, Redo, Undo)
 15 Modern architectures: LSM trees, columnar storage, DuckDB internals, RocksDB compaction
 16 Distributed DBs + final: partitioning, replication, 2PC, CAP theorem

For each blueprint:
- hook: the one motivating question.
- arc: 4-7 first-principles beats (problem -> naive fix -> why it breaks -> real design -> edge cases).
- simulator: ONE concrete interactive idea that genuinely teaches the mechanism (what the learner manipulates and what insight they get). Examples: a slotted-page byte editor, a buffer pool with selectable LRU/CLOCK/LRU-K under a scan vs random workload, a B+tree you insert keys into and watch split, a join visualizer toggling NLJ/SMJ/HJ, a 2PL/MVCC schedule stepper showing anomalies, an ARIES log replayer.
- diagrams: 2-3 SVG diagram ideas.
- mcq_themes: at least 4 tricky MCQ topics (include "which is false" style).
- glossary_terms, primary_source (real URL from the research notes), research_refs (paths to read), viva (true for weeks 1, 9/10, 14, 15/16 papers; mark the week that should host each paper's viva: architecture->w1, volcano->w9, aries->w14, bigtable->w15).

Make simulators DIVERSE across weeks. Return per schema.`,
  { label: 'plan:blueprints', phase: 'Plan', agentType: 'general-purpose', effort: 'high', schema: BLUEPRINT_SCHEMA }
)

return { research_count: research.length, research, plan }
