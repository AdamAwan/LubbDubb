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
- **The "Up next" queue (issue #69)** is a rank-then-slice inside `RuleDispatcher.decide`:
  agent-dispatch rules collect ordered `Candidate`s (PR concerns get a cross-PR urgency
  sort — CI > base-update > comment, then PR number), and only the final walk applies the
  headroom cut, dispatching the above-cut prefix while the whole ranked list is returned
  as `DispatchResult.upcoming` (`QueueItem[]`: `dispatching`/`waiting`/`cooldown`). If you
  add a dispatch rule, route it through the candidate list — an inline `raw.push` of a
  `dispatch_*` action would bypass both the cut and the queue. The `Harness` caches the
  last plan (`harness.upcoming`, null for the LLM dispatcher which returns none) and
  `buildStateSnapshot` ships it as `upcoming`; the cockpit's `UpNext` panel draws the
  cut-line. It's a per-pulse projection — never treat it as a persisted FIFO.
- **Operator-launched jobs (the `jobs` table + rule 0).** A job is an ad-hoc prompt queued from
  the cockpit (`POST /api/jobs` → `Store.createJob`, status `queued`). Unlike a `Task` (created
  the instant an agent spawns), a job persists _ahead of_ dispatch so it can sit in a queue when
  the fleet is at capacity. The dispatcher pushes queued jobs (`DispatchContext.queuedJobs`, wired
  from `store.listQueuedJobs()`) onto the front of the `Candidate` list **before any world-driven
  rule** — rule `manual-job` (number `0`) — so the headroom cut dispatches them first (a manual
  request takes the next free slot); a job below the cut shows as `waiting` in the Up next queue and
  is retried next cycle. No cooldown throttle applies (a job is a one-shot request). The ClaudeDispatcher
  gets the same queue in its prompt. The emitted `dispatch_*` action carries a `jobId`, and the executor
  calls `Store.markJobDispatched(jobId, task.id)` **only after** the agent actually spawns — so a job the
  cap/pause gate holds stays `queued`. `Store.cancelJob` drops a still-queued job; a dispatched one is a
  live agent (kill it instead). The `jobs` table is a fresh `CREATE TABLE`, so no `migrate()` entry is
  needed. Tests: `test/jobQueue.test.ts`.
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

**Flag sentinel (surfacing artifacts).** A third sentinel, `@@LUBBDUBB_FLAG:<payload>@@`, lets an
agent push an artifact/link to the cockpit mid-run (a design doc, a report) without changing its
status. Payload is a bare ref or a JSON `{kind?,label?,ref}` (`parseFlag`/`extractFlags` in
`sentinels.ts`, pure + tested), where `ref` is a **worktree-relative path or an http(s) URL**. Both
runtimes detect it on the _raw_ stream and emit `flag`; it strips from display through the same
`stripSentinels`/hold machinery as the waiting sentinel (PtySession additionally strips complete
flags from its detection tail via `stripFlags`, since — unlike done/waiting — a flag doesn't latch a
status, so a sliding window would otherwise re-emit it). `AgentManager.recordFlag` persists it
(`agent_flags`, deduped by `(agent, ref)` so an evolving doc refreshes in place), re-emits it as the
`flag` event, and the `Hub` ships it as `agent:flag` + a `dirty`. `buildStateSnapshot` includes
`flags` per snapshot; the cockpit groups them by agent onto the card/drawer as chips. Local-path
refs are served by `GET /api/artifacts/:id` (addressed by **flag id**, so the served path comes from
the stored flag row, not the request — the taint never reaches a path expression), **confined to the
flag's agent worktree** (a lexical prefix check runs before any fs access; `realpathSync` then defeats
symlink escape), **rate-limited** (`@fastify/rate-limit`, `global:false` + per-route opt-in so the
cockpit's state polling is never throttled), and sandboxed (`Content-Security-Policy: sandbox`) so
agent-authored HTML can't script the cockpit origin; URL refs are linked directly. It's purely
additive detection — on in every agent mode, gated behind nothing.

**File-events hook (skill-agnostic artifacts).** The flag sentinel only surfaces an artifact if
the agent's _prompt_ tells it to print the sentinel — so every skill that emits a report has to
know the protocol. A Claude Code `PostToolUse` hook removes that coupling: it fires for _any_
file-writing tool (`Write`/`Edit`/…) regardless of what the agent was told, so a report shows up
with zero skill-side knowledge. It's wired once into the launch `--settings` for **both** runtimes
(hooks fire in headless stream mode too — they just don't appear in the stream output), mirroring
the status-line capture: `buildClaudeArgs`/`buildClaudeStreamArgs` take a `fileEvents` opt, and the
`--settings` fragment (`FILE_EVENTS_SETTINGS`, `src/agents/fileEvents.ts`) runs a small `node`
command that dumps each written **path only** (never the file content) into a per-agent spool dir
named by `$LUBBDUBB_EVENTS_DIR` (set in the spawn env by `AgentManager`, like the status file).
Because status-line and file-events must share one `--settings` (the flag has no array form),
`STATUS_LINE_SETTINGS` is now an object and `buildClaudeArgs` merges the enabled fragments.
`AgentManager.drainFileEvents` (piggybacked on the `output` stream + a final drain at
terminal/kill, so no polling timer) folds each captured write in through the pure `classifyArtifact`:
**every** path is recorded in the `agent_files` table (the drawer's "files changed" list, snapshot
key `files`), while **report-like** ones additionally go through the _same_ `Store.recordFlag` +
`flag` event as a sentinel flag — so a report becomes a chip via the identical dedup / `agent:flag` /
confined `GET /api/artifacts/:id` machinery. Promotion is: under one of the configured `docsFolderPrefix`
entries (`string | string[]` — an artifacts folder, _any_ extension), or under a `reports/` segment, else
the report/doc extension allowlist. A prefix entry is matched **prefix-aware**: a _relative_ entry matches
the worktree-relative path, an _absolute_ entry (e.g. `D:/docs`) matches an _out-of-worktree_ write left
absolute (subfolders included). Absolute paths inside the worktree are stored worktree-relative so the
artifact route can serve them; a write under an **absolute** prefix stays absolute, and the artifact route
widens its confinement to also serve files under each operator-configured absolute prefix
(`absolutePrefixes(config.docsFolderPrefix)` → extra trusted roots in `resolveConfinedArtifact`, still
lexical- + `realpath`-confined per root, so `..`/symlink escape is refused). The `FileEventsSpool` (`dirFor`/`drain`/`dispose`) is the read side; the spool dir is
minted per spawn (independent of the resume session id, so stream agents get one) and disposed on
reap. The flag sentinel stays supported as an optional intent override (URLs, custom `kind`/`label`)
but is no longer _required_. The done/waiting sentinels are unaffected — they're already injected
centrally by `PROTOCOL_SYSTEM_PROMPT` and carry intent a hook can't infer. `agent_files` is a fresh
`CREATE TABLE`, so no `migrate()` entry. Tests: `test/fileEvents.test.ts`.

_Coexists with the target repo's own config (verified)._ LubbDubb agents run in a **git worktree of
the repo they're working on**, so that repo's committed `.claude/settings.json`, `.claude/skills/`,
and `CLAUDE.md` are all present in the cwd and load normally. The hook rides on `--settings`, which
is an _additional_ settings source: hooks **merge** across sources (like permission rules, not
last-one-wins), so our `PostToolUse` entry and the target repo's own hooks **both** fire — confirmed
empirically with a nested `claude` run where a project hook and a `--settings` hook both fired on one
`Write`. Skills/CLAUDE.md are filesystem-discovered and unaffected by `--settings`. Our hook is
additionally env-gated on `$LUBBDUBB_EVENTS_DIR` (set only in the spawn env), so it's a silent no-op
for a human running `claude` in that repo by hand.

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
knobs — orthogonal to the watch/ignore label gate below, don't conflate them. Both are off unless
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
- **Watch/ignore tags (derived from `labelPrefix`).** The `-ignore`/`-watch` pair is the operator's
  "leave it alone"/"work this" signal, resolved by `src/watchLabels.ts` (see the Gotchas note). PR
  side: `harness.ts` filters `-ignore`-tagged PRs out of the world it hands the dispatcher (via
  `isPrExcluded`), so **both** dispatchers ignore them uniformly, while the cockpit snapshot (reads
  the connector directly) still shows them with their health. Issue/story side: the opt-in watch
  gate leaves un-watched items visible but unacted-on. The cockpit's per-row toggle writes the tags
  back through outbound capabilities on the `ActionSink` seam, routed by `CompositeConnector`:
  `PrLabelCapable.setPrLabel` (fake + `github` + `azure` sourceControl, `setPullLabel` on each `*Api`),
  `IssueLabelCapable.setIssueLabel` (fake + `github` + `azure` issues; GitHub reuses the labels API,
  Azure read-modify-writes `System.Tags` via `setWorkItemTag`), and `StoryLabelCapable.setStoryLabel`
  (fake backlog only). Add to the seam + its scripted fake together, same as the other outbound
  actions. Endpoints: `POST /api/prs/:n/exclude` (`{excluded}`), `POST /api/issues/:n/watch` and
  `POST /api/stories/:id/watch` (`{watched}` — writes the `-watch`/`-ignore` pair, mutually
  exclusive). They're label writes, **not** dispatcher actions.
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
- **One label model — watch/ignore, derived from `labelPrefix`.** `src/watchLabels.ts` is the
  single source: `watchLabelsFor(prefix)` derives `${prefix}-watch` / `${prefix}-ignore`, and
  the pure `resolveWatchState(labels, {watchLabel, ignoreLabel, defaultWatched})` folds the
  precedence — **ignore wins, then watch, else the type default**. The default differs by kind:
  PRs are opt-out (`defaultWatched: true` → worked unless `-ignore`), issues/stories are opt-in
  (`defaultWatched: false` → left alone unless `-watch`). An **empty prefix** yields empty labels =
  both gates off (the escape hatch tests use via `labelPrefix: ''`). There is **no ingest filter**
  anymore — every open issue is fetched and displayed; the gate only decides what's _acted on_.
  - PR side: `isPrExcluded(pr, ignoreLabel)` in `prHealth.ts` (still a plain `-ignore` includes,
    since PR default is watched) — `harness.ts` filters excluded PRs out of the dispatch world.
  - Issue side: `isIssuePickupEligible` / `issuePickupStatus` (`src/dispatcher/issuePickup.ts`)
    require `watchLabel` present and `ignoreLabel` absent; the status splits into `ignored`
    (explicit `-ignore`) vs `unwatched` (no `-watch` / state-gated) so the cockpit marks them apart.
    An **empty `watchLabel` leaves the watch gate off** (act on all) — that's how the no-arg
    `RuleDispatcher` and `labelPrefix: ''` keep the old act-on-all behaviour.
  - Story side: the pure `watchGateReason(labels, policy)` gates the story rules the same way
    (fake-backlog-only; `Story.labels` is optional).
  - Priority stays label-encoded (`issuePriorityLabels`/`issueDefaultPriority`, pure `issuePriority`).
  `issuePickupRequireOwnLabel` refines the **watch** gate: when on, the watch check reads
  `issue.labelsAddedByViewer` instead of `labels`, so a `-watch` tag someone else added is ignored
  (anti-abuse). Authorship is resolved only in the real providers — GitHub reads the timeline's
  `labeled`/`unlabeled` events (`viewerAddedLabels`), Azure diffs work-item revisions
  (`viewerAddedTags`) — and only for items carrying the tag (the registry passes the derived
  `watchLabel` as `ownershipLabel`/`ownershipTag` only when the flag is set). The `fake` provider
  leaves `labelsAddedByViewer` unset, so the gate fails closed there.
