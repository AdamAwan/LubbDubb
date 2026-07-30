# 19 — Development and quality

## Fresh clone

`node_modules` is not committed, and **`better-sqlite3` and `node-pty` are native builds**, so a clean
checkout needs `npm ci` (or `npm install`) before anything runs — and it is not instant.
`npm run web:build` bundles the cockpit SPA into `web/dist`, which the server serves in production.

Node 20 or newer (`engines.node: ">=20"`). CI runs Node 22.

## The one gate

```bash
npm run check   # format:check, lint, typecheck, typecheck:web, knip, test
```

CI enforces exactly the same six commands on every PR, as separate steps across two jobs — CI stays
the source of truth for _what_ is verified. Locally `scripts/check.ts` runs them concurrently and
cached, which changes only the scheduling and the reporting:

- **A weighted pool, sized to the core count.** Each static stage counts as one job; `test` counts
  as `availableParallelism() - 1`, because node's test runner spawns its own worker pool and
  counting it as a single job oversubscribes the box badly enough to be slower than the chain.
  Stages are declared slowest-first and admitted in that order, so the long poles (`knip`, then the
  typecheckers) start while there is still room and the cheap stages fill in behind them. On a
  single core the pool admits one at a time, i.e. the old behaviour.
- **Every stage runs even when one fails**, and each failure is reported. The chain stopped at the
  first, so a formatting slip hid a type error until the next run.
- **Output is buffered per stage** and printed under its own heading, failures first, then a timing
  summary. Six concurrent writers to one terminal is unreadable, so only a progress line per stage
  streams live.
- **Every static stage is cached**, under `node_modules/.cache/` — which means `npm ci` invalidates
  the lot and no `.gitignore` entry is needed. Prettier and ESLint take `--cache`; both typecheckers
  run `--incremental` with an explicit `--tsBuildInfoFile` (explicit so the `build` script, which
  emits, cannot share a `.tsbuildinfo` with a `--noEmit` pass); knip takes `--cache`, which helps
  least of the five because its analysis is whole-graph by nature. Caches are correctness-neutral
  and tested as such — each one catches an error introduced after a clean run. `rm -rf
node_modules/.cache` forces cold.

The shape of the cost, which is why the above is worth having: the test suite is **startup-bound**,
not work-bound. Roughly half its files finish in under half a second, and each worker pays tsx's
transpile boot (~230ms against ~30ms for bare node). So the suite is the floor on wall time, and the
entire static half now finishes inside it — a warm run costs about what `test` alone costs.

Failure modes that are not obvious:

- **knip** fails the build on **every** class of unused code it can find. Adding an `export` nothing
  imports, a type nothing names, a dependency you do not end up using, or a public method nothing
  calls turns `check` red. Remove dead code or wire it up. **Every** rule is `error` — there is no
  `warn` tier, so nothing accumulates unnoticed: files, dependencies, devDependencies,
  optionalPeerDependencies, unlisted, unresolved, binaries, exports, types, namespace exports/types,
  duplicates, enum members and class members. Two switches widen it beyond knip's defaults:
  `includeEntryExports` (an entry file's own exports are checked too, so a helper exported from a
  test or a script is held to the same standard) and `include: ["classMembers"]`.

  The usual fix for a type or a helper reported here is to **drop the `export` keyword**, not to
  delete it: a type naming an exported function's parameters or return value stays perfectly usable
  by callers without being exported, and structural typing means nothing downstream breaks.
  ESLint's `no-unused-vars` then catches whatever is left genuinely dead.

  Class-member analysis is **name-based**, so a method reached only through a structural seam — an
  interface the class satisfies without declaring `implements` — reads as unused. Two honest ways
  out, and neither is an ignore list: declare the `implements` clause when the interface is the
  class's own contract (`PtySession implements AgentSession`), or tag the member `@public` with a
  note naming the seam when the interface belongs to a consumer that must not be depended on
  backwards (`AgentManager.recordProgress`, reached through `AgentToolTarget` in `src/mcp/`).
- **Two typecheckers.** `typecheck` covers the server (`tsconfig.json`) and `typecheck:web` the cockpit
  (`web/tsconfig.json`). They are separate passes, so a change spanning `src/` and `web/` must satisfy
  both.
- **format:check** is Prettier in check mode over `src/**/*.ts`, `test/**/*.ts`, `web/**/*.{ts,tsx}`,
  `scripts/*.ts` and root-level `*.{json,md}`. Run `npm run format` to fix; do not hand-format.

CI additionally runs `npm run smoke` and coverage, and there are CodeQL and security workflows.

## Scripts

| Script                | Does                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| `npm start`           | Builds the cockpit bundle, then runs the server via tsx.                      |
| `npm run start:server`| The server alone, serving whatever `web/dist` already holds.                  |
| `npm run dev`         | The server with `--watch`, no cockpit build (see below).                      |
| `npm test`            | `node --import tsx --test test/**/*.test.ts`.                                 |
| `npm run test:coverage` | The suite under c8 (`.c8rc.json`; `src/server/main.ts` excluded).           |
| `npm run smoke`       | The real end-to-end run (see below).                                          |
| `npm run build`       | `tsc -p tsconfig.json`.                                                       |
| `npm run web:dev`     | Vite dev server for the cockpit.                                              |
| `npm run web:dev:demo`| The cockpit against the scripted demo backend, no server needed.              |
| `npm run web:build`   | Production bundle into `web/dist`.                                            |
| `npm run web:build:demo` | The demo bundle for GitHub Pages.                                          |
| `npm run audit`       | `npm audit --audit-level=high`.                                               |
| `npm run check`       | The one gate: the six stages above, concurrently, via `scripts/check.ts`.      |

