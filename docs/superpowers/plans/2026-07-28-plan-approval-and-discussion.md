# Plan Approval, the Plan Modal, and Discussing a Plan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn plan approval on by default, widen what a plan carries so the approval is worth giving, put the whole plan behind a button reachable from anywhere, and let an operator argue with a planning agent until the decomposition is right.

**Architecture:** Four additive slices over machinery that already exists. The approval gate (`planning.requireApproval`), the proposal that carries it, rule 3d that asks, and rule 4a's `unapproved` hold all ship already — this changes a default, adds five optional document fields, adds a shared cockpit modal owned by the app shell and opened through the skin seam, and models "Discuss" as a **Replan with a conversational planner** so it inherits every existing dispatch gate rather than adding one.

**Tech Stack:** TypeScript (ESM, `nodenext`, explicit `.js` import extensions), Fastify, better-sqlite3, zod, React 18 + Vite, `node:test` via `tsx`.

## Global Constraints

- **ESM with explicit `.js` import extensions in every import**, even from `.ts` sources: `import { Store } from './store/store.js';`. New files must follow this or module resolution breaks.
- **Comments explain _why_, not _what_.** Match the surrounding terse, high-signal style. Do not narrate code.
- **The verification command is `npm run check`** = `format:check && lint && typecheck && typecheck:web && knip && test`. Run it before every commit.
- **`knip` runs with every rule at `error`.** An `export` nothing imports, a **type** nothing names, or a **public class member** nothing calls turns `check` red. The usual fix for a reported type is to **drop the `export` keyword**, not delete it.
- **Two typecheckers.** `typecheck` (server, `tsconfig.json`) and `typecheck:web` (cockpit, `web/tsconfig.json`) are separate passes; a change spanning `src/` and `web/` must satisfy both.
- **`format:check` is Prettier.** Fix with `npm run format`, never by hand. On Windows this may report nearly every file as failing — that is a CRLF false alarm; verify the real signal with `npx prettier --check <the files you changed>`.
- **Run a single test file** with `node --import tsx --test test/<name>.test.ts`.
- **`CREATE TABLE IF NOT EXISTS` never alters an existing table.** Any column added to `plans` or `plan_parts` needs an `ensureColumns` entry in `Store.migrate()` (`src/store/store.ts:82-104`). CLAUDE.md currently says these tables need no `migrate()` entry — that was true when they were new and is false for columns added now. Task 11 fixes that line.
- **Domain types are separate by design.** `src/types.ts` (server) and `web/src/types.ts` (cockpit) are intentionally duplicated; the web bundle must not import server code. A field added to one usually needs adding to the other.
- **`test/cockpitSkins.test.ts` holds a byte-for-byte golden of the classic skin's markup** (`test/fixtures/classic-markup.html`). Any change to classic's DOM — including a change to `web/src/demo/fixtures.ts`, which feeds it — fails that test until regenerated with `UPDATE_GOLDEN=1 npm test`. Regenerate in the same commit as the DOM change and eyeball the diff.
- **No skin may import `web/src/api.ts`.** `test/cockpitSkins.test.ts` asserts it structurally. Every mutation goes on the `CockpitActions` interface (`web/src/cockpit/actions.ts`) and is implemented in `web/src/cockpit/useCockpit.ts`.
- **Never render agent-authored text with `dangerouslySetInnerHTML`.**

---

## File Structure

**Created**

| Path                               | Responsibility                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plans/planDiscussion.ts`      | Pure helpers for the discussion arm: the summary a discussion agent is primed with, and the predicate deciding whether a plan is in discussion. |
| `web/src/components/markdown.ts`   | Pure markdown-subset → React nodes renderer. No HTML interpretation, no dependency.                                                             |
| `web/src/components/PlanModal.tsx` | The shared plan modal: tabs, parts, write-up, verdict buttons, discussion pane.                                                                 |
| `test/planDiscussion.test.ts`      | The discussion arm end to end.                                                                                                                  |
| `test/markdown.test.ts`            | The renderer, pure.                                                                                                                             |

**Modified**

| Path                                                                                            | Change                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/config.ts:375`                                                                             | `requireApproval: false` → `true`.                                                                                                                                             |
| `src/plans/planning.ts:47-52`                                                                   | `DEFAULT_PLANNING.requireApproval` → `true`; update the doc comment above `requireApproval`.                                                                                   |
| `src/plans/planDocument.ts`                                                                     | Five optional fields on the zod schemas; `planPartInputs` carries the two part-level ones.                                                                                     |
| `src/types.ts`                                                                                  | `Plan` gains `risks`/`outOfScope`/`document`/`discussing`; `PlanPart` gains `rationale`/`acceptance`; `PlanPartInput` widens.                                                  |
| `src/store/schema.ts:173-206`                                                                   | New columns on both `CREATE TABLE`s (for fresh databases).                                                                                                                     |
| `src/store/store.ts`                                                                            | `ensureColumns` entries for both tables (for existing databases); `upsertPlan`, `upsertPlanParts`, `rowToPlan`, `rowToPlanPart` carry the new fields; new `setPlanDiscussing`. |
| `src/plans/planIngest.ts`                                                                       | Pass the new document fields through to the store; clear `discussing` on ingest.                                                                                               |
| `src/mcp/tools.ts:129-209`                                                                      | `plan_submit`'s input schema gains the five fields.                                                                                                                            |
| `src/dispatcher/promptTemplates.ts`                                                             | `issue-plan` / `issue-replan` demand the new fields; new `discuss-plan` entry.                                                                                                 |
| `src/dispatcher/ruleDispatcher.ts:551-615`                                                      | Rule 3c renders `discuss-plan` when the plan is in discussion.                                                                                                                 |
| `src/server/app.ts`                                                                             | Two new routes; `buildStateSnapshot` needs no change (it ships whole rows).                                                                                                    |
| `web/src/types.ts`                                                                              | Mirror the new `Plan` / `PlanPart` fields.                                                                                                                                     |
| `web/src/api.ts`                                                                                | `discussPlan`, `endPlanDiscussion`.                                                                                                                                            |
| `web/src/cockpit/actions.ts`                                                                    | `viewPlan`, `discussPlan`, `endPlanDiscussion` on `CockpitActions`.                                                                                                            |
| `web/src/cockpit/useCockpit.ts`                                                                 | `viewingPlan` state; implement the three actions; expose `viewingPlan` on the view model input.                                                                                |
| `web/src/view/viewModel.ts`                                                                     | Carry `viewingPlan` through to the view.                                                                                                                                       |
| `web/src/App.tsx`                                                                               | Render `PlanModal` off the shell.                                                                                                                                              |
| `web/src/components/EscalationCard.tsx`                                                         | "View plan" button on a `plan` proposal.                                                                                                                                       |
| `web/src/components/PlanPanel.tsx`                                                              | "view" button per plan card.                                                                                                                                                   |
| `web/src/skins/factory/components/TechTree.tsx`                                                 | "view" button per plan.                                                                                                                                                        |
| `web/src/skins/classic/ClassicRoot.tsx`                                                         | Thread `onViewPlan` into `PlanPanel` and `EscalationCard`; issue pickup chip becomes a button when the issue has a plan.                                                       |
| `web/src/skins/factory/FactoryRoot.tsx`                                                         | Thread `onViewPlan` into `TechTree`.                                                                                                                                           |
| `web/src/styles.css`                                                                            | Append the `.plan-modal` block.                                                                                                                                                |
| `web/src/demo/fixtures.ts`                                                                      | An `awaiting_approval` plan with the new fields, its proposal and escalation, `unapproved` queue items.                                                                        |
| `test/planPart.test.ts:418-422`                                                                 | Pin `requireApproval: false` explicitly; add the inverted default assertion.                                                                                                   |
| `test/planIngestion.test.ts`                                                                    | Round-trip the new fields on both transports.                                                                                                                                  |
| `docs/spec/08-planning.md`, `14-persistence.md`, `16-http-api.md`, `17-cockpit.md`, `CLAUDE.md` | Documentation.                                                                                                                                                                 |

---

## Task 1: Approval on by default

**Files:**

- Modify: `src/config.ts:375`
- Modify: `src/plans/planning.ts:22-32` (doc comment), `src/plans/planning.ts:47-52` (`DEFAULT_PLANNING`)
- Test: `test/planApproval.test.ts`, `test/planPart.test.ts:418-422`

**Interfaces:**

- Consumes: nothing.
- Produces: `DEFAULT_PLANNING.requireApproval === true`. Every later task assumes a `parts` verdict lands `awaiting_approval` unless a test pins it off.

- [ ] **Step 1: Write the failing test**

Append to `test/planApproval.test.ts` (it already imports `DEFAULT_PLANNING` at line 12 and `loadConfig` at line 7):

```ts
test('approval is on by default, in both places that default it', () => {
  // Two sites default this and they must agree: the config loader is what a
  // deployment gets, `DEFAULT_PLANNING` is what a `RuleDispatcher` constructed
  // without one gets. A drift between them is a gate that is on for the harness
  // and off for the dispatcher, which reads as "the rule never fires".
  assert.equal(DEFAULT_PLANNING.requireApproval, true);
  assert.equal(loadConfig().planning.requireApproval, true);
  // Off is still reachable and still means what it meant.
  assert.equal(loadConfig({ planning: { requireApproval: false } }).planning.requireApproval, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/planApproval.test.ts`
Expected: FAIL — `Expected values to be strictly equal: false !== true`.

- [ ] **Step 3: Flip both defaults**

`src/config.ts:375` — change `requireApproval: false` to `requireApproval: true`:

```ts
  planning: { enabled: false, maxConcurrentPartsPerIssue: 2, requireApproval: true, gitFetchIntervalMs: 60_000 },
```

`src/plans/planning.ts` — in `DEFAULT_PLANNING`:

```ts
export const DEFAULT_PLANNING: PlanningPolicy = {
  enabled: false,
  maxConcurrentPartsPerIssue: 2,
  requireApproval: true,
  gitFetchIntervalMs: 60_000,
};
```

- [ ] **Step 4: Rewrite the doc comment above `requireApproval`**

Replace the existing comment at `src/plans/planning.ts:21-32` with:

```ts
/**
 * Put a `parts` verdict to a human before anything is scheduled from it
 * (issue #109 phase 3). **On by default** — which changes nothing for a
 * deployment that has not enabled the funnel, because `enabled` is still off.
 * It only decides what happens once they do, and the thing being defaulted is
 * whether a decomposition into N branches and N agents starts itself.
 *
 * On, ingestion persists a `parts` verdict as `awaiting_approval` instead of
 * `active`, rule `plan-approval` puts it to the operator once, and rule 4a
 * schedules nothing until they accept — approve-before rather than replan-after,
 * which is the undo we built in place of this gate. A `single` verdict is never
 * gated: it is the status quo path and proposes nothing.
 */
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test test/planApproval.test.ts`
Expected: PASS.

