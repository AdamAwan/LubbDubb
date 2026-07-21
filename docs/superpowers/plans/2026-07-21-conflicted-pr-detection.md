# Conflicted-PR Detection & PR Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a merge-conflicted / behind / blocked PR visible to the decision loop — dispatch an agent to pull the base branch in and resolve, never run two agents on one branch, and surface each PR's health in the cockpit.

**Architecture:** Map GitHub's `mergeable_state` + `base.ref` through the existing narrow `GitHubApi` seam into the domain `PullRequest`. Add a per-branch concern-resolution pass to the `RuleDispatcher`: one code agent per branch, with fresh signals for an already-staffed branch delivered via `respond_to_agent` (held while the branch's agent is parked `waiting`). A pure `prHealth(pr)` folds the signals for the snapshot + UI.

**Tech Stack:** TypeScript (ESM, nodenext, explicit `.js` imports), zod action schemas, better-sqlite3 store, `node:test` via tsx, React cockpit under `web/`.

## Global Constraints

- ESM with explicit `.js` import extensions in all TS sources.
- Never cast through `unknown`; narrow with runtime type guards instead.
- `npm run check` (format:check, lint, typecheck, typecheck:web, knip, test) must pass — knip fails on unused exports, so every new export must be imported somewhere.
- Comments explain *why*, terse and high-signal.
- Two typecheckers: server (`tsconfig.json`) and web (`web/tsconfig.json`) are separate passes.
- Domain PR fields are all optional today (`approved?`, `mergeable?`, `merged?`); new fields follow suit — `baseBranch?` and `mergeableState?` — to avoid churning unrelated inline PR literals in tests. Prompts default an absent base to `main`.
- Origin-ref convention: `pr:<n>:<facet>` (`:ci`, `:mergeable`, `:comment:<id>`).

---

### Task 1: Map `mergeableState` + `baseBranch` through the GitHub seam

**Files:**
- Modify: `src/types.ts` (add `MergeableState`, extend `PullRequest`)
- Modify: `src/integrations/github/githubApi.ts` (`GhPullSummary.baseBranch`, `GhPullDetail.mergeableState`)
- Modify: `src/integrations/github/octokitGitHubApi.ts` (map `base.ref`, `mergeable_state`)
- Modify: `src/integrations/github/sourceControl.ts` (`normalizeMergeState`, set fields)
- Test: `test/githubIntegration.test.ts`

**Interfaces:**
- Produces: `type MergeableState = 'dirty'|'behind'|'blocked'|'clean'|'unknown'`; `PullRequest.baseBranch?: string`; `PullRequest.mergeableState?: MergeableState`; `normalizeMergeState(state: string|null): MergeableState`.

- [ ] **Step 1: Add the domain type + fields** in `src/types.ts`. Above `PullRequest`:

```ts
/** GitHub's `mergeable_state`, normalised to the values the harness reacts to. */
export type MergeableState = 'dirty' | 'behind' | 'blocked' | 'clean' | 'unknown';
```

Inside `PullRequest`, after the `mergeable?` field:

```ts
  /** The base branch this PR targets (e.g. "main") — needed to pull the base in. */
  baseBranch?: string;
  /**
   * GitHub's `mergeable_state`, normalised. Distinguishes a real conflict
   * ('dirty') from merely-behind-base ('behind', a safe update) and required
   * checks/reviews not met ('blocked'). Absent/unrecognised => 'unknown'.
   */
  mergeableState?: MergeableState;
```

- [ ] **Step 2: Extend the `Gh*` seam** in `src/integrations/github/githubApi.ts`. In `GhPullSummary` after `branch`:

```ts
  /** base.ref — the branch this PR merges into. */
  baseBranch: string;
```

In `GhPullDetail`:

```ts
export interface GhPullDetail {
  /** GitHub tri-state: true / false / null (still computing). */
  mergeable: boolean | null;
  /** raw `mergeable_state`: clean | dirty | behind | blocked | unstable | ... | null. */
  mergeableState: string | null;
  merged: boolean;
}
```

- [ ] **Step 3: Map from octokit** in `src/integrations/github/octokitGitHubApi.ts`. In `listOpenPulls`'s map add `baseBranch: p.base.ref,` after `branch: p.head.ref,`. In `getPull`:

```ts
  async getPull(number: number): Promise<GhPullDetail> {
    const { data } = await this.octokit.pulls.get({ ...this.base, pull_number: number });
    return { mergeable: data.mergeable, mergeableState: data.mergeable_state ?? null, merged: data.merged };
  }
```

- [ ] **Step 4: Write the failing mapping test** in `test/githubIntegration.test.ts`. First update the shared fakes so they satisfy the extended types:
  - In `fakeApi`'s `getPull` default: `return script.detail?.[number] ?? { mergeable: null, mergeableState: null, merged: false };`
  - In `pull(...)`: add `baseBranch: 'main',` to the returned object.

  Then add:

