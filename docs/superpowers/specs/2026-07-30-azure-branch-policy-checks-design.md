# Azure branch-policy checks: see every check, decide per check

**Date:** 2026-07-30
**Status:** approved, not yet implemented

## The problem

The per-check CI policy (`src/ci/ciPolicy.ts`, config `ci.checks`) lets an operator say, per
failing check, whether an agent fixes it, the harness ignores it, or a human is asked. On Azure
DevOps it can route almost none of a PR's checks, because the provider surfaces a narrow slice of
the branch-policy evaluations as `CiCheck`s.

`listPolicyCiChecks` and `aggregatePolicyCiStatus` (`src/integrations/azure/sourceControl.ts`)
both filter with `!e.isEnabled || !e.isBlocking || !CI_POLICY_TYPES.has(e.typeId)`, and
`listPolicyCiChecks` additionally skips any evaluation with an empty `displayName`.

Measured against a real PR (org `fiscaltecvsts`, PR 31093, `az repos pr policy list`), that filter
drops the following:

| # | Policy | Kind | `isBlocking` | `settings.displayName` | Dropped by |
| --- | --- | --- | --- | --- | --- |
| 181 | Build UI | Build | **true** | **null** | the name check |
| 184 | Build-dotnet | Build | **true** | **null** | the name check |
| 192 | Hallway Traffic Light | Build | true | present | — (surfaced today) |
| 214 | Dotnet Code Format Validation | Build | **false** | present | `!isBlocking` |
| 215 | nxg-build-dotnet-qodana | Build | **false** | **null** | both |
| 227 | Typescript Code Formatter Validation | Build | **false** | present | `!isBlocking` |
| 164 | Comment requirements | Comments | true | null | `typeId` |
| 163 | Work item linking | WorkItems | true | null | `typeId` |
| 165 | Require a merge strategy | MergeStrategy | true | null | `typeId` |
| 47, 167 | Required / Minimum reviewers | Reviewers | true | null | `typeId` |

Two distinct defects, only one of which was the reported one:

1. **Optional policies are invisible.** Three real, failing-capable checks — Dotnet Code Format
   Validation, nxg-build-dotnet-qodana, Typescript Code Formatter Validation — are configured
   Optional in Azure (`isBlocking: false`) and never reach `ciChecks` at all.
2. **Named-by-nothing policies are invisible, including required ones.** A build-validation policy
   names itself in `settings.displayName` only when an operator typed one; otherwise the name lives
   in the evaluation's `context.buildDefinitionName`, which we never read. So **Build UI and
   Build-dotnet — the two required builds this repo actually gates on — cannot be named in
   `ci.checks` today.** Their failure still dispatches an agent (they fold into the aggregate), but
   there is no way to give either one guidance, mute it, or escalate it. This is a pre-existing bug
   with nothing to do with Optional, and it is the higher-value half of the fix.

## Goal

Make every branch-policy evaluation the harness can act on visible to `ci.checks`, without any of
it being able to falsely report a PR as unable to merge.

## Design

### A. Provider: name every policy

`AzPolicyEvaluation` (`src/integrations/azure/azureDevOpsApi.ts`) gains two fields:

- `typeName: string` — `configuration.type.displayName` (`"Build"`, `"Comment requirements"`,
  `"Work item linking"`, `"Required reviewers"`, …). The stable operator-facing category, and the
  last-resort name.
- `buildDefinitionName?: string` — `context.buildDefinitionName`, present on build-validation
  evaluations.

`policyDisplayName` (`src/integrations/azure/restAzureDevOpsApi.ts`) extends its chain to:

```
settings.displayName → statusGenre/statusName → context.buildDefinitionName → type.displayName
```

Every policy is then nameable, which retires `listPolicyCiChecks`'s "skip the nameless" clause
entirely. That clause existed because an unnameable check cannot be matched by a glob and emitting
it nameless would let one empty pattern claim several unrelated checks at once — a fallback to a
real name removes the condition rather than working around it.

`type.displayName` is a per-type name, so two nameless policies of the same type would collide. In
practice the collision case is builds, and `context.buildDefinitionName` resolves those before the
fallback is reached; the remaining types (comments, work items, merge strategy) appear at most once
per PR. Accepted, and stated here rather than discovered later.

### B. Domain: one new optional field on `CiCheck`

```ts
export interface CiCheck {
  name: string;
  status: Exclude<CiStatus, 'unknown'>;
  /** False when the provider says the check does not block completion. Absent = blocking. */
  blocking?: boolean;
  /** True when the check is reported for visibility only and can never dispatch. */
  advisory?: boolean;
}
```