- [ ] **Step 6: Fix the test that relied on the old default**

`test/planPart.test.ts` builds a system whose plan must reach `active` for its parts to dispatch, and asserts at lines 418-422 that no proposal was written. With the default flipped, that plan now lands `awaiting_approval` and the whole test fails.

Find the `loadConfig({...})` call in that test that sets `planning: { enabled: true, ... }` and add `requireApproval: false` to it. Then replace the comment and assertion at lines 418-422 with:

```ts
// `requireApproval` is pinned off above, which is *not* the default any more:
// this is the ungated path, where an `active` plan is released work and the
// approval gate writes nothing at all (issue #109 phase 3). The default's
// behaviour is asserted in `planApproval.test.ts`; asserted here on the
// existing path so the two arms are covered separately.
assert.deepEqual(system.store.listProposals(), []);
assert.deepEqual(system.store.listOpenEscalations(), []);
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS. If another test fails with a plan stuck at `awaiting_approval`, it is relying on the old default the same way — pin `requireApproval: false` in its config and note why in a comment.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/plans/planning.ts test/planApproval.test.ts test/planPart.test.ts
git commit -m "Plan approval is on by default"
```

---

## Task 2: The plan document carries more than four fields

**Files:**

- Modify: `src/plans/planDocument.ts:23-33` (`PartSchema`), `:42-48` (`PlanDocumentSchema`), `:154-163` (`planPartInputs`)
- Modify: `src/types.ts:678-690` (`Plan`), `:701-723` (`PlanPart`, `PlanPartInput`)
- Modify: `src/store/schema.ts:173-206`
- Modify: `src/store/store.ts:82-104` (`migrate`), `upsertPlan` (425-460), `upsertPlanParts` (628-668), and the `rowToPlan` / `rowToPlanPart` mappers
- Modify: `src/plans/planIngest.ts:70` (the `upsertPlan` call)
- Test: `test/planIngestion.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces:

  - `Plan` gains `risks: string | null`, `outOfScope: string | null`, `document: string | null`.
  - `PlanPart` gains `rationale: string | null`, `acceptance: string | null`.
  - `PlanPartInput = Pick<PlanPart, 'slug'|'seq'|'title'|'scope'|'dependsOn'|'rationale'|'acceptance'>`.
  - `MAX_PLAN_DOCUMENT_CHARS = 60_000` exported from `src/plans/planDocument.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/planIngestion.test.ts`:

```ts
test('the widened plan document round-trips through ingestion', () => {
  const store = new Store(':memory:');
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
      reason: 'the signer must exist before the route verifies one',
      risks: 'part 2 briefly serves artifacts with no guard',
      outOfScope: 'capability revocation',
      document: '# Why\n\nBecause the guard is a prefix, not a per-route opt-in.',
      parts: [
        {
          slug: 'signer',
          title: 'Add the signer',
          scope: 'src/server/artifactCapability.ts',
          dependsOn: [],
          rationale: 'a pure predicate with no callers',
          acceptance: 'mint/verify round-trip, tampered and expired both refused',
        },
      ],
    }),
  );
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  const { plan } = ingestPlanDocument(store, {
    doc: parsed.document,
    originRef: 'issue:231',
    title: 'Serve artifacts outside /api',
  });

  assert.equal(plan.risks, 'part 2 briefly serves artifacts with no guard');
  assert.equal(plan.outOfScope, 'capability revocation');
  assert.match(plan.document!, /^# Why/);
  const part = store.listPlanParts(plan.id)[0]!;
  assert.equal(part.rationale, 'a pure predicate with no callers');
  assert.equal(part.acceptance, 'mint/verify round-trip, tampered and expired both refused');
  store.close();
});

test('a document from an older planner still validates, and reads as absent', () => {
  // The five fields are optional precisely so a planner that has never heard of
  // them — or an operator-overridden prompt that does not mention them — keeps
  // working. Absent must read as null, never as an empty string, or the cockpit
  // cannot tell "wrote nothing" from "wrote ''".
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
      reason: 'unchanged',
      parts: [{ slug: 'only', title: 'One', scope: 'src/', dependsOn: [] }],
    }),
  );
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  const store = new Store(':memory:');
  const { plan } = ingestPlanDocument(store, { doc: parsed.document, originRef: 'issue:9', title: 'Old' });
  assert.equal(plan.risks, null);
  assert.equal(plan.document, null);
  assert.equal(store.listPlanParts(plan.id)[0]!.rationale, null);
  store.close();
});

test('an over-long write-up is trimmed and stored, never refused', () => {
  // The opposite of `report_finding`, and deliberately: a finding is testimony an
  // operator acts on, so it is refused when it cannot be trusted; a write-up is
  // prose, and refusing it would reject the whole plan submission over its length.
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'single',
      reason: 'one PR',
      document: 'x'.repeat(MAX_PLAN_DOCUMENT_CHARS + 500),
    }),
  );
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  assert.equal(parsed.document.document!.length, MAX_PLAN_DOCUMENT_CHARS);
});
```

Add to that file's imports: `MAX_PLAN_DOCUMENT_CHARS` from `../src/plans/planDocument.js`, and `Store` from `../src/store/store.js` if not already imported.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/planIngestion.test.ts`
Expected: FAIL — `MAX_PLAN_DOCUMENT_CHARS` is not exported.

- [ ] **Step 3: Widen the zod schemas**

In `src/plans/planDocument.ts`, above `PartSchema`:

```ts
/**
 * How much narrative is kept. Trimmed rather than refused (see the test): the
 * write-up rides along with a verdict, so rejecting it for length would throw
 * away the decomposition too.
 */
export const MAX_PLAN_DOCUMENT_CHARS = 60_000;
```

Then widen `PartSchema` (keeping the existing three fields and their comments exactly as they are):

```ts
const PartSchema = z.object({
  /** Stable and author-chosen: an amended plan merges on it, so it must survive a replan. */
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
  title: z.string().min(1),
  /** Files/areas this part owns — what substitutes for a human holding the split in their head. */
  scope: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).default([]),
  /** Why this is its *own* PR rather than folded into a sibling. */
  rationale: z.string().min(1).optional(),
  /** What makes this part done. */
  acceptance: z.string().min(1).optional(),
});
```

And the plan level — add three fields to the `z.object({...})` at line 43, leaving `.superRefine(...)` untouched:

```ts
    version: z.literal(1),
    verdict: z.enum(['single', 'parts']),
    reason: z.string().min(1),
    /** What could go wrong with this split. */
    risks: z.string().min(1).optional(),
    /** What the planner deliberately left out. */
    outOfScope: z.string().min(1).optional(),
    /**
     * The full narrative, markdown. Stored on the plan row rather than surfaced
     * as an artifact chip: `GET /artifacts/:id` serves out of the agent's
     * worktree, and `system.ts` removes that worktree on a `done` reap — so a
     * write-up surfaced that way 404s exactly when the plan is ready to approve.
     */
    document: z.string().min(1).max(MAX_PLAN_DOCUMENT_CHARS).optional(),
    parts: z.array(PartSchema).default([]),
```

Note `.max()` would **refuse** an over-long document, which is what the third test forbids. Replace that line's `.max(...)` with a transform instead:

```ts
    document: z
      .string()
      .min(1)
      .transform((s) => (s.length > MAX_PLAN_DOCUMENT_CHARS ? s.slice(0, MAX_PLAN_DOCUMENT_CHARS) : s))
      .optional(),
```

- [ ] **Step 4: Carry the part fields into store input**

Replace `planPartInputs` at `src/plans/planDocument.ts:154-163`:

```ts
/** The declared parts as store input, sequenced by their order in the document. */
export function planPartInputs(doc: PlanDocument): PlanPartInput[] {
  return doc.parts.map((part, index) => ({
    slug: part.slug,
    seq: index + 1,
    title: part.title,
    scope: part.scope,
    dependsOn: part.dependsOn,
    rationale: part.rationale ?? null,
    acceptance: part.acceptance ?? null,
  }));
}
```

- [ ] **Step 5: Widen the domain types**

`src/types.ts`, in `Plan` (after `reason`):

```ts
/** What could go wrong with this split, as the planner saw it. Null when it said nothing. */
risks: string | null;
/** What the planner deliberately left out. */
outOfScope: string | null;
/** The full narrative, markdown — the read-in-depth version of this plan. */
document: string | null;
/** True while an operator is discussing this plan with an agent (see rule 3c). */
discussing: boolean;
```

In `PlanPart` (after `scope`):

```ts
/** Why this is its own PR rather than folded into a sibling. */
rationale: string | null;
/** What makes this part done. */
acceptance: string | null;
```

And widen `PlanPartInput`:

```ts
export type PlanPartInput = Pick<
  PlanPart,
  'slug' | 'seq' | 'title' | 'scope' | 'dependsOn' | 'rationale' | 'acceptance'
>;
```

`discussing` is added here now rather than in Task 4 so the row shape changes once.

- [ ] **Step 6: Add the columns — both for fresh and for existing databases**

`src/store/schema.ts`, in `CREATE TABLE IF NOT EXISTS plans`, after `reason`:

```sql
  risks       TEXT,                   -- what could go wrong with this split
  out_of_scope TEXT,                  -- what the planner deliberately left out
  document    TEXT,                   -- the full narrative, markdown
  discussing  INTEGER NOT NULL DEFAULT 0,  -- an operator is arguing with a planner about it
```

In `CREATE TABLE IF NOT EXISTS plan_parts`, after `scope`:

```sql
  rationale   TEXT,                   -- why this is its own PR
  acceptance  TEXT,                   -- what makes this part done
```

Then in `src/store/store.ts`, add to `migrate()` after the `findings` block — **this is the half that matters for any database from an older build**:

```ts
// `plans`/`plan_parts` were introduced as fresh `CREATE TABLE`s and needed no
// entry here. Columns added to them *now* do: `CREATE TABLE IF NOT EXISTS`
// never alters an existing table, so without these the fields are invisible
// on every database that predates them.
this.ensureColumns('plans', {
  risks: 'TEXT',
  out_of_scope: 'TEXT',
  document: 'TEXT',
  discussing: 'INTEGER NOT NULL DEFAULT 0',
});
this.ensureColumns('plan_parts', {
  rationale: 'TEXT',
  acceptance: 'TEXT',
});
```

