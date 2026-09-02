# CLAUDE.md

Operating notes for AI agents working in this repo. This file is loaded into **every** agent's
context on **every** dispatch, so it holds one genre only: the things that, not knowing them, break
something **silently** — a failure `npm run check` does not catch, that is not obvious at the call
site, and that no test surfaces.

Everything else — how each subsystem works, and why — is in **[`docs/spec/`](docs/README.md)**,
read on demand. A spec states the behaviour the product is meant to have; if the code differs, one
of them is wrong, unless the spec marks that behaviour as not yet built. The [README](README.md)
covers what LubbDubb _is_ and how to run it.

**When you change behaviour, update the spec document that owns it in the same change.** That is
the repo's one documentation rule; [`docs/README.md`](docs/README.md) says which owns what.

## Making a change

1. Find the spec that owns the behaviour and read the invariants it states.
2. Change the code.
3. Update that spec in the same change.
4. Add or extend a test at the `buildSystem` seam, or a unit test for a pure function.
5. `npm run check` — format:check, lint, typecheck, typecheck:web, knip, test. CI runs the same six.

Two `check` failures are not obvious ([19](docs/spec/19-development.md) has the rest): **knip runs
with every rule at `error`** — the fix for an unused type or helper is to **drop the `export`**,
never an ignore list; a class member reached only through a structural seam reads as unused, so
declare `implements` or tag it `@public` naming the seam. And there are **two typecheckers**:
`typecheck` (server) and `typecheck:web` (cockpit) are separate passes.

A fresh clone needs `npm ci` first — `better-sqlite3` and `node-pty` are native builds.

## Conventions

- **ESM with explicit `.js` import extensions**, even from `.ts` sources. TS `nodenext`.
- **Comments explain _why_, not _what_.** Match the existing terse style.
- **Typed `emit`/`on` overrides** on `EventEmitter` subclasses — keep event payloads typed.
- **Domain types live in `src/types.ts`; the shapes the HTTP routes ship live in `src/wire.ts`**,
  which `web/src/types.ts` re-exports. A wire type either **is** a domain type or `extends` it —
  never a re-declaration, never widened. `src/wire.ts` is the only server module `web/src/` may name.