```ts
test('snapshot maps baseBranch and normalises mergeable_state', async () => {
  const { api } = fakeApi({
    pulls: [pull({ number: 7, baseBranch: 'develop' })],
    detail: { 7: { mergeable: false, mergeableState: 'dirty', merged: false } },
  });
  const integ = new GitHubSourceControlIntegration({ api, store: memStore() });
  const pr = (await integ.snapshot()).pullRequests![0]!;
  assert.equal(pr.baseBranch, 'develop');
  assert.equal(pr.mergeableState, 'dirty');
  assert.equal(pr.mergeable, false);
});

test('an unrecognised mergeable_state normalises to unknown', async () => {
  const { api } = fakeApi({
    pulls: [pull({ number: 7 })],
    detail: { 7: { mergeable: true, mergeableState: 'unstable', merged: false } },
  });
  const integ = new GitHubSourceControlIntegration({ api, store: memStore() });
  const pr = (await integ.snapshot()).pullRequests![0]!;
  assert.equal(pr.mergeableState, 'unknown');
});
```

  (Reuse the file's existing `memStore()`/`GitHubSourceControlIntegration` import helpers — confirm their exact names at the top of the file and match them.)

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx tsx --test test/githubIntegration.test.ts`
Expected: FAIL — `pr.mergeableState`/`pr.baseBranch` undefined (mapping not written yet).

- [ ] **Step 6: Implement the mapping** in `src/integrations/github/sourceControl.ts`. Add the exported helper (near the other exported helpers):

```ts
/** Fold GitHub's `mergeable_state` down to the values the harness reacts to. */
export function normalizeMergeState(state: string | null): MergeableState {
  switch (state) {
    case 'dirty':
    case 'behind':
    case 'blocked':
    case 'clean':
      return state;
    default:
      // 'unstable' | 'has_hooks' | 'draft' | 'unknown' | null | anything new.
      return 'unknown';
  }
}
```

  Import the type: add `MergeableState` to the `import type { CiStatus, PrComment, PullRequest } from '../../types.js';` line. In the `pr` object literal, add `baseBranch: p.baseBranch,` and `mergeableState: normalizeMergeState(detail.mergeableState),`. Leave the existing tri-state `mergeable` handling untouched.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx tsx --test test/githubIntegration.test.ts`
Expected: PASS (all, including the two new ones).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/integrations/github/ test/githubIntegration.test.ts
git commit -m "Map mergeable_state and base.ref through the GitHub seam"
```

---

### Task 2: Fake connector — baseBranch, mergeableState, and injectable signals

**Files:**
- Modify: `src/connector/connector.ts` (`InjectableEvent`: `new_pr.baseBranch?`, `pr_mergeable.mergeableState?`)
- Modify: `src/integrations/fake/fakeGitHub.ts` (construct + mutate the new fields)
- Test: `test/integrations.test.ts`

**Interfaces:**
- Consumes: `MergeableState` from `src/types.ts`.
- Produces: fake PRs carry `baseBranch` (default `'main'`) and `mergeableState` (default `'unknown'`); `pr_mergeable` can set `mergeableState`.

- [ ] **Step 1: Extend `InjectableEvent`** in `src/connector/connector.ts`. Import the type at top: `import type { MergeableState, WorldSnapshot } from '../types.js';` (currently imports only `WorldSnapshot`). Change the two variants:

```ts
  | { kind: 'new_pr'; number: number; title: string; branch: string; baseBranch?: string }
  ...
  | { kind: 'pr_mergeable'; prNumber: number; mergeable?: boolean; mergeableState?: MergeableState }
```

- [ ] **Step 2: Write the failing test** in `test/integrations.test.ts` (mirror the style of the existing `PR monitoring` test):

```ts
test('new_pr carries a base branch and unknown merge state; pr_mergeable can set a conflict', async () => {
  const { store, connector } = build();
  connector.inject({ kind: 'new_pr', number: 7, title: 'X', branch: 'b', baseBranch: 'develop' });
  let pr = (await connector.getState()).pullRequests[0]!;
  assert.equal(pr.baseBranch, 'develop');
  assert.equal(pr.mergeableState, 'unknown');

  connector.inject({ kind: 'pr_mergeable', prNumber: 7, mergeable: false, mergeableState: 'dirty' });
  pr = (await connector.getState()).pullRequests[0]!;
  assert.equal(pr.mergeableState, 'dirty');
  assert.equal(pr.mergeable, false);
  store.close();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test test/integrations.test.ts`
Expected: FAIL — `baseBranch`/`mergeableState` undefined.

- [ ] **Step 4: Implement in `src/integrations/fake/fakeGitHub.ts`.** In the `new_pr` case object literal: drop the `mergeable: false,` line (a fresh PR is *not* asserted un-mergeable — GitHub reports `null` while computing, and `mergeable:false` would now falsely trigger the conflict rule); add `baseBranch: event.baseBranch ?? 'main',` and `mergeableState: 'unknown',`. In the `pr_mergeable` case:

```ts
        case 'pr_mergeable':
          mutatePr(world, event.prNumber, (pr) => {
            pr.mergeable = event.mergeable ?? true;
            if (event.mergeableState !== undefined) pr.mergeableState = event.mergeableState;
          });
          break;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test test/integrations.test.ts`
Expected: PASS (including the pre-existing merge-ready test, which injects `pr_mergeable` with no state and still sees `mergeable === true`).

- [ ] **Step 6: Commit**

```bash
git add src/connector/connector.ts src/integrations/fake/fakeGitHub.ts test/integrations.test.ts
git commit -m "Fake connector: base branch + mergeable_state signals"
```

---

### Task 3: `prHealth` — pure health verdict + conflict/behind predicates

**Files:**
- Create: `src/prHealth.ts`
- Test: `test/prHealth.test.ts`

**Interfaces:**
- Consumes: `PullRequest`, `MergeableState` from `src/types.js`.
- Produces:
  - `interface PrHealth { blocked: boolean; reasons: string[] }`
  - `prHealth(pr: PullRequest): PrHealth`
  - `isConflicted(pr: PullRequest): boolean` — 'dirty', or unknown-state fallback when `mergeable === false`
  - `needsBaseUpdate(pr: PullRequest): boolean` — conflicted or 'behind', and not merged

- [ ] **Step 1: Write the failing test** in `test/prHealth.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prHealth, isConflicted, needsBaseUpdate } from '../src/prHealth.js';
import type { PullRequest } from '../src/types.js';

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { id: 'p', number: 1, title: 'X', branch: 'feat', ciStatus: 'passing', unresolvedComments: [], ...over };
}

test('a clean, green, comment-free PR is healthy', () => {
  const h = prHealth(pr({ mergeableState: 'clean', mergeable: true }));
  assert.equal(h.blocked, false);
  assert.deepEqual(h.reasons, []);
});

test('a dirty PR is conflicted, blocked, and needs a base update', () => {
  const p = pr({ mergeableState: 'dirty', mergeable: false });
  assert.equal(isConflicted(p), true);
  assert.equal(needsBaseUpdate(p), true);
  assert.deepEqual(prHealth(p).reasons, ['merge conflicts']);
});

test('unknown state + mergeable:false falls back to conflicted', () => {
  const p = pr({ mergeableState: 'unknown', mergeable: false });
  assert.equal(isConflicted(p), true);
  assert.equal(needsBaseUpdate(p), true);
});

test('behind base is a clean update, not a conflict', () => {
  const p = pr({ mergeableState: 'behind', mergeable: true });
  assert.equal(isConflicted(p), false);
  assert.equal(needsBaseUpdate(p), true);
  assert.deepEqual(prHealth(p).reasons, ['behind base branch']);
});

test('blocked is surfaced but never auto-acted', () => {
  const p = pr({ mergeableState: 'blocked', mergeable: true });
  assert.equal(needsBaseUpdate(p), false);
  assert.deepEqual(prHealth(p).reasons, ['merge blocked (required checks/reviews)']);
});

test('health folds CI, conflicts and comments together', () => {
  const p = pr({
    ciStatus: 'failing',
    mergeableState: 'dirty',
    mergeable: false,
    unresolvedComments: [{ id: 'c1', author: 'bob', body: 'x', handled: false }],
  });
  assert.deepEqual(prHealth(p).reasons, ['CI failing', 'merge conflicts', '1 unresolved comment']);
  assert.equal(prHealth(p).blocked, true);
});

test('a merged PR is done, never blocked, never needs an update', () => {
  const p = pr({ merged: true, mergeableState: 'dirty', mergeable: false });
  assert.equal(prHealth(p).blocked, false);
  assert.equal(needsBaseUpdate(p), false);
  assert.equal(isConflicted(p), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test test/prHealth.test.ts`
Expected: FAIL — cannot find `../src/prHealth.js`.

- [ ] **Step 3: Implement `src/prHealth.ts`:**

```ts
import type { PullRequest } from './types.js';

export interface PrHealth {
  /** True when the PR can't progress on its own and needs work or attention. */
  blocked: boolean;
  /** Human-readable reasons, most actionable first. Empty when healthy. */
  reasons: string[];
}

/**
 * Fold a PR's signals into one health verdict for the cockpit: *why* is this PR
 * stuck? Pure and deterministic — the snapshot computes it per PR and the UI
 * renders `reasons`. A merged PR is done, so it is never blocked.
 */
export function prHealth(pr: PullRequest): PrHealth {
  const reasons: string[] = [];
  if (pr.merged) return { blocked: false, reasons };

  if (pr.ciStatus === 'failing') reasons.push('CI failing');

  if (isConflicted(pr)) reasons.push('merge conflicts');
  else if (pr.mergeableState === 'behind') reasons.push('behind base branch');
  else if (pr.mergeableState === 'blocked') reasons.push('merge blocked (required checks/reviews)');

  const open = pr.unresolvedComments.filter((c) => !c.handled).length;
  if (open > 0) reasons.push(`${open} unresolved comment${open === 1 ? '' : 's'}`);

  return { blocked: reasons.length > 0, reasons };
}

/**
 * A real merge conflict: GitHub says 'dirty', or — when it hasn't reported a
 * state — the tri-state `mergeable` is a firm false. Merged PRs are never conflicted.
 */
export function isConflicted(pr: PullRequest): boolean {
  if (pr.merged) return false;
  if (pr.mergeableState === 'dirty') return true;
  const unknownState = pr.mergeableState === undefined || pr.mergeableState === 'unknown';
  return unknownState && pr.mergeable === false;
}

/** The PR needs its base branch merged in: a conflict to resolve, or simply behind. */
export function needsBaseUpdate(pr: PullRequest): boolean {
  if (pr.merged) return false;
  return isConflicted(pr) || pr.mergeableState === 'behind';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/prHealth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prHealth.ts test/prHealth.test.ts
git commit -m "Add pure prHealth + conflict/behind predicates"
```

---

### Task 4: Conflict/behind dispatch rule + merge-state-aware merge guard

**Files:**
- Modify: `src/dispatcher/ruleDispatcher.ts`
- Test: `test/ruleDispatcher.test.ts`

This task adds the conflict/behind concern to the PR block **for the no-existing-agent path only** (dispatch), plus refines the merge guard. Task 5 layers the notify-vs-dispatch branch logic on top. To avoid a half-built PR block, implement the full per-branch structure now but keep the running-agent branch minimal (Task 5 fills its test coverage).

**Interfaces:**
- Consumes: `needsBaseUpdate` from `src/prHealth.js`.
- Produces: conflict origin `pr:<n>:mergeable`; merge guard additionally requires `mergeableState` ∉ {dirty, behind, blocked}.

- [ ] **Step 1: Write the failing tests** in `test/ruleDispatcher.test.ts`:

```ts
test('a dirty PR is dispatched to a code agent to resolve conflicts', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        { id: 'p', number: 42, title: 'X', branch: 'feat', baseBranch: 'main',
          ciStatus: 'passing', unresolvedComments: [], mergeable: false, mergeableState: 'dirty' },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'dispatch_code_agent');
  assert.equal((actions[0] as { originRef: string }).originRef, 'pr:42:mergeable');
  assert.match((actions[0] as { prompt: string }).prompt, /resolve the conflicts/i);
});

test('a behind PR gets a clean base-update dispatch, not conflict framing', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        { id: 'p', number: 42, title: 'X', branch: 'feat', baseBranch: 'main',
          ciStatus: 'passing', unresolvedComments: [], mergeable: true, mergeableState: 'behind' },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'dispatch_code_agent');
  assert.equal((actions[0] as { originRef: string }).originRef, 'pr:42:mergeable');
  assert.match((actions[0] as { prompt: string }).prompt, /up to date/i);
  assert.doesNotMatch((actions[0] as { prompt: string }).prompt, /conflict/i);
});

test('a blocked PR is not auto-acted (surfaced only)', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        { id: 'p', number: 42, title: 'X', branch: 'feat', baseBranch: 'main',
          ciStatus: 'passing', unresolvedComments: [], approved: true, mergeable: true, mergeableState: 'blocked' },
      ],
    }),
  );
  assert.equal(actions[0]?.type, 'no_op');
});

