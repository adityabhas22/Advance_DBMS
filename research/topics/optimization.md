# Query optimization

Course week 11. Topic cluster: query optimization.

This note covers why a query optimizer exists, how it estimates cost and selectivity, how it orders joins, the heuristic rewrites layered on top, the cost-based versus rule-based split, and how PostgreSQL and SQLite implement all of this. Formulas and constants are attributed to the source they come from, mostly the Selinger 1979 System R paper and the PostgreSQL documentation.

## 1. The core problem

A SQL query says what data you want, not how to get it. `SELECT name, title FROM emp, dept, job WHERE ... AND emp.dno = dept.dno AND emp.job = job.job` is a declarative statement. The engine has to turn it into a procedure: which table to scan first, whether to use an index or a full scan, which join algorithm to run, and in what order to join. The Selinger paper opens on exactly this point: the user states data "without reference to access paths," and "nor does a user specify in what order joins are to be performed" (Selinger et al. 1979, section 1).

Each of those choices is independent, so the number of distinct procedures (the plan space) explodes combinatorially. For a query over n relations the number of join orders alone is the number of orderings of n items. Selinger notes there are "n factorial permutations of relation join orders" for n relations in the FROM list (section 5). Multiply that by the choice of access path per relation (index scan on each available index, or a full scan) and the choice of join method per join (nested loop or merge), and the space is far too large to enumerate naively.

What breaks without an optimizer:

- The plans differ enormously in cost, not by a few percent. A query that picks an index scan plus a merge join might touch a few hundred pages; the same query as full scans plus a Cartesian product can touch billions. The same answer, off by orders of magnitude in work.
- A purely syntactic execution (run the FROM list left to right, evaluate WHERE last) would materialize huge intermediate results. Filtering after a cross product instead of before it is the classic catastrophe.
- Declarative SQL only stays declarative if some component is responsible for choosing well. Push that choice onto the application and you have re-invented a navigational database.

So the optimizer's job is to search the plan space and pick a plan that is cheap, using estimates of how much data each operation will produce and how much work each operator will do. It does not need the truly optimal plan; it needs to reliably avoid the disastrous ones. Selinger's own validation work found the predicted-optimal plan was "often not accurate in absolute value," but "in many cases, the ordering among the estimated costs ... was precisely the same as that among the actual measured costs" (section 7). Getting the ranking right is what matters.

## 2. Mechanisms

### 2.1 The cost model: IO plus CPU

System R's cost formula is a weighted sum of IO and CPU:

```
COST = PAGE FETCHES + W * (RSI CALLS)
```

PAGE FETCHES is the IO term (pages fetched). RSI CALLS is the number of tuples returned across the Research Storage System interface, which stands in for CPU because "most of System R's CPU time is spent in the RSS" (Selinger 1979, section 4). W is "an adjustable weighting factor between I/O and CPU." This single formula is the template every modern cost-based optimizer still follows: a cost is a number that blends IO pages and CPU work, tuned by weights, and plans are compared by that number. The unit is artificial; only relative ordering of plans matters.

The single-relation access cost formulas (Selinger Table 2) are worth knowing precisely, because they show how an index changes the IO term:

| Situation | Cost (in pages) |
|---|---|
| Unique index matching an equal predicate | `1 + 1 + W` |
| Clustered index I matching boolean factors | `F(preds) * (NINDX(I) + TCARD) + W * RSICARD` |
| Non-clustered index I matching boolean factors | `F(preds) * (NINDX(I) + NCARD) + W * RSICARD` |
| Clustered index, no matching factors | `(NINDX(I) + TCARD) + W * RSICARD` |
| Non-clustered index, no matching factors | `(NINDX(I) + NCARD) + W * RSICARD` |
| Segment (full) scan | `TCARD/P + W * RSICARD` |

Here TCARD is the number of data pages holding the relation's tuples, NCARD is its tuple cardinality, NINDX(I) is the number of pages in index I, and P is the fraction of data pages that actually hold tuples of this relation. The crucial structural point: a clustered index multiplies the selectivity F against `(NINDX + TCARD)` (touch the index plus the data pages, but only the selected fraction), while a non-clustered index uses `(NINDX + NCARD)` because in the worst case every selected tuple is on its own page, so the page count tracks the tuple count, not the page count. That difference (TCARD versus NCARD) is exactly why clustering matters and is a frequent exam target.

