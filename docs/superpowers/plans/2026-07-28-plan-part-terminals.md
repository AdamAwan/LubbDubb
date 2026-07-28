# Plan Part Terminals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a plan part finish without a pull request, so a part that produces a report or determines nothing needs building closes cleanly and its plan rolls up to `complete`.

**Architecture:** One new terminal `PlanPartStatus` (`concluded`) beside `merged`, four additive `plan_parts` columns, and a new `conclude_part` MCP tool the part's own agent calls. `merged` stays the code terminal so the whole PR-observation path is untouched; every `=== 'merged'` test that means _reached its terminal_ moves to one pure predicate, `partSettled`.

**Tech Stack:** TypeScript ESM (`nodenext`, explicit `.js` import extensions), better-sqlite3, zod, `node:test` via tsx, Preact/React cockpit under `web/`.

## Global Constraints

- ESM with explicit `.js` import extensions in every import, even from `.ts` sources.
- Comments explain **why**, not what. Match the surrounding terse, high-signal style.
- `npm run check` (`format:check && lint && typecheck && typecheck:web && knip && test`) must pass. knip runs every rule at `error`: an unused `export`, type, or public class member fails the build. Prefer dropping the `export` keyword over deleting.
- New columns on an **existing** table require an `ensureColumns(...)` entry in `Store.migrate()` — `CREATE TABLE IF NOT EXISTS` never alters an existing table.
- Never cast through `unknown`.
- Prompt templates are operator-overridable and `loadPromptTemplates` rejects only _unknown_ placeholders. Never add a new placeholder to an existing template — append to the rendered string instead.
- Commit after each task. Run `npm run check` before the final commit of each task that touches `src/` or `web/`.

---

### Task 1: Types, schema and store

**Files:**

- Modify: `src/types.ts:729` (`PlanPartStatus`), `src/types.ts:731-754` (`PlanPart`, `PlanPartInput`)
- Modify: `src/store/schema.ts:195-212` (`plan_parts` comment only — the CREATE TABLE gains the columns for fresh databases)
- Modify: `src/store/store.ts:114` (`ensureColumns`), `:661-698` (`upsertPlanParts`), `:718-742` (`updatePlanPart`), `:793-803` (`rollUpPlanStatus`), `:1612-1629` (`PlanPartRow`), `:1844-1864` (`rowToPlanPart`)
- Test: `test/planPart.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `PartOutcomeKind = 'code' | 'report' | 'determination'`; `PlanPart.expectedKind: PartOutcomeKind | null`, `.outcomeKind: PartOutcomeKind | null`, `.outcomeRef: string | null`, `.outcomeSummary: string | null`; `PlanPartInput.expectedKind: PartOutcomeKind | null`; `Store.concludePlanPart(id, {kind, ref, summary}): PlanPart | null`.

- [ ] **Step 1: Write the failing test**

Append to `test/planPart.test.ts`:

```ts
test('a concluded part is persisted with its outcome and cannot be concluded twice', () => {
  const store = new Store({ path: ':memory:' });
  const plan = store.upsertPlan({ originRef: 'issue:12', verdict: 'parts', reason: 'split', status: 'active' });
  store.upsertPlanParts(plan.id, [
    {
      slug: 'probe',
      seq: 1,
      title: 'Investigate',
      scope: 'src/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      expectedKind: 'report',
    },
  ]);
  const part = store.listPlanParts(plan.id)[0]!;
  assert.equal(part.expectedKind, 'report');
  assert.equal(part.outcomeKind, null);

  store.updatePlanPart(part.id, { status: 'dispatched' });
  const done = store.concludePlanPart(part.id, {
    kind: 'determination',
    ref: 'finding:f_1',
    summary: 'Already fixed by #98.',
  });
  assert.equal(done?.status, 'concluded');
  assert.equal(done?.outcomeKind, 'determination');
  assert.equal(done?.outcomeRef, 'finding:f_1');
  assert.equal(done?.outcomeSummary, 'Already fixed by #98.');

  // Idempotence lives in the write, not in a read-then-check.
  assert.equal(store.concludePlanPart(part.id, { kind: 'report', ref: null, summary: 'again' }), null);
});

test('a plan whose parts all concluded rolls up to complete', () => {
  const store = new Store({ path: ':memory:' });
  const plan = store.upsertPlan({ originRef: 'issue:12', verdict: 'parts', reason: 'split', status: 'active' });
  store.upsertPlanParts(plan.id, [
    {
      slug: 'probe',
      seq: 1,
      title: 'Investigate',
      scope: 'src/',
      dependsOn: [],
      rationale: null,
      acceptance: null,
      expectedKind: 'report',
    },
  ]);
  const part = store.listPlanParts(plan.id)[0]!;
  store.updatePlanPart(part.id, { status: 'dispatched' });
  store.concludePlanPart(part.id, { kind: 'report', ref: null, summary: 'Written up.' });
  assert.equal(store.rollUpPlanStatus(plan.id)?.status, 'complete');
});
```

Check the existing helper style at the top of `test/planPart.test.ts` first and reuse whatever plan/part factory is already there rather than duplicating it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/planPart.test.ts`
Expected: FAIL — `expectedKind` not accepted by `PlanPartInput`, `concludePlanPart` is not a function.

- [ ] **Step 3: Add the type members**

In `src/types.ts`, replace the `PlanPartStatus` declaration and its doc comment:

```ts
/**
 * Where one part of a multi-PR plan sits: `pending` (dependencies outstanding),
 * `ready` (dispatchable), `dispatched` (an agent is on it), `in_review` (its PR
 * is open), `merged`, `concluded` (finished without a pull request — a report or
 * a determination), `blocked`, or `retired` — a part an amended plan no longer
 * declares. Retiring is a *status transition, not a disappearance*: the row stays
 * so the graph remains readable after a replan, and nothing schedules it again.
 *
 * `merged` and `concluded` are both terminals; ask {@link partSettled} rather than
 * comparing, so the sites that mean "finished" cannot drift apart.
 */
type PlanPartStatus = 'pending' | 'ready' | 'dispatched' | 'in_review' | 'merged' | 'concluded' | 'blocked' | 'retired';

/**
 * What a part produces. `code` ends in a merged pull request, which the world
 * observes; the other two end in a record already durable in the store the moment
 * the agent writes it, which is why the reconciler's fold differs by kind.
 */
export type PartOutcomeKind = 'code' | 'report' | 'determination';
```

Add to the `PlanPart` interface, after `acceptance`:

```ts
/** What the planner expected this part to produce. Null means unstated, which reads as `code`. */
expectedKind: PartOutcomeKind | null;
/** What it actually produced, written when it concludes. Null until then; a merged part derives `code`. */
outcomeKind: PartOutcomeKind | null;
/** Optional evidence for a concluded part — `flag:<id>` or `finding:<id>`. */
outcomeRef: string | null;
/** What the concluding agent said it found. Required at close, so never empty on a concluded part. */
outcomeSummary: string | null;
```

Extend `PlanPartInput` to include `'expectedKind'`:

```ts
export type PlanPartInput = Pick<
  PlanPart,
  'slug' | 'seq' | 'title' | 'scope' | 'dependsOn' | 'rationale' | 'acceptance' | 'expectedKind'
>;
```

