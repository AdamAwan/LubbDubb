# Azure Branch-Policy Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every actionable Azure DevOps branch-policy evaluation visible to the per-check CI policy (`ci.checks`), without any of it being able to falsely report a PR as unable to merge.

**Architecture:** Four layers, in order. (1) The Azure REST mapper learns to name every policy, fixing a live bug where two required builds are invisible. (2) A pure `PolicyKind` classifier plus an operator-configured kind→mode map decides which evaluations become `CiCheck`s and which are advisory-only. (3) `CiCheck` gains two optional flags (`blocking`, `advisory`) that are absent-means-old-behaviour, so GitHub, `fake`, and persisted rows are untouched. (4) Rule 1's gate moves off the aggregate `ciStatus` onto a new pure predicate, so a failing Optional check dispatches an agent while `ciStatus` — and therefore `prHealth.blocked` and rule 3's merge test — stays frozen.

**Tech Stack:** TypeScript (ESM, `nodenext`, explicit `.js` import extensions), `node:test` via `tsx`, no new dependencies.

## Global Constraints

- **ESM with explicit `.js` import extensions**, even from `.ts` sources: `import { x } from './y.js';`
- **Comments explain _why_, not _what_** — match the existing terse, high-signal style in the files being edited.
- **knip runs with every rule at `error`.** An exported type or const that nothing outside its file names turns `npm run check` red. Where this plan says "do not export", that is why. The usual fix for a reported symbol is to **drop the `export` keyword**, not delete it.
- **Two typecheckers**: `npm run typecheck` (server) and `npm run typecheck:web` (cockpit) are separate passes. This plan touches `src/types.ts`, which the web bundle has its own copy of (`web/src/types.ts`) — the two are intentionally separate and **`web/src/types.ts` is not modified by this plan**.
- **Prettier is the formatter.** Never hand-format; run `npx prettier --write <files>` on anything you touch.
- **`docs/spec/` is the specification, written as fact.** When behaviour changes, update the spec document that owns it **in the same commit**.
- Single test file: `node --import tsx --test test/<name>.test.ts`. Full gate: `npm run check`.
- On Windows, `npm run check`'s `format:check` stage can report a CRLF false alarm across nearly every file. If that happens, verify the other five stages and the specific tests directly.

## Background: the two defects

Measured against a real PR (`az repos pr policy list --id 31093`):

| # | Policy | Kind | `isBlocking` | `settings.displayName` | Dropped by |
| --- | --- | --- | --- | --- | --- |
| 181 | Build UI | Build | **true** | **null** | the name check |
| 184 | Build-dotnet | Build | **true** | **null** | the name check |
| 192 | Hallway Traffic Light | Build | true | present | — surfaced today |
| 214 | Dotnet Code Format Validation | Build | **false** | present | `!isBlocking` |
| 215 | nxg-build-dotnet-qodana | Build | **false** | **null** | both |
| 227 | Typescript Code Formatter Validation | Build | **false** | present | `!isBlocking` |
| 164 | Comment requirements | Comments | true | null | `typeId` |
| 163 | Work item linking | WorkItems | true | null | `typeId` |
| 165 | Require a merge strategy | MergeStrategy | true | null | `typeId` |
| 47 / 167 | Required / Minimum reviewers | Reviewers | true | null | `typeId` |

**Defect 1 (Task 1):** a build-validation policy carries a name in `settings.displayName` only when an operator typed one. Otherwise the name is in the evaluation's `context.buildDefinitionName`, which the mapper never reads — so `listPolicyCiChecks` skips it as nameless. **Build UI and Build-dotnet, the two required builds, cannot be named in `ci.checks` today.**

**Defect 2 (Tasks 2–5):** Optional (`isBlocking: false`) policies and non-build/status policy types never reach `ciChecks` at all.

Full design rationale: [`docs/superpowers/specs/2026-07-30-azure-branch-policy-checks-design.md`](../specs/2026-07-30-azure-branch-policy-checks-design.md).

## The well-known policy type GUIDs

Copy these verbatim; they are stable across every Azure DevOps organization and were read off live data.

| GUID | Kind |
| --- | --- |
| `0609b952-1397-4640-95ec-e00a01b2c241` | build |
| `cbdc66da-9728-4af8-aada-9a5a32e4a226` | status |
| `c6a1889d-b943-4856-b76f-9e46bb6b0df2` | comments |
| `40e92b44-2fe1-4dd6-b3d8-74a9c21d0c6e` | workItems |
| `fd2167ab-b0be-447a-8ec8-39368250530e` | reviewers (Required reviewers) |
| `fa4e907d-c16b-4a4c-9dfa-4906e5d171dd` | reviewers (Minimum number of reviewers) |
| `fa4e907d-c16b-4a4c-9dfa-4916e5d171ab` | mergeStrategy |

Note the two reviewers GUIDs differ by four characters (`4906e5d171dd` vs `4916e5d171ab`) and one of them is the merge-strategy GUID. Transcribe carefully.

## File structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/integrations/azure/azureDevOpsApi.ts` | seam — `AzPolicyEvaluation` gains `typeName`, `buildDefinitionName?` | 1 |
| `src/integrations/azure/restAzureDevOpsApi.ts` | the only file touching the network — reads the new raw fields, extends the naming chain | 1 |
| `src/integrations/azure/policyKinds.ts` | **new, pure** — the kind vocabulary, the typeId→kind map, the mode vocabulary, defaults, and mode validation | 2 |
| `src/types.ts` | `CiCheck.blocking?`, `CiCheck.advisory?` | 2 |
| `src/integrations/azure/sourceControl.ts` | `listPolicyCiChecks(evals, modes)`; `aggregatePolicyCiStatus` re-expressed over the classifier with unchanged behaviour | 2 |
| `src/config.ts` | `AzureDevOpsConfig.policyChecks`, merge, validation | 3 |
| `src/integrations/registry.ts` | thread `az.policyChecks` into the integration opts | 3 |
| `src/ci/ciPolicy.ts` | advisory checks are filtered before classification; `ciFailureNote` names non-blocking failures | 4 |
| `src/prHealth.ts` | new `ciNeedsAttention`; `inheritedCiFailure` and `failingCheckSuffix` read the new flags | 5 |
| `src/dispatcher/ruleDispatcher.ts` | rule 1 gate reads `ciNeedsAttention` | 5 |
| `src/prAttention.ts` | `ciReading` reads `ciNeedsAttention` | 5 |
| `docs/spec/02,03,07,15` | specification updates, committed with the behaviour | 1–5 |

---

### Task 1: Name every policy

Fixes Defect 1 on its own. A reviewer could accept this and reject everything after it.

