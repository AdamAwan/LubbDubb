# CLAUDE.md

Operating notes for AI agents working in this repo. This file is loaded into **every** agent's
context on **every** dispatch, so it holds one genre only: the things that, not knowing them, get
something broken **silently** — a failure `npm run check` does not catch, that is not obvious at the
call site, and that no test surfaces.

Everything else — how each subsystem works, and why it came out that way — is in
**[`docs/spec/`](docs/README.md)**, written as fact and read on demand. If the code does something a
spec does not say, that is a bug in one of them. The [README](README.md) covers what LubbDubb _is_
and how to run it.

**When you change behaviour, update the spec document that owns it in the same change.** That is the
repo's one documentation rule; [`docs/README.md`](docs/README.md) indexes the nineteen documents and
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

### Persistence

- **A column added to an _existing_ table needs an additive `ALTER TABLE`**, guarded by a
  `PRAGMA table_info` check and declared in the `ColumnMigrations` of the module that owns the table. `CREATE TABLE IF NOT EXISTS` never alters an existing
  table, so a column without an `ensureColumns` entry is invisible on every database from before it
  existed — and invisible is the whole failure: nothing errors. A brand-new table needs no entry,
  but a table being new **once** does not keep it exempt.
  → [14](docs/spec/14-persistence.md#migrations)
- **A new issue-verdict writer goes through `IssueVerdictStore.recordVerdict`, never a hand-rolled
  `DELETE`.**
  Which of `issue_conclusions` / `issue_deliveries` / `issue_shortfalls` / `issue_assays` may coexist
  is declared once in `src/store/verdicts.ts`; a writer that clears its siblings itself compiles,
  passes, and silently reintroduces the pairwise drift the matrix replaced.
  → [14](docs/spec/14-persistence.md#issue-verdicts-and-the-exclusion-matrix)

### Tests

- **A test that dispatches a code agent must inject `worktrees`.** `config.repoRoot` defaults to
  `process.cwd()`, so without `FakeWorktreeManager` the test cuts a **real branch in whatever
  checkout the suite is running in** — yours — and nothing deletes it. Use the real manager only
  when git behaviour _is_ the subject, pointed at a throwaway repo from `test/support/gitRepo.ts`.
  → [19](docs/spec/19-development.md#why-a-test-must-not-dispatch-through-the-real-worktree-manager)
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
  `prAttentionStatus`, `findings` and `overlaps` are all read-only views for the cockpit; a rule
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
- **`resolveCommit` prefers `origin/<ref>` over the local ref** and returns a SHA, because the
  harness's clone never checks the integration branch out. New `GitObserver` methods stay read-only
  and fetch-free.

### Errors and config

- **Do not add swallowed `catch`es.** Route every caught failure through `errors.record(...)`
  (`src/errorLog.ts`), the one error-recording path. Its event is named `logged`, not `error` — an
  unlistened `error` event throws, and recording a failure must never throw.
  → [18](docs/spec/18-observability.md)
- **No secret is ever a config key.** `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT` and `LUBBDUBB_TOKEN` come
  from the environment, so `lubbdubb.config.json` stays safe to paste. Precedence is explicit
  overrides → `lubbdubb.config.json` → defaults, with `PORT` / `LUBBDUBB_DB` / `LUBBDUBB_HOST` /
  `LUBBDUBB_REPO_ROOT` env overrides. → [02](docs/spec/02-configuration.md)
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

[`docs/README.md`](docs/README.md) is the index: nineteen specs, one per subsystem, numbered by the
order they build on each other. Start there rather than grepping — each document states the
invariants of its area and the reasoning behind them, which is what stops a change re-litigating a
settled decision badly.

`docs/workflow.md` describes the end-to-end workflow the harness is built to run.
`docs/prompt-templates/` holds copies of the built-in prompt bodies.
