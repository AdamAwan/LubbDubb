# Cockpit Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Factory Floor presentation layer with a console whose left rail is one merged "Needs you" queue and whose main pane is a goal page, so an ask is always shown with the goal it is about.

**Architecture:** The cockpit's three layers are unchanged — wiring (`web/src/cockpit/`), derivation (`web/src/view/`), presentation (`web/src/factory/` → `web/src/console/`). This plan adds three pure derivations to the view layer, builds `console/` beside the floor while both stay green, switches `App.tsx` in one commit, then deletes the floor. Presentation never imports `api.js`; every mutation stays on the pre-bound `CockpitActions`.

**Tech Stack:** React 18 + Vite (no router, no state library), TypeScript with `nodenext` module resolution, `node:test` + `renderToStaticMarkup` for component tests, plain CSS with `:root` tokens.

**Design spec:** [`docs/superpowers/specs/2026-08-12-cockpit-redesign-design.md`](../specs/2026-08-12-cockpit-redesign-design.md)

## Global Constraints

Every task's requirements implicitly include all of these.

- **ESM with explicit `.js` import extensions**, even from `.ts`/`.tsx` sources: `import { buildNeedsYou } from './needsYou.js';`. A missing extension breaks module resolution.
- **Two typecheckers.** `npm run typecheck` (server) and `npm run typecheck:web` (cockpit) are separate passes. Any change spanning `src/` and `web/` must satisfy both.
- **knip runs with every rule at `error`.** `knip.json` lists `test/**/*.test.ts` as an entry point, so a module imported by its test counts as used — this is what lets `console/` exist before `App.tsx` renders it. The fix for an unused type or helper is to **drop the `export` keyword**, never an ignore list.
- **Never cast through `unknown`.** If a type does not line up, fix the type.
- **Nothing under `web/src/console/` may import `web/src/api.js`.** Every mutation is a method on `CockpitActions`. Task 10 adds the structural assertion; do not wait for it.
- **Nothing is derived in the browser that the server already decided.** `attention.status`, `ciVerdict`, `health.reasons`, `QueueItem.reason`, assay summaries and planner reasons are quoted, never parsed.
- **Shared components in `web/src/components/` are embedded, never redrawn.** `EscalationCard`, `RecoveryPanel`, `HumanTaskActions`, `FindingsPanel`, `LaunchPanel`, `SchedulePanel`, `WorldSummary`, `FleetControl`, `ConfirmButton`, `AsyncButton` own their refusal rules and keep one implementation each.
- **`console.css` must not target a shared component's class** (`.escalation-card`, `.recovery-panel`, …). Shared components style themselves through `:root` tokens in `styles.css`; reaching into their classes makes the two inseparable.
- **Comments explain _why_, not _what_.** Match the existing terse, high-signal style.
- **`npm run check`** (format:check, lint, typecheck, typecheck:web, knip, test) must pass before every commit. Run it, read it, and do not commit red.
- **Commit after every task**, with the message body explaining why, not what.

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `web/src/view/needsYou.ts` | Pure: the merged blocking queue, its ordering, and the holding count |
| `web/src/view/goalPage.ts` | Pure: everything one goal's page draws, and the overview's segment track |
| `web/src/console/ConsoleRoot.tsx` | Placement only — shell, rail, situation area, recovery banner |
| `web/src/console/TopBar.tsx` | Ident, Scan, fleet cap, the Tier-3 readings |
| `web/src/console/QueueRail.tsx` | The "Needs you" list |
| `web/src/console/GoalPage.tsx` | A goal's page, asks pinned above the plan |
| `web/src/console/Overview.tsx` | Fleet, goals, PRs, up-next, signals |
| `web/src/console/Backlog.tsx` | Watched / blocked at intake / unwatched / ignored |
| `web/src/console/Panel.tsx` | Modal wrapper: backdrop, button and Escape all close |
| `web/src/console/console.css` | The console's own stylesheet |
| `test/needsYou.test.ts` | Unit tests for the queue derivation |
| `test/goalPage.test.ts` | Unit tests for the goal-page derivation |
| `test/console.test.ts` | Component and structural tests, replacing `test/factoryFloor.test.ts` |

**Modified:** `web/src/view/viewModel.ts`, `web/src/cockpit/useCockpit.ts`, `web/src/cockpit/actions.ts`, `web/src/App.tsx`, `web/src/main.tsx`, `docs/spec/17-cockpit.md`.

**Deleted (Task 10):** all of `web/src/factory/`, `test/factoryFloor.test.ts`.

---

### Task 1: The merged queue derivation

**Files:**
- Create: `web/src/view/needsYou.ts`
- Test: `test/needsYou.test.ts`

**Interfaces:**
- Consumes: `AppState`, `PlanPart`, `Escalation`, `Proposal`, `HumanTask`, `OrphanedWork` from `web/src/types.js`.
- Produces: `NeedKind`, `NeedGroup`, `NeedRow`, `buildNeedsYou(state: AppState): NeedRow[]`, `partHolding(planId: string, slug: string, parts: readonly PlanPart[]): number`. Tasks 2, 3, 5 and 6 all consume these exact names.

- [ ] **Step 1: Write the failing test**