- [ ] **Step 4: Add the columns**

In `src/store/schema.ts`, the `plan_parts` CREATE TABLE gains four columns after `acceptance` (this covers fresh databases only):

```sql
  expected_kind   TEXT,                  -- code | report | determination; null = unstated, reads as code
  outcome_kind    TEXT,                  -- what it actually produced, written at close
  outcome_ref     TEXT,                  -- flag:<id> | finding:<id>, optional evidence
  outcome_summary TEXT,                  -- required at close
```

and its `status` comment becomes:

```sql
  status      TEXT NOT NULL,          -- pending | ready | dispatched | in_review | merged | concluded | blocked | retired
```

In `src/store/store.ts:114`, extend the existing entry — this is what makes them visible on an older database:

```ts
this.ensureColumns('plan_parts', {
  rationale: 'TEXT',
  acceptance: 'TEXT',
  expected_kind: 'TEXT',
  outcome_kind: 'TEXT',
  outcome_ref: 'TEXT',
  outcome_summary: 'TEXT',
});
```

In `PlanPartRow`, add after `acceptance` (same `| undefined` treatment, for the same reason):

```ts
/** Nullable *and* possibly absent: added by `migrate()` on databases from an older build. */
expected_kind: string | null | undefined;
outcome_kind: string | null | undefined;
outcome_ref: string | null | undefined;
outcome_summary: string | null | undefined;
```

In `rowToPlanPart`, add after `acceptance`:

```ts
    expectedKind: (r.expected_kind ?? null) as PartOutcomeKind | null,
    outcomeKind: (r.outcome_kind ?? null) as PartOutcomeKind | null,
    outcomeRef: r.outcome_ref ?? null,
    outcomeSummary: r.outcome_summary ?? null,
```

- [ ] **Step 5: Carry the declaration through `upsertPlanParts`**

In the `PlanPart` literal inside `upsertPlanParts`, after `acceptance: input.acceptance,`:

```ts
        expectedKind: input.expectedKind,
        // Progress, not declaration: an amendment re-declaring a part must not
        // wipe an outcome it already reached.
        outcomeKind: prev?.outcomeKind ?? null,
        outcomeRef: prev?.outcomeRef ?? null,
        outcomeSummary: prev?.outcomeSummary ?? null,
```

Extend the INSERT column list, the VALUES list and the ON CONFLICT DO UPDATE SET clause. `expected_kind` is part of the **declaration**, so it updates on conflict; the three outcome columns are progress and must not appear in the `DO UPDATE SET`:

```ts
const stmt = this.db.prepare(
  `INSERT INTO plan_parts (id, plan_id, slug, seq, title, scope, rationale, acceptance, expected_kind,
         outcome_kind, outcome_ref, outcome_summary, depends_on, branch, pr_number, status, task_id, created_at, updated_at)
       VALUES (@id, @planId, @slug, @seq, @title, @scope, @rationale, @acceptance, @expectedKind,
         @outcomeKind, @outcomeRef, @outcomeSummary, @dependsOn, @branch, @prNumber, @status, @taskId, @createdAt, @updatedAt)
       ON CONFLICT(plan_id, slug) DO UPDATE SET seq=excluded.seq, title=excluded.title, scope=excluded.scope,
         rationale=excluded.rationale, acceptance=excluded.acceptance, expected_kind=excluded.expected_kind,
         depends_on=excluded.depends_on, updated_at=excluded.updated_at`,
);
```

- [ ] **Step 6: Add `concludePlanPart` and settle the roll-up**

In `src/store/store.ts`, immediately after `markPartDispatched`:

```ts
  /**
   * A part finished without a pull request. Its own method rather than a
   * {@link updatePlanPart} patch, because the guard is the point: the write is
   * conditional on the part still being in flight, so a second call merges nothing
   * and a merged or retired part cannot be re-labelled. Idempotence in the write,
   * not in a read-then-check nobody remembers to do.
   */
  concludePlanPart(
    id: string,
    outcome: { kind: PartOutcomeKind; ref: string | null; summary: string },
  ): PlanPart | null {
    const updatedAt = this.now();
    const result = this.db
      .prepare(
        `UPDATE plan_parts SET status='concluded', outcome_kind=?, outcome_ref=?, outcome_summary=?, updated_at=?
         WHERE id=? AND status IN ('dispatched','in_review')`,
      )
      .run(outcome.kind, outcome.ref, outcome.summary, updatedAt, id);
    if (result.changes === 0) return null;
    const row = this.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    return row ? rowToPlanPart(row) : null;
  }
```

In `rollUpPlanStatus`, replace the `every` test — this is one of the sites the new predicate exists for:

```ts
const next: PlanStatus = parts.every(partSettled) ? 'complete' : 'active';
```

and add `partSettled` to the existing `import { liveParts } from '../plans/parts.js';` at `src/store/store.ts:6`. Import `PartOutcomeKind` from `../types.js` alongside the existing type imports.

`partSettled` does not exist yet — Task 2 writes it. Define it there first if you are working strictly in order; otherwise add this two-line stub to `src/plans/parts.ts` now and let Task 2 document it:

```ts
export function partSettled(part: PlanPart): boolean {
  return part.status === 'merged' || part.status === 'concluded';
}
```

- [ ] **Step 7: Run the tests**

Run: `npx tsx --test test/planPart.test.ts`
Expected: PASS, including the two new tests.

Then run the full suite, because `PlanPartInput` gained a required member and every existing construction site must be updated: `npm test`. Fix each compile error by adding `expectedKind: null` (or the declared kind) to the literal.

- [ ] **Step 8: Verify and commit**

Run: `npm run check`
Expected: all six stages pass.

```bash
git add -A
git commit -m "Plan parts: a concluded terminal, an outcome kind, and the columns to hold them"
```

---

### Task 2: The pure predicates in `parts.ts`

**Files:**