**Files:**

- Modify: `src/integrations/azure/azureDevOpsApi.ts` (the `AzPolicyEvaluation` interface, ~line 154)
- Modify: `src/integrations/azure/restAzureDevOpsApi.ts` (`RawPolicyEvaluation` ~line 172, `policyDisplayName` ~line 188, `listPolicyEvaluations` ~line 439)
- Modify: `src/integrations/azure/sourceControl.ts` (`listPolicyCiChecks`, ~line 270 — drop the `!e.displayName` clause)
- Test: `test/azureDevOpsIntegration.test.ts`
- Modify: `docs/spec/15-integrations.md`

**Interfaces:**

- Produces: `AzPolicyEvaluation` gains `typeName: string` and `buildDefinitionName?: string`. `policyDisplayName` becomes an **exported** pure function in `restAzureDevOpsApi.ts` (the repo convention: mapping logic is exported pure and tested directly, with no HTTP — see `isSignInHtml` and `buildOpenWorkItemQuery` in the same file). Every later task's `evalRec` test helper must supply `typeName`.

- [ ] **Step 1: Write the failing tests**

In `test/azureDevOpsIntegration.test.ts`, find the `evalRec` helper (~line 195) and add `typeName` to it, then add the new tests directly below the existing `aggregatePolicyCiStatus` block. Also add `listPolicyCiChecks` to the import list from `../src/integrations/azure/sourceControl.js` at the top of the file.

```ts
function evalRec(over: Partial<AzPolicyEvaluation> = {}): AzPolicyEvaluation {
  return {
    typeId: BUILD_TYPE,
    typeName: 'Build',
    displayName: 'build',
    status: 'approved',
    isBlocking: true,
    isEnabled: true,
    ...over,
  };
}

test('policyDisplayName: a build policy with no settings name falls back to its build definition', () => {
  // The regression this whole task exists for. `settings.displayName` is null for
  // a build-validation policy whose operator never typed one — which on a real
  // repo is most of them, the required builds included — and a nameless check was
  // skipped outright, so `ci.checks` could not reach Build UI or Build-dotnet.
  assert.equal(
    policyDisplayName({
      configuration: { type: { id: BUILD_TYPE, displayName: 'Build' }, settings: {} },
      context: { buildDefinitionName: 'Build-dotnet' },
    }),
    'Build-dotnet',
  );
});

test('policyDisplayName: an operator-typed name still wins over the build definition', () => {
  assert.equal(
    policyDisplayName({
      configuration: { type: { id: BUILD_TYPE, displayName: 'Build' }, settings: { displayName: 'Hallway Traffic Light' } },
      context: { buildDefinitionName: 'hallway-traffic-light' },
    }),
    'Hallway Traffic Light',
  );
});

test('policyDisplayName: a policy with neither falls back to its type name', () => {
  assert.equal(
    policyDisplayName({ configuration: { type: { id: COMMENTS_TYPE, displayName: 'Comment requirements' } } }),
    'Comment requirements',
  );
});

test('listPolicyCiChecks: a failing build is surfaced with its blocking flag', () => {
  const checks = listPolicyCiChecks([evalRec({ displayName: 'Build-dotnet', status: 'rejected' })]);
  assert.deepEqual(checks, [{ name: 'Build-dotnet', status: 'failing', blocking: true }]);
});
```

`policyDisplayName` is imported from `../src/integrations/azure/restAzureDevOpsApi.js` beside the existing `isSignInHtml`. `COMMENTS_TYPE` is `'c6a1889d-b943-4856-b76f-9e46bb6b0df2'` — declare it beside `BUILD_TYPE` now; Task 2 reuses it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/azureDevOpsIntegration.test.ts`

Expected: a TypeScript/type failure on the unknown `typeName` property, or a `listPolicyCiChecks` shape mismatch (it does not yet emit `blocking`). Either is the correct starting failure.

- [ ] **Step 3: Extend the seam**

In `src/integrations/azure/azureDevOpsApi.ts`, add two fields to `AzPolicyEvaluation`, after `displayName`:

```ts
  /**
   * The policy *type*'s own display name ("Build", "Comment requirements",
   * "Work item linking"). Carried because it classifies the evaluation for the
   * operator and is the last-resort name for a policy whose settings carry none.
   */
  typeName: string;
  /**
   * The build definition a build-validation evaluation ran, from its `context`.
   * The real name of most build policies: `settings.displayName` is null unless
   * an operator typed one, and a nameless check cannot be matched by a glob.
   */
  buildDefinitionName?: string;
```

- [ ] **Step 4: Read the new raw fields**

In `src/integrations/azure/restAzureDevOpsApi.ts`, extend `RawPolicyEvaluation`:

```ts
interface RawPolicyEvaluation {
  status?: string | null;
  /** Build-validation evaluations carry the definition they ran here. */
  context?: { buildDefinitionName?: string } | null;
  configuration?: {
    isBlocking?: boolean;
    isEnabled?: boolean;
    type?: { id?: string; displayName?: string };
    /**
     * Policy-type-specific settings. A build-validation policy names itself with
     * `displayName`; a status policy is identified by its `statusGenre`/
     * `statusName` pair, which is what shows on the PR.
     */
    settings?: { displayName?: string; statusName?: string; statusGenre?: string };
  };
}
```

- [ ] **Step 5: Extend the naming chain**

Replace `policyDisplayName` in the same file:

```ts
/**
 * The operator-facing name of a policy, however its type happens to carry one.
 *
 * The `context` and type-name arms are why a nameless policy is no longer
 * skipped downstream: `settings.displayName` is null for every build-validation
 * policy whose operator never typed one — which on a real repo is most of them,
 * including the required builds — leaving the definition name in `context` as
 * the only thing a `ci.checks` glob could ever match.
 */
export function policyDisplayName(e: RawPolicyEvaluation): string {
  const s = e.configuration?.settings;
  if (s?.displayName) return s.displayName;
  if (s?.statusName) return s.statusGenre ? `${s.statusGenre}/${s.statusName}` : s.statusName;
  if (e.context?.buildDefinitionName) return e.context.buildDefinitionName;
  return e.configuration?.type?.displayName ?? '';
}
```

Note: the existing `statusGenre` line uses a `/` separator — preserve it exactly as it is in the file rather than trusting this transcription.

- [ ] **Step 6: Populate the new fields in the mapper**

In `listPolicyEvaluations`, extend the map:

```ts
    return data.value.map((e) => ({
      typeId: e.configuration?.type?.id ?? '',
      typeName: e.configuration?.type?.displayName ?? '',
      displayName: policyDisplayName(e),
      buildDefinitionName: e.context?.buildDefinitionName,
      status: e.status ?? null,
      isBlocking: e.configuration?.isBlocking ?? false,
      isEnabled: e.configuration?.isEnabled ?? false,
    }));