Create `test/needsYou.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, Escalation, HumanTask, OrphanedWork, PlanPart } from '../web/src/types.js';
import { buildNeedsYou, partHolding } from '../web/src/view/needsYou.js';

const { buildDemoState } = await import('../web/src/demo/fixtures.js');

function part(over: Partial<PlanPart>): PlanPart {
  return {
    id: 'p:a', planId: 'p', slug: 'a', seq: 1, title: 'A', scope: 'src/a.ts',
    rationale: null, acceptance: null, expectedKind: null, outcomeKind: null,
    outcomeRef: null, outcomeSummary: null, dependsOn: [], branch: null,
    prNumber: null, status: 'ready', blockedReason: null, taskId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function escalation(over: Partial<Escalation>): Escalation {
  return {
    id: 'e1', type: 'answer_question', status: 'open', prompt: 'Which store?',
    context: {}, agentId: null, taskId: null, response: null,
    createdAt: '2026-01-01T00:00:00.000Z', answeredAt: null,
    ...over,
  };
}

function task(over: Partial<HumanTask>): HumanTask {
  return {
    id: 't1', title: 'Provision creds', detail: null, originRef: 'issue:142',
    partId: null, kind: 'ask', agentId: null, taskId: null, status: 'open',
    resolution: null, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', resolvedAt: null, dismissedAt: null,
    ...over,
  };
}

function orphan(over: Partial<OrphanedWork> = {}): OrphanedWork {
  return {
    taskId: 't9', agentId: null, title: 'Orphaned run', kind: 'code',
    originRef: null, branch: null, cwd: null, died: 'crashed',
    waitingReason: null, note: null, startedAt: '2026-01-01T00:00:00.000Z',
    detectedAt: null, restorable: false, restoreBlocked: null,
    ...over,
  };
}

/** A snapshot with the four lists this suite varies replaced, and nothing cast. */
function stateWith(over: Partial<AppState>): AppState {
  return { ...buildDemoState().state, ...over };
}

test('partHolding counts live direct dependents and ignores retired ones', () => {
  const parts = [
    part({ id: 'p:a', slug: 'a' }),
    part({ id: 'p:b', slug: 'b', dependsOn: ['a'] }),
    part({ id: 'p:c', slug: 'c', dependsOn: ['a'], status: 'retired' }),
    part({ id: 'q:d', planId: 'q', slug: 'd', dependsOn: ['a'] }),
  ];
  assert.equal(partHolding('p', 'a', parts), 1);
});

test('a parked agent and a bench task land in different groups', () => {
  const rows = buildNeedsYou(stateWith({
    escalations: [escalation({ id: 'e1', agentId: 'a1' })],
    humanTasks: [task({ id: 't1' })],
    proposals: [],
    recovery: [],
  }));

  assert.deepEqual(
    rows.map((r) => [r.kind, r.group]),
    [['escalation', 'blocking'], ['bench', 'yours']],
  );
});

test('recovery sorts above everything, because no pulse runs while it is up', () => {
  const rows = buildNeedsYou(stateWith({
    escalations: [escalation({ id: 'e1', agentId: 'a1' })],
    humanTasks: [],
    proposals: [],
    recovery: [orphan()],
  }));

  assert.equal(rows[0]?.kind, 'recovery');
  assert.equal(rows[0]?.goalRef, null);
});

test('a permission request is its own kind, not a plain escalation', () => {
  const rows = buildNeedsYou(stateWith({
    escalations: [
      escalation({
        id: 'e1',
        agentId: 'a1',
        context: { permission: { toolName: 'Bash', summary: 'rm -rf build' } },
      }),
    ],
    humanTasks: [], proposals: [], recovery: [],
  }));

  assert.equal(rows[0]?.kind, 'permission');
});

test('within a group the row holding more work sorts first', () => {
  const state = buildDemoState().state;
  const parts = [
    part({ id: 'p:a', slug: 'a' }),
    part({ id: 'p:b', slug: 'b', dependsOn: ['a'] }),
    part({ id: 'p:c', slug: 'c', dependsOn: ['a'] }),
    part({ id: 'p:z', slug: 'z' }),
  ];
  const rows = buildNeedsYou(stateWith({
    planParts: parts,
    escalations: [],
    proposals: [],
    recovery: [],
    humanTasks: [
      task({ id: 'holds-none', partId: 'p:z', title: 'Holds nothing' }),
      task({ id: 'holds-two', partId: 'p:a', title: 'Holds two' }),
    ],
  }));

  assert.deepEqual(rows.map((r) => r.id), ['holds-two', 'holds-none']);
  assert.equal(rows[0]?.holding, 2);
  assert.equal(rows[1]?.holding, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx --test test/needsYou.test.ts
```

Expected: FAIL — `Cannot find module '../web/src/view/needsYou.js'`.

- [ ] **Step 3: Write the implementation**

Create `web/src/view/needsYou.ts`:

```ts
import type { AppState, Escalation, HumanTask, PlanPart, Proposal } from '../types.js';

/**
 * What kind of answer a row wants. `permission` and `proposal` are escalations
 * underneath, split out because the verdict differs: a permission goes to
 * `/permission`, a proposal carries accept/reject, and a plain question takes
 * free text. Drawing them as one kind is how a surface ends up offering the
 * wrong control.
 */
export type NeedKind = 'recovery' | 'escalation' | 'permission' | 'proposal' | 'bench' | 'close_out';

/**
 * Who is stopped. `blocking` means an agent is parked and cannot proceed;
 * `yours` means the obligation is the operator's and nothing is waiting inside
 * the fleet. This is the floor's red/amber rule carried over intact — red means
 * an agent is parked on a question only you can answer, and nothing else.
 */
export type NeedGroup = 'blocking' | 'yours';

/** One row of the merged queue. */
export interface NeedRow {
  /** The source row's own id, so answering it settles exactly this row. */
  id: string;
  kind: NeedKind;
  group: NeedGroup;
  /** The ask on one line. */
  title: string;
  /** `issue:<n>` when the ask belongs to a goal; null for fleet-wide holds. */
  goalRef: string | null;
  /** The parked agent, when there is one. */
  agentId: string | null;
  /** Live plan parts this ask is holding. Zero when it genuinely holds nothing. */
  holding: number;
  raisedAt: string;
}

/**
 * How many live parts named this slug — the same rule the bench station has
 * always used, lifted out so the queue, the goal page and the station cannot
 * disagree about what an ask is holding. Direct dependents only: a transitive
 * count would claim work that a sibling, not this ask, is the blocker for.
 */
export function partHolding(planId: string, slug: string, parts: readonly PlanPart[]): number {
  return parts.filter((p) => p.status !== 'retired' && p.planId === planId && p.dependsOn.includes(slug)).length;
}

/** The goal a ref belongs to, as `issue:<n>` — `issue:12:part:x` and `issue:12` both fold to `issue:12`. */
function goalOf(ref: string | null | undefined): string | null {
  const m = /^(issue:\d+)/.exec(ref ?? '');
  return m ? m[1] : null;
}

function holdingForTask(task: HumanTask, parts: readonly PlanPart[]): number {
  if (!task.partId) return 0;
  const step = parts.find((p) => p.id === task.partId);
  return step ? partHolding(step.planId, step.slug, parts) : 0;
}

function holdingForEscalation(e: Escalation, state: AppState): number {
  const originRef = state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef ?? null;
  const m = /^issue:\d+:part:(.+)$/.exec(originRef ?? '');
  if (!m) return 0;
  const step = (state.planParts ?? []).find((p) => p.slug === m[1]);
  return step ? partHolding(step.planId, step.slug, state.planParts ?? []) : 0;
}

function kindOf(e: Escalation, proposal: Proposal | undefined): NeedKind {
  if (e.context.permission) return 'permission';
  return proposal ? 'proposal' : 'escalation';
}

const GROUP_RANK: Record<NeedGroup, number> = { blocking: 0, yours: 1 };

/**
 * The merged queue, ordered. Recovery first because while it is up no pulse runs
 * at all, so every other row is waiting on it whether or not it says so. Then
 * blocking before yours, then whatever holds the most work, then oldest first.
 */
export function buildNeedsYou(state: AppState): NeedRow[] {
  const parts = state.planParts ?? [];
  const proposals = state.proposals ?? [];
  const rows: NeedRow[] = [];

  if ((state.recovery ?? []).length > 0) {
    rows.push({
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: `${state.recovery.length} runs were orphaned by a restart`,
      goalRef: null,
      agentId: null,
      holding: 0,
      raisedAt: '',
    });
  }

  for (const e of state.escalations.filter((x) => x.status === 'open')) {
    const proposal = proposals.find((p) => p.escalationId === e.id);
    rows.push({
      id: e.id,
      kind: kindOf(e, proposal),
      group: 'blocking',
      title: e.prompt,
      goalRef: goalOf(state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef),
      agentId: e.agentId,
      holding: holdingForEscalation(e, state),
      raisedAt: e.createdAt,
    });
  }

  for (const t of (state.humanTasks ?? []).filter((x) => x.status === 'open')) {
    rows.push({
      id: t.id,
      kind: t.kind === 'close_out' ? 'close_out' : 'bench',
      group: 'yours',
      title: t.title,
      goalRef: goalOf(t.originRef),
      agentId: null,
      holding: holdingForTask(t, parts),
      raisedAt: t.createdAt,
    });
  }

  return rows.sort((a, b) => {
    if (a.kind === 'recovery' !== (b.kind === 'recovery')) return a.kind === 'recovery' ? -1 : 1;
    if (a.group !== b.group) return GROUP_RANK[a.group] - GROUP_RANK[b.group];
    if (a.holding !== b.holding) return b.holding - a.holding;
    return a.raisedAt.localeCompare(b.raisedAt);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx tsx --test test/needsYou.test.ts
```