- **`src/system.ts` is the composition root.** A new component is threaded through it.
- **`src/store/` is the only directory that touches SQLite.** Writes are synchronous, which is what
  keeps the harness logic race-free. One module per group of tables, each taking a `StoreContext`,
  with `Store` delegating under the same names. → [14](docs/spec/14-persistence.md#shape)

## Sharp edges

### Identity

- **`userId` gates pickup, so a provider that cannot report label authorship stops the fleet
  silently.** With it set, `issuePickup.ts` reads `labelsAddedByViewer` instead of `labels`; a
  provider that never populates that field resolves every issue's labels to `[]` and **nothing is
  ever picked up**, with nothing red. `FakeIssuesIntegration` mirrors `labels` into it for that reason.
  → [02](docs/spec/02-configuration.md#userid), [06](docs/spec/06-issue-pickup.md)

### Review threads

- **Whether a review reply is the fleet's is a _record_, never the reply's author.** `ours` and
  `answered` read `pr_replies_sent` (`src/store/prReplies.ts`) — one row per reply that actually left
  through `sink.postPrReply` — and `config.userId` is the credential the harness posts under, which on
  a single-operator deployment is the operator's own account. Compare against it and the operator's
  follow-up on their own thread reads as the harness's: `answered` folds to `PrComment.handled`, the
  only bit rule `pr-review-comment` reads, so their comment is marked as work already done and never
  dispatched for. Both providers must read the same record through `src/prThreads.ts`, and every
  uncertainty — no comment ref, a reply from before the table — leaves the thread **unanswered**.
  → [07](docs/spec/07-pull-requests.md#attribution-is-a-record-never-an-identity)

### Persistence

- **A column added to an _existing_ table needs an additive `ALTER TABLE`**, guarded by
  `PRAGMA table_info` and declared in the owning module's `ColumnMigrations`. `CREATE TABLE IF NOT
EXISTS` never alters an existing table, so a column without an `ensureColumns` entry is invisible on
  every database from before it existed. A table being new **once** does not keep it exempt. A
  _renamed_ table needs a `TableRename` entry applied **before** the schema pass.
  → [14](docs/spec/14-persistence.md#migrations), [rename](docs/spec/14-persistence.md#renaming-a-table)
- **A column whose _null means something_ needs a backfill as well**, gated on `ensureColumns`'
  report of what it added. `pets.opened_at` null spells "still an egg", so the column alone turns
  every existing vivarium back into shells; a backfill on _every_ boot opens the eggs operators were
  saving. → [14](docs/spec/14-persistence.md#when-a-null-means-something)
- **A one-shot id is never edited in place** — `VIVARIUM_RESET` in `src/pets/keeper.ts`, and every
  id passed to `runOnce`. Changing it declares a _second_ pass, which every database that ran the
  first runs again on the next boot. A further pass is a further id, added deliberately.
  → [22](docs/spec/22-pets.md#clearing-the-vivarium), [14](docs/spec/14-persistence.md#a-migration-that-must-run-once)
- **A pooled corroboration is upserted on `(fact_id, fleet_id)`; `PoolDesk` never lands its own
  fleet's document.** Either appends a voice every pulse and looks like the pool working.
  → [28](docs/spec/28-cross-fleet-pool.md)
- **A new issue-verdict writer goes through `IssueVerdictStore.recordVerdict`, never a hand-rolled
  `DELETE`.** Which verdict tables may coexist is declared once in `src/store/verdicts.ts`; a writer
  that clears its siblings itself silently reintroduces the pairwise drift the matrix replaced.
  → [14](docs/spec/14-persistence.md#issue-verdicts-and-the-exclusion-matrix)
- **A failed validation check must never be recorded as a shortfall.** A shortfall clears the goal's
  **delivery** row, and the delivery is what parks the goal: writing one un-parks it, settles the
  close-out obligation and declines the validation bench row — the reading deleting the rows it was
  reported into, with delivered work handed back to the fleet. Rule `validation-failed` is the
  consumer, on its own origin. → [20](docs/spec/20-validation.md#when-a-check-fails)

### Tests

- **A test that dispatches a code agent must inject `worktrees`.** `config.repoRoot` defaults to
  `process.cwd()`, so without `FakeWorktreeManager` the test cuts a **real branch in your checkout**
  and nothing deletes it. Use the real manager only when git behaviour _is_ the subject, pointed at a
  throwaway repo from `test/support/gitRepo.ts`.
  → [19](docs/spec/19-development.md#why-a-test-must-not-dispatch-through-the-real-worktree-manager)
- **A test that touches `GET /api/issues/filing-target` or `POST /api/issues` must inject
  `upstream`.** The default is the real `gh` CLI against **AdamAwan/LubbDubb** — a test without
  `FakeUpstreamIssues` files a live issue on the project's tracker and passes while doing it.
  → [15](docs/spec/15-integrations.md)
- **A test that reads the project config layer injects `projectConfigFile`, or points `repoRoot` at
  a temp directory.** `lubbdubb.project.json` is read from `repoRoot`, and this repo is itself a
  LubbDubb target — the day one is committed here every test on the default starts merging it.
  → [02](docs/spec/02-configuration.md#the-project-layer)
- **A test builds its config with `loadConfig`, never `loadDeploymentConfig`.** Only the latter
  reads `lubbdubb.config.json` and the env, so a test on it passes or fails by machine.
  → [02](docs/spec/02-configuration.md#two-loaders)
- **Tests build a whole `System`** via `buildSystem(config, opts)` with fakes injected (`backend`,
  `streamSpawner`, `sink`, `gitObserver`, `worktrees`, `errorMirror`) and `dbPath: ':memory:'`.
  Prefer that seam. New tests go in `test/*.test.ts`; do not edit unrelated test files.
- **Extending a provider means adding to the `*Api` interface _and_ its scripted fake in the same
  change.** All provider HTTP is behind that seam; the tests touch no network.

### Prompts and templates

- **Anything new an agent must read is _appended_ to the rendered prompt, never interpolated.**
  Templates are operator-overridable and `loadPromptTemplates` rejects only _unknown_ placeholders,
  so an override that never learned your new `{token}` silently drops it — on exactly the
  deployments that customised most. → [09](docs/spec/09-execution.md), [05](docs/spec/05-dispatcher.md#prompt-templates)
- **A `PromptId` is never deleted — it is marked `retired: true`.** Removing an id turns every
  deployment that overrode it into a harness that will not boot.
  → [05](docs/spec/05-dispatcher.md#prompt-templates)

### Filing a tracker item

- **What a filed ticket must carry goes in `IssueCreateInput`, never in a sentence in a prompt.**
  Type, labels, assignee and the bug/story relation are arguments to `ActionSink.createIssue`,
  resolved by `ticketFiler` (`src/tickets/filing.ts`). Told to an agent instead, each failure is
  silent: a ticket without the watch label is created, linked, shown complete, and **never dispatched
  for**. → [13](docs/spec/13-jobs-and-tickets.md#filing-a-ticket), [15](docs/spec/15-integrations.md)

### Dispatch

- **A new `issue:<n>:…` dispatch origin is classified in `src/issueOrigins.ts`.** Left out, it reads
  as `unrecognised`: it stops expanding under a goal's priority flag, and its spend files under
  "other" rather than the phase it belongs to. Neither is red.
  → [05](docs/spec/05-dispatcher.md#marking-a-goal-a-priority), [18](docs/spec/18-observability.md)
- **A new agent-dispatch rule must route through the candidate list.** An inline `raw.push` of a
  `dispatch_*` action bypasses both the headroom cut and the Up next queue. Adding a rule is a
  `DISPATCH_PIPELINE` entry in the position it should run, and a module under
  `src/dispatcher/rules/` registered in `STAGES` under that id. → [05](docs/spec/05-dispatcher.md#the-rule-book)
- **Pipeline order is load-bearing state.** `issue-appraisal` and `issue-assess` write
  `appraising` / `assessing` on the `StageContext` for later stages to read. Moving either below its
  readers silently puts two agents on one issue.
- **Lenses stay out of `src/dispatcher/`.** The work graph, `buildStacks`, `prAttentionStatus`,
  `knowledge`, `overlaps` and `src/features/` are read-only views for the cockpit. Asserted
  structurally — if one of those tests fails, fix the file it names, not the assertion.

### Agent runtimes

- **A new agent-termination path must reap the process _subtree_, before it signals the child.**
  `session.kill()` does this via the injected `ProcessReaper`; a direct `kill` leaves the agent's
  shells holding the worktree as cwd, and every later dispatch onto that branch fails `EBUSY`,
  forever. Reaping _after_ the child dies finds nothing.
  → [10](docs/spec/10-agent-runtimes.md#reaping-the-process-subtree)
- **A launch carries `--session-id` _or_ `--resume`, never both**, written only through
  `appendSessionFlags` in `src/agents/agentProtocol.ts`. `claude` refuses `--session-id` on an id
  that already has a transcript — exit 1, **no stream event** — which reads to the harness as a
  process that died for no reason. → [10](docs/spec/10-agent-runtimes.md#launch-arguments)
- **A mid-run crash re-attaches through `AgentManager.resume`, which must be handed a torn-down
  agent.** `resume` was written for boot: for an agent still in `sessions` it returns a silent
  success and overwrites the spool key and MCP token, leaking a spool dir and leaving a **bearer
  credential live** with nothing to revoke it. Drop the session, `disposeFileEvents` and
  `releaseMcp` first. → [10](docs/spec/10-agent-runtimes.md#auto-resume-on-a-mid-run-crash)
- **A _re-dispatch_ re-attaches through `spawn`'s `resumeSessionId`, never `resume`.** It writes a
  new agent row, so there is nothing to tear down; two agent rows sharing one `sessionId` is the
  _correct_ shape here. → [10](docs/spec/10-agent-runtimes.md#inheriting-a-conversation-on-re-dispatch)
- **Anything in `main.ts` that can start an agent goes _below_ the signal handlers.** A Ctrl-C
  above them takes Node's default path, which runs no handler: agents launched, not reaped, not
  recorded. → [21](docs/spec/21-self-update.md#where-the-shutdown-handlers-are-registered)
- **The upgrade exit code is `UPGRADE_EXIT_CODE` in `src/selfUpdate/handoff.ts`, never a literal.**
  An exit the supervisor reads as a crash comes back on the **old** build with its agents restored,
  which looks like a successful upgrade. → [21](docs/spec/21-self-update.md#applying-it)
- **`agentMode` is `stream` or `raw`, and only `stream` runs a model.** `raw` is the mock agent and
  what nearly every test drives, so a change asserted only there has not been asserted against a
  model. → [10](docs/spec/10-agent-runtimes.md#the-session-contract)
- **`PtySession.kill()` sets status `killed` _before_ signalling the process.** A synchronously
  delivered exit would otherwise be reclassified as `failed`, firing a terminal event.
- **`PtySession.send()` writes the text and its submitting carriage return as two separate writes**,
  `agentSubmitDelayMs` apart. A line editor folds one burst into a paste and treats a trailing CR as a
  literal newline. Test assertions look for the payload as its own write — do not re-glue them.
- **Sentinel matching goes through `src/pty/sentinelScanner.ts`, never `indexOf`.** A program that
  styles the line puts SGR escapes _inside_ the token; one matcher serves detection and stripping.
- **The account's 5h/weekly windows are read off `rate_limit_event` beside the park, by a second
  function that must stay one.** It fires on **every ordinary turn**, so folded into `rateLimitPark`
  it is one edit from parking the fleet on a reading that says there is room. Freshest wins by
  `capturedAt`, not arrival. → [10](docs/spec/10-agent-runtimes.md#the-account-usage-windows)

### Agent launch and the tool channel

- **Do not allow-list Bash via `claudeArgs: ["--allowedTools", …]`.** Operator args are appended
  last, so it wins over the harness's and silently drops the `mcp__lubbdubb__*` grants. Use
  `agentAllowedTools`, which rides in `--settings`.
- **A tool added to `buildTools` must also be named in `MCP_TOOL_NAMES`.** The server id, the tool
  names and the `mcp__<key>__<tool>` grants must agree. → [11](docs/spec/11-mcp-tools.md#launch-flags)
- **There are two channels, and `validation_report` is a tool on both.** The fleet's is
  `src/mcp/tools/validationReport.ts`; the operator's own Claude Code gets `src/mcp/desktopTools.ts`
  (`DESKTOP_TOOL_NAMES`, never `buildTools`). Editing one leaves the other on the old behaviour.
  → [11](docs/spec/11-mcp-tools.md#the-desktop-channel)
- **Never add `ANTHROPIC_API_KEY` to spawn env or config to "fix" an auth problem.** Non-interactive
  `claude` always uses the key when present, so a stray export moves the whole fleet onto API
  billing. Fix the login instead. → [02](docs/spec/02-configuration.md#secrets)
- `bypassPermissions` maps to `--dangerously-skip-permissions`, which `claude` refuses under root.
  `agentAllowedTools` plus the permission backstop complete a task unattended under `acceptEdits`.

### Cockpit

- **A colour written as a literal in a stylesheet is a colour no theme can reach.** Every colour is
  a custom property on one of two `:root` blocks; a hex at a use site stays dark when somebody
  switches to Light, and only `test/cockpitTheme.test.ts` reads CSS. A new tint belongs on `:root`
  — ideally a `color-mix` of the core — and in the registry in `web/src/cockpit/tokens.ts`.
  → [17](docs/spec/17-cockpit.md#tokens)
- **A reference is drawn with `<Ref to={ref}/>` (`web/src/components/refs.tsx`), never as text.** A
  surface that names a goal or PR with no way there is a dead end that renders correctly. A
  reference **never goes inside a button**: draw the name as the control and the refs beside it in a
  `cn-refs` group. → [17](docs/spec/17-cockpit.md#links)
- **A new piece of "where am I" state goes on `Place` (`web/src/cockpit/place.ts`), never a
  `useState` in `useCockpit`.** The cockpit's place is the query string; state held outside it
  breaks on the back button and on reload. → [17](docs/spec/17-cockpit.md#the-address-bar)

### Git and worktrees

- **`WorktreeManager.ensure(branch, base)` is reuse-first**: an existing worktree or local branch is
  handed back and `base` is ignored. An unresolvable `base` throws rather than falling back to HEAD.
  → [09](docs/spec/09-execution.md#worktrees)
- **Worktrees are a pool of slots leased to branches, and `git switch -C` / `checkout -B` must stay
  unreachable.** The reset form rewinds a branch that already has commits — a re-dispatch, a retry —
  and loses them. Check the ref exists first; only reach `switch -c` for one that does not.
  → [09](docs/spec/09-execution.md#handing-a-slot-over)
- **A slot handed to a _different_ branch is wiped with `git clean -ffdx` first.** Weakening the
  wipe puts another branch's `dist/` and lockfile-resolved dependencies in front of an agent as its
  own output. The cold install is the trade on purpose. → [09](docs/spec/09-execution.md#handing-a-slot-over)
- **`ensure` grows the pool before it evicts a free slot still on a branch.** Evicting early burns
  the tree a CI fix on that branch would have come back to; every re-dispatch then pays a cold
  install, which nothing measures. → [09](docs/spec/09-execution.md#worktrees)
- **The lease is the only thing keeping two agents out of one directory.** Anything that hands out
  a slot goes through `WorktreeManager.ensure`; anything that frees one goes through `remove` /
  `deleteBranch`. → [09](docs/spec/09-execution.md#the-lease)
- **The pool bound is `RuntimeControl.cap` plus slack, read by reference on every `ensure`.**
  Snapshot it at boot and every dispatch above the lower number is refused for want of a directory
  and retried forever — a full "Up next" queue, an idle fleet, nothing red. A stranded slot with
  uncommitted changes is reclaimed only at `acquire`'s dead end, only when nothing holds it, and only
  after stashing the work to `refs/lubbdubb/salvage/…`. → [09](docs/spec/09-execution.md#exhaustion)
- **The local run's checkout must stay outside `worktreeRoot`.** `slots()` counts every registered
  worktree under that root, so a preview checkout in there is a pool slot: handed to an agent and
  wiped. `localRunRoot` is separate, and only `ensurePreview` touches it.
  → [23](docs/spec/23-local-runs.md#the-checkout)
- **`resolveCommit` prefers `origin/<ref>` over the local ref** and returns a SHA, because the
  harness's clone never checks the integration branch out. `GitObserver` methods stay read-only and
  fetch-free.

### Environments

- **A reach verdict is three-valued, and a new reader must not fold `unknown` into `absent`.** An
  expired credential, a missing binary and a commit that genuinely has not shipped all fail the same
  way, and only the last is about deployment. `GitObserver.contains` answers `boolean | null`, and a
  probe that could not say makes **every** landing of that environment `unknown`.
  → [24](docs/spec/24-environments.md#the-three-verdicts)
- **An arrival must never be written as a `WorldEvent`.** `deliveryHold` expires a standing delivery
  verdict on **any** world event matching the goal's issue ref, so an arrival written as one un-parks
  the goal it just announced and hands delivered work back to the fleet. Arrivals have their own
  table and wire list; the cockpit merges them at the feed's door.
  → [24](docs/spec/24-environments.md#in-the-cockpit)
- **An arrival is announced only if its reading is fresh, and stamped either way.** Drop either and
  the deployment that takes the build comments on every ticket that ever shipped.
  → [24](docs/spec/24-environments.md#announcing-an-arrival)
- **`DeliveryCloseOutDesk` runs below `ValidationReadyDesk` in the pulse**, because it holds the
  close while the goal's `validate` row is open. Above it, both arrive together.
  → [24](docs/spec/24-environments.md#the-bench-asks-for-one-thing-at-a-time)
- **A landing is recorded by sweeping for unattributed merges, never on the merge itself.** The
  merge SHA has a `closedPrWindowMs` shelf life, so a hook on the transition loses the landing to any
  restart that straddles it. The desk runs **immediately below `graph.record`**, because attribution
  walks the graph's `parentRef` chain. → [24](docs/spec/24-environments.md#recording-a-landing)

### Errors and config

- **Do not add swallowed `catch`es.** Route every caught failure through `errors.record(...)`
  (`src/errorLog.ts`). Its event is named `logged`, not `error` — an unlistened `error` event
  throws, and recording a failure must never throw. → [18](docs/spec/18-observability.md)
- **No secret is ever a config key.** `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT` and `LUBBDUBB_TOKEN` come
  from the environment. Precedence is explicit overrides → env → `lubbdubb.config.json` →
  `lubbdubb.project.json` → defaults. → [02](docs/spec/02-configuration.md)
- **A config layer carries only what its file said.** `mergeLayers` never folds `DEFAULTS` in; that
  happens once, in `mergeConfig`. A layer that arrives dense does not merge, it replaces — and
  shadows the project file with a policy no file on the machine states.
  → [02](docs/spec/02-configuration.md#precedence)
- **A route handler never reads the request.** It is wrapped in `checked(schemas, handler)` and
  handed `{params, body, req, reply}` already parsed. A refusal is a returned value and a 400, not a
  throw — `setErrorHandler` means _unanticipated_. → [16](docs/spec/16-http-api.md#request-validation)
- **A new route goes in the `src/server/routes/` module that owns its group**; a new group is a new
  module plus an entry in `app.ts`'s `ROUTE_MODULES`. A schema encoding a domain rule lives with the
  rule — `ShortfallBody` is in `src/delivery/shortfall.ts`. → [16](docs/spec/16-http-api.md#shape)

## Where to read further

[`docs/README.md`](docs/README.md) is the index: one spec per subsystem, numbered by the order they
build on each other. Start there rather than grepping. `docs/workflow.md` describes the end-to-end
workflow the harness runs; `docs/prompt-templates/` holds copies of the built-in prompt bodies.
