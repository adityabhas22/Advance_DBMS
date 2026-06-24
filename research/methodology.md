# How this course was built

This file is the honest account of how the Field Guide was made: the thinking, the research, and the machinery. The goal was a complete set of study notes for a 16-week Advanced DBMS course that a learner could read on their own and come away with intuitive mastery, not 16 disconnected topics. Two skills shaped the work: `teach` (the workspace structure and the pedagogy) and `humanizer` (the prose).

## The brief, restated

The learner already knows what a database, an index, and a transaction are, but not deeply. They wanted four things in every lesson: simulators they can play with, real diagrams, good first-principles explanations, and a sense of how the whole engine fits together. The graded assessment is an MCQ exam plus a viva (oral defense) on four assigned papers. Everything below serves those constraints.

## Principles

A few decisions drove the rest.

Never trust parametric memory. The `teach` skill is explicit that knowledge should come from high-trust sources, not from a model's recall. So the first phase read the actual papers and grounded every topic in PostgreSQL and SQLite documentation and the CMU 15-445 course. The research notes in `research/` are the ground truth the lessons were written against.

Tie the picture together. The single most requested outcome was connective tissue. That produced two artifacts: `course-spine.md`, which threads one running query and one running transaction through all 16 weeks, and `index.html`, which is a map of the whole engine where every box links to the lesson that explains it. Every lesson opens by locating itself on that map.

Make the designs feel inevitable. Each lesson follows the same first-principles arc: here is the problem, here is the naive fix, here is why it breaks, here is the real design, here are the edge cases. The slotted page, the B+tree, write-ahead logging, and MVCC are all introduced as the answer to a pressure, not as a definition to memorize.

Build for retrieval, because the exam is MCQ. Every lesson ends with multiple-choice questions that grade themselves in the browser, including the "which statement is false" framing that exams favor. The four papers get a dedicated viva question bank.

Consistency through a shared design system. All 16 lessons link one stylesheet and one component library. A fixed color code maps each subsystem to a color (storage is clay, the buffer pool is amber, indexes are teal, and so on) so the same color always means the same layer. That visual constancy is itself connective tissue.

## The pipeline

The work was parallelized across agents in two workflow phases, so the slow part (reading, writing, drawing) happened many times at once rather than one after another.

Phase 1, research and planning (`research/_wf_research.js`). Fourteen agents ran. Four read the assigned papers from their extracted text: the Architecture survey (chapters 1 to 4), Volcano, Bigtable, and ARIES. Nine covered topic clusters aligned to the weeks: storage, buffer pool, indexing, parsing, execution, optimization, transactions, concurrency, and modern and distributed systems. Each produced a structured note with the mechanism, how real systems do it, the common exam traps, simulator ideas, verified citations, and glossary terms. A final planning agent read all of that and produced two things: the course spine and 16 per-lesson blueprints. A blueprint fixes the hook, the first-principles arc, the one simulator to build, the diagrams, the MCQ themes, the primary source, and which research notes ground the lesson.

Phase 2, the build (`research/_wf_build.js`). The 16 lessons ran through a two-stage pipeline. The first stage wrote the lesson: it read the template, its blueprint, the spine, and its grounding research, then authored a complete self-contained HTML file with a working simulator. The second stage was an editor and QA pass on the same file: it ran the humanizer rules over the prose (no em dashes, no promotional vocabulary, sentence-case headings), checked the simulator JavaScript for undefined references and balance, confirmed every MCQ had a valid answer and explanation, and fixed problems in place. Because it is a pipeline and not a barrier, a lesson could be in the editing stage while another was still being written. After the lessons, eight reference cheat sheets were built in parallel, including the MCQ exam bank and the viva preparation for the four papers.

After both phases, a mechanical verification pass extracted every inline script from every lesson and checked it for syntax errors, then the lessons were cross-linked and the glossary consolidated.

## Why a design system came first

Sixteen agents writing HTML independently would normally produce sixteen different-looking documents. To prevent that, the stylesheet, the component library, and a fully-worked template were authored before any lesson. The template doubles as documentation: it shows the exact markup for every component (callouts, the MCQ widget, flashcards, the simulator panel, figures, the navigation footer) and includes one real working simulator built on the shared stepper helper. Each lesson agent read the template first and built from it, so the lessons cohere.

The component library (`assets/components.js`) is small and dependency-free. It auto-wires the declarative widgets (MCQs and flashcards need no per-lesson JavaScript) and gives simulators a few reusable building blocks: a DOM builder, an SVG builder, a deterministic random number generator so demos replay identically, and a stepper that drives play, step, and reset controls. Keeping the shared code small meant each simulator could be bespoke without each agent reinventing the controls.

## What is in the repository

The lessons and reference docs are the product. The `research/` directory is the working material: the paper and topic notes, the spine, the blueprints, this methodology, and the two workflow scripts that orchestrated everything. Anyone can read the scripts to see exactly how the agents were prompted and how the phases fit together. The raw extracted paper text was processed locally and is not committed, since the papers are copyrighted; the notes summarize and cite them.

## How to continue

This is a teaching workspace, so it is meant to keep growing. To add or revise a lesson, edit its blueprint in `research/blueprints/manifest.json` and re-run the relevant stage of the build workflow, or edit the HTML directly. New shared widgets belong in `assets/`, not inline in a lesson. When the learner demonstrates understanding of something non-obvious, that belongs in a learning record under `learning-records/`. The glossary is the canonical vocabulary; keep the lessons faithful to it.
