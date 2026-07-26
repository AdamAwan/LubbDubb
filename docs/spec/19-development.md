# 19 — Development and quality

## Fresh clone

`node_modules` is not committed, and **`better-sqlite3` and `node-pty` are native builds**, so a clean
checkout needs `npm ci` (or `npm install`) before anything runs — and it is not instant.
`npm run web:build` bundles the cockpit SPA into `web/dist`, which the server serves in production.

Node 20 or newer (`engines.node: ">=20"`). CI runs Node 22.

## The one gate

```bash
npm run check   # = format:check && lint && typecheck && typecheck:web && knip && test
```

CI enforces exactly the same thing on every PR. Failure modes that are not obvious:

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
| `npm start`           | Runs the server via tsx.                                                      |
| `npm run dev`         | The same, with `--watch`.                                                     |
| `npm test`            | `node --import tsx --test test/**/*.test.ts`.                                 |
| `npm run test:coverage` | The suite under c8 (`.c8rc.json`; `src/server/main.ts` excluded).           |
| `npm run smoke`       | The real end-to-end run (see below).                                          |
| `npm run build`       | `tsc -p tsconfig.json`.                                                       |
| `npm run web:dev`     | Vite dev server for the cockpit.                                              |
| `npm run web:dev:demo`| The cockpit against the scripted demo backend, no server needed.              |
| `npm run web:build`   | Production bundle into `web/dist`.                                            |
| `npm run web:build:demo` | The demo bundle for GitHub Pages.                                          |
| `npm run audit`       | `npm audit --audit-level=high`.                                               |

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
