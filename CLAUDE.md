# CLAUDE.md

Operating notes for AI agents working in this repo. The [README](README.md) covers what
LubbDubb _is_ and how to run it — this file is the stuff you need to change code safely and
not trip the CI gate. Read the README's Architecture table once; it won't be repeated here.

## Verify before you commit

One command is the source of truth, and CI enforces the same thing on every PR:

```bash
npm run check   # = format:check && lint && typecheck && typecheck:web && knip && test
```

Run it before committing. Notable failure modes that aren't obvious:

- **knip** fails the build on _unused files, exports, or dependencies_. If you add an
  `export` nothing imports, or a dependency you don't end up using, `check` goes red. Remove
  dead code or wire it up.
- **Two typecheckers**: `typecheck` (server, `tsconfig.json`) and `typecheck:web` (cockpit,
  `web/tsconfig.json`) are separate passes. A change spanning `src/` and `web/` must satisfy
  both.
- **format:check** is Prettier in check mode — run `npm run format` (or
  `npx prettier --write <files>`) to fix, don't hand-format.

Tests are `node:test` run through `tsx` (`npm test`). `npm run smoke` is a real end-to-end
run (real `node-pty` + a git worktree); the unit/integration suite does **not** need native
processes because it injects fakes (see Testing below).

## Fresh clone

`node_modules` is not committed and **`better-sqlite3` and `node-pty` are native builds**, so
a clean checkout needs `npm ci` (or `npm install`) before anything runs — and it isn't
instant. `npm run web:build` bundles the cockpit SPA into `web/dist`, which the server serves
in production.

## Conventions

- **ESM with explicit `.js` import extensions**, even from `.ts` sources:
  `import { Store } from './store/store.js';`. New files must follow this or module resolution
  breaks. `type: "module"`, TS `nodenext`.
- **Comments explain _why_, not _what_** — match the existing terse, high-signal style. Don't
  narrate the code.
- **Typed `emit`/`on` overrides** on `EventEmitter` subclasses (see `AgentManager`) — keep
  event payloads typed at the call site when you add events.
