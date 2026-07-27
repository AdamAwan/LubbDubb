# Work graph, stage 1 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a durable record of every node and edge in the work a LubbDubb harness does for an issue, so a merged PR that ages out of the world snapshot is still known to have merged.

**Architecture:** A pure fold (`src/graph/workGraph.ts`) turns the world snapshot plus store rows into node observations; a thin recorder writes them through `Store.recordWorkGraph`; `harness.ts` calls it once per pulse after `PlanReconciler` and before `Dispatcher.decide`. Nodes are keyed on refs that already exist (`issue:12`, `pr:41`, `pr:41:ci`), each has one `parent_ref` following work lineage plus a `base_ref` cross-link for stacking. Nothing in the dispatcher reads any of it — stage 1 is a lens.

**Tech Stack:** TypeScript (ESM, `nodenext`, explicit `.js` import extensions), `better-sqlite3` via `src/store/store.ts`, Fastify, React (cockpit under `web/`), `node:test` run through `tsx`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-28-work-graph-design.md`. Read it before starting.
- **ESM with explicit `.js` extensions on every relative import**, even from `.ts` sources.
- **`src/store/store.ts` is the only file that touches SQLite.** Nothing else opens the database.
- **`work_nodes` is a fresh `CREATE TABLE IF NOT EXISTS`, so it needs no `Store.migrate()` entry.** The two `CREATE INDEX IF NOT EXISTS` statements likewise.
- **knip runs with every rule at `error`.** An `export` nothing imports, a type nothing names, or an unused public class member turns `npm run check` red. If knip reports a type, **drop the `export` keyword** rather than deleting it — a type naming an exported function's parameters stays usable by callers unexported.
- **Two typecheckers:** `npm run typecheck` (server, `tsconfig.json`) and `npm run typecheck:web` (cockpit, `web/tsconfig.json`). A change spanning `src/` and `web/` must satisfy both.
- **Comments explain _why_, not _what_.** Match the surrounding terse, high-signal style. Do not narrate the code.
- **Verify with `npm run check`** (= `format:check && lint && typecheck && typecheck:web && knip && test`) before every commit. Run `npm run format` to fix formatting; never hand-format.
- **Do not edit unrelated test files.** All new tests go in `test/workGraph.test.ts` unless a task says otherwise.
- **Nothing under `src/dispatcher/` may import `src/graph/`.** Task 7 asserts this.

---

## File structure

| File                                                                                 | Responsibility                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `src/types.ts` (modify)                                                              | `WorkNode`, `WorkNodeKind`, `WorkNodeProvenance`, `WorkNodeObservation` domain types |
| `src/store/schema.ts` (modify)                                                       | `work_nodes` table + two indexes                                                     |
| `src/store/store.ts` (modify)                                                        | `recordWorkGraph`, `listWorkRoots`, `listWorkSubtree`                                |
| `src/graph/workGraph.ts` (create)                                                    | The pure fold — all edge inference, no I/O                                           |
| `src/graph/workGraphRecorder.ts` (create)                                            | Gathers store rows, calls the fold, writes, swallows-and-records errors              |
| `src/harness.ts` (modify)                                                            | Calls the recorder once per pulse                                                    |
| `src/system.ts` (modify)                                                             | Constructs the recorder, threads it into `Harness`                                   |
| `src/server/app.ts` (modify)                                                         | `GET /api/work`, `GET /api/work/:ref`                                                |
| `web/src/api.ts` (modify)                                                            | `getWorkRoots`, `getWorkSubtree` client methods                                      |
| `web/src/types.ts` (modify)                                                          | Cockpit-side `WorkNodeView`                                                          |
| `web/src/components/WorkTreePanel.tsx` (create)                                      | The panel                                                                            |
| `web/src/App.tsx` (modify)                                                           | Mounts the panel                                                                     |
| `test/workGraph.test.ts` (create)                                                    | Every test in this plan                                                              |
| `docs/spec/14-persistence.md`, `docs/spec/04-harness-cycle.md`, `CLAUDE.md` (modify) | Documentation                                                                        |

---

### Task 1: Types, schema and store methods

**Files:**

- Modify: `src/types.ts`
- Modify: `src/store/schema.ts`
- Modify: `src/store/store.ts`
- Test: `test/workGraph.test.ts` (create)

**Interfaces:**

- Consumes: nothing.
- Produces: `WorkNode`, `WorkNodeKind`, `WorkNodeProvenance`, `WorkNodeObservation` from `src/types.js`; `Store.recordWorkGraph(observations: WorkNodeObservation[]): void`, `Store.listWorkRoots(): WorkNode[]`, `Store.listWorkSubtree(rootRef: string): WorkNode[]`.

- [ ] **Step 1: Write the failing test**

Create `test/workGraph.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import type { WorkNodeObservation } from '../src/types.js';

function obs(over: Partial<WorkNodeObservation> & Pick<WorkNodeObservation, 'ref' | 'kind'>): WorkNodeObservation {
  return { title: over.ref, status: 'open', terminal: false, parentRef: null, ...over };
}

test('records nodes, reads a subtree and lists roots', () => {
  const store = new Store(':memory:');
  store.recordWorkGraph([
    obs({ ref: 'issue:12', kind: 'issue', title: 'Widget' }),
    obs({ ref: 'pr:40', kind: 'pr', parentRef: 'issue:12', title: 'PR #40' }),
    obs({ ref: 'pr:40:ci', kind: 'concern', parentRef: 'pr:40', title: 'CI fix', status: 'live' }),
    obs({ ref: 'issue:99', kind: 'issue', title: 'Unrelated' }),
  ]);

  assert.deepEqual(
    store.listWorkSubtree('issue:12').map((n) => n.ref),
    ['issue:12', 'pr:40', 'pr:40:ci'],
    'the subtree walks parent_ref down from the root',
  );
  assert.deepEqual(
    store
      .listWorkRoots()
      .map((n) => n.ref)
      .sort(),
    ['issue:12', 'issue:99'],
    'a root is a node with no parent',
  );
});

test('a parent is written once and never rewritten, but a null one can be filled', () => {
  const store = new Store(':memory:');
  store.recordWorkGraph([obs({ ref: 'pr:50', kind: 'pr', title: 'Stray PR' })]);
  store.recordWorkGraph([obs({ ref: 'pr:50', kind: 'pr', parentRef: 'issue:12', title: 'Stray PR' })]);
  assert.equal(store.listWorkSubtree('pr:50')[0]?.parentRef, 'issue:12', 'a null parent is adopted');

  store.recordWorkGraph([obs({ ref: 'pr:50', kind: 'pr', parentRef: 'issue:99', title: 'Stray PR' })]);
  assert.equal(store.listWorkSubtree('pr:50')[0]?.parentRef, 'issue:12', 'an existing parent is never rewritten');
});