- Modify: `src/plans/parts.ts:75-79` (`dependencySatisfied`), `:86-95` (`partBase`), `:102-110` (`liveParts`, `planProgress`), `:166-168` (`partHasWork`), `:244-264` (`siblingContext`, `describe`), `:224-235` (`currentPlanSummary`)
- Modify: `src/dispatcher/issuePickup.ts:272-282` (the chip's wording)
- Test: `test/planPart.test.ts`

**Interfaces:**

- Consumes: `PlanPart.expectedKind/outcomeKind/outcomeSummary`, `PartOutcomeKind`, `partSettled` (Task 1).
- Produces: `partSettled(part): boolean`; `partOutcomeKind(part): PartOutcomeKind | null`; `planProgress(parts): { settled: number; total: number }` (field renamed from `merged`).

- [ ] **Step 1: Write the failing tests**

```ts
test('a concluded dependency is satisfied and its dependent bases on the default branch', () => {
  const dep = makePart({ slug: 'probe', status: 'concluded', branch: null });
  const dependent = makePart({ slug: 'build', dependsOn: ['probe'] });
  const index = bySlug([dep, dependent]);
  assert.equal(
    dependencySatisfied(dep, () => false),
    true,
  );
  // The guard that matters: a concluded part may never have pushed a branch, so
  // basing on it would hand WorktreeManager.ensure an unresolvable ref.
  assert.equal(partBase(dependent, index, 12, 'main'), 'main');
});

test('partOutcomeKind derives code for a merged part and reads the column for a concluded one', () => {
  assert.equal(partOutcomeKind(makePart({ status: 'merged' })), 'code');
  assert.equal(partOutcomeKind(makePart({ status: 'concluded', outcomeKind: 'report' })), 'report');
  assert.equal(partOutcomeKind(makePart({ status: 'dispatched' })), null);
});

test('planProgress counts concluded parts as settled', () => {
  const parts = [makePart({ slug: 'a', status: 'merged' }), makePart({ slug: 'b', status: 'concluded' })];
  assert.deepEqual(planProgress(parts), { settled: 2, total: 2 });
});

test('partHasWork holds for a concluded part, so an amendment cannot retire it', () => {
  assert.equal(partHasWork(makePart({ status: 'concluded' })), true);
  assert.deepEqual(partsToRetire([makePart({ slug: 'probe', status: 'concluded' })], []), []);
});
```

`makePart` is a local helper; if `test/planPart.test.ts` has no equivalent, add one that returns a full `PlanPart` with sensible defaults and spreads the override.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test test/planPart.test.ts`
Expected: FAIL — `partOutcomeKind` is not exported; `planProgress` returns `{ merged, total }`; `partBase` returns `issue/12/probe`.

- [ ] **Step 3: Implement**

Replace `partSettled`'s stub from Task 1 with the documented version, and add `partOutcomeKind` beside it:

```ts
/**
 * Has this part reached a terminal? Both `merged` and `concluded` mean finished,
 * and this is the one place that says so — every roll-up, progress count,
 * dependency test and sibling description asks it rather than comparing to
 * `merged`, which is what stops the sites disagreeing about what "done" is.
 */
export function partSettled(part: PlanPart): boolean {
  return part.status === 'merged' || part.status === 'concluded';
}

/**
 * What a part produced, or null while it is still in flight.
 *
 * `code` is **derived from `merged`, never stored**: a part that merged a pull
 * request has said what it produced by producing it, and writing the column too
 * would put a second answer in `observePartPr`'s path — one more thing the PR fold
 * could get wrong for no gain.
 */
export function partOutcomeKind(part: PlanPart): PartOutcomeKind | null {
  if (part.status === 'merged') return 'code';
  if (part.status === 'concluded') return part.outcomeKind;
  return null;
}
```

`dependencySatisfied` — a concluded dependency is finished, so there is nothing to wait for and no branch to test:

```ts
export function dependencySatisfied(dep: PlanPart, pushed: (part: PlanPart) => boolean): boolean {
  if (partSettled(dep)) return true;
  if (dep.status === 'dispatched' || dep.status === 'in_review') return pushed(dep);
  return false;
}
```

`partBase` — the guard the design calls out as a real bug if missed:

```ts
/**
 * The base a part's branch is cut from: its dependency's branch while that
 * dependency is still in flight (this is the stack), the integration branch once
 * the dependency reached a terminal or when there is none.
 *
 * `partSettled` rather than `merged` is load-bearing, not tidiness: a *concluded*
 * dependency produced no pull request and may never have pushed its branch at all,
 * so returning that branch would hand `WorktreeManager.ensure` a ref it cannot
 * resolve — which throws, by design, rather than silently picking an incidental base.
 */
export function partBase(
  part: PlanPart,
  index: Map<string, PlanPart>,
  issueNumber: number,
  defaultBranch: string,
): string {
  const dep = dependencyOf(part, index);
  if (!dep || partSettled(dep)) return defaultBranch;
  return dep.branch ?? partBranch(issueNumber, dep.slug);
}
```

`planProgress` — the field renames, so the wording downstream can stop saying "merged":

```ts
/** How far a plan has got, for the cockpit's per-issue chip. Counts every terminal, not just merges. */
export function planProgress(parts: PlanPart[]): { settled: number; total: number } {
  const live = liveParts(parts);
  return { settled: live.filter(partSettled).length, total: live.length };
}
```

`partHasWork` — a concluded part reached the outside world in the sense that matters here (an agent ran and produced a durable record), so an amendment must not retire it:

```ts
export function partHasWork(part: PlanPart): boolean {
  return part.status === 'dispatched' || part.status === 'in_review' || partSettled(part);
}
```

`siblingContext`'s `exists` predicate, and `describe`, so a concluded sibling is reported as finished but not as code the agent may find on its branch:

```ts
const exists = (p: PlanPart): boolean => partSettled(p) || p.status === 'in_review';
```

```ts
function describe(parts: PlanPart[], empty: string): string {
  if (parts.length === 0) return empty;
  return parts
    .map((p) => {
      const kind = partOutcomeKind(p);
      // A concluded part left a record, not a branch — saying "PR #n" or naming a
      // branch for one would send the agent looking for code that does not exist.
      const where =
        p.status === 'concluded'
          ? ` (${kind ?? 'concluded'}: ${p.outcomeSummary ?? 'no summary'})`
          : p.prNumber !== null
            ? ` (PR #${p.prNumber})`
            : p.branch !== null
              ? ` (branch ${p.branch})`
              : '';
      return `- ${p.title} [${p.slug}, ${p.status}${where}] — ${p.scope}`;
    })
    .join('\n');
}
```

`currentPlanSummary`'s per-part line, so a replanning planner sees which parts were write-ups:

```ts
const lines = live.map((p) => {
  const where =
    p.status === 'concluded'
      ? `${partOutcomeKind(p) ?? 'concluded'}: ${p.outcomeSummary ?? 'no summary'}`
      : p.prNumber !== null
        ? `PR #${p.prNumber}`
        : (p.branch ?? 'no branch yet');
  const dep = p.dependsOn[0];
  const stacks = dep === undefined ? '' : `, stacks on "${dep}"`;
  const expected = p.expectedKind && p.expectedKind !== 'code' ? `, expected to produce a ${p.expectedKind}` : '';
  return `- "${p.slug}": ${p.title} [${p.status}, ${where}${stacks}${expected}] — ${p.scope}`;
});
```

- [ ] **Step 4: Update the chip's wording**

In `src/dispatcher/issuePickup.ts:272-282`, rename the destructured field and stop saying merged:

```ts
const { settled, total } = planProgress(parts);
```

and in the string below it, `${settled}/${total} parts done`. Update the surrounding comment, which currently reads `"3/3 parts merged"`, to `"3/3 parts done"`.

- [ ] **Step 5: Run the tests**

Run: `npx tsx --test test/planPart.test.ts && npx tsx --test test/issuePickup.test.ts`
Expected: PASS. Any `issuePickup` test asserting the literal string `parts merged` needs its expectation updated to `parts done` — that is the intended behaviour change, not a regression.

- [ ] **Step 6: Verify and commit**

Run: `npm run check`

```bash
git add -A
git commit -m "Plan parts: one partSettled predicate for every site that means finished"
```

---

### Task 3: The zod boundary

**Files:**

- Modify: `src/plans/planDocument.ts:30-44` (`PartSchema`), `:183-193` (`planPartInputs`)
- Test: `test/planIngestion.test.ts`

**Interfaces:**

- Consumes: `PartOutcomeKind` (Task 1).
- Produces: plan documents accept an optional per-part `expectedKind`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a part may declare an expected outcome kind, and a bad one is refused synchronously', () => {
  const ok = validatePlanDocument({
    version: 1,
    verdict: 'parts',
    reason: 'investigate then fix',
    parts: [{ slug: 'probe', title: 'Investigate', scope: 'src/', expectedKind: 'report' }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && planPartInputs(ok.document)[0]?.expectedKind, 'report');

  const bad = validatePlanDocument({
    version: 1,
    verdict: 'parts',
    reason: 'x',
    parts: [{ slug: 'probe', title: 'Investigate', scope: 'src/', expectedKind: 'writeup' }],
  });
  assert.equal(bad.ok, false);
});

test('a parts verdict may be entirely non-code', () => {
  const result = validatePlanDocument({
    version: 1,
    verdict: 'parts',
    reason: 'this is an investigation, not a build',
    parts: [
      { slug: 'measure', title: 'Measure', scope: 'ci/', expectedKind: 'report' },
      { slug: 'decide', title: 'Decide', scope: 'docs/', dependsOn: ['measure'], expectedKind: 'determination' },
    ],
  });
  assert.equal(result.ok, true);
});

test('a part with no declared kind reads as unstated', () => {
  const result = validatePlanDocument({
    version: 1,
    verdict: 'parts',
    reason: 'x',
    parts: [{ slug: 'probe', title: 'Investigate', scope: 'src/' }],
  });
  assert.equal(result.ok && planPartInputs(result.document)[0]?.expectedKind, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test test/planIngestion.test.ts`
Expected: FAIL — `expectedKind` is stripped by the schema, so the first assertion gets `undefined` and the bad-kind document validates.

- [ ] **Step 3: Implement**

In `PartSchema`, after `acceptance`:

```ts
  /**
   * What this part produces. Optional and defaulted at read time rather than
   * here — an older plan, and an override that never learned the field, must
   * keep validating. `code` is the assumption everything else already made.
   */
  expectedKind: z.enum(['code', 'report', 'determination']).optional(),
```

In `planPartInputs`, add to the mapped object:

```ts
    expectedKind: part.expectedKind ?? null,
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test test/planIngestion.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run check`

```bash
git add -A
git commit -m "Plan documents: a part may declare the kind of outcome it expects"
```

---

### Task 4: The `conclude_part` pure layer

**Files:**

- Create: `src/mcp/partOutcome.ts`
- Test: `test/mcpChannel.test.ts`

**Interfaces:**

- Consumes: `PartOutcomeKind` (Task 1).
- Produces: `PART_OUTCOME_KINDS: readonly ['report','determination']`; `PART_OUTCOME_KIND_HELP: Record<'report'|'determination', string>`; `partConclusionOrigin(originRef): {ok:true, issueNumber:number, slug:string} | {ok:false, error:string}`; `validatePartConclusion(args): {ok:true, kind, summary, ref} | {ok:false, error:string}`.

- [ ] **Step 1: Write the failing tests**

```ts
test('partConclusionOrigin accepts only a part origin', () => {
  const ok = partConclusionOrigin('issue:12:part:schema');
  assert.deepEqual(ok, { ok: true, issueNumber: 12, slug: 'schema' });

  // Each refusal names the right tool for that caller, rather than silently scoping.
  for (const [ref, expect] of [
    ['issue:12', 'conclude_work'],
    ['issue:12:plan', 'plan_submit'],
    ['issue:12:assess', 'assess_issue'],
    ['pr:42:ci', 'conclude_part'],
  ] as const) {
    const result = partConclusionOrigin(ref);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes(expect), `${ref} should mention ${expect}`);
  }
});

test('validatePartConclusion refuses code, requires a summary, and accepts optional evidence', () => {
  // A code part finishes by merging a pull request, which the world observes.
  // Accepting `code` here would let an agent mark its own work finished with no PR.
  const code = validatePartConclusion({ kind: 'code', summary: 'done' });
  assert.equal(code.ok, false);
  assert.ok(!code.ok && code.error.includes('pull request'));

  assert.equal(validatePartConclusion({ kind: 'report', summary: '  ' }).ok, false);
  assert.equal(validatePartConclusion({ kind: 'report', summary: 'x'.repeat(2001) }).ok, false);

  const ok = validatePartConclusion({ kind: 'determination', summary: 'Already fixed by #98.' });
  assert.deepEqual(ok, { ok: true, kind: 'determination', summary: 'Already fixed by #98.', ref: null });

  const withRef = validatePartConclusion({ kind: 'report', summary: 'Written up.', evidenceRef: 'flag:fl_1' });
  assert.equal(withRef.ok && withRef.ref, 'flag:fl_1');

  assert.equal(validatePartConclusion({ kind: 'report', summary: 'x', evidenceRef: 'https://x' }).ok, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test test/mcpChannel.test.ts`
Expected: FAIL — module `src/mcp/partOutcome.js` not found.

- [ ] **Step 3: Implement**

Create `src/mcp/partOutcome.ts`:

```ts
import type { PartOutcomeKind } from '../types.js';

/**
 * The `conclude_part` tool's pure layer: what a part is allowed to say it produced.
 *
 * ## Why `code` is not one of the kinds
 *
 * A code part finishes by merging a pull request, and the world observes that —
 * `observePartPr` reads it off the provider every pulse. Accepting `code` here
 * would let an agent declare its own work finished with no pull request behind it,
 * which is precisely the false terminal that ruled *derivation* out (see the
 * design). The tool covers exactly the two outcomes that have no outside world to
 * observe them.
 *
 * ## Why the summary is required and not trimmed
 *
 * `conclude_work`'s rule, for its reason. A progress note is cheap and frequent, so
 * trimming beats refusing; a terminal is written once and read by an operator
 * deciding what the plan achieved, and a silently truncated one is worse than a
 * refusal the agent can act on.
 */

/** The kinds an agent may declare. `code` is deliberately absent — see above. */
export const PART_OUTCOME_KINDS = ['report', 'determination'] as const satisfies readonly PartOutcomeKind[];

type DeclarableKind = (typeof PART_OUTCOME_KINDS)[number];

export const PART_OUTCOME_KIND_HELP: Record<DeclarableKind, string> = {
  report: 'the deliverable is a write-up, a measurement or a document rather than a change to the code',
  determination:
    'you established that no change is needed here — it is already done, it is a duplicate, or the ' +
    'premise turned out to be wrong',
};

/** A summary long enough to be prose rather than a label, short of a pasted transcript. */
const MAX_PART_SUMMARY = 2000;

/**
 * Resolve a task's origin into the part it may conclude — or say why it may not.
 *
 * Only a part origin qualifies, and every other caller is refused by name rather
 * than scoped down: an agent handed `{ok: true}` would believe it had closed
 * something. Each refusal points at the tool that caller actually wants, the way
 * `conclusionOrigin`'s assessor arm points at `assess_issue`.
 */
export function partConclusionOrigin(
  originRef: string | null,
): { ok: true; issueNumber: number; slug: string } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const part = /^issue:(\d+):part:([a-z0-9][a-z0-9-]*)$/.exec(ref);
  if (part) return { ok: true, issueNumber: Number(part[1]), slug: part[2]! };

  const issue = /^issue:(\d+)$/.exec(ref);
  if (issue) {
    return {
      ok: false,
      error:
        `conclude_part closes one part of a decomposed issue, and you own the whole of issue ` +
        `#${issue[1]} rather than a part of it. Use conclude_work instead — it says whether the ` +
        `issue is finished, which is the verdict your origin carries.`,
    };
  }
  const planner = /^issue:(\d+):plan$/.exec(ref);
  if (planner) {
    return {
      ok: false,
      error:
        `conclude_part closes a part that has been worked, and you are planning issue #${planner[1]}, ` +
        `not delivering any of it. Submit your decomposition with plan_submit instead.`,
    };
  }
  const assessor = /^issue:(\d+):assess$/.exec(ref);
  if (assessor) {
    return {
      ok: false,
      error:
        `conclude_part closes a part you worked, and you were dispatched to assess issue ` +
        `#${assessor[1]} rather than to deliver any of it. Cast your verdict with assess_issue instead.`,
    };
  }
  return {
    ok: false,
    error:
      `conclude_part closes one part of a decomposed issue, and this task's origin is ` +
      `${ref || '(none)'}, which is not a part. Only the agent dispatched for a plan part concludes it.`,
  };
}

