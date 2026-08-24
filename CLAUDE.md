# CLAUDE.md

Operating notes for AI agents working in this repo. This file is loaded into **every** agent's
context on **every** dispatch, so it holds one genre only: the things that, not knowing them, get
something broken **silently** — a failure `npm run check` does not catch, that is not obvious at the
call site, and that no test surfaces.

Everything else — how each subsystem works, and why it came out that way — is in
**[`docs/spec/`](docs/README.md)**, read on demand. A spec states the behaviour the product is meant
to have, so if the code does something a spec does not say, that is a bug in one of them — **unless
the spec has marked that behaviour as not yet built**, which is the one honest reason for the two to
differ, and which is a thing you may find yourself sent to implement. The [README](README.md) covers
what LubbDubb _is_ and how to run it.

**When you change behaviour, update the spec document that owns it in the same change.** That is the
repo's one documentation rule; [`docs/README.md`](docs/README.md) indexes the twenty-eight documents and
says which owns what.

## Making a change

1. Find the spec that owns the behaviour and read the invariants it states.
2. Change the code.
3. Update that spec in the same change.
4. Add or extend a test at the `buildSystem` seam, or a unit test for a pure function.
5. `npm run check`.

## Verify before you commit

```bash
npm run check   # format:check, lint, typecheck, typecheck:web, knip, test
```

CI enforces the same six. Two failure modes are not obvious ([19](docs/spec/19-development.md) has
the rest):

- **knip runs with every rule at `error`** — an unimported `export`, an unnamed type, an unused
  dependency or an uncalled public class member all turn `check` red. The usual fix for a type or
  helper is to **drop the `export` keyword**, not delete it. Class-member analysis is name-based, so
  a method reached only through a structural seam reads as unused; declare `implements`, or tag it
  `@public` naming the seam. Never an ignore list.
- **Two typecheckers.** `typecheck` (server) and `typecheck:web` (cockpit) are separate passes; a
  change spanning `src/` and `web/` must satisfy both.

A fresh clone needs `npm ci` first — `better-sqlite3` and `node-pty` are native builds.

## Conventions

- **ESM with explicit `.js` import extensions**, even from `.ts` sources:
  `import { Store } from './store/store.js';`. New files must follow this or module resolution
  breaks. `type: "module"`, TS `nodenext`.
- **Comments explain _why_, not _what_.** Match the existing terse, high-signal style.
- **Typed `emit`/`on` overrides** on `EventEmitter` subclasses — keep event payloads typed at the
  call site when you add events.
- **Domain types live in `src/types.ts`; the shapes the HTTP routes ship live in `src/wire.ts`**,
  which `web/src/types.ts` re-exports. A wire type either **is** a domain type or `extends` it —
  never a re-declaration, and never widened. `test/wireContract.test.ts` enforces that `src/wire.ts`
  is the only server module anything under `web/src/` names.
- **`src/system.ts` is the composition root.** Every module is wired there through its interface. A
  new component is threaded through it.