test('a node not observed is left exactly as it was', () => {
  const store = new Store(':memory:');
  store.recordWorkGraph([
    obs({ ref: 'issue:12', kind: 'issue', title: 'Widget' }),
    obs({ ref: 'pr:40', kind: 'pr', parentRef: 'issue:12', title: 'PR #40', status: 'merged', terminal: true }),
  ]);
  store.recordWorkGraph([obs({ ref: 'issue:12', kind: 'issue', title: 'Widget' })]);

  const pr = store.listWorkSubtree('issue:12').find((n) => n.ref === 'pr:40');
  assert.equal(pr?.status, 'merged', 'an unobserved node keeps its status');
  assert.equal(pr?.terminal, true, 'and its terminal flag');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: FAIL — TypeScript cannot resolve `WorkNodeObservation`, and `store.recordWorkGraph is not a function`.

- [ ] **Step 3: Add the domain types**

In `src/types.ts`, after the `Job` interface:

```ts
/** What a work-graph node represents. `assess` is written only by stage 2. */
export type WorkNodeKind = 'issue' | 'plan' | 'part' | 'pr' | 'concern' | 'job' | 'assess';

/**
 * How a PR node's terminal state was learned. `observed` means it was seen in
 * `closedPullRequests`; `inferred` means it left the open set and the window never
 * showed it. The distinction is kept because absence-means-merged is a deliberate
 * fallback, and a durable record has no reason to forget that it *was* one.
 */
export type WorkNodeProvenance = 'observed' | 'inferred';

/**
 * One node of the durable work graph: what the harness did for a work item, and
 * what it descended from. Keyed on the ref vocabulary that already exists
 * (`issue:12`, `issue:12:part:schema`, `pr:41`, `pr:41:ci`) so it joins to every
 * gate, override and proposal without a second naming scheme.
 *
 * `parentRef` follows *work lineage* — a PR's parent is the part that produced it.
 * Stacking is a different relation and lives on `baseRef`, which keeps the graph a
 * tree and stops it lying about what caused the work.
 */
export interface WorkNode {
  ref: string;
  kind: WorkNodeKind;
  parentRef: string | null;
  /** PR nodes only: the PR this one is based on, from `basePrOf`. */
  baseRef: string | null;
  title: string;
  status: string;
  terminal: boolean;
  provenance: WorkNodeProvenance | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** One node as observed this pulse. Timestamps are the store's to stamp. */
export interface WorkNodeObservation {
  ref: string;
  kind: WorkNodeKind;
  parentRef?: string | null;
  baseRef?: string | null;
  title: string;
  status: string;
  terminal: boolean;
  provenance?: WorkNodeProvenance | null;
}
```

- [ ] **Step 4: Add the table**

In `src/store/schema.ts`, immediately before the `CREATE INDEX` block at the end of `SCHEMA`:

```sql
-- The durable work graph: every node the harness has observed for a work item and
-- what it descended from. Written once per pulse from the world plus the store's
-- own rows, and **never deleted** — that is the whole feature. A merged PR ages out
-- of `closedPullRequests` after `closedPrWindowMs`, and without this the edge from
-- an issue to the PR that delivered it is unrecoverable from that moment on.
CREATE TABLE IF NOT EXISTS work_nodes (
  ref           TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  parent_ref    TEXT,
  base_ref      TEXT,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  terminal      INTEGER NOT NULL DEFAULT 0,
  provenance    TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
```

Then add both indexes alongside the existing ones:

```sql
CREATE INDEX IF NOT EXISTS idx_work_nodes_parent ON work_nodes(parent_ref);
CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_ref);
```

- [ ] **Step 5: Add the store methods**

In `src/store/store.ts`, add the row type beside the other `*Row` interfaces:

```ts
interface WorkNodeRow {
  ref: string;
  kind: string;
  parent_ref: string | null;
  base_ref: string | null;
  title: string;
  status: string;
  terminal: number;
  provenance: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function rowToWorkNode(row: WorkNodeRow): WorkNode {
  return {
    ref: row.ref,
    kind: row.kind as WorkNodeKind,
    parentRef: row.parent_ref,
    baseRef: row.base_ref,
    title: row.title,
    status: row.status,
    terminal: row.terminal === 1,
    provenance: row.provenance as WorkNodeProvenance | null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}
```

Add `WorkNode`, `WorkNodeKind`, `WorkNodeObservation`, `WorkNodeProvenance` to the existing `import type { … } from '../types.js';` list. Then the three methods, as class members:

```ts
  /**
   * Write this pulse's observations. Upsert-only: a node not in `observations` is
   * left exactly as it was, which is what makes the graph outlive the world's
   * memory of a merged PR.
   *
   * `parent_ref` is write-once once non-null — work lineage does not change, and an
   * immutable edge makes a cycle impossible rather than merely guarded, which
   * matters because {@link listWorkSubtree} is recursive. A null parent may still be
   * filled later, so a stray PR can be adopted when its issue link appears.
   */
  recordWorkGraph(observations: WorkNodeObservation[]): void {
    const ts = this.now();
    const stmt = this.db.prepare(`
      INSERT INTO work_nodes
        (ref, kind, parent_ref, base_ref, title, status, terminal, provenance, first_seen_at, last_seen_at)
      VALUES
        (@ref, @kind, @parentRef, @baseRef, @title, @status, @terminal, @provenance, @ts, @ts)
      ON CONFLICT(ref) DO UPDATE SET
        kind         = excluded.kind,
        parent_ref   = COALESCE(work_nodes.parent_ref, excluded.parent_ref),
        base_ref     = COALESCE(excluded.base_ref, work_nodes.base_ref),
        title        = excluded.title,
        status       = excluded.status,
        terminal     = excluded.terminal,
        provenance   = excluded.provenance,
        last_seen_at = excluded.last_seen_at
    `);
    const write = this.db.transaction((rows: WorkNodeObservation[]) => {
      for (const o of rows)
        stmt.run({
          ref: o.ref,
          kind: o.kind,
          parentRef: o.parentRef ?? null,
          baseRef: o.baseRef ?? null,
          title: o.title,
          status: o.status,
          terminal: o.terminal ? 1 : 0,
          provenance: o.provenance ?? null,
          ts,
        });
    });
    write(observations);
  }

  /** Every node with no parent — one per work item the harness has ever touched. */
  listWorkRoots(): WorkNode[] {
    const rows = this.db
      .prepare(`SELECT * FROM work_nodes WHERE parent_ref IS NULL ORDER BY last_seen_at DESC`)
      .all() as WorkNodeRow[];
    return rows.map(rowToWorkNode);
  }

  /**
   * One root and everything beneath it. `UNION` rather than `UNION ALL` so the walk
   * terminates even if a cycle ever reached the table — belt to the write-once
   * parent's braces.
   */
  listWorkSubtree(rootRef: string): WorkNode[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE sub(ref) AS (
           SELECT ref FROM work_nodes WHERE ref = ?
           UNION
           SELECT n.ref FROM work_nodes n JOIN sub s ON n.parent_ref = s.ref
         )
         SELECT w.* FROM work_nodes w JOIN sub ON w.ref = sub.ref
         ORDER BY w.first_seen_at ASC, w.ref ASC`,
      )
      .all(rootRef) as WorkNodeRow[];
    return rows.map(rowToWorkNode);
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Run the full check**

Run: `npm run check`
Expected: PASS. If knip flags `WorkNodeProvenance` or `WorkNodeObservation` as unused, leave them exported — task 2 imports both. If it flags them _after_ task 2 lands, drop the `export` keyword rather than deleting the type.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/store/schema.ts src/store/store.ts test/workGraph.test.ts
git commit -m "Work graph: the work_nodes table and its three store methods

Upsert-only so a node not observed this pulse is left exactly as it was —
the property the whole record exists for. parent_ref is write-once once
non-null, which makes a cycle impossible rather than guarded, and lets a
stray PR be adopted when its issue link turns up."
```

---

### Task 2: The pure fold — issue, plan and part nodes

**Files:**

- Create: `src/graph/workGraph.ts`
- Test: `test/workGraph.test.ts` (modify)

**Interfaces:**

- Consumes: `WorkNode`, `WorkNodeObservation` from `src/types.js` (task 1); `planIssueNumber`, `partOrigin` from `src/plans/parts.js`; `planOrigin`, `issueOrigin` from `src/plans/planning.js`.
- Produces: `foldWorkGraph(input: WorkGraphInput): WorkNodeObservation[]` and the `WorkGraphInput` type, both from `src/graph/workGraph.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/workGraph.test.ts` (add the imports at the top of the file alongside the existing ones):

```ts
import { foldWorkGraph, type WorkGraphInput } from '../src/graph/workGraph.js';
import type { Issue, Plan, PlanPart, WorldSnapshot } from '../src/types.js';

function world(over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return { pullRequests: [], closedPullRequests: [], issues: [], stories: [], ...over };
}

function issue(over: Partial<Issue> = {}): Issue {
  return { id: 'i12', number: 12, title: 'Widget', body: '', labels: [], state: 'open', ...over };
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'pl1',
    originRef: 'issue:12',
    title: 'Widget plan',
    status: 'active',
    reason: null,
    statusCommentRef: null,
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

function part(over: Partial<PlanPart> = {}): PlanPart {
  return {
    id: 'pl1:schema',
    planId: 'pl1',
    slug: 'schema',
    seq: 1,
    title: 'Schema',
    scope: 'the tables',
    dependsOn: null,
    branch: null,
    prNumber: null,
    status: 'ready',
    taskId: null,
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

function input(over: Partial<WorkGraphInput> = {}): WorkGraphInput {
  return { world: world(), tasks: [], plans: [], parts: [], jobs: [], existing: [], ...over };
}

/** The observation for `ref`, or a failed assertion naming what was produced. */
function node(out: WorkNodeObservation[], ref: string): WorkNodeObservation {
  const found = out.find((n) => n.ref === ref);
  assert.ok(found, `expected a node ${ref}, got: ${out.map((n) => n.ref).join(', ')}`);
  return found;
}

test('an open issue is a root, and a closed one is terminal', () => {
  const open = foldWorkGraph(input({ world: world({ issues: [issue()] }) }));
  assert.equal(node(open, 'issue:12').parentRef, null);
  assert.equal(node(open, 'issue:12').kind, 'issue');
  assert.equal(node(open, 'issue:12').terminal, false);

  const closed = foldWorkGraph(input({ world: world({ issues: [issue({ state: 'closed' })] }) }));
  assert.equal(node(closed, 'issue:12').terminal, true, 'the tracker status is the only terminal marker');
  assert.equal(node(closed, 'issue:12').status, 'closed');
});

test("an issue's native workflow state is its status when it has one", () => {
  const out = foldWorkGraph(input({ world: world({ issues: [issue({ workItemState: 'In Review' })] }) }));
  assert.equal(node(out, 'issue:12').status, 'In Review');
  assert.equal(node(out, 'issue:12').terminal, false, 'a review state is not terminal');
});

test('a plan and its parts hang off the issue', () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue()] }),
      plans: [plan()],
      parts: [part(), part({ id: 'pl1:api', slug: 'api', seq: 2, title: 'API', status: 'merged' })],
    }),
  );
  assert.equal(node(out, 'issue:12:plan').parentRef, 'issue:12');
  assert.equal(node(out, 'issue:12:plan').kind, 'plan');
  assert.equal(node(out, 'issue:12:part:schema').parentRef, 'issue:12');
  assert.equal(node(out, 'issue:12:part:schema').kind, 'part');
  assert.equal(node(out, 'issue:12:part:schema').terminal, false);
  assert.equal(node(out, 'issue:12:part:api').terminal, true, 'a merged part is terminal');
});