Expected: PASS, 5 tests.

If a fixture field name is wrong, fix the **test's** helper against `src/types.ts` — do not widen the production type to accommodate a fixture.

- [ ] **Step 5: Run the full check**

```bash
npm run check
```

Expected: all six pass. `buildNeedsYou`, `partHolding`, `NeedRow`, `NeedKind` and `NeedGroup` are reachable from a test entry point, so knip is satisfied.

- [ ] **Step 6: Commit**

```bash
git add web/src/view/needsYou.ts test/needsYou.test.ts
git commit -m "Merge every blocking item into one ordered queue"
```

---

### Task 2: The goal-page derivation

**Files:**
- Create: `web/src/view/goalPage.ts`
- Test: `test/goalPage.test.ts`

**Interfaces:**
- Consumes: `NeedRow` and `buildNeedsYou` from Task 1.
- Produces: `PartGroup`, `GoalPartView`, `GoalPageView`, `GoalTrack`, `buildGoalPage(state, ref, needs): GoalPageView | null`, `buildGoalTrack(parts): GoalTrack`. Tasks 3, 6 and 7 consume these names.

- [ ] **Step 1: Write the failing test**

Create `test/goalPage.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, Plan, PlanPart } from '../web/src/types.js';
import { buildGoalPage, buildGoalTrack } from '../web/src/view/goalPage.js';
import { buildNeedsYou } from '../web/src/view/needsYou.js';

const { buildDemoState } = await import('../web/src/demo/fixtures.js');

function part(over: Partial<PlanPart>): PlanPart {
  return {
    id: 'p:a', planId: 'p', slug: 'a', seq: 1, title: 'A', scope: 'src/a.ts',
    rationale: null, acceptance: null, expectedKind: null, outcomeKind: null,
    outcomeRef: null, outcomeSummary: null, dependsOn: [], branch: null,
    prNumber: null, status: 'ready', blockedReason: null, taskId: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function plan(originRef: string): Plan {
  return {
    id: 'p', originRef, title: 'A plan', status: 'active', reason: null,
    risks: null, outOfScope: null, document: null, discussing: false,
    statusCommentRef: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('an unknown goal ref yields null rather than an empty page', () => {
  const state = buildDemoState().state;
  assert.equal(buildGoalPage(state, 'issue:99999', []), null);
});

test('parts group by status, and a retired part is on no page at all', () => {
  const parts = [
    part({ id: 'p:1', slug: 'one', status: 'merged' }),
    part({ id: 'p:2', slug: 'two', status: 'in_review' }),
    part({ id: 'p:3', slug: 'three', status: 'blocked', blockedReason: 'waits on creds' }),
    part({ id: 'p:4', slug: 'four', status: 'pending' }),
    part({ id: 'p:5', slug: 'five', status: 'retired' }),
  ];
  const state = buildDemoState().state;
  const issue = state.world.issues[0];
  const page = buildGoalPage(
    { ...state, planParts: parts, plans: [plan(`issue:${issue.number}`)] },
    `issue:${issue.number}`,
    [],
  );

  assert.deepEqual(
    page?.parts.map((p) => [p.part.slug, p.group]),
    [['one', 'merged'], ['two', 'now'], ['three', 'held'], ['four', 'waiting']],
  );
});

test('the track folds the same groups the page draws, so the two cannot disagree', () => {
  const parts = [
    part({ id: 'p:1', slug: 'one', status: 'merged' }),
    part({ id: 'p:2', slug: 'two', status: 'concluded' }),
    part({ id: 'p:3', slug: 'three', status: 'dispatched' }),
    part({ id: 'p:4', slug: 'four', status: 'blocked' }),
  ];
  const state = buildDemoState().state;
  const issue = state.world.issues[0];
  const page = buildGoalPage(
    { ...state, planParts: parts, plans: [plan(`issue:${issue.number}`)] },
    `issue:${issue.number}`,
    [],
  );

  assert.deepEqual(buildGoalTrack(page?.parts ?? []), {
    merged: 2, now: 1, held: 1, waiting: 0, total: 4,
  });
});

test('only this goal’s asks reach its page', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0];
  const needs = buildNeedsYou(state);
  const page = buildGoalPage(state, `issue:${issue.number}`, needs);

  for (const row of page?.needs ?? []) assert.equal(row.goalRef, `issue:${issue.number}`);
});

test('the activity list is this goal’s decisions, read off subjectRef', () => {
  const state = buildDemoState().state;
  const issue = state.world.issues[0];
  const page = buildGoalPage(state, `issue:${issue.number}`, []);

  for (const d of page?.decisions ?? []) {
    assert.ok(d.subjectRef?.startsWith(`issue:${issue.number}`));
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx --test test/goalPage.test.ts
```

Expected: FAIL — `Cannot find module '../web/src/view/goalPage.js'`.

- [ ] **Step 3: Write the implementation**

Create `web/src/view/goalPage.ts`:

```ts
import type {
  Agent,
  AppState,
  CockpitDecision,
  Issue,
  OpenPullRequest,
  Plan,
  PlanPart,
  PullRequest,
} from '../types.js';
import type { NeedRow } from './needsYou.js';

/**
 * Where a part stands, folded from `status` alone. Four groups rather than eight
 * statuses because the page is read as a sequence — what is done, what is moving,
 * what is stuck, what has not started — and `ready` versus `pending` is a
 * distinction the queue's own reason states better than a column heading can.
 */
export type PartGroup = 'merged' | 'now' | 'held' | 'waiting';

export interface GoalPartView {
  part: PlanPart;
  group: PartGroup;
  /** The agent on this part right now, when there is one. */
  agentId: string | null;
}

/** The overview's five-segment reading of a goal. */
export interface GoalTrack {
  merged: number;
  now: number;
  held: number;
  waiting: number;
  total: number;
}

export interface GoalPageView {
  issue: Issue;
  /** This goal's open asks, already ordered by {@link buildNeedsYou}. */
  needs: NeedRow[];
  plan: Plan | null;
  parts: GoalPartView[];
  openPullRequests: OpenPullRequest[];
  closedPullRequests: PullRequest[];
  agents: Agent[];
  /** This goal's own slice of the decision log, newest first as the server ordered it. */
  decisions: CockpitDecision[];
}

const GROUP_OF: Record<PlanPart['status'], PartGroup | null> = {
  merged: 'merged',
  concluded: 'merged',
  dispatched: 'now',
  in_review: 'now',
  blocked: 'held',
  ready: 'waiting',
  pending: 'waiting',
  retired: null,
};

/**
 * Everything one goal's page draws, assembled from the snapshot. Null for a ref
 * the world does not carry: a page of empty sections is indistinguishable from a
 * goal that exists and has nothing on it, and only one of those is worth drawing.
 *
 * `needs` is passed in rather than rebuilt so the rail and the page are one
 * reading — answering on either settles the row and the next snapshot clears both.
 */
export function buildGoalPage(state: AppState, ref: string, needs: readonly NeedRow[]): GoalPageView | null {
  const number = Number(/^issue:(\d+)$/.exec(ref)?.[1]);
  if (!Number.isFinite(number)) return null;

  const issue =
    state.world.issues.find((i) => i.number === number) ??
    (state.retainedRuns ?? []).find((i) => i.number === number);
  if (!issue) return null;

  const plan = (state.plans ?? []).find((p) => p.originRef === ref) ?? null;
  const parts = (state.planParts ?? [])
    .filter((p) => plan !== null && p.planId === plan.id)
    .flatMap<GoalPartView>((part) => {
      const group = GROUP_OF[part.status];
      if (!group) return [];
      const agent = state.agents.find(
        (a) => state.tasks.find((t) => t.id === a.taskId)?.originRef === `${ref}:part:${part.slug}`,
      );
      return [{ part, group, agentId: agent?.id ?? null }];
    })
    .sort((a, b) => a.part.seq - b.part.seq);

  const partPrs = new Set(parts.flatMap((p) => (p.part.prNumber === null ? [] : [p.part.prNumber])));

  return {
    issue,
    needs: needs.filter((n) => n.goalRef === ref),
    plan,
    parts,
    openPullRequests: state.world.pullRequests.filter((pr) => partPrs.has(pr.number)),
    closedPullRequests: (state.world.closedPullRequests ?? []).filter((pr) => partPrs.has(pr.number)),
    agents: state.agents.filter((a) => state.tasks.find((t) => t.id === a.taskId)?.originRef?.startsWith(ref)),
    decisions: state.decisions.filter((d) => d.subjectRef?.startsWith(ref)),
  };
}

/**
 * The overview's track, folded off the page's own groups rather than off `status`
 * a second time — which is what stops the row and the page disagreeing about
 * whether a part is held or merely not started.
 */
export function buildGoalTrack(parts: readonly GoalPartView[]): GoalTrack {
  const count = (g: PartGroup) => parts.filter((p) => p.group === g).length;
  return {
    merged: count('merged'),
    now: count('now'),
    held: count('held'),
    waiting: count('waiting'),
    total: parts.length,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx tsx --test test/goalPage.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Run the full check**

```bash
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add web/src/view/goalPage.ts test/goalPage.test.ts
git commit -m "Assemble a goal's whole page from the snapshot"
```

---

### Task 3: Wire the derivations and the selected goal into the view model

**Files:**
- Modify: `web/src/view/viewModel.ts`
- Modify: `web/src/cockpit/useCockpit.ts`
- Modify: `web/src/cockpit/actions.ts`
- Test: `test/needsYou.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: on `CockpitView` — `needsYou: NeedRow[]`, `selectedGoal: string | null`, `goalPage: GoalPageView | null`, `consolePanel: ConsolePanel`, `backlogOpen: boolean`. On `CockpitActions` — `selectGoal(ref: string | null): void`, `openPanel(panel: ConsolePanel): void`, `openBacklog(open: boolean): void`. `export type ConsolePanel = 'findings' | 'faults' | 'output' | 'launch' | null` lives in `web/src/cockpit/actions.ts`. Tasks 4–9 consume all of these.

**All five view fields land in this task**, including `backlogOpen`, which nothing draws until Task 8. Adding it later would mean every `buildViewModel` call site written in Tasks 4–7 — production and test — needing a second edit, and a required field added mid-plan is exactly the kind of churn that makes a later task fail for a reason unrelated to its own change.

- [ ] **Step 1: Write the failing test**

Append to `test/needsYou.test.ts`:

```ts
test('the view model exposes the queue and the selected goal together', async () => {
  const { buildViewModel } = await import('../web/src/view/viewModel.js');
  const state = buildDemoState().state;
  const ref = `issue:${state.world.issues[0].number}`;

  const view = buildViewModel({
    state, now: Date.now(), connected: true, demo: true, selected: null,
    liveOutput: new Map(), tails: new Map(), lastPulseAt: Date.now(),
    viewingPlan: null, viewingRetro: null, viewingScratchpad: null,
    settingsOpen: false, spendOpen: false, reliabilityOpen: false,
    selectedGoal: ref, consolePanel: null, backlogOpen: false,
  });

  assert.equal(view.selectedGoal, ref);
  assert.equal(view.goalPage?.issue.number, state.world.issues[0].number);
  assert.deepEqual(view.needsYou, view.goalPage ? view.needsYou : []);
  assert.ok(Array.isArray(view.needsYou));
});

test('no selected goal means no goal page', async () => {
  const { buildViewModel } = await import('../web/src/view/viewModel.js');
  const state = buildDemoState().state;

  const view = buildViewModel({
    state, now: Date.now(), connected: true, demo: true, selected: null,
    liveOutput: new Map(), tails: new Map(), lastPulseAt: Date.now(),
    viewingPlan: null, viewingRetro: null, viewingScratchpad: null,
    settingsOpen: false, spendOpen: false, reliabilityOpen: false,
    selectedGoal: null, consolePanel: null, backlogOpen: false,
  });

  assert.equal(view.goalPage, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx --test test/needsYou.test.ts
```

Expected: FAIL — `selectedGoal` is not a known property of `ViewInputs`, and `view.goalPage` is undefined.

- [ ] **Step 3: Extend the view model**

In `web/src/view/viewModel.ts`, add the imports:

```ts
import { buildNeedsYou } from './needsYou.js';
import type { NeedRow } from './needsYou.js';
import { buildGoalPage } from './goalPage.js';
import type { GoalPageView } from './goalPage.js';
import type { ConsolePanel } from '../cockpit/actions.js';
```

Add to `CockpitView`, after `liveOverlapCount`:

```ts
  /** Every blocking item, merged and ordered — the queue rail's whole contents. */
  needsYou: NeedRow[];
  /** The goal whose page is open, as `issue:<n>`, or null for the overview. */
  selectedGoal: string | null;
  /** That goal's page, or null when none is selected or the ref is not in the world. */
  goalPage: GoalPageView | null;
  /** Which full-surface panel is in front, or null. */
  consolePanel: ConsolePanel;
```

Add the same four (minus `goalPage`, which is derived) to `ViewInputs`:

```ts
  /** The goal whose page is open, as `issue:<n>`. */
  selectedGoal: string | null;
  /** Which full-surface panel is in front. */
  consolePanel: ConsolePanel;
  /** Whether the backlog view is open instead of the overview. */
  backlogOpen: boolean;
```

And in the returned object, after `liveOverlapCount`:

```ts
    needsYou,
    selectedGoal: input.selectedGoal,
    goalPage: input.selectedGoal ? buildGoalPage(state, input.selectedGoal, needsYou) : null,
    consolePanel: input.consolePanel,
```

with, above the `return`:

```ts
  const needsYou = buildNeedsYou(state);
```

- [ ] **Step 4: Add the actions and the state**

In `web/src/cockpit/actions.ts`, add the type above `CockpitActions`:

```ts
/**
 * Which full-surface panel is in front. One value rather than a boolean each: a
 * boolean per panel admits far more states than there are, and two panels in
 * front at once is not something this layout can draw.
 */
export type ConsolePanel = 'findings' | 'faults' | 'output' | 'launch' | null;
```

and the two methods to the interface:

```ts
  /** Open a goal's page, or return to the overview with null. */
  selectGoal(ref: string | null): void;
  /** Bring a full-surface panel in front, or dismiss it with null. */
  openPanel(panel: ConsolePanel): void;
```

In `web/src/cockpit/useCockpit.ts`, add two `useState` hooks beside the existing UI state (`viewingPlan`, `settingsOpen`, …), bind both actions in the same `useMemo` the other UI actions are bound in, and pass `selectedGoal` and `consolePanel` into `buildViewModel`. Follow the file's existing pattern exactly rather than introducing a second one.