```

- [ ] **Step 7: Emit `blocking` and stop skipping the nameless**

In `src/integrations/azure/sourceControl.ts`, replace `listPolicyCiChecks` (the signature stays single-argument for now; Task 2 adds the modes parameter):

```ts
/**
 * The CI policies {@link aggregatePolicyCiStatus} folds, kept individually so
 * per-check policy can act on *which* one failed.
 *
 * A policy with no name is no longer skipped: `policyDisplayName` now falls back
 * through the build definition name to the policy type's own, so "unnameable"
 * has stopped being a state an evaluation can be in. The clause it replaces
 * existed because a nameless check cannot be matched by a glob and emitting one
 * would let a single empty pattern claim several unrelated checks at once.
 */
export function listPolicyCiChecks(evals: AzPolicyEvaluation[]): CiCheck[] {
  const checks: CiCheck[] = [];
  for (const e of evals) {
    if (!e.isEnabled || !CI_POLICY_TYPES.has(e.typeId)) continue;
    const status = checkStatusOf(e.status);
    if (status) checks.push({ name: e.displayName, status, blocking: e.isBlocking });
  }
  return checks;
}

/** A policy evaluation status as a {@link CiCheck} status, or null for no signal. */
function checkStatusOf(status: string | null): CiCheck['status'] | null {
  if (status === 'rejected' || status === 'broken') return 'failing';
  if (status === 'queued' || status === 'running') return 'pending';
  if (status === 'approved') return 'passing';
  // 'notApplicable' / null contribute no signal, exactly as in the fold.
  return null;
}
```

Leave the `!e.isBlocking` filter **removed** here (it is what surfaces Optional checks) but leave `aggregatePolicyCiStatus` completely untouched in this task — that separation is the whole point of freezing the aggregate.

- [ ] **Step 8: Add `blocking` to `CiCheck`**

In `src/types.ts`, add to the `CiCheck` interface:

```ts
  /**
   * False when the provider says this check does not block completion (an Azure
   * "Optional" branch policy). Absent means blocking, so every provider and
   * persisted row that predates this reads unchanged.
   *
   * Display and briefing only — nothing gates on it. Whether a *check* is
   * blocking and whether the *PR* can merge are different questions, and the
   * second is `ciStatus`'s alone.
   */
  blocking?: boolean;
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --import tsx --test test/azureDevOpsIntegration.test.ts`
Expected: PASS. If other tests in the file fail on the missing `typeName`, they are constructing `AzPolicyEvaluation` literals outside `evalRec` — add `typeName: 'Build'` to each.

Then run the neighbours that read `ciChecks`:

Run: `node --import tsx --test test/ciPolicy.test.ts`
Run: `node --import tsx --test test/prHealth.test.ts`
Expected: PASS (nothing they assert on has changed yet).

- [ ] **Step 10: Update the spec**

In `docs/spec/15-integrations.md`, find the Azure CI-status section and state, as fact, that a policy's operator-facing name resolves through `settings.displayName` → `statusGenre/statusName` → `context.buildDefinitionName` → the policy type's display name, and that individual checks carry `blocking` reflecting Azure's Required/Optional setting while the aggregate `ciStatus` folds blocking policies only.

- [ ] **Step 11: Format and commit**

```bash
npx prettier --write src/integrations/azure/azureDevOpsApi.ts src/integrations/azure/restAzureDevOpsApi.ts src/integrations/azure/sourceControl.ts src/types.ts test/azureDevOpsIntegration.test.ts docs/spec/15-integrations.md
git add -A
git commit -m "azure: name every branch policy, so ci.checks can reach the required builds"
```

---

### Task 2: Policy kinds and check modes

**Files:**

- Create: `src/integrations/azure/policyKinds.ts`
- Modify: `src/integrations/azure/sourceControl.ts` (delete `CI_POLICY_TYPES`, re-express `aggregatePolicyCiStatus`, add the modes parameter to `listPolicyCiChecks`)
- Modify: `src/types.ts` (`CiCheck.advisory?`)
- Test: `test/azureDevOpsIntegration.test.ts`
- Modify: `docs/spec/03-world-model.md`

**Interfaces:**

- Consumes: `AzPolicyEvaluation` with `typeName`/`buildDefinitionName` from Task 1; `CiCheck.blocking` from Task 1.
- Produces:
  - `POLICY_KINDS: readonly PolicyKind[]` and `POLICY_CHECK_MODES: readonly PolicyCheckMode[]` (exported consts)
  - `export type PolicyCheckModes = Partial<Record<PolicyKind, PolicyCheckMode>>`
  - `policyKindOf(typeId: string): PolicyKind`
  - `DEFAULT_POLICY_CHECK_MODES: Record<PolicyKind, PolicyCheckMode>`
  - `policyCheckMode(kind: PolicyKind, modes: PolicyCheckModes | undefined): PolicyCheckMode`
  - `validatePolicyCheckModes(modes: PolicyCheckModes): void`
  - `listPolicyCiChecks(evals: AzPolicyEvaluation[], modes?: PolicyCheckModes): CiCheck[]`
  - **`PolicyKind` and `PolicyCheckMode` are NOT exported** — nothing outside this file names either directly, and knip runs every rule at `error`, so exporting them turns `npm run check` red.

- [ ] **Step 1: Write the failing tests**

In `test/azureDevOpsIntegration.test.ts`, add the remaining type GUIDs beside the existing ones (~line 190) and add the new tests below the ones from Task 1:

`COMMENTS_TYPE` was declared in Task 1 — add only the two below it.

```ts
const WORK_ITEMS_TYPE = '40e92b44-2fe1-4dd6-b3d8-74a9c21d0c6e';
const MERGE_STRATEGY_TYPE = 'fa4e907d-c16b-4a4c-9dfa-4916e5d171ab';

test('listPolicyCiChecks: an Optional build failure is surfaced as a non-blocking check', () => {
  const checks = listPolicyCiChecks([
    evalRec({ displayName: 'Dotnet Code Format Validation', status: 'rejected', isBlocking: false }),
  ]);
  assert.deepEqual(checks, [{ name: 'Dotnet Code Format Validation', status: 'failing', blocking: false }]);
});

test('aggregatePolicyCiStatus: an Optional failure still does not move the aggregate', () => {
  // The decoupling that makes the whole feature safe: an agent may be dispatched
  // for a check that cannot stop the merge, and `ciStatus` must not claim it can.
  assert.equal(aggregatePolicyCiStatus([evalRec({ status: 'rejected', isBlocking: false })]), 'unknown');
});