### 2.2 Selectivity estimation

Cost depends on how many rows each operator produces, so the optimizer must estimate, for each predicate, the fraction of rows that survive it. Selinger calls this the selectivity factor F. The cardinality of a query block is the product of input cardinalities times the product of the boolean factors' selectivities (section 4: query cardinality QCARD is "the product of the cardinalities of every relation ... times the product of all ... boolean factors").

System R's default selectivity factors (Selinger Table 1) are the canonical constants:

- `column = value`: `F = 1 / ICARD(column index)` if an index exists (ICARD is the number of distinct keys in that index), assuming an even distribution; otherwise `F = 1/10`.
- `column1 = column2` (join predicate): `F = 1 / max(ICARD(col1 index), ICARD(col2 index))` if both indexed, `1 / ICARD` if only one is indexed, else `1/10`.
- `column > value` (open-ended range): linear interpolation `F = (high key value - value) / (high key value - low key value)` if the column is arithmetic and the value is known at plan time; otherwise `F = 1/3`.
- `column BETWEEN value1 AND value2`: `F = (value2 - value1) / (high key - low key)` if arithmetic; otherwise `F = 1/4`.
- `column IN (list)`: `F = (number of items) * F(column = value)`, capped at `1/2`.
- `pred1 OR pred2`: `F = F(pred1) + F(pred2) - F(pred1) * F(pred2)`.
- `pred1 AND pred2`: `F = F(pred1) * F(pred2)`. Selinger states plainly: "Note that this assumes that column values are independent."
- `NOT pred`: `F = 1 - F(pred)`.

Two assumptions are baked in and both are named in the paper:

1. Uniformity. `F = 1/ICARD` for equality assumes "an even distribution of tuples among the index key values." Real columns are skewed (a few values dominate), so this can be badly wrong for hot values and too pessimistic for rare ones.
2. Independence. The AND rule multiplies selectivities, which is only correct if the columns are uncorrelated. Correlated predicates (`city = 'Pittsburgh' AND state = 'PA'`) make the product a large underestimate, because the second predicate adds almost no extra filtering once the first holds.

### 2.3 Histograms

To attack the uniformity failure, modern systems replace the single `1/ICARD` constant with a histogram of the column's distribution. Two layouts:

- Equi-width histogram: the value range is divided into buckets of equal width, each bucket counts how many rows fall in it. Simple to build, but a skewed column dumps most rows into one bucket, so within-bucket estimates are still poor exactly where the data is dense.
- Equi-depth (equi-height) histogram: bucket boundaries are chosen so each bucket holds roughly the same number of rows. Dense regions get many narrow buckets, sparse regions get few wide ones. This puts resolution where the data is, which is why production systems prefer it.

PostgreSQL uses an equi-depth histogram for the bulk of the distribution plus a separate most-common-values (MCV) list for the spikes. The histogram is built only from values not already captured as MCVs, so the two structures partition the column: MCVs handle the skew, the histogram handles the smooth tail. The PostgreSQL row-estimation examples show the histogram as a list of bucket boundaries, for example `{0,993,1997,3050,...,9995}` for 10 equi-depth buckets, and a range predicate is estimated by locating the value in a bucket and interpolating within it (PostgreSQL docs, "Row Estimation Examples"). Their worked formula for `unique1 < 1000`:

```
selectivity = (1 + (1000 - 993)/(1997 - 993))/10 = 0.100697
rows = 10000 * 0.100697 = 1007
```

The `(1 + ...)/10` form counts one full bucket below the value plus the interpolated fraction of the straddled bucket, divided by the bucket count.

### 2.4 Join ordering and the Selinger dynamic program

Join trees come in two shapes:

- Left-deep: every join's inner (right) input is a base relation; the tree leans left, `((A join B) join C) join D`. The intermediate result is always a single growing composite that can be pipelined.
- Bushy: a join's inner input can itself be a join result, `(A join B) join (C join D)`. This exposes more plans (some cheaper) but the search space is larger and intermediate results may need to be materialized.

System R restricts the search to left-deep orderings. The justification is in the join section: n-way joins are built as a sequence of 2-way joins where at each step the inner relation being added is identified, and "the first 2-way join does not have to be completed before the second 2-way join is started" only in the pipelining sense. The optimizer materializes intermediate composites "only if a sort is required." Restricting to left-deep keeps one composite in flight at a time.

The core algorithm is dynamic programming over subsets of relations, exploiting a substructure property the paper states directly: "once the first k relations are joined, the method to join the composite to the k+1-st relation is independent of the order of joining the first k" (section 5). So the cheapest way to produce a given set of relations in a given output order can be computed once and reused. The procedure:

1. For each single relation, find the cheapest access path (per interesting order, see below, plus the cheapest unordered path).
2. For each pair, find the cheapest way to join them, using the single-relation solutions as building blocks.
3. For each set of three, extend the best two-relation solutions by joining the remaining relation. And so on up to all n.
4. At the top, pick the cheapest complete solution that delivers any required output order.

The cost of a nested-loop join in this scheme is `C-outer(path1) + N * C-inner(path2)` where N is the number of outer tuples satisfying the predicates; a merge-scan join is `C-outer(path1) + N * C-inner(path2)` with the inner being a contiguous scan of the matching group (section 5). The state stored is "at most 2**n (the number of subsets of n tables) times the number of interesting result orders," so the table size is exponential in n but the constant is small, and Selinger reports "joins of 8 tables have been optimized in a few seconds" on a 370/158.

Two pruning heuristics shrink the space further:

- Cartesian products are pushed as late as possible. The search only considers join orders where each newly added relation has a join predicate connecting it to a relation already in the composite, "or" it has no predicate with any later relation. Concretely, for `T1.T2.T3` with predicates between T1-T2 and T2-T3, the orders `T1-T3-T2` and `T3-T1-T2` are not considered, because they would force a T1xT3 cross product.

### 2.5 Interesting orders

A sort order is "interesting" if a later operator could exploit it: the query's `ORDER BY` or `GROUP BY` columns, and every join column (Selinger: "every join column defines an interesting order"). The DP normally keeps only the single cheapest plan per relation-subset, but it must keep, in addition, the cheapest plan for each interesting order even if that plan is not the globally cheapest unordered plan. The reason: a plan that produces tuples already sorted on a join column lets a later merge join skip its sort, which can pay for a more expensive scan now. Equivalence classes of orders are computed (if `D.dno = F.dno` is a predicate then those columns share an order class) so the optimizer keeps one best plan per class rather than per literal column. This is the subtle bookkeeping that makes the System R optimizer more than a naive least-cost search, and it is the contribution the paper itself highlights in its conclusion.

### 2.6 Heuristic rewrites versus cost-based search

Above the cost-based search sits a layer of transformations that are almost always good, so they are applied as rewrites rather than costed:

- Predicate pushdown (selection pushdown): move a `WHERE` filter as close to the base table scan as possible, so rows are discarded before they enter joins. Filtering early shrinks every downstream input. This is the single highest-value rewrite.
- Projection pushdown: drop columns that are not needed downstream as early as possible, so intermediate tuples are narrower and more fit per page.
- Join elimination: remove a join entirely when it cannot change the result, for example a join to a table on a foreign key that is guaranteed present and whose columns are not otherwise referenced, or a join whose only purpose was a uniqueness-guaranteed lookup.

Rule-based versus cost-based is the historical dividing line. A rule-based (heuristic) optimizer applies a fixed priority list of transformations with no cost estimate: for example, "prefer an index over a full scan, always." It is cheap and predictable but blind to data, so it picks an index even when the predicate matches most of the table (where a full scan is cheaper). A cost-based optimizer (System R and every serious modern engine) estimates the cost of alternatives and picks the cheapest, which requires statistics but adapts to the data. Modern systems are cost-based at their core and use heuristics only for the transformations that are unconditionally safe (the pushdowns above).

