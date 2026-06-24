export const meta = {
  name: 'dbms-build',
  description: 'Build 16 interactive HTML lessons + reference cheat sheets from the lesson blueprints',
  phases: [
    { title: 'Lessons', detail: 'write each lesson then humanize + verify it' },
    { title: 'Reference', detail: 'build cheat sheets, MCQ bank, viva prep' },
  ],
}

const REPO = '/home/xspecies/aditya/Advance_DBMS'
const A = '../assets'

// Slim lesson list (full per-lesson spec lives in research/blueprints/manifest.json, read by each agent).
const ordered = [
  { week: 1,  slug: '0001-dbms-architecture',           title: 'DBMS architecture: the life of a query',                              layer: 'query',    part: 'Part I - Foundations',           viva: true  },
  { week: 2,  slug: '0002-storage-engine-disk-pages',   title: 'Storage engine: disk layout, pages, and slotted records',             layer: 'storage',  part: 'Part II - Storage',              viva: false },
  { week: 3,  slug: '0003-storage-engine-heap-files',   title: 'Heap files, free space, and deleting tuples',                         layer: 'storage',  part: 'Part II - Storage',              viva: false },
  { week: 4,  slug: '0004-buffer-pool-design',          title: 'Buffer pool design: frames, pins, dirty flags, replacement',          layer: 'buffer',   part: 'Part III - Buffer pool',         viva: false },
  { week: 5,  slug: '0005-buffer-pool-lru-k',           title: 'LRU-K, sequential flooding, and prefetching',                         layer: 'buffer',   part: 'Part III - Buffer pool',         viva: false },
  { week: 6,  slug: '0006-btree-search-insert',         title: 'B+tree invariants, search, insertion, and splits',                    layer: 'index',    part: 'Part IV - Index structures',     viva: false },
  { week: 7,  slug: '0007-btree-delete-hash',           title: 'B+tree deletion, bulk loading, composite keys, and hash indexes',     layer: 'index',    part: 'Part IV - Index structures',     viva: false },
  { week: 8,  slug: '0008-query-parsing',               title: 'Query parsing: lexing, parsing, binding, and logical plans',          layer: 'query',    part: 'Part V - Query processing',      viva: false },
  { week: 9,  slug: '0009-query-execution-volcano',     title: 'Query execution: the Volcano iterator model',                         layer: 'query',    part: 'Part V - Query processing',      viva: true  },
  { week: 10, slug: '0010-query-execution-joins',       title: 'Joins, external sort, and aggregation',                               layer: 'query',    part: 'Part V - Query processing',      viva: true  },
  { week: 11, slug: '0011-query-optimization',          title: 'Query optimization: cost, selectivity, and join ordering',            layer: 'query',    part: 'Part V - Query processing',      viva: false },
  { week: 12, slug: '0012-transactions-isolation',      title: 'Transactions, ACID, anomalies, and isolation levels',                 layer: 'txn',      part: 'Part VI - Transactions',         viva: false },
  { week: 13, slug: '0013-concurrency-mvcc',            title: 'Concurrency: strict 2PL, deadlock, and MVCC',                         layer: 'txn',      part: 'Part VI - Transactions',         viva: false },
  { week: 14, slug: '0014-logging-recovery-aries',      title: 'Logging and recovery: WAL and ARIES',                                 layer: 'recovery', part: 'Part VII - Recovery',            viva: true  },
  { week: 15, slug: '0015-modern-architectures-lsm',    title: 'Modern architectures: LSM trees, columnar storage, DuckDB',           layer: 'modern',   part: 'Part VIII - Modern and distributed', viva: true },
  { week: 16, slug: '0016-distributed-databases',       title: 'Distributed databases: partitioning, replication, 2PC, CAP',          layer: 'modern',   part: 'Part VIII - Modern and distributed', viva: true },
]
const wk = (n) => String(n).padStart(2, '0')
const navOf = (i) => ({
  prev: i > 0 ? `<a class="prev" href="${ordered[i-1].slug}.html">Week ${wk(ordered[i-1].week)} · ${ordered[i-1].title}</a>` : '(first lesson) link prev to ../index.html labelled "Course map"',
  next: i < ordered.length - 1 ? `<a class="next" href="${ordered[i+1].slug}.html">Week ${wk(ordered[i+1].week)} · ${ordered[i+1].title}</a>` : '(last lesson) link next to ../reference/exam-mcq-bank.html labelled "Exam prep"',
})