test('a retired part stays in the graph and is terminal', () => {
  const out = foldWorkGraph(
    input({ world: world({ issues: [issue()] }), plans: [plan()], parts: [part({ status: 'retired' })] }),
  );
  assert.equal(node(out, 'issue:12:part:schema').status, 'retired');
  assert.equal(node(out, 'issue:12:part:schema').terminal, true);
});

test('the fold is idempotent — the same input twice produces the same output', () => {
  const args = input({ world: world({ issues: [issue()] }), plans: [plan()], parts: [part()] });
  assert.deepEqual(foldWorkGraph(args), foldWorkGraph(args));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: FAIL — cannot find module `../src/graph/workGraph.js`.

- [ ] **Step 3: Write the fold**

Create `src/graph/workGraph.ts`:

```ts
import type { Job, Plan, PlanPart, Task, WorkNode, WorkNodeObservation, WorldSnapshot } from '../types.js';
import { planIssueNumber, partOrigin } from '../plans/parts.js';
import { issueOrigin, planOrigin } from '../plans/planning.js';

/**
 * Everything the fold reads: this pulse's world, the store rows that hold intent,
 * and the graph as it already stands. `existing` is what lets the fold apply
 * "observed beats inferred" without the store needing an opinion about it.
 */
export interface WorkGraphInput {
  world: WorldSnapshot;
  tasks: Task[];
  plans: Plan[];
  parts: PlanPart[];
  jobs: Job[];
  existing: WorkNode[];
}

/**
 * Turn this pulse into node observations.
 *
 * Pure over its input, and **emits only what it observed** — a node absent from the
 * result is not deleted, it is left alone by {@link Store.recordWorkGraph}. That is
 * the property the record exists for: `closedPullRequests` remembers a merge for
 * `closedPrWindowMs` and then forgets, and the graph must not.
 *
 * Every edge here is already computed somewhere in the pulse (`observePartPr`,
 * `openPrForIssue`, `basePrOf`); this is where they stop being thrown away.
 */
export function foldWorkGraph(input: WorkGraphInput): WorkNodeObservation[] {
  const out: WorkNodeObservation[] = [];

  for (const issue of input.world.issues) {
    const closed = issue.state === 'closed';
    out.push({
      ref: issueOrigin(issue.number),
      kind: 'issue',
      parentRef: null,
      title: issue.title,
      // The tracker's own word, kept raw when it has a richer model than open/closed
      // — the harness reads completion here and never computes it.
      status: closed ? 'closed' : (issue.workItemState ?? 'open'),
      terminal: closed,
    });
  }

  const issueOfPlan = new Map<string, number>();
  for (const plan of input.plans) {
    const n = planIssueNumber(plan.originRef);
    if (n === null) continue;
    issueOfPlan.set(plan.id, n);
    out.push({
      ref: planOrigin(n),
      kind: 'plan',
      parentRef: issueOrigin(n),
      title: plan.title,
      status: plan.status,
      terminal: plan.status === 'complete' || plan.status === 'abandoned',
    });
  }

  for (const part of input.parts) {
    const n = issueOfPlan.get(part.planId);
    if (n === undefined) continue; // a part whose plan names no issue schedules nothing
    out.push({
      ref: partOrigin(n, part.slug),
      kind: 'part',
      parentRef: issueOrigin(n),
      title: part.title,
      status: part.status,
      // Retired is terminal in the same way merged is: the row stays so the graph
      // remains readable after a replan, and nothing schedules it again.
      terminal: part.status === 'merged' || part.status === 'retired',
    });
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: PASS. `Task`, `Job` and `WorkNode` are imported but not yet used by the fold body — TypeScript's `noUnusedLocals` will complain. Leave `WorkGraphInput` complete (tasks 3 and 4 fill the body); if the check fails on the unused imports, that is the signal to do tasks 3 and 4 before committing. If you need a green commit here, temporarily narrow the import list to the types actually referenced and restore it in task 3.

- [ ] **Step 6: Commit**

```bash
git add src/graph/workGraph.ts test/workGraph.test.ts
git commit -m "Work graph: fold issue, plan and part nodes

The issue node is its own pickup work node — issueOrigin(12) and the world
ref are the same string, and inventing issue:12:work would break the join
with every existing gate for no gain. Terminal on an issue is the tracker's
closed state and nothing else: completion is read, never computed."
```

---

### Task 3: The pure fold — PR nodes, terminal provenance and `base_ref`

**Files:**

- Modify: `src/graph/workGraph.ts`
- Test: `test/workGraph.test.ts`

**Interfaces:**

- Consumes: `foldWorkGraph`, `WorkGraphInput` (task 2); `prState`, `basePrOf` from `src/prHealth.js`; `issueBranch` from `src/dispatcher/issuePickup.js`.
- Produces: no new exports — extends `foldWorkGraph`'s output with `pr:<n>` nodes carrying `baseRef`, `terminal` and `provenance`.

- [ ] **Step 1: Write the failing test**

Append to `test/workGraph.test.ts` (add `PullRequest` to the existing `types.js` type import):

```ts
function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'p40',
    number: 40,
    title: 'PR #40',
    branch: 'issue/12',
    ciStatus: 'passing',
    unresolvedComments: [],
    ...over,
  };
}