test('a behind but otherwise-ready PR is updated, not merged', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx({
      pullRequests: [
        { id: 'p', number: 42, title: 'X', branch: 'feat', baseBranch: 'main',
          ciStatus: 'passing', unresolvedComments: [], approved: true, mergeable: true, mergeableState: 'behind' },
      ],
    }),
  );
  assert.ok(!actions.some((a) => a.type === 'merge_pr'), 'behind PR must not merge yet');
  assert.equal(actions[0]?.type, 'dispatch_code_agent');
});

test('a conflicted PR is dispatched ahead of a new issue under headroom 1', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx(
      {
        pullRequests: [
          { id: 'p', number: 42, title: 'X', branch: 'feat', baseBranch: 'main',
            ciStatus: 'passing', unresolvedComments: [], mergeable: false, mergeableState: 'dirty' },
        ],
        issues: [
          { id: 'i', number: 9, title: 'Bug', body: 'b', labels: [], state: 'open', linkedPrNumber: null },
        ],
      },
      { agentHeadroom: 1 },
    ),
  );
  const dispatches = actions.filter((a) => a.type.startsWith('dispatch_'));
  assert.equal(dispatches.length, 1);
  assert.equal((dispatches[0] as { originRef: string }).originRef, 'pr:42:mergeable');
});
```

Also confirm the existing `a green, approved, mergeable PR yields a merge_pr action` test still passes — those literals omit `mergeableState` (undefined), which the refined guard allows.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test test/ruleDispatcher.test.ts`
Expected: FAIL — conflict PR produces `no_op`; behind PR produces `merge_pr`.

