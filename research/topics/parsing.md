# Query parsing and logical plans

Course week 8. Research note for the "front of the pipeline" between the raw SQL string and the optimizer.

This sits at the very start of the engine. The parser and binder hand the optimizer a clean, name-resolved, type-checked tree that says *what* the query asks for. Everything downstream (optimizer, executor, access methods, buffer pool, disk) is about turning that *what* into an efficient *how*. If this stage gets anything wrong, every later stage is operating on a lie.

## 1. The core problem

A SQL statement arrives as a flat string of bytes: `SELECT name FROM emp WHERE salary > 75000`. The engine cannot execute a string. It needs a structured object it can walk, validate against the database, and rewrite into operators.

Several distinct things break if you skip this stage or do it naively.

- **No structure.** A string has no notion of "this is the WHERE predicate" or "this expression is the argument of that function." You cannot push a predicate down a join if you do not know which token sequence is the predicate. Structure has to be recovered from the grammar before any reasoning is possible.
- **Ambiguous names.** `emp` might mean `public.emp` for one user and `hr.emp` for another, because of search paths and defaults. `name` might be a column of `emp`, a column of a joined table, an alias, or a function. Without name resolution against the catalog, the same query text means different things to different sessions, and the engine cannot tell which table or column a reference points at.
- **No types.** `salary * 1.15` is meaningless until you know `salary` is an integer, a float, or a money type. The data type drives which multiplication operator and which comparison get used. Without type information the engine cannot pick operator implementations or even decide the query is well formed.
- **Lies about what exists.** If you let a query reach the executor referencing a table or column that does not exist, or that the user has no permission to read, you either crash deep in execution or leak data. Catching this early, against the catalog, is a correctness and security requirement.
- **No optimizable form.** The optimizer reasons over relational algebra (selections, projections, joins, aggregates). SQL text is not algebra. Someone has to translate `SELECT ... FROM ... WHERE ...` into an algebra tree, expand views, and normalize it so equivalent queries reach the optimizer in a comparable shape.

So the front of the pipeline exists to convert text into a validated, name-resolved, typed, algebra-shaped object. The standard decomposition, used by PostgreSQL and described in the "Architecture of a Database System" survey, is: lex, parse to a raw syntax tree, semantically analyze and bind, rewrite, then translate to a logical plan. The deliberate split between pure syntax parsing and catalog-aware analysis matters: PostgreSQL separates them because "system catalog lookups can only be done within a transaction" (PostgreSQL parser-stage docs). Pure syntax checking needs no transaction; binding does.

## 2. Mechanisms

### Lexing (tokenizing)

The lexer (scanner) reads the character stream and emits a stream of tokens: keywords (`SELECT`), identifiers (`emp`), literals (`75000`, `'foo'`), operators and punctuation (`>`, `,`, `(`). Whitespace and comments are recognized and discarded. SQLite's documentation lists exactly these token classes and notes that "Whitespace and comment tokens are discarded; all others proceed to the parser" (sqlite.org howitworks).

A lexer is a finite automaton. Each token class is described by a regular expression; the union of those regexes compiles to a DFA that runs in time linear in the input length, O(n) over the characters, with O(1) work per character. Tools like `flex` (used by PostgreSQL, file `scan.l`) generate this DFA as C code. The lexer also handles the lexical hazards of SQL: case folding of keywords, the distinction between a keyword and an identifier that merely looks like one, and quoted identifiers.

Keyword-versus-identifier collision is a real design point. SQL has many keywords, and treating every keyword as reserved would forbid users from naming a column `name` or `value`. SQLite's Lemon grammar uses *fallback tokens*: a token first tried as a keyword can "fall back" to being an identifier when the grammar context demands it (sqlite.org lemon). This keeps the reserved-word set smaller than the keyword set.

### Parsing to a syntax tree

The parser consumes the token stream and, guided by a context-free grammar, builds a tree that encodes the syntactic structure. There are two dominant strategies.

**Recursive descent (top-down, LL).** One function per grammar nonterminal; the call stack mirrors the parse tree. It is hand-written, easy to read, easy to attach good error messages to, and easy to special-case. Its classic weakness is left recursion: a rule like `expr := expr '+' term` makes the function call itself with no input consumed, looping forever. Left recursion must be rewritten into iteration or right recursion. Expression precedence is usually handled with a precedence-climbing or Pratt sub-parser rather than pure descent.

