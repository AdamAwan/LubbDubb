# 02 — Configuration

All configuration lives in `src/config.ts` as the `Config` interface, its `DEFAULTS`, and
`loadConfig()`. There is no other configuration mechanism.

## Precedence

Values are merged in this order, later winning:

1. `DEFAULTS` (in `src/config.ts`)
2. `lubbdubb.config.json`, read from `process.cwd()` — absent is fine; unparseable throws with the
   file path and the parse error
3. Environment overrides: `PORT` → `port`, `LUBBDUBB_HOST` → `host`, `LUBBDUBB_DB` → `dbPath`,
   `LUBBDUBB_REPO_ROOT` → `repoRoot`
4. Explicit `overrides` passed to `loadConfig(overrides)` (tests, embedding)

Eight keys are **deep-merged** rather than replaced, so a config file can set one field of them
without dropping the rest: `autoSend`, `integrations`, `planning`, `assessment`, `assay`,
`retrospective`, `mcp`, `auth`. Everything else — including `issuePriorityLabels` and `ci.checks` —
is replaced wholesale.

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
- `worktreeRoot`, `deskRoot` and `promptTemplatesDir` are resolved against **`repoRoot`** (not the
  launch directory), so running LubbDubb from its own folder against a repo elsewhere does not
  scatter that repo's worktrees into the app's directory. An absolute override is honoured as-is.
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

| Key             | Type     | Default               | Behaviour                                                                                                                             |
| --------------- | -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `repoRoot`      | `string` | `process.cwd()`       | The git repository worktrees are cut from. Overridable via `LUBBDUBB_REPO_ROOT`.                                                      |
| `defaultBranch` | `string` | `"main"`              | The integration branch. A new agent branch is cut from it, and a PR targeting anything else is treated as stacked. Not auto-detected. |
| `worktreeRoot`  | `string` | `.lubbdubb/worktrees` | Root for per-branch worktrees.                                                                                                        |
| `deskRoot`      | `string` | `.lubbdubb/desk`      | Root for desk-task scratch directories (one per task id).                                                                             |

### Dispatch behaviour

| Key                   | Type            | Default                                                                          | Behaviour                                                                                                                                                                                                                                               |                                                                                                               |
| --------------------- | --------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `autoSend`            | object          | `{ enabled: false, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] }` | The confidence gate on side-effectful actions. See [09](09-execution.md).                                                                                                                                                                               |                                                                                                               |
| `promptTemplatesDir`  | `string`        | `.lubbdubb/prompts`                                                              | Directory of `<prompt-id>.md` overrides, read once at boot. Absent directory = all built-in defaults.                                                                                                                                                   |                                                                                                               |
| `closedPrWindowMs`    | `number`        | `21600000` (6h)                                                                  | How far back providers look for PRs that left the open set. `0` disables the lookup entirely.                                                                                                                                                           |                                                                                                               |
| `upNextOverrideTtlMs` | `number`        | `604800000` (7d)                                                                 | How long an operator "Up next" priority override (issue #128) survives after its origin stops being tracked. `0` disables pruning.                                                                                                                      |                                                                                                               |
| `ci.checks`           | `CiCheckRule[]` | `[]`                                                                             | Per-check CI policy: what rule `pr-ci-failing` does about _which_ check went red. Ordered, first match wins, replaced wholesale by an override. Empty — and any check matching no rule — is the pre-policy behaviour: dispatch a code agent. See below. |                                                                                                               |

#### Per-check CI policy (`ci.checks`)

A failing check is matched against each rule's `match` **glob** in order (`*` = any
run of characters, `?` = exactly one, everything else literal, matched
case-insensitively); the first match decides it.

| Field       | Type                                   | Default    | Behaviour                                                                                                                         |
| ----------- | -------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `match`     | `string`                               | (required) | Glob against the check name (`lint`, `test (*)`, `deploy-*`).                                                                     |
| `onFailure` | `'dispatch' \| 'ignore' \| 'escalate'` | `'ignore'` | What this failure makes the harness do. The default is `ignore` because the usual reason to name a check is to stop acting on it. |
| `guidance`  | `string`                               | unset      | Appended to the dispatched agent's prompt when this check is among the failures. Only legal with `onFailure: 'dispatch'`.         |
| `urgent`    | `boolean`                              | `false`    | Sort this PR's concern ahead of every other PR concern this cycle. Only legal with `onFailure: 'dispatch'`.                       |

Verdict per PR, not per check — one agent works a branch, so all its failures are
one job:

- **Anything actionable** → one agent on `pr:<n>:ci`, with every matched
  `guidance` appended, and the held checks named so the agent doesn't chase
  them.