- [ ] **Step 5: Run the tests**

```bash
npx tsx --test test/needsYou.test.ts test/goalPage.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full check**

```bash
npm run check
```

`test/factoryFloor.test.ts` calls `buildViewModel` and will fail to typecheck until its call sites pass the two new inputs. Add `selectedGoal: null, consolePanel: null` to each — the floor ignores them, and the file is deleted in Task 10 anyway.

- [ ] **Step 7: Commit**

```bash
git add web/src/view/viewModel.ts web/src/cockpit/ test/
git commit -m "Carry the queue and the open goal on the view model"
```

---

### Task 4: The console shell

**Files:**
- Create: `web/src/console/ConsoleRoot.tsx`, `web/src/console/TopBar.tsx`, `web/src/console/Panel.tsx`, `web/src/console/console.css`
- Test: `test/console.test.ts`

**Interfaces:**
- Consumes: `CockpitView` (Task 3), `CockpitActions`, `ConsolePanel`.
- Produces: `ConsoleRoot({ view, actions })`, `TopBar({ view, actions })`, `Panel({ title, onClose, children })`. Tasks 5–9 consume these.

Two rules from the design carry into this task and are what the tests pin:

- **A dropped socket empties the console.** No gauge, no rail, no situation area — one `Off the air` card. Nothing must be polled into a lie.
- **The recovery banner sits outside the situation area**, above it, at every width, because while it is up every goal is stale for the same reason.

- [ ] **Step 1: Write the failing test**

Create `test/console.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildViewModel } from '../web/src/view/viewModel.js';
import type { CockpitView } from '../web/src/view/viewModel.js';
import type { CockpitActions } from '../web/src/cockpit/actions.js';
import type { GoalPartView } from '../web/src/view/goalPage.js';

// `tsx` compiles JSX with the classic runtime, which emits bare
// `React.createElement`; the bundle uses the automatic one. The global goes in
// before the console's modules load so the test exercises the same sources.
(globalThis as { React?: typeof React }).React = React;

const { buildDemoState } = await import('../web/src/demo/fixtures.js');
const { ConsoleRoot } = await import('../web/src/console/ConsoleRoot.js');

function view(over: Partial<CockpitView> = {}): CockpitView {
  const state = buildDemoState().state;
  return {
    ...buildViewModel({
      state, now: Date.now(), connected: true, demo: true, selected: null,
      liveOutput: new Map(), tails: new Map(), lastPulseAt: Date.now(),
      viewingPlan: null, viewingRetro: null, viewingScratchpad: null,
      settingsOpen: false, spendOpen: false, reliabilityOpen: false,
      selectedGoal: null, consolePanel: null, backlogOpen: false,
    }),
    ...over,
  };
}

const actions = new Proxy({}, { get: () => () => undefined }) as CockpitActions;

const render = (v: CockpitView) => renderToStaticMarkup(createElement(ConsoleRoot, { view: v, actions }));

test('nothing under console/ imports the api module', () => {
  const dir = new URL('../web/src/console/', import.meta.url).pathname;
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  for (const file of walk(dir)) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/from '.*\/api\.js'/.test(src), `${file} reaches api.js — every mutation belongs on CockpitActions`);
  }
});

test('console.css never targets a shared component’s class', () => {
  const css = readFileSync(new URL('../web/src/console/console.css', import.meta.url).pathname, 'utf8');
  for (const cls of ['.escalation-card', '.recovery-panel', '.findings-panel', '.human-task-actions']) {
    assert.ok(!css.includes(cls), `console.css styles ${cls}; shared components restyle through tokens only`);
  }
});

test('a dropped socket draws no gauge, no rail and no situation area', () => {
  const html = render(view({ connected: false }));
  assert.ok(html.includes('Off the air'));
  assert.ok(!html.includes('cn-rail'), 'the rail must not render while offline');
  assert.ok(!html.includes('cn-sit'), 'the situation area must not render while offline');
});

test('the recovery banner sits outside the situation area', () => {
  const html = render(view({ crashed: [{ taskId: 't1' }] as CockpitView['crashed'] }));
  const banner = html.indexOf('cn-recovery');
  const sit = html.indexOf('cn-sit');
  assert.ok(banner !== -1, 'a held harness must draw its banner');
  assert.ok(banner < sit, 'the banner belongs above the situation area, not inside it');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx --test test/console.test.ts
```

Expected: FAIL — `Cannot find module '../web/src/console/ConsoleRoot.js'`.

- [ ] **Step 3: Write the stylesheet**

Create `web/src/console/console.css`. Take the tokens, the shell grid, the rail, the card and row vocabulary, and the breakpoints from the approved mockup at [`docs/superpowers/mockups/layout-a.html`](../mockups/layout-a.html) — it is the agreed layout and the CSS in it is the reference. Prefix every class `cn-`. The breakpoints, stated once and only here:

```css
/* < 1100: rail above, one column. 1100+: rail beside. 1500+: goal page gains
   its right column. 2000+: overview in four tracks. Matching these in React as
   well would cost a resize listener and a second definition of every boundary. */
@media (min-width: 1100px) { .cn-body { grid-template-columns: 360px 1fr; } }
@media (min-width: 1200px) { .cn-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 1500px) { .cn-gcols { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); } }
@media (min-width: 2000px) { .cn-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
```

The plan's waves **stack below 1500px** rather than scrolling sideways:

```css
.cn-waves { display: grid; gap: 12px; }
@media (min-width: 1500px) { .cn-waves { grid-auto-flow: column; grid-auto-columns: minmax(250px, 1fr); } }
```

Import it from `web/src/main.tsx` beside `factory.css`, **not** from a module under `console/` — `tsx` has no CSS loader and would throw when the test pulls those modules in.

- [ ] **Step 4: Write the shell**

Create `web/src/console/Panel.tsx`:

```tsx
import { useEffect } from 'react';

/**
 * A full-surface panel with three ways out — the backdrop, the button and
 * Escape. A thing that covers the console must not have exactly one exit.
 */
export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="cn-backdrop" onClick={onClose}>
      <section className="cn-panel" onClick={(e) => e.stopPropagation()}>
        <header className="cn-panel-head">
          <h2>{title}</h2>
          <button className="cn-btn" onClick={onClose}>Close</button>
        </header>
        {children}
      </section>
    </div>
  );
}
```

Create `web/src/console/TopBar.tsx` with the ident, the `Scan` control (embedding nothing — it calls `actions.pulse()`), the fleet cap (embedding the shared `FleetControl`), and the readings for Spend, Yield, Output, Findings, Faults and Settings, each a real `<button>` calling `actions.openSpend(true)`, `actions.openReliability(true)`, `actions.openPanel('output')`, `actions.openPanel('findings')`, `actions.openPanel('faults')` and `actions.openSettings(true)` respectively. A zero count **mutes** a reading; it never removes it.

Create `web/src/console/ConsoleRoot.tsx` — placement only:

```tsx
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import { TopBar } from './TopBar.js';
import { RecoveryPanel } from '../components/RecoveryPanel.js';

/**
 * The console's placement, and deliberately nothing else: what a panel contains
 * and where it sits are separate edits, so every one below is bound to a const
 * and then placed.
 *
 * A dropped socket empties the whole surface. Every reading here is one the
 * harness confirms, and a stale one is drawn in exactly the chrome of a live
 * one — so rather than ask an operator to remember to check a chip, nothing is
 * drawn at all.
 */
