# Teaching Notes

Working notes on how this learner wants to be taught. Refer back before designing any lesson.

## Learner preferences
- **Intuition first, then mechanism.** Lead with the mental model and the "why does this problem even exist," then drop into the byte-level / algorithmic detail. Never open with a definition dump.
- **Tie the picture together.** The single most requested thing: connective tissue between topics. Every lesson should say where it sits in the whole engine and link backward/forward. The landing page is a map of the entire system.
- **Show, don't just tell.** Each lesson earns its keep with at least one interactive simulator the learner can poke at, plus real diagrams (SVG/canvas), not decorative clip art.
- **First principles.** Derive designs, don't assert them. "Here is a problem; here is the naive fix; here is why it breaks; here is the real design." Slotted pages, B+trees, WAL, MVCC should all feel inevitable by the end.
- **Grounded in real systems.** Pseudocode for algorithms, but always anchored to "here's how PostgreSQL/SQLite actually does it" with citations.
- **Retrieval practice every lesson.** The exam is MCQ-only, so each lesson ends with MCQ-style questions (4 options, immediate feedback, options kept equal length so formatting gives nothing away). Spaced/interleaved review where possible.
- **Papers matter.** Four assigned papers get a viva (oral defense). They get dedicated deep summaries plus an anticipated-question bank.

## Style constraints (from the humanizer skill)
- No em dashes or en dashes anywhere in prose. No emojis in headings. No title-case headings. No rule-of-three padding, no "vibrant tapestry" vocabulary, no fragmented headers that restate themselves.
- Plain, confident, technical voice. Vary sentence length. Prefer "is/are/has" over elaborate copula-avoidance.

## Format conventions
- One self-contained HTML lesson per syllabus week, `lessons/NNNN-slug.html`.
- All lessons share `assets/course.css` and `assets/components.js`. Reuse components; never inline-duplicate a widget.
- Reference docs in `reference/` are print-friendly cheat sheets.
- Research notes and methodology live in `research/`.
