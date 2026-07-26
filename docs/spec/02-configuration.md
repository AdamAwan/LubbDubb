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

Five keys are **deep-merged** rather than replaced, so a config file can set one field of them
without dropping the rest: `autoSend`, `integrations`, `planning`, `mcp`, `auth`. Everything else —
including `issuePriorityLabels` — is replaced wholesale.

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

| Key                   | Type      | Default   | Behaviour                                                                                                                     |
| --------------------- | --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `heartbeatIntervalMs` | `number`  | `300000`  | Gap between timer-driven cycles.                                                                                              |
| `maxConcurrentAgents` | `number`  | `3`       | Seeds the runtime cap. Live changes go through `POST /api/control` and are **not** persisted.                                  |
| `startPaused`         | `boolean` | `false`   | Seeds the runtime pause flag. The only config-level pause knob; live pause/resume is ephemeral, so a restart reverts to this.  |
| `port`                | `number`  | `4300`    | HTTP/WS port. Overridable via `PORT`.                                                                                         |
| `host`                | `string`  | `127.0.0.1` | Bind address. Loopback by default; `"0.0.0.0"` exposes the cockpit on the network and then requires `auth.enabled`. Overridable via `LUBBDUBB_HOST`. |
| `auth.enabled`        | `boolean` | `true`    | Require a bearer token on `/api/*` and `/ws`. See [16 — HTTP API](16-http-api.md#authentication).                              |
| `auth.tokenFile`      | `string`  | `.lubbdubb/cockpit-token` | Where a minted token is persisted (0600). Ignored when `LUBBDUBB_TOKEN` is set.                             |
| `dbPath`              | `string`  | `.lubbdubb/lubbdubb.sqlite` | SQLite file. Overridable via `LUBBDUBB_DB`. `:memory:` is supported (tests).                                |

### Repository

| Key             | Type     | Default                  | Behaviour                                                                                                                        |
| --------------- | -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `repoRoot`      | `string` | `process.cwd()`          | The git repository worktrees are cut from. Overridable via `LUBBDUBB_REPO_ROOT`.                                                 |
| `defaultBranch` | `string` | `"main"`                 | The integration branch. A new agent branch is cut from it, and a PR targeting anything else is treated as stacked. Not auto-detected. |
| `worktreeRoot`  | `string` | `.lubbdubb/worktrees`    | Root for per-branch worktrees.                                                                                                   |
| `deskRoot`      | `string` | `.lubbdubb/desk`         | Root for desk-task scratch directories (one per task id).                                                                        |

### Dispatch behaviour

| Key                          | Type                          | Default                                                        | Behaviour                                                                                                     |
| ---------------------------- | ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `dispatcher`                 | `'rule' \| 'claude'`          | `'rule'`                                                        | Which dispatcher decides. Only `rule` implements prompt templates, the planning funnel and the Up next queue.  |
| `steeringPriorities`         | `string[]`                    | `[]`                                                            | Ordered hints. Injected into the `claude` dispatcher's prompt; carried in the state snapshot for display.      |
| `autoSend`                   | object                        | `{ enabled: false, confidenceThreshold: 0.85, allowedActions: ['reply_on_pr'] }` | The confidence gate on side-effectful actions. See [09](09-execution.md). |
| `promptTemplatesDir`         | `string`                      | `.lubbdubb/prompts`                                             | Directory of `<prompt-id>.md` overrides, read once at boot. Absent directory = all built-in defaults.          |
| `closedPrWindowMs`           | `number`                      | `21600000` (6h)                                                 | How far back providers look for PRs that left the open set. `0` disables the lookup entirely.                  |

### Item selection (labels, priority, states)

| Key                          | Type                       | Default                                                     | Behaviour                                                                                                            |
| ---------------------------- | -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `labelPrefix`                | `string`                   | `"lubbdubb"`                                                 | Derives the tag pair `${prefix}-watch` / `${prefix}-ignore`. An **empty** prefix turns both gates off.                |
| `issuePickupRequireOwnLabel` | `boolean`                  | `false`                                                      | When on, the watch tag only counts if the authenticated viewer added it. Needs a real provider; fails closed on `fake`. |
| `issuePriorityLabels`        | `Record<string, number>`   | `{ 'priority:high': 3, 'priority:medium': 2, 'priority:low': 1 }` | Label → weight for pickup ordering. Replaced wholesale by an override.                                            |
| `issueDefaultPriority`       | `number`                   | `2`                                                          | Weight for an issue with no matching priority label.                                                                 |
| `issuePickupStates`          | `string[]` (optional)      | unset                                                        | When non-empty, only items whose provider-native state is listed are eligible. Items with no such state bypass it.    |
| `issueInReviewState`         | `string` (optional)        | unset                                                        | The state an item is moved to once a PR is open for it. Takes effect only alongside `issuePickupStates`.              |

### Feature policies

| Key                                 | Type      | Default   | Behaviour                                                                                                              |
| ----------------------------------- | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `planning.enabled`                  | `boolean` | `false`   | The multi-PR planning funnel. **Off by default**, and off leaves it out entirely — rule 4 is un-narrowed and no planner ever runs. |
| `planning.maxConcurrentPartsPerIssue` | `number` | `2`       | How many parts of one plan may have live agents at once.                                                               |
| `planning.requireApproval`          | `boolean` | `false`   | Put a `parts` verdict to a human before anything is scheduled from it. Off leaves an enabled funnel byte-for-byte as it was: a decomposition commits the moment the planner writes it. |
| `planning.gitFetchIntervalMs`       | `number`  | `60000`   | Floor on how often plan reconciliation runs `git fetch`. `0` = every pulse.                                             |
| `mcp.enabled`                       | `boolean` | `true`    | The agent tool channel. **On by default**, because it is purely additive; off leaves agents on the sentinels alone.     |
| `mcp.permissionEscalation`          | `boolean` | `true`    | The permission backstop (`--permission-prompt-tool`). A tool call the `agentAllowedTools` list doesn't cover is routed to the operator (allow/deny in "Needs you") instead of hanging. Gated by `mcp.enabled` — the tool lives on the MCP server. Off falls back to Claude's default headless deny. |

### Agent launch

| Key                       | Type                            | Default        | Behaviour                                                                                                                        |
| ------------------------- | ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `agentMode`               | `'stream' \| 'pty' \| 'raw'`    | `'stream'`     | Which runtime launches agents.                                                                                                   |
| `claudeCommand`           | `string`                        | `'claude'`     | The command spawned for an agent (and for the `claude` dispatcher).                                                              |
| `claudeArgs`              | `string[]`                      | `[]`           | Extra args, appended **after** the harness's own, so an explicit flag there has the last word.                                    |
| `agentPermissionMode`     | `string`                        | `'acceptEdits'`| Passed to `--permission-mode`. `acceptEdits` auto-accepts file edits only. `bypassPermissions` maps to `--dangerously-skip-permissions`, which `claude` refuses under root. |
| `agentAllowedTools`       | `string[]`                      | JS toolchain + git + gh | Tool allow rules merged into `--settings` as `permissions.allow` (Claude Code syntax, e.g. `Bash(npm:*)`). Pre-approves the mechanical validate/commit/push commands so the default config completes a task unattended without `bypassPermissions`. Never on `--allowedTools` (that carries the MCP grants). Default: `Bash(npm:*)`, `Bash(npx:*)`, `Bash(pnpm:*)`, `Bash(yarn:*)`, `Bash(node:*)`, `Bash(git:*)`, `Bash(gh:*)`. |
| `agentPromptDelayMs`      | `number`                        | `1200`         | Delay before the first message is delivered, giving an interactive REPL time to boot. Stream mode uses `0`.                       |
| `agentSubmitDelayMs`      | `number`                        | `60`           | PTY only: gap between writing message text and writing the submitting carriage return.                                            |
| `agentIdleWaitMs`         | `number`                        | `90000`        | PTY (real TUI) only: park a session as waiting after this long with no terminal output. `0` disables. Unlatched — output un-parks it. |
| `agentWaitingPatterns`    | `string[]`                      | `[]`           | Extra literal substrings a PTY session treats as "waiting for input".                                                            |
| `whitelistedApprovals`    | `{match, response}[]`           | `[]`           | Waiting prompts containing `match` are auto-answered with `response` instead of escalating.                                       |
| `sessionTranscriptRoot`   | `string` (optional)             | `~/.claude/projects` | Where Claude Code writes session transcripts, which PTY mode tails. Override only if the agent runs under a different HOME.  |
| `docsFolderPrefix`        | `string \| string[]` (optional) | unset          | Folder(s) whose files are promoted to artifact chips regardless of extension. Absolute entries also widen the artifact-serving boundary. |

### Provider targets

| Key                                    | Type                              | Default                                                    | Behaviour                                                                       |
| -------------------------------------- | --------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `integrations.sourceControl`           | `'fake' \| 'github' \| 'azure'`   | `'fake'`                                                    | Who supplies pull requests.                                                     |
| `integrations.issues`                  | `'fake' \| 'github' \| 'azure'`   | `'fake'`                                                    | Who supplies issues / work items.                                               |
| `integrations.backlog`                 | `'fake'`                          | `'fake'`                                                    | Who supplies stories. `fake` is the only registered provider.                    |
| `github.owner`, `github.repo`          | `string`                          | unset                                                       | Required when any capability uses `github`.                                     |
| `github.filters.prAuthor`              | `string` (optional)               | unset                                                       | Only surface PRs opened by this login.                                          |
| `azureDevOps.organization/project/repository` | `string`                   | unset                                                       | Required when any capability uses `azure`.                                      |
| `azureDevOps.filters.prAuthor`         | `string` (optional)               | unset                                                       | Only surface PRs opened by this UPN.                                            |
| `azureDevOps.filters.workItemTag`      | `string` (optional)               | unset                                                       | Only surface work items carrying this tag.                                      |
| `azureDevOps.filters.workItemAssignedTo` | `string` (optional)             | unset                                                       | Only surface work items assigned to this UPN.                                   |

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