- [ ] **Step 7: Carry the fields through the store**

Find `rowToPlan` and `rowToPlanPart` in `src/store/store.ts` (and their `PlanRow` / `PlanPartRow` interfaces) and add the new columns to each: `risks`, `out_of_scope`, `document`, `discussing` on the plan; `rationale`, `acceptance` on the part. Map `discussing` with `row.discussing === 1`; map every `TEXT` column with `?? null`.

In `upsertPlan`, widen the input and the SQL. The `statusCommentRef` line already shows the preserve-on-absence idiom — **the write-up must use it too**, or a plan reconciler write that omits the document would erase it:

```ts
  upsertPlan(input: {
    originRef: string;
    title: string;
    status: PlanStatus;
    reason?: string | null;
    risks?: string | null;
    outOfScope?: string | null;
    document?: string | null;
    statusCommentRef?: string | null;
  }): Plan {
    const existing = this.getPlanByOrigin(input.originRef);
    const ts = this.now();
    const plan: Plan = {
      id: existing?.id ?? `plan_${nanoid(10)}`,
      originRef: input.originRef,
      title: input.title,
      status: input.status,
      reason: input.reason ?? null,
      // Preserved on absence for the same reason `statusCommentRef` is: a caller
      // that writes a status without re-stating the narrative must not erase it.
      risks: input.risks ?? existing?.risks ?? null,
      outOfScope: input.outOfScope ?? existing?.outOfScope ?? null,
      document: input.document ?? existing?.document ?? null,
      // Not settable here: discussion is its own one-way transition (`setPlanDiscussing`),
      // so an ingestion cannot accidentally re-open one it is meant to be closing.
      discussing: existing?.discussing ?? false,
      statusCommentRef: input.statusCommentRef ?? existing?.statusCommentRef ?? null,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO plans (id, origin_ref, title, status, reason, risks, out_of_scope, document, discussing, status_comment_ref, created_at, updated_at)
         VALUES (@id, @originRef, @title, @status, @reason, @risks, @outOfScope, @document, @discussing, @statusCommentRef, @createdAt, @updatedAt)
         ON CONFLICT(origin_ref) DO UPDATE SET title=excluded.title, status=excluded.status,
           reason=excluded.reason, risks=excluded.risks, out_of_scope=excluded.out_of_scope,
           document=excluded.document, status_comment_ref=excluded.status_comment_ref, updated_at=excluded.updated_at`,
      )
      .run({ ...plan, discussing: plan.discussing ? 1 : 0 });
    return plan;
  }
```

Note `discussing` is deliberately **absent from the `DO UPDATE SET` list** — an upsert must not clear a flag it does not own.

In `upsertPlanParts`, add `rationale: input.rationale, acceptance: input.acceptance,` to the constructed `part` object, add both columns to the `INSERT` column list and `VALUES`, and add `rationale=excluded.rationale, acceptance=excluded.acceptance` to the `DO UPDATE SET` — these are _declaration_, which `upsertPlanParts` owns, so they refresh on amendment.

- [ ] **Step 8: Pass the new fields at ingestion**

`src/plans/planIngest.ts:70` — replace the `upsertPlan` call:

```ts
const plan = store.upsertPlan({
  originRef,
  title,
  status,
  reason: doc.reason,
  risks: doc.risks ?? null,
  outOfScope: doc.outOfScope ?? null,
  document: doc.document ?? null,
});
```

- [ ] **Step 9: Run the tests**

Run: `node --import tsx --test test/planIngestion.test.ts`
Expected: PASS (all three new tests).

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
npm run format
git add src/plans/planDocument.ts src/plans/planIngest.ts src/types.ts src/store/schema.ts src/store/store.ts test/planIngestion.test.ts
git commit -m "A plan carries risks, scope-outs, per-part rationale and a write-up"
```

---

## Task 3: `plan_submit` and the planner prompts ask for them

**Files:**

- Modify: `src/mcp/tools.ts:129-209`
- Modify: `src/dispatcher/promptTemplates.ts:58-81` (`issue-plan`), `:82-107` (`issue-replan`)
- Test: `test/mcpChannel.test.ts`

**Interfaces:**

- Consumes: the widened `PlanDocumentSchema` from Task 2.
- Produces: nothing new — a planner that fills the fields.

- [ ] **Step 1: Write the failing test**

Append to `test/mcpChannel.test.ts`, following the file's existing `mcp.session(agentId)` pattern (copy the setup from the nearest existing `plan_submit` test in that file):

```ts
test('plan_submit accepts and persists the widened document', async () => {
  // ...build the system and a planning agent exactly as the existing plan_submit
  // test in this file does, then:
  const res = await session.call('plan_submit', {
    verdict: 'parts',
    reason: 'the signer must exist first',
    risks: 'part 2 briefly serves artifacts unguarded',
    outOfScope: 'capability revocation',
    document: '# Serving artifacts\n\nThe guard is a prefix, not a per-route opt-in.',
    parts: [
      {
        slug: 'signer',
        title: 'Add the signer',
        scope: 'src/server/artifactCapability.ts',
        dependsOn: [],
        rationale: 'a pure predicate with no callers',
        acceptance: 'round-trips; tampered and expired refused',
      },
    ],
  });
  assert.equal(res.accepted, true);
  const plan = system.store.getPlanByOrigin('issue:231')!;
  assert.equal(plan.risks, 'part 2 briefly serves artifacts unguarded');
  assert.match(plan.document!, /^# Serving artifacts/);
  assert.equal(system.store.listPlanParts(plan.id)[0]!.acceptance, 'round-trips; tampered and expired refused');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/mcpChannel.test.ts`
Expected: FAIL — the fields are dropped, so `plan.risks` is `null`.

- [ ] **Step 3: Widen the tool's input schema**

In `src/mcp/tools.ts`, inside `plan_submit`'s `inputSchema.properties`, after `reason`:

```ts
          risks: { type: 'string', description: 'What could go wrong with this split.' },
          outOfScope: { type: 'string', description: 'What you deliberately left out, and why.' },
          document: {
            type: 'string',
            description:
              'The full write-up in markdown — the version a human reads before approving. ' +
              'Cover why the work is shaped this way, what you considered and rejected, and ' +
              'anything you are unsure about. This is what the operator reads; write it for them.',
          },
```

and inside `parts.items.properties`, after `dependsOn`:

```ts
                rationale: { type: 'string', description: 'Why this is its own PR rather than folded into a sibling.' },
                acceptance: { type: 'string', description: 'What makes this part done.' },
```

- [ ] **Step 4: Pass them to the validator**

In the same handler, replace the `validatePlanDocument({...})` call:

```ts
const parsed = validatePlanDocument({
  version: 1,
  verdict: args.verdict,
  reason: args.reason,
  risks: args.risks,
  outOfScope: args.outOfScope,
  document: args.document,
  parts: args.parts ?? [],
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test test/mcpChannel.test.ts`
Expected: PASS.

- [ ] **Step 6: Make the prompts demand the write-up**

In `src/dispatcher/promptTemplates.ts`, in the `issue-plan` template, replace the two JSON examples and the paragraph after them. The `placeholders` array is unchanged — no new `{token}` is introduced, so an operator's existing override keeps loading.

```ts
      'For one PR:\n\n' +
      '  {"version": 1, "verdict": "single", "reason": "<one sentence>",\n' +
      '   "risks": "<what could go wrong>", "outOfScope": "<what you are not doing>",\n' +
      '   "document": "<the full write-up, markdown>"}\n\n' +
      'For several, each part being one reviewable PR:\n\n' +
      '  {"version": 1, "verdict": "parts", "reason": "<one sentence>",\n' +
      '   "risks": "...", "outOfScope": "...", "document": "...", "parts": [\n' +
      '    {"slug": "schema", "title": "...", "scope": "src/store/...", "dependsOn": [],\n' +
      '     "rationale": "why this is its own PR", "acceptance": "what makes it done"},\n' +
      '    {"slug": "dispatcher", "title": "...", "scope": "src/dispatcher/...", "dependsOn": ["schema"],\n' +
      '     "rationale": "...", "acceptance": "..."}\n' +
      '  ]}\n\n' +
      'Slugs are short, lowercase, kebab-case and unique; "scope" names the files or areas that part owns, ' +
      'so parts running at the same time do not collide; "dependsOn" names **at most one** sibling slug — a part ' +
      'stacks on a single branch, so two dependencies is not expressible and the plan will be rejected.\n\n' +
      '"document" is not optional in practice: a human reads it and decides whether this work happens. ' +
      'Write it for them, in markdown — why the work is shaped this way, what you considered and rejected, ' +
      'and a section naming whatever you are least sure about. A plan with no write-up is one they have to ' +
      'take on trust.\n\n' +
```

Make the equivalent change to `issue-replan`: widen its JSON example the same way and append the same `"document"` paragraph. Also add one amendment rule to its bullet list:

```ts
      '- **Re-state the write-up.** `document`, `risks` and `outOfScope` are replaced by what you submit, not ' +
      'merged — an amendment that omits them leaves the previous ones standing, which will read as though the ' +
      'old reasoning still applies.\n' +
```

Update both `doc:` strings to mention the new fields.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. `loadPromptTemplates` rejects only _unknown placeholders_, and none were added, so operator overrides still load.

- [ ] **Step 8: Commit**

```bash
npm run format
git add src/mcp/tools.ts src/dispatcher/promptTemplates.ts test/mcpChannel.test.ts
git commit -m "plan_submit and the planner prompts ask for the write-up"
```

---

## Task 4: Discussion — the store flag and the two routes

**Files:**

- Create: `src/plans/planDiscussion.ts`
- Modify: `src/store/store.ts` (new `setPlanDiscussing` beside `setPlanStatus` at 724-731)
- Modify: `src/server/app.ts` (two routes, after the replan route at 458-476)
- Test: `test/planDiscussion.test.ts` (create)

**Interfaces:**

- Consumes: `Plan.discussing` from Task 2; `planProposalRef` (`src/proposals/proposals.js`), `proposals.reject(id, note)`, `store.setPlanStatus(id, status)`.
- Produces:

  - `Store.setPlanDiscussing(id: string, discussing: boolean): Plan | null`
  - `isPlanInDiscussion(plan: Plan | null): boolean` from `src/plans/planDiscussion.ts`
  - `POST /api/plans/:id/discuss` → `{ ok: true; plan: Plan }`, 404 when no plan
  - `POST /api/plans/:id/discuss/end` → `{ ok: true; plan: Plan }`, 404 when no plan