export function validatePartConclusion(
  args: Record<string, unknown>,
): { ok: true; kind: DeclarableKind; summary: string; ref: string | null } | { ok: false; error: string } {
  const kind = args.kind;
  if (kind === 'code') {
    return {
      ok: false,
      error:
        'a code part finishes by merging its pull request, which the harness observes for itself — ' +
        'there is nothing to declare. Open the pull request instead. If you found that no code is ' +
        'needed after all, that is kind "determination".',
    };
  }
  if (typeof kind !== 'string' || !PART_OUTCOME_KINDS.includes(kind as DeclarableKind)) {
    return {
      ok: false,
      error:
        `kind must be one of ${PART_OUTCOME_KINDS.join(', ')}. ` +
        PART_OUTCOME_KINDS.map((k) => `${k}: ${PART_OUTCOME_KIND_HELP[k]}`).join('. '),
    };
  }
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) {
    return {
      ok: false,
      error:
        'summary is required. Say what you found or produced — an operator reads this to decide what ' +
        'the plan achieved, and for a determination it is the whole record of why no code was written.',
    };
  }
  if (summary.length > MAX_PART_SUMMARY) {
    return {
      ok: false,
      error: `summary is too long (${summary.length} chars, max ${MAX_PART_SUMMARY}). Summarise it.`,
    };
  }
  const raw = args.evidenceRef;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return { ok: false, error: 'evidenceRef must be a string when given.' };
  }
  const ref = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  // A narrow vocabulary for the same reason `report_finding`'s ref has one: an
  // open-ended evidence field is an unqueryable junk drawer, and both records it
  // may name are already addressed this way elsewhere.
  if (ref !== null && !/^(flag|finding):\S+$/.test(ref)) {
    return {
      ok: false,
      error:
        'evidenceRef must be "flag:<id>" (an artifact you surfaced) or "finding:<id>" (something you ' +
        'reported with report_finding). Omit it if you have neither — the summary is what matters.',
    };
  }
  return { ok: true, kind: kind as DeclarableKind, summary, ref };
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test test/mcpChannel.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run check`
Expected: passes. If knip reports `PART_OUTCOME_KIND_HELP` or `PART_OUTCOME_KINDS` as unused, leave them exported — Task 5 consumes both. Run this task's commit only after Task 5 if knip blocks.

```bash
git add -A
git commit -m "conclude_part: the pure layer for a part that finishes without a PR"
```

---

### Task 5: Wire the tool

**Files:**

- Modify: `src/mcp/names.ts:26-35` (`MCP_TOOL_NAMES`)
- Modify: `src/agents/agentManager.ts` (add `recordPartOutcome` after `recordConclusion`)
- Modify: `src/mcp/tools.ts:36-58` (`AgentToolTarget`), and the tool array (append after `MCP_TOOL_NAMES[8]`'s entry)
- Modify: `src/issueConclusion.ts:139-148` (the part refusal now names `conclude_part`)
- Test: `test/mcpChannel.test.ts`, `test/planPart.test.ts`

**Interfaces:**

- Consumes: `partConclusionOrigin`, `validatePartConclusion`, `PART_OUTCOME_KINDS`, `PART_OUTCOME_KIND_HELP` (Task 4); `Store.concludePlanPart` (Task 1).
- Produces: `AgentManager.recordPartOutcome(agentId, kind, summary, ref): {ok:true, part: PlanPart} | {ok:false, error:string}`; the `conclude_part` MCP tool.

- [ ] **Step 1: Write the failing test**

```ts
test('a part agent concludes its part through the tool, and the plan completes', async () => {
  // Build a system with a plan whose single part is dispatched to this agent,
  // following whatever harness helper test/mcpChannel.test.ts already uses.
  const session = mcp.session(agentId);
  const result = await session.call('conclude_part', {
    kind: 'determination',
    summary: 'Already fixed by #98 — nothing to build here.',
  });
  assert.equal(result.isError ?? false, false);

  const part = store.listPlanParts(plan.id)[0]!;
  assert.equal(part.status, 'concluded');
  assert.equal(part.outcomeKind, 'determination');
  assert.equal(store.rollUpPlanStatus(plan.id)?.status, 'complete');
});