- [ ] **Step 3: Refactor the PR block** in `src/dispatcher/ruleDispatcher.ts`. Add imports at top:

```ts
import { needsBaseUpdate } from '../prHealth.js';
import type { Agent, Decision, Task } from '../types.js';
```

  (Replace the existing `import type { Task } ...` line.) Replace the entire `// 1 & 2: React to PR signals first …` loop (the `for (const pr of ctx.world.pullRequests) { … }` block, up to but not including the `// 4:` issue loop) with:

```ts
    // 1–3: React to PR signals first — they're time-sensitive. At most one code
    // agent works a given branch, so a fresh signal for a branch that already
    // has a running agent is delivered to it (Task 5), never a second dispatch.
    for (const pr of ctx.world.pullRequests) {
      if (pr.merged) continue; // a merged PR is done — never act on it.

      // Every concern that would, on its own, warrant a code agent on this branch,
      // ordered by urgency: CI > base-update > review comments.
      const concerns: PrConcern[] = [];
      if (pr.ciStatus === 'failing') {
        concerns.push({
          origin: `pr:${pr.number}:ci`,
          title: `Fix failing CI on PR #${pr.number}`,
          prompt: `CI is failing on PR #${pr.number} ("${pr.title}", branch ${pr.branch}). Investigate the failure and push a fix.`,
          dispatchReason: `PR #${pr.number} has failing CI and no agent is on it.`,
          note: `CI is now failing on PR #${pr.number} — investigate and push a fix.`,
        });
      }
      if (needsBaseUpdate(pr)) {
        const base = pr.baseBranch ?? 'main';
        const behind = pr.mergeableState === 'behind';
        concerns.push({
          origin: `pr:${pr.number}:mergeable`,
          title: behind ? `Update PR #${pr.number} with ${base}` : `Resolve merge conflicts on PR #${pr.number}`,
          prompt: behind
            ? `PR #${pr.number} ("${pr.title}") is behind its base branch ${base}. Merge ${base} into ${pr.branch} to bring it up to date, then push. No conflicts are expected — this is a routine update.`
            : `PR #${pr.number} ("${pr.title}") has merge conflicts with its base branch ${base}. Merge ${base} into ${pr.branch}, resolve the conflicts, and push. If you cannot resolve them cleanly, escalate for a human.`,
          dispatchReason: behind
            ? `PR #${pr.number} is behind ${base} and no agent is on it.`
            : `PR #${pr.number} has merge conflicts with ${base} and no agent is on it.`,
          note: behind
            ? `PR #${pr.number} is now behind ${base} — merge ${base} in to bring it up to date, then push.`
            : `The base branch ${base} now conflicts with PR #${pr.number} — merge ${base} in, resolve the conflicts, and push.`,
        });
      }
      for (const comment of pr.unresolvedComments) {
        if (comment.handled) continue;
        concerns.push({
          origin: `pr:${pr.number}:comment:${comment.id}`,
          title: `Address review comment on PR #${pr.number}`,
          prompt: `A reviewer commented on PR #${pr.number} (branch ${pr.branch}):\n\n"${comment.body}"\n\nDecide whether to fix the code or defend the current approach. If defending, prepare a concise reply.`,
          dispatchReason: `Unhandled review comment from ${comment.author} on PR #${pr.number}.`,
          note: `New review comment from ${comment.author} on PR #${pr.number}: "${comment.body}" — address it or prepare a reply.`,
        });
      }

      if (concerns.length > 0) {
        const branch = resolveBranchAgent(ctx, pr.branch);
        if (branch.kind === 'running') {
          // A running agent already owns this branch — notify it, don't duplicate.
          const fresh = concerns.filter(
            (c) => !activeOrigins.has(c.origin) && !notified.has(`${branch.agent.id}::${c.origin}`),
          );
          if (fresh.length > 0) {
            raw.push({
              type: 'respond_to_agent',
              agentId: branch.agent.id,
              response:
                `An update on the branch you're working (PR #${pr.number}):\n` +
                fresh.map((c) => `- ${c.note}`).join('\n'),
              originRefs: fresh.map((c) => c.origin),
              reason: `New PR signal(s) for a branch already staffed by agent ${branch.agent.id}.`,
            } satisfies RawAction);
          }
        } else if (branch.kind === 'free') {
          // No agent on this branch — dispatch one for the most urgent concern.
          const top = concerns[0]!;
          if (canDispatch(top.origin)) {
            raw.push({
              type: 'dispatch_code_agent',
              branch: pr.branch,
              title: top.title,
              prompt: top.prompt,
              originRef: top.origin,
              reason: top.dispatchReason,
            } satisfies RawAction);
            claim(top.origin);
          }
        }
        // branch.kind === 'busy' (starting / queued / parked waiting): hold every
        // note. Injecting into a waiting agent would un-park a human escalation;
        // a starting agent has no live session yet. The signals persist, so a
        // later cycle delivers them once the agent is running.
      }

      // Drive a settled PR the last mile — merge it in. `merge_pr` isn't an agent
      // dispatch (claims no headroom); the executor's auto-send gate decides
      // whether to merge autonomously or escalate. A 'behind'/'blocked'/'dirty'
      // state is handled above, so it never counts as merge-ready here.
      const mergeReady =
        pr.ciStatus === 'passing' &&
        pr.approved === true &&
        pr.mergeable === true &&
        pr.mergeableState !== 'behind' &&
        pr.mergeableState !== 'blocked' &&
        pr.mergeableState !== 'dirty' &&
        pr.unresolvedComments.every((c) => c.handled);
      if (mergeReady) {
        raw.push({
          type: 'merge_pr',
          prNumber: pr.number,
          method: 'squash',
          confidence: 0.9,
          reason: `PR #${pr.number} is green, approved and mergeable; merge it in.`,
        } satisfies RawAction);
      }
    }