const COMMON = `
You are authoring ONE lesson in a cohesive 16-lesson HTML course called "A Field Guide to the Database Engine".
The learner knows what a database, an index, and a transaction ARE, but not deeply. The goal is intuitive mastery
that ties the whole engine together, plus an MCQ exam and a viva on four papers.

BEFORE WRITING, READ (Read tool):
  1. ${REPO}/assets/_TEMPLATE.html        the exact component markup and the lesson contract
  2. ${REPO}/research/blueprints/manifest.json   find the object whose "week" equals THIS lesson's week; that is
     your full spec: hook, arc, simulator (name/what_it_does/controls/observe), diagrams, mcq_themes,
     glossary_terms, primary_source (use its real url), research_refs, viva.
  3. ${REPO}/research/course-spine.md     the single running example and the hand-offs between layers
  4. every file listed in your blueprint's research_refs (ground truth; read before making factual claims)

NON-NEGOTIABLE STYLE (a final humanize pass will check this):
- No em dashes or en dashes anywhere in prose. Use periods, commas, colons, or parentheses.
- No emojis. Headings in sentence case. No "rule of three" padding. No promotional vocabulary
  (vibrant, rich, crucial, pivotal, testament, tapestry, seamless, robust). Prefer is/are/has over
  elaborate copula avoidance. Vary sentence length. Confident, precise, technical voice.
- Lead with intuition and a concrete problem, THEN the mechanism. Derive designs, do not assert them.

HARD STRUCTURAL REQUIREMENTS (every lesson):
- Self-contained HTML5 file. In <head>: <link rel="stylesheet" href="${A}/course.css"> and
  <script defer src="${A}/components.js"></script>. Set <body class="layer-LAYER"> using the blueprint layer.
- Masthead with crumbs + week badge + h1 + lede. An .objectives box.
- CONNECTIVE TISSUE: open by placing the lesson on the course's single running example
  (SELECT name FROM emp WHERE salary > 75000 ORDER BY name, plus the UPDATE walk for write-path weeks),
  name what the layer above hands in and what this layer hands down, and link to the neighbouring lessons.
  The learner's top goal is to stop seeing 16 islands.
- At least ONE genuinely interactive simulator built per the blueprint, as self-contained vanilla JS in an inline
  <script>. Use the DBMS helpers (DBMS.el, DBMS.svg, DBMS.stepper, DBMS.rng, DBMS.bindRange, DBMS.clamp).
  The sim MUST actually work: no undefined variables, no external libraries, deterministic where possible.
  Wrap each sim script in an IIFE so multiple sims never collide. Give every DOM id a lesson-unique prefix.
- Real SVG diagrams (inline <svg>), not decorative images. Use the subsystem CSS variables for colour.
- Use the callout flavours (intuition, why, keyidea, gotcha, realworld, and viva on paper weeks).
- At least 5 MCQs using the declarative .mcq pattern (data-answer is 0-based; include .mcq-explain; keep all four
  options close to the same length so layout gives nothing away; include at least one "which is false" item).
- At least one .flashcard for active recall.
- A .source-box pointing to the blueprint's primary source (real URL). An .ask-teacher box. A .lesson-nav with prev/next.
- Cite sources inline with real links where you make a specific factual claim.

Your returned text is structured data for a program, not a human message.`

const LESSON_RETURN = {
  type: 'object',
  required: ['slug', 'path', 'sim_count', 'mcq_count'],
  properties: {
    slug: { type: 'string' }, path: { type: 'string' },
    sim_count: { type: 'integer' }, mcq_count: { type: 'integer' },
    notes: { type: 'string' },
  },
}
const POLISH_RETURN = {
  type: 'object',
  required: ['slug', 'ok'],
  properties: {
    slug: { type: 'string' }, ok: { type: 'boolean' },
    dashes_removed: { type: 'integer' },
    issues_fixed: { type: 'array', items: { type: 'string' } },
  },
}

phase('Lessons')