## 3. How real systems do it

### 3.1 PostgreSQL

PostgreSQL is cost-based with a Selinger-style dynamic-programming join search, plus a genetic fallback for large joins.

Statistics live in the catalog `pg_statistic`, exposed through the readable view `pg_stats`. The relevant columns (PostgreSQL docs, "Statistics Used by the Planner"):

- `null_frac`: fraction of the column that is NULL.
- `avg_width`: average value width in bytes.
- `n_distinct`: number of distinct values, with a sign-based encoding. A positive value is the literal count of distinct values. A negative value is the count expressed as a fraction of the table's row count; in particular `n_distinct = -1` means every value is distinct (the count tracks the row count exactly, so a growing table stays fully distinct), and `-0.5681108` means about 56.8 percent of rows have a distinct value. The negative form exists so the estimate stays valid as the table grows.
- `most_common_vals` and `most_common_freqs`: the MCV list and their frequencies, capturing skew.
- `histogram_bounds`: the equi-depth histogram boundaries for the non-MCV portion.
- `correlation`: how closely physical row order matches sorted column order, used to decide whether an index scan will hit pages sequentially or randomly.

These are populated by `ANALYZE` (and `VACUUM ANALYZE`), which samples rows rather than reading the whole table, so the values are "always approximate even when freshly updated." `ANALYZE` also refreshes `reltuples` and `relpages` in `pg_class`, the raw row and page counts the cost formulas multiply selectivity against. The number of MCV slots and histogram buckets per column is governed by `default_statistics_target`, default 100, settable per column with `ALTER TABLE ... SET STATISTICS`.

Worked estimation examples from the PostgreSQL docs, all over a 10000-row table (`tenk1`, `relpages 358`, `reltuples 10000`):

- Equality on an MCV (`stringu1 = 'CRAAAA'`): selectivity is just that value's stored frequency, `mcf = 0.003`, so `rows = 10000 * 0.003 = 30`.
- Equality not in the MCV list (`stringu1 = 'xxx'`): the leftover probability spread over the leftover distinct values, `selectivity = (1 - sum(mcv_freqs)) / (num_distinct - num_mcv) = (1 - 0.03033...)/(676 - 10) = 0.0014559`, so `rows = 15`.
- Two ANDed predicates (`unique1 < 1000 AND stringu1 = 'xxx'`): multiplied under independence, `0.100697 * 0.0014559 = 0.0001466`, so `rows = 1`. This is exactly the independence assumption from Selinger, and PostgreSQL names it as such.
- Join (`t1.unique2 = t2.unique2`, both with `n_distinct = -1`): `selectivity = (1 - null_frac1)(1 - null_frac2) / max(num_rows1, num_rows2) = 1/max(10000,10000) = 0.0001`.

To attack the independence failure, PostgreSQL supports extended (multivariate) statistics created with `CREATE STATISTICS`, which can store n-distinct counts and functional-dependency information across column groups so correlated predicates are not naively multiplied.

Join search: for a FROM list with fewer than `geqo_threshold` items (default 12) PostgreSQL runs the near-exhaustive dynamic program. At 12 or more FROM items the genetic query optimizer (GEQO, on by default) takes over, because the factorial growth of join orders makes exhaustive search infeasible. GEQO encodes a join order as an integer string (a chromosome, for example `4-1-3-2`), treats finding a good order as a Traveling Salesman style problem, generates a population of random orders, costs each with the standard cost model as the fitness function, and breeds better orders with edge-recombination crossover over several generations. It is a non-exhaustive heuristic search: it trades a guarantee of the best plan for a planning time that does not blow up (PostgreSQL docs, "Genetic Query Optimizer").

Inspecting plans: `EXPLAIN` prints the chosen plan tree with estimated row counts and costs; `EXPLAIN ANALYZE` actually runs the query and prints estimated versus actual rows, which is how you catch a bad selectivity estimate (a large gap between estimated and actual rows is the tell).

### 3.2 SQLite