```

  Immediately after `let headroom = ctx.agentHeadroom;` and the `canDispatch`/`claim` closures, add the notify-dedup set (used above; fully exercised in Task 5):

```ts
    // Origins we've already told a live agent about (from the audit log), so a
    // persistent signal isn't re-notified every cycle. Best-effort over the recent
    // decision window — see Task 5.
    const notified = notifiedOriginsByAgent(ctx.recentDecisions);
```

  Add the concern type + helpers near `type RawAction`:

```ts
interface PrConcern {
  origin: string;
  title: string;
  prompt: string;
  dispatchReason: string;
  note: string;
}

/** The agent state of a PR's branch: a running agent to notify, busy (hold), or free (dispatch). */
type BranchAgent = { kind: 'running'; agent: Agent } | { kind: 'busy' } | { kind: 'free' };

function resolveBranchAgent(ctx: DispatchContext, branch: string): BranchAgent {
  const task = ctx.tasks.find((t) => isActive(t) && t.branch === branch);
  if (!task) return { kind: 'free' };
  const agent = task.agentId ? ctx.agents.find((a) => a.id === task.agentId) : undefined;
  if (agent && agent.status === 'running') return { kind: 'running', agent };
  return { kind: 'busy' }; // queued / starting / waiting — hold new notes.
}

/** Agent+origin pairs we've already notified, from executed respond_to_agent decisions. */
function notifiedOriginsByAgent(decisions: Decision[]): Set<string> {
  const set = new Set<string>();
  for (const d of decisions) {
    if (d.outcome !== 'executed') continue;
    const a = d.action;
    if (a.type !== 'respond_to_agent') continue;
    const agentId = a.agentId;
    const origins = a.originRefs;
    if (typeof agentId !== 'string' || !Array.isArray(origins)) continue;
    for (const o of origins) if (typeof o === 'string') set.add(`${agentId}::${o}`);
  }
  return set;
}
```

  > Note: `ctx.recentDecisions` and `originRefs` don't exist yet — they're added in Task 5. To keep this task green in isolation, Task 5's Step 1 (add `recentDecisions` to `DispatchContext` + the test `ctx` default) and Step 2 (add `originRefs` to the schema) may be done first if the compiler complains. If executing strictly task-by-task, do Task 5 Steps 1–2 immediately before this step. Update the class doc comment block (lines ~6–21) to mention rule "2b: base out-of-date (conflict/behind) → resolve" and the one-agent-per-branch rule.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test test/ruleDispatcher.test.ts test/prHealth.test.ts`