Both absent-means-the-old-behaviour, so GitHub, the `fake` provider, and every PR persisted before
this change are unchanged with no migration.

`blocking` is for **display and for the agent's briefing** — `ciFailureNote` says which failures
will not actually hold the merge — and nothing gates on it. `advisory` is the one that changes
control flow, in exactly one place (D below).

### C. The aggregate is frozen, deliberately

`aggregatePolicyCiStatus` keeps folding **enabled + blocking + build/status-type** evaluations only,
and no new configuration touches it.

This is the structural answer to "keep *the harness will dispatch a fix* decoupled from *the PR
cannot merge*". `ciStatus` is read by `prHealth` (whose `blocked` is `reasons.length > 0`) and by
rule 3's merge test. Freezing it means no setting an operator can write, and no policy kind they
enable, can mark a PR merge-blocked that Azure would happily complete, or stop the harness merging
one it would.

Consequence, accepted: a PR red **only** on Optional checks reports `ciStatus` other than `failing`
and draws no `prHealth` reason. That is correct — it can merge — and the detail still reaches the
cockpit, which is already shipped `ciVerdict: classifyCiFailures(pr.ciChecks, config.ci)` per PR in
`/api/state` (`src/server/app.ts:1442`).

### D. Rule 1's gate moves off the aggregate

A new pure predicate — provisionally `ciNeedsAttention(pr)` in `src/prHealth.ts`, beside the other
PR predicates:

```ts
pr.ciStatus === 'failing' || (pr.ciChecks ?? []).some((c) => c.status === 'failing' && !c.advisory)
```

Read in **three** places, which must agree or the harness contradicts itself:

1. the rule 1 gate (`src/dispatcher/ruleDispatcher.ts:283`), so an Optional failure gets an agent;
2. `inheritedCiFailure` (`src/prHealth.ts:142`), which early-returns on the aggregate today — without
   this, a red Optional check on a stack's base would put a doomed agent on every PR above it, which
   is precisely the multiplication that predicate exists to prevent;
3. `prAttention`'s `ciReading` (`src/prAttention.ts:310`), or the attention lens and the rule
   disagree about whose turn a PR is.

The `!c.advisory` term is what makes "visible but never dispatches" structural rather than
configurational (see E).

### E. `azureDevOps.policyChecks`: which kinds become checks

Policies classify by `typeId` into a `PolicyKind`:
`build | status | comments | workItems | reviewers | mergeStrategy | other`, via a pure function
beside the existing type GUIDs. `CI_POLICY_TYPES` is replaced by that map.

Config gains, on `AzureDevOpsConfig`:

```ts
policyChecks?: Partial<Record<PolicyKind, PolicyCheckMode>>;
```

with `PolicyCheckMode = 'check' | 'advisory' | 'off'`:

- **`check`** — an ordinary `CiCheck`: visible, routable by a `ci.checks` rule, dispatchable.
  Blocking and Optional alike; `blocking` records which.
- **`advisory`** — emitted and visible, `advisory: true`, and therefore never actionable, never
  dispatched, never escalated. `classifyCiFailures` filters advisory checks out before classifying.
- **`off`** — not emitted.

Defaults:

```ts
{ build: 'check', status: 'check', comments: 'advisory',
  workItems: 'off', reviewers: 'off', mergeStrategy: 'off', other: 'off' }
```

`loadConfig` validates the mode values the way `validateCiPolicy` validates `onFailure` — an
unknown mode or unknown kind throws at load, not at 3am.

**Behaviour change, stated:** on an existing Azure deployment, Optional build/status checks and
previously-nameless required builds start appearing in `ciChecks`. A failing check matching no
`ci.checks` rule dispatches — that is the deliberate design (`classifyCiFailures`' doc comment: a
check added next week is fixed rather than silently parking every red PR forever), and it now
applies to Optional failures too. GitHub and `fake` are untouched.

### F. "Comments must be resolved" — advisory by construction

Defaults to `advisory`, so it is visible in the cockpit and in `world_read`, and structurally
incapable of preempting rule 2b.

The hazard it avoids is not a double dispatch — concerns are collected per PR and only the top one
dispatches, at most one agent per branch — it is a **preemption**. Rule 1 (`pr-ci-failing`) outranks
rule 2b (`pr-review-comment`), so a comment policy surfaced as an ordinary failing check would win
the branch and send the generic `pr-ci-fix` prompt *instead of* `pr-review-comment`, discarding the
comment author and body the harness already holds via `buildUnresolvedComments`. Strictly less
information for the same work.