**`npm start` builds the cockpit first, and that is not a convenience.** The server needs no
build step — tsx runs it from source — but the SPA does, and `web/dist` is gitignored, so it is
whatever the last `web:build` on that machine produced. The server serves it on an `existsSync`
check alone (`app.ts`): there is no version stamp and no comparison against `web/src`, so a
bundle months out of date is indistinguishable from a fresh one and fails silently, at a distance,
in the browser. That was not hypothetical — a `web/dist` predating the cockpit token guard has no
`readToken`, so it attaches no `Authorization` header and no `?t=` to the socket, and the symptom
is every request 401ing and every WebSocket upgrade refused, on a machine where restarts and hard
refreshes change nothing. Building first removes the failure rather than documenting it; the build
is well under a second, which is what makes paying it every start the right trade.

`npm run dev` deliberately does **not** build: `--watch` restarts the server on every `src/` edit,
and rebuilding the bundle on each of those would make the loop useless. Cockpit work belongs in
`npm run web:dev`, where Vite compiles from source and no artifact can go stale. `start:server` is
the escape hatch for the case where the build must not run — a checkout installed with
`--omit=dev` has no vite.

## Conventions

- **ESM with explicit `.js` import extensions**, even from `.ts` sources:
  `import { Store } from './store/store.js';`. New files must follow this or module resolution breaks.
  `type: "module"`, TypeScript `nodenext`.
- **Comments explain *why*, not *what*.** Match the existing terse, high-signal style; do not narrate
  the code.
- **Typed `emit`/`on` overrides** on `EventEmitter` subclasses (see `AgentManager`, `Harness`,
  `ErrorLog`) — keep event payloads typed at the call site when you add events.
- **Domain types live in `src/types.ts`**; the cockpit has its own `web/src/types.ts`.
- **`src/system.ts` is the composition root.** Every module is wired there through its interface, so
  any one is swappable. A new component is threaded through it.

## Testing seams

Tests build a full `System` with fakes injected via `buildSystem(config, opts)`:

| Option           | Replaces                                                                       |
| ---------------- | -------------------------------------------------------------------------------- |
| `backend`        | `NodePtyBackend` → `FakePtyBackend` (`src/pty/fakeBackend.ts`). Drive it with `.last().emit(...)` / `.emitExit(...)`; inspect `.writes`. |
| `streamSpawner`  | The real child process for the stream-JSON runtime.                            |
| `sink`           | The outbound seam (defaults to the composite connector).                       |
| `gitObserver`    | `GitCliObserver` → `FakeGitObserver`. Injecting one also turns the reconciler's `git fetch` off. |
| `errorMirror`    | The stderr echo (tests silence it).                                            |

Plus `dbPath: ':memory:'` for an in-memory database.

That combination exercises the whole **inject → dispatch → agent → escalate → answer → done** loop
without a model, a network or a real terminal. Prefer adding tests at that seam. Put new tests in
`test/*.test.ts`; do not edit unrelated test files.

The provider tests follow the same pattern: all HTTP sits behind a narrow `*Api` seam
(`GitHubApi`, `AzureDevOpsApi`), one file per provider imports the real client, and tests inject a
scripted fake — **no network**. Field-mapping logic is exported as pure functions and tested directly.
Extending a provider means adding to the interface **and its scripted fake in the same change**.

The MCP tests drive `mcp.session(agentId)`, which converges on the same dispatch an agent's bridge
reaches — there is no test-only tool path.

## The smoke run

`npm run smoke` (`scripts/smoke.ts`) is the half unit tests cannot cover: a real `node-pty` backend,
the `scripts/mock-agent.sh` program, a real temporary git repository (initialised explicitly with
`-b main`, because agent branches are cut from `config.defaultBranch` while bare `git init` takes
whatever the host's `init.defaultBranch` says), and a real `bridge.mjs` child over a real socket.

It proves the highest-risk path end to end: inject a CI failure → the harness decides → an agent spawns
in a git worktree over a PTY → it reaches a waiting state that escalates → the answer is delivered →
it continues → it finishes.

The unit and integration suite deliberately needs **no** native processes, because it injects fakes.

## Making a change safely

1. Find the spec document that owns the behaviour ([docs/README.md](../README.md) indexes them) and
   read the invariants it states.
2. Change the code.
3. **Update the spec in the same change.** These documents are the truth of the application; a code
   change that leaves them stale has introduced a discrepancy, which is a bug by the contract in the
   index.
4. Add or extend a test at the `buildSystem` seam, or a unit test for a pure function.
5. Run `npm run check`.

Two recurring shapes worth knowing before you start:

- **A column added to an existing table** needs an additive `ALTER TABLE` in `Store.migrate()`, guarded
  by a `PRAGMA table_info` check. A brand-new table does not.
- **A new dispatcher branch** needs a `DISPATCH_RULES` registry entry, its id tagged onto every action
  it emits, and — if it dispatches an agent — routing through the candidate list rather than an inline
  `raw.push`.