- **Nothing actionable, something escalating** → rule `pr-ci-blocked` asks a human once (held
  by an open item on the same origin, or a recent one in the audit log).
- **Nothing actionable, nothing escalating** → nothing happens. The PR sits red
  and `prHealth` names the failing checks. Re-evaluated every pulse, so it moves
  on its own the moment an actionable check goes red or the held one recovers.

`loadConfig` **throws** on `guidance` or `urgent` attached to a rule that never
dispatches: both are written for an agent that would never be sent, and dropping
them silently is the failure worth catching at boot.

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
      { "match": "infra-*", "onFailure": "escalate" }
    ]
  }
}
```

### Item selection (labels, priority, states)

| Key                          | Type                     | Default                                                           | Behaviour                                                                                                               |
| ---------------------------- | ------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `labelPrefix`                | `string`                 | `"lubbdubb"`                                                      | Derives the tag pair `${prefix}-watch` / `${prefix}-ignore`. An **empty** prefix turns both gates off.                  |
| `issuePickupRequireOwnLabel` | `boolean`                | `false`                                                           | When on, the watch tag only counts if the authenticated viewer added it. Needs a real provider; fails closed on `fake`. |
| `issuePriorityLabels`        | `Record<string, number>` | `{ 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 }` | Label → weight for pickup ordering. Replaced wholesale by an override.                                                  |
| `issueDefaultPriority`       | `number`                 | `2`                                                               | Weight for an issue with no matching priority label.                                                                    |
| `issuePickupStates`          | `string[]` (optional)    | unset                                                             | When non-empty, only items whose provider-native state is listed are eligible. Items with no such state bypass it.      |
| `issueInReviewState`         | `string` (optional)      | unset                                                             | The state an item is moved to once a PR is open for it. Takes effect only alongside `issuePickupStates`.                |

### Feature policies

| Key                                   | Type      | Default | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | --------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planning.enabled`                    | `boolean` | `true`  | The multi-PR planning funnel. **On by default**; off leaves it out entirely — rule `issue-pickup` is un-narrowed and no planner ever runs.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `planning.maxConcurrentPartsPerIssue` | `number`  | `2`     | How many parts of one plan may have live agents at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `planning.requireApproval`            | `boolean` | `true`  | Put a `parts` verdict to a human before anything is scheduled from it — approve-before rather than replan-after. On, ingestion persists the decomposition as `awaiting_approval`, rule `plan-approval` proposes it once, and rule `plan-part` queues its ready parts as `unapproved` until you accept; rejecting retires the parts nothing was started for and works the issue as one PR. Off leaves an enabled funnel byte-for-byte as it was: a decomposition commits the moment the planner writes it. A `single` verdict is never gated. |
| `planning.gitFetchIntervalMs`         | `number`  | `60000` | Floor on how often plan reconciliation runs `git fetch`. `0` = every pulse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `assessment.enabled`                  | `boolean` | `true`  | Rule `issue-assess`, the assessor: ask whether an issue that has had work and has nothing in flight is finished, and park it as `delivered` if so. **On by default**, and not purely additive — it gates pickup and spends an agent per assessed issue. Off, no assessor runs, no verdict is written, and rule `issue-pickup` behaves as it did before the assessor existed, which on GitHub means a merged PR's issue is picked up again.                                                                                                   |
| `assay.enabled`                       | `boolean` | `true`  | Rule `issue-assay`, the goal assay: ask whether a fresh issue's _text_ can be worked from at all before anything is dispatched against it, and hold it out of planning and pickup while the answer is `unclear`. **On by default**, with the cumulative cost named — with `planning`, `assessment`, this and `retrospective` all on, one issue can spend an assayer, a planner, its part agents, an assessor and a writer. Off, no assayer runs, no verdict is written, and every gate in front of an issue behaves as it did.               |
| `retrospective.enabled`               | `boolean` | `true`  | Rule `issue-retro`, the retrospective: one desk agent writing up a goal the harness has parked as `delivered` — what shipped, and what came out of the process of shipping it, from the issue's scratchpad plus the record the harness kept. **On by default**, and unlike the three above it gates nothing: it runs once, after the work is over, so it can neither park an issue nor delay anything. Off, the Goal Floor's Manifest station reads _Nothing written_ and no agent is spent.                                                 |
| `mcp.enabled`                         | `boolean` | `true`  | The agent tool channel. **On by default**, because it is purely additive; off leaves agents on the sentinels alone.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `mcp.permissionEscalation`            | `boolean` | `true`  | The permission backstop (`--permission-prompt-tool`). A tool call the `agentAllowedTools` list doesn't cover is routed to the operator (allow/deny in "Needs you") instead of hanging. Gated by `mcp.enabled` — the tool lives on the MCP server. Off falls back to Claude's default headless deny.                                                                                                                                                                                                                                          |