Making it advisory rather than requiring a `ci.checks` rule with `onFailure: 'ignore'` means the
correct behaviour is the default and cannot be lost by forgetting a line of config. An operator who
wants it routable can set `comments: 'check'`; that is their call, and the trade-off is recorded
here.

Rule 2b, `buildUnresolvedComments`, and the `handled` heuristic are **not changed by this work**.
See Out of scope.

### G. "Work items must be linked" — guidance, not a new capability

No new outbound capability. The operator opts in with `workItems: 'check'` and a `ci.checks` rule:

```jsonc
{ "match": "Work item linking", "onFailure": "dispatch",
  "guidance": "Link the work item with `az repos pr work-item add --id <pr> --work-items <n>`. The work item number is the `<n>` in the branch name `issue/<n>`." }
```

This is what `guidance` was built for. A `WorkItemLinkCapable` seam would need a new validated
action, a new dispatcher rule, an implementation on the seam and its scripted fake, and an answer on
whether it is auto-send gated — a lot of new outbound surface for one mechanical link an agent can
already make with a tool it already has. If it proves frequent and the agent proves unreliable at
it, promoting it to a capability later costs nothing that is spent here.

## What changes, by file

| File | Change |
| --- | --- |
| `src/integrations/azure/azureDevOpsApi.ts` | `AzPolicyEvaluation` gains `typeName`, `buildDefinitionName?` |
| `src/integrations/azure/restAzureDevOpsApi.ts` | `RawPolicyEvaluation` gains `context`/`type.displayName`; `policyDisplayName` chain extended; mapping populates the two new fields |
| `src/integrations/azure/sourceControl.ts` | `PolicyKind` classifier replaces `CI_POLICY_TYPES`; `listPolicyCiChecks(evals, modes)` emits per mode with `blocking`/`advisory`; `aggregatePolicyCiStatus` unchanged in behaviour, re-expressed over the classifier |
| `src/integrations/registry.ts` | thread `az.policyChecks` into the integration opts |
| `src/config.ts` | `AzureDevOpsConfig.policyChecks`, defaults, validation |
| `src/types.ts` | `CiCheck.blocking?`, `CiCheck.advisory?` |
| `src/ci/ciPolicy.ts` | `classifyCiFailures` filters advisory out before classifying; `ciFailureNote` names non-blocking failures as such |
| `src/prHealth.ts` | new `ciNeedsAttention`; `inheritedCiFailure` reads it |
| `src/dispatcher/ruleDispatcher.ts` | rule 1 gate reads `ciNeedsAttention` |
| `src/prAttention.ts` | `ciReading` reads `ciNeedsAttention` |

## Testing

`test/azureDevOpsIntegration.test.ts` — extend the scripted `AzureDevOpsApi` fake alongside the seam,
per the repo convention:

- a required build with `settings.displayName: null` and a `context.buildDefinitionName` is surfaced
  under that name (the Build UI / Build-dotnet regression);
- an Optional (`isBlocking: false`) failing build appears in `ciChecks` with `blocking: false` and
  does **not** move `aggregatePolicyCiStatus`;
- a comment policy under the default modes appears with `advisory: true`;
- a reviewers / merge-strategy policy under the default modes appears not at all;
- `policyChecks: { workItems: 'check' }` surfaces work-item linking as an ordinary check;
- a disabled policy is dropped under every mode.

`test/ciPolicy.test.ts`:

- an advisory failing check never appears in `dispatch`/`escalate`/`ignored` and never makes a
  verdict `actionable`;
- a PR whose only failing check is advisory yields `actionable: false` with empty lists — distinct
  from the "no per-check detail" case, which stays `actionable: true`;
- `ciFailureNote` marks a non-blocking failing check as not blocking the merge.

`test/prHealth.test.ts` / `test/stackedPrs.test.ts`:

- `ciNeedsAttention` is true for a PR failing only on a non-aggregate check, false for one whose only
  failing check is advisory;
- `inheritedCiFailure` attributes an Optional failure inherited from a stack base, so no agent is
  dispatched on the child.

`npm run check` — all six stages.

## Out of scope

- **The `handled` heuristic.** `buildUnresolvedComments` marks a thread handled when the bot authored
  its last comment, so an agent's reply settles the thread for the harness while Azure keeps the
  comment policy red and the PR blocked. This is a real divergence and it is *not* fixed here:
  changing it alters when the deterministic loop settles and risks agents re-dispatching on threads
  no human ever resolves. Surfacing the comment policy as an advisory check makes the divergence
  **visible** for the first time, which is the right first step. Worth its own issue.
- Any change to rule 2b, rule 3, `prHealth`'s shape, or the auto-send gate.
- A `WorkItemLinkCapable` outbound capability (G).
- Anything provider-side for GitHub.