test('an agent on the whole issue cannot conclude a part', async () => {
  const session = mcp.session(issueAgentId);
  const result = await session.call('conclude_part', { kind: 'report', summary: 'x' });
  assert.equal(result.isError, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/mcpChannel.test.ts`
Expected: FAIL — unknown tool `conclude_part`.

- [ ] **Step 3: Register the name**

In `src/mcp/names.ts`, append to `MCP_TOOL_NAMES` after `'assess_issue'`:

```ts
  'conclude_part',
```

This puts it in `ALLOWED_MCP_TOOLS` automatically. Adding the tool to `buildTools` without adding it here yields a connected server whose every call is refused with nothing in the logs — the trap the module exists to prevent.

- [ ] **Step 4: Add the fleet-side transition**

In `src/agents/agentManager.ts`, after `recordConclusion`:

```ts
  /**
   * Record what a part produced, for a part that finishes without a pull request.
   *
   * Routed through the manager rather than straight to the store for
   * {@link recordConclusion}'s reason: the event repaints the cockpit now rather
   * than on the next pulse. Identity is structural — the part is resolved from the
   * credential's task origin, so an agent cannot conclude a sibling's work.
   *
   * @public — reached only through `AgentToolTarget` (`src/mcp/tools.ts`), which this
   * class satisfies structurally; knip's member analysis is name-based.
   */
  recordPartOutcome(
    agentId: string,
    kind: PartOutcomeKind,
    summary: string,
    ref: string | null,
  ): { ok: true; part: PlanPart } | { ok: false; error: string } {
    const agent = this.store.getAgent(agentId);
    const task = agent ? this.store.getTask(agent.taskId) : null;
    if (!agent || !task) return { ok: false, error: 'agent has no task' };
    const origin = partConclusionOrigin(task.originRef);
    if (!origin.ok) return { ok: false, error: origin.error };
    const plan = this.store.getPlanByOrigin(issueOrigin(origin.issueNumber));
    const part = plan ? this.store.listPlanParts(plan.id).find((p) => p.slug === origin.slug) : undefined;
    if (!part) {
      return { ok: false, error: `no part "${origin.slug}" is recorded for issue #${origin.issueNumber}.` };
    }
    const concluded = this.store.concludePlanPart(part.id, { kind, ref, summary });
    if (!concluded) {
      return {
        ok: false,
        error:
          `part "${origin.slug}" is "${part.status}" and only a part being worked can be concluded. ` +
          `A merged part already finished; a retired one was dropped by a replan.`,
      };
    }
    this.emit('partOutcome', { agentId, taskId: task.id, part: concluded });
    return { ok: true, part: concluded };
  }
```

Add the `partOutcome` event to the class's typed `emit`/`on` overrides beside `conclusion`. Confirm the exact accessor names for the plan lookup — if `getPlanByOrigin` is not the method's name, use whatever `planning.ts`/`planIngest.ts` already calls to fetch a plan by its `issue:<n>` origin, and reuse `issueOrigin` from `../plans/planning.js`.

- [ ] **Step 5: Add the tool**

In `src/mcp/tools.ts`, extend `AgentToolTarget`:

```ts
  recordPartOutcome(
    agentId: string,
    kind: PartOutcomeKind,
    summary: string,
    ref: string | null,
  ): { ok: true; part: PlanPart } | { ok: false; error: string };
```

and append the tool after the `assess_issue` entry:

```ts
    {
      name: MCP_TOOL_NAMES[9],
      description:
        'Close YOUR PART of a decomposed issue when it finished without a pull request. Most parts end ' +
        'in a merged PR and need nothing from you — the harness sees the merge itself. Call this only ' +
        'when there is no PR to open: the part was a write-up or a measurement ("report"), or you ' +
        'established that no change is needed at all ("determination" — it is already done, a ' +
        'duplicate, or the premise was wrong). Without it a part like that stays open forever and holds ' +
        'the whole plan, and its issue, open with it. Concluding your part says nothing about the other ' +
        'parts or about the issue as a whole.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [...PART_OUTCOME_KINDS],
            description: PART_OUTCOME_KINDS.map((k) => `${k}: ${PART_OUTCOME_KIND_HELP[k]}`).join('. '),
          },
          summary: {
            type: 'string',
            description:
              'What you produced or found. An operator reads this to decide what the plan achieved, and ' +
              'for a determination it is the entire record of why no code was written — so give the ' +
              'evidence, not just the conclusion.',
          },
          evidenceRef: {
            type: 'string',
            description:
              'Optional: "flag:<id>" for an artifact you surfaced, or "finding:<id>" for something you ' +
              'reported with report_finding. Omit it if you have neither.',
          },
        },
        required: ['kind', 'summary'],
      },
      handler: (args) => {
        const parsed = validatePartConclusion(args);
        if (!parsed.ok) return toolError(`Part conclusion rejected: ${parsed.error}`);
        // Structural identity, carrying more than attribution: the origin decides
        // which part this is, so an agent cannot conclude a sibling's work.
        const result = deps.agents.recordPartOutcome(agent.id, parsed.kind, parsed.summary, parsed.ref);
        if (!result.ok) return toolError(result.error);
        return ok({
          concluded: true,
          part: result.part.slug,
          outcome: result.part.outcomeKind,
          note:
            'Recorded. This part is finished and nothing further is dispatched for it. The rest of the ' +
            'plan is unaffected, and whether the issue itself is done is decided by the plan as a whole.',
        });
      },
    },