- **`src/store/` is the only directory that touches SQLite.** Everything else goes through the
  `Store`; writes are synchronous, which is what keeps the harness logic race-free. `store.ts` is a
  composition root: one module per group of related tables, each taking a `StoreContext` of
  `{db, now}`, with `Store` delegating under the same method names. Asserted structurally in
  `test/storeModules.test.ts`. → [14](docs/spec/14-persistence.md#shape)

## Sharp edges

### Identity

- **`userId` gates pickup, so a provider that cannot report label authorship stops the fleet
  silently.** With it set, `issuePickup.ts` reads `labelsAddedByViewer` instead of `labels` — so a
  provider that never populates that field resolves every issue's labels to `[]`, and **nothing is
  ever picked up**. Nothing errors, and an issue that is simply not eligible looks exactly like one
  nothing has got to yet. `FakeIssuesIntegration` mirrors `labels` into it for that reason; a new
  issues provider must resolve it or the deployment quietly does nothing.
  → [02](docs/spec/02-configuration.md#userid), [06](docs/spec/06-issue-pickup.md)

### Persistence

- **A column added to an _existing_ table needs an additive `ALTER TABLE`**, guarded by a
  `PRAGMA table_info` check and declared in the `ColumnMigrations` of the module that owns the table. `CREATE TABLE IF NOT EXISTS` never alters an existing
  table, so a column without an `ensureColumns` entry is invisible on every database from before it
  existed — and invisible is the whole failure: nothing errors. A brand-new table needs no entry,
  but a table being new **once** does not keep it exempt.
  → [14](docs/spec/14-persistence.md#migrations)
- **A column whose _null means something_ needs a backfill as well as an `ALTER TABLE`, gated on
  `ensureColumns`' report of what it added.** `pets.opened_at` null spells "still an egg", so the
  column alone turns every existing vivarium back into a crate of shells on the boot the operator
  takes the build. A backfill run on _every_ boot is the same silence pointed the other way: it opens
  the eggs they were saving. Both look like the feature working.
  → [14](docs/spec/14-persistence.md#when-a-null-means-something)
- **A one-shot id is never edited in place** — `VIVARIUM_RESET` in `src/pets/keeper.ts`, and every id passed to
  `runOnce`. The string names _that_ clearance or _that_ migration, so changing it is not a rename: it declares a second
  one, which every database that already ran the first then runs again — releasing every operator's pet collection, or
  re-creating rows they have since ruled on, on the boot after they take the build. A pass that ran as designed reports
  nothing, and `check` has no opinion about a constant. A further pass is a further id, added deliberately.
  → [22](docs/spec/22-pets.md#clearing-the-vivarium), [14](docs/spec/14-persistence.md#a-migration-that-must-run-once)
- **A pooled corroboration is upserted on `(fact_id, fleet_id)`; `PoolDesk` never lands its own fleet's
  document.** Either appends a voice every pulse and looks like the pool working. → [28](docs/spec/28-cross-fleet-pool.md)
- **A new issue-verdict writer goes through `IssueVerdictStore.recordVerdict`, never a hand-rolled `DELETE`.**
  Which of `issue_conclusions` / `issue_deliveries` / `issue_shortfalls` / `issue_assays` may coexist is
  declared once in `src/store/verdicts.ts`; a writer that clears its siblings itself compiles, passes, and
  silently reintroduces the pairwise drift the matrix replaced.
  → [14](docs/spec/14-persistence.md#issue-verdicts-and-the-exclusion-matrix)

### Tests

- **A test that dispatches a code agent must inject `worktrees`.** `config.repoRoot` defaults to
  `process.cwd()`, so without `FakeWorktreeManager` the test cuts a **real branch in whatever
  checkout the suite is running in** — yours — and nothing deletes it. Use the real manager only
  when git behaviour _is_ the subject, pointed at a throwaway repo from `test/support/gitRepo.ts`.
  → [19](docs/spec/19-development.md#why-a-test-must-not-dispatch-through-the-real-worktree-manager)
- **A test that touches `GET /api/issues/filing-target` or `POST /api/issues` must inject
  `upstream`.** Both routes go through `system.upstream`, which defaults to the real `gh` CLI against
  **AdamAwan/LubbDubb** — so a test without `FakeUpstreamIssues` files a live issue on the project's
  own tracker, as whoever is logged in, and passes while doing it. → [15](docs/spec/15-integrations.md)
- **A test that reads the project config layer injects `projectConfigFile`, or points `repoRoot` at a
  temp directory.** `lubbdubb.project.json` is read from `repoRoot`, which defaults to
  `process.cwd()` — and this repo is itself a LubbDubb target, so the day one is committed here every
  test going through `loadConfigFromText` or `buildSystem`'s default starts merging it, silently and
  differently from CI. Same hazard as `configFile`, and the same fix.
  → [02](docs/spec/02-configuration.md#the-project-layer)
- **A test builds its config with `loadConfig`, never `loadDeploymentConfig`.** Only the latter reads
  `lubbdubb.config.json` and the env overrides — which is the whole distinction: the suite runs in a
  working copy of this repo, so a test on the deployment loader picks up whatever config the
  operator runs the app with, and passes or fails by machine.
  → [02](docs/spec/02-configuration.md#two-loaders)
- **Tests build a whole `System`** via `buildSystem(config, opts)` with fakes injected (`backend`,
  `streamSpawner`, `sink`, `gitObserver`, `worktrees`, `errorMirror`) and `dbPath: ':memory:'`.
  Prefer that seam. Put new tests in `test/*.test.ts`; do not edit unrelated test files.
- **Extending a provider means adding to the `*Api` interface _and_ its scripted fake in the same
  change.** All provider HTTP is behind that seam; the tests inject the fake and touch no network.

### Prompts and templates

- **Anything new an agent must read is _appended_ to the rendered prompt, never interpolated into
  it.** Prompt templates are operator-overridable and `loadPromptTemplates` rejects only _unknown_
  placeholders — so an override that never learned about your new `{token}` silently drops it, on
  exactly the deployments that customised most. Appending has no fallback to get wrong.
  → [09](docs/spec/09-execution.md), [05](docs/spec/05-dispatcher.md#prompt-templates)
- **A `PromptId` is never deleted — it is marked `retired: true`.** `loadPromptTemplates` throws on a
  file naming no known id, so removing an id turns every deployment that overrode it into a harness
  that will not boot, over a file it no longer reads. The flag keeps it loadable and says so in the
  Prompts panel. → [05](docs/spec/05-dispatcher.md#prompt-templates)

### Filing a tracker item

- **What a filed ticket must carry goes in `IssueCreateInput`, never in a sentence in a prompt.** The
  type, the labels, the assignee and the bug/story relation are arguments to
  `ActionSink.createIssue`, resolved by `ticketFiler` (`src/tickets/filing.ts`). Told to an agent
  instead, each is only as reliable as its memory of one line — and every failure is silent: a
  blueprint's ticket without the watch label is created, linked, shown complete in the cockpit, and
  **never dispatched for**; an Azure bug without its relation is a bug nobody can trace back.
  → [13](docs/spec/13-jobs-and-tickets.md#filing-a-ticket), [15](docs/spec/15-integrations.md)

### Dispatch

- **A new agent-dispatch rule must route through the candidate list.** An inline `raw.push` of a
  `dispatch_*` action bypasses both the headroom cut and the Up next queue, silently. Adding a rule
  is two things: a `DISPATCH_PIPELINE` entry in the position it should run, and a module under
  `src/dispatcher/rules/` registered in `STAGES` under that id. There are no rule numbers, and one
  must not come back. → [05](docs/spec/05-dispatcher.md#the-rule-book)
- **Pipeline order is load-bearing state, not just priority.** `issue-assay` and `issue-assess`
  write `assaying` / `assessing` on the `StageContext` for later stages to read. Moving either
  below its readers compiles fine and silently puts two agents on one issue.
- **Lenses must stay out of `src/dispatcher/`.** The work graph (`src/graph/`), `buildStacks`,
  `prAttentionStatus`, `knowledge` and `overlaps` are all read-only views for the cockpit; a rule
  consulting one would be a second opinion about a decision made elsewhere. Asserted structurally
  in `test/workGraph.test.ts`, `test/stacks.test.ts` and `test/prAttention.test.ts` — if one fails,
  fix the file it names, not the assertion.

### Agent runtimes

- **A new agent-termination path must reap the process _subtree_, before it signals the child.**
  `session.kill()` does this via the injected `ProcessReaper`; a path that calls a process's `kill`
  directly leaves the agent's Bash-tool shells alive with the worktree as their cwd, and Windows then
  refuses `rmdir` on it — every later dispatch onto that branch fails `EBUSY`, forever, with nothing
  but rejected dispatches to show for it. Reaping _after_ the child dies finds nothing: descendants
  are resolved through the root pid. → [10](docs/spec/10-agent-runtimes.md#reaping-the-process-subtree)
- **Both real runtimes are resumable, and a launch carries `--session-id` _or_ `--resume`, never
  both.** Since #318 the stream launch pins an id too, so `restore` is on offer on the default
  deployment. Write either flag only through `appendSessionFlags` in `src/agents/agentProtocol.ts`:
  `claude` refuses `--session-id` on an id that already has a transcript — exit 1, plain stderr, and
  **no stream event at all** — so a relaunch that carried a stored id down the mint arm reads to the
  harness as a process that died for no reason.
  → [10](docs/spec/10-agent-runtimes.md#launch-arguments)

- **A mid-run crash re-attaches through `AgentManager.resume`, which must be handed a torn-down
  agent.** `resume` was written for boot, where the in-memory maps are empty: it returns a silent
  success for an agent still in `sessions`, and `set`s the spool key and MCP token over the dead
  launch's rather than replacing them — leaking a spool dir and leaving a **bearer credential bound
  and live** with nothing to revoke it. Drop the session, `disposeFileEvents` and `releaseMcp` first;
  the agent comes back either way, so nothing is red.
  → [10](docs/spec/10-agent-runtimes.md#auto-resume-on-a-mid-run-crash)

- **A _re-dispatch_ re-attaches through `spawn`'s `resumeSessionId`, never `resume`.** It writes a new
  agent row, so the maps that make `resume` dangerous hold nothing under that id and there is nothing
  to tear down. Routing it through `resume` instead would reuse the dead row and reintroduce the leak
  above — and, because two agent rows sharing one `sessionId` is the _correct_ shape here, nothing
  about it looks wrong. → [10](docs/spec/10-agent-runtimes.md#inheriting-a-conversation-on-re-dispatch)

- **Anything in `main.ts` that can start an agent goes _below_ the signal handlers.** They are
  registered before the upgrade's auto-restore and before the boot cycle, and that ordering is the
  whole of why those lines sit where they do: a Ctrl-C above them takes Node's default path, which
  runs no handler — so the agents it just launched are not interrupted, not reaped and not recorded.
  Real orphans holding worktrees open, with rows still claiming to be live.
  → [21](docs/spec/21-self-update.md#where-the-shutdown-handlers-are-registered)
- **The upgrade exit code is `UPGRADE_EXIT_CODE` in `src/selfUpdate/handoff.ts`, never a literal.**
  The server and `scripts/serve.ts` must agree on it: a server that exits for an upgrade the
  supervisor reads as a crash comes back on the **old** build with its agents restored, which looks
  exactly like a successful upgrade until you wonder why the fix is not in.
  → [21](docs/spec/21-self-update.md#applying-it)

The **default `agentMode` is `stream`, not a PTY.** Do not assume terminal semantics on the default
path. Everything below is PTY-only, and every one of them is a silent failure — the agent keeps
running and does the wrong thing. → [10](docs/spec/10-agent-runtimes.md#sharp-edges)

- **`PtySession.kill()` sets status `killed` _before_ signalling the process.** A synchronously
  delivered exit would otherwise be reclassified as `failed`, firing a terminal event. Keep that
  ordering.
- **`PtySession.send()` writes the text and its submitting carriage return as two separate writes**,
  `agentSubmitDelayMs` apart. The TUI coalesces one input burst into a paste and treats a trailing
  CR as a literal newline, so a glued-on CR leaves the message sitting unsubmitted. Test assertions
  therefore look for the payload as its own write — do not re-glue them.
- **`deliverInitial()` pastes the prompt once and then re-sends only the bare CR.** A re-paste
  accumulates it in the input box. "Landed" is observed from the session file, not timed.
- **PTY sentinel matching goes through `src/pty/sentinelScanner.ts`, never `indexOf`.** The TUI
  styles the line it prints a sentinel on, so SGR escapes land _inside_ the token. One matcher
  serves both detection and display-stripping; two views of the same bytes is the bug already fixed
  once, where detection fired and the strip missed.
- **Do not launch the server from inside a Claude Code session when using `agentMode: 'pty'`.** The
  parent's `CLAUDE_CODE_SESSION_ID` / `CLAUDECODE` leak into the spawned `claude`, which then writes
  no session transcript of its own and falls back to raw screen output.

### Agent launch and the tool channel

- **Do not allow-list Bash via `claudeArgs: ["--allowedTools", …]`.** Operator args are appended
  last, so an explicit `--allowedTools` there wins over the harness's and silently drops the
  `mcp__lubbdubb__*` grants — a _connected_ MCP server whose every call is refused, invisible until
  an agent needs it. Use `agentAllowedTools`, which rides in `--settings`, a different flag.
- **Adding a tool to `buildTools` without adding its name to `MCP_TOOL_NAMES` is the sharp edge of
  `src/mcp/`.** Three things must agree — the server id, the tool names, and the
  `mcp__<key>__<tool>` grants. `test/mcpChannel.test.ts` asserts all three against each other.
  → [11](docs/spec/11-mcp-tools.md#launch-flags)
- **There are two channels, and `validation_report` is a tool on both.** The fleet's is
  `src/mcp/tools/validationReport.ts`; the operator's own Claude Code gets
  `src/mcp/desktopTools.ts`, whose set is `DESKTOP_TOOL_NAMES` and never `buildTools`. They share the
  schema, the store writes and the hand-back wording, and differ in where the check comes from — an
  origin, or a claim. Editing one and believing you have edited "the report tool" leaves the other on
  the old behaviour, with nothing red. → [11](docs/spec/11-mcp-tools.md#the-desktop-channel)
- **Never add `ANTHROPIC_API_KEY` to spawn env or config to "fix" an auth problem.** Model
  credentials are _inherited_ from the parent shell, and in non-interactive mode `claude` always
  uses the key when present, with no approval prompt — so a stray export moves the whole fleet onto
  API billing. Fix the login instead. → [02](docs/spec/02-configuration.md#secrets)
- `bypassPermissions` maps to `--dangerously-skip-permissions`, which `claude` refuses under root.
  You should rarely need it: `agentAllowedTools` plus the permission backstop complete a task
  unattended under the default `acceptEdits`.

### Cockpit

- **A colour written as a literal in a stylesheet is a colour no theme can reach.** Every colour the
  cockpit draws is a custom property on one of two `:root` blocks, because the token layer _is_ the
  theme an operator picks from the config page — so a hex at a use site is a surface that stays dark
  when somebody switches to Light. It reads as a tidiness rule and is not one: the sheet is correct,
  the component renders, and the only symptom arrives on a theme nobody tested. `format:check` and
  `lint` do not read CSS at all; `test/cockpitTheme.test.ts` is the only thing in `check` that does.
  A new tint belongs on `:root` — ideally as a `color-mix` of the core, so it follows the hue — and in
  the registry in `web/src/cockpit/tokens.ts`, which the same test holds against the sheets in both
  directions. → [17](docs/spec/17-cockpit.md#tokens)
- **A reference is drawn with `<Ref to={ref}/>` (`web/src/components/refs.tsx`), never as text.** A
  surface that names a goal or a pull request and offers no way there is the cockpit's most repeated
  bug, and it is invisible: the row reads correctly, renders correctly, and is simply a dead end. The
  component owns where each family of ref goes; the one rule left to the call site is that a reference
  **never goes inside a button**, since one click cannot have two destinations — a row that carries both
  draws its name as the control and the refs beside it in a `cn-refs` group.
  → [17](docs/spec/17-cockpit.md#links)
- **A new piece of "where am I" state goes on `Place` (`web/src/cockpit/place.ts`), never a
  `useState` in `useCockpit`.** The cockpit's place is the query string, and a surface held outside it
  compiles, renders and works — until the back button steps over it, or a reload drops it. Both are
  silent, and neither is a thing `npm run check` can see. → [17](docs/spec/17-cockpit.md#the-address-bar)

### Git and worktrees

- **`WorktreeManager.ensure(branch, base)` is reuse-first, so an existing worktree or local branch
  is handed back and `base` is ignored entirely.** It does not guarantee the branch is based on
  `base`; it only decides where a branch that did not exist starts. An unresolvable `base` throws
  rather than falling back to HEAD — silently picking an incidental base is the bug the parameter
  exists to fix. → [09](docs/spec/09-execution.md#worktrees)
- **Worktrees are a pool of slots leased to branches, and `git switch -C` / `checkout -B` must stay
  unreachable.** The reset form rewinds an existing branch to the start point, so a slot handed to a
  branch that already has commits — a re-dispatch, a retry, a part picked up again — loses them, with
  nothing red. Check the ref exists first and only ever reach `switch -c` for one that does not.
  → [09](docs/spec/09-execution.md#handing-a-slot-over)
- **Reuse is scoped to the branch: a slot handed to a _different_ branch is wiped with
  `git clean -ffdx` first.** Only `ensure`'s same-branch arm hands a tree back with anything in it.
  Weakening the wipe puts another branch's `dist/`, generated files and lockfile-resolved
  dependencies in front of an agent as its own branch's output, which nothing marks as stale and no
  test sees. The cold install on a branch's first dispatch is the price, and it is the trade on
  purpose. → [09](docs/spec/09-execution.md#handing-a-slot-over)
- **`ensure` grows the pool before it evicts a free slot that is still on a branch.** A hand-over
  wipes, so evicting early burns the tree a CI fix or a review comment on that branch would have come
  back to — and buys nothing a fresh slot would not have. A reordering compiles and passes; all it
  costs is every re-dispatch paying for a cold install, which nothing measures.
  → [09](docs/spec/09-execution.md#worktrees)
- **The lease is the only thing keeping two agents out of one directory now.** A directory per branch
  used to provide that implicitly. Anything that hands out a slot goes through
  `WorktreeManager.ensure`, and anything that frees one goes through `remove` / `deleteBranch` — a
  path that picks a directory itself puts two agents in one tree on different branches.
  → [09](docs/spec/09-execution.md#the-lease)
- **The pool bound is the agent cap plus slack, and it must stay a live read of it.** The bound is
  `RuntimeControl.cap` plus slack, read by reference on every `ensure`, exactly as `harness.ts` reads
  the cap. Snapshot it at boot — or reintroduce a setting that can sit under the cap — and the bound
  is the fleet's real limit: every dispatch above the lower number is refused for want of a directory
  and retried forever, which is a full "Up next" queue, an idle fleet, nothing paused and nothing
  red. A slot stranded carrying uncommitted changes is reclaimed the same way it is refused — only at
  `acquire`'s dead end, only when nothing holds it, and only by stashing the work to
  `refs/lubbdubb/salvage/…` first. Anything that reclaims on a schedule instead pays `git status`
  across every checkout in the pool per pulse; anything that wipes instead of stashing destroys the
  one copy of an agent's work, and the slot looks identically clean either way.
  → [09](docs/spec/09-execution.md#exhaustion)
- **The local run's checkout must stay outside `worktreeRoot`.** The pool's `slots()` counts every
  _registered_ worktree under that root whatever the directory is called — so a preview checkout in
  there is a pool slot: counted toward the bound, handed to an agent, and wiped `git clean -ffdx` with
  the operator's warm dependencies in it. `localRunRoot` is a separate root for that reason, and
  `ensurePreview` is the only thing that touches it. → [23](docs/spec/23-local-runs.md#the-checkout)
- **`resolveCommit` prefers `origin/<ref>` over the local ref** and returns a SHA, because the
  harness's clone never checks the integration branch out. New `GitObserver` methods stay read-only
  and fetch-free.

### Environments

- **A reach verdict is three-valued, and a new reader must not fold `unknown` into `absent`.** An
  expired credential, a missing binary, a commit this clone never fetched and one that genuinely has
  not shipped all fail the same way, and only the last is about deployment — read as `absent` they
  are indistinguishable on the glass, and the cockpit states in the operator's words that the work
  has not shipped for a reason that has nothing to do with shipping. `GitObserver.contains` answers
  `boolean | null` for that reason, and a probe that could not say makes **every** landing of that
  environment `unknown`. → [24](docs/spec/24-environments.md#the-three-verdicts)
- **An arrival must never be written as a `WorldEvent`.** It is the obvious way to get it into the
  activity feed, and `deliveryHold` expires a standing delivery verdict on **any** world event
  matching the goal's issue ref — so an arrival written as one un-parks the goal it just announced
  and hands delivered work back to the fleet to do again. Nothing errors; a re-dispatch of finished
  work looks like the harness deciding there is more to do. Arrivals have their own table and their
  own wire list, and the cockpit merges them at the feed's door.
  → [24](docs/spec/24-environments.md#in-the-cockpit)
- **An arrival is announced only if its reading is fresh, and stamped either way.** The freshness
  window is what separates an arrival this harness watched from one it discovered on the first pulse
  after a build; the stamp is what stops an environment that grows `arrival.comment` later from
  commenting on its whole history. Drop either and the deployment that takes the build puts a comment
  on every ticket that ever shipped. → [24](docs/spec/24-environments.md#announcing-an-arrival)
- **`DeliveryCloseOutDesk` runs below `ValidationReadyDesk` in the pulse**, because it holds the
  close while the goal's `validate` row is open. Above it, it reads a bench that row has not been
  filed onto yet and both arrive together — which is the sequence gone, with nothing red.
  → [24](docs/spec/24-environments.md#the-bench-asks-for-one-thing-at-a-time)
- **A landing is recorded by sweeping for unattributed merges, never on the merge itself.** The merge
  SHA is a provider fact with a `closedPrWindowMs` shelf life and no way to recover it — a squash
  leaves no ancestry link — so a hook on the transition loses the landing to any restart that
  straddles it, or to a person merging in the web UI between two pulses. Nothing errors, and a goal
  whose commit was never caught looks exactly like one that never shipped. The desk also runs
  **immediately below `graph.record`** in the pulse, because attribution walks the graph's
  `parentRef` chain. → [24](docs/spec/24-environments.md#recording-a-landing)

### Errors and config

- **Do not add swallowed `catch`es.** Route every caught failure through `errors.record(...)`
  (`src/errorLog.ts`), the one error-recording path. Its event is named `logged`, not `error` — an
  unlistened `error` event throws, and recording a failure must never throw.
  → [18](docs/spec/18-observability.md)
- **No secret is ever a config key.** `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT` and `LUBBDUBB_TOKEN` come
  from the environment, so `lubbdubb.config.json` stays safe to paste. Precedence is explicit
  overrides → env (`PORT` / `LUBBDUBB_DB` / `LUBBDUBB_HOST` / `LUBBDUBB_REPO_ROOT`) →
  `lubbdubb.config.json` → the project's `lubbdubb.project.json` → defaults.
  → [02](docs/spec/02-configuration.md)
- **A config layer carries only what its file said.** `mergeLayers` never folds `DEFAULTS` in; that
  happens once, at the bottom, in `mergeConfig`. A layer that arrives dense does not merge, it
  replaces — so an operator's `{"planning": {"gitFetchIntervalMs": 0}}` would carry the default part
  cap and shadow the one their team's `lubbdubb.project.json` set, leaving the harness running a
  policy no file on the machine states. → [02](docs/spec/02-configuration.md#precedence)
- **A route handler never reads the request.** It is wrapped in `checked(schemas, handler)`
  (`src/server/validation.ts`) and handed `{params, body, req, reply}` already parsed — never an `as`
  cast, and never its own `code(400)` for a malformed request. A refusal is a returned value and a
  400, not a throw — `setErrorHandler` means _unanticipated_, and routing typos there buries real
  faults. Asserted structurally over every file in `src/server/routes/`.
  → [16](docs/spec/16-http-api.md#request-validation)
- **A new route goes in the module under `src/server/routes/` that owns its group**, and a new group
  is a new module plus an entry in `app.ts`'s `ROUTE_MODULES`. `app.ts` is wiring only. A schema
  encoding a domain rule (rather than a request shape) goes with the rule — `ShortfallBody` lives in
  `src/delivery/shortfall.ts`. → [16](docs/spec/16-http-api.md#shape)

## Where to read further

[`docs/README.md`](docs/README.md) is the index: twenty-eight specs, one per subsystem, numbered by the
order they build on each other. Start there rather than grepping — each document states the
invariants of its area and the reasoning behind them, which is what stops a change re-litigating a
settled decision badly.

`docs/workflow.md` describes the end-to-end workflow the harness is built to run.
`docs/prompt-templates/` holds copies of the built-in prompt bodies.
