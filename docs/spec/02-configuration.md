# 02 — Configuration

All configuration lives in `src/config.ts` as the `Config` interface, its `DEFAULTS`, and two
loaders. There is no other configuration mechanism.

## Two loaders

- **`loadConfig(overrides)`** — `DEFAULTS` + the caller's overrides, then path resolution and
  validation. It reads **no file and no environment variable**, so the same arguments give the same
  config on any machine. This is what tests and embedders call.
- **`loadDeploymentConfig(overrides)`** — the two ambient layers (`lubbdubb.config.json` and the env
  overrides) folded in underneath the explicit ones, then `loadConfig`. This is what a process entry
  point calls; `src/server/main.ts` is the only one.

The split exists because the ambient layers make the config a function of the machine it loads on.
The suite runs in a working copy of this repo, so an operator's own `lubbdubb.config.json` sitting
beside it would otherwise merge into every test that builds a config — silently, and differently on
each developer's machine. A test wants defaults plus what it wrote; only a deployment wants the
environment. `scripts/smoke.ts` builds a hermetic scenario against a throwaway repo, so it calls
`loadConfig` too.

## Precedence

Values are merged in this order, later winning:

1. `DEFAULTS` (in `src/config.ts`)
2. `lubbdubb.config.json`, read from `process.cwd()` — absent is fine; unparseable throws with the
   file path and the parse error
3. Environment overrides: `PORT` → `port`, `LUBBDUBB_HOST` → `host`, `LUBBDUBB_DB` → `dbPath`,
   `LUBBDUBB_REPO_ROOT` → `repoRoot`
4. Explicit `overrides` passed to the loader (tests, embedding)

Layers 2 and 3 exist only under `loadDeploymentConfig`; `loadConfig` sees 1 and 4.

Four keys are **deep-merged** rather than replaced, so a config file can set one field of them
without dropping the rest: `integrations`, `planning`, `validation`, `auth`. The deep merge holds
_between_ layers as well — an explicit `{planning: {requireApproval: true}}` keeps the other
`planning` fields the operator's file set. Everything else — including `issuePriorityLabels` and
`ci.checks` — is replaced wholesale.

### Retired keys

Two kinds of key an operator's file may still carry, and they are treated differently because they
ask for different things.

A **removed key** (`REMOVED_KEYS`: `dispatcher`, `steeringPriorities`, `autoSend`) is **refused**, by
name, with what to do about it. It names a capability that no longer exists on any setting, so
honouring it is impossible and ignoring it would have the harness do the opposite of what the file
says while the file goes on saying it. `autoSend` is the clearest case: a file asking the harness to
send or merge on its own authority is asking for the one thing it will now never do.

A **retired key** (`RETIRED_KEYS`) is **warned about, dropped, and the harness boots**. Every entry
named a subsystem that is now **unconditional**, so a file setting one is asking for something the
harness either already does or will never do again — and refusing would take a running deployment
down at boot over one stale line. The warning is on the boot log, naming the key: a deployment that
had switched a funnel off is getting it back, and has to hear that from the harness rather than from
the fleet's behaviour. The key is dropped rather than left to merge into nothing, so no value
survives on the policy object for something later to read.

An entry is either a top-level name or one `block.key` path, and both forms are there because a
block whose every field went unconditional is removed whole while an operator's file names the block
rather than the field inside it. The list:

| Retired key                                                        | Because                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `planning.enabled`, `validation.enabled`                           | always on ([08](08-planning.md), [20](20-validation.md))         |
| `assay`, `assessment`, `retrospective` (and each one's `.enabled`) | always on ([06](06-issue-pickup.md), [05](05-dispatcher.md))     |
| `mcp`, `mcp.enabled`, `mcp.permissionEscalation`                   | always on ([11](11-mcp-tools.md))                                |
| `validation.desktopSkill`                                          | the skill always rides with the channel ([20](20-validation.md)) |
| `reapMergedBranches`                                               | always on ([07](07-pull-requests.md#reaping-a-merged-branch))    |
| `reviewReminderMs`                                                 | the cockpit ages every waiting PR, with no threshold             |
| `issuePickupRequireOwnLabel`                                       | follows `userId` ([below](#userid))                              |
| `github.defaultAssignee`, `azureDevOps.defaultAssignee`            | follows `userId`                                                 |
| `github.filters`, `azureDevOps.filters.prAuthor`                   | follows `userId`                                                 |
| `azureDevOps.filters.workItemAssignedTo`                           | follows `userId`                                                 |

Both lists are permanent — a config written before a removal outlives the release that made it.

`loadConfig` **throws** for one combination: a `host` that is reachable off this machine together
with `auth.enabled: false`. Each half alone is a supported deliberate choice; together they expose an
endpoint that queues jobs — which spawn agents with write access to the repo — to every peer on the
network. A warning would scroll past in a boot log, so it is refused instead.

No secret is ever a config key. The GitHub token comes from `GITHUB_TOKEN`, and the cockpit token
from `LUBBDUBB_TOKEN` or a minted 0600 file, so `lubbdubb.config.json` stays safe to paste.

## Path resolution at load

`loadConfig` resolves paths so that later code, which runs with a worktree or scratch `cwd`, cannot
resolve them against the wrong directory:

- `repoRoot` is resolved against `process.cwd()`.
- `worktreeRoot`, `deskRoot`, `attachmentRoot`, `validationRoot` and `promptTemplatesDir` are resolved against **`repoRoot`** (not the
  launch directory), so running LubbDubb from its own folder against a repo elsewhere does not
  scatter that repo's worktree slots into the app's directory. An absolute override is honoured as-is.
- Each entry of `claudeArgs` that is relative **and names an existing file** is made absolute.
  Non-file args are left untouched.

## Reference

### Loop and capacity

| Key                   | Type      | Default                     | Behaviour                                                                                                                                            |
| --------------------- | --------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heartbeatIntervalMs` | `number`  | `300000`                    | Gap between timer-driven cycles.                                                                                                                     |
| `maxConcurrentAgents` | `number`  | `3`                         | Seeds the runtime cap. Live changes go through `POST /api/control` and are **not** persisted.                                                        |
| `startPaused`         | `boolean` | `false`                     | Seeds the runtime pause flag. The only config-level pause knob; live pause/resume is ephemeral, so a restart reverts to this.                        |
| `port`                | `number`  | `4300`                      | HTTP/WS port. Overridable via `PORT`.                                                                                                                |
| `host`                | `string`  | `127.0.0.1`                 | Bind address. Loopback by default; `"0.0.0.0"` exposes the cockpit on the network and then requires `auth.enabled`. Overridable via `LUBBDUBB_HOST`. |
| `auth.enabled`        | `boolean` | `true`                      | Require a bearer token on `/api/*` and `/ws`. See [16 — HTTP API](16-http-api.md#authentication).                                                    |
| `auth.tokenFile`      | `string`  | `.lubbdubb/cockpit-token`   | Where a minted token is persisted (0600). Ignored when `LUBBDUBB_TOKEN` is set.                                                                      |
| `dbPath`              | `string`  | `.lubbdubb/lubbdubb.sqlite` | SQLite file. Overridable via `LUBBDUBB_DB`. `:memory:` is supported (tests).                                                                         |

### Repository

| Key                | Type     | Default                   | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | -------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repoRoot`         | `string` | `process.cwd()`           | The git repository worktrees are cut from. Overridable via `LUBBDUBB_REPO_ROOT`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `defaultBranch`    | `string` | `"main"`                  | The integration branch. A new agent branch is cut from it, and a PR targeting anything else is treated as stacked. Not auto-detected.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `worktreeRoot`     | `string` | `.lubbdubb/worktrees`     | Root for the pool of worktree slot directories (`slot-0`, `slot-1`, …).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `worktreePoolSize` | `number` | `maxConcurrentAgents + 2` | Hard bound on how many worktree directories the pool may hold. **Derived, not a flat default**, so raising the concurrency cap does not silently start rejecting dispatches for want of a directory. Set it to override: a small disk wanting fewer full checkouts, or a deployment whose slots are routinely left carrying uncommitted changes and so needs more. Exhaustion **rejects** the dispatch (recorded, retried next cycle) rather than blocking the pulse. Read once at boot, so the live cap from `POST /api/control` does not move it. → [09](09-execution.md#exhaustion) |
| `deskRoot`         | `string` | `.lubbdubb/desk`          | Root for desk-task scratch directories (one per task id).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `attachmentRoot`   | `string` | `.lubbdubb/attachments`   | Root for images attached to a blueprint (issue #249) — deliberately outside every worktree, so a screenshot cannot be committed onto a branch. Every agent launch is granted read access to this whole root via `permissions.additionalDirectories`, which is a real widening: an agent working one goal can read another goal's attachments. See [09](09-execution.md) and [10](10-agent-runtimes.md).                                                                                                                                                                                |
| `validationRoot`   | `string` | `.lubbdubb/validation`    | Root for a goal's validation resources — fixtures, reference material, sample data — one directory per goal (`<root>/issue-284/`). `attachmentRoot`'s storage rule, argument for argument: outside every worktree, canonical rather than copied per dispatch, and granted to every agent launch through `permissions.additionalDirectories`. Granted on every launch, so an agent's readable set does not depend on a policy flag it cannot see. → [20](20-validation.md)                                                                                                              |

### Dispatch behaviour

| Key                   | Type            | Default             | Behaviour                                                                                                                                                                                                                                               |     |
| --------------------- | --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `promptTemplatesDir`  | `string`        | `.lubbdubb/prompts` | Directory of `<prompt-id>.md` overrides, read once at boot. Absent directory = all built-in defaults.                                                                                                                                                   |     |
| `closedPrWindowMs`    | `number`        | `21600000` (6h)     | How far back providers look for PRs that left the open set. `0` disables the lookup entirely.                                                                                                                                                           |     |
| `upNextOverrideTtlMs` | `number`        | `604800000` (7d)    | How long an operator "Up next" priority override (issue #128) survives after its origin stops being tracked. `0` disables pruning.                                                                                                                      |     |
| `ci.checks`           | `CiCheckRule[]` | `[]`                | Per-check CI policy: what rule `pr-ci-failing` does about _which_ check went red. Ordered, first match wins, replaced wholesale by an override. Empty — and any check matching no rule — is the pre-policy behaviour: dispatch a code agent. See below. |     |

#### Per-check CI policy (`ci.checks`)

A check is matched against each rule's `match` **glob** in order (`*` = any
run of characters, `?` = exactly one, everything else literal, matched
case-insensitively) **and** against the rule's `states`; the first rule that
matches on both decides it. The glob is tried against every name the provider
reports for the check — its `name` and any `aliases` (see
[07](07-pull-requests.md#ci-checks)).

| Field       | Type                                   | Default       | Behaviour                                                                                                                                                |
| ----------- | -------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match`     | `string`                               | (required)    | Glob against the check name (`lint`, `test (*)`, `deploy-*`), or any alias the provider reports for it.                                                  |
| `states`    | `('failing' \| 'pending')[]`           | `['failing']` | Which check states this rule claims. Scopes the whole rule, so a rule listing only `pending` does **not** claim the same check when it fails. See below. |
| `onFailure` | `'dispatch' \| 'ignore' \| 'escalate'` | `'ignore'`    | What a check this rule claims makes the harness do. The default is `ignore` because the usual reason to name a check is to stop acting on it.            |
| `guidance`  | `string`                               | unset         | Appended to the dispatched agent's prompt when this check is among the ones that fired. Only legal with `onFailure: 'dispatch'`.                         |
| `urgent`    | `boolean`                              | `false`       | Sort this PR's concern ahead of every other PR concern this cycle. Only legal with `onFailure: 'dispatch'`.                                              |

##### Watching a check that is not failing (`states`)

Some blocking checks never fail — they **wait**. An Azure `status` branch policy is
`queued` from the moment the PR opens until something outside the harness posts its
status, and until then `ciStatus` is `pending`, `ciNeedsAttention` is false, no rule
looks at it, and `prAttentionStatus` reads `elsewhere` / "CI still running" forever.
That is the case `states` exists for: the PR is stuck on a command somebody has to
run, and there was no lever to say so.

```json
{ "match": "pr-agent-review*", "states": ["pending"], "onFailure": "dispatch", "guidance": "Run `/pr-agent-review` …" }
```

Three decisions worth stating, because none of them is the only defensible one:

- **`states` scopes the rule; it does not extend it.** Matching is on the
  `(glob, state)` pair, so the rule above claims `pr-agent-review/reviewed` while it
  waits and claims nothing when it goes red — the red one then walks on to a later
  rule, or to the unmatched default (dispatch). One check can therefore carry two
  rules saying different things, which is the only way to express "run the gate when
  it stalls, fix it when it breaks". The cost is that a rule watching only `pending`
  silently stops muting the same check's failures; the CI tab names that, per rule.
- **`onFailure` keeps its name.** It reads narrow now — "on match" is the honest word
  — but it is the action field in every deployed config and in `describeCiPolicy`, and
  renaming a key to improve a noun breaks files in the field in exchange for nothing an
  operator can do differently.
- **A non-failing watch may `dispatch` or `ignore`, never `escalate`.** `loadConfig`
  **throws** on `states` without `failing` combined with `escalate`: the harness has no
  escalation arm for a check that is merely waiting — rule `pr-ci-blocked` asks about a
  _red_ PR whose failures are all held — so the rule could never fire. `ignore` there is
  not idle, because of the expiry default below: it is how an operator mutes a check the
  provider reports as `expired` while leaving that same check's genuine failures on the
  dispatching default, which `states: ["failing", "pending"]` would give up. `passing` is
  refused as a state on the could-never-fire grounds: a check that passed asks nothing of
  anyone.

**One waiting check needs no rule at all.** A check the provider reports as `expired` — an Azure
build-validation policy whose last run predates the branch's commits, so nothing is in flight and
nothing starts on its own — is watched with nothing in `ci.checks` naming it, exactly as an unclaimed
_failing_ check dispatches. Writing `{ "match": "<build>", "states": ["pending"] }` for that case is
the wrong lever and is not needed: it fires equally on a build that is genuinely running, sending an
agent to release a gate that was about to release itself. A rule claiming the check in `pending` with
a non-dispatch action shadows the default, which is how an operator turns it off:

```json
{ "match": "NXG-CI", "states": ["pending"], "onFailure": "ignore" }
```

That is the whole lever for a deployment where required builds expire on **every** push, and the
reason the pending-only `ignore` is legal. Because `states` scopes rather than extends, the rule says
nothing about the same build going red, so the failure still falls through to the dispatching default
and an agent still fixes it — the half `states: ["failing", "pending"]` with `ignore` would destroy.
→ [07](07-pull-requests.md#ci-checks)

The dispatch itself, its own origin, and what stops it looping are rule `pr-ci-gate`'s
— [05](05-dispatcher.md#the-rule-book).

Verdict per PR, not per check — one agent works a branch, so all its failures are
one job:

- **Anything actionable** → one agent on `pr:<n>:ci`, with every matched
  `guidance` appended, and the held checks named so the agent doesn't chase
  them.
- **Anything watched in a non-failing state** → one agent on `pr:<n>:ci-gate`, a
  separate origin with its own attempt cap, ranked below a red build. The waiting
  checks and their guidance are appended to a prompt written for a gate rather
  than for a broken build.
- **Nothing actionable, something escalating** → rule `pr-ci-blocked` asks a human once (held
  by an open item on the same origin, or a recent one in the audit log).
- **Nothing actionable, nothing escalating** → nothing happens. The PR sits red
  and `prHealth` names the failing checks. Re-evaluated every pulse, so it moves
  on its own the moment an actionable check goes red or the held one recovers.

`loadConfig` **throws** on `guidance` or `urgent` attached to a rule that never
dispatches: both are written for an agent that would never be sent, and dropping
them silently is the failure worth catching at boot. It throws on the same grounds
for an empty `states`, an unrecognised state, and a non-failing watch that
`escalate`s — a rule that cannot fire is a rule the operator believes is running.

The resolved policy is readable **from the cockpit** since #244 — the settings modal's CI tab
([17](17-cockpit.md#the-ci-policy-tab)), off `GET /api/ci-policy`
([16](16-http-api.md#get-apici-policy)). It shows the _effective_ routing per rule rather than the
field as written, which is the point: the three defaults above (`ignore` for an omitted `onFailure`,
`['failing']` for omitted `states`, `dispatch` for a check no rule claims) are the whole reason
reading the file is not the same as knowing the policy.

```json
{
  "ci": {
    "checks": [
      { "match": "lint", "onFailure": "dispatch", "guidance": "Run the lint-fix skill; do not touch unrelated files." },
      {
        "match": "e2e (*)",
        "onFailure": "dispatch",
        "guidance": "These are flaky. Reproduce locally before editing test code."
      },
      { "match": "security-*", "onFailure": "dispatch", "urgent": true },
      { "match": "deploy-preview*", "onFailure": "ignore" },
      { "match": "infra-*", "onFailure": "escalate" },
      {
        "match": "pr-agent-review*",
        "states": ["pending"],
        "onFailure": "dispatch",
        "guidance": "Run `/pr-agent-review` on this branch; the gate clears when it posts its status."
      },
      { "match": "NXG-CI", "states": ["pending"], "onFailure": "ignore" }
    ]
  }
}
```

### Item selection (labels, priority, states)

| Key                    | Type                     | Default                                                           | Behaviour                                                                                                                                                                                        |
| ---------------------- | ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `userId`               | `string` (optional)      | unset                                                             | Who _you_ are to every provider — see [`userId`](#userid). Turns on the ownership gate, ticket assignment and the PR-author filter together. Unset, all three are off.                           |
| `labelPrefix`          | `string`                 | `"lubbdubb"`                                                      | Derives the tag pair `${prefix}-watch` / `${prefix}-ignore`. An **empty** prefix turns both gates off.                                                                                           |
| `issuePriorityLabels`  | `Record<string, number>` | `{ 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 }` | Label → weight for pickup ordering. Replaced wholesale by an override.                                                                                                                           |
| `issueDefaultPriority` | `number`                 | `2`                                                               | Weight for an issue with no matching priority label.                                                                                                                                             |
| `issuePickupStates`    | `string[]` (optional)    | unset                                                             | When non-empty, only items whose provider-native state is listed are eligible. Items with no such state bypass it.                                                                               |
| `issueInReviewState`   | `string` (optional)      | unset                                                             | The state an item is moved to once a PR is open for it. Takes effect only alongside `issuePickupStates`.                                                                                         |
| `issueContainerTypes`  | `string[]`               | `["Feature", "Epic"]`                                             | Item types that **hold** work rather than being work. Never picked up, planned or assayed. Matched case-insensitively; `[]` turns the gate off; items with no type bypass it.                    |
| `issueFilingTypes`     | `string[]`               | `["User Story", "Bug"]`                                           | The types the harness may **create** when filing a finding, a blueprint or unrecorded work — see [what a filed item is](#what-type-a-filed-item-is). Azure only; `[]` falls back to the default. |

### Feature policies

| Key                                   | Type             | Default                              | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ---------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planning.maxConcurrentPartsPerIssue` | `number`         | `2`                                  | How many parts of one plan may have live agents at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `planning.requireApproval`            | `boolean`        | `true`                               | Put a plan to a human before anything is scheduled from it: approve-before rather than replan-after. On, ingestion persists it as `awaiting_approval` and rule `plan-approval` proposes it once, and its ready parts are queued as `unapproved` by rule `plan-part` until you accept. One part or eight — the part count has no bearing on any of it. Rejecting sends the plan back to a planner with your reason, retiring the parts nothing was started for. Off leaves the funnel byte-for-byte as it was: the plan commits the moment the planner writes it. |
| `planning.gitFetchIntervalMs`         | `number`         | `60000`                              | Floor on how often plan reconciliation runs `git fetch`. `0` = every pulse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `validation.desktop`                  | `boolean`        | `false`                              | The desktop channel: a second MCP socket the operator's _own_ Claude Code connects to, so a check needing a browser and a login the fleet has not can be run at their keyboard. **Off by default**, unlike everything else in `validation`, because it has a footprint outside the harness — a credential in a home directory, a skill installed into their Claude Code, and a socket at a fixed path. None of that should happen because a deployment took the defaults. → [20](20-validation.md#the-desktop-channel)                                           |
| `validation.desktopClaimMinutes`      | `number`         | `60`                                 | How long a desktop claim holds a check unreleased. A claim normally goes when the session's socket closes or the check is reported; neither survives a harness killed in between, and a stale claim blocks the fleet from a check nobody is running.                                                                                                                                                                                                                                                                                                             |
| `validation.desktopSocketPath`        | `string`         | `<tmpdir>/lubbdubb/mcp-desktop.sock` | Where the desktop bridge connects. **Stable, not per-pid** — that is what lets the MCP server be registered in Claude Code once instead of per run. The cost is that two harnesses on one machine want the same path, so the channel refuses a _live_ socket rather than unlinking it the way the fleet's does. → [11](11-mcp-tools.md#transport)                                                                                                                                                                                                                |
| `validation.desktopCredentialPath`    | `string`         | `~/.lubbdubb/desktop.json`           | Where the credential is written, `0600`. A **path**, not a secret — the token inside is minted at every start, which is the point: it keeps the token out of the registration an operator pastes, and out of `ps`.                                                                                                                                                                                                                                                                                                                                               |
| `validation.desktopSkillPath`         | `string`         | `~/.claude/skills/lubbdubb/SKILL.md` | Where the skill is installed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `spendBurn.enabled`                   | `boolean`        | `true`                               | The live burn watch. On by default because it spends no agent and gates nothing. Off files nothing and **still settles rows already standing**, so turning it off drains the bench.                                                                                                                                                                                                                                                                                                                                                                              |
| `spendBurn.multiple`                  | `number`         | `4`                                  | How many times its bucket's median a live run may reach before it surfaces. Must be above `1`. Generous on purpose: the spread inside one rule-and-profile bucket is real work, not noise.                                                                                                                                                                                                                                                                                                                                                                       |
| `spendBurn.minimumRuns`               | `number`         | `5`                                  | Settled, measured runs a bucket needs before its median is trusted at all. Below it the bucket is silent rather than guessed at.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `spendBurn.floorUsd`                  | `number`         | `1`                                  | Absolute money a run must **also** have spent, so four times the median of a rule that costs pennies is not an alarm.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `spendBurn.ceilingUsd`                | `number \| null` | `null`                               | A flat per-run ceiling that fires with no history whatever — the arm for a deployment where the first runaway is also the first run. `null` = no such arm, because the right number is a property of your work and nothing here can guess it.                                                                                                                                                                                                                                                                                                                    |

| `selfUpdate.enabled` | `boolean` | `true` | Whether the harness checks its **own** build for updates. Off means no check, no gauge and no upgrade route — the behaviour before this existed. |
| `selfUpdate.remote` | `string` | `"origin"` | The remote the install directory's updates come from. |
| `selfUpdate.branch` | `string` | `"main"` | The branch on it that releases land on. **Not `defaultBranch`**, which is the _worked_ repo's integration branch and a different repository's. |
| `selfUpdate.checkIntervalMs` | `number` | `3600000` | A floor on how often the remote is touched, not on how fresh the served answer is: the reading is held in memory and served from there in between. |

#### `selfUpdate`

The one config group that is not about the repository the fleet works on. It watches the directory
LubbDubb is **installed** in, resolved from the running module rather than from `repoRoot` — the two
coincide only when the harness is dogfooding itself, and a deployment working on another codebase
still wants to hear that its own build moved. There is deliberately no key pointing the watch at an
arbitrary path; only the remote and branch it tracks are configurable, because a fork tracks
somewhere else.

Cheap by construction: the steady state is one `ls-remote` an hour, which transfers no objects. Full
behaviour, including the drain and the handoff, is [21](21-self-update.md).

#### `spendBurn`

Every other cost reading is a post-mortem. This one is taken while the money is still being spent: a
live run is compared against the median of settled runs of **its own kind of work** — the dispatch
rule _and_ the profile, since a pinned goal legitimately costs several times the same rule on a cheap
profile — and one far past that becomes a `burn` human task.

It **holds nothing and kills nothing**. An expensive run is not a wrong run, and no threshold can
tell the two apart; the notice is the prompt to open the transcript and decide. It refreshes its
figures every pulse and settles itself when the run ends.

Three gates must hold together (`multiple`, `minimumRuns`, `floorUsd`) because a multiple on its own
fires constantly. A policy that would file constantly — a `multiple` at or below 1, a `minimumRuns`
of 0 — is refused at load, naming the key. **PTY mode reports no usage**, so nothing there can ever
trip the watch. → [18](18-observability.md#the-burn-watch)

### Agent launch

| Key                     | Type                            | Default                 | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentMode`             | `'stream' \| 'pty' \| 'raw'`    | `'stream'`              | Which runtime launches agents.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `claudeCommand`         | `string`                        | `'claude'`              | The command spawned for an agent.                                                                                                                                                                                                                                                                                                                                                                                                |
| `claudeArgs`            | `string[]`                      | `[]`                    | Extra args, appended **after** the harness's own, so an explicit flag there has the last word.                                                                                                                                                                                                                                                                                                                                   |
| `agentPermissionMode`   | `string`                        | `'acceptEdits'`         | Passed to `--permission-mode`. `acceptEdits` auto-accepts file edits only. `bypassPermissions` maps to `--dangerously-skip-permissions`, which `claude` refuses under root.                                                                                                                                                                                                                                                      |
| `agentModels`           | `AgentModels` (optional)        | unset                   | Which model each kind of work runs on and how hard, keyed on the dispatch rule that proposed it (issue #321). Named profiles, a `default` and per-rule assignments; resolved once at dispatch and stored on the task. Omitted, no launch carries `--model` or `--effort`. See [Model assignment](#model-assignment-by-rule) below and [10](10-agent-runtimes.md#launch-arguments).                                               |
| `agentAllowedTools`     | `string[]`                      | JS toolchain + git + gh | Tool allow rules merged into `--settings` as `permissions.allow` (Claude Code syntax, e.g. `Bash(npm:*)`). Pre-approves the mechanical validate/commit/push commands so the default config completes a task unattended without `bypassPermissions`. Never on `--allowedTools` (that carries the MCP grants). Default: `Bash(npm:*)`, `Bash(npx:*)`, `Bash(pnpm:*)`, `Bash(yarn:*)`, `Bash(node:*)`, `Bash(git:*)`, `Bash(gh:*)`. |
| `agentPromptDelayMs`    | `number`                        | `1200`                  | Delay before the first message is delivered, giving an interactive REPL time to boot. Stream mode uses `0`.                                                                                                                                                                                                                                                                                                                      |
| `agentSubmitDelayMs`    | `number`                        | `60`                    | PTY only: gap between writing message text and writing the submitting carriage return.                                                                                                                                                                                                                                                                                                                                           |
| `agentIdleWaitMs`       | `number`                        | `90000`                 | PTY (real TUI) only: park a session as waiting after this long with no terminal output. `0` disables. Unlatched — output un-parks it.                                                                                                                                                                                                                                                                                            |
| `agentWaitingPatterns`  | `string[]`                      | `[]`                    | Extra literal substrings a PTY session treats as "waiting for input".                                                                                                                                                                                                                                                                                                                                                            |
| `agentResumeAttempts`   | `number`                        | `3`                     | How many times a live agent whose process dies mid-run is re-attached to its own session before it is settled as `failed` (issue #318). Counted on `agents.resume_attempts`, so the budget spans the agent's whole life and survives a restart. `0` disables auto-resume; ignored by runtimes that cannot resume.                                                                                                                |
| `whitelistedApprovals`  | `{match, response}[]`           | `[]`                    | Waiting prompts containing `match` are auto-answered with `response` instead of escalating.                                                                                                                                                                                                                                                                                                                                      |
| `sessionTranscriptRoot` | `string` (optional)             | `~/.claude/projects`    | Where Claude Code writes session transcripts, which PTY mode tails. Override only if the agent runs under a different HOME.                                                                                                                                                                                                                                                                                                      |
| `docsFolderPrefix`      | `string \| string[]` (optional) | unset                   | Folder(s) whose files are promoted to artifact chips regardless of extension. Absolute entries also widen the artifact-serving boundary.                                                                                                                                                                                                                                                                                         |

### Model assignment by rule

Planning an issue and triaging a red CI check are not the same problem, and before issue #321 the
only lever that could say so was `claudeArgs` — fleet-wide and all-or-nothing. `agentModels` assigns
a model per _kind_ of work:

```json
{
  "agentModels": {
    "profiles": {
      "fast": { "model": "haiku", "rank": 1, "description": "Mechanical, well-specified work." },
      "standard": { "model": "sonnet", "effort": "medium", "rank": 2, "description": "Ordinary feature and bug work." },
      "deep": { "model": "opus", "effort": "medium", "rank": 3, "description": "Work whose shape is unclear." }
    },
    "default": "deep",
    "byRule": { "pr-ci-gate": "fast", "issue-retro": "fast", "issue-assess": "standard" }
  }
}
```

- **The key is a `DISPATCH_RULES` id.** That id is already persisted on `Task.rule` and is already the
  axis `src/taskTypeSpend.ts` prices work by, so config, spend and the decision log share one
  vocabulary rather than growing a second. → [05](05-dispatcher.md#the-rule-book)
- **A rule points at a named profile, and a profile is a model and the depth it runs at.** The
  indirection buys a name (`deep`, `fast`) that survives a model being replaced: when a new model
  ships, one profile value changes and every rule pointing at it follows. A profile deliberately
  carries nothing else — no permission mode, no extra args. `claudeArgs` stays the single global
  escape hatch, which structurally removes the risk of a profile's args clobbering the
  `--allowedTools` MCP grants; both fields a profile does carry are flags the harness emits itself,
  which is what keeps them out of that argument.
- **The two fields resolve together, as one profile.** A lookup that fell back for the model and not
  the effort could pair a cheap model with a depth chosen for an expensive one, so `resolveAgentProfile`
  returns a whole profile or nothing.
- **A profile also carries a `rank` and a `description`, and both are required.** Neither reaches the
  command line, so neither widens the one-escape-hatch property above. `rank` orders the profiles
  cheapest-first and must be unique: it is what lets the goal-profile gate say whether a proposal is
  _cheaper_ or _deeper_ than what is standing, and what orders the cockpit's dropdowns. Declaration
  order was the alternative and is not one — a key's position in a JSON object is not a value, and
  reordering the block would silently re-rank the fleet. `description` is the whole of what the
  assayer is told about a deployment's profiles when it proposes one, so it is written as
  instructions to an agent about when to pick this profile rather than as a note to the operator.
- **`effort` is optional, and omitting it is not the middle setting.** `claude --effort` takes
  `low`/`medium`/`high`/`xhigh`/`max`, and the CLI's own default is the top of that ladder — so an
  unassigned rule is the _expensive_ one, not the neutral one. This is the argument for setting
  `default`: a policy that covers only some rules leaves the rest at the CLI's default depth.
  A profile that omits `effort` passes no flag, which is what the smallest models need — they refuse
  the flag outright, so a cheap model and a shallow depth are alternative levers, not composable ones.
- **The model string and the effort level are both unvalidated.** Only the installed `claude` knows
  which models exist and which of them accept `--effort`, so either being wrong fails at _spawn_ — as
  a failed agent — rather than at boot.
- **`default` covers every rule with no `byRule` entry, and every run dispatched outside a rule.** An
  operator who sets only this has moved the whole fleet with one line. Omitted, an unassigned rule
  carries neither flag.
- **The whole block is optional.** Omitted, neither flag is ever passed and argv is exactly what it
  was before the key existed.
- **It merges whole**, not field by field like the policy blocks: an override that sets `agentModels`
  replaces it, which is what lets one _remove_ an assignment rather than only add to it. It also means
  a partial block is the whole policy — an operator who writes only `profiles` and `default` has
  cleared every `byRule` entry they were copying from, rather than adding to them.

Every rejection at load is by `validateAgentModels`, in `src/agents/modelPolicy.ts` — a pure function called
from `loadConfig` (not only `loadDeploymentConfig`, or no test could reach it):

- a profile written as a bare model string — the shape before profiles carried an effort. Accepting
  both would leave one config key with two spellings, which is the drift the named profile exists to
  end; refusing it by name stops a deployment on the old shape at boot, with the fix in the message,
  rather than starting it with a profile the resolver reads as having no model;
- an `effort` that is not one of the five levels, which would otherwise reach the CLI as a flag value
  it rejects — at spawn, per agent, rather than once at boot;
- a missing or non-numeric `rank`, a missing or empty `description`, or two profiles sharing a rank.
  The first two are refused rather than defaulted because both have a _silent_ wrong answer available:
  an inferred rank reads as a deliberate ordering, and an empty description makes every assay proposal
  a guess that looks exactly like a judgement. A shared rank is refused because "deeper or cheaper
  than what is standing" then has no answer;
- a `default` or `byRule` value naming a profile that is not in `profiles`, which would otherwise
  launch with no flag and read as working;
- a `byRule` key that is not a **pipeline** rule id. Validated against `DISPATCH_PIPELINE` rather than
  the whole registry: the `admission` and `terminal` entries (`cooldown-escalate`, `idle`) never reach
  `action.rule`, so accepting one as a key would make the typo check weaker than it looks. A key that
  can never match is the failure class the config rejections exist to prevent.

#### No policy ships, and unset is not a default model

The harness ships **no `agentModels` block**. `lubbdubb.config.example.json` carries a worked one —
that file is the discovery surface for every other knob, and a mechanism nobody is told about is the
defect issue #335 opened on — but it is an example to copy and edit, not a default in force.

The reason is that a shipped default would have to name model strings, and the harness cannot check
one: only the installed `claude` knows which models this deployment has. A wrong alias in a shipped
default fails at **spawn**, as a failed agent on a deployment that configured nothing and changed
nothing — precisely the invisible failure class the rest of this document exists to avoid. An
operator who copies the example is choosing those strings, and owns them.

So `resolveAgentProfile` returning `null` is a **meaningful value**, and it is not "the default
model". It means _pass no flag_, and leave the choice to the CLI. The two are different in a way that
matters for cost: the CLI's own effort default is the top of the ladder, so an unconfigured fleet is
not sitting in the middle of the range — it is at the expensive end of it, which is the observation
that motivates configuring the block at all.

Resolution happens **once, at dispatch** (`ActionExecutor.recordDispatchTask`), and the resolved
_strings_ are stored on the task as `model` and `effort`, beside the `profile` name they came from and
the `profileSource` that names which level of the chain below answered — see
[10](10-agent-runtimes.md#launch-arguments) and [14](14-persistence.md).

### Pinning one goal to a profile

`byRule` prices work by **kind**, which is right as the default axis — it is the vocabulary
`Task.rule`, the decision log and `rollUpTaskTypes` already share. It has no answer for the case an
operator actually hits: _this issue is harder than the rule it arrived on._ Editing config moves every
`issue-pickup` in the fleet, which is both too big and too slow to be the answer to one hard ticket
(issue #342).

The answer is a **tag on the ticket**:

```
${labelPrefix}-model-<profile>
```

written through `connector.setIssueLabel` — the same seam, and the same gesture, as the watch toggle,
so Azure DevOps needs no separate answer. Writing one clears the others, as `watch` clears `ignore`.

The chain a dispatch resolves through is then three levels, in `resolveAgentProfile`:

| Level     | Where it comes from                            | `Task.profileSource` |
| --------- | ---------------------------------------------- | -------------------- |
| pin       | the plan part's `profile`, else the goal's tag | `pin`                |
| `byRule`  | the dispatch rule that proposed the run        | `rule`               |
| `default` | the fleet-wide fallback                        | `default`            |
| —         | nothing configured: pass neither flag          | (null)               |

- **The pin is keyed on the origin, never on the run.** That is what keeps `resolveAgentProfile` pure:
  a retry runs the same profile, a re-dispatch resolves the same one, and a boot-resumed agent
  re-launches on what its task row stored. Escalating on attempt count would break all three, and is a
  separate argument — see [10](10-agent-runtimes.md#launch-arguments).
- **It wins in both directions.** A pin is not an escalation; the same mechanism pins one noisy goal to
  the cheapest profile. The word is _pin_, not _bump_, for exactly that reason — you name a profile,
  not a direction.
- **It reaches every dispatch on that issue's origins, with two carve-outs.** `issue-retro` runs on its
  `byRule` entry whatever the goal is pinned to: a retrospective **gates nothing**, so inheriting a deep
  pin is real money on a write-up no dispatch reads. `issue-assay` runs on its own entry because it is
  the stage that _produces_ the pin. Both are declared in `UNPINNED_SUFFIXES` in `src/profilePin.ts`.
  Nothing outside the `issue:<n>` subtree is pinned at all, so the CI and review rules on a pull request
  the work produced resolve on `byRule` — following a pin down that lineage is a second mechanism.
- **A tag naming no configured profile is ignored, and never parks anything.** Config is the operator's
  own file and is refused at boot by name; a label is typed on a ticket by a human the harness cannot
  refuse, so the only choices are falling back to the rule's entry or parking a watched issue over a
  typo. `resolveModelTag` falls back and reports the tag it ignored, which the cockpit draws. Two valid
  tags resolve to the **deeper** one — ranks are unique, so there is always an answer, and quietly
  taking the cheaper of two is the failure that reads as ordinary output.
- **A plan may name a profile per part**, which beats the goal's pin for that part alone. The planner
  writes it, because it is the stage that just cut the decomposition and knows which part is the hairy
  one; the cockpit can override it. Clearing a part's profile is not the same as naming the goal's:
  a cleared part _inherits_, so re-pinning the goal later moves it too.
- **Nothing needs enabling.** Pins are on wherever `labelPrefix` and `agentModels.profiles` are both
  set, and off — completely, with no control drawn — where either is missing.

#### The gate: the assayer proposes, a human confirms

`assay_issue` asks the assayer for a profile alongside its `workable`/`unclear` verdict, enumerating
this deployment's own profiles with their descriptions. The assayer is the right author because it is
the only stage that reads the ticket against the repository **before** anything is spent, and it is
already dispatched in front of every fresh issue. It necessarily runs on its own `byRule` entry.

Naming the operator's profiles directly, rather than an abstract difficulty scale, deletes the
`byDifficulty` mapping table a scale would have needed — and the mapping is exactly where the meaning
would be lost, since an operator who splits `deep` into two knows what the two are for and a fixed
vocabulary cannot be told.

**A proposal that differs from what is already standing holds the funnel** until a human answers it,
as a second arm on `assayHold` — see [06](06-issue-pickup.md). Blocking rather than informing, for the
reason the `unclear` arm blocks: informing is what the cockpit already does for every verdict, and the
dispatch the gate exists to price correctly would happen anyway. What makes it safe is what makes the
first arm safe:

- **An absent proposal holds nothing.** An assayer that crashes, is killed, spends its attempt cap or
  simply names no profile leaves the issue to the funnel it would have entered anyway, on its rule's
  own entry. So does every `unclear` verdict — a goal nobody could start from has no work to size.
- **Agreement holds nothing, and costs no click.** The divergence is decided **once**, where the
  proposal is written and the ticket's tag and the operator's config are both in hand
  (`AgentManager.recordAssay`), and a proposal that matched what was standing is stored already
  answered. So the gate itself is a two-field read with no config threaded into it, and no caller can
  forget a lookup and gate the whole fleet by accident.
- **The answer is recorded, not the choice.** The operator's click writes the tag _and_ stamps
  `issue_assays.profile_answered_at`. What was chosen is the tag; a second copy of it on the row would
  be free to drift. This is also why "keep mine" works — the tag goes on deliberately disagreeing with
  the assayer, and a gate that re-read the disagreement would ask the same question for ever.
- **It does not expire on world signal**, unlike the `unclear` arm. A comment or a link is how a human
  answers "I could not act on this goal"; it is not how they authorise spending more than the rule
  allows. Three things end it: the operator answering, the ticket being rewritten (a new fingerprint,
  so a re-assay proposes against the current text), and `clearAssay`.

The tag therefore holds the **resolved answer**, not an operator override sitting beside an inferred
one — which is what collapses the precedence chain to one lookup at dispatch. Who decided is still
answerable: the assay row keeps what was proposed, and a difference between it and the tag is a human
having intervened.

### Provider targets

| Key                                           | Type                            | Default   | Behaviour                                            |
| --------------------------------------------- | ------------------------------- | --------- | ---------------------------------------------------- |
| `integrations.sourceControl`                  | `'fake' \| 'github' \| 'azure'` | `'fake'`  | Who supplies pull requests.                          |
| `integrations.issues`                         | `'fake' \| 'github' \| 'azure'` | `'fake'`  | Who supplies issues / work items.                    |
| `github.owner`, `github.repo`                 | `string`                        | unset     | Required when any capability uses `github`.          |
| `azureDevOps.organization/project/repository` | `string`                        | unset     | Required when any capability uses `azure`.           |
| `azureDevOps.filters.workItemTag`             | `string` (optional)             | unset     | Only surface work items carrying this tag.           |
| `azureDevOps.policyChecks`                    | kind → mode map (optional)      | see below | Which branch-policy kinds become CI checks, and how. |

### `userId`

**Who you are, to every provider the harness talks to.** One string, and the only place the harness
is told whose queue it works.

It replaced six keys that were all the same fact spelled per provider and per use —
`issuePickupRequireOwnLabel`, both `defaultAssignee`s, both `filters.prAuthor`s, and
`filters.workItemAssignedTo`. Setting it turns on three gates together, because they are one intent:

| Gate           | What it does                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------- |
| **Ownership**  | `${labelPrefix}-watch` only counts if **you** added it, so nobody else can tag work onto the fleet. |
| **Assignment** | Tickets the harness _files_ are assigned to you.                                                    |
| **Authorship** | Only pull requests you opened are surfaced — which is also what lets a merged branch be reaped.     |

**One string rather than one per provider**, though a GitHub login and an Azure UPN are different
identities. One project is worked at a time and each project carries its own `lubbdubb.config.json`,
so the identity that is correct is whichever provider `integrations` selects: a login where that is
`github`, a UPN where it is `azure`. Only one is ever in force, so there is nothing for a second key
to disagree with.

**Unset, all three gates are off**: any tagger counts, filed tickets go unassigned, and every open
pull request is surfaced. That is the first-run and test posture, and it is why the key is optional —
the `fake` provider resolves no identity at all, and a harness that demanded one could not boot
against it.

#### How assignment reaches the agent

It rides inside the **tracker coordinates** rather than as a prompt placeholder (`ticketAssignment`,
`src/ticketAssignment.ts`), which is what keeps it working under an operator's prompt override:
`{tracker}` is already rendered by all four filing templates ([13](13-jobs-and-findings.md)), while a
new `{assignee}` token would be dropped silently by every override written before it. Concretely, the
create command grows `--assignee <login>` / `--assigned-to "<upn>"` — the flag spelling is the
tracker's business, and the only thing still resolved per provider — followed by a paragraph saying
the flag is not optional, applies only to an item the agent **creates** (linking an existing one
leaves its assignee alone), and must not cost the ticket if the tracker refuses the identity.

Assignment applies to the four filing arms and to nothing the harness merely reads: it is not a
filter, and it never narrows pickup. The narrowing is the other two gates, and they are separate
mechanisms that happen to share a name.

### What type a filed item is

`issueFilingTypes` is the closed set of Azure work item types the harness may **create**, and the
filing agent picks one from it (`ticketTypeGuidance`, `src/ticketTypes.ts`). The three non-bug filing
arms — a deferred finding, a blueprint, unrecorded work — used to hardcode `--type Task`, which is
the altitude a story is **broken down** at rather than the one a backlog is filed at: an item created
there has no story above it, rolls up to nothing, and appears on no backlog anybody grooms. A raised
bug is the fourth arm and does not consult the list; what it is filing was never in question.

Which type a given report is, is left to the agent on the same argument that leaves it the wording:
it is a judgement about the report, and only the agent has read it. What the harness supplies is the
menu and the prohibition — the list is closed, a decomposition type is named and refused outright
(the failure this exists to stop; "pick the right one" does not read to an agent as excluding the one
it has always picked), and an imperfect fit resolves to the nearest entry rather than an invented
type, because Azure refuses a type the project does not define and the ticket is lost with it.

It reaches the agent the same way assignment does and for the same reason: spliced into the create
command inside `{tracker}`, never as a `{type}` placeholder an older override would drop. The default
`["User Story", "Bug"]` is the Agile template's names, on the reasoning `issueContainerTypes` already
uses; a Scrum project sets `["Product Backlog Item", "Bug"]`, and a process extended with a custom
type lists it (`["User Story", "Tech Debt", "Bug"]`). Names are passed to `az` verbatim. Unlike
`issueContainerTypes` there is no "off" — a work item is created _as_ something, so `[]` falls back
to the default rather than emitting a create with no `--type`. A single-entry list is spliced in
literally and the agent is given no choice to make. GitHub is untouched throughout: an issue carries
no type, so its coordinates read exactly as they always did.

### `azureDevOps.policyChecks`

Azure gates a PR with **branch policies**, only some of which are automated checks. Each policy
classifies into a kind — `build`, `status`, `comments`, `workItems`, `reviewers`, `mergeStrategy`,
`other` — and each kind is surfaced in one of three modes:

| Mode       | Effect                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------- |
| `check`    | An ordinary `CiCheck`: visible, routable by a `ci.checks` rule, dispatchable.                |
| `advisory` | Visible, and structurally unable to dispatch or escalate — no `ci.checks` rule can claim it. |
| `off`      | Not emitted.                                                                                 |

Defaults: `build` and `status` are `check`, `comments` is `advisory`, everything else is `off`. An
unknown kind or mode throws at load. A **disabled** policy is dropped whatever its mode.

`build`/`status` at `check` include **Optional** (non-blocking) policies, which carry
`blocking: false`. Such a check really does fail and an agent really can fix it, so rule `pr-ci-failing` dispatches
for it — while `aggregatePolicyCiStatus` folds enabled, blocking build/status policies only, so
`prHealth`'s blocked verdict and the merge rule are untouched. **No value here can reach `ciStatus`**,
which is what keeps "the harness will fix this" from ever becoming "the PR cannot merge".

`comments` defaults to `advisory` rather than `check` because the harness already models that signal
at higher fidelity: rule `pr-review-comment` acts per unresolved thread, with the author and body in the prompt. As an
ordinary check it would restate the same fact as a second concern on the same PR under a different
origin (`pr:<n>:ci`), carrying the generic CI-fix prompt — the same work with strictly less
information, and a PR that reads as CI-failing for as long as a review is open.

Work-item linking is `off` by default; promoting it means an agent making writes against a tracker.
To have an agent fix it:

```jsonc
{
  "azureDevOps": { "policyChecks": { "workItems": "check" } },
  "ci": {
    "checks": [
      {
        "match": "Work item linking",
        "onFailure": "dispatch",
        "guidance": "Link the work item with `az repos pr work-item add --id <pr> --work-items <n>`. The work item number is the `<n>` in the branch name `issue/<n>`.",
      },
    ],
  },
}
```

No outbound capability is involved: the agent makes the link with a tool it already has, and
`guidance` is the channel that tells it how.

## Secrets

Credentials are **never** read from `Config` or from `lubbdubb.config.json`, so a secret cannot be
committed:

- **GitHub** — the token comes from `GITHUB_TOKEN` only. Selecting `github` without it, or without
  `github.owner`/`github.repo`, throws a clear error at `buildIntegrations` time (boot), not later as
  a network failure.
- **Azure DevOps** — `AZURE_DEVOPS_PAT` (Basic auth) is preferred; if unset, the logged-in `az` CLI
  is used (Bearer, cached). Auth is resolved lazily, so a missing login surfaces as a recorded
  connector error at snapshot time rather than blocking boot. A missing **target** is still a boot
  error.
- **Model credentials are inherited**, not supplied. Agents spawn with `{...process.env, ...spec.env}`
  plus only `LUBBDUBB_PROMPT`, `LUBBDUBB_TASK_ID`, and the status-file / events-dir variables. In
  non-interactive mode `claude` always uses `ANTHROPIC_API_KEY` when it is present, with no approval
  prompt, so a stray exported key moves the whole fleet onto API billing. The harness never sets one.

## Example

`lubbdubb.config.example.json` at the repo root is a complete, commented example of every key.