### Agent launch

| Key                     | Type                            | Default                 | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentMode`             | `'stream' \| 'pty' \| 'raw'`    | `'stream'`              | Which runtime launches agents.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `claudeCommand`         | `string`                        | `'claude'`              | The command spawned for an agent.                                                                                                                                                                                                                                                                                                                                                              |
| `claudeArgs`            | `string[]`                      | `[]`                    | Extra args, appended **after** the harness's own, so an explicit flag there has the last word.                                                                                                                                                                                                                                                                                                                                   |
| `agentPermissionMode`   | `string`                        | `'acceptEdits'`         | Passed to `--permission-mode`. `acceptEdits` auto-accepts file edits only. `bypassPermissions` maps to `--dangerously-skip-permissions`, which `claude` refuses under root.                                                                                                                                                                                                                                                      |
| `agentAllowedTools`     | `string[]`                      | JS toolchain + git + gh | Tool allow rules merged into `--settings` as `permissions.allow` (Claude Code syntax, e.g. `Bash(npm:*)`). Pre-approves the mechanical validate/commit/push commands so the default config completes a task unattended without `bypassPermissions`. Never on `--allowedTools` (that carries the MCP grants). Default: `Bash(npm:*)`, `Bash(npx:*)`, `Bash(pnpm:*)`, `Bash(yarn:*)`, `Bash(node:*)`, `Bash(git:*)`, `Bash(gh:*)`. |
| `agentPromptDelayMs`    | `number`                        | `1200`                  | Delay before the first message is delivered, giving an interactive REPL time to boot. Stream mode uses `0`.                                                                                                                                                                                                                                                                                                                      |
| `agentSubmitDelayMs`    | `number`                        | `60`                    | PTY only: gap between writing message text and writing the submitting carriage return.                                                                                                                                                                                                                                                                                                                                           |
| `agentIdleWaitMs`       | `number`                        | `90000`                 | PTY (real TUI) only: park a session as waiting after this long with no terminal output. `0` disables. Unlatched — output un-parks it.                                                                                                                                                                                                                                                                                            |
| `agentWaitingPatterns`  | `string[]`                      | `[]`                    | Extra literal substrings a PTY session treats as "waiting for input".                                                                                                                                                                                                                                                                                                                                                            |
| `whitelistedApprovals`  | `{match, response}[]`           | `[]`                    | Waiting prompts containing `match` are auto-answered with `response` instead of escalating.                                                                                                                                                                                                                                                                                                                                      |
| `sessionTranscriptRoot` | `string` (optional)             | `~/.claude/projects`    | Where Claude Code writes session transcripts, which PTY mode tails. Override only if the agent runs under a different HOME.                                                                                                                                                                                                                                                                                                      |
| `docsFolderPrefix`      | `string \| string[]` (optional) | unset                   | Folder(s) whose files are promoted to artifact chips regardless of extension. Absolute entries also widen the artifact-serving boundary.                                                                                                                                                                                                                                                                                         |

### Provider targets

| Key                                           | Type                            | Default   | Behaviour                                            |
| --------------------------------------------- | ------------------------------- | --------- | ---------------------------------------------------- |
| `integrations.sourceControl`                  | `'fake' \| 'github' \| 'azure'` | `'fake'`  | Who supplies pull requests.                          |
| `integrations.issues`                         | `'fake' \| 'github' \| 'azure'` | `'fake'`  | Who supplies issues / work items.                    |
| `github.owner`, `github.repo`                 | `string`                        | unset     | Required when any capability uses `github`.          |
| `github.filters.prAuthor`                     | `string` (optional)             | unset     | Only surface PRs opened by this login.               |
| `azureDevOps.organization/project/repository` | `string`                        | unset     | Required when any capability uses `azure`.           |
| `azureDevOps.filters.prAuthor`                | `string` (optional)             | unset     | Only surface PRs opened by this UPN.                 |
| `azureDevOps.filters.workItemTag`             | `string` (optional)             | unset     | Only surface work items carrying this tag.           |
| `azureDevOps.filters.workItemAssignedTo`      | `string` (optional)             | unset     | Only surface work items assigned to this UPN.        |
| `azureDevOps.policyChecks`                    | kind → mode map (optional)      | see below | Which branch-policy kinds become CI checks, and how. |

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
ordinary check it would let rule `pr-ci-failing` outrank rule `pr-review-comment` and send the generic CI-fix prompt instead — the
same work with strictly less information.

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