SQLite is also cost-based but deliberately lightweight, built around nested-loop joins only. The documentation states "SQLite implements joins as nested loops," with the left-most FROM table as the outer loop and the right-most as the inner, so its plans are left-deep nested-loop plans. It does not implement hash or merge joins.

Join ordering uses the Next Generation Query Planner (NGQP), described as "an efficient polynomial-time graph algorithm," which lets SQLite "plan queries with 50- or 60-way joins in a matter of microseconds." This is the key contrast with PostgreSQL: rather than exponential DP with a genetic fallback, SQLite uses a polynomial heuristic graph search throughout, accepting that it may miss the optimal order in exchange for never being slow to plan.

Statistics come from the `ANALYZE` command and are stored in tables whose names begin with `sqlite_stat`:

- `sqlite_stat1`: per-index average selectivity for equality constraints, for example "an equality constraint on column x reduces the search space to 10 rows on average."
- `sqlite_stat4` (requires the `SQLITE_ENABLE_STAT4` compile option): a histogram of column content used for range-query selectivity. The older `sqlite_stat3` stored histogram data for only the left-most column of an index; `sqlite_stat4` records it for all columns of the index. Without these, SQLite falls back to fixed selectivity guesses much like System R's defaults.

`EXPLAIN QUERY PLAN` is SQLite's analog to PostgreSQL `EXPLAIN`, showing which indexes and join order were chosen.

## 4. Common exam traps and misconceptions

These are the false statements an MCQ would offer, with why each is false.

- "The optimizer finds the optimal execution plan." False. It finds a good plan under estimated costs. Selinger's own validation says the predicted optimal "is often not accurate in absolute value"; the goal is correct relative ranking and avoiding disasters, not provable optimality.
- "Cost is measured in seconds." False. Cost is a unitless weighted number (`PAGE FETCHES + W * RSI CALLS` in System R, abstract cost units in PostgreSQL). Only relative comparison between plans is meaningful.
- "An index scan is always faster than a full table scan, so the optimizer always prefers an index." False. For low-selectivity predicates that match most rows, a non-clustered index scan touches roughly one page per matching tuple (`NINDX + NCARD`) and loses to a full scan (`TCARD/P`). The optimizer compares costs; a rule-based optimizer that always picks the index is the broken case.
- "Clustered and non-clustered indexes have the same scan cost." False. Clustered uses `(NINDX + TCARD)` (data pages), non-clustered uses `(NINDX + NCARD)` (tuple count) because matching tuples can be scattered one per page. The TCARD-versus-NCARD swap is the whole point of clustering.
- "System R / the classic optimizer searches all join trees including bushy trees." False. It restricts to left-deep trees (inner input is always a base relation) to keep one pipelined composite in flight. Bushy plans exist in some modern systems but were excluded by System R.
- "The independence assumption means predicate selectivities are added." False. Under independence, ANDed selectivities are multiplied (`F1 * F2`); ORed selectivities use `F1 + F2 - F1*F2`. Independence is also exactly the assumption that fails on correlated columns, causing underestimates.
- "Equi-width and equi-depth histograms are the same thing." False. Equi-width buckets have equal value ranges and unequal row counts; equi-depth buckets have equal row counts and unequal value ranges. Equi-depth handles skew far better, which is why PostgreSQL uses it.
- "`n_distinct = -1` in PostgreSQL means the statistic is missing or unknown." False. It means the column is fully distinct (one distinct value per row); the negative encoding expresses the count as a fraction of table size so it survives table growth.
- "PostgreSQL always uses dynamic programming for join ordering." False. Below `geqo_threshold` (default 12) it uses near-exhaustive DP; at or above it, the genetic optimizer (GEQO) takes over with heuristic search.
- "Predicate pushdown is a cost-based decision." False. Pushdown, projection pushdown, and join elimination are heuristic rewrites applied unconditionally because they are essentially always beneficial; they are not costed alternatives.
- "More statistics (higher default_statistics_target) is free." False. Larger MCV lists and histograms improve estimates for skewed data but cost more space in `pg_statistic` and more ANALYZE and planning time. It is a tradeoff, default 100.
- "Interesting orders are only about the final ORDER BY." False. Every join column also defines an interesting order, because producing tuples pre-sorted on a join column lets a downstream merge join skip its sort.

