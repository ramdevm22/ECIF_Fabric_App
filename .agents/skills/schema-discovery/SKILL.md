---
name: schema-discovery
description: >
  Discover Power BI semantic-model tables, columns, measures, relationships,
  and column statistics through the analytics pack's local SQLite catalog.
  Use advanced INFO queries only when the fixed catalog does not contain the
  required metadata.
---

# Schema discovery

## Use the analytics catalog

This skill is the schema-discovery route for the
[`analytics`](../analytics/SKILL.md) pack.

It is a preview capability and ships off. `schema:sql` exists only in an app
that opted in before applying the pack, so check `package.json` for the script
before planning around it. To turn it on, add the flag and re-apply:

```sh
# rayfin/.env
RAYFIN_FEATURE_FLAGS=schema-sqlite
```

```sh
npm run pack:add -- analytics
```

Without it, discover the model through the read-only queries in
[`discovery-queries.md`](./references/discovery-queries.md) instead, and say
that the catalog is unavailable rather than reporting the model as empty.

Apply the connectors and analytics packs, connect the intended semantic model,
then query the local catalog:

```sh
npm run --silent schema:sql -- "SELECT status, incomplete, notes FROM catalog_status"
npm run --silent schema:sql -- --search "requested business concept"
```

The first command builds the catalog automatically when it is missing or older
than 15 minutes.
An explicit rebuild is available when freshness matters:

```sh
npm run schema:refresh
```

One refresh runs five schema-only source queries from a hardcoded list, plus
retries if the model throttles:

- `INFO.VIEW.TABLES()`
- `INFO.VIEW.COLUMNS()`
- `INFO.VIEW.MEASURES()`
- `INFO.VIEW.RELATIONSHIPS()`
- `COLUMNSTATISTICS()`

The builder does not accept agent-supplied DAX.
Business-data queries cannot enter the catalog-build path.
After those five requests, discovery is read-only SQL against local SQLite.

This resolves the apparent conflict between full and progressive discovery.
The fixed sources are materialized once for local reuse, but each agent result
must still be a narrow SQL projection containing only evidence needed for the
current task.
Do not dump whole catalog tables into the conversation.

## Catalog contents

The database is `.schema/models/<itemId>/model.sqlite`.
Its tables preserve the model's native DAX column names:

| SQLite table | Contents |
| --- | --- |
| `catalog_status` | Persistent `complete` or `incomplete` build status and notes |
| `info_view_tables` | One row per semantic-model table |
| `info_view_columns` | One row per model column |
| `info_view_measures` | One row per shipped measure |
| `info_view_relationships` | One row per relationship |
| `column_statistics` | Actual Min/Max values, cardinality, and maximum text length |
| `semantic_search` | Searchable projection of tables, columns, measures, and relationships |

`column_statistics` is derived from real model rows.
The catalog is customer data, not metadata-only content.
The `.schema/` directory is gitignored and must never be copied, committed, or
exposed.

Read `.schema/models/<itemId>/catalog.md` once when orientation is needed.
It records every table and column and prominently marks an incomplete catalog.

## Completeness and truncation

Catalog completeness and SQL-result completeness are separate:

- `catalog_status.status = 'incomplete'` means at least one source view failed.
- `truncated: true` means the local SQL output was bounded by row count or byte size.
- `truncated: false` only means that one SQL result is complete.
  It does not prove the catalog itself is complete.

Always check `catalog_status` before using absence as evidence.
If the catalog is incomplete, read its notes and run `npm run schema:refresh`
once to retry.
Concurrent refreshes serialize per model and reuse a complete catalog built by
the process that won the lock.
An incomplete refresh never replaces an existing complete catalog.
If it remains incomplete, continue only with the views that are present and
state which evidence is missing.
Do not bypass an incomplete catalog with exploratory `INFO.VIEW.*` calls.

`complete` describes which source views answered, not how much of each one you
were allowed to see. `INFO.VIEW.MEASURES()` returns `Expression` only to a
caller with write permission, so on a model you have Build access to, measure
expressions can come back blank while the catalog still reads `complete`. Treat
a blank `[Expression]` as unknown rather than as proof the measure has no
definition, and say so instead of rebuilding its logic from physical columns.

A SQL result with `truncated: true` cannot be used to choose model objects or
author DAX.
Narrow the `WHERE` clause and, for ordinary catalog tables, the projection.
Queries selecting model tables automatically append compact owned-measure names
and display folders, so a narrower projection does not reduce that enrichment;
narrow the selected table rows instead.
Rerun until the needed evidence is in a result with `truncated: false`.
Do not use `--allow-truncated` during discovery or DAX authoring.

### Reading a single expression that is larger than the budget

One cell can exceed the byte budget on its own — localization measures built
from `SWITCH(USERCULTURE(), ...)` routinely run to tens of thousands of
characters.
Narrowing cannot help there: a single cell has nothing left to narrow, so the
same `SELECT` returns `totalRows: 1` with `returnedRows: 0` however often it is
repeated.