```

Import `PART_OUTCOME_KIND_HELP`, `PART_OUTCOME_KINDS`, `validatePartConclusion` from `./partOutcome.js`, and `PartOutcomeKind`/`PlanPart` from `../types.js`.

- [ ] **Step 6: Point `conclude_work`'s part refusal at the new tool**

In `src/issueConclusion.ts`, replace the `part` refusal's final sentence:

```ts
if (part) {
  return {
    ok: false,
    error:
      `conclude_work is for the whole issue, and you are working one part of issue #${part[1]}'s plan. ` +
      `The harness concludes a decomposed issue from its plan — when every part has finished, the issue ` +
      `is done, and no part agent has to say so. Finish your part: open its pull request, or if it ` +
      `finished without one (a write-up, or you found no change is needed) close it with conclude_part. ` +
      `If you believe the *plan* is wrong (a part is missing, or one is no longer needed), use report_finding.`,
  };
}
```

- [ ] **Step 7: Run tests**

Run: `npx tsx --test test/mcpChannel.test.ts && npx tsx --test test/planPart.test.ts`
Expected: PASS. `test/mcpChannel.test.ts`'s assertion that `MCP_TOOL_NAMES` matches the built tool set picks the new tool up with no edit — if it fails, `buildTools` and `names.ts` disagree.

- [ ] **Step 8: Verify and commit**

Run: `npm run check`

```bash
git add -A
git commit -m "conclude_part: wire the tool, the fleet transition and the store write"
```

---

### Task 6: Reconciliation and the status comment

**Files:**

- Modify: `src/plans/planReconciler.ts:110-117` (the fold loop's skip)
- Modify: `src/plans/planComment.ts` (heading, `statusMark`, `where`)
- Test: `test/planReconcile.test.ts`, `test/planPart.test.ts`

**Interfaces:**

- Consumes: `partSettled`, `partOutcomeKind` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

```ts
test('a concluded part is not dragged back by a PR appearing on its branch', async () => {
  // Set the part to `concluded`, then reconcile a world containing an open PR on
  // `issue/12/probe`. A report part has no PR, but a stray branch push must not
  // resurrect a finished part.
  await reconciler.reconcile(worldWithOpenPrOnBranch('issue/12/probe'));
  assert.equal(store.listPlanParts(plan.id)[0]?.status, 'concluded');
});

test('the plan status comment never describes a non-code part as merged', () => {
  const parts = [
    makePart({ slug: 'a', title: 'Build it', status: 'merged', prNumber: 7 }),
    makePart({
      slug: 'b',
      title: 'Write it up',
      status: 'concluded',
      outcomeKind: 'report',
      outcomeSummary: 'Findings in docs/perf.md',
    }),
  ];
  const body = renderPlanComment(makePlan({ status: 'complete' }), parts);
  assert.ok(body.includes('all 2 parts finished'));
  assert.ok(body.includes('report'));
  assert.ok(!/Write it up.*merged/.test(body));
});