## 5. Good simulator ideas

Concrete interactive widgets for teaching this, each with something the learner manipulates and something they observe.

1. Selectivity and histogram playground. The learner edits a column's value distribution by dragging bars (make it uniform, then skew it so a few values dominate). The widget overlays an equi-width and an equi-depth histogram with an adjustable bucket count, and shows the estimated row count for a predicate the learner types (`x = 7`, `x < 50`, `x BETWEEN 10 AND 20`) next to the true count computed from the underlying data. The payoff the learner sees: uniform data makes both histograms accurate; skewed data makes equi-width wildly wrong in the dense bucket while equi-depth stays close. A second predicate plus an AND toggle reveals the independence error when the two columns are made correlated (estimated rows collapse below actual).

2. Join-order dynamic-programming visualizer. The learner picks 3 to 5 tables with editable cardinalities and a join graph (which pairs have predicates). The widget animates the System R DP filling its table level by level: singletons, then pairs, then triples, showing the cheapest plan and cost for each subset and which partial plans get pruned (Cartesian-product orders struck out, dominated plans discarded). The learner toggles "keep interesting orders" on and off and watches a merge-join plan that needs a sort either survive or get pruned, then sees the final plan flip. They observe directly that the chosen left-deep order depends on cardinalities and the join graph, not on FROM-clause order.

3. EXPLAIN cost-tradeoff sandbox. The learner is given one table and one predicate and a slider for the predicate's selectivity (fraction of rows matched). The widget computes and plots, on the same axes, the cost of a full scan (`TCARD/P`), a clustered index scan, and a non-clustered index scan (`NINDX + NCARD * F`) as the slider moves, and highlights which plan wins at each point. The crossover where the index stops being worth it is the lesson: the learner watches the optimal plan switch from index to full scan as selectivity grows, which kills the "index is always faster" misconception by construction.

## 6. Citations

- Selinger, Astrahan, Chamberlin, Lorie, Price, "Access Path Selection in a Relational Database Management System," ACM SIGMOD 1979. https://people.eecs.berkeley.edu/~brewer/cs262/3-selinger79.pdf . Primary source. The original System R optimizer: the `COST = PAGE FETCHES + W * RSI CALLS` model, Table 1 selectivity factors and default constants (`1/10`, `1/3`, `1/4`), Table 2 single-relation access cost formulas, the dynamic-programming join search, left-deep restriction, interesting orders, and the n factorial plan-space argument. Fetched and read in full.
- PostgreSQL documentation, "Statistics Used by the Planner." https://www.postgresql.org/docs/current/planner-stats.html . Authoritative. The `pg_statistic` / `pg_stats` columns (`null_frac`, `n_distinct`, `most_common_vals`, `histogram_bounds`, `correlation`), the sign-based `n_distinct` encoding including `-1`, what `ANALYZE` does, and `default_statistics_target` (default 100).
- PostgreSQL documentation, "Row Estimation Examples." https://www.postgresql.org/docs/current/row-estimation-examples.html . Authoritative. Worked selectivity arithmetic: MCV equality, non-MCV equality `(1 - sum(mcf))/(num_distinct - num_mcv)`, histogram range interpolation, ANDed-predicate independence multiplication, and the join selectivity formula with `null_frac` and `max(num_rows)`.
- PostgreSQL documentation, "Genetic Query Optimizer." https://www.postgresql.org/docs/current/geqo-pg-intro.html . Authoritative. GEQO as a non-exhaustive genetic search, join orders encoded as integer-string chromosomes, TSP framing, edge-recombination crossover.
- PostgreSQL documentation, "Query Planning" runtime configuration. https://www.postgresql.org/docs/current/runtime-config-query.html . Authoritative. `geqo` default on, `geqo_threshold` default 12 FROM items.
- SQLite documentation, "The SQLite Query Optimizer Overview." https://www.sqlite.org/optoverview.html . Authoritative. Nested-loop-only joins, the Next Generation Query Planner polynomial-time graph algorithm for 50-to-60-way joins, and the `sqlite_stat1` / `sqlite_stat4` statistics tables (stat4 histograms across all index columns, requires `SQLITE_ENABLE_STAT4`).
- CMU 15-445/645 Intro to Database Systems (Fall 2023), Andy Pavlo and Jignesh Patel. Schedule: https://15445.courses.cs.cmu.edu/fall2023/schedule.html . Teaching reference. Lecture 14, "Query Planning and Optimization," covers cost models and estimation with public slides, notes, and video.