export function ConsoleRoot({ view, actions }: { view: CockpitView; actions: CockpitActions }) {
  if (!view.connected) {
    return (
      <div className="cn">
        <TopBar view={view} actions={actions} />
        <div className="cn-offline"><h1>Off the air</h1><p>The link to the harness dropped. The harness is unaffected; the console returns by itself when it reconnects.</p></div>
      </div>
    );
  }

  const recovery =
    view.crashed.length > 0 ? (
      <div className="cn-recovery">
        <RecoveryPanel crashed={view.crashed} onDecide={(id, verdict) => actions.decideRecovery(id, verdict)} />
      </div>
    ) : null;

  return (
    <div className="cn">
      <TopBar view={view} actions={actions} />
      {recovery}
      <div className="cn-body">
        <aside className="cn-rail" />
        <main className="cn-sit" />
      </div>
    </div>
  );
}
```

The empty `<aside>` and `<main>` are filled in Tasks 5–8. Check `RecoveryPanel`'s real prop names in `web/src/components/RecoveryPanel.tsx` and match them; do not guess.

- [ ] **Step 5: Run the tests**

```bash
npx tsx --test test/console.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Run the full check**

```bash
npm run check
```

- [ ] **Step 7: Commit**

```bash
git add web/src/console/ web/src/main.tsx test/console.test.ts
git commit -m "Stand up the console shell, empty when the link drops"
```

---

### Task 5: The queue rail

**Files:**
- Create: `web/src/console/QueueRail.tsx`
- Modify: `web/src/console/ConsoleRoot.tsx`, `web/src/console/console.css`
- Test: `test/console.test.ts` (extend)

**Interfaces:**
- Consumes: `NeedRow` (Task 1), `view.needsYou`, `actions.selectGoal`.
- Produces: `QueueRail({ view, actions })`.

- [ ] **Step 1: Write the failing test**

Append to `test/console.test.ts`:

```ts
test('the rail carries every blocking kind in one list', () => {
  const html = render(view());
  const v = view();
  assert.ok(v.needsYou.length > 0, 'the demo fixtures must carry at least one ask');
  for (const row of v.needsYou) assert.ok(html.includes(row.title), `the rail dropped ${row.kind}`);
});

test('a row states what it is holding, and a row holding nothing draws no count', () => {
  const rows = [
    { id: 'a', kind: 'escalation', group: 'blocking', title: 'Holds two', goalRef: 'issue:1', agentId: 'a1', holding: 2, raisedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', kind: 'bench', group: 'yours', title: 'Holds nothing', goalRef: 'issue:1', agentId: null, holding: 0, raisedAt: '2026-01-01T00:00:00.000Z' },
  ] as CockpitView['needsYou'];

  const html = render(view({ needsYou: rows }));
  assert.ok(html.includes('holding 2 parts'));
  assert.ok(!html.includes('holding 0'), 'a zero is not a reading — draw no count');
});

test('an empty queue collapses the rail rather than removing it', () => {
  const html = render(view({ needsYou: [] }));
  assert.ok(html.includes('cn-rail'), 'a surface that vanishes when quiet reads as one that broke');
  assert.ok(html.includes('cn-rail-empty'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx --test test/console.test.ts
```

Expected: FAIL — the rail renders nothing, so the row titles are absent.

- [ ] **Step 3: Write the rail**

Create `web/src/console/QueueRail.tsx`. Requirements, each of which a test above pins:

- Two groups, `blocking` above `yours`, each with its own sub-heading; a group with no rows draws no heading.
- Each row: the kind as a tag, the age, the title, the goal it belongs to, and `holding N parts` **only when `holding > 0`**.
- A row with a `goalRef` is a `<button>` calling `actions.selectGoal(row.goalRef)`. A row with none (recovery) is not clickable — the banner above is where it is answered.
- At zero rows, render the rail with a `cn-rail-empty` note ("Nothing is waiting on you"), never nothing.

Place it in `ConsoleRoot` in the `<aside className="cn-rail">`.

- [ ] **Step 4: Run the tests**

```bash
npx tsx --test test/console.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Run the full check**

```bash
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add web/src/console/ test/console.test.ts
git commit -m "Put every blocking item in one rail, ordered by what it holds"
```

---

### Task 6: The goal page

**Files:**
- Create: `web/src/console/GoalPage.tsx`
- Modify: `web/src/console/ConsoleRoot.tsx`, `web/src/console/console.css`
- Test: `test/console.test.ts` (extend)

**Interfaces:**
- Consumes: `GoalPageView`, `GoalPartView` (Task 2); the shared `EscalationCard` and `HumanTaskActions`.
- Produces: `GoalPage({ page, view, actions })`.

This is the design's central claim, and the tests pin it directly: **the ask sits above the plan, and a goal with no ask draws no band.**

- [ ] **Step 1: Write the failing test**

Append to `test/console.test.ts`:

```ts
function goalView(): CockpitView {
  const v = view();
  const ref = v.needsYou.find((n) => n.goalRef)?.goalRef ?? `issue:${buildDemoState().state.world.issues[0].number}`;
  const state = buildDemoState().state;
  return {
    ...buildViewModel({
      state, now: Date.now(), connected: true, demo: true, selected: null,
      liveOutput: new Map(), tails: new Map(), lastPulseAt: Date.now(),
      viewingPlan: null, viewingRetro: null, viewingScratchpad: null,
      settingsOpen: false, spendOpen: false, reliabilityOpen: false,
      selectedGoal: ref, consolePanel: null, backlogOpen: false,
    }),
  };
}

test('a selected goal draws its page instead of the overview', () => {
  const v = goalView();
  const html = render(v);
  assert.ok(html.includes('cn-goal'));
  assert.ok(v.goalPage !== null);
  assert.ok(html.includes(String(v.goalPage!.issue.title)));
});

test('the ask is drawn above the plan, which is the whole point of the page', () => {
  const v = goalView();
  if ((v.goalPage?.needs.length ?? 0) === 0) return; // fixtures carry no ask on this goal
  const html = render(v);
  assert.ok(html.indexOf('cn-needs') < html.indexOf('cn-waves'));
});

test('a goal with no ask draws no band at all', () => {
  const v = goalView();
  const html = render({ ...v, goalPage: { ...v.goalPage!, needs: [] } });
  assert.ok(!html.includes('cn-needs'), 'a band with nothing in it is not a band');
});