test('a PR is parented to the issue whose branch it is on', () => {
  const out = foldWorkGraph(input({ world: world({ issues: [issue()], pullRequests: [pr()] }) }));
  assert.equal(node(out, 'pr:40').parentRef, 'issue:12');
  assert.equal(node(out, 'pr:40').kind, 'pr');
  assert.equal(node(out, 'pr:40').status, 'open');
  assert.equal(node(out, 'pr:40').terminal, false);
});

test('a PR is parented to the plan part that produced it, in preference to the issue', () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue()], pullRequests: [pr({ number: 41, branch: 'issue/12/schema' })] }),
      plans: [plan()],
      parts: [part({ prNumber: 41, branch: 'issue/12/schema', status: 'in_review' })],
    }),
  );
  assert.equal(node(out, 'pr:41').parentRef, 'issue:12:part:schema', 'work lineage, not the nearest ancestor');
});

test('a PR seen in the closed list is terminal, and says it was observed', () => {
  const merged = foldWorkGraph(
    input({ world: world({ issues: [issue()], closedPullRequests: [pr({ state: 'merged' })] }) }),
  );
  assert.equal(node(merged, 'pr:40').status, 'merged');
  assert.equal(node(merged, 'pr:40').terminal, true);
  assert.equal(node(merged, 'pr:40').provenance, 'observed');

  const abandoned = foldWorkGraph(
    input({ world: world({ issues: [issue()], closedPullRequests: [pr({ state: 'closed' })] }) }),
  );
  assert.equal(node(abandoned, 'pr:40').status, 'closed');
  assert.equal(node(abandoned, 'pr:40').terminal, true);
});

test('a PR that was open and is now absent is inferred merged', () => {
  const existing: WorkNode[] = [
    {
      ref: 'pr:40',
      kind: 'pr',
      parentRef: 'issue:12',
      baseRef: null,
      title: 'PR #40',
      status: 'open',
      terminal: false,
      provenance: null,
      firstSeenAt: '2026-07-28T09:00:00.000Z',
      lastSeenAt: '2026-07-28T09:00:00.000Z',
    },
  ];
  const out = foldWorkGraph(input({ world: world({ issues: [issue()] }), existing }));
  assert.equal(node(out, 'pr:40').status, 'merged');
  assert.equal(node(out, 'pr:40').terminal, true);
  assert.equal(node(out, 'pr:40').provenance, 'inferred', 'absence-means-merged stays, but says so');
});

test('an observed terminal is never downgraded to an inference', () => {
  const existing: WorkNode[] = [
    {
      ref: 'pr:40',
      kind: 'pr',
      parentRef: 'issue:12',
      baseRef: null,
      title: 'PR #40',
      status: 'merged',
      terminal: true,
      provenance: 'observed',
      firstSeenAt: '2026-07-28T09:00:00.000Z',
      lastSeenAt: '2026-07-28T09:00:00.000Z',
    },
  ];
  const out = foldWorkGraph(input({ world: world({ issues: [issue()] }), existing }));
  assert.equal(
    out.find((n) => n.ref === 'pr:40'),
    undefined,
    'nothing to say, so nothing is emitted',
  );
});

test('a PR observed open again clears a stale terminal', () => {
  const existing: WorkNode[] = [
    {
      ref: 'pr:40',
      kind: 'pr',
      parentRef: 'issue:12',
      baseRef: null,
      title: 'PR #40',
      status: 'merged',
      terminal: true,
      provenance: 'inferred',
      firstSeenAt: '2026-07-28T09:00:00.000Z',
      lastSeenAt: '2026-07-28T09:00:00.000Z',
    },
  ];
  const out = foldWorkGraph(input({ world: world({ issues: [issue()], pullRequests: [pr()] }), existing }));
  assert.equal(node(out, 'pr:40').status, 'open');
  assert.equal(node(out, 'pr:40').terminal, false);
  assert.equal(node(out, 'pr:40').provenance, null);
});

