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
  (better-sqlite3), which keeps the harness logic race-free — lean on that.
- **`src/harness.ts`** is the pulse: snapshot world → `Dispatcher.decide` → `ActionExecutor`
  → audit. Cycles are coalesced (one in flight at a time).
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
they are detected for status transitions _and_ stripped from displayed output. If you touch
detection, keep those two behaviors in sync and preserve the cross-chunk handling (sentinels
can split across two data chunks).

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
logic in pure functions so it stays unit-testable without HTTP.

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