- [ ] **Step 1: Write the failing test**

Create `test/planDiscussion.test.ts`. Copy the system/app construction preamble from `test/planApproval.test.ts` (it builds a `System` via `buildSystem` with `FakePtyBackend` + `FakeGitObserver` + `dbPath: ':memory:'`, then `buildApp(system)`, and drives routes with `app.inject`; tests that drive routes opt out of auth with `auth: { enabled: false } as never`).

```ts
test('discuss parks the plan for a planner and withdraws the pending approval', async () => {
  const { system, app } = await buildTestApp(); // per the preamble copied above
  const plan = seedAwaitingApprovalPlan(system); // helper below
  await system.harness.runCycle('manual'); // rule 3d writes the proposal
  const before = system.store.listProposals().find((p) => p.kind === 'plan')!;
  assert.equal(before.status, 'pending');

  const res = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });
  assert.equal(res.statusCode, 200);

  const after = system.store.getPlan(plan.id)!;
  // `planning`, so rule 3c dispatches and rule 4a schedules no parts.
  assert.equal(after.status, 'planning');
  assert.equal(after.discussing, true);
  // The withdrawal is not optional: a pending proposal holds rule 3d, so the
  // amended decomposition would never be put to anyone — and the stale card, if
  // accepted, would release a plan its reader never saw.
  assert.equal(system.store.listProposals().find((p) => p.id === before.id)!.status, 'rejected');
  // ...and withdrawing must not retire anything: `refusePlan` no-ops because the
  // status write above already moved the plan out of `awaiting_approval`.
  assert.ok(system.store.listPlanParts(plan.id).every((p) => p.status !== 'retired'));
});

test('ending a discussion puts the plan back to awaiting approval', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });

  const res = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss/end` });
  assert.equal(res.statusCode, 200);
  const after = system.store.getPlan(plan.id)!;
  // Without restoring the status the plan sits in `planning` and rule 3c simply
  // starts another discussion — the flag alone is not the whole of ending one.
  assert.equal(after.status, 'awaiting_approval');
  assert.equal(after.discussing, false);
});

test('a missing plan is a 404 on both discussion routes', async () => {
  const { app } = await buildTestApp();
  assert.equal((await app.inject({ method: 'POST', url: '/api/plans/nope/discuss' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/plans/nope/discuss/end' })).statusCode, 404);
});
```

Write `seedAwaitingApprovalPlan(system)` in the same file: `ingestPlanDocument(system.store, { doc, originRef: 'issue:231', title: '...', requireApproval: true })` with a two-part document, plus whatever world seeding `planApproval.test.ts` uses to make issue 231 open and watched.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/planDiscussion.test.ts`
Expected: FAIL — 404 from `/discuss` (route does not exist).

- [ ] **Step 3: Add the store transition**

In `src/store/store.ts`, immediately after `setPlanStatus`:

```ts
  /**
   * Mark a plan as being discussed with an agent, or not. Its own transition
   * rather than a field on `upsertPlan`, because ingestion is what *ends* a
   * discussion — folding it in would let an amendment silently re-open one.
   */
  setPlanDiscussing(id: string, discussing: boolean): Plan | null {
    const row = this.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    if (!row) return null;
    const updatedAt = this.now();
    this.db
      .prepare(`UPDATE plans SET discussing=?, updated_at=? WHERE id=?`)
      .run(discussing ? 1 : 0, updatedAt, id);
    return { ...rowToPlan(row), discussing, updatedAt };
  }
```

- [ ] **Step 4: Create the pure predicate**

Create `src/plans/planDiscussion.ts`:

```ts
import type { Plan } from '../types.js';

/**
 * Is this plan parked for a conversation rather than for a fresh decomposition?
 *
 * Both arms of rule 3c see a plan in `planning` status — that is the whole
 * mechanism a discussion reuses, and why it inherits the origin gate, the
 * cooldown and the attempt cap for free. The flag is the only thing that tells
 * the two apart, so the question is asked here rather than inline, and the
 * dispatcher and the routes cannot come to different answers about it.
 */
export function isPlanInDiscussion(plan: Plan | null): boolean {
  return plan !== null && plan.status === 'planning' && plan.discussing;
}
```

- [ ] **Step 5: Add both routes**

In `src/server/app.ts`, immediately after the `/api/plans/:id/replan` route (ends line 476):

```ts
// Discuss a plan with an agent instead of accepting, rejecting or replanning it.
//
// Deliberately *a replan with a different prompt*, not a new mechanism: the plan
// goes to `planning`, which is the status rule 3c already dispatches a planner
// from, so the discussion agent inherits the origin gate (`issue:<n>:plan`, so no
// second planner), the cooldown, the attempt cap and the fail-open — none of which
// a bespoke path would have. `discussing` only picks the prompt.
//
// Nothing is scheduled while you talk: rule 4a schedules parts for `active` and
// `awaiting_approval` plans only, and rule 3d proposes for `awaiting_approval`
// only, so no fresh card appears mid-conversation either.
app.post('/api/plans/:id/discuss', async (req, reply) => {
  const { id } = req.params as { id: string };
  const plan = store.getPlan(id);
  if (!plan) return reply.code(404).send({ error: 'plan not found' });
  // Order matters exactly as it does for a replan: the status write is what
  // makes the withdrawal safe, because `refusePlan` refuses to settle a plan
  // that is no longer `awaiting_approval` — so the reject below closes the inbox
  // item without retiring a single part.
  store.setPlanStatus(id, 'planning');
  const next = store.setPlanDiscussing(id, true);
  const ref = planProposalRef(plan.originRef);
  const pending = store.listProposals().find((p) => p.kind === 'plan' && p.ref === ref && p.status === 'pending');
  if (pending) proposals.reject(pending.id, 'superseded by a discussion');
  hub.broadcast({ type: 'world:changed' });
  await harness.runCycle('manual');
  return { ok: true, plan: next };
});

// End a discussion the operator no longer wants — the escape hatch, since the
// agent ends itself when it submits an amended plan.
//
// Restoring the status is half the job and not an afterthought: clearing the
// flag alone leaves the plan in `planning`, which is precisely what rule 3c
// dispatches from, so the next pulse would start another planner.
app.post('/api/plans/:id/discuss/end', async (req, reply) => {
  const { id } = req.params as { id: string };
  const plan = store.getPlan(id);
  if (!plan) return reply.code(404).send({ error: 'plan not found' });
  store.setPlanStatus(id, 'awaiting_approval');
  const next = store.setPlanDiscussing(id, false);
  hub.broadcast({ type: 'world:changed' });
  await harness.runCycle('manual');
  return { ok: true, plan: next };
});
```

- [ ] **Step 6: Clear the flag at ingestion**

In `src/plans/planIngest.ts`, after the `upsertPlan` call:

```ts
// An amended plan is what *ends* a discussion — the agent has said its piece and
// submitted. Cleared here rather than in the route so it holds for both
// transports, and so an agent that finishes without anyone pressing a button
// still leaves the plan in a state rule 3c will not re-dispatch from.
if (plan.discussing) store.setPlanDiscussing(plan.id, false);
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --import tsx --test test/planDiscussion.test.ts`
Expected: PASS (all three).

- [ ] **Step 8: Commit**

```bash
npm run format
git add src/plans/planDiscussion.ts src/plans/planIngest.ts src/store/store.ts src/server/app.ts test/planDiscussion.test.ts
git commit -m "Discussing a plan: the store flag and the two routes"
```

---

## Task 5: Rule 3c dispatches a conversational planner

**Files:**

- Create: nothing.
- Modify: `src/dispatcher/promptTemplates.ts` (`PromptId` union at 24-42, `REGISTRY` — a new `discuss-plan` entry after `issue-replan`)
- Modify: `src/dispatcher/ruleDispatcher.ts:551-615` (rule 3c)
- Test: `test/planDiscussion.test.ts`

**Interfaces:**

- Consumes: `isPlanInDiscussion` from Task 4.
- Produces: prompt id `'discuss-plan'` with placeholders `['number', 'title', 'body', 'branch', 'planFile', 'current']`.

- [ ] **Step 1: Write the failing test**

Append to `test/planDiscussion.test.ts`:

```ts
test('a discussed plan gets a conversational planner, not a fresh one', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });

  const task = system.store.listTasks().find((t) => t.originRef === 'issue:231:plan');
  assert.ok(task, 'rule 3c dispatched on the planner origin');
  // Same origin and branch as any planner — that is what makes the origin gate,
  // the cooldown and the attempt cap apply without a line of new code.
  assert.equal(task!.branch, 'plan/issue/231');
  // ...but the conversation prompt, not the replan one.
  assert.match(task!.prompt, /conversation/i);
  assert.match(task!.prompt, /escalate/);
  assert.doesNotMatch(task!.prompt, /an operator has asked for it to be replanned/);
});

test('an ordinary replan is untouched by the discussion arm', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/replan` });
  const task = system.store.listTasks().find((t) => t.originRef === 'issue:231:plan');
  assert.ok(task);
  assert.match(task!.prompt, /an operator has asked for it to be replanned/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/planDiscussion.test.ts`
Expected: FAIL — the discussed plan gets the `issue-replan` prompt.

- [ ] **Step 3: Add the prompt id**

In `src/dispatcher/promptTemplates.ts`, add `| 'discuss-plan'` to the `PromptId` union, after `'issue-replan'`.

- [ ] **Step 4: Add the template**

In `REGISTRY`, after the `issue-replan` entry:

```ts
  'discuss-plan': {
    placeholders: ['number', 'title', 'body', 'branch', 'planFile', 'current'],
    template:
      'An operator wants to talk through the delivery plan for issue #{number} ("{title}") before approving it. ' +
      'This is a conversation, not a planning run: nothing is scheduled while you are talking, and your job is to ' +
      'answer them well and amend the plan if they ask.\n\n{body}\n\n{current}\n\n' +
      'How this works:\n\n' +
      '- Read the repository and the plan above, then use the escalate tool to open the conversation — say what ' +
      'you understand the plan to be and what you think is most worth questioning about it. Escalating parks you ' +
      'until they reply; their reply arrives as your next turn.\n' +
      '- Answer honestly. If they are right that a split is wrong, say so. If they are wrong, say that too and ' +
      'explain why — you have read the code and they may not have.\n' +
      '- Escalate again each time you need them, and keep going until they are satisfied.\n' +
      '- When they are, submit the amended plan with the plan_submit tool (or write it to {planFile}), exactly as ' +
      'a replan would: slugs are the merge key, re-declare every part that is already merged, dispatched or in ' +
      'review, and a part you leave out is retired only if nothing was started for it. Re-state "document", ' +
      '"risks" and "outOfScope" — they are replaced by what you submit, not merged.\n' +
      '- If they end up wanting no change at all, submit the plan unchanged. Submitting is what ends the ' +
      'conversation and puts the plan back in front of them for approval.\n\n' +
      'Do not implement anything and do not open a pull request. You are on branch {branch} only so you have the ' +
      'repository to read.',
    doc: 'Sent to a code agent when an operator hits Discuss on a plan (rule 3c, with the plan row in `planning` and `discussing` set). Unlike {issue-replan} it is a dialogue: the agent escalates to talk, and submitting the amended plan is what ends it. Placeholders: {number} {title} {body} {branch} {planFile} {current}.',
  },
```

- [ ] **Step 5: Branch rule 3c**

In `src/dispatcher/ruleDispatcher.ts`, inside the rule 3c loop: after the existing `const replan = ...` line, add

```ts
// A discussion is a replan whose planner talks first. Same status, same
// origin, same branch — only the prompt differs, which is why it needs no
// gate of its own (see `isPlanInDiscussion`).
const discussing = isPlanInDiscussion(existing);
```

Then replace the `title` and `reason` assignments:

```ts
const title = discussing
  ? `Discuss the plan for issue #${issue.number}`
  : replan
    ? `Replan issue #${issue.number}`
    : `Plan issue #${issue.number}`;
const reason = discussing
  ? `An operator is discussing the plan for issue #${issue.number} before approving it.`
  : replan
    ? `Issue #${issue.number} was sent back for replanning; plan it again from its current state.`
    : `Open issue #${issue.number} has no plan yet; plan it before dispatching work.`;
```

And replace the `prompt:` expression in the action. `discuss-plan` takes the same variables `issue-replan` does, so the existing `currentPlanSummary(...)` call is reused verbatim:

```ts
          prompt:
            discussing || replan
              ? this.templates.render(discussing ? 'discuss-plan' : 'issue-replan', {
                  number: issue.number,
                  title: issue.title,
                  body: issue.body,
                  branch,
                  planFile: PLAN_FILE,
                  current: currentPlanSummary(
                    existing!,
                    (ctx.planParts ?? []).filter((p) => p.planId === existing!.id),
                  ),
                })
              : this.templates.render('issue-plan', {
                  number: issue.number,
                  title: issue.title,
                  body: issue.body,
                  branch,
                  planFile: PLAN_FILE,
                }),
```

Add the import at the top of `ruleDispatcher.ts`:

```ts
import { isPlanInDiscussion } from '../plans/planDiscussion.js';
```

- [ ] **Step 6: Run the tests**

Run: `node --import tsx --test test/planDiscussion.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run format
git add src/dispatcher/promptTemplates.ts src/dispatcher/ruleDispatcher.ts test/planDiscussion.test.ts
git commit -m "Rule 3c dispatches a conversational planner for a discussed plan"
```

---

## Task 6: The markdown renderer

**Files:**

- Create: `web/src/components/markdown.ts`
- Test: `test/markdown.test.ts` (create)

**Interfaces:**

- Consumes: nothing.
- Produces: `renderMarkdown(source: string): ReactNode[]` from `web/src/components/markdown.ts`.

This is a pure, self-contained unit with no dependency on any other task — safe to build in parallel with Tasks 1-5.

- [ ] **Step 1: Write the failing test**

Create `test/markdown.test.ts`, modelled on `test/ansi.test.ts` (which provides `globalThis.React` before importing the module — do the same here, and render with `renderToStaticMarkup`):

````ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const { renderMarkdown } = await import('../web/src/components/markdown.js');

const html = (src: string): string => renderToStaticMarkup(createElement(React.Fragment, null, ...renderMarkdown(src)));

test('headings, paragraphs and lists', () => {
  assert.match(html('# Title'), /<h1[^>]*>Title<\/h1>/);
  assert.match(html('## Why'), /<h2[^>]*>Why<\/h2>/);
  assert.match(html('a paragraph'), /<p[^>]*>a paragraph<\/p>/);
  const list = html('- one\n- two');
  assert.match(list, /<ul[^>]*>/);
  assert.equal(list.match(/<li/g)?.length, 2);
  assert.match(html('1. first\n2. second'), /<ol[^>]*>/);
});

test('code, emphasis and blockquotes', () => {
  assert.match(html('```\nnpm run check\n```'), /<pre[^>]*><code[^>]*>npm run check/);
  assert.match(html('use `runGit` here'), /<code[^>]*>runGit<\/code>/);
  assert.match(html('**bold**'), /<strong[^>]*>bold<\/strong>/);
  assert.match(html('*soft*'), /<em[^>]*>soft<\/em>/);
  assert.match(html('> quoted'), /<blockquote[^>]*>/);
});

test('agent-authored HTML is text, never markup', () => {
  // The whole reason this is hand-written rather than a dependency: the source is
  // agent-authored, so a renderer that never interprets HTML has no injection
  // surface to reason about. React escapes text children, and nothing here ever
  // reaches `dangerouslySetInnerHTML`.
  const out = html('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /<script/);
  assert.match(out, /&lt;img/);
});

test('a fenced block is never parsed as markdown', () => {
  // A write-up that shows a markdown example would otherwise render it.
  const out = html('```\n# not a heading\n- not a list\n```');
  assert.doesNotMatch(out, /<h1/);
  assert.doesNotMatch(out, /<ul/);
});

test('empty and whitespace-only input render nothing', () => {
  assert.equal(html(''), '');
  assert.equal(html('   \n\n  '), '');
});
````

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/markdown.test.ts`
Expected: FAIL — cannot find module `markdown.js`.

- [ ] **Step 3: Write the renderer**

Create `web/src/components/markdown.ts`:

````ts
import { createElement, Fragment, type ReactNode } from 'react';

/**
 * A markdown subset, rendered to React nodes.
 *
 * Hand-written rather than a dependency, for the reason `ansi.ts` is: the
 * surface actually needed is small, and the text is **agent-authored**. A
 * renderer that produces React children never interprets HTML — React escapes
 * text — so there is no sanitiser to get wrong and no `dangerouslySetInnerHTML`
 * anywhere in the path. Anything it does not understand renders as its own
 * literal text, which is the right failure for a write-up: legible, never
 * executable.
 *
 * Supported: ATX headings (#..###), unordered and ordered lists, fenced code,
 * blockquotes, paragraphs, and inline `code`, **strong** and *emphasis*.
 */
export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let para: string[] = [];
  let key = 0;
  const k = () => `md-${key++}`;

  const flushParagraph = () => {
    if (para.length === 0) return;
    out.push(createElement('p', { key: k() }, ...inline(para.join(' '), k)));
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code first: everything inside is literal, including markdown that
    // would otherwise be parsed (a write-up explaining markdown is not rare).
    const fence = /^```/.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i]!), i++;
      out.push(createElement('pre', { key: k() }, createElement('code', null, body.join('\n'))));
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      out.push(createElement(`h${heading[1]!.length}`, { key: k() }, ...inline(heading[2]!, k)));
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i]!.replace(/^>\s?/, '')), i++;
      i--;
      out.push(createElement('blockquote', { key: k() }, ...inline(body.join(' '), k)));
      continue;
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      const matches = (l: string) => (ordered ? /^\s*\d+\.\s+/.test(l) : /^\s*[-*]\s+/.test(l));
      while (i < lines.length && matches(lines[i]!)) {
        items.push(lines[i]!.replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, ''));
        i++;
      }
      i--;
      out.push(
        createElement(
          ordered ? 'ol' : 'ul',
          { key: k() },
          ...items.map((item) => createElement('li', { key: k() }, ...inline(item, k))),
        ),
      );
      continue;
    }

    if (line.trim() === '') flushParagraph();
    else para.push(line.trim());
  }
  flushParagraph();
  return out;
}