test('listPolicyCiChecks: the comment policy is advisory under the defaults', () => {
  const checks = listPolicyCiChecks([
    evalRec({ typeId: COMMENTS_TYPE, typeName: 'Comment requirements', displayName: 'Comment requirements', status: 'rejected' }),
  ]);
  assert.deepEqual(checks, [
    { name: 'Comment requirements', status: 'failing', blocking: true, advisory: true },
  ]);
});

test('listPolicyCiChecks: work-item and merge-strategy policies are off under the defaults', () => {
  const checks = listPolicyCiChecks([
    evalRec({ typeId: WORK_ITEMS_TYPE, typeName: 'Work item linking', displayName: 'Work item linking', status: 'rejected' }),
    evalRec({ typeId: MERGE_STRATEGY_TYPE, typeName: 'Require a merge strategy', displayName: 'Require a merge strategy', status: 'rejected' }),
    evalRec({ typeId: REVIEWERS_TYPE, typeName: 'Minimum number of reviewers', displayName: 'Minimum number of reviewers', status: 'rejected' }),
  ]);
  assert.deepEqual(checks, []);
});

test('listPolicyCiChecks: an operator can promote work-item linking to an ordinary check', () => {
  const checks = listPolicyCiChecks(
    [evalRec({ typeId: WORK_ITEMS_TYPE, typeName: 'Work item linking', displayName: 'Work item linking', status: 'rejected' })],
    { workItems: 'check' },
  );
  assert.deepEqual(checks, [{ name: 'Work item linking', status: 'failing', blocking: true }]);
});