Read it in slices instead, and fetch the length first so the last offset is
known.
Use `length([Expression])` as the bound rather than the character count in the
search summary: `substr` offsets and `length` both count code points, while the
summary counts UTF-16 units, so the two disagree for text containing emoji.

```sh
npm run --silent schema:sql -- "SELECT length([Expression]) AS chars FROM info_view_measures WHERE [Table] = 'Sales' AND [Name] = 'Localized Label'"
npm run --silent schema:sql -- "SELECT substr([Expression], 1, 1000) AS part FROM info_view_measures WHERE [Table] = 'Sales' AND [Name] = 'Localized Label'"
npm run --silent schema:sql -- "SELECT substr([Expression], 1001, 1000) AS part FROM info_view_measures WHERE [Table] = 'Sales' AND [Name] = 'Localized Label'"
```

Use a stride of 1000 characters.
The budget is counted in bytes, not characters, so a stride that fits ASCII can
still be three or four times too large for CJK or emoji text.

Two conditions both have to hold, and the second is the one that is easy to get
wrong:

- Every chunk returns `returnedRows: 1` and `truncated: false`.
  `returnedRows: 0` means the slice was still too big — halve the stride and
  retry that offset.
- The offsets cover `1` through the full length with no gap.
  Stopping after one clean chunk looks like success, because the chunks that
  were fetched are all complete; only the coverage is missing.

Concatenate the parts in offset order to reconstruct the definition exactly.

## Discovery workflow

1. Query `catalog_status`.
2. Run a catalog-wide semantic search for the user's concepts.
3. Inspect candidate tables and their owned measures.
4. Query focused columns and measures for every selected table.
5. Query relationships connecting the selected tables.
6. Use column statistics only after the exact column is known.
7. Reuse prior catalog results instead of issuing equivalent SQL again.
8. Stop only when every requested output has an exact source mapping, and the
   shipped measures, grouping columns, relationship path, **filter grain** and
   **explicit filter values** are all grounded in untruncated results.

The catalog holds metadata and per-column extrema, not the distinct values in a
column. Once the filter column is known and a literal value still has to be
confirmed, ground it with one bounded query against the model rather than
looping on catalog SQL that cannot answer it:

```sh
npx rayfin connector invoke <alias> executeQuery --file <probe>.query.json
```

Test the literal you were given, so the answer is decisive:

```dax
EVALUATE
FILTER(VALUES('Geography'[Country]), 'Geography'[Country] = "France")
```

Zero rows means there is no exact match for that value; report that instead of
widening the search. If the probe errors, or the mapping is still unresolved
after it, report the blocker rather than broadening discovery. Do not sample a
column and read absence from the sample — `TOPN` over a column with more
distinct values than the bound returns a complete-looking partial answer. This
is a value check, not more discovery: ask it once, for a column you have
already selected.

Before writing any DAX, write down the output plan: every output field with its
exact source (a fully qualified column, or an exact shipped measure for every
business value), the filters and their values, the relationship path, and the
expected row shape. Then compare what the query returns against that plan.
A query that runs is not the same as a query at the right grain.

One grain trap is worth checking by name. When a measure counts a column —
`COUNT`, `DISTINCTCOUNT` or `DISTINCTCOUNTNOBLANK` over `'Table'[Column]` —
filtering or grouping by that same column, or by one that reaches it through an
active relationship, collapses the result to a trivial one per group. It
returns rows and looks correct. The catalog already holds both inputs: read the
measure's `[Expression]` from `info_view_measures` and the path from
`info_view_relationships` before committing to that filter. If two filter
columns remain plausible, compare them once with the shipped measures
unchanged.

Start with shipped measures.
Never reconstruct business logic from physical columns when the model already
ships a measure.
Column statistics are not a shortcut around that: `Min`, `Max` and
`Cardinality` are the raw column extent, ignoring filter context,
relationships, and any business rule the measure encodes. A cardinality that
happens to match an expected row count is not evidence that reading the column
is correct.
Helper, selector, calculation, and parameter tables may own the measure that
supplies a displayed value, so do not restrict the first search to a fact-table
prefix.

A selected table is not fully inspected until its owned measures have been
read. When such a table owns a measure that dispatches on its column — a
`SELECTEDVALUE` / `SWITCH` over the selector, for example — group by that
column and evaluate the shipped measure once instead of building one expression
per row out of similarly named physical columns. That recipe does not apply to
every helper: a native field-parameter table carries field references that the
client resolves, so grouping by its label does not swap the underlying field.
If the owned measures do not explain what the table is for, search measure
expressions for references to it before falling back to raw aggregation:

```sh
npm run --silent schema:sql -- "SELECT [Table], [Name] FROM info_view_measures WHERE [Expression] LIKE '%ParameterTable%'"
```

Selecting from `info_view_tables` automatically includes a bounded
`ownedMeasures` preview when `info_view_measures` is available.
The preview carries names and display folders only so it cannot consume the
result byte budget with repeated expressions.
Query `info_view_measures` for each selected table to read expressions,
descriptions, and format strings.
Review it before choosing raw columns.

## SQL examples

Search globally before narrowing:

```sh
npm run --silent schema:sql -- --search "revenue region comparison"
```

Search is an AND across names, descriptions, expressions, and display folders,
so prefer a few specific terms over a whole sentence.
When no object matches every term, terms that appear nowhere in the model are
dropped and the search is answered without them, and the result says which ones
were dropped.
A statement sourced with `--file` must live inside the app, and is labelled by
its path rather than by its contents.

Inspect candidate tables:

```sh
npm run --silent schema:sql -- "SELECT [Name], [Description], [IsHidden] FROM info_view_tables WHERE lower([Name]) LIKE '%sales%'"
```

Inspect shipped measures across selected tables in one statement:

```sh
npm run --silent schema:sql -- "SELECT [Table], [Name], [Expression], [Description], [FormatString], [DisplayFolder] FROM info_view_measures WHERE [Table] IN ('Sales', 'Date') ORDER BY [Table], [Name]"
```

Inspect columns only after selecting tables:

```sh
npm run --silent schema:sql -- "SELECT [Table], [Name], [DataType], [Description], [FormatString], [IsHidden] FROM info_view_columns WHERE [Table] IN ('Sales', 'Date') ORDER BY [Table], [Name]"
```

Inspect the relationship path:

```sh
npm run --silent schema:sql -- "SELECT [FromTable], [FromColumn], [ToTable], [ToColumn], [IsActive], [CrossFilteringBehavior] FROM info_view_relationships WHERE [FromTable] IN ('Sales', 'Date') OR [ToTable] IN ('Sales', 'Date')"
```

Inspect statistics for exact columns:

```sh
npm run --silent schema:sql -- "SELECT [Table Name], [Column Name], [Min], [Max], [Cardinality], [Max Length] FROM column_statistics WHERE [Table Name] = 'Date' AND [Column Name] IN ('Date', 'Year')"
```

Column names retain spaces and reserved words.
Quote them with SQL double quotes or square brackets.

## Batch several statements in one invocation

Each extra invocation costs a whole model round trip, and a round trip re-sends
the entire conversation.
The five statements above are normally run back to back, so run them together
instead.
`--search`, `--sql`, and `--file` are repeatable, and searches run before SQL:

```sh
npm run --silent schema:sql -- --search "revenue region comparison" --sql "SELECT [Name], [Description], [IsHidden] FROM info_view_tables WHERE lower([Name]) LIKE '%sales%'" --sql "SELECT [Table], [Name], [Expression], [Description], [FormatString], [DisplayFolder] FROM info_view_measures WHERE [Table] IN ('Sales', 'Date') ORDER BY [Table], [Name]"
```

The reply is one payload: a `#` header naming the batch, then a `##` label line
per statement followed by that statement's ordinary result block.
A failed statement stays in the payload beside the ones that worked, so a single
mistake does not cost the whole batch.

At most eight statements per invocation.
The whole batch shares one byte budget, so batching never costs more context
than a single statement would.
Ask everything you already know you need, but keep each statement narrow: the
shared budget is divided across them, and unused room rolls forward.

## Advanced metadata outside the catalog

The fixed catalog intentionally covers the common DAX-authoring path.
It does not include every elevated `INFO.*` function.

Only when the current task specifically requires calculation groups, calendars,
user-defined functions, variations, or model configuration should you use the
advanced read-only queries in
[`discovery-queries.md`](./references/discovery-queries.md).
Run the minimum advanced query needed through:

```sh
npx rayfin connector invoke <alias> executeQuery --file <query>.query.json
```

The file is a JSON operation input such as:

```json
{
  "query": "EVALUATE INFO.CALCULATIONGROUPS()"
}
```

Do not use advanced queries to re-fetch tables, columns, measures,
relationships, or column statistics already owned by the catalog.
If an elevated query fails with a permission error after catalog discovery
succeeded, mark elevated metadata unavailable and do not probe the remaining
elevated functions.

## Must, prefer, avoid

### Must

- Check `catalog_status` before treating absence as evidence.
- Bind every business value to an exact shipped measure, and every label or
  grouping to an exact column, before writing DAX. If exhaustive untruncated
  discovery finds no suitable measure, record which one is missing and the
  catalog evidence for that before using another source.
- Use fully qualified `'Table'[Column]` references in authored DAX.
- Use simple `[Measure]` references for measures.
- Keep every SQL result narrow and untruncated.
- Reuse discovered metadata.

### Prefer

- `--search` for the first semantic pass.
- Batching known statements into one invocation over separate calls.
- One SQL statement for several known metadata questions.
- Exact relationship paths and column statistics after candidate selection.

### Avoid

- Hand-running the catalog's five source queries.
- Progressive `INFO.VIEW.*` connector round trips.
- Whole-table SQL dumps.
- Re-fetching metadata already present in the catalog or conversation.
- Treating `truncated: false` as proof that an incomplete catalog is complete.
- Rebuilding a helper table's logic one row at a time from physical columns.
- Using unavailable `GetSemanticModelSchema`, `GenerateQuery`, or
  `DiscoverArtifacts` tools.