/**
 * Inline spans, in one pass over a single alternation so the segments cannot
 * overlap — `code` wins, because a backticked `**x**` is showing you the
 * asterisks, not asking for bold.
 */
function inline(text: string, k: () => string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(createElement('code', { key: k() }, m[1].slice(1, -1)));
    else if (m[2]) out.push(createElement('strong', { key: k() }, m[2].slice(2, -2)));
    else if (m[3]) out.push(createElement('em', { key: k() }, m[3].slice(1, -1)));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length > 0 ? out : [createElement(Fragment, { key: k() })];
}
````

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test test/markdown.test.ts`
Expected: PASS (all five).

- [ ] **Step 5: Commit**

```bash
npm run format
git add web/src/components/markdown.ts test/markdown.test.ts
git commit -m "A markdown subset renderer that never interprets HTML"
```

---

## Task 7: The plan modal

**Files:**

- Create: `web/src/components/PlanModal.tsx`
- Modify: `web/src/types.ts` (mirror `Plan` / `PlanPart` fields from Task 2)
- Modify: `web/src/api.ts` (two calls), `web/src/cockpit/actions.ts` (three actions), `web/src/cockpit/useCockpit.ts`, `web/src/view/viewModel.ts`, `web/src/App.tsx`
- Modify: `web/src/styles.css` (append)
- Test: `test/cockpitSkins.test.ts` (must keep passing)

**Interfaces:**

- Consumes: `renderMarkdown` (Task 6); the widened `Plan`/`PlanPart` (Task 2); the two routes (Task 4).
- Produces:

  - `CockpitActions.viewPlan(planId: string | null): void`
  - `CockpitActions.discussPlan(planId: string): Promise<void>`
  - `CockpitActions.endPlanDiscussion(planId: string): Promise<void>`
  - `CockpitView.viewingPlan: string | null`
  - `<PlanModal plan parts upcoming agents now refUrls onClose onReplan onDiscuss onEndDiscussion onDecide onOpenAgent onRespond />`

- [ ] **Step 1: Mirror the types in the web bundle**

`web/src/types.ts` — in the `Plan` interface add `risks: string | null; outOfScope: string | null; document: string | null; discussing: boolean;` and in `PlanPart` add `rationale: string | null; acceptance: string | null;`. Keep the one-line comments in the style of the surrounding fields.

- [ ] **Step 2: Add the API calls**

`web/src/api.ts`, in `realApi` after `replan`:

```ts
  // Talk it through with an agent instead of accepting or rejecting. Server-side
  // this is a replan whose planner converses first — see the route.
  discussPlan: (planId: string) => post<{ ok: true }>(`/api/plans/${planId}/discuss`),
  endPlanDiscussion: (planId: string) => post<{ ok: true }>(`/api/plans/${planId}/discuss/end`),