test('a held part quotes the reconciler’s own reason rather than inventing one', () => {
  const v = goalView();
  const page = v.goalPage;
  assert.ok(page, 'the fixture goal must resolve to a page');
  const first = page.parts[0];
  if (!first) return; // the fixture goal has no plan; the grouping tests cover this

  const parts: GoalPartView[] = [
    {
      part: { ...first.part, status: 'blocked', blockedReason: 'waits on staging credentials' },
      group: 'held',
      agentId: null,
    },
  ];

  const html = render({ ...v, goalPage: { ...page, parts } });
  assert.ok(html.includes('waits on staging credentials'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx --test test/console.test.ts
```

Expected: FAIL — `cn-goal` is absent.

- [ ] **Step 3: Write the page**

Create `web/src/console/GoalPage.tsx`, in the design's order:

1. **Header** — `#<n> · <title>`, the item type and workflow state as chips, the assay verdict, the age, agent count, `issue.spend` when present (**no row at all when null** — a goal with no measurement must not draw `$0.00`), and parts merged. Controls: the watch toggle (`actions.setIssueWatched`), the conclusion verdict (`actions.setIssueConclusion`), raise a bug (`actions.raiseBug`), the ticket URL from `state.refUrls`, and `actions.dismissRun` **only when a retained run exists and has not ended**.
2. **The needs band** — one block per `page.needs` row, red for `blocking` and amber for `yours`. Each embeds the **shared** component that owns its refusal rules: `EscalationCard` for `escalation` / `permission` / `proposal`, `HumanTaskActions` for `bench` / `close_out`. Pass `buttonClass="cn-btn"` where the component offers the seam, exactly as the bench station does today. **Do not reimplement any verdict.**
3. **The plan** — `cn-waves`, grouped merged / now / held / waiting, each part carrying its title, `scope`, `dependsOn`, PR number and, when held, `blockedReason` verbatim.
4. **The ticket** — `issue.body`, rendered through the existing `markdown` helper in `web/src/components/markdown.ts`.
5. **Pull requests** — open and closed, with the court chip off `attention.status` and the CI ladder off `ciVerdict`, both quoted.
6. **What has happened** — `page.decisions`, capped at 40 with a note naming the total, the shift log's convention.

Right column at ≥1500px: agents on this goal, the spend split, the tail, and the scratchpad link (`actions.viewScratchpad`).

In `ConsoleRoot`, render `GoalPage` in `<main className="cn-sit">` when `view.goalPage !== null`.

- [ ] **Step 4: Run the tests**

```bash
npx tsx --test test/console.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Run the full check**

```bash
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add web/src/console/ test/console.test.ts
git commit -m "Show an ask with the goal it is about"
```

---

### Task 7: The overview

**Files:**
- Create: `web/src/console/Overview.tsx`
- Modify: `web/src/console/ConsoleRoot.tsx`, `web/src/console/console.css`
- Test: `test/console.test.ts` (extend)

**Interfaces:**
- Consumes: `buildGoalTrack` (Task 2), `view.live`, `state.world`, `state.upcoming`, `state.worldEvents`.
- Produces: `Overview({ view, actions })`.

- [ ] **Step 1: Write the failing test**

Append to `test/console.test.ts`:

```ts
test('with no goal selected the overview draws its five cards', () => {
  const html = render(view());
  for (const title of ['Fleet', 'Goals in flight', 'Pull requests', 'Up next', 'World signals']) {
    assert.ok(html.includes(title), `the overview is missing ${title}`);
  }
});

test('a queued item states why it is held, in the queue’s own words', () => {
  const v = view();
  const held = v.state.upcoming?.items.filter((i) => i.reason);
  if (!held?.length) return;
  const html = render(v);
  for (const item of held) assert.ok(html.includes(item.reason!));
});

test('an empty rack still draws — a surface that vanishes reads as one that broke', () => {
  const v = view();
  const html = render({ ...v, state: { ...v.state, world: { ...v.state.world, pullRequests: [] } } });
  assert.ok(html.includes('Pull requests'));
});

test('a goal row is a way into its page', () => {
  const html = render(view());
  assert.ok(html.includes('cn-goal-row'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx --test test/console.test.ts
```

Expected: FAIL — the card titles are absent.

- [ ] **Step 3: Write the overview**

Create `web/src/console/Overview.tsx` with five cards in this document order: **Fleet**, **Goals in flight**, **Pull requests**, **Up next**, **World signals**. Document order is reading order; no card carries an `order`.

- **Fleet** — one row per `view.live` agent: a lamp (red when `view.escalationByAgent` has it, green running, amber waiting), what it is on, elapsed, cost. A `shifts ended` count in the header opens the past list.
- **Goals in flight** — one row per goal with work in flight, each a `<button className="cn-goal-row">` calling `actions.selectGoal(ref)`, carrying the segment track from `buildGoalTrack` and the court chip.
- **Pull requests** — every open PR: number, title, goal, the CI ladder from `ciVerdict`, the court chip from `attention.status`, and the watch/ignore toggle (`actions.setPrExcluded`), rendered **disabled rather than absent** when no `ignoreLabel` is configured. Merged count in the header. Draws even when empty.
- **Up next** — each `state.upcoming.items` row with its `reason` quoted verbatim.
- **World signals** — `state.worldEvents` grouped by `(kind, ref)` with a count, so three comments on one PR read as one signal.

Render it in `ConsoleRoot` when `view.goalPage === null` and no nav view is chosen.

- [ ] **Step 4: Run the tests**

```bash
npx tsx --test test/console.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Run the full check**

```bash
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add web/src/console/ test/console.test.ts
git commit -m "Draw the fleet, the goals and the rack as rows"
```

---

### Task 8: The backlog and the panels

**Files:**
- Create: `web/src/console/Backlog.tsx`
- Modify: `web/src/console/ConsoleRoot.tsx`, `web/src/console/TopBar.tsx`, `web/src/console/console.css`
- Test: `test/console.test.ts` (extend)

**Interfaces:**
- Consumes: `view.consolePanel`, `actions.openPanel`, `actions.setIssueWatched`, `actions.setIssueAssay`; the shared `FindingsPanel`, `LaunchPanel`, `SchedulePanel`.
- Produces: `Backlog({ view, actions })`.

- [ ] **Step 1: Write the failing test**

Append to `test/console.test.ts`:

```ts
test('the backlog groups by watch state and gives intake its own group', () => {
  const v = view({ consolePanel: null, selectedGoal: null });
  const html = renderToStaticMarkup(createElement(ConsoleRoot, { view: { ...v, backlogOpen: true } as CockpitView, actions }));
  for (const group of ['Watched', 'Blocked at intake', 'Unwatched', 'Ignored']) {
    assert.ok(html.includes(group), `the backlog is missing ${group}`);
  }
});

test('a container type is disabled rather than absent — cannot be picked up is worth seeing', () => {
  const v = view();
  const state = { ...v.state, world: { ...v.state.world, issues: [{ ...v.state.world.issues[0], issueType: 'Feature' }] } };
  const html = renderToStaticMarkup(
    createElement(ConsoleRoot, { view: { ...v, state, backlogOpen: true } as CockpitView, actions }),
  );
  assert.ok(html.includes('disabled'));
});

test('the fault log keeps its clear even when it is empty', () => {
  const v = view({ consolePanel: 'faults' });
  const html = render({ ...v, state: { ...v.state, errors: [] } });
  assert.ok(html.includes('Clear'), 'the only route to clear must not depend on there being rows');
});
```

`backlogOpen` and `actions.openBacklog` already exist from Task 3 — this task is the first to draw them. Wire the nav's Backlog item to `actions.openBacklog(true)` and Overview to `actions.openBacklog(false)`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx --test test/console.test.ts
```

Expected: FAIL — the group headings are absent.

- [ ] **Step 3: Write the backlog and the panels**

Create `web/src/console/Backlog.tsx` with four groups in this order:

1. **Watched** — issues the harness will act on, each with the watch toggle.
2. **Blocked at intake** — issues whose assay verdict is `unclear`, the assayer's summary quoted, with `actions.setIssueAssay(n, 'workable')` beside it. Its own group because it is the one intake reading that stops dispatch.
3. **Unwatched** — open and unclaimed, newest first, each with a Watch button. A **container type** renders its button `disabled` with the reason as its `title`.
4. **Ignored** — a tail with un-ignore.

Reuse the existing `watchBucket` predicate from `web/src/worldBuckets.ts` rather than re-reading the labels — a second reading of the same labels is how two surfaces start disagreeing about what is watched.

In `TopBar`, wire the readings to `actions.openPanel`. In `ConsoleRoot`, render the panel in front when `view.consolePanel` is set, each inside `Panel`:

- `findings` → the shared `FindingsPanel`
- `faults` → the fault log, forty rows, with the two-step clear **above** the log (one misclick between "leave" and "delete the only copy" is too few) and present at zero rows
- `output` → the production graph
- `launch` → `LaunchPanel` + `SchedulePanel`, and `InjectPanel` **only when `view.demo`**

- [ ] **Step 4: Run the tests**

```bash
npx tsx --test test/console.test.ts
```

Expected: PASS, 19 tests.

- [ ] **Step 5: Run the full check**

```bash
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add web/src/console/ web/src/view/ web/src/cockpit/ test/console.test.ts
git commit -m "Add the backlog and the panels behind the bar"
```

---

### Task 9: Switch the shell to the console

**Files:**
- Modify: `web/src/App.tsx`
- Test: `test/console.test.ts` (extend)

**Interfaces:**
- Consumes: `ConsoleRoot` (Task 4).
- Produces: nothing new. This is the cutover.

- [ ] **Step 1: Write the failing test**

Append to `test/console.test.ts`:

```ts
test('the shell renders the console and no longer names the floor', () => {
  const src = readFileSync(new URL('../web/src/App.tsx', import.meta.url).pathname, 'utf8');
  assert.ok(src.includes('ConsoleRoot'), 'the shell must render the console');
  assert.ok(!src.includes('factory/'), 'the shell must not still reach into the floor');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx --test test/console.test.ts
```

Expected: FAIL — `App.tsx` still imports `FactoryRoot`.

- [ ] **Step 3: Switch the shell**

In `web/src/App.tsx`, replace the `FactoryRoot` import and its use with `ConsoleRoot`. Leave the modals (`PlanModal`, `RetroModal`, `ScratchpadModal`, `SettingsModal`, `SpendModal`, `ReliabilityModal`) and `WorkTreePanel` exactly where they are — they hang off the shell because they ride their own routes, which is unchanged by this redesign. Update the file's header comment: it names `factory/` three times.

- [ ] **Step 4: Verify it in the browser**

```bash
npm run dev
```

Open the cockpit and confirm, in this order: the rail lists every ask; clicking one opens its goal with the ask pinned above the plan; the overview draws five cards; the backlog groups four ways; a panel closes on the backdrop, the button and Escape. Resize from ultrawide to laptop and confirm the plan's waves **stack** rather than scrolling sideways.

- [ ] **Step 5: Run the full check**

```bash
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add web/src/App.tsx test/console.test.ts
git commit -m "Render the console instead of the floor"
```

---

### Task 10: Delete the Factory Floor

**Files:**
- Delete: `web/src/factory/` (all of it), `test/factoryFloor.test.ts`
- Modify: `web/src/main.tsx`, `test/console.test.ts`

**Interfaces:** none. This removes the second presentation of one view model.

Two presentations of one view-model is two things to keep in step, and the shared-component seam exists precisely so the presentation can be replaced rather than duplicated. Nothing is kept behind a flag.

- [ ] **Step 1: Check what else names the floor**

```bash
grep -rn "factory/" web/src src test docs --include="*.ts" --include="*.tsx" --include="*.md" | grep -v docs/superpowers
```

Every hit outside `docs/spec/17-cockpit.md` must be resolved in this task; the spec is Task 11.

- [ ] **Step 2: Delete**

```bash
git rm -r web/src/factory test/factoryFloor.test.ts
```

Remove the `factory.css` import from `web/src/main.tsx`.

- [ ] **Step 3: Move the surviving structural assertions**

`test/factoryFloor.test.ts` held assertions that are about the **cockpit**, not the floor. Carry these into `test/console.test.ts` if Tasks 4–9 have not already: that the presentation layer never reaches `api.js`, that a zero count mutes rather than removes a reading, that the demo predicate gates the inject panel, and that a shared component is embedded rather than redrawn.

Anything that asserts a belt, a bay, a silo, a roboport or an inserter goes with the floor — those claims no longer exist to be true or false.

- [ ] **Step 4: Run the full check**

```bash
npm run check
```

knip is the one to read carefully here: a shared component that only the floor used is now unreachable and will be reported. For each, decide honestly — if the console should be using it, use it; if nothing needs it, delete it. Do not add an ignore entry.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Delete the floor rather than keep two presentations in step"
```

---

### Task 11: Rewrite the cockpit spec

**Files:**
- Modify: `docs/spec/17-cockpit.md`
- Check: `docs/README.md`

`docs/spec/17-cockpit.md` owns this behaviour, and roughly two thirds of its 1673 lines describe the Factory Floor specifically. The repo's one documentation rule is that the spec owning a behaviour is updated in the same change; this task is the outstanding half of that.

- [ ] **Step 1: Keep what outlives the floor**

These sections are about the cockpit and are restated, not deleted: the layer split and why the web bundle imports no server code; the `CockpitActions` seam; the shared/drawn split on behaviour weight; the token contract and its narrower-than-usual meaning; **one subject, once**; nothing at all when the link drops; a zero count mutes but never removes; red means one thing; nothing is derived in the browser that the server decided; and one DOM at every width with the breakpoints stated once.

- [ ] **Step 2: Write the new sections**

Replace the floor-specific body with: the queue rail and its ordering rule; the goal page and its order; why an ask is drawn with its goal; the overview's five cards; the backlog's four groups; the panels; and the responsive table from the design spec. Keep the prose in the document's existing voice — stated as fact, with the reasoning that stops a settled decision being re-litigated badly.

- [ ] **Step 3: Fix the cross-references**

```bash
grep -rn "factory\|Factory Floor\|Goal Floor\|the floor" docs/spec/*.md docs/README.md README.md
```

Other specs link to sections of 17 by anchor. Every anchor that moved must be repointed; a dead cross-reference is the failure mode this repo's doc rule exists to prevent.

- [ ] **Step 4: Verify**

```bash
npm run check
```

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "State the console's rules where the floor's used to be"
```

---

## Self-Review

**Spec coverage.** Every section of the design spec maps to a task: the ranking informs Tasks 5–8; the queue rail is Tasks 1 and 5; the goal page is Tasks 2 and 6; the overview is Task 7; the backlog is Task 8; what does not belong to a goal is Task 4 (recovery banner) and Task 8 (findings panel); layout at width is Task 4's stylesheet with the stacking rule pinned in Task 9's browser check; the architecture invariants are Global Constraints plus Task 4's two structural tests; the view-model additions are Tasks 1–3; new behaviour is Task 6 (activity list) and Task 1 (holding counts), with the overlap warning correctly absent; non-goals are respected — no theme is chosen, no server file is touched, the floor is deleted rather than flagged; testing is Task 10; documentation is Task 11.

**Deliberate omission.** The design defers the plan-time overlap warning to its own design, and no task implements it. The mockup shows it; the plan does not.

**Known risk, stated rather than hidden.** Task 6 assumes `state.decisions` reaches far enough back to be useful per goal. If it does not, the design says this becomes a route and is deferred — take that arm rather than half-building it, and say so in the commit.
