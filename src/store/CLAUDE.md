# CLAUDE.md — `src/store/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Persistence

- **A column added to an _existing_ table needs an additive `ALTER TABLE`**, guarded by
  `PRAGMA table_info` and declared in the owning module's `ColumnMigrations`. `CREATE TABLE IF NOT
EXISTS` never alters an existing table, so a column without an `ensureColumns` entry is invisible on
  every database from before it existed. A table being new **once** does not keep it exempt. A
  _renamed_ table needs a `TableRename` entry applied **before** the schema pass.
  → [14](../../docs/spec/14-persistence.md#migrations), [rename](../../docs/spec/14-persistence.md#renaming-a-table)
- **A partial unique index whose predicate changes must be dropped by name first.** `CREATE UNIQUE
INDEX IF NOT EXISTS` never re-predicates an index that already exists, so widening the statuses a
  lock covers — `remote_runs_open`'s `WHERE status IN ('pending', 'dispatched')` — leaves every
  database from before the change still enforcing the old predicate, and lets through exactly the
  clash the index exists to refuse. A status is a **column value** and needs no `ALTER TABLE`; the
  index over it is schema. → [14](../../docs/spec/14-persistence.md#a-partial-index-predicate-is-not-idempotent),
  [36](../../docs/spec/36-remote-validation.md#a-runs-status-vocabulary)
- **A column whose _null means something_ needs a backfill as well**, gated on `ensureColumns`' report of what it added.
  `pets.opened_at` null spells "still an egg", so the column alone turns every existing vivarium back into shells; a
  backfill on _every_ boot opens the eggs operators were saving. →
  [14](../../docs/spec/14-persistence.md#when-a-null-means-something)
- **A new issue-verdict writer goes through `IssueVerdictStore.recordVerdict`, never a hand-rolled `DELETE`.** Which
  verdict tables may coexist is declared once in `src/store/verdicts.ts`; a writer that clears its siblings itself
  silently reintroduces the pairwise drift the matrix replaced. →
  [14](../../docs/spec/14-persistence.md#issue-verdicts-and-the-exclusion-matrix)
