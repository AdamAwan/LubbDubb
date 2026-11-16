# CLAUDE.md — `test/`

Sharp edges for work under this directory, loaded when you read or edit a file here. It holds the
same genre as the root [`CLAUDE.md`](../CLAUDE.md) — what breaks **silently** — which keeps the
documentation rule, the conventions and the edges that can be tripped from anywhere.

## Tests

- **A test that dispatches a code agent must inject `worktrees`.** `config.repoRoot` defaults to
  `process.cwd()`, so without `FakeWorktreeManager` the test cuts a **real branch in your checkout**
  and nothing deletes it. Use the real manager only when git behaviour _is_ the subject, pointed at a
  throwaway repo from `test/support/gitRepo.ts`, and with `FakeSlotProcesses` — its default **kills** live processes.
  → [19](../docs/spec/19-development.md#why-a-test-must-not-dispatch-through-the-real-worktree-manager)
- **A test that touches `GET /api/issues/filing-target` or `POST /api/issues` must inject
  `upstream`.** The default is the real `gh` CLI against **AdamAwan/LubbDubb** — a test without
  `FakeUpstreamIssues` files a live issue on the project's tracker and passes while doing it.
  → [15](../docs/spec/15-integrations.md)
- **A test that configures an environment with a `validate` block must inject `stateReader` _and_
  `tenants`.** The defaults are the real `CommandStateReader`, which spawns the project's own
  `validate.state.run` against a **deployed store**, and the real `CommandTenantKeeper`, which spawns
  its `ensureTenant` and `reseed` — a test that queries somebody's environment, or **provisions a
  tenant in it**, and passes while doing it. What saves an ordinary test is only that a config with no
  `validate` block declares no command to run; rely on that deliberately. Use `FakeStateReader` and
  `FakeTenantKeeper`, each of which records what it was asked for.
  → [36](../docs/spec/36-remote-validation.md#seams-and-why-the-fake-comes-first)
- **A test that reads the project config layer injects `projectConfigFile`, or points `repoRoot` at
  a temp directory.** `lubbdubb.project.json` is read from `repoRoot`, and this repo is itself a
  LubbDubb target — the day one is committed here every test on the default starts merging it.
  → [02](../docs/spec/02-configuration.md#the-project-layer)
- **A test touching `/api/plugin` injects `pluginCli` and a temp `desktopCredentialPath`**, or it installs into your own Claude Code. → [11](../docs/spec/11-mcp-tools.md#the-plugin)
- **Tests build a whole `System`** via `buildSystem(config, opts)` with fakes injected (`backend`,
  `streamSpawner`, `sink`, `gitObserver`, `worktrees`, `errorMirror`) and `dbPath: ':memory:'`.
  Prefer that seam. New tests go in `test/*.test.ts`; do not edit unrelated test files.