test('listPolicyCiChecks: a disabled policy is dropped under every mode', () => {
  assert.deepEqual(listPolicyCiChecks([evalRec({ status: 'rejected', isEnabled: false })], { build: 'check' }), []);
  assert.deepEqual(
    listPolicyCiChecks(
      [evalRec({ typeId: COMMENTS_TYPE, typeName: 'Comment requirements', status: 'rejected', isEnabled: false })],
      { comments: 'advisory' },
    ),
    [],
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/azureDevOpsIntegration.test.ts`
Expected: FAIL — `listPolicyCiChecks` takes one argument and emits nothing for the comment/work-item types.

- [ ] **Step 3: Create the pure policy-kind module**

Create `src/integrations/azure/policyKinds.ts`:

```ts
/**
 * Azure branch-policy *kinds*, and what the harness does with each.
 *
 * The provider used to key on a two-GUID allow-list, which answered one question
 * ("is this an automated check?") and therefore could not express the two the
 * operator actually has: a policy can be worth *seeing* without being worth
 * *dispatching for*, and one the harness will dispatch for is not necessarily one
 * that blocks the merge. So evaluations classify into a kind here, and the
 * operator maps kind → mode.
 *
 * Pure and dependency-free: `config.ts` validates a mode map without importing
 * the provider, and `sourceControl.ts` reads it without importing config.
 */

/**
 * Azure's well-known branch-policy type GUIDs, stable across every organization.
 * Two GUIDs map to `reviewers` ("Required reviewers" and "Minimum number of
 * reviewers"); they differ from each other, and from the merge-strategy GUID, by
 * a few characters — transcribe rather than pattern-match them.
 */
const POLICY_TYPE_KINDS: ReadonlyMap<string, PolicyKind> = new Map([
  ['0609b952-1397-4640-95ec-e00a01b2c241', 'build'],
  ['cbdc66da-9728-4af8-aada-9a5a32e4a226', 'status'],
  ['c6a1889d-b943-4856-b76f-9e46bb6b0df2', 'comments'],
  ['40e92b44-2fe1-4dd6-b3d8-74a9c21d0c6e', 'workItems'],
  ['fd2167ab-b0be-447a-8ec8-39368250530e', 'reviewers'],
  ['fa4e907d-c16b-4a4c-9dfa-4906e5d171dd', 'reviewers'],
  ['fa4e907d-c16b-4a4c-9dfa-4916e5d171ab', 'mergeStrategy'],
] as const);

/** Every kind an evaluation can classify into, so config validation can't drift from the map. */
export const POLICY_KINDS = [
  'build',
  'status',
  'comments',
  'workItems',
  'reviewers',
  'mergeStrategy',
  'other',
] as const;

type PolicyKind = (typeof POLICY_KINDS)[number];

/**
 * How a kind is surfaced.
 * - `check` — an ordinary {@link CiCheck}: visible, routable by a `ci.checks`
 *   rule, dispatchable.
 * - `advisory` — visible and *structurally* unable to dispatch or escalate. The
 *   comment policy's mode, so it can never outrank rule 2b, which holds the same
 *   signal at far higher fidelity (thread ids, authors, bodies).
 * - `off` — not emitted.
 */
export const POLICY_CHECK_MODES = ['check', 'advisory', 'off'] as const;

type PolicyCheckMode = (typeof POLICY_CHECK_MODES)[number];

/** An operator's kind → mode map; absent kinds fall back to {@link DEFAULT_POLICY_CHECK_MODES}. */
export type PolicyCheckModes = Partial<Record<PolicyKind, PolicyCheckMode>>;

/**
 * Conservative by intent. Build and status are the automated checks, Optional
 * ones included — a failing check nobody named still dispatches, which is
 * `ci.checks`' deliberate design and the reason a job added next week gets fixed
 * rather than parking every red PR forever. Comments are advisory: purely
 * additive, since an advisory check changes no dispatch and no aggregate. Work
 * items are off, because promoting them means an agent running `az` writes
 * against a tracker, which is an opt-in.
 */
export const DEFAULT_POLICY_CHECK_MODES: Record<PolicyKind, PolicyCheckMode> = {
  build: 'check',
  status: 'check',
  comments: 'advisory',
  workItems: 'off',
  reviewers: 'off',
  mergeStrategy: 'off',
  other: 'off',
};

/** Which kind a policy type GUID is. An unrecognised type is `other` — never guessed at. */
export function policyKindOf(typeId: string): PolicyKind {
  return POLICY_TYPE_KINDS.get(typeId) ?? 'other';
}

/** The configured mode for a kind, falling back to the default for that kind. */
export function policyCheckMode(kind: PolicyKind, modes: PolicyCheckModes | undefined): PolicyCheckMode {
  return modes?.[kind] ?? DEFAULT_POLICY_CHECK_MODES[kind];
}

/**
 * Reject a mode map that cannot mean what it says, at load rather than at 3am —
 * the same fail-fast discipline as `validateCiPolicy`. A typo'd kind would
 * otherwise be silently ignored and the operator would watch a check they thought
 * they had configured behave as though they had not.
 */
export function validatePolicyCheckModes(modes: PolicyCheckModes): void {
  for (const [kind, mode] of Object.entries(modes)) {
    if (!(POLICY_KINDS as readonly string[]).includes(kind)) {
      throw new Error(
        `azureDevOps.policyChecks: "${kind}" is not a policy kind (${POLICY_KINDS.join(' | ')}).`,
      );
    }
    if (!(POLICY_CHECK_MODES as readonly string[]).includes(mode as string)) {
      throw new Error(
        `azureDevOps.policyChecks.${kind}: "${String(mode)}" is not one of ${POLICY_CHECK_MODES.join(' | ')}.`,
      );
    }
  }
}
```

- [ ] **Step 4: Add `advisory` to `CiCheck`**

In `src/types.ts`, add below `blocking`:

```ts
  /**
   * Reported for visibility only: `classifyCiFailures` never classifies it and
   * `ciNeedsAttention` never counts it, so it cannot dispatch an agent, escalate,
   * or be muted by a `ci.checks` rule.
   *
   * The Azure comment policy's mode. Surfacing it as an ordinary check would let
   * rule 1 outrank rule 2b and send the generic CI-fix prompt in place of one
   * carrying the comment's author and body — the same work with strictly less
   * information. Making that structural rather than configurational means the
   * correct behaviour cannot be lost by forgetting a line of config.
   */
  advisory?: boolean;
```

- [ ] **Step 5: Re-express the provider over the classifier**

In `src/integrations/azure/sourceControl.ts`: delete the `BUILD_POLICY_TYPE` / `STATUS_POLICY_TYPE` / `CI_POLICY_TYPES` constants and their block comment, add the import, and replace both functions.

```ts
import {
  policyCheckMode,
  policyKindOf,
  type PolicyCheckModes,
} from './policyKinds.js';
```

```ts
/**
 * Fold a PR's *branch-policy evaluations* into one {@link CiStatus} — the
 * authoritative "are the required checks passing?" signal.
 *
 * Deliberately frozen: enabled + blocking + build/status only, and no
 * configuration reaches it. `ciStatus` is what `prHealth.blocked` and rule 3's
 * merge test read, so anything an operator can widen must be unable to claim a
 * PR cannot merge when Azure would complete it — or to stop the harness merging
 * one it would. Widening happens in {@link listPolicyCiChecks} instead, and rule
 * 1 reads that.
 *
 * This replaces aggregating the PR *statuses* endpoint, which returns every
 * status ever posted across *all* iterations: one stale `failed` from a
 * superseded push permanently poisoned the PR to `failing`.
 */
export function aggregatePolicyCiStatus(evals: AzPolicyEvaluation[]): CiStatus {
  let failing = false;
  let pending = false;
  let passing = false;

  for (const e of evals) {
    const kind = policyKindOf(e.typeId);
    if (!e.isEnabled || !e.isBlocking || (kind !== 'build' && kind !== 'status')) continue;
    switch (e.status) {
      case 'rejected':
      case 'broken': // the policy errored — it still blocks the merge, so treat it as failing.
        failing = true;
        break;
      case 'queued':
      case 'running':
        pending = true;
        break;
      case 'approved':
        passing = true;
        break;
      // 'notApplicable' / null contribute no signal.
    }
  }

  if (failing) return 'failing';
  if (pending) return 'pending';
  if (passing) return 'passing';
  return 'unknown';
}

/**
 * Every policy evaluation the operator asked to see, kept individually so
 * per-check policy can act on *which* one failed.
 *
 * Wider than the fold above in both directions an operator needs: Optional
 * (`isBlocking: false`) policies are included with `blocking: false`, and the
 * non-CI kinds are included at whatever mode they are configured at. A disabled
 * policy is dropped whatever its mode — its evaluation is stale noise.
 */
export function listPolicyCiChecks(evals: AzPolicyEvaluation[], modes?: PolicyCheckModes): CiCheck[] {
  const checks: CiCheck[] = [];
  for (const e of evals) {
    if (!e.isEnabled) continue;
    const mode = policyCheckMode(policyKindOf(e.typeId), modes);
    if (mode === 'off') continue;
    const status = checkStatusOf(e.status);
    if (!status) continue;
    const check: CiCheck = { name: e.displayName, status, blocking: e.isBlocking };
    if (mode === 'advisory') check.advisory = true;
    checks.push(check);
  }
  return checks;
}

/** A policy evaluation status as a {@link CiCheck} status, or null for no signal. */
function checkStatusOf(status: string | null): CiCheck['status'] | null {
  if (status === 'rejected' || status === 'broken') return 'failing';
  if (status === 'queued' || status === 'running') return 'pending';
  if (status === 'approved') return 'passing';
  // 'notApplicable' / null contribute no signal, exactly as in the fold.
  return null;
}
```

- [ ] **Step 6: Thread the modes through the integration**

In the same file, add to `AzureSourceControlOpts`:

```ts
  /** Which branch-policy kinds become CI checks, and at what mode. Unset = the defaults. */
  policyChecks?: PolicyCheckModes;
```

and in `snapshot()`, change the `ciChecks` line:

```ts
            ciChecks: listPolicyCiChecks(policyEvals, this.opts.policyChecks),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --import tsx --test test/azureDevOpsIntegration.test.ts`
Expected: PASS.

- [ ] **Step 8: Update the spec**

In `docs/spec/03-world-model.md`, extend the `CiCheck` description with `blocking` and `advisory`, stating as fact that an advisory check is never classified by the CI policy and never dispatches, and that `blocking` is display-and-briefing only.

- [ ] **Step 9: Format and commit**

```bash
npx prettier --write src/integrations/azure/policyKinds.ts src/integrations/azure/sourceControl.ts src/types.ts test/azureDevOpsIntegration.test.ts docs/spec/03-world-model.md
git add -A
git commit -m "azure: classify branch policies by kind, with a per-kind surfacing mode"
```

---

### Task 3: The `azureDevOps.policyChecks` config knob

**Files:**

- Modify: `src/config.ts` (`AzureDevOpsConfig` ~line 345, the merge block ~line 503)
- Modify: `src/integrations/registry.ts` (~line 40)
- Test: `test/azureDevOpsIntegration.test.ts`
- Modify: `docs/spec/02-configuration.md`

**Interfaces:**

- Consumes: `PolicyCheckModes`, `validatePolicyCheckModes` from Task 2.
- Produces: `AzureDevOpsConfig.policyChecks?: PolicyCheckModes`, threaded into `AzureDevOpsSourceControlIntegration`'s `policyChecks` opt.

- [ ] **Step 1: Write the failing test**

Add to `test/azureDevOpsIntegration.test.ts`, and add `validatePolicyCheckModes` plus `type PolicyCheckModes` to the imports:

```ts
import { validatePolicyCheckModes, type PolicyCheckModes } from '../src/integrations/azure/policyKinds.js';

test('validatePolicyCheckModes: an unknown kind or mode is refused at load', () => {
  assert.throws(
    () => validatePolicyCheckModes({ builds: 'check' } as unknown as PolicyCheckModes),
    /"builds" is not a policy kind/,
  );
  assert.throws(
    () => validatePolicyCheckModes({ build: 'dispatch' } as unknown as PolicyCheckModes),
    /is not one of check \| advisory \| off/,
  );
  // A valid map passes silently.
  validatePolicyCheckModes({ comments: 'check', workItems: 'off' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/azureDevOpsIntegration.test.ts`
Expected: FAIL — at this point `validatePolicyCheckModes` exists from Task 2, so this test may pass immediately. If it does, that is fine: it is a regression test for a validator written a task earlier, and the failing work in this task is the config wiring. Proceed to Step 3.

- [ ] **Step 3: Add the config field**

In `src/config.ts`, add the import beside the existing `validateCiPolicy` one:

```ts
import { validatePolicyCheckModes, type PolicyCheckModes } from './integrations/azure/policyKinds.js';
```

and add to `AzureDevOpsConfig`, after `filters`:

```ts
  /**
   * Which branch-policy kinds become CI checks, and how.
   *
   * `check` makes a kind an ordinary check — visible, routable by a `ci.checks`
   * rule, dispatchable. `advisory` makes it visible and structurally unable to
   * dispatch. `off` drops it. Unset kinds take the defaults: build and status are
   * `check` (Optional policies included), comments are `advisory`, everything else
   * is `off`.
   *
   * Widening this can never make a PR read as unable to merge: the aggregate
   * `ciStatus` folds blocking build/status policies only and no setting here
   * reaches it.
   */
  policyChecks?: PolicyCheckModes;
```

- [ ] **Step 4: Validate it at load**

In `loadConfig`, immediately after the `validateCiPolicy(merged.ci);` line:

```ts
  if (merged.azureDevOps?.policyChecks) validatePolicyCheckModes(merged.azureDevOps.policyChecks);
```

- [ ] **Step 5: Wire it into the provider**

In `src/integrations/registry.ts`, add one line to the `AzureDevOpsSourceControlIntegration` construction (~line 40):

```ts
      return new AzureDevOpsSourceControlIntegration({
        api,
        store: ctx.store,
        errors: ctx.errors,
        prAuthor: az.filters?.prAuthor,
        policyChecks: az.policyChecks,
        closedPrWindowMs: ctx.config.closedPrWindowMs,
      });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --import tsx --test test/azureDevOpsIntegration.test.ts`
Run: `npm run typecheck`
Expected: PASS both.

- [ ] **Step 7: Update the spec**

In `docs/spec/02-configuration.md`, document `azureDevOps.policyChecks` in the same style as the neighbouring keys: the three modes, the per-kind defaults, and the guarantee that it never reaches `ciStatus`.

- [ ] **Step 8: Format and commit**

```bash
npx prettier --write src/config.ts src/integrations/registry.ts test/azureDevOpsIntegration.test.ts docs/spec/02-configuration.md
git add -A
git commit -m "config: azureDevOps.policyChecks selects which branch-policy kinds become checks"
```

---

### Task 4: The CI policy learns advisory and non-blocking

**Files:**

- Modify: `src/ci/ciPolicy.ts` (`CiMatch` ~line 62, `classifyCiFailures` ~line 133, `ciFailureNote` ~line 187)
- Test: `test/ciPolicy.test.ts`

**Interfaces:**

- Consumes: `CiCheck.blocking` (Task 1), `CiCheck.advisory` (Task 2).
- Produces: `CiMatch` gains `blocking?: boolean`. `classifyCiFailures`' signature is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `test/ciPolicy.test.ts`. Match the file's existing helper style — read the top of the file first and reuse whatever check/policy constructors are already there rather than introducing new ones.

```ts
test('classifyCiFailures: an advisory failing check is never classified', () => {
  const verdict = classifyCiFailures(
    [{ name: 'Comment requirements', status: 'failing', advisory: true }],
    { checks: [] },
  );
  // Not dispatched, not escalated, not muted — it is not the CI policy's business
  // at all. Rule 2b owns the signal it restates.
  assert.deepEqual(verdict.dispatch, []);
  assert.deepEqual(verdict.escalate, []);
  assert.deepEqual(verdict.ignored, []);
});

test('classifyCiFailures: an advisory check cannot be claimed by a ci.checks rule', () => {
  const verdict = classifyCiFailures(
    [{ name: 'Comment requirements', status: 'failing', advisory: true }],
    { checks: [{ match: '*', onFailure: 'escalate' }] },
  );
  assert.deepEqual(verdict.escalate, []);
});

test('classifyCiFailures: an Optional failing check dispatches and records that it is not blocking', () => {
  const verdict = classifyCiFailures(
    [{ name: 'Dotnet Code Format Validation', status: 'failing', blocking: false }],
    { checks: [] },
  );
  assert.equal(verdict.actionable, true);
  assert.deepEqual(
    verdict.dispatch.map((m) => ({ name: m.name, blocking: m.blocking })),
    [{ name: 'Dotnet Code Format Validation', blocking: false }],
  );
});

test('ciFailureNote: a non-blocking failure is named as not holding the merge', () => {
  const verdict = classifyCiFailures(
    [{ name: 'Dotnet Code Format Validation', status: 'failing', blocking: false }],
    { checks: [] },
  );
  const note = ciFailureNote(verdict);
  assert.match(note, /Dotnet Code Format Validation/);
  assert.match(note, /do not block the merge/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/ciPolicy.test.ts`
Expected: FAIL — the advisory check is classified as `dispatch`, `CiMatch` has no `blocking`, and `ciFailureNote` says nothing about blocking.

- [ ] **Step 3: Carry `blocking` on a match**

In `src/ci/ciPolicy.ts`, extend `CiMatch`:

```ts
/** A failing check paired with the rule that claimed it (null = matched nothing). */
interface CiMatch {
  name: string;
  rule: CiCheckRule | null;
  /** False when the provider says this failure does not hold the merge. */
  blocking?: boolean;
}
```

- [ ] **Step 4: Filter advisory checks out before classifying**

In `classifyCiFailures`, change the first line of the body and the per-check construction:

```ts
export function classifyCiFailures(checks: CiCheck[] | undefined, policy: CiPolicy): CiVerdict {
  // Advisory checks are dropped before anything is decided, so no rule — not even
  // `match: '*'` — can claim one. They are reported for visibility and belong to
  // whatever already models the signal (the comment policy's threads are rule 2b's).
  const failing = (checks ?? []).filter((c) => c.status === 'failing' && !c.advisory);
```

and inside the loop:

```ts
    const match: CiMatch = { name: check.name, rule, blocking: check.blocking };
```

Add a sentence to the function's doc comment, below the existing "Two silences" paragraph:

```
 * A third silence is *not* a silence: an advisory check is filtered out above, so
 * a PR whose only failure is advisory classifies into nothing at all. Rule 1 does
 * not fire on it either — `ciNeedsAttention` excludes advisory checks by the same
 * rule — so the two cannot disagree.
```

- [ ] **Step 5: Name non-blocking failures to the agent**

In `ciFailureNote`, insert a block between the `guided` block and the `held` block:

```ts
  const optional = verdict.dispatch.filter((m) => m.blocking === false).map((m) => m.name);
  if (optional.length > 0) {
    lines.push(
      `These failing checks do not block the merge — ${optional.join(', ')}. Fix them anyway; they are ` +
        'reported here so you do not read the pull request being mergeable as your fix having landed.',
    );
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --import tsx --test test/ciPolicy.test.ts`
Expected: PASS.

- [ ] **Step 7: Format and commit**

```bash
npx prettier --write src/ci/ciPolicy.ts test/ciPolicy.test.ts
git add -A
git commit -m "ci policy: advisory checks are never classified, Optional ones are named as such"
```

---

### Task 5: Rule 1's gate moves off the aggregate

The task that actually delivers the feature. Everything before it is plumbing.

**Files:**

- Modify: `src/prHealth.ts` (new `ciNeedsAttention`; `failingCheckSuffix` ~line 64; `inheritedCiFailure` ~line 141)
- Modify: `src/dispatcher/ruleDispatcher.ts` (~line 283)
- Modify: `src/prAttention.ts` (~line 310)
- Test: `test/prHealth.test.ts`, `test/stackedPrs.test.ts`
- Modify: `docs/spec/07-pull-requests.md`

**Interfaces:**

- Consumes: `CiCheck.blocking`, `CiCheck.advisory`.
- Produces: `export function ciNeedsAttention(pr: PullRequest): boolean` in `src/prHealth.ts`, read by exactly three call sites.

- [ ] **Step 1: Write the failing tests**

In `test/prHealth.test.ts` — reuse whatever PR-constructing helper the file already has rather than writing a new one; the literals below are illustrative of the fields that matter:

```ts
test('ciNeedsAttention: true for a PR failing only on a check outside the aggregate', () => {
  const pr = makePr({
    ciStatus: 'passing',
    ciChecks: [{ name: 'Dotnet Code Format Validation', status: 'failing', blocking: false }],
  });
  assert.equal(ciNeedsAttention(pr), true);
});

test('ciNeedsAttention: false when the only failing check is advisory', () => {
  const pr = makePr({
    ciStatus: 'passing',
    ciChecks: [{ name: 'Comment requirements', status: 'failing', blocking: true, advisory: true }],
  });
  assert.equal(ciNeedsAttention(pr), false);
});

test('ciNeedsAttention: true off the aggregate alone, for a provider reporting no per-check detail', () => {
  assert.equal(ciNeedsAttention(makePr({ ciStatus: 'failing' })), true);
});

test('prHealth: an Optional failure alone leaves the PR unblocked', () => {
  const pr = makePr({
    ciStatus: 'passing',
    ciChecks: [{ name: 'Dotnet Code Format Validation', status: 'failing', blocking: false }],
  });
  // `prHealth` answers "can this merge", and Azure would complete this PR.
  assert.deepEqual(prHealth(pr), { blocked: false, reasons: [] });
});

test('prHealth: the failing-check suffix names only checks that hold the merge', () => {
  const pr = makePr({
    ciStatus: 'failing',
    ciChecks: [
      { name: 'Build-dotnet', status: 'failing', blocking: true },
      { name: 'Dotnet Code Format Validation', status: 'failing', blocking: false },
      { name: 'Comment requirements', status: 'failing', blocking: true, advisory: true },
    ],
  });
  assert.deepEqual(prHealth(pr).reasons, ['CI failing: Build-dotnet']);
});
```

In `test/stackedPrs.test.ts` — again reuse the file's existing helpers:

```ts
test('inheritedCiFailure: an Optional failure on the base is attributed, so no agent lands on the child', () => {
  const base = makePr({
    number: 1,
    branch: 'part-one',
    ciStatus: 'passing',
    ciChecks: [{ name: 'Typescript Code Formatter Validation', status: 'failing', blocking: false }],
  });
  const child = makePr({
    number: 2,
    branch: 'part-two',
    baseBranch: 'part-one',
    ciStatus: 'passing',
    ciChecks: [{ name: 'Typescript Code Formatter Validation', status: 'failing', blocking: false }],
  });
  assert.equal(inheritedCiFailure(child, [base, child])?.number, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/prHealth.test.ts`
Run: `node --import tsx --test test/stackedPrs.test.ts`
Expected: FAIL — `ciNeedsAttention` does not exist; `inheritedCiFailure` returns null because it early-returns on the aggregate.

- [ ] **Step 3: Add the predicate**

In `src/prHealth.ts`, add above `inheritedCiFailure`:

```ts
/**
 * Is there a CI failure on this PR the harness should put an agent on?
 *
 * Deliberately *not* `ciStatus === 'failing'`, which is the merge question. A
 * provider can report a check that fails without blocking completion — an Azure
 * Optional branch policy — and the harness should still fix it; folding that into
 * the aggregate instead would claim the PR cannot merge when it can, and would
 * stop rule 3 merging it.
 *
 * The aggregate is still an arm of the test, because a provider that reports no
 * per-check detail at all (and every PR persisted before checks existed) has
 * nothing else to answer from.
 *
 * Advisory checks are excluded here for the same reason `classifyCiFailures`
 * excludes them: they restate a signal something else already owns at higher
 * fidelity, and dispatching on one would outrank the rule that does.
 */
export function ciNeedsAttention(pr: PullRequest): boolean {
  if (pr.ciStatus === 'failing') return true;
  return (pr.ciChecks ?? []).some((c) => c.status === 'failing' && !c.advisory);
}
```

- [ ] **Step 4: Widen `inheritedCiFailure`**

In the same file, change two lines inside `inheritedCiFailure`:

```ts
  if (!ciNeedsAttention(pr)) return null;
```

and, inside the loop:

```ts
    if (ciNeedsAttention(base)) return base;
```

Add to its doc comment, after the existing "Walks the whole chain" paragraph:

```
 * Reads `ciNeedsAttention` rather than the aggregate, so a failure that dispatches
 * without blocking the merge is attributed too — otherwise one red Optional check
 * on a stack's base would put an agent on every PR above it, which is exactly the
 * multiplication this exists to prevent.
```

- [ ] **Step 5: Narrow the health suffix**

In `failingCheckSuffix`, change the filter so the health reason names only checks that actually hold the merge:

```ts
  const failing = (pr.ciChecks ?? [])
    // The health question is "can this merge", so a check that does not block it —
    // and an advisory one, which is not a CI check at all — has no place in the
    // reason. A muted check *does*: the operator telling the harness to leave it
    // alone does not stop Azure holding the PR on it.
    .filter((c) => c.status === 'failing' && !c.advisory && c.blocking !== false)
    .map((c) => c.name);
```

- [ ] **Step 6: Move rule 1's gate**

In `src/dispatcher/ruleDispatcher.ts`, add `ciNeedsAttention` to the existing import from `../prHealth.js`, then change line ~283:

```ts
      const ciFailing = ciNeedsAttention(pr) && inheritedFailure === null;
```

Extend the comment above it (the one beginning "Which checks failed decides what happens"):

```
      // The gate is `ciNeedsAttention`, not the aggregate: a check that fails
      // without blocking completion still wants a fix, and folding it into
      // `ciStatus` would have claimed the PR cannot merge when it can.
```

- [ ] **Step 7: Move the attention lens's gate**

In `src/prAttention.ts`, add `ciNeedsAttention` to the existing import from `./prHealth.js` and change line ~310:

```ts
  if (!ciNeedsAttention(pr) || inheritedCiFailure(pr, ctx.openPrs) !== null) return none;
```

The lens and the rule must read the same predicate or the cockpit tells an operator a PR is nobody's turn while an agent is being dispatched for it.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --import tsx --test test/prHealth.test.ts`
Run: `node --import tsx --test test/stackedPrs.test.ts`
Run: `node --import tsx --test test/prAttention.test.ts`
Run: `node --import tsx --test test/ruleDispatcher.test.ts`
Expected: PASS all four.

- [ ] **Step 9: Update the spec**

In `docs/spec/07-pull-requests.md`, state as fact that rule 1 fires on `ciNeedsAttention` — the aggregate being `failing`, or any non-advisory check failing — while `prHealth.blocked` and rule 3's merge test read `ciStatus` alone, and that a failing check which does not block completion therefore gets an agent without the PR reading as unmergeable.

- [ ] **Step 10: Format and commit**

```bash
npx prettier --write src/prHealth.ts src/dispatcher/ruleDispatcher.ts src/prAttention.ts test/prHealth.test.ts test/stackedPrs.test.ts docs/spec/07-pull-requests.md
git add -A
git commit -m "dispatch a CI fix for a failing check that does not block the merge"
```

---

### Task 6: Full gate and the operator's recipe

**Files:**

- Modify: `docs/spec/02-configuration.md` (the work-item-linking recipe)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run the full gate**

Run: `npm run check`
Expected: all six stages pass (`format:check`, `lint`, `typecheck`, `typecheck:web`, `knip`, `test`).

Likely failures and their fixes:

- **knip** reporting `PolicyKind` / `PolicyCheckMode` / `checkStatusOf` as unused exports → drop the `export` keyword, do not delete or add to an ignore list.
- **knip** reporting `POLICY_KINDS` or `DEFAULT_POLICY_CHECK_MODES` as unused → they are named by `validatePolicyCheckModes` and `policyCheckMode` in the same file, so this means a consumer was not wired; check Task 3 Step 4 landed.
- **format:check** failing on nearly every file on Windows is a CRLF false alarm — verify the other five stages and re-run the specific test files directly rather than reformatting the repo.

- [ ] **Step 2: Document the work-item recipe**

In `docs/spec/02-configuration.md`, beside the `policyChecks` documentation, add the worked example — this is the whole of the answer to "Work items must be linked", and it exists nowhere else:

````markdown
Work-item linking is `off` by default. To have an agent fix it:

```jsonc
{
  "azureDevOps": { "policyChecks": { "workItems": "check" } },
  "ci": {
    "checks": [
      {
        "match": "Work item linking",
        "onFailure": "dispatch",
        "guidance": "Link the work item with `az repos pr work-item add --id <pr> --work-items <n>`. The work item number is the `<n>` in the branch name `issue/<n>`."
      }
    ]
  }
}
```

No outbound capability is involved: the agent makes the link with a tool it already
has, and `guidance` is the channel that tells it how.
````

- [ ] **Step 3: Record the sharp edges in CLAUDE.md**

In `CLAUDE.md`, under the Azure provider paragraph in **Testing patterns** (the one beginning "The **`azure` provider**"), extend the CI sentence so the two invariants a future change could quietly break are written down:

- `aggregatePolicyCiStatus` is frozen at enabled + blocking + build/status and no configuration reaches it, because `prHealth.blocked` and rule 3's merge test read it;
- rule 1, `inheritedCiFailure` and `prAttention` all gate on `ciNeedsAttention`, and a fourth reader added later must use it too or the cockpit and the rule will disagree;
- an advisory check is filtered out by both `classifyCiFailures` and `ciNeedsAttention`, which is what keeps the comment policy from outranking rule 2b.

- [ ] **Step 4: Re-run the full gate and commit**

```bash
npm run check
npx prettier --write docs/spec/02-configuration.md CLAUDE.md
git add -A
git commit -m "docs: azure policy check modes, and the invariants that keep the aggregate frozen"
```

---

## Out of scope (do not implement)

- **The `handled` heuristic.** `buildUnresolvedComments` marks a thread handled when the bot authored its last comment, so an agent's reply settles the thread for the harness while Azure keeps the comment policy red and the PR blocked. Real, and deliberately not fixed here — changing it alters when the deterministic loop settles and risks agents re-dispatching on threads no human ever resolves. Surfacing the comment policy as advisory makes the divergence visible for the first time, which is the right first step. It wants its own issue.
- Any change to rule 2b, rule 3, the shape of `PrHealth`, or the auto-send gate.
- A `WorkItemLinkCapable` outbound capability.
- Anything provider-side for GitHub, and `web/src/types.ts`.