Expected: PASS (new + all existing dispatcher tests).

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher/ruleDispatcher.ts test/ruleDispatcher.test.ts
git commit -m "Dispatch conflict/behind PRs; keep behind/blocked out of merge"
```

---

### Task 5: One agent per branch — notify running, hold waiting, debounce

**Files:**
- Modify: `src/dispatcher/dispatcher.ts` (`DispatchContext.recentDecisions`)
- Modify: `src/dispatcher/actions.ts` (`respond_to_agent.originRefs`)
- Modify: `src/harness.ts` (pass `recentDecisions`)
- Modify: `test/ruleDispatcher.test.ts` (ctx default)
- Test: `test/ruleDispatcher.test.ts` (pure) + `test/conflictLoop.test.ts` (full seam)

**Interfaces:**
- Consumes: `Decision` from `src/types.js`.
- Produces: `DispatchContext.recentDecisions: Decision[]`; `respond_to_agent` action gains optional `originRefs: string[]`.

- [ ] **Step 1: Add `recentDecisions` to the context.** In `src/dispatcher/dispatcher.ts`, import `Decision`: change the import to `import type { Agent, Decision, Escalation, Task, WorldSnapshot } from '../types.js';` and add to `DispatchContext`:

```ts
  /** Recent audit decisions, so the dispatcher won't re-notify an agent about the same signal each cycle. */
  recentDecisions: Decision[];
```

  In `test/ruleDispatcher.test.ts`'s `ctx(...)` helper, add `recentDecisions: []` to the defaults object (before `...over`).

- [ ] **Step 2: Add `originRefs` to the schema.** In `src/dispatcher/actions.ts`, in the `respond_to_agent` object add before `...base`:

```ts
    /** The PR concern origins this note covers, for the audit log + notify de-dup. */
    originRefs: z.array(z.string()).optional(),
```

- [ ] **Step 3: Wire the harness.** In `src/harness.ts`, after `const agents = store.listAgents();` add `const recentDecisions = store.listDecisions(200);`, and add `recentDecisions,` to the `dispatcher.decide({ … })` object.

- [ ] **Step 4: Write the failing pure-dispatcher tests** in `test/ruleDispatcher.test.ts`:

```ts
const runningAgent = (id: string) => ({
  id, taskId: 't', status: 'running' as const, cwd: '/tmp', pid: 1,
  waitingReason: null, startedAt: 'n', endedAt: null,
});
const branchTask = (branch: string, originRef: string, agentId: string) => ({
  id: 't1', kind: 'code' as const, title: 'x', prompt: 'x', branch, originRef,
  status: 'running' as const, agentId, createdAt: 'n', updatedAt: 'n',
});

test('a fresh concern on a running branch notifies the agent, not a second dispatch', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx(
      {
        pullRequests: [
          { id: 'p', number: 42, title: 'X', branch: 'feat', baseBranch: 'main',
            ciStatus: 'failing', unresolvedComments: [], mergeable: false, mergeableState: 'dirty' },
        ],
      },
      {
        // agent is on the branch working the CI concern; the conflict is new.
        tasks: [branchTask('feat', 'pr:42:ci', 'ag1')],
        agents: [runningAgent('ag1')],
      },
    ),
  );
  assert.ok(!actions.some((a) => a.type.startsWith('dispatch_')), 'must not dispatch a second agent');
  const note = actions.find((a) => a.type === 'respond_to_agent');
  assert.ok(note, 'expected a respond_to_agent note');
  assert.equal((note as { agentId: string }).agentId, 'ag1');
  assert.deepEqual((note as { originRefs: string[] }).originRefs, ['pr:42:mergeable']);
  assert.match((note as { response: string }).response, /conflict/i);
});

test('a concern on a waiting branch is held (no note, no dispatch)', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx(
      {
        pullRequests: [
          { id: 'p', number: 42, title: 'X', branch: 'feat', baseBranch: 'main',
            ciStatus: 'passing', unresolvedComments: [], mergeable: false, mergeableState: 'dirty' },
        ],
      },
      {
        tasks: [branchTask('feat', 'pr:42:ci', 'ag1')],
        agents: [{ ...runningAgent('ag1'), status: 'waiting', waitingReason: 'need input' }],
      },
    ),
  );
  assert.equal(actions[0]?.type, 'no_op', 'held: nothing injected while the agent is parked');
});