```

Add the same two to `demoApi` in `web/src/demo/demoBackend.ts`, mirroring how `replan` is faked there.

- [ ] **Step 3: Add the actions to the seam**

`web/src/cockpit/actions.ts`, after `replan`:

```ts
  /**
   * Which plan's modal is open. UI state, on the seam for the same reason
   * `select` is: a skin cannot own it (the modal is shared and the triggers are
   * skin-side), and a skin may not reach `api.js` to open it another way.
   */
  viewPlan(planId: string | null): void;
  discussPlan(planId: string): Promise<void>;
  endPlanDiscussion(planId: string): Promise<void>;
```

`web/src/cockpit/useCockpit.ts` — add state beside `selected` (line 31):

```ts
const [viewingPlan, setViewingPlan] = useState<string | null>(null);
```

and in the `actions` memo, after `replan`:

```ts
      viewPlan: (planId) => setViewingPlan(planId),
      discussPlan: (planId) => then(api.discussPlan(planId)),
      endPlanDiscussion: (planId) => then(api.endPlanDiscussion(planId)),
```

and pass `viewingPlan` into `buildViewModel({ ... })` at the bottom of the hook.

`web/src/view/viewModel.ts` — accept `viewingPlan: string | null` on the input and put it on `CockpitView` unchanged.

- [ ] **Step 4: Write the modal**

Create `web/src/components/PlanModal.tsx`. It is a presentational component: every mutation arrives as a prop, and it imports nothing from `api.js`.

```tsx
import { useState } from 'react';
import type { Agent, Plan, PlanPart, Proposal, QueueItem } from '../types.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { renderMarkdown } from './markdown.js';
import { refLink, relTime } from './util.js';

/**
 * The whole plan, on demand — the record of what was agreed, not just the
 * question that was asked.
 *
 * Until now a decomposition was legible only while it was a pending proposal: the
 * approval card rendered a template string and vanished on the click, and the
 * Plans panel drew rows whose `scope` was a tooltip. Which five parts, why each
 * was its own PR, what the planner thought could go wrong and what it left out
 * were all facts you opened SQLite to learn.
 *
 * Two tabs rather than one scroll, because the decision view has to stay short
 * enough to hold in your head while you decide. The cost is that the write-up is
 * one click away; the alternative cost — a wall of prose above the buttons — is
 * worse, because it is paid on every approval rather than on the ones where you
 * want the detail.
 */