**Table-driven bottom-up (LR / LALR(1)).** A generator (`bison`/`yacc`, or SQLite's `Lemon`) computes parse tables from the grammar. The parser runs a shift-reduce loop driven by those tables: it shifts tokens onto a stack and reduces stack tops to nonterminals when a grammar rule's right-hand side is matched. LALR(1) accepts a larger grammar class than LL, handles left recursion natively, and runs in O(n) over the token stream. The cost is that grammar conflicts (shift/reduce, reduce/reduce) are reported in terms of the generated automaton, which is harder to debug than a hand-written descent parser, and the generated tables are opaque.

Whichever strategy is used, parsing itself is a fixed-rules operation. The PostgreSQL docs state the invariant directly: "The parser stage creates a parse tree using only fixed rules about the syntactic structure of SQL. It does not make any lookups in the system catalogs" (PostgreSQL parser-stage docs). The output is a *raw parse tree* (also called an abstract syntax tree, AST): nodes for the statement, its target list, its FROM items, its WHERE expression tree, and so on. At this point names are still just strings and nothing has been checked against the database.

Grammar actions build the tree. In a bison grammar the grammar rule's action is C code that allocates nodes; the PostgreSQL docs note "the code of the actions (which is actually C code) is used to build up the parse tree." Complexity of this whole step is O(n) in input size for the LALR machine plus O(size of tree) for node allocation.

### Semantic analysis and binding

This is where the catalog enters. Binding (PostgreSQL calls it *analysis* or *transformation*; CMU calls the component the *binder*) walks the raw tree and turns it into a validated, typed *query tree*. The "Architecture of a Database System" survey lists four parser/analysis tasks: (1) check the query is correctly specified, (2) resolve names and references, (3) convert the query into the optimizer's internal format, and (4) verify the user is authorized (section 4.1).

Concretely:

- **Table-name canonicalization.** Each FROM reference is expanded to a fully qualified name. The survey describes the canonical form as a four-part name `server.database.schema.table`, reduced to `database.schema.table` or `schema.table` in simpler systems, because users rely on context-dependent defaults and aliases (section 4.1). Aliases are substituted with the fully qualified name.
- **Existence check.** The analyzer calls the catalog manager to confirm each table is registered, and caches table metadata in the query's internal structures. Then it checks that every attribute reference is a real column of an in-scope table.
- **Type checking and overload resolution.** Column data types drive disambiguation of overloaded operators, functions, and literals. The survey's example: in `(EMP.salary * 1.15) < 75000`, the actual multiplication and comparison code, and the assumed type of the literals `1.15` and `75000`, depend on whether `EMP.salary` is integer, float, or money (section 4.1). PostgreSQL shows the same mechanism: a `FuncCall` node from the raw tree "might be transformed to either a `FuncExpr` or `Aggref` node depending on whether the referenced name turns out to be an ordinary function or an aggregate function," and the analyzer adds "information about the actual data types of columns and expression results" (PostgreSQL parser-stage docs).
- **Structural semantic checks.** Consistent use of tuple variables, union-compatibility of set operations (`UNION`/`INTERSECT`/`EXCEPT`), legal use of attributes in the SELECT list of aggregate queries, correct subquery nesting (section 4.1).
- **Authorization.** Confirm the user holds the needed privilege (SELECT/INSERT/UPDATE/DELETE) on each referenced object. The survey notes some checks must be deferred to execution when they are data-dependent, for example row-level security (section 4.1).

The output is the *query tree*. PostgreSQL: "The data structure that is built to represent this information is called the query tree," and it "is structurally similar to the raw parse tree in most places, but it has many differences in detail," with types attached (PostgreSQL parser-stage docs).

### Query rewrite

The rewriter simplifies and normalizes the query *without changing its meaning*. It "can rely only on the query and on metadata in the catalog, and cannot access data in the tables," and "most rewriters actually operate on an internal representation of the query, rather than on the original SQL statement text," emitting that same internal format (section 4.2). Its main jobs, per the survey:

- **View expansion.** For each view in FROM, fetch the view definition from the catalog and splice its tables and predicates into the query, substituting column references, applied recursively until no views remain (section 4.2). This is the rewriter's traditional core job and the reason PostgreSQL's rewrite stage exists: the docs say the rewrite system's most important use is "the realization of views" by rewriting queries against virtual tables to hit base tables (PostgreSQL query-path docs).
- **Constant arithmetic folding.** `R.x < 10+2+R.y` becomes `R.x < 12+R.y` (section 4.2).
- **Logical predicate rewriting.** `NOT Emp.Salary > 1000000` becomes `Emp.Salary <= 1000000` to match index access methods; provably contradictory predicates like `salary < 75000 AND salary > 1000000` collapse to `FALSE`, which can return an empty result without touching the data; transitivity adds implied predicates, for example `R.x < 10 AND R.x = S.y` suggests adding `S.y < 10` (section 4.2).
- **Semantic optimization.** Use integrity constraints from the catalog. The headline example is redundant-join elimination: a join to a table whose columns are never used, where a foreign key guarantees exactly one matching parent row, can drop that table and the join entirely (section 4.2).
- **Subquery flattening / normalization.** Because optimizers usually optimize one SELECT-FROM-WHERE block at a time, the rewriter flattens nested queries into a single block where possible and rewrites equivalent queries into a canonical form so they optimize identically. SQL makes this tricky around duplicates, NULLs, and correlation (section 4.2).

Note the architectural point from the survey: rewrite is a *logical* component. DB2 has a stand-alone rewriter; SQL Server folds rewriting into an early phase of the optimizer. The boundary is conceptual, not always a separate module (section 4.2).

### Translating to a logical plan

The validated, rewritten query tree is turned into a *logical plan*: a tree of relational-algebra operators. CMU states it plainly: "The logical plan is roughly equivalent to the relational algebra expressions in the query" (CMU 15-445 Lecture 15). Operators are the algebra primitives: selection (filter, sigma), projection (column list, pi), cross product and join, grouping/aggregation, set operations, sort, and limit. A simple `SELECT name FROM emp WHERE salary > 75000` maps to projection(name) over selection(salary > 75000) over scan(emp).

The logical plan says only *what* relation to produce. It does not say how to scan `emp` (sequential scan? index scan?), which join algorithm to use, or in what order to join. That is the physical plan's job.

### The logical/physical boundary

This is one of the most tested distinctions in the topic.

- A **logical plan** is an algebra expression: it specifies the operators and their dataflow, independent of how each operator runs. Two logical plans are *equivalent* when they always produce the same set of tuples (CMU 15-445 Lecture 14/15). Equivalences (selection pushdown, projection pushdown, join reordering, join associativity and commutativity) are exactly the rewrites the optimizer is allowed to make because they preserve results.
- A **physical plan** binds each logical operator to a concrete algorithm and access path: sequential scan vs index scan, nested-loop vs hash vs merge join, plus physical properties like sort order and partitioning. CMU: "Physical operators define a specific execution strategy using an access path," and "Physical plans may depend on the physical format of the data" (CMU 15-445 Lecture 15).
- **There is no one-to-one mapping** from logical to physical. One logical join can become a hash join or a merge join; one logical scan can become a seq scan or any of several index scans. CMU states it outright: "There does not always exist a one-to-one mapping from logical to physical plans" (CMU 15-445 Lecture 15).

The optimizer is the thing that searches physical plans for a logical query and picks the cheapest. Two broad strategies exist (CMU 15-445 Lecture 15): rule/heuristic-based (match query patterns, apply transformations like predicate pushdown; consult the catalog for structure but never read the data) and cost-based (enumerate equivalent plans, estimate cost from statistics, pick the minimum). Most real systems combine them: heuristic logical rewrites first, then cost-based physical selection.

## 3. How real systems do it

### PostgreSQL

PostgreSQL's "path of a query" has five stages: connection, parser, rewrite system, planner/optimizer, executor (PostgreSQL query-path docs). The parsing front matters here.

- **Lexer**: defined in `scan.l`, compiled to `scan.c` by `flex`. It is "responsible for recognizing identifiers, the SQL key words etc." (PostgreSQL parser-stage docs). Do not edit the generated C; it is regenerated.
- **Grammar/parser**: defined in `gram.y`, compiled to `gram.c` by `bison`. It "consists of a set of grammar rules and actions," and the action C code builds the raw parse tree. This is a bottom-up LALR parser, the bison default.
- **Raw parse tree**: built using fixed syntactic rules only, with no catalog access (PostgreSQL parser-stage docs). This is the key reason the parse is split from analysis: the raw parse needs no transaction.
- **Analysis / transformation**: turns the raw parse tree into a *Query tree*. This is where catalog lookups happen, types are attached, and nodes change kind (the `FuncCall` to `FuncExpr`/`Aggref` example). In the source this is the `parse_analyze` path and the `transform*` functions; the docs describe it as "the transformation process" producing the query tree (PostgreSQL parser-stage docs).
- **Rewrite system**: applies rules from the system catalogs to the query tree. Its headline job is view realization, rewriting references to virtual tables into base-table access (PostgreSQL query-path docs).
- **Planner/optimizer**: turns the rewritten query tree into a plan. It searches over *paths*, which are "cut-down representations of plans containing only as much information as the planner needs," then "a full-fledged plan tree is built to pass to the executor" once the cheapest path is chosen (PostgreSQL planner-optimizer docs). When the number of joins exceeds `geqo_threshold` (default 12), PostgreSQL switches from near-exhaustive join-order search to the Genetic Query Optimizer (PostgreSQL planner-optimizer docs).

So the PostgreSQL chain is: string -> (flex) tokens -> (bison `gram.y`) raw parse tree -> (analyze) Query tree -> (rewrite) Query tree -> (plan) Plan tree -> executor.

### SQLite

SQLite compiles SQL to bytecode for a virtual machine, then runs the bytecode (sqlite.org howitworks). Translating SQL to a prepared statement is "analogous to converting a C++ program into machine code."

- **Tokenizer**: source file `tokenize.c`. Splits text into keyword, identifier, punctuation, literal, and whitespace/comment tokens; discards whitespace and comments (sqlite.org howitworks).
- **Parser**: an LALR(1) parser generated by *Lemon* from `parse.y`. "Lemon generates an LALR(1) parser" (sqlite.org lemon). It "analyzes the structure of the input program and generates an Abstract Syntax Tree (AST)" (sqlite.org howitworks).
- **Why Lemon, not yacc**: the calling direction is inverted. "In Lemon, the tokenizer calls the parser. Yacc operates the other way around, with the parser calling the tokenizer. The Lemon approach is reentrant and threadsafe, whereas Yacc uses global variables and is therefore neither" (sqlite.org lemon). Reentrancy matters because SQLite parses recursively: parsing `CREATE TABLE` invokes the parser again to generate the `INSERT` into `sqlite_schema` (sqlite.org lemon). Lemon also has nonterminal `%destructor`s to reclaim resources on a syntax error, and fallback tokens for keyword/identifier collisions.
- **Code generator**: described as "the heart of SQLite." It does symbol resolution (matching names to real database objects, which is SQLite's binding step), AST-level optimization, algorithm selection, and bytecode emission (sqlite.org howitworks). SQLite does not expose a separately materialized relational-algebra logical plan the way a textbook draws it; binding, rewriting, optimization, and code generation are interleaved in the code generator that walks the AST and emits VDBE bytecode.
- **Output**: the bytecode is the *prepared statement*. `EXPLAIN` in front of a statement prints this bytecode (sqlite.org howitworks).

The contrast worth holding: PostgreSQL keeps explicit, separately named tree stages (raw parse tree, Query tree, plan tree) and a tree-walking iterator executor; SQLite collapses analysis-through-codegen into one pass and executes a flat bytecode program on a register VM. Both start identically: tokenizer then grammar-driven parser then an AST.

## 4. Common exam traps and misconceptions

These are framed as the false statements an MCQ would offer, with why each is wrong.

- **False: "The parser checks that the tables and columns referenced in the query exist."** The pure parser does not. It applies only syntactic rules and makes no catalog lookups; existence and name resolution happen in the later analysis/binding step. PostgreSQL is explicit that the parse stage "does not make any lookups in the system catalogs" (PostgreSQL parser-stage docs). The trap conflates parsing with binding.
- **False: "Catalog lookups can be done during parsing because the catalog is just another table."** Catalog lookups require a transaction, which is why PostgreSQL separates raw parsing (no transaction needed) from analysis (PostgreSQL parser-stage docs). That separation is a design reason, not an accident.
- **False: "A logical plan specifies which join algorithm and access method to use."** Those are physical decisions. A logical plan is relational algebra: it says join, not hash-join; scan, not index-scan. The physical plan binds the algorithms (CMU 15-445 Lecture 15).
- **False: "Every logical operator maps to exactly one physical operator."** No. One logical join maps to nested-loop, hash, or merge join; one logical scan maps to sequential or several index scans. CMU: "There does not always exist a one-to-one mapping from logical to physical plans" (CMU 15-445 Lecture 15).
- **False: "Query rewrite reads table data to decide how to simplify the query."** The rewriter uses only the query and the catalog (constraints, view definitions), never the table data (section 4.2). Reading data and estimating cost is cost-based optimization, a different stage.
- **False: "Query rewrite can change the result set if it makes the query faster."** Rewrite must preserve semantics. It "simplifies and normalizes the query without changing its semantics" (section 4.2). A rewrite that changed results would be a bug.
- **False: "Recursive descent parsers handle left-recursive grammars directly."** They do not. Left recursion sends a recursive-descent function into infinite recursion without consuming input; the grammar must be refactored. LALR/LR parsers handle left recursion natively.
- **False: "LALR parsers are top-down; recursive descent is bottom-up."** Reversed. Recursive descent is top-down (LL); LALR/LR is bottom-up shift-reduce.
- **False: "SQLite uses yacc/bison for its parser."** SQLite uses Lemon, which generates LALR(1) and, unlike yacc, has the tokenizer call the parser, making it reentrant and threadsafe (sqlite.org lemon).
- **False: "View expansion happens in the optimizer / cost model."** View expansion is a rewrite-stage job, driven by catalog view definitions, not by cost (section 4.2; PostgreSQL query-path docs). It runs before cost-based optimization.
- **False: "The parser produces the physical execution plan."** The parser produces a syntax tree; analysis produces a typed query tree; rewrite normalizes it; only the optimizer produces a plan, and only its physical form binds execution strategy.
- **False: "Predicate pushdown is a physical optimization."** Pushing a selection below a join is a logical, algebra-equivalence rewrite that transforms one logical plan into an equivalent logical plan (CMU 15-445 Lecture 15). The physical step is choosing algorithms after pushdown.

## 5. Good simulator ideas

Three interactive widgets that make this stage tangible, in line with "show, don't just tell."

1. **Lexer / parser tracer.** The learner types a SQL statement into a box. Pane one shows the token stream as colored chips (keyword, identifier, literal, operator), with whitespace and comments visibly dropped, so the regex-to-token step is concrete. Pane two animates the parse: for the LL view, show the recursive-descent call stack growing and shrinking; toggle to an LR view that shows the shift-reduce stack with shift and reduce steps. Pane three renders the resulting AST tree. The payoff is watching a flat string become a tree, and seeing why a left-recursive expression rule loops in the LL view but reduces cleanly in the LR view. The learner manipulates the SQL and the parser mode; they observe tokens, the parse stack, and the tree.

2. **Binder against a toy catalog.** Give the learner a small fixed catalog (a couple of tables with typed columns, one view, simple privileges) shown in a side panel. They edit a query; the simulator runs binding and highlights each step: table names canonicalized to schema.table, each column reference resolved or flagged red as "no such column," each expression annotated with its inferred type, and overloaded operators resolved (show `salary * 1.15` picking integer vs float multiply when they flip the column's declared type). Introduce a permission toggle so an unauthorized table reference flags an authorization error. The learner manipulates the query text, column types, and privileges; they observe resolution, type annotations, and the precise stage where an invalid query fails (syntactically valid but semantically rejected).

3. **Logical-plan rewrite playground, with a physical reveal.** Show the relational-algebra tree for a query (projection over selection over join). The learner drags a selection node to push it below the join, or toggles "expand view," "fold constants," "eliminate redundant join," and watches the tree change while a counter confirms the result set is unchanged (semantics preserved). A final toggle "show physical options" expands each logical operator into its candidate physical operators (the join offers nested-loop, hash, merge; the scan offers seq vs index), driving home the no one-to-one-mapping point. The learner manipulates rewrite rules and which physical operator each logical node binds to; they observe the algebra tree, an estimated cost number per choice, and the invariant that rewrites preserve results while physical choices only change cost.

## 6. Citations

- PostgreSQL, "The Parser Stage." https://www.postgresql.org/docs/current/parser-stage.html . Primary source for: flex `scan.l`, bison `gram.y`, the rule that parsing makes no catalog lookups, the raw parse tree vs the query tree, and the `FuncCall` to `FuncExpr`/`Aggref` transformation example. Verified by fetch.
- PostgreSQL, "The Path of a Query." https://www.postgresql.org/docs/current/query-path.html . Primary source for the five stages (connection, parser, rewrite, planner/optimizer, executor) and the rewrite system's role in realizing views. Verified by fetch.
- PostgreSQL, "Planner/Optimizer." https://www.postgresql.org/docs/current/planner-optimizer.html . Source for the path-vs-plan distinction and the `geqo_threshold` default of 12 joins. Verified by fetch.
- SQLite, "Architecture of SQLite" / how it works. https://www.sqlite.org/howitworks.html . Source for the tokenizer (`tokenize.c`), the LALR(1) parser producing an AST, the code generator doing symbol resolution and bytecode generation, and the prepared statement output. Verified by fetch.
- SQLite, "The Lemon Parser Generator." https://www.sqlite.org/lemon.html . Source for Lemon generating LALR(1), the tokenizer-calls-parser reentrancy difference from yacc, recursive parsing of `CREATE TABLE`, `%destructor`, and fallback tokens. Verified by fetch.
- Hellerstein, Stonebraker, Hamilton, "Architecture of a Database System," Foundations and Trends in Databases 1(2), 2007. https://dsf.berkeley.edu/papers/fntdb07-architecture.pdf . Section 4.1 for the four parser/authorization tasks and four-part name canonicalization; section 4.2 for the query rewrite responsibilities (view expansion, constant folding, predicate logic, semantic optimization, subquery flattening). Verified by extracting and reading the PDF text.
- CMU 15-445/645, Lecture 15, "Query Planning & Optimization" (Fall 2024). https://15445.courses.cs.cmu.edu/fall2024/notes/15-optimization.pdf . Source for the logical-plan-equals-relational-algebra statement, the no one-to-one mapping between logical and physical plans, the heuristic-vs-cost-based strategies, and predicate/projection pushdown as logical rewrites. Verified by extracting and reading the PDF text.

## 7. Glossary terms

- **Token**: the smallest meaningful lexical unit of SQL (keyword, identifier, literal, operator, punctuation) produced by the lexer.
- **Lexer / scanner / tokenizer**: the finite-automaton stage that turns the character stream into a token stream and discards whitespace and comments. In PostgreSQL it is `scan.l` compiled by flex.
- **Grammar (context-free grammar)**: the set of production rules that define the syntactic structure of valid SQL.
- **Recursive descent (LL) parser**: a top-down, usually hand-written parser with one function per nonterminal; cannot handle left recursion without refactoring.
- **LALR(1) / LR parser**: a bottom-up, table-driven shift-reduce parser generated from a grammar by tools like bison or Lemon; handles left recursion natively.
- **Shift-reduce**: the bottom-up parsing loop that shifts tokens onto a stack and reduces stack tops to nonterminals when a rule's right-hand side matches.
- **Raw parse tree / AST (abstract syntax tree)**: the tree produced by the parser using only syntactic rules, before any catalog lookup; names are still strings and types are unknown.
- **Binding / analysis / transformation**: the catalog-aware stage that resolves names, checks existence, infers types, resolves overloads, checks authorization, and produces the query tree.
- **Query tree**: PostgreSQL's name for the post-analysis structure, structurally similar to the raw parse tree but with names resolved and types attached.
- **Name resolution**: mapping an unqualified reference (a table or column name, or an alias) to a specific catalog object, including canonicalization to a fully qualified name.
- **Type checking / overload resolution**: using column data types to choose the correct operator and function implementations and to type literals and expressions.
- **Authorization check**: verifying the user holds the required privilege on each referenced object; may be partly deferred to execution for data-dependent rules.
- **Query rewrite**: the semantics-preserving normalization stage (view expansion, constant folding, predicate logic, semantic optimization, subquery flattening) that uses only the query and the catalog, never the data.
- **View expansion**: replacing a view reference with the view's underlying tables and predicates, applied recursively until no views remain.
- **Redundant join elimination**: dropping a joined table whose columns are unused when a foreign key guarantees exactly one matching row, an example of semantic optimization.
- **Predicate pushdown**: a logical rewrite that moves a selection below a join so filtering happens before the more expensive operator.
- **Projection pushdown**: a logical rewrite that drops unused columns early to shrink intermediate tuples.
- **Logical plan**: a relational-algebra operator tree specifying *what* result to compute, independent of execution strategy.
- **Physical plan**: a plan that binds each logical operator to a concrete algorithm and access path (seq vs index scan, nested-loop vs hash vs merge join) plus physical properties like sort order.
- **Relational-algebra equivalence**: two expressions are equivalent when they always produce the same set of tuples; the legal basis for logical rewrites.
- **Path (PostgreSQL)**: a lightweight, cut-down representation of a candidate plan that the planner searches over before building the full plan tree.
- **GEQO (Genetic Query Optimizer)**: PostgreSQL's heuristic join-order search used when the number of joins exceeds `geqo_threshold` (default 12).
- **Prepared statement (SQLite)**: the VDBE bytecode program produced by SQLite's code generator from the AST, viewable with `EXPLAIN`.
- **Lemon**: SQLite's LALR(1) parser generator; reentrant and threadsafe because the tokenizer calls the parser, unlike yacc.