const results = await pipeline(
  ordered.map((bp, i) => ({ bp, nav: navOf(i) })),

  // ---- stage 1: write the lesson ----
  ({ bp, nav }) => agent(
    `${COMMON}

THIS LESSON
Week ${bp.week}. Title: "${bp.title}". File to WRITE: ${REPO}/lessons/${bp.slug}.html
Layer (for <body class>): layer-${bp.layer}. Part: ${bp.part}.
${bp.viva ? 'This is a PAPER VIVA week. Include a "viva" callout with 2-3 examiner-style questions, each followed by a <details class="deepdive"> holding the model answer, pulled from the matching research/papers note.' : ''}

Get the full spec (hook, arc, simulator, diagrams, mcq_themes, glossary_terms, primary_source, research_refs)
from research/blueprints/manifest.json for week ${bp.week}, as instructed above.

Navigation footer:
  prev: ${nav.prev}
  next: ${nav.next}

Write the complete file now. Make it deep, correct, and beautiful. Return per schema.`,
    { label: `write:${bp.slug}`, phase: 'Lessons', agentType: 'general-purpose', effort: 'high', schema: LESSON_RETURN }
  ),

  // ---- stage 2: humanize prose + verify structure, fix in place ----
  (written, { bp }) => agent(
    `You are the editor and QA pass for one lesson: ${REPO}/lessons/${bp.slug}.html
READ the file. Then fix it IN PLACE (use Edit/Write) so that:

1) HUMANIZER PASS on PROSE ONLY (never touch code inside <pre>, <code>, or <script>):
   - Remove every em dash and en dash. Replace with period, comma, colon, or parentheses, or restructure.
   - Remove AI tells: promotional words (vibrant, rich, crucial, pivotal, testament, tapestry, seamless, robust,
     "plays a key role", "it is important to note"), rule-of-three padding, fragmented headers that just restate
     themselves, hedging, signposting ("let's dive in"), and emojis. Keep it precise and varied in rhythm.
   - Headings must be sentence case, not Title Case.
2) STRUCTURE + CORRECTNESS CHECK (fix what is wrong):
   - <head> links ${A}/course.css and ${A}/components.js with those exact relative paths; <body> has a layer-* class.
   - There is at least one working <script> simulator: scan it for undefined variables, unbalanced braces/parens,
     references to element ids that are not present, and any external dependency. Fix so it runs standalone.
   - Every .mcq has a numeric data-answer in range and a .mcq-explain. Options are similar length.
   - prev/next nav present and pointing at real sibling files. All internal hrefs use correct relative paths.
   - The factual content is accurate: if you spot a wrong claim about DBMS internals, correct it against the research notes.
   - HTML is well-formed (tags balanced, exactly one <h1>, valid nesting).

Do not water down the depth. Return per schema with the count of dashes removed and a short list of issues fixed.`,
    { label: `polish:${bp.slug}`, phase: 'Lessons', agentType: 'general-purpose', effort: 'medium', schema: POLISH_RETURN }
  ),
)

const built = results.filter(Boolean)
log(`lessons built: ${built.length}/${ordered.length}`)

// ---------------- REFERENCE DOCS ----------------
phase('Reference')

const REF_RETURN = { type: 'object', required: ['name', 'path'], properties: { name: { type: 'string' }, path: { type: 'string' }, notes: { type: 'string' } } }
const REF_RULES = `
Build a print-friendly HTML reference page. Link ../assets/course.css in <head> (and ../assets/components.js if it
has MCQs). Use <body class="layer-LAYER">. Wrap content in <main class="page"><div class="col">...</div></main>.
Use tables, .callout, inline SVG, and tight prose. These are cheat sheets the learner returns to and prints, so be
dense, accurate, and scannable. Same style rules: no em/en dashes, no emojis, sentence-case headings, no fluff.
Ground content in the research notes (READ them first). Your returned text is structured data, not a human message.`