## 7. Glossary terms

- Plan space: the set of all distinct execution plans (access paths, join methods, join orders) for one query. Exponential in the number of relations.
- Access path: a way to retrieve tuples of one relation, either a full (segment) scan or a scan of a specific index.
- Selectivity factor (F): the estimated fraction of rows surviving a predicate, between 0 and 1. Multiplies cardinality to estimate output rows.
- Cardinality: the number of rows in a relation or intermediate result.
- Cost model: a function mapping a plan to a comparable number, typically a weighted sum of IO page fetches and CPU work (`PAGE FETCHES + W * RSI CALLS` in System R).
- Uniformity assumption: the assumption that all distinct values of a column occur equally often, making equality selectivity `1/(distinct count)`. Fails on skewed columns.
- Independence assumption: the assumption that predicates on different columns are uncorrelated, so ANDed selectivities multiply. Fails on correlated columns, causing underestimates.
- Equi-width histogram: buckets covering equal value ranges; row counts per bucket vary. Poor on skew.
- Equi-depth histogram: buckets each holding roughly equal row counts; value ranges vary. Resolution concentrates where data is dense. Used by PostgreSQL.
- Most-common-values (MCV) list: a stored list of a column's most frequent values and their exact frequencies, capturing skew that a histogram smooths over.
- Clustered index: an index whose order matches the physical order of the table's data pages, so a range scan touches data pages sequentially (cost tracks page count, TCARD).
- Non-clustered index: an index whose order is independent of physical row placement, so matching tuples may be one per page (cost tracks tuple count, NCARD).
- Left-deep join tree: a join tree in which every join's inner input is a base relation; allows a single pipelined composite. The System R search restriction.
- Bushy join tree: a join tree in which a join's inner input may itself be a join result; larger search space, may need materialization.
- Dynamic programming (Selinger) join search: build the cheapest plan for each subset of relations bottom up, reusing the property that the best way to extend a composite is independent of how the composite was built.
- Interesting order: a tuple sort order a later operator could exploit (ORDER BY, GROUP BY, or any join column). The optimizer keeps the cheapest plan per interesting order even if not globally cheapest.
- Predicate pushdown: moving a selection as close to the base scan as possible to filter rows before they enter joins.
- Projection pushdown: dropping unneeded columns early so intermediate tuples are narrower.
- Join elimination: removing a join that cannot affect the result, for example a guaranteed foreign-key lookup whose columns are unused.
- Cost-based optimizer: chooses plans by estimating and comparing costs using statistics. System R, PostgreSQL, SQLite.
- Rule-based optimizer: applies a fixed priority list of transformations with no cost estimate; blind to data distribution.
- pg_statistic / pg_stats: the PostgreSQL catalog table (and its readable view) holding per-column statistics used by the planner.
- n_distinct: PostgreSQL's distinct-value statistic; positive is a literal count, negative is a fraction of table size, `-1` means fully distinct.
- ANALYZE: the command that samples a table and populates the planner statistics (`pg_statistic` in PostgreSQL, `sqlite_stat*` in SQLite).
- default_statistics_target: PostgreSQL setting (default 100) controlling the number of MCV slots and histogram buckets per column.
- GEQO: PostgreSQL's genetic query optimizer, a heuristic non-exhaustive join search used when the FROM list reaches `geqo_threshold` (default 12) items.
- NGQP: SQLite's Next Generation Query Planner, a polynomial-time graph algorithm for join ordering.
- EXPLAIN: the command that prints a query's chosen plan with estimated rows and costs; `EXPLAIN ANALYZE` adds actual measured values.