test('a part whose actual kind differs from the planner expectation says so', () => {
  const parts = [
    makePart({
      slug: 'a',
      title: 'Build it',
      status: 'concluded',
      expectedKind: 'code',
      outcomeKind: 'determination',
      outcomeSummary: 'Already fixed by #98',
    }),
  ];
  assert.ok(renderPlanComment(makePlan({ status: 'complete' }), parts).includes('planned as code'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test test/planReconcile.test.ts && npx tsx --test test/planPart.test.ts`
Expected: FAIL — the comment says "merged", and `observePartPr` moves the concluded part to `in_review`.

- [ ] **Step 3: Skip concluded parts in the fold**

In `src/plans/planReconciler.ts`, extend the loop's existing `retired` skip:

```ts
for (const part of parts) {
  // A retired part is out of the plan: an amendment dropped it before anything
  // was started for it, so there is no reality to fold on and nothing that
  // should quietly bring it back.
  //
  // A concluded one is out for the opposite reason — it *finished*, and for a
  // report or a determination there is no outside world to observe: the record
  // was durable in the store the moment the agent wrote it. The only thing the
  // fold could do here is undo it, which is exactly what a stray branch push or
  // a PR opened on that branch would otherwise do.
  if (part.status === 'retired' || part.status === 'concluded') continue;
  const patch = this.foldPr(part, issueNumber, prs, closedPrs) ?? this.foldStalled(part, tasks);
  if (patch) next.set(part.slug, patch);
}
```

- [ ] **Step 4: Re-word the status comment**

Rewrite `src/plans/planComment.ts`'s heading, `statusMark` and `where`:

```ts
export function renderPlanComment(plan: Plan, parts: PlanPart[]): string {
  const { settled, total } = planProgress(parts);
  // "merged" was the only terminal when this was written. It is not any more, and
  // an operator reading "3/4 parts merged" on a plan whose fourth part was a
  // write-up is being told something false.
  const heading =
    plan.status === 'complete'
      ? `**Plan complete** — all ${total} part${total === 1 ? '' : 's'} finished.`
      : `**Plan in progress** — ${settled}/${total} part${total === 1 ? '' : 's'} done.`;
  const lines = parts.map((p) => `- ${statusMark(p)} **${p.title}** (\`${p.slug}\`) — ${where(p)}`);
  const why = plan.reason ? `\n\n${plan.reason}` : '';
  const tail =
    plan.status === 'complete' ? '\n\nNothing further is scheduled for this item. Closing it is a human decision.' : '';
  return `${MARKER}\n\n${heading}${why}\n\n${lines.join('\n')}${tail}`;
}
```

```ts
function statusMark(part: PlanPart): string {
  switch (part.status) {
    case 'merged':
    // A concluded part is finished, so it ticks. What kind of finish it was is
    // carried by `where`, not by a second mark nobody would know how to read.
    case 'concluded':
      return '[x]';
    case 'retired':
      return '[–]';
    case 'in_review':
      return '[~]';
    case 'dispatched':
      return '[>]';
    case 'blocked':
      return '[!]';
    default:
      return '[ ]';
  }
}

function where(part: PlanPart): string {
  if (part.status === 'concluded') {
    const kind = partOutcomeKind(part) ?? 'concluded';
    // Surfaced, never validated: the planner expecting code and the agent finding
    // a duplicate is information, not an error.
    const mismatch = part.expectedKind && part.expectedKind !== kind ? ` (planned as ${part.expectedKind})` : '';
    const summary = part.outcomeSummary ? ` — ${part.outcomeSummary}` : '';
    return `${kind}${mismatch}${summary}`;
  }
  if (part.prNumber !== null) return `${label(part)} · PR #${part.prNumber}`;
  if (part.branch !== null) return `${label(part)} · \`${part.branch}\``;
  return label(part);
}
```

Update the import at the top to `import { partOutcomeKind, planProgress } from './parts.js';`.

- [ ] **Step 5: Run tests**

Run: `npx tsx --test test/planReconcile.test.ts && npx tsx --test test/planPart.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

Run: `npm run check`

```bash
git add -A
git commit -m "Plans: a concluded part is not re-observed, and the comment stops saying merged"
```

---

### Task 7: What the part agent is told

**Files:**

- Modify: `src/dispatcher/promptTemplates.ts:60-90` (`issue-plan` default text), `:146-160` (`plan-part` default text)
- Modify: `src/dispatcher/ruleDispatcher.ts:1123-1134` (append to the rendered `plan-part` prompt)
- Modify: `src/plans/parts.ts` (add `partOutcomeNote`)
- Test: `test/planPart.test.ts`

**Interfaces:**

- Consumes: `PlanPart.expectedKind` (Task 1).
- Produces: `partOutcomeNote(part): string` — `''` for a code or unstated part.

- [ ] **Step 1: Write the failing test**

```ts
test('a part expected to produce no code is told so, appended rather than interpolated', () => {
  assert.equal(partOutcomeNote(makePart({ expectedKind: null })), '');
  assert.equal(partOutcomeNote(makePart({ expectedKind: 'code' })), '');
  const note = partOutcomeNote(makePart({ expectedKind: 'report' }));
  assert.ok(note.includes('conclude_part'));
  assert.ok(note.includes('report'));
  assert.ok(!note.includes('{'), 'the note is appended text, never a template with placeholders');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/planPart.test.ts`
Expected: FAIL — `partOutcomeNote` is not exported.

- [ ] **Step 3: Implement the note**

Add to `src/plans/parts.ts`:

```ts
/**
 * What a part expected to produce no code is told, appended to its rendered prompt.
 *
 * **Appended, never filled into the template.** Prompt templates are
 * operator-overridable and `loadPromptTemplates` rejects only *unknown*
 * placeholders, so a `{kind}` token would be silently dropped by exactly the
 * deployments that customised most — and this is the instruction without which the
 * part cannot finish at all. Appending has no fallback to get wrong.
 *
 * Empty for a `code` or unstated part: the default plan-part prompt already tells
 * it to open a pull request, and a part that turns out to need no code learns
 * `conclude_part` from the tool list, where it belongs.
 */
export function partOutcomeNote(part: PlanPart): string {
  if (!part.expectedKind || part.expectedKind === 'code') return '';
  const what =
    part.expectedKind === 'report'
      ? 'a write-up, a measurement or a document — not a change to the code'
      : 'a determination: whether anything needs doing here at all, and the evidence for it';
  return (
    `\n\n---\n\nThis part was planned to produce ${what}. So it may well end with no pull request, and ` +
    `that is a success rather than a failure. When you have finished, call **conclude_part** with kind ` +
    `"${part.expectedKind}" and a summary of what you found — that is the only thing that closes a part ` +
    `with no pull request behind it, and until you do, the whole plan and its issue stay open. If the ` +
    `work does turn out to need code, ignore this and open a pull request as normal.`
  );
}
```

- [ ] **Step 4: Append it at the dispatch site**

In `src/dispatcher/ruleDispatcher.ts`'s `partCandidate`, wrap the rendered prompt:

```ts
        prompt:
          this.templates.render('plan-part', {
            number: issueNumber,
            title: issue.title,
            part: part.title,
            scope: part.scope,
            branch,
            base,
            plan: plan.reason ?? 'the planner gave no reason',
            done,
            remaining,
          }) + partOutcomeNote(part),
```

Add `partOutcomeNote` to the existing `../plans/parts.js` import.

- [ ] **Step 5: Teach the planner it may declare a kind**

In `promptTemplates.ts`, the `issue-plan` template's parts example gains the field, and a paragraph explains it. Replace the two example part lines:

```ts
      '    {"slug": "schema", "title": "...", "scope": "src/store/...", "dependsOn": [],\n' +
      '     "expectedKind": "code", "rationale": "why this is its own PR", "acceptance": "what makes it done"},\n' +
      '    {"slug": "dispatcher", "title": "...", "scope": "src/dispatcher/...", "dependsOn": ["schema"],\n' +
      '     "expectedKind": "code", "rationale": "...", "acceptance": "..."}\n' +
```

and add after the slugs paragraph:

```ts
      '"expectedKind" is optional and defaults to "code" — a part that ends in a merged pull request. Use ' +
      '"report" for a part whose deliverable is a write-up or a measurement, and "determination" for one ' +
      'that decides whether anything needs doing at all. They exist so you can decompose investigative ' +
      'work honestly instead of inventing pull requests for it; do not reach for them when the work is ' +
      'genuinely code.\n\n' +
```

Update the `issue-plan` and `issue-replan` `doc` strings to mention `expectedKind` alongside `rationale`/`acceptance`. Make the same example change in the `issue-replan` template so an amendment can re-declare a kind.

Add to the `plan-part` template, before the final "Work on branch" paragraph:

```ts
      'If you find there is nothing to build here — it is already done, it is a duplicate, or the premise ' +
      'is wrong — do not open an empty pull request and do not just stop. Call conclude_part with kind ' +
      '"determination" and say what you found, and the part closes cleanly.\n\n' +
```

- [ ] **Step 6: Run tests**

Run: `npx tsx --test test/planPart.test.ts && npx tsx --test test/promptTemplates.test.ts`
Expected: PASS. If a template test asserts an exact default body, update the expectation — the wording change is intended.

- [ ] **Step 7: Verify and commit**

Run: `npm run check`

```bash
git add -A
git commit -m "Prompts: a non-code part is told how to finish, appended not interpolated"
```

---

### Task 8: Cockpit

**Files:**

- Modify: `web/src/types.ts:193-214` (`PlanPart`)
- Modify: `web/src/components/PlanPanel.tsx` (progress chip wording, per-part kind chip)
- Modify: `web/src/components/PlanModal.tsx` (kind and outcome summary)
- Modify: `web/src/skins/factory/techTree.ts` if it branches on `'merged'`

**Interfaces:**

- Consumes: the shipped `PlanPart` shape (Task 1).
- Produces: no new exports.

- [ ] **Step 1: Mirror the type**

In `web/src/types.ts`, add to `PlanPart` after `acceptance` and update the status comment:

```ts
/** 'code' | 'report' | 'determination' — what the planner expected. Null means unstated, which reads as code. */
expectedKind: string | null;
/** What it actually produced, once concluded. */
outcomeKind: string | null;
/** Optional evidence — 'flag:<id>' or 'finding:<id>'. */
outcomeRef: string | null;
/** What the concluding agent found. */
outcomeSummary: string | null;
/** 'pending' | 'ready' | 'dispatched' | 'in_review' | 'merged' | 'concluded' | 'blocked' | 'retired'. */
status: string;
```

Mark them optional (`?`) if the file's convention is to degrade gracefully against an older server — follow whatever the neighbouring `flags`/`overlaps` fields do.

- [ ] **Step 2: Update the panel**

In `PlanPanel.tsx`, the progress chip currently counts merged parts. Count both terminals and re-word:

```tsx
const settled = live.filter((p) => p.status === 'merged' || p.status === 'concluded').length;
```

with the chip reading `{settled}/{live.length} done` and its `title` becoming `"Parts finished out of the parts this plan still declares"`. Update the file's header comment, which quotes `"2/5 parts merged"`.

Give each part row a kind chip when the kind is not code: the expected kind while it is in flight, the actual kind once concluded, and a concluded row shows `outcomeSummary` as its detail line where a merged row shows its PR.

- [ ] **Step 3: Update the modal**

In `PlanModal.tsx`, render each part's expected kind beside its scope — this is the surface `planning.requireApproval` exists for, and seeing that step 3 is "write it up" before approving is the whole reason the expected kind is stored. For a concluded part show the actual kind and summary.

- [ ] **Step 4: Verify**

Run: `npm run typecheck:web && npm run check`
Expected: pass. Check `web/src/skins/factory/techTree.ts:47` — it excludes `retired`; confirm it treats `concluded` as a finished node rather than an in-flight one.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Cockpit: show what a part produced, not just whether it merged"
```

---

### Task 9: Documentation and the full gate

**Files:**

- Modify: `docs/spec/08-planning.md`
- Modify: `CLAUDE.md` (the "Plan parts" bullet, and the MCP tool channel list)

- [ ] **Step 1: Update the spec**

In `docs/spec/08-planning.md`, add a section on part terminals written as fact, covering: the `concluded` status beside `merged`; the four columns and their `ensureColumns` entry; that `code` is derived from `merged` and never stored; that the agent declares and the reconciler does not derive, with the reason (a positive terminal is never inferred from incidental output, and `foldStalled` makes a forgotten declaration a visible loop rather than a park); that `conclude_part` refuses `code` because the world observes a merge; that the reconciler's fold differs by kind because a report and a determination have no outside world; and that `partBase` returns the default branch for a concluded dependency because such a part may never have pushed.

- [ ] **Step 2: Update CLAUDE.md**

Extend the **Plan parts** bullet under "Where things live" with a sub-bullet stating the same properties in the file's voice, and add `conclude_part` to the MCP tool channel section's list of tools with a one-line note on why its kinds exclude `code`.

- [ ] **Step 3: Run the full gate**

Run: `npm run check`
Expected: all six stages pass.

- [ ] **Step 4: Commit and open the PR**

```bash
git add -A
git commit -m "Docs: plan part terminals"
git push -u origin issue/160
gh pr create --title "A plan part can finish without a pull request (#160)" --body "..."
```

The PR body states what shipped, the decisions and their reasons, and that it closes #160.

---

## Self-Review

**Spec coverage.** Data model → Task 1. Zod boundary → Task 3. `conclude_part` → Tasks 4–5. Reconciliation asymmetry → Task 6. Roll-up/progress/comment → Tasks 2 and 6. Dispatch unchanged plus the prompt → Task 7. Stacking → Task 2. Cockpit → Task 8. Testing → distributed across every task. Docs → Task 9. No spec section is unimplemented.

**Type consistency.** `PartOutcomeKind` is defined once in `src/types.ts` (Task 1) and imported by `parts.ts`, `partOutcome.ts`, `agentManager.ts` and `tools.ts`. `partSettled` is stubbed in Task 1 and documented in Task 2 — flagged explicitly in Task 1 Step 6 so the ordering is not a surprise. `planProgress`'s field rename `merged` → `settled` has exactly two consumers, both updated (Task 2 `issuePickup.ts`, Task 6 `planComment.ts`). `concludePlanPart`'s signature is identical in Tasks 1 and 5.

**Known imprecision.** Task 5 Step 4 names `Store.getPlanByOrigin`, which is not verified against the store's actual accessor; the step says to reuse whatever `planIngest.ts` already calls. Test-file helpers (`makePart`, `makePlan`, the mcpChannel harness) are described rather than reproduced, because they already exist in those files and duplicating them would be the worse error.