test('an already-notified concern is not re-notified', async () => {
  const d = new RuleDispatcher();
  const { actions } = await d.decide(
    ctx(
      {
        pullRequests: [
          { id: 'p', number: 42, title: 'X', branch: 'feat', baseBranch: 'main',
            ciStatus: 'passing', unresolvedComments: [], mergeable: false, mergeableState: 'dirty' },
        ],
      },
      {
        tasks: [branchTask('feat', 'pr:42:ci', 'ag1')],
        agents: [runningAgent('ag1')],
        recentDecisions: [
          { id: 'd1', cycleId: 'c', outcome: 'executed', detail: '', createdAt: 'n',
            action: { type: 'respond_to_agent', reason: 'r', agentId: 'ag1', originRefs: ['pr:42:mergeable'] } },
        ],
      },
    ),
  );
  assert.equal(actions[0]?.type, 'no_op', 'already told this agent about pr:42:mergeable');
});
```

- [ ] **Step 5: Run the tests to verify the first two pass and the third fails or all fail appropriately**

Run: `npx tsx --test test/ruleDispatcher.test.ts`
Expected: with Task 4's implementation already using `notified`/`resolveBranchAgent`, the notify + hold tests should pass and the debounce test should pass once `recentDecisions`/`originRefs` are wired (Steps 1–3). If Steps 1–3 were deferred, do them now, then re-run — expected: PASS.

- [ ] **Step 6: Write the full-loop seam test** `test/conflictLoop.test.ts` (drives `buildSystem` with fakes; mirrors `test/integration.test.ts` for how it spawns/queries agents — copy that file's `buildSystem` + `FakePtyBackend` setup and its helper for advancing an agent to `running`/`waiting`; match the real helper names in that file):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  return loadConfig({
    dbPath: ':memory:', dispatcher: 'rule',
    deskRoot: join(dir, 'desk'), worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
  });
}

test('a conflicted PR dispatches a resolve-conflicts code agent', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', baseBranch: 'main' });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 42, mergeable: false, mergeableState: 'dirty' });
  await system.harness.runCycle('manual');

  const task = system.store.listTasks().find((t) => t.originRef === 'pr:42:mergeable');
  assert.ok(task, 'a conflict-resolution task should exist');
  assert.equal(task!.branch, 'feat');
  assert.match(task!.prompt, /resolve the conflicts/i);
  system.store.close();
});

test('a second concern on a running branch notifies the live agent, not a duplicate', async () => {
  const system = buildSystem(testConfig(), { backend: new FakePtyBackend() });
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', baseBranch: 'main' });
  system.connector.inject({ kind: 'ci_failed', prNumber: 42 });
  await system.harness.runCycle('manual'); // dispatches the CI agent

  const agent = system.store.listAgentsByStatus('starting', 'running')[0]!;
  system.store.updateAgent(agent.id, { status: 'running' }); // agent is now live
  // A conflict arrives while the CI agent works the branch.
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 42, mergeable: false, mergeableState: 'dirty' });
  await system.harness.runCycle('manual');

  const codeTasks = system.store.listTasks().filter((t) => t.branch === 'feat');
  assert.equal(codeTasks.length, 1, 'still exactly one agent/task on the branch');
  const backend = system.__backend as FakePtyBackend; // if exposed; else assert via decision log
  // The note was typed into the live agent's session:
  const notified = system.store.listDecisions().find(
    (d) => d.action.type === 'respond_to_agent' && d.outcome === 'executed',
  );
  assert.ok(notified, 'the conflict should be delivered to the running agent');
  system.store.close();
});
```

  Adjust the "agent is now live" mechanic to however `test/integration.test.ts` drives the `FakePtyBackend` to a running state (`.last().emit(...)`), rather than poking the store directly, if that's the established pattern. Prefer the established pattern.

- [ ] **Step 7: Run the seam tests to verify they pass**

Run: `npx tsx --test test/conflictLoop.test.ts`
Expected: PASS. Debug against `test/integration.test.ts` if the agent-liveness mechanic differs.

- [ ] **Step 8: Full check**

Run: `npm run check`
Expected: PASS (format, lint, both typecheckers, knip, all tests). `knip` will flag `prHealth`/`isConflicted`/`normalizeMergeState` if unused — `prHealth` is imported in Task 6; `needsBaseUpdate` in Task 4; `isConflicted` is used by `prHealth`+tests; `normalizeMergeState` by sourceControl+tests.

- [ ] **Step 9: Commit**

```bash
git add src/dispatcher/dispatcher.ts src/dispatcher/actions.ts src/harness.ts test/
git commit -m "One code agent per PR branch: notify running, hold waiting, debounce"
```

---

### Task 6: Surface PR health in the snapshot + cockpit

**Files:**
- Modify: `src/server/app.ts` (`buildStateSnapshot` adds `health` per PR)
- Modify: `web/src/types.ts` (`PullRequest.baseBranch/mergeableState/health`)
- Modify: `web/src/App.tsx` (`WorldSummary` health badge)
- Modify: `web/src/components/Vitals.tsx` (a "Conflicts" vital)
- Modify: `web/src/components/InjectPanel.tsx` (a "Conflict" inject button)
- Test: `test/state.test.ts` (or extend an existing app/state test — confirm which file exercises `buildStateSnapshot`/`/api/state`)

**Interfaces:**
- Consumes: `prHealth` from `src/prHealth.js`.
- Produces: `/api/state` `world.pullRequests[i].health: { blocked: boolean; reasons: string[] }`.

- [ ] **Step 1: Write the failing snapshot test.** Add to the appropriate server/state test file (search for a test importing `buildStateSnapshot` or hitting `/api/state`; if none, create `test/state.test.ts`):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildStateSnapshot } from '../src/server/app.js';