export function PlanModal({
  plan,
  parts,
  upcoming,
  proposal,
  agent,
  now,
  refUrls,
  onClose,
  onReplan,
  onDiscuss,
  onEndDiscussion,
  onDecide,
  onOpenAgent,
  onRespond,
}: {
  plan: Plan;
  parts: PlanPart[];
  /** The last pulse's ranked plan, joined per part by origin — the dispatch cut. */
  upcoming: QueueItem[];
  /** The pending approval this plan is waiting on, when it is waiting on one. */
  proposal?: Proposal;
  /** The discussion agent, when one is live on this plan's planner origin. */
  agent?: Agent;
  now: number;
  refUrls: Record<string, string>;
  onClose: () => void;
  onReplan: (planId: string) => Promise<unknown> | unknown;
  onDiscuss: (planId: string) => Promise<unknown> | unknown;
  onEndDiscussion: (planId: string) => Promise<unknown> | unknown;
  onDecide: (id: string, verdict: 'accept' | 'reject', note?: string) => Promise<unknown> | unknown;
  onOpenAgent: (agentId: string) => void;
  onRespond: (agentId: string, text: string) => Promise<unknown> | unknown;
}) {
  const [tab, setTab] = useState<'plan' | 'writeup'>('plan');
  const [note, setNote] = useState('');
  const [say, setSay] = useState('');
  const send = useAsyncAction();

  const live = parts.filter((p) => p.status !== 'retired');
  const merged = live.filter((p) => p.status === 'merged').length;
  const issueNumber = issueOf(plan.originRef);
  const queued = new Map(upcoming.map((q) => [q.origin, q]));
  // A verdict is only on offer while the plan is still the thing that was
  // proposed; during a discussion there is nothing to approve, because the
  // amended plan comes back as a fresh proposal.
  const decidable = proposal?.status === 'pending' && !plan.discussing ? proposal : null;
  const cutAt = live.findIndex((p) => {
    const q = queued.get(originOf(issueNumber, p.slug));
    return q !== undefined && q.status !== 'dispatching';
  });

  return (
    <div className="plan-modal-backdrop" onClick={onClose}>
      <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pm-head">
          {issueNumber !== null && refLink(`#${issueNumber}`, refUrls)}
          <span className="pm-title">{plan.title}</span>
          <span className={`chip small${plan.status === 'complete' ? ' ok' : decidable ? ' warn' : ''}`}>
            {plan.discussing ? 'discussing' : plan.status.replace(/_/g, ' ')}
          </span>
          {live.length > 0 && (
            <span className="chip small">
              {merged}/{live.length} merged
            </span>
          )}
          <button className="btn ghost small pm-close" onClick={onClose}>
            close
          </button>
        </div>

        {plan.discussing && agent && (
          <div className="pm-discussion">
            <div className="pm-head">
              <span className="pm-section-label">Discussion</span>
              <span className="chip small ok">{agent.status}</span>
              <button className="btn ghost small pm-close" onClick={() => onOpenAgent(agent.id)}>
                Open full transcript →
              </button>
            </div>
            {agent.note && <div className="pm-note-line">{agent.note}</div>}
            <form
              className="pm-say"
              onSubmit={(e) => {
                e.preventDefault();
                const value = say.trim();
                if (!value) return;
                void send.run(async () => {
                  await onRespond(agent.id, value);
                  setSay('');
                });
              }}
            >
              <input placeholder="Say something to the planner…" value={say} onChange={(e) => setSay(e.target.value)} />
              <SubmitButton phase={send.phase} className="primary">
                Send
              </SubmitButton>
            </form>
          </div>
        )}

        <div className="pm-tabs">
          <button className={`pm-tab${tab === 'plan' ? ' on' : ''}`} onClick={() => setTab('plan')}>
            Plan <span className="count">· {live.length} parts</span>
          </button>
          <button className={`pm-tab${tab === 'writeup' ? ' on' : ''}`} onClick={() => setTab('writeup')}>
            Full write-up
          </button>
        </div>

        {tab === 'writeup' ? (
          plan.document ? (
            <div className="pm-doc">{renderMarkdown(plan.document)}</div>
          ) : (
            // Said rather than hidden: an absent tab reads as "the planner had
            // nothing to add", which is indistinguishable from "the planner
            // ignored the instruction" — and only one of those is your problem.
            <p className="empty">
              This planner wrote no write-up. Replan to ask again, or discuss it if you want the reasoning.
            </p>
          )
        ) : (
          <>
            {plan.reason && (
              <div className="pm-why">
                <span className="pm-section-label">Why the planner split it</span>
                {plan.reason}
              </div>
            )}
            {(plan.risks || plan.outOfScope) && (
              <div className="pm-flags">
                {plan.risks && (
                  <div className="pm-flag risk">
                    <span className="pm-section-label">Risks</span>
                    {plan.risks}
                  </div>
                )}
                {plan.outOfScope && (
                  <div className="pm-flag oos">
                    <span className="pm-section-label">Deliberately out of scope</span>
                    {plan.outOfScope}
                  </div>
                )}
              </div>
            )}
            {live.length === 0 ? (
              <p className="empty">
                {plan.status === 'single'
                  ? 'One pull request — this issue goes through ordinary pickup.'
                  : 'No parts declared yet.'}
              </p>
            ) : (
              <div>
                <span className="pm-section-label">{live.length} parts, in dispatch order</span>
                {live.map((part, idx) => (
                  <div key={part.id}>
                    {idx === cutAt && (
                      <div className="pm-cut">
                        <span>
                          {decidable ? 'nothing below is scheduled until you approve' : 'not started this cycle'}
                        </span>
                      </div>
                    )}
                    <PartBlock
                      part={part}
                      seq={idx + 1}
                      queue={queued.get(originOf(issueNumber, part.slug))}
                      refUrls={refUrls}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="pm-foot">
          {plan.discussing ? (
            <>
              <span className="muted small">
                While a discussion is running nothing is scheduled, and there is no approval to give — the amended plan
                comes back as a fresh proposal.
              </span>
              <span className="spacer" />
              <AsyncButton
                className="ghost"
                title="Stop the conversation and put the plan back up for approval unchanged"
                onClick={() => onEndDiscussion(plan.id)}
              >
                End discussion
              </AsyncButton>
            </>
          ) : (
            <>
              {decidable && (
                <>
                  <input
                    className="pm-note"
                    placeholder="Why (optional) — recorded either way"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <AsyncButton
                    className="primary"
                    title="Release the plan — each part gets its own agent, branch and pull request"
                    onClick={() => onDecide(decidable.id, 'accept', note.trim() || undefined)}
                  >
                    Approve plan
                  </AsyncButton>
                  <AsyncButton
                    className="ghost"
                    title="Retires the parts nothing has started for and works the issue as a single pull request"
                    onClick={() => onDecide(decidable.id, 'reject', note.trim() || undefined)}
                  >
                    Reject
                  </AsyncButton>
                </>
              )}
              <span className="spacer" />
              <AsyncButton
                className="ghost"
                title="Talk it through with an agent, which can amend the plan — nothing is scheduled while you do"
                onClick={() => onDiscuss(plan.id)}
              >
                Discuss…
              </AsyncButton>
              <AsyncButton
                className="ghost"
                title="Ask the planner again from the plan's current state. Nothing is torn down."
                onClick={() => onReplan(plan.id)}
              >
                Replan
              </AsyncButton>
            </>
          )}
        </div>
        <div className="muted small">updated {relTime(plan.updatedAt, now)}</div>
      </div>
    </div>
  );
}

function PartBlock({
  part,
  seq,
  queue,
  refUrls,
}: {
  part: PlanPart;
  seq: number;
  queue: QueueItem | undefined;
  refUrls: Record<string, string>;
}) {
  const dep = part.dependsOn[0];
  return (
    <div className="pm-part">
      <span className="pm-seq">{seq}</span>
      <div>
        <div className="pm-part-head">
          <span className="pm-part-title">{part.title}</span>
          <span className="chip small mono">{part.slug}</span>
          <span className="chip small">{part.status.replace('_', ' ')}</span>
          {part.prNumber !== null && <span className="chip small">{refLink(`#${part.prNumber}`, refUrls)}</span>}
          {queue && (
            <span
              className={`chip small${
                queue.status === 'dispatching'
                  ? ' ok'
                  : queue.status === 'capped' || queue.status === 'unapproved'
                    ? ' warn'
                    : ''
              }`}
              title={queue.reason}
            >
              {queue.status === 'dispatching' ? '▶ now' : queue.status}
            </span>
          )}
        </div>
        <div className="pm-scope">{part.scope}</div>
        {part.rationale && (
          <div className="pm-field">
            <b>why its own PR</b>
            {part.rationale}
          </div>
        )}
        {part.acceptance && (
          <div className="pm-field">
            <b>done when</b>
            {part.acceptance}
          </div>
        )}
        {/*
          Spelled out rather than left as an `on <slug>` chip: the stack edge is
          what decides which branch this part is cut from, and getting it wrong is
          the one planning mistake that is expensive to undo.
        */}
        <div className="pm-stack">
          {dep === undefined
            ? 'stacks on nothing — starts from the default branch'
            : `stacks on "${dep}" — based on that part's branch`}
        </div>
      </div>
    </div>
  );
}

/** The issue number a plan hangs off (`issue:12` → 12), or null for a shape we don't recognise. */
function issueOf(originRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}

/** A part's dispatch origin — the key the "Up next" queue is joined on. */
function originOf(issueNumber: number | null, slug: string): string {
  return issueNumber === null ? '' : `issue:${issueNumber}:part:${slug}`;
}
```

- [ ] **Step 5: Render it off the shell**

`web/src/App.tsx` — inside the returned fragment, after `<Root .../>` and before the work panel:

```tsx
{
  planModal;
}
```

and above the `return`, build it (the modal hangs off the shell for the same reason `WorkTreePanel` does — it is shared, and the skin seam forbids a skin reaching `api.js`):

```tsx
const state = status.view.state;
const viewedPlan = (state.plans ?? []).find((p) => p.id === status.view.viewingPlan) ?? null;
const planModal = viewedPlan ? (
  <PlanModal
    plan={viewedPlan}
    parts={(state.planParts ?? []).filter((p) => p.planId === viewedPlan.id).sort((a, b) => a.seq - b.seq)}
    upcoming={state.upcoming?.items ?? []}
    proposal={(state.proposals ?? []).find((p) => p.kind === 'plan' && p.ref === `${viewedPlan.originRef}:plan`)}
    agent={state.agents.find(
      (a) => status.view.taskFor(a)?.originRef === `${viewedPlan.originRef}:plan` && a.status !== 'done',
    )}
    now={status.view.now}
    refUrls={state.refUrls}
    onClose={() => status.actions.viewPlan(null)}
    onReplan={(id) => status.actions.replan(id)}
    onDiscuss={(id) => status.actions.discussPlan(id)}
    onEndDiscussion={(id) => status.actions.endPlanDiscussion(id)}
    onDecide={(id, verdict, note) => status.actions.decideProposal(id, verdict, note)}
    onOpenAgent={(id) => status.actions.select(id)}
    onRespond={(id, text) => status.actions.respondAgent(id, text)}
  />
) : null;
```

If `view.taskFor` does not exist with that signature, use whatever the view model exposes for task lookup — check `web/src/view/viewModel.ts` and match it.

- [ ] **Step 6: Append the CSS**

Append to the end of `web/src/styles.css` the `.plan-modal-backdrop`, `.plan-modal`, `.pm-head`, `.pm-title`, `.pm-close`, `.pm-tabs`, `.pm-tab`, `.pm-why`, `.pm-section-label`, `.pm-flags`, `.pm-flag`, `.pm-part`, `.pm-seq`, `.pm-part-head`, `.pm-part-title`, `.pm-scope`, `.pm-field`, `.pm-stack`, `.pm-cut`, `.pm-foot`, `.pm-note`, `.pm-doc` (and its `h1/h2/p/ul/ol/li/code/pre/blockquote` children), `.pm-discussion`, `.pm-note-line`, `.pm-say` rules. Use only existing custom properties (`--panel`, `--panel-2`, `--border`, `--text`, `--muted`, `--accent`, `--blue`, `--amber`, `--grey`, `--well`, `--amber-line`, `--blue-line`, `--blue-fill`, `--r-sm`, `--r-md`, `--r-lg`, `--font-mono`) so both skins theme it. Model `.plan-modal-backdrop` on `.drawer-backdrop` (`web/src/styles.css:868-875`) but with `justify-content: center; align-items: flex-start; padding: 28px 16px; overflow-y: auto`.

- [ ] **Step 7: Verify both typecheckers and the suite**

Run: `npm run typecheck && npm run typecheck:web && npm test`
Expected: PASS. The modal is not yet reachable from any skin, so the golden markup is unchanged.

- [ ] **Step 8: Commit**

```bash
npm run format
git add web/src/components/PlanModal.tsx web/src/types.ts web/src/api.ts web/src/demo/demoBackend.ts web/src/cockpit/ web/src/view/viewModel.ts web/src/App.tsx web/src/styles.css
git commit -m "The plan modal: the whole decomposition, on demand"
```

---

## Task 8: The entry points

**Files:**

- Modify: `web/src/components/EscalationCard.tsx`, `web/src/components/PlanPanel.tsx`
- Modify: `web/src/skins/classic/ClassicRoot.tsx` (~line 176-188 for `PlanPanel`, ~line 230-244 for `EscalationCard`, and the issues list)
- Modify: `web/src/skins/factory/FactoryRoot.tsx`, `web/src/skins/factory/components/TechTree.tsx`
- Test: `test/cockpitSkins.test.ts` — **golden regeneration required**

**Interfaces:**

- Consumes: `CockpitActions.viewPlan` (Task 7).
- Produces: nothing new.

- [ ] **Step 1: Add the button to `EscalationCard`**

Add an optional prop:

```tsx
  /** Open the full plan behind a `plan` proposal — the card carries a summary, not the decomposition. */
  onViewPlan?: (planId: string) => void;
```

and render it inside the existing `esc-agent-actions` area (or a new `<div className="esc-agent-actions">` when there is no agent), gated on the proposal kind:

```tsx
{
  proposal?.kind === 'plan' && onViewPlan && typeof context.planId === 'string' ? (
    <div className="esc-agent-actions">
      <button className="btn ghost small" onClick={() => onViewPlan(context.planId as string)}>
        View the full plan →
      </button>
    </div>
  ) : null;
}
```

`context.planId` is already set by the executor when it creates a `propose_plan` escalation.

- [ ] **Step 2: Add the button to `PlanPanel`**

Add `onViewPlan: (planId: string) => void;` to both `PlanPanel`'s and `PlanCard`'s props and thread it through. In `PlanCard`'s `plan-head`, before the existing replan button:

```tsx
<button
  className="btn ghost world-toggle"
  onClick={() => onViewPlan(plan.id)}
  title="The whole plan: every part's scope, why it is its own PR, and the planner's write-up"
>
  view
</button>
```

- [ ] **Step 3: Add the button to `TechTree`**

Same shape: a `onViewPlan` prop, a `view` button beside the existing replan control in the tech-tree header.

- [ ] **Step 4: Thread it from both roots**

`ClassicRoot.tsx` — pass `onViewPlan={(id) => actions.viewPlan(id)}` to `PlanPanel` and to `EscalationCard`. `FactoryRoot.tsx` — the same for `TechTree` and its alert bay's escalation cards.

- [ ] **Step 5: Make the issue pickup chip a button when the issue has a plan**

In `ClassicRoot.tsx`'s issue list, where `pickupChip(...)` is rendered, wrap it when a plan exists for that issue:

```tsx
{
  (() => {
    const plan = (state.plans ?? []).find((p) => p.originRef === `issue:${issue.number}`);
    return plan ? (
      <button
        className="btn ghost small chip-button"
        onClick={() => actions.viewPlan(plan.id)}
        title="Open the plan for this issue"
      >
        {pickupChip(issue)}
      </button>
    ) : (
      pickupChip(issue)
    );
  })();
}
```

Add a `.chip-button` rule to `styles.css` that strips button chrome (`background: none; border: none; padding: 0; font: inherit; cursor: pointer;`).

- [ ] **Step 6: Run the suite and regenerate the golden**

Run: `npm test`
Expected: FAIL on `classic renders its golden markup` — classic's DOM changed, which is exactly what the golden exists to catch.

Regenerate and inspect:

```bash
UPDATE_GOLDEN=1 npm test
git diff test/fixtures/classic-markup.html
```

Expected diff: only the new `view` buttons and the wrapped pickup chips. If anything else moved, that is a real regression — fix it rather than accepting the golden.

- [ ] **Step 7: Run the suite again**

Run: `npm test`
Expected: PASS, including `no skin imports the api client` (every new call goes through `actions`).

- [ ] **Step 8: Commit**

```bash
npm run format
git add web/src/components/EscalationCard.tsx web/src/components/PlanPanel.tsx web/src/skins/ web/src/styles.css test/fixtures/classic-markup.html
git commit -m "A plan is one click away from wherever it is mentioned"
```

---

## Task 9: The demo world shows an unapproved plan

**Files:**

- Modify: `web/src/demo/fixtures.ts`
- Test: `test/cockpitSkins.test.ts` — **golden regeneration required**

**Interfaces:**

- Consumes: everything above.
- Produces: demo coverage of the `awaiting_approval` state, which is also what the golden markup then asserts.

- [ ] **Step 1: Add the plan**

In `buildDemoState`'s `plans` array, after the existing `plan-212`:

```ts
      {
        id: 'plan-231',
        originRef: 'issue:231',
        title: 'Split the cockpit auth guard from the artifact route',
        status: 'awaiting_approval',
        reason:
          'The capability signer has to exist before the route can verify one, and the guard change touches every route.',
        risks:
          'Moving /artifacts outside the /api prefix means part 2 briefly serves artifacts with no guard at all — the capability check has to land in the same PR, not a later one.',
        outOfScope: 'Capability revocation, and any change to the cockpit bearer token. Artifact TTL stays at 5 minutes.',
        document:
          '# Serving artifacts outside the authenticated /api prefix\n\n' +
          'Every artifact chip in the cockpit currently 401s. This is not a bug in the guard — it is a structural ' +
          'consequence of where the route lives.\n\n' +
          '## Why it is broken\n\n' +
          'Opening a chip is a top-level browser navigation, and a navigation cannot carry the `Authorization` ' +
          'header the cockpit attaches to every `fetch`.\n\n' +
          '> Allow-listing the route inside the prefix guard is the tempting fix and the one to avoid. One ' +
          'exception is one line; the second one is a policy.\n\n' +
          '## Why three pull requests\n\n' +
          '1. The signer is a pure predicate with no callers.\n' +
          '2. The route change is the only part that alters who can reach what.\n' +
          '3. The snapshot change touches the cockpit as well as the server.\n\n' +
          '## The one thing I am unsure about\n\n' +
          'With `auth.enabled` off there is no signing key, so the route must serve with no capability at all. ' +
          'That means two modes and only one of them is covered by the capability tests.',
        discussing: false,
        createdAt: ago(12),
        updatedAt: ago(12),
      },
```

- [ ] **Step 2: Add its three parts**

Append three `planParts` entries with `planId: 'plan-231'`, slugs `signer` / `route` / `mint`, `seq` 1-3, `dependsOn` `[]` / `['signer']` / `['route']`, `status: 'ready'`, `branch: null`, `prNumber: null`, `taskId: null`, and a `rationale` and `acceptance` on each. Also add `rationale: null, acceptance: null` to the three existing `plan-212` parts so the type checks.

- [ ] **Step 3: Add the proposal and escalation**

In `proposals`, after `prop-1`:

```ts
      {
        id: 'prop-2',
        kind: 'plan',
        ref: 'issue:231:plan',
        status: 'pending',
        action: {
          type: 'propose_plan',
          reason: 'Issue #231 was decomposed into 3 part(s) and approval is required before any is scheduled.',
          planId: 'plan-231',
          originRef: 'issue:231',
        },
        note: null,
        decidedBy: null,
        decidedAt: null,
        escalationId: 'esc-3',
        createdAt: ago(12),
      },
```

In `escalations`, a matching `esc-3` with `type: 'approve_change'`, `status: 'open'`, a prompt summarising the split, `context: { originRef: 'issue:231', planId: 'plan-231' }`, `agentId: null`, `taskId: null`.

- [ ] **Step 4: Add the issue and the queue items**

Add issue 231 to `world.issues` (open, `lubbdubb-watch`, `pickup: { eligible: false, status: 'planning', reasons: ['0/3 parts merged'] }`), and two `upcoming.items` entries for `issue:231:part:signer` and `issue:231:part:route` with `status: 'unapproved'` and a reason naming the hold.

- [ ] **Step 5: Regenerate the golden and inspect**

```bash
UPDATE_GOLDEN=1 npm test
git diff test/fixtures/classic-markup.html
```

Expected: the new plan card, its parts, the approval escalation and the two `unapproved` queue rows. Nothing else.

- [ ] **Step 6: Verify in the browser**

Start the demo cockpit (`preview_start` with `.claude/launch.json`'s `cockpit-demo`, or `npm run web:dev:demo`), then:

- confirm the `#231` plan card renders `awaiting approval` with three `unapproved` parts;
- click `view` and confirm the modal opens on the Plan tab with risks, out-of-scope, and per-part `why its own PR` / `done when`;
- switch to Full write-up and confirm the markdown renders as headings, a blockquote and an ordered list — not as raw `#` characters;
- click `View the full plan →` on the approval card in "Needs you" and confirm it opens the same modal;
- confirm Approve/Reject appear in the modal footer, and that closing via the backdrop works.

- [ ] **Step 7: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npm run format
git add web/src/demo/fixtures.ts test/fixtures/classic-markup.html
git commit -m "The demo world carries a plan awaiting approval"
```

---

## Task 10: The discussion pane, end to end

**Files:**

- Test: `test/planDiscussion.test.ts`
- Modify: whatever Tasks 4-7 left incomplete (this task is the integration gate, not new surface).

**Interfaces:**

- Consumes: all of Tasks 4, 5, 7.
- Produces: nothing new.

- [ ] **Step 1: Write the failing integration test**

Append to `test/planDiscussion.test.ts`:

```ts
test('an amended plan ends the discussion and comes back as a fresh proposal', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await system.harness.runCycle('manual');
  const first = system.store.listProposals().find((p) => p.kind === 'plan')!;

  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });
  assert.equal(system.store.listProposals().find((p) => p.id === first.id)!.status, 'rejected');

  // The discussion agent submits an amended decomposition — the same ingestion
  // both transports share.
  const parsed = parsePlanDocument(
    JSON.stringify({
      version: 1,
      verdict: 'parts',
      reason: 'amended after discussion',
      document: '# Amended\n\nmint no longer stacks on route.',
      parts: [
        { slug: 'signer', title: 'Signer', scope: 'src/', dependsOn: [] },
        { slug: 'mint', title: 'Mint', scope: 'web/', dependsOn: ['signer'] },
      ],
    }),
  );
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  ingestPlanDocument(system.store, {
    doc: parsed.document,
    originRef: 'issue:231',
    title: 'Serve artifacts outside /api',
    requireApproval: true,
  });

  const amended = system.store.getPlan(plan.id)!;
  assert.equal(amended.discussing, false, 'submitting is what ends the discussion');
  assert.equal(amended.status, 'awaiting_approval');

  // A *fresh* proposal, not the withdrawn one: the withdrawal at discuss time is
  // what unblocks rule 3d, which would otherwise be held by a pending verdict.
  await system.harness.runCycle('manual');
  const pending = system.store.listProposals().filter((p) => p.kind === 'plan' && p.status === 'pending');
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0]!.id, first.id);
});

test('nothing is scheduled from a plan while it is being discussed', async () => {
  const { system, app } = await buildTestApp();
  const plan = seedAwaitingApprovalPlan(system);
  await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/discuss` });
  await system.harness.runCycle('manual');

  // Rule 4a schedules parts for `active`/`awaiting_approval` only, so a plan in
  // `planning` yields no part dispatch — and rule 3c cannot start a second
  // planner because the discussion agent holds `issue:231:plan`.
  const partTasks = system.store.listTasks().filter((t) => (t.originRef ?? '').includes(':part:'));
  assert.deepEqual(partTasks, []);
  const planners = system.store.listTasks().filter((t) => t.originRef === 'issue:231:plan');
  assert.equal(planners.length, 1, 'exactly one planner, however many pulses run');
});
```

- [ ] **Step 2: Run it**

Run: `node --import tsx --test test/planDiscussion.test.ts`
Expected: PASS if Tasks 4 and 5 are complete. If `discussing` is still true after ingestion, Task 4 Step 6 was missed.

- [ ] **Step 3: Verify the discussion pane in the browser**

The demo backend has no live agent on a planner origin, so drive this against a real harness: start it with `planning: { enabled: true }` in `lubbdubb.config.json`, open the cockpit, open a plan awaiting approval, click **Discuss…**, and confirm the modal switches to the discussion pane, that Approve/Reject are gone, that the message box posts, and that **End discussion** returns the plan to `awaiting approval`.

If a real run is impractical, add a temporary demo fixture with `discussing: true` and a live agent on `issue:231:plan`, screenshot the pane, then revert the fixture before committing.

- [ ] **Step 4: Commit**

```bash
npm run format
git add test/planDiscussion.test.ts
git commit -m "Discussion, end to end: amend ends it, and nothing schedules while it runs"
```

---

## Task 11: Documentation

**Files:**

- Modify: `docs/spec/08-planning.md`, `docs/spec/14-persistence.md`, `docs/spec/16-http-api.md`, `docs/spec/17-cockpit.md`, `CLAUDE.md`

**Interfaces:**

- Consumes: everything.
- Produces: nothing.

`docs/spec/` is the specification of how the application works, written as fact — when behaviour changes, the document that owns it changes in the same work.

- [ ] **Step 1: `docs/spec/08-planning.md`**

State that `requireApproval` is on by default and what that does and does not change; document the five document fields; document the discussion arm (the route, the `discussing` flag, rule 3c's second template, the three endings, and that nothing is scheduled meanwhile).

- [ ] **Step 2: `docs/spec/14-persistence.md`**

Document the four new `plans` columns and two new `plan_parts` columns, and note that unlike the original tables these needed `ensureColumns` entries.

- [ ] **Step 3: `docs/spec/16-http-api.md`**

Document `POST /api/plans/:id/discuss` and `POST /api/plans/:id/discuss/end`: bodies (none), responses, 404s, and that both kick a cycle.

- [ ] **Step 4: `docs/spec/17-cockpit.md`**

Document the plan modal, its two tabs, its entry points, and that it is shell-owned and opened through `CockpitActions.viewPlan`.

- [ ] **Step 5: Correct the CLAUDE.md line**

In the planning-funnel bullet, the sentence "`plans`/`plan_parts` are fresh `CREATE TABLE`s, so no `migrate()` entry" is now misleading. Replace with:

```
  `plans`/`plan_parts` were fresh `CREATE TABLE`s when introduced, so they needed no `migrate()`
  entry — but columns added to them **since** do, and have them (`risks`/`out_of_scope`/`document`/
  `discussing`, `rationale`/`acceptance`). `CREATE TABLE IF NOT EXISTS` never alters an existing
  table, so a column without an `ensureColumns` entry is invisible on every older database.
```

Also add a short bullet describing the discussion arm and the plan modal, in the file's existing style.

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run format
git add docs/spec/ CLAUDE.md
git commit -m "Specs: approval by default, the widened plan, the modal, and discussion"
```

---

## Self-Review Notes

Checked against `docs/spec/2026-07-28-plan-approval-and-discussion-design.md`:

- **Spec §1 (approval default)** → Task 1, including the inverted `planPart.test.ts` assertion the spec calls out.
- **Spec §2 (five fields, storage, `document` expected, trim-not-refuse)** → Tasks 2 and 3.
- **Spec §3 (modal, shell ownership, two tabs, markdown renderer, entry points, verdict buttons)** → Tasks 6, 7, 8.
- **Spec §4 (discussion: routes, `discussing`, rule 3c, three endings, no new transport)** → Tasks 4, 5, 10.
- **Spec "Testing" section** → Task 1 (planPart), Task 2 (planIngestion), Tasks 4/5/10 (planDiscussion), Task 6 (markdown), Tasks 8/9 (skins golden).
- **Spec "Spec documents to update"** → Task 11.

Two things the plan adds that the spec did not name, both discovered while reading the code:

1. **The golden markup test** (`test/fixtures/classic-markup.html`) gates every classic DOM change and every demo-fixture change. Regeneration is an explicit step in Tasks 8 and 9.
2. **`upsertPlan` must preserve the write-up on absence**, the way it already preserves `statusCommentRef` — otherwise the plan reconciler's status writes erase the narrative. Task 2 Step 7.