- Domain types live in `src/types.ts`; the cockpit has its own `web/src/types.ts` (they are
  intentionally separate — the web bundle doesn't import server code).

## Where things live

- **`src/system.ts` is the composition root.** Every module is wired here through its
  interface, so any one is swappable. If you add a component, thread it through here.
- **`src/store/store.ts` is the _only_ thing that touches SQLite.** Everything else goes
  through the `Store`. Schema is `src/store/schema.ts`. Writes are synchronous
  (better-sqlite3), which keeps the harness logic race-free — lean on that. `CREATE TABLE IF
NOT EXISTS` never alters an existing table, so a **column added to an existing table** needs
  an additive `ALTER TABLE` in `Store.migrate()` (guarded by a `PRAGMA table_info` check) or it
  won't appear on databases from an older build.
- **`src/dispatcher/rules.ts`** is the RuleDispatcher's rule book as data (`DISPATCH_RULES`):
  every action the rule dispatcher emits carries a `rule` id from it, the store lifts the id
  into the `decisions.rule` column at `recordDecision` time, and `/api/state` ships the
  registry so the cockpit's Decision log can expand a row into the rule that fired. If you add
  a dispatcher branch, add its registry entry and tag the emitted actions. LLM-dispatcher
  actions carry no rule (null) by design.
- **Operator-launched jobs (the `jobs` table + rule 0).** A job is an ad-hoc prompt queued from
  the cockpit (`POST /api/jobs` → `Store.createJob`, status `queued`). Unlike a `Task` (created
  the instant an agent spawns), a job persists _ahead of_ dispatch so it can sit in a queue when
  the fleet is at capacity. The dispatcher drains queued jobs (`DispatchContext.queuedJobs`, wired
  from `store.listQueuedJobs()`) **before any world-driven rule** — rule `manual-job` (number `0`)
  in `ruleDispatcher.ts` — claiming headroom first so a manual request takes the next free slot;
  the ClaudeDispatcher gets the same queue in its prompt. The emitted `dispatch_*` action carries a
  `jobId`, and the executor calls `Store.markJobDispatched(jobId, task.id)` **only after** the agent
  actually spawns — so a job the cap/pause gate holds stays `queued` and is retried next cycle (the
  queue behaviour is the soft headroom gate: at capacity the dispatcher advertises zero headroom, so
  the job isn't planned, not that the executor defers it). `Store.cancelJob` drops a still-queued job;
  a dispatched one is a live agent (kill it instead). The `jobs` table is a fresh `CREATE TABLE`, so no
  `migrate()` entry is needed. Tests: `test/jobQueue.test.ts`.
- **`src/harness.ts`** is the pulse: snapshot world → diff against the previous snapshot
  (`src/world/worldDiff.ts`, persisted as `world_events` + streamed as `world:events` for the
  cockpit's Activity feed) → `Dispatcher.decide` → `ActionExecutor` → audit. Cycles are
  coalesced (one in flight at a time).
- **`reconcileAndResumeOnBoot` in `src/system.ts`** runs once at boot, _before_
  `harness.runCycle('boot')`, so resumed agents occupy their concurrency slots before new work
  is dispatched. See "Resume on boot" below.
- **`src/runtimeControl.ts`** holds the live, in-memory dispatch controls (`cap` +
  `paused`), seeded from `maxConcurrentAgents`/`startPaused` at boot. Both the `Harness`
  (headroom) and `ActionExecutor` (the hard dispatch gate) read it **by reference** each
  cycle — never copy `.cap`/`.paused` into a local at wiring time or runtime changes stop
  taking effect. Mutated via `POST /api/control`; **not persisted**, so a restart reverts
  to config. Pausing defers only `dispatch_*` actions (escalate/answer/etc. still run) and
  scaling the cap down never kills a live agent — both deferrals are audited with a reason.
- **`src/errorLog.ts`** is the one error-recording path. Anything that catches a failure —
  the harness's cycle `catch`, provider snapshot `catch`es (via the optional `errors` in
  `IntegrationContext`/provider opts), `AgentManager` terminal failures (with the exit code
  captured from the session's `exit` event), the Fastify `setErrorHandler`, boot resume —
  calls `errors.record(...)`, which persists to the `error_events` table, mirrors to stderr,
  and emits `logged` (fanned out over WS for the cockpit's Errors panel). Don't add new
  swallowed `catch`es; route them here. The event is named `logged`, not `error` — an
  unlistened `error` event throws, and recording a failure must never throw. Tests silence
  the stderr mirror with `buildSystem(config, { errorMirror: () => {} })`.
- **Server surface** is `src/server/app.ts` (Fastify REST + the `/ws` route) and
  `src/server/hub.ts` (fans harness/agent events out to sockets). The cockpit SPA is under
  `web/`.

## Agent runtimes (the part that surprises people)

There are **two interchangeable agent runtimes**, both implementing `AgentSession`
(`src/agents/session.ts`) and emitting the _same_ events
(`output`/`waiting`/`done`/`failed`/`status`/`exit`). `AgentManager`, the `Hub`, and the
cockpit are agnostic to which is running:

- **`StreamJsonSession`** (`agentMode: 'stream'`, the **production default**) — real `claude`
  over headless stream-JSON. No PTY, no TUI. This is what runs by default, so "how agents run"
  is usually _not_ a terminal.
- **`PtySession`** (`agentMode: 'pty'`/`'raw'`, and the `ClaudeDispatcher`) — a real
  pseudoterminal via `node-pty`. All the fiddly "is it waiting / is it done" heuristics live
  here behind one testable abstraction (`src/pty/backend.ts` is the swappable spawn seam).

Both speak the **sentinel protocol**: an agent prints `@@LUBBDUBB_DONE@@` when finished and
`@@LUBBDUBB_WAITING:<reason>@@` when it needs a human. These are reserved control strings —
they are detected for status transitions _and_ stripped from displayed output. The protocol
strings and the pure `stripSentinels`/`extractWaitingReason` helpers live in
`src/agents/sentinels.ts`; both runtimes use them. If you touch detection, keep the two
behaviors in sync. `PtySession` additionally handles the cross-chunk case (a sentinel split
across two PTY data chunks); on the line-delimited stream-JSON transport a sentinel always
arrives whole inside one text block, so that machinery isn't needed there.

**Transcript legibility (stream mode).** `StreamJsonSession` doesn't dump raw events. It runs
each message's content blocks through the pure `renderBlocks` in
`src/agents/streamTranscript.ts`: assistant text is passed through (sentinels stripped), a
`tool_use` becomes a labelled line with a one-line input summary, and a `tool_result` (arriving
as a `user` event) is sanitised — ANSI/control chars removed — and truncated to `MAX_RESULT_LINES`
with a "+N more lines" marker. Labels carry SGR colour, which xterm renders in the drawer; the
`Hub` strips ANSI from the compact fleet-card tail so it never shows as literal escapes. Detection
still scans the _raw_ turn text, so keep the raw-vs-display split intact if you extend rendering.

**Transcript legibility (PTY mode, issue #63).** The interactive claude TUI paints the
screen with cursor-addressed redraws, so the raw PTY byte stream is illegible once escapes
are stripped — stripping deletes the escapes but can't interpret them. `PtySession` with
`legibleTranscript: true` (wired for `agentMode: 'pty'` only; `raw`/mock sessions stay raw)
therefore routes the sentinel-stripped bytes through `TerminalTranscript`
(`src/pty/terminalTranscript.ts`): a headless xterm (`@xterm/headless`) sized to the real
PTY (`PTY_COLS`/`PTY_ROWS` in `backend.ts` — keep them in sync or cursor addressing
garbles), read back as settled screen text with wrapped rows re-joined and TUI chrome
(spinner/input box/hints — the heuristic `isTuiChromeLine`) dropped. Updates are debounced
and diffed: an extension flows out the normal `output` delta path, while an in-place
rewrite of already-emitted text becomes a `transcript` (full-replacement) event —
`AgentManager` maps it to `Store.setTranscript`, the `Hub` ships it to subscribers as
`agent:transcript` and rebuilds the rolling tail from it, and the cockpit replaces its
accumulated live buffer. Two sharp edges: xterm parses writes _asynchronously_, so
transcript content lands a beat after detection events (detection still scans the raw
bytes synchronously and is unaffected), and `PtySession.handleExit` settles the emulator
_before_ reporting `exit`/`done`/`failed` so the final text never races the terminal
transition. Tests: `test/terminalTranscript.test.ts`, `test/ptyLegibleTranscript.test.ts`.

**Exit on done (issue #66).** The interactive claude REPL has no natural end — after a turn
it sits at the prompt forever — so the done sentinel alone would orphan the process and leak
its worktree. `PtySession` with `exitOnDone: true` (wired for `agentMode: 'pty'` only, like
`legibleTranscript`; raw/mock processes exit by themselves) therefore tears the REPL down
after the sentinel-driven `finish('done')`: it writes `/exit` + a delayed Enter (the same
paste-vs-keypress split as `send`, but bypassing the status guards — status is already
`done`), with a `SIGTERM` backstop after `exitGraceMs` (default 5s); `reportExit` already
ignores exits on a `done` session, so neither path reclassifies the finish as `failed`.
`AgentManager` then emits **`reaped`** once a finished (done/failed) agent's process has
_actually exited_ — the two signals arrive in either order (PTY: sentinel first; stream:
exit first) — and the composition root reacts to a `done` reap by removing the task's
worktree via `WorktreeManager.remove` (its only caller). Sequencing matters: a live process
pins the worktree cwd. Failed/killed agents keep their worktree for debugging, and a
shared branch with another active task is left alone. Tests: `test/ptyExitOnDone.test.ts`,
`test/worktreeCleanup.test.ts`.

**Usage capture (issue #60) — two mode-specific sources, don't conflate them.** Stream
mode: each `result` event's _cumulative_ `total_cost_usd`/`usage`/`num_turns` becomes a
`usage` session event (cache tokens folded into input), which `AgentManager` persists via
`Store.recordAgentUsage` — cumulative values onto the `agents` row, the cost _delta_ as a
timestamped `usage_events` row so `/api/state` can SUM rolling 5h/7d cost windows. PTY
mode reports no per-turn usage; instead it captures the **account rate limits** (the
Pro/Max `rate_limits` in the status-line payload — the one programmatic surface for
them): `buildClaudeArgs({ statusLine: true })` wires a `--settings` status command that
atomically dumps each payload to `$LUBBDUBB_STATUS_FILE` (per session id, set in the
spawn env, under the OS tmpdir), and `StatusFileRateLimits.readLatest()` feeds the
freshest one into the snapshot's `usage.rateLimits` (null when absent — the cockpit chip
then falls back to the cost windows). Parsing is pure (`parseStatusLinePayload`,
`src/agents/statusLine.ts`); tests in `test/usage.test.ts`.

### Resume on boot (PTY only)

A restart (crash or graceful shutdown) kills every agent, but the PTY runtime **resumes** the
in-flight ones rather than discarding them. The moving parts:

- **Chosen session id.** `AgentManager.spawn` mints a UUID (only when `opts.resumable`, i.e.
  PTY) and `buildArgs` passes it as `--session-id`; it's persisted on the `agents` row
  (`session_id` column). Resume passes `--resume <id>` instead. `buildClaudeArgs` **re-appends**
  the protocol system prompt on resume — `--resume` does _not_ retain it, so detection would
  break otherwise.
- **Shutdown ≠ kill.** `AgentManager.interruptAll()` (server shutdown) marks agents
  `interrupted` (resumable) and leaves the task status alone; `kill()` (cockpit button) marks
  `killed` and sets the task `interrupted`. `reconcileAndResumeOnBoot` treats an agent as a
  resume candidate only if it's in `starting`/`running`/`waiting`/`interrupted` **and its task
  is still active** — so a cockpit kill (agent `killed`) and a prior give-up (task
  `interrupted`) both stay dead and aren't resurrected on every boot.
- **`waitingReason` is the state signal.** `interruptAll` overwrites status to `interrupted`
  but preserves `waitingReason`, so `resume()` knows whether the agent was parked on a human
  (restore its escalation, no nudge) or mid-work (nudge it to continue). The pre-restart
  escalation persists and, once the session is live again, an answer routes into it.
- Best-effort: no session id or missing worktree → fall back to `interrupted`; boot never
  blocks on a resume. Stream-JSON resume is out of scope. `spawn`/`resume` share their listener
  wiring — change one, change both.

Sharp edge in `PtySession.kill()`: it sets status `killed` **before** signalling the process,
because a synchronously-delivered exit would otherwise be reclassified as `failed` (firing a
terminal event). Keep that ordering.

Sharp edge in `PtySession.send()`: the message text and its submitting carriage return are
written as **two separate writes**, `agentSubmitDelayMs` apart (default 60ms). The claude TUI
coalesces a single input burst into a paste and treats a trailing CR as a literal newline, so a
glued-on CR leaves the message sitting in the input unsubmitted. Trailing newlines in the text
are stripped so the lone CR does the submitting. This is why `send`-related test assertions look
for the payload as its own write (not `payload\r`) and await the delayed CR — don't re-glue them.

## Testing patterns

Tests build a full `System` with fakes injected via `buildSystem(config, opts)`:

- `opts.backend = new FakePtyBackend()` — scripted PTY, no native `node-pty`
  (`src/pty/fakeBackend.ts`; drive it with `.last().emit(...)` / `.emitExit(...)`, inspect
  `.writes`).
- `opts.streamSpawner` — a fake child process for the stream-JSON runtime.
- `dbPath: ':memory:'` — in-memory SQLite.

So you can exercise the whole inject → dispatch → agent → escalate → answer → done loop
without a model or a real terminal. Prefer adding tests at that seam. Put new tests in
`test/*.test.ts`; don't edit unrelated test files.

The **real `github` provider** (`src/integrations/github/`) follows the same pattern: all
GitHub HTTP is behind the narrow `GitHubApi` seam (`githubApi.ts`), `OctokitGitHubApi` is the
only file that imports octokit, and tests (`test/githubIntegration.test.ts`) inject a scripted
fake `GitHubApi` — no network. The field-mapping logic (CI aggregation, approval folding,
comment threading, linked-PR-from-timeline) is exported as pure functions and tested directly.
When you extend it, add to the `GitHubApi` interface + its fake together, and keep new mapping
logic in pure functions so it stays unit-testable without HTTP. `mergeable_state` and `base.ref`
map through this seam too (→ `PullRequest.mergeableState` / `baseBranch`); add a field to the
`Gh*` type _and_ the scripted fake in the same change.

The **`azure` provider** (`src/integrations/azure/`, Azure DevOps Repos + Boards) is the exact
same shape: all HTTP behind the narrow `AzureDevOpsApi` seam (`azureDevOpsApi.ts`),
`RestAzureDevOpsApi` (`restAzureDevOpsApi.ts`) the only file that touches the network _and_
resolves auth, and tests (`test/azureDevOpsIntegration.test.ts`) inject a scripted fake
`AzureDevOpsApi`. Mapping logic — CI aggregation from branch-**policy evaluations**, approval from
reviewer votes, `mergeStatus`→`MergeableState`, thread→comment folding, linked-PR-from-relations —
is exported as pure functions and tested directly. **CI status comes from policy evaluations, not
the PR `statuses` endpoint**: that endpoint returns every status ever posted across _all_ iterations,
so a stale `failed` from a superseded push poisons the PR forever (the false-"failing" bug).
`aggregatePolicyCiStatus` instead reads `listPolicyEvaluations` (`/_apis/policy/evaluations`, keyed by
the `vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}` artifact — so `RestAzureDevOpsApi` resolves
the project GUID once) and folds only _enabled, blocking_ CI-type policies (build-validation +
status; reviewer/comment/work-item policies are human gates that map to `approved`/`unresolvedComments`
instead). Auth is unlike GitHub's single env token: `resolveAzureAuth`
prefers `AZURE_DEVOPS_PAT` (Basic) and otherwise shells out to the logged-in `az` CLI (Bearer,
cached), so it's the one place `az` is invoked. Work-item **tags** map onto `Issue.labels`, so the
provider-agnostic pickup/priority gates work unchanged. Merging is Azure "complete PR", which
needs the head commit — the source-control integration caches each PR's `lastMergeSourceCommit`
from the last snapshot, so a `merge_pr` only works on a PR seen in a prior cycle.

The work item's raw **`System.State`** (unlike `Issue.state`, which collapses to open/closed) is
preserved on `Issue.workItemState`, which drives two _state-based_ (not label-based) dispatcher
knobs — orthogonal to the three label mechanisms below, don't conflate them. Both are off unless
configured, so standard setups don't regress: **(1)** `issuePickupStates` gates rule-4 pickup to
items in an allowed workflow state (e.g. `["Ready","Doing"]`) via the pure `isIssuePickupEligible`
— items with no `workItemState` (github/fake) bypass it. **(2)** `issueInReviewState` (e.g.
`"In Review"`) is the back-off: when a PR is open for a still-in-pickup work item (matched by its
`issue/{n}` branch or `linkedPrNumber`), the dispatcher emits a new **`set_work_item_state`** action
that PATCHes `System.State`, so the item drops out of pickup while it waits on review/CI instead of
being re-picked every cycle. It's idempotent (once moved, it no longer matches) and routes through
a new outbound capability, `WorkItemStateCapable.setWorkItemState` on the `ActionSink` seam (the
same add-to-the-seam-and-its-fake pattern as `setPrLabel`), implemented by the fake + azure `issues`
providers. Unlike `reply_on_pr`/`merge_pr` it is _not_ auto-send gated — it's mechanical bookkeeping,
so the executor runs it directly.

## PR health & one-agent-per-branch

- **`src/prHealth.ts`** holds the pure PR predicates — `prHealth(pr)` (the `{ blocked, reasons }`
  verdict rendered in the cockpit and included per-PR in `buildStateSnapshot`), plus
  `needsBaseUpdate(pr)` and `isConflicted(pr)`, which the dispatcher's conflict/behind rule
  consumes, and `isPrExcluded(pr, label)`. Keep these pure and unit-tested (`test/prHealth.test.ts` /
  `test/prExclusion.test.ts`); don't inline the logic.
- **Issue pickup state is the mirror on the issue side.** `isIssuePickupEligible` returns
  `{ eligible, reasons }` (not a bare bool) for the intrinsic policy gates, and the pure
  `issuePickupStatus(issue, ctx)` (both in `src/dispatcher/issuePickup.ts`) folds in the
  contextual gates — active task on the origin, `dispatchVerdict` cooldown/escalation, and
  pause/headroom — into one per-item `{ eligible, status, reasons }` verdict.
  `buildStateSnapshot` attaches it per-issue as `pickup` (reading the policy via
  `System.issuePickup` and `DEFAULT_COOLDOWN` — the same inputs rule 4 consults, so the
  verdict predicts the next cycle), and the cockpit renders it as the per-issue chip
  (`pickupChip` in `web/src/App.tsx`). If you add a pickup gate, extend both the pure
  verdict and its tests (`test/issuePickup.test.ts`) in the same change.
- **PR exclusion tag.** A PR whose `labels` include `config.prExclusionLabel` is the operator's
  "leave it alone" signal: `harness.ts` filters excluded PRs out of the world it hands the
  dispatcher (read via `isPrExcluded`), so **both** dispatchers ignore them uniformly, while the
  cockpit snapshot (which reads the connector directly) still shows them with their health. The
  cockpit's ignore/watch toggle writes the tag back through a **new outbound capability** —
  `PrLabelCapable.setPrLabel` on the `ActionSink` seam, routed by `CompositeConnector`, implemented
  by the fake + `github` + `azure` sourceControl providers (`setPullLabel` on each `*Api` seam). Add
  to the seam + its scripted fake together, same as the other outbound actions. `POST
/api/prs/:number/exclude` is the endpoint; it's a label write, **not** a dispatcher action.
- **One code agent per PR branch.** The PR rules never dispatch a second agent onto a branch that
  already has an active task. When the branch's agent is **running**, a fresh signal is delivered
  via `respond_to_agent` (the note records the concern origins in `originRefs`); when it's
  **waiting**, the note is **held** (don't inject — `agents.respond` flips `waiting → running` and
  would derail a human escalation). Notify de-dup reads `DispatchContext.recentDecisions` (wired in
  `harness.ts` from `store.listDecisions`), so a persistent signal isn't re-notified every cycle.

**External references → links.** URL construction lives in the provider, never in `web/`. The
github providers implement the `RefResolvable` capability (`resolveRefUrl(ref)`, backed by the
pure `githubRefUrl` in `src/integrations/github/refUrl.ts`); `CompositeConnector.resolveRefUrl`
routes to it. The server builds a `ref → URL` map (`buildRefUrls`, `src/server/refUrls.ts`) into
the `/api/state` snapshot as `refUrls`, and the cockpit looks refs up there (`linkify` / `refLink`
in `web/src/components/util.tsx`) — it never string-builds a `github.com` URL. A provider that
can't resolve a ref returns `null`; the ref then renders as plain text (the `fake` provider's
behaviour). If you add a new ref shape, extend `githubRefUrl` (+ its unit test) and, if it's a new
structured field, feed it into `buildRefUrls`.

## Gotchas

- The default `agentMode` is `stream`, **not** a PTY — don't assume terminal semantics when
  reasoning about the default path.
- Relative paths in `claudeArgs` are resolved to absolute at config load, because agents run
  in a worktree/scratch `cwd` (`src/config.ts`).
- `bypassPermissions` maps to `--dangerously-skip-permissions`, which `claude` refuses under
  root — run as non-root if you need it.
- Config precedence: explicit overrides → `lubbdubb.config.json` → defaults, with `PORT` and
  `LUBBDUBB_DB` env overrides. `autoSend` is deep-merged.
- The `github` provider's auth token comes from `GITHUB_TOKEN` **only** — never from `Config`
  or a config file (so a secret can't be committed). Selecting `github` without the token or
  without `github.owner`/`github.repo` throws a clear error at `buildIntegrations` time.
- **Two orthogonal label mechanisms — don't conflate them.** `github.filters.issueLabel` is a
  provider-level _ingest_ filter: GitHub-only, config-time, and it **hides** non-matching issues
  from the world. `issuePickupLabel` is a dispatcher-level _pickup gate_ (rule 4 in
  `ruleDispatcher.ts`, via `src/dispatcher/issuePickup.ts`): provider-agnostic, reads
  `issue.labels`, and leaves untagged issues **visible** but unacted-on. Priority is
  label-encoded (`issuePriorityLabels`/`issueDefaultPriority`) and parsed by the pure exported
  `issuePriority` — keep that parsing pure so it stays unit-testable without a world. The gate
  is off by default (unset label = act on all open issues), so existing setups don't regress.
  `issuePickupRequireOwnLabel` is a _refinement_ of the pickup gate, not a fourth mechanism:
  when on, `isIssuePickupEligible` consumes `issue.labelsAddedByViewer` (the viewer-added subset
  of `labels`) instead of `labels`, so a pickup tag someone else added is ignored (anti-abuse).
  Authorship is resolved only in the real providers — GitHub reads the issue timeline's
  `labeled`/`unlabeled` events (`viewerAddedLabels`), Azure diffs work-item revision updates
  (`viewerAddedTags`, via the new `listWorkItemUpdates` seam method) — and only for items already
  carrying the gate tag (the registry passes `issuePickupLabel` as the `ownershipLabel`/`ownershipTag`
  opt only when the flag is set), so the extra history lookups stay bounded. Keep the folds pure;
  the `fake` provider leaves `labelsAddedByViewer` unset, so the gate fails closed there.
  A **third** label mechanism, `prExclusionLabel`, is the mirror on the PR side: it reads
  `PullRequest.labels` to _exclude_ a tagged PR from action (see "PR health" above). Don't
  conflate the three.