test('a stacked PR records its base as a cross-link, not as its parent', () => {
  const out = foldWorkGraph(
    input({
      world: world({
        issues: [issue()],
        pullRequests: [
          pr({ number: 41, branch: 'issue/12/schema' }),
          pr({ number: 42, branch: 'issue/12/api', baseBranch: 'issue/12/schema' }),
        ],
      }),
      plans: [plan()],
      parts: [
        part({ prNumber: 41, branch: 'issue/12/schema', status: 'in_review' }),
        part({
          id: 'pl1:api',
          slug: 'api',
          seq: 2,
          title: 'API',
          prNumber: 42,
          branch: 'issue/12/api',
          status: 'in_review',
        }),
      ],
    }),
  );
  assert.equal(node(out, 'pr:42').baseRef, 'pr:41', 'stacking is its own relation');
  assert.equal(node(out, 'pr:42').parentRef, 'issue:12:part:api', 'and does not become the parent');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: FAIL — "expected a node pr:40, got: issue:12".

- [ ] **Step 3: Extend the fold**

In `src/graph/workGraph.ts`, add to the imports:

```ts
import { basePrOf, prState } from '../prHealth.js';
import { issueBranch } from '../dispatcher/issuePickup.js';
```

Inside `foldWorkGraph`, replace the `for (const part of input.parts)` loop's body ending with a version that also records the part→PR parent, and add the PR block. The complete replacement for everything between the part loop and `return out;`:

```ts
// Which node owns each PR. Filled part-first because work lineage is what the
// parent means: a part's PR belongs to the part, not to the issue two levels up.
const prParent = new Map<number, string>();
for (const part of input.parts) {
  const n = issueOfPlan.get(part.planId);
  if (n === undefined) continue;
  if (part.prNumber !== null) prParent.set(part.prNumber, partOrigin(n, part.slug));
}
for (const issue of input.world.issues) {
  const branch = issueBranch(issue.number);
  for (const pr of input.world.pullRequests) {
    const mine = pr.branch === branch || issue.linkedPrNumber === pr.number;
    if (mine && !prParent.has(pr.number)) prParent.set(pr.number, issueOrigin(issue.number));
  }
}

const priorPr = new Map(input.existing.filter((n) => n.kind === 'pr').map((n) => [n.ref, n]));
const seen = new Set<string>();

for (const pr of input.world.pullRequests) {
  const ref = `pr:${pr.number}`;
  seen.add(ref);
  const base = basePrOf(pr, input.world.pullRequests);
  const merged = pr.merged === true;
  out.push({
    ref,
    kind: 'pr',
    parentRef: prParent.get(pr.number) ?? null,
    baseRef: base ? `pr:${base.number}` : null,
    title: pr.title,
    // An observation of it being open clears a stale terminal — a reopened PR
    // corrects itself rather than being stuck on a guess.
    status: merged ? 'merged' : 'open',
    terminal: merged,
    provenance: merged ? 'observed' : null,
  });
}

for (const pr of input.world.closedPullRequests) {
  const ref = `pr:${pr.number}`;
  if (seen.has(ref)) continue; // in both lists: the open reading wins, it is fresher
  seen.add(ref);
  out.push({
    ref,
    kind: 'pr',
    parentRef: prParent.get(pr.number) ?? null,
    title: pr.title,
    status: prState(pr),
    terminal: true,
    provenance: 'observed',
  });
}

// A PR the graph knew as open and the world no longer mentions. Absence-means-
// merged stays the deliberate fallback it is everywhere else here — but it is
// recorded as an inference, and never overwrites something actually observed.
for (const [ref, prior] of priorPr) {
  if (seen.has(ref) || prior.terminal) continue;
  out.push({
    ref,
    kind: 'pr',
    parentRef: prior.parentRef,
    baseRef: prior.baseRef,
    title: prior.title,
    status: 'merged',
    terminal: true,
    provenance: 'inferred',
  });
}

return out;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/graph/workGraph.ts test/workGraph.test.ts
git commit -m "Work graph: PR nodes, terminal provenance and the base cross-link

A PR's parent is the part that produced it, in preference to the issue —
work lineage, not the nearest ancestor. Stacking rides on base_ref so the
graph stays a tree and does not claim PR #41 caused PR #42.

Terminal state records how it was learned. Absence-means-merged remains the
fallback it is everywhere else, but a durable record has no reason to forget
that it was one, and an observed terminal is never downgraded to a guess."
```

---

### Task 4: The pure fold — concern and job nodes

**Files:**

- Modify: `src/graph/workGraph.ts`
- Test: `test/workGraph.test.ts`

**Interfaces:**

- Consumes: `foldWorkGraph` (tasks 2–3).
- Produces: no new exports — extends the output with `pr:<n>:<concern>` and `job:<id>` nodes.

- [ ] **Step 1: Write the failing test**

Append to `test/workGraph.test.ts` (add `Job`, `Task` to the existing `types.js` type import):

```ts
function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    kind: 'code',
    title: 'Fix CI on PR #40',
    prompt: 'fix it',
    branch: 'issue/12',
    originRef: 'pr:40:ci',
    originTitle: null,
    originSummary: null,
    dispatchReason: null,
    status: 'running',
    agentId: 'a1',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'j7',
    title: 'Bump the linter',
    prompt: 'bump it',
    kind: 'code',
    branch: 'chore/lint',
    status: 'queued',
    taskId: null,
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:00:00.000Z',
    ...over,
  };
}

test('a concern hangs off its PR and is live while a task is active', () => {
  const out = foldWorkGraph(input({ world: world({ issues: [issue()], pullRequests: [pr()] }), tasks: [task()] }));
  assert.equal(node(out, 'pr:40:ci').parentRef, 'pr:40');
  assert.equal(node(out, 'pr:40:ci').kind, 'concern');
  assert.equal(node(out, 'pr:40:ci').status, 'live');
  assert.equal(node(out, 'pr:40:ci').terminal, false, 'a concern is never terminal — the PR is');
});

test('a concern whose attempts have all ended is done but stays in the graph', () => {
  const out = foldWorkGraph(
    input({ world: world({ issues: [issue()], pullRequests: [pr()] }), tasks: [task({ status: 'done' })] }),
  );
  assert.equal(node(out, 'pr:40:ci').status, 'done');
  assert.equal(node(out, 'pr:40:ci').terminal, false);
});

test('two attempts on one concern are one node', () => {
  const out = foldWorkGraph(
    input({
      world: world({ issues: [issue()], pullRequests: [pr()] }),
      tasks: [task({ id: 't1', status: 'done' }), task({ id: 't2', status: 'running' })],
    }),
  );
  assert.equal(out.filter((n) => n.ref === 'pr:40:ci').length, 1, 'keyed on the origin, not the task');
  assert.equal(node(out, 'pr:40:ci').status, 'live', 'one live attempt makes the node live');
});

test('a task on an origin with no PR in the graph produces no orphan concern', () => {
  const out = foldWorkGraph(input({ world: world({ issues: [issue()] }), tasks: [task()] }));
  assert.equal(
    out.find((n) => n.ref === 'pr:40:ci'),
    undefined,
  );
});

test('a job is its own root, and a cancelled one is terminal', () => {
  const queued = foldWorkGraph(input({ jobs: [job()] }));
  assert.equal(node(queued, 'job:j7').parentRef, null);
  assert.equal(node(queued, 'job:j7').kind, 'job');
  assert.equal(node(queued, 'job:j7').terminal, false);

  const cancelled = foldWorkGraph(input({ jobs: [job({ status: 'cancelled' })] }));
  assert.equal(node(cancelled, 'job:j7').terminal, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: FAIL — "expected a node pr:40:ci".

- [ ] **Step 3: Extend the fold**

In `src/graph/workGraph.ts`, insert immediately before the final `return out;`:

```ts
for (const job of input.jobs) {
  out.push({
    ref: `job:${job.id}`,
    kind: 'job',
    parentRef: null,
    title: job.title,
    status: job.status,
    terminal: job.status === 'cancelled',
  });
}

// Concerns, keyed on the **origin** rather than the task: two CI attempts on one
// PR are two `tasks` rows but one node, so the graph does not grow a node every
// time an agent restarts. The attempts stay reachable by `origin_ref`.
//
// A concern is never terminal. It is a step on the way to a merge, not a leaf —
// while one is live its PR simply is not terminal yet, and a PR that sits red
// forever correctly keeps its issue unfinished.
const concernTasks = new Map<string, Task[]>();
for (const task of input.tasks) {
  if (task.originRef === null) continue;
  if (!/^pr:\d+:.+$/.test(task.originRef)) continue;
  const bucket = concernTasks.get(task.originRef);
  if (bucket) bucket.push(task);
  else concernTasks.set(task.originRef, [task]);
}
for (const [ref, attempts] of concernTasks) {
  const prRef = ref.slice(0, ref.indexOf(':', 3));
  if (!seen.has(prRef)) continue; // its PR is not in the graph, so neither is it
  const live = attempts.some((t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting');
  out.push({
    ref,
    kind: 'concern',
    parentRef: prRef,
    title: attempts[0]?.title ?? ref,
    status: live ? 'live' : 'done',
    terminal: false,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/graph/workGraph.ts test/workGraph.test.ts
git commit -m "Work graph: concern and job nodes

A concern is keyed on its origin, so two CI attempts are two tasks rows and
one node, and is never terminal — it is a step on the way to a merge, not a
leaf. While one is live its PR is simply not terminal yet, which is what
makes a PR that sits red forever keep its issue unfinished."
```

---

### Task 5: The recorder, wired into the pulse

**Files:**

- Create: `src/graph/workGraphRecorder.ts`
- Modify: `src/harness.ts`
- Modify: `src/system.ts`
- Test: `test/workGraph.test.ts`

**Interfaces:**

- Consumes: `foldWorkGraph` (tasks 2–4); `Store` methods (task 1); `ErrorRecorder` from `src/errorLog.js`.
- Produces: `class WorkGraphRecorder { constructor(deps: { store: Store; errors?: ErrorRecorder }); record(world: WorldSnapshot): void }` from `src/graph/workGraphRecorder.js`; `HarnessDeps.graph?: WorkGraphRecorder`; `System.graph` on the object `buildSystem` returns.

- [ ] **Step 1: Write the failing test**

Append to `test/workGraph.test.ts` (add these imports at the top):

```ts
import { buildSystem } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

test('a merged PR stays merged in the graph long after the world forgets it', async () => {
  // The headline property. `closedPrWindowMs: 0` disables the closed list entirely,
  // which is the same thing the 6h window does to a merge that is a day old — the
  // PR is simply not in the snapshot any more.
  const config = loadConfig({
    dbPath: ':memory:',
    connectors: { sourceControl: 'fake', issues: 'fake', backlog: 'fake' },
    labelPrefix: '',
    startPaused: true,
  } as never);
  const system = buildSystem(config, { backend: new FakePtyBackend(), errorMirror: () => {} });

  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Widget' });
  system.connector.inject({ kind: 'new_pr', number: 40, title: 'Add the widget', branch: 'issue/12' });
  await system.harness.runCycle('manual');

  const open = system.store.listWorkSubtree('issue:12');
  assert.equal(open.find((n) => n.ref === 'pr:40')?.status, 'open');

  system.connector.inject({ kind: 'pr_merged', prNumber: 40 });
  await system.harness.runCycle('manual');
  const merged = system.store.listWorkSubtree('issue:12').find((n) => n.ref === 'pr:40');
  assert.equal(merged?.status, 'merged', 'the merge is observed while it is still in the world');
  assert.equal(merged?.terminal, true);

  // The PR now leaves the world entirely — no open row, no closed row.
  system.connector.inject({ kind: 'pr_closed', prNumber: 40 });
  await system.harness.runCycle('manual');
  await system.harness.runCycle('manual');

  const after = system.store.listWorkSubtree('issue:12').find((n) => n.ref === 'pr:40');
  assert.equal(after?.status, 'merged', 'the graph still knows PR #40 merged');
  assert.equal(after?.parentRef, 'issue:12', 'and still knows which issue it delivered');
  await system.shutdown();
});
```

**Note for the implementer:** the `pr_merged` / `pr_closed` / `new_issue` / `new_pr` injectable event names are the fake connector's. Confirm them against `src/integrations/fake/fakeWorld.ts` before running; if `pr_closed` moves the row into `closedPullRequests` rather than removing it, add a further cycle after raising `closedPrWindowMs`'s effect by injecting nothing — the assertion that matters is that `pr:40` survives its disappearance from both lists.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: FAIL — `listWorkSubtree('issue:12')` returns `[]`, because nothing writes the graph yet.

- [ ] **Step 3: Write the recorder**

Create `src/graph/workGraphRecorder.ts`:

```ts
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { WorldSnapshot } from '../types.js';
import { foldWorkGraph } from './workGraph.js';

interface WorkGraphRecorderDeps {
  store: Store;
  errors?: ErrorRecorder;
}

/**
 * Writes the durable work graph once per pulse.
 *
 * Thin on purpose: it gathers the store rows the fold needs, runs the pure fold and
 * hands the result to the store. All the reasoning is in {@link foldWorkGraph}, so
 * it is testable with no database and no world.
 *
 * **A failure here never fails the cycle.** Nothing in stage 1 reads the graph for a
 * decision, so a recorder that throws must cost an error-log entry and nothing else.
 */
export class WorkGraphRecorder {
  constructor(private readonly deps: WorkGraphRecorderDeps) {}

  record(world: WorldSnapshot): void {
    const { store, errors } = this.deps;
    try {
      store.recordWorkGraph(
        foldWorkGraph({
          world,
          tasks: store.listTasks(),
          plans: store.listPlans(),
          parts: store.listAllPlanParts(),
          jobs: store.listJobs(),
          existing: store.listWorkRoots().flatMap((root) => store.listWorkSubtree(root.ref)),
        }),
      );
    } catch (err) {
      errors?.record({
        source: 'work-graph',
        message: 'failed to record the work graph',
        detail: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
  }
}
```

**Note for the implementer:** check `Store` for an existing "every job" reader; the harness uses `listQueuedJobs()`. If no `listJobs()` exists, add one in the same style as `listWorkRoots` (`SELECT * FROM jobs ORDER BY created_at DESC`) and export it. Likewise check `ErrorRecorder.record`'s exact field names in `src/errorLog.ts` and match them.

- [ ] **Step 4: Wire it into the pulse**

In `src/harness.ts`, add to `HarnessDeps` after `plans?: PlanReconciler;`:

```ts
  /**
   * Writes the durable work graph each pulse. Absent = no graph (tests that do not
   * care). Stage 1 is a lens: nothing reads what it writes.
   */
  graph?: WorkGraphRecorder;
```

Add the import at the top of the file:

```ts
import type { WorkGraphRecorder } from './graph/workGraphRecorder.js';
```

In `runCycle`, immediately after the `await this.deps.plans?.reconcile(world);` line:

```ts
// Record what the world and the store now say happened, after the reconciler
// so part→PR observations are fresh, and before `decide` so stage 2 can read
// it. Never deleting is the point: `closedPullRequests` forgets a merge after
// `closedPrWindowMs` and the graph must not.
this.deps.graph?.record(world);
```

In `src/system.ts`, after the `const plans = new PlanReconciler({…});` block:

```ts
const graph = new WorkGraphRecorder({ store, errors });
```

Add `graph,` to the `new Harness({…})` argument object, add the import
`import { WorkGraphRecorder } from './graph/workGraphRecorder.js';`, and add `graph`
to the object `buildSystem` returns so the cockpit routes and tests can reach it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: PASS, 21 tests.

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: PASS. If knip reports `System.graph` as an unused member, it means nothing reads it yet — leave it and confirm it goes green after task 6, which does.

- [ ] **Step 7: Commit**

```bash
git add src/graph/workGraphRecorder.ts src/harness.ts src/system.ts test/workGraph.test.ts
git commit -m "Work graph: record it once per pulse

After the plan reconciler so part->PR observations are fresh, before decide
so stage 2 can read it. A failure records an error and never fails the
cycle: nothing reads the graph for a decision yet, so it must not be able
to break the pulse.

The headline test drives a PR through merge and then out of the world
entirely, and asserts the graph still knows it merged and which issue it
delivered — which is unrecoverable today."
```

---

### Task 6: The `/api/work` routes

**Files:**

- Modify: `src/server/app.ts`
- Test: `test/workGraph.test.ts`

**Interfaces:**

- Consumes: `Store.listWorkRoots`, `Store.listWorkSubtree` (task 1); `system.connector.resolveRefUrl` for link resolution.
- Produces: `GET /api/work` → `{ roots: WorkNode[] }`; `GET /api/work/:ref` → `{ nodes: WorkNode[]; refUrls: Record<string, string> }`.

- [ ] **Step 1: Write the failing test**

Append to `test/workGraph.test.ts`:

```ts
test('the routes serve roots and one subtree, and refuse an unknown root', async () => {
  const config = loadConfig({
    dbPath: ':memory:',
    connectors: { sourceControl: 'fake', issues: 'fake', backlog: 'fake' },
    labelPrefix: '',
    startPaused: true,
    auth: { enabled: false },
  } as never);
  const system = buildSystem(config, { backend: new FakePtyBackend(), errorMirror: () => {} });
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Widget' });
  system.connector.inject({ kind: 'new_pr', number: 40, title: 'Add the widget', branch: 'issue/12' });
  await system.harness.runCycle('manual');

  const app = await buildServer(system, config);
  const roots = await app.inject({ method: 'GET', url: '/api/work' });
  assert.equal(roots.statusCode, 200);
  assert.deepEqual(
    (roots.json() as { roots: { ref: string }[] }).roots.map((r) => r.ref),
    ['issue:12'],
  );

  const sub = await app.inject({ method: 'GET', url: '/api/work/issue:12' });
  assert.equal(sub.statusCode, 200);
  assert.deepEqual((sub.json() as { nodes: { ref: string }[] }).nodes.map((n) => n.ref).sort(), ['issue:12', 'pr:40']);

  const missing = await app.inject({ method: 'GET', url: '/api/work/issue:999' });
  assert.equal(missing.statusCode, 404);

  await app.close();
  await system.shutdown();
});
```

**Note for the implementer:** import the server builder the way the other route tests do — check `test/cockpitAuth.test.ts` for its exact name and signature (`buildServer` / `createApp`) and match it. Add the import to the top of `test/workGraph.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: FAIL — the first request returns 404, since the route does not exist.

- [ ] **Step 3: Add the routes**

In `src/server/app.ts`, beside the other `app.get('/api/…')` routes:

```ts
// The graph is deliberately *not* in `/api/state`: that endpoint is polled
// continuously, so shipping every node on every poll is the wrong shape. Roots
// are cheap; a subtree is fetched when a panel is opened.
app.get('/api/work', async () => ({ roots: store.listWorkRoots() }));

app.get('/api/work/:ref', async (req, reply) => {
  const { ref } = req.params as { ref: string };
  const nodes = store.listWorkSubtree(ref);
  if (nodes.length === 0) return reply.code(404).send({ error: 'no such work item' });
  // Resolved here rather than looked up in the snapshot's `refUrls`: a historical
  // PR is long gone from the world, and the connector can still name its URL.
  const refUrls: Record<string, string> = {};
  for (const node of nodes) {
    const url = await system.connector.resolveRefUrl(node.ref);
    if (url) refUrls[node.ref] = url;
  }
  return { nodes, refUrls };
});
```

**Note for the implementer:** confirm `resolveRefUrl`'s exact signature on `CompositeConnector` (sync or async, and whether it is optional) and adjust the `await` accordingly. If it is optional on the `Connector` type, guard with `system.connector.resolveRefUrl?.(node.ref)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Run the auth suite — the routes are new surface**

Run: `npx tsx --test test/cockpitAuth.test.ts`
Expected: PASS. That suite walks `app.ts`'s route table and requires a refusal from each route, so it covers the two new ones automatically. If it fails, the routes were registered before the `onRequest` auth hook — move them.

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/app.ts test/workGraph.test.ts
git commit -m "Work graph: GET /api/work and /api/work/:ref

Kept out of /api/state because that is polled continuously and the forest
has no business riding every poll. The subtree route resolves its own ref
URLs through the connector rather than the snapshot's refUrls map, because
a historical PR is long gone from the world and still deserves a link."
```

---

### Task 7: The cockpit panel, the lens assertion and the docs

**Files:**

- Create: `web/src/components/WorkTreePanel.tsx`
- Modify: `web/src/api.ts`, `web/src/types.ts`, `web/src/App.tsx`
- Modify: `docs/spec/14-persistence.md`, `docs/spec/04-harness-cycle.md`, `CLAUDE.md`
- Test: `test/workGraph.test.ts`

**Interfaces:**

- Consumes: the routes from task 6.
- Produces: `api.getWorkRoots()`, `api.getWorkSubtree(ref)`; `WorkTreePanel`.

- [ ] **Step 1: Write the failing structural test**

Append to `test/workGraph.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

test('stage 1 is a lens: nothing in the dispatcher reads the graph', () => {
  // Structural, the way prAttention's single-importer property is kept. The moment
  // a rule consults the graph, an agent can suppress another's dispatch and a
  // second opinion about a gate starts living nowhere near the gate it duplicates.
  const readers = srcFiles('src')
    .filter((f) => !f.startsWith('src/graph/'))
    .filter((f) => readFileSync(f, 'utf8').includes('graph/workGraph'));
  assert.deepEqual(
    readers,
    ['src/harness.ts', 'src/system.ts'],
    'only the pulse and the composition root may reach the graph in stage 1',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails or passes**

Run: `npx tsx --test test/workGraph.test.ts`
Expected: PASS immediately if tasks 1–6 were followed exactly. If it fails, the assertion names the file that reached into `src/graph/` and must not — fix that file, do not relax the assertion.

- [ ] **Step 3: Add the cockpit client methods**

In `web/src/types.ts`:

```ts
/** One node of the work graph, as the cockpit reads it. Mirrors the server's WorkNode. */
export interface WorkNodeView {
  ref: string;
  kind: 'issue' | 'plan' | 'part' | 'pr' | 'concern' | 'job' | 'assess';
  parentRef: string | null;
  baseRef: string | null;
  title: string;
  status: string;
  terminal: boolean;
  provenance: 'observed' | 'inferred' | null;
  firstSeenAt: string;
  lastSeenAt: string;
}
```

In `web/src/api.ts`, add to `realApi`:

```ts
  getWorkRoots: () => authFetch('/api/work').then((r) => json<{ roots: WorkNodeView[] }>(r)),
  getWorkSubtree: (ref: string) =>
    authFetch(`/api/work/${encodeURIComponent(ref)}`).then((r) =>
      json<{ nodes: WorkNodeView[]; refUrls: Record<string, string> }>(r),
    ),
```

Import `WorkNodeView` from `./types.js`. Add matching stubs to `demoApi` in
`web/src/demo/demoBackend.ts` returning `{ roots: [] }` and `{ nodes: [], refUrls: {} }`,
or the demo build breaks.

- [ ] **Step 4: Write the panel**

Create `web/src/components/WorkTreePanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { WorkNodeView } from '../types.js';

/**
 * The durable record of what was done for a work item. Fetched on open rather than
 * carried in `/api/state`, which is polled continuously.
 */
export function WorkTreePanel(): JSX.Element {
  const [roots, setRoots] = useState<WorkNodeView[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [nodes, setNodes] = useState<WorkNodeView[]>([]);
  const [refUrls, setRefUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.getWorkRoots().then((r) => setRoots(r.roots));
  }, []);

  useEffect(() => {
    if (open === null) return;
    void api.getWorkSubtree(open).then((r) => {
      setNodes(r.nodes);
      setRefUrls(r.refUrls);
    });
  }, [open]);

  // Depth by walking parents, so the indent needs no server-side ordering contract.
  const depth = (node: WorkNodeView): number => {
    let d = 0;
    let cur = node.parentRef;
    while (cur !== null) {
      const parent = nodes.find((n) => n.ref === cur);
      if (!parent) break;
      d += 1;
      cur = parent.parentRef;
    }
    return d;
  };

  return (
    <section className="panel">
      <h2>Work</h2>
      {roots.length === 0 && <p className="muted">Nothing recorded yet.</p>}
      <ul className="work-roots">
        {roots.map((root) => (
          <li key={root.ref}>
            <button type="button" onClick={() => setOpen(open === root.ref ? null : root.ref)}>
              {root.title} <span className="muted">{root.ref}</span> <span className="chip">{root.status}</span>
            </button>
            {open === root.ref && (
              <ul className="work-tree">
                {nodes.map((node) => (
                  <li key={node.ref} style={{ marginLeft: `${depth(node) * 16}px` }}>
                    {refUrls[node.ref] ? (
                      <a href={refUrls[node.ref]} target="_blank" rel="noreferrer">
                        {node.title}
                      </a>
                    ) : (
                      node.title
                    )}{' '}
                    <span className="muted">{node.ref}</span> <span className="chip">{node.status}</span>
                    {node.provenance === 'inferred' && <span className="chip muted">inferred</span>}
                    {node.baseRef && <span className="muted">on {node.baseRef}</span>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

**Note for the implementer:** match the surrounding components' conventions — check
`web/src/components/PlanPanel.tsx` for whether panels take props, how `className`s are
named in this codebase, and whether `JSX.Element` or `ReactElement` is the house return
type. Follow what is already there rather than the sketch above.

- [ ] **Step 5: Mount the panel**

In `web/src/App.tsx`, import `WorkTreePanel` and render it beside `PlanPanel`.

- [ ] **Step 6: Run both typecheckers and the suite**

Run: `npm run typecheck && npm run typecheck:web && npm test`
Expected: PASS.

- [ ] **Step 7: Update the documentation**

- `docs/spec/14-persistence.md` — add a `work_nodes` section: the table, upsert-only semantics, the write-once parent, why there is no TTL.
- `docs/spec/04-harness-cycle.md` — add the recorder to the pulse's step list, between plan reconciliation and `Dispatcher.decide`.
- `CLAUDE.md` — add a "Where things live" bullet: `src/graph/` is the durable work graph; the fold is pure and the recorder is its only writer; **nothing in the dispatcher reads it** and `test/workGraph.test.ts` asserts that structurally; `closedPrWindowMs` bounds the _world's_ memory, not the graph's.

- [ ] **Step 8: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src src/../docs/spec CLAUDE.md test/workGraph.test.ts
git commit -m "Work graph: the cockpit panel, the lens assertion and the docs

The structural test is the one that has to survive: the moment a rule reads
the graph, an agent can suppress another's dispatch and a second opinion
about a gate starts living nowhere near the gate it duplicates."
```

---

## Self-review

**Spec coverage.** Node model → tasks 1–4. Edge table (all six rows) → tasks 2–4. Recorder position in the pulse → task 5. Never-delete / observed-beats-inferred / derive-never-toggle → tasks 1, 3, 5. Backfill on first run → **covered implicitly**: `WorkGraphRecorder.record` reads `listTasks`/`listPlans`/`listAllPlanParts` unconditionally, so the first pulse against an existing database seeds from them with no special case, exactly as the spec says. Storage DDL → task 1. `/api/work` routes → task 6. Panel → task 7. All six listed tests → tasks 1–7, with the durability headline in task 5 and the structural lens assertion in task 7.

**Known gaps, stated rather than hidden.** Three steps carry a "note for the implementer" where a signature could not be confirmed without running the code: the fake connector's `pr_closed` semantics (task 5), the server-builder export name (task 6), and `resolveRefUrl`'s exact shape (task 6). Each names the file to check and what to do with either answer, so none is a decision deferred — but they are the three places this plan asks the implementer to look before typing.

**Type consistency.** `WorkNodeObservation` is the fold's output and the store's input throughout; `WorkNode` is the store's output and the routes' payload throughout. `foldWorkGraph`/`WorkGraphInput` keep one name across tasks 2–5. `recordWorkGraph`/`listWorkRoots`/`listWorkSubtree` keep one name across tasks 1, 5, 6.