const REFS = [
  { name: 'page-layout', layer: 'storage', title: 'Slotted page layout, on one page',
    spec: 'A labelled byte-map SVG of a slotted page (header, slot/line-pointer array growing down, tuple data growing up, free space pointer). A table of header fields. PostgreSQL page header + ItemId + HeapTupleHeader fields with sizes. Variable-length record encoding and the NULL bitmap. Quick rules for insert/delete/update within a page.',
    refs: ['research/topics/storage.md'] },
  { name: 'btree-operations', layer: 'index', title: 'B+tree operations cheat sheet',
    spec: 'Invariants. Search, insert (with split rule and where the separator goes), delete (underflow, redistribute vs merge thresholds). Bulk loading. SVG of a split before/after. Complexity table. B-tree vs B+tree vs hash comparison row.',
    refs: ['research/topics/indexing.md'] },
  { name: 'join-algorithms', layer: 'query', title: 'Join algorithms and costs',
    spec: 'Nested loop (naive/block/index), sort-merge, hash (grace). For each: when to use, IO cost formula, memory needs, whether output is sorted. A decision flowchart SVG. External merge sort pass count formula. Hash vs sort aggregation.',
    refs: ['research/topics/execution.md','research/papers/volcano.md'] },
  { name: 'isolation-levels', layer: 'txn', title: 'Isolation levels and anomalies',
    spec: 'The canonical matrix: rows = read uncommitted, read committed, repeatable read, serializable, (snapshot); columns = dirty read, non-repeatable read, phantom, (write skew); cells = allowed/prevented. Definitions of each anomaly with a tiny schedule example. 2PL vs MVCC one-liner. The ANSI critique note.',
    refs: ['research/topics/transactions.md','research/topics/concurrency.md'] },
  { name: 'aries-recovery', layer: 'recovery', title: 'ARIES recovery on one page',
    spec: 'WAL rule. LSN, pageLSN, prevLSN, Dirty Page Table, Transaction Table, recLSN, CLR/undoNextLSN. The three passes (Analysis, Redo from recLSN, Undo of losers) as a numbered list with what each pass builds/uses. A timeline SVG of a crash. The steal/no-force matrix and what each needs (undo/redo).',
    refs: ['research/papers/aries.md','research/topics/recovery.md'] },
  { name: 'lsm-vs-btree', layer: 'modern', title: 'LSM tree vs B-tree',
    spec: 'Side-by-side: write path, read path, write amplification, read amplification, space amplification, when each wins. Leveled vs tiered compaction SVG. Bloom filter role. Where Bigtable/RocksDB/LevelDB sit.',
    refs: ['research/topics/modern.md','research/papers/bigtable.md'] },
  { name: 'viva-prep-papers', layer: 'recovery', title: 'Viva prep: the four papers',
    spec: 'For each of the four papers (Architecture of a DB System, Volcano, Bigtable, ARIES): a 3-sentence "what and why", the 5 facts most likely to be asked, and the full anticipated question-and-answer bank from the research note. Use <details class="deepdive"> for model answers so the learner can self-test first.',
    refs: ['research/papers/architecture.md','research/papers/volcano.md','research/papers/bigtable.md','research/papers/aries.md'] },
  { name: 'exam-mcq-bank', layer: 'query', title: 'MCQ exam bank',
    spec: 'A large bank of MCQ practice across ALL 16 weeks, grouped by topic, using the declarative .mcq component so it is self-grading in the browser. Aim for 45 to 60 questions total, including several "which statement is false" items and a few that combine two topics. Each has an explanation. Include ../assets/components.js so they self-grade.',
    refs: ['research/topics/storage.md','research/topics/buffer.md','research/topics/indexing.md','research/topics/execution.md','research/topics/optimization.md','research/topics/transactions.md','research/topics/concurrency.md','research/topics/recovery.md','research/topics/modern.md','research/topics/parsing.md'] },
]

const refResults = (await parallel(REFS.map(r => () => agent(
  `${REF_RULES}

Reference page: "${r.title}". WRITE to ${REPO}/reference/${r.name}.html with <body class="layer-${r.layer}">.
Include a small masthead (h1 = the title, a crumb link back to ../index.html) and a footer link back to the relevant lesson(s).
Content to include: ${r.spec}
READ these research notes first as ground truth: ${r.refs.map(x=>`${REPO}/${x}`).join(', ')}
Return per schema.`,
  { label: `ref:${r.name}`, phase: 'Reference', agentType: 'general-purpose', effort: 'high', schema: REF_RETURN }
)))).filter(Boolean)

log(`reference docs built: ${refResults.length}/${REFS.length}`)

return { lessons: built, references: refResults }