test('the state snapshot reports per-PR health', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-'));
  const system = buildSystem(
    loadConfig({ dbPath: ':memory:', dispatcher: 'rule', deskRoot: join(dir, 'd'), worktreeRoot: join(dir, 'w') }),
    { backend: new FakePtyBackend() },
  );
  system.connector.inject({ kind: 'new_pr', number: 42, title: 'X', branch: 'feat', baseBranch: 'main' });
  system.connector.inject({ kind: 'pr_mergeable', prNumber: 42, mergeable: false, mergeableState: 'dirty' });

  const snap = await buildStateSnapshot(system);
  const pr = snap.world.pullRequests[0]!;
  assert.deepEqual(pr.health, { blocked: true, reasons: ['merge conflicts'] });
  system.store.close();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test test/state.test.ts`
Expected: FAIL — `pr.health` undefined.

- [ ] **Step 3: Implement in `src/server/app.ts`.** Add `import { prHealth } from '../prHealth.js';`. In `buildStateSnapshot`, replace `world,` in the returned object with a health-augmented world:

```ts
    world: {
      ...world,
      pullRequests: world.pullRequests.map((pr) => ({ ...pr, health: prHealth(pr) })),
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test test/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the web types** in `web/src/types.ts`, inside `PullRequest`:

```ts
  baseBranch?: string;
  mergeableState?: string;
  health?: { blocked: boolean; reasons: string[] };
```

- [ ] **Step 6: Render health** in `web/src/App.tsx` `WorldSummary`. Replace the merged/merge-ready chip block for a PR with one that also shows blocked reasons:

```tsx
          {pr.merged ? (
            <span className="chip small">merged</span>
          ) : pr.health?.blocked ? (
            <span className="chip small warn" title={pr.health.reasons.join(', ')}>
              {pr.health.reasons[0]}
              {pr.health.reasons.length > 1 ? ` +${pr.health.reasons.length - 1}` : ''}
            </span>
          ) : (
            pr.ciStatus === 'passing' &&
            pr.approved &&
            pr.mergeable && <span className="chip small warn">merge-ready</span>
          )}
```

  (Keep the existing unresolved-comment chip line above it as-is.)

- [ ] **Step 7: Add a "Conflicts" vital** in `web/src/components/Vitals.tsx`. After `redPrs`:

```ts
  const conflicted = state.world.pullRequests.filter(
    (p) => !p.merged && (p.mergeableState === 'dirty' || p.mergeableState === 'behind'),
  ).length;
```

  And an item after the `CI red` item:

```ts
    { label: 'Conflicts', value: conflicted, tone: conflicted ? 'urgent' : undefined, hint: 'PRs behind / conflicting with base' },
```

- [ ] **Step 8: Add an inject button** in `web/src/components/InjectPanel.tsx`, after the "Mergeable" button:

```tsx
      <button
        className="btn"
        disabled={busy}
        onClick={() => inject({ kind: 'pr_mergeable', prNumber: firstPr, mergeable: false, mergeableState: 'dirty' })}
      >
        Conflict #{firstPr}
      </button>
```

- [ ] **Step 9: Verify both typecheckers + build**

Run: `npm run typecheck && npm run typecheck:web && npm run web:build`
Expected: PASS. Then `npx tsx --test test/state.test.ts` PASS.

- [ ] **Step 10: Commit**

```bash
git add src/server/app.ts web/ test/state.test.ts
git commit -m "Surface per-PR health in /api/state and the cockpit"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/` spec if a PR-monitoring/dispatcher spec exists (search `docs/` for the existing dispatcher/PR docs updated in commit 9d77459).

- [ ] **Step 1: Update `README.md`** — in the PR-monitoring / dispatcher section, document: the conflict/behind resolution rule (pull base branch in, resolve, push; behind = clean update); the new `baseBranch`/`mergeableState` PR fields and their source; the one-agent-per-branch notify-vs-dispatch behaviour (and the hold-while-waiting rule); and the per-PR health indicator shown in the cockpit + `/api/state`.

- [ ] **Step 2: Update `CLAUDE.md`** — under the GitHub provider / dispatcher notes: mention that `mergeable_state` + `base.ref` now map through the `GitHubApi` seam (extend the interface + its fake together), that `prHealth`/`needsBaseUpdate`/`isConflicted` are pure functions in `src/prHealth.ts`, and that PR rules keep one agent per branch by emitting `respond_to_agent` (deduped via `recentDecisions`) instead of a second dispatch — held while the branch's agent is `waiting`.

- [ ] **Step 3: Full check + commit**

```bash
npm run check
git add README.md CLAUDE.md docs/
git commit -m "Document conflict resolution, PR health, and one-agent-per-branch"
```

---

## Self-Review notes

- **Acceptance criteria coverage:** dirty→dispatch (T4); behind→clean update (T4); conflict before new issue under headroom (T4); one agent per branch / notify running (T5); hold waiting then deliver later (T5 pure + seam); `mergeableState`+`baseBranch` mapped + on fake, whole loop at `buildSystem` seam (T1,T2,T5,T6); `prHealth` pure + in `/api/state` + cockpit (T3,T6); merged PR never targeted (T4 `continue` + T3 tests); tests for all four behaviours (T4/T5); docs (T7).
- **Blocked-state open question:** resolved as "flag in `prHealth`, don't auto-act" (non-goal honoured) — merge guard excludes `blocked`, `needsBaseUpdate` excludes `blocked`.
- **Note-idempotency open question:** debounced per `(agentId, origin)` via `recentDecisions` (best-effort over the recent window) — documented as such.
- **Base-drift open question:** one attempt per poll; a later poll re-notifies/re-dispatches naturally. No extra machinery.
- **Type consistency:** `needsBaseUpdate`/`isConflicted`/`prHealth`/`normalizeMergeState`/`MergeableState`/`recentDecisions`/`originRefs` names are used identically across tasks.
