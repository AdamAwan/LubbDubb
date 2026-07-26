# 01 — System overview

LubbDubb is a self-hosted orchestration harness. It watches a set of work inputs (pull requests,
issues/work items, backlog stories), decides what should happen, and dispatches Claude Code agents to
do it — each in its own git worktree — while a browser cockpit shows the fleet and collects the
decisions a human has to make.

It runs as a single Node process: an HTTP/WebSocket server, a timer-driven decision loop, a SQLite
database, and a set of child processes (one per live agent).

## The loop

The system is one repeating cycle, driven by a heartbeat (`heartbeatIntervalMs`, default 5 minutes)
and also triggerable on demand:

```
snapshot the world  →  diff against the last snapshot  →  reconcile plans
      →  decide (dispatcher)  →  execute (executor)  →  audit
```

Every step is recorded. The dispatcher's rationale, every action it emitted, and the outcome of each
action are written to the `decisions` table, so an idle cycle is as explainable as a busy one.

## Components

| Component            | Module                              | Responsibility                                                        |
| -------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| Composition root     | `src/system.ts`                     | Wires every module through its interface; the only place they meet     |
| Entry point          | `src/server/main.ts`                | Loads config, boots, resumes orphans, serves, shuts down cleanly       |
| Config               | `src/config.ts`                     | Defaults, file overrides, env overrides, path resolution               |
| Store                | `src/store/store.ts`                | The only module that touches SQLite                                    |
| Connector (read)     | `src/connector/connector.ts`        | The seam the world is read through                                     |
| Action sink (write)  | `src/sink/actionSink.ts`            | The seam side-effectful actions are written through                    |
| Integrations         | `src/integrations/`                 | Per-capability providers (`fake`, `github`, `azure`) behind both seams |
| Harness              | `src/harness.ts`                    | The pulse: snapshot → diff → reconcile → decide → execute              |
| Dispatcher           | `src/dispatcher/`                   | Decides what to do; deterministic rules or an LLM                      |
| Executor             | `src/executor/actionExecutor.ts`    | Turns a validated action plan into effects, applying the guard rails   |
| Agent manager        | `src/agents/agentManager.ts`        | Owns the live agent fleet: spawn, stream, park, answer, kill, reap     |
| Agent runtimes       | `src/agents/`, `src/pty/`           | Two interchangeable ways to run an agent (stream-JSON, PTY)            |
| MCP tool channel     | `src/mcp/`                          | The typed, bidirectional channel agents call back on                   |
| Plans                | `src/plans/`                        | The multi-PR planning funnel and its reconciliation                    |
| Worktrees / git      | `src/worktree/`, `src/git/`         | Per-branch checkouts, and the read-only git observer                   |
| Escalations          | `src/escalation/`                   | The human-in-the-loop inbox                                            |
| Error log            | `src/errorLog.ts`                   | The one path every caught failure funnels through                      |
| Server               | `src/server/`                       | Fastify REST + `/ws`, and the state snapshot the cockpit reads         |
| Cockpit              | `web/`                              | The React SPA                                                          |

## Vocabulary

| Term            | Meaning                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------- |
| **World**       | The outside state at one instant: open PRs, recently-closed PRs, issues, stories                    |
| **Cycle/pulse** | One pass of the loop, identified by a `cyc_*` id                                                    |
| **Origin ref**  | A stable string naming the world signal a piece of work exists for, e.g. `pr:42:ci`, `issue:12`     |
| **Task**        | A unit of work materialised at dispatch time; owns a branch (code) or a scratch dir (desk)          |
| **Agent**       | A live Claude Code process working a task                                                          |
| **Job**         | An operator-queued prompt that persists *before* dispatch and waits for a slot                      |
| **Action**      | One item of the dispatcher's bounded output vocabulary                                              |
| **Decision**    | One executed/deferred/rejected/skipped action, persisted with its reason                            |
| **Escalation**  | A question parked for a human                                                                       |
| **Plan**        | One issue's delivery verdict — one PR (`single`) or several (`parts`)                               |
| **Finding**     | Something an agent noticed outside its own task                                                     |

## Task kinds

- **`code`** — runs in a git worktree of `repoRoot`, on a named branch. Worktrees are keyed by branch
  and reused, so two tasks on one branch share one checkout.
- **`desk`** — runs in a scratch directory under `deskRoot`, keyed by task id. No branch, no worktree.

## The two dispatchers

`config.dispatcher` selects one:

- **`rule`** (default) — `RuleDispatcher`, deterministic and dependency-free. It is the reference
  implementation and the only one that implements the planning funnel, prompt templates and the
  "Up next" queue.
- **`claude`** — `ClaudeDispatcher`, a Claude Code session that reads the state and emits a JSON plan
  between sentinels. Its output passes through the identical zod schema, so it can only ever ask for
  actions the rule dispatcher could also emit.

## The two agent runtimes

Both implement `AgentSession` and emit the same events, so `AgentManager`, the `Hub` and the cockpit
are agnostic to which is running:

- **`stream`** (default) — `claude -p --output-format stream-json`. No terminal, no TUI.
- **`pty`** — a real pseudoterminal running the interactive `claude` REPL. This is the only resumable
  runtime and the only one that captures account rate limits.
- **`raw`** — runs `claudeCommand`/`claudeArgs` verbatim over a PTY with the prompt in
  `LUBBDUBB_PROMPT`. Used by the mock-agent demo and tests.

## Standing invariants

These hold across the whole system. Each is stated again, with its mechanism, in the document that
owns it.

1. **The store is the only thing that touches SQLite.** Every other module goes through `Store`.
2. **The harness reads the world through one interface (`Connector`) and writes through one
   (`ActionSink`).** Providers are swapped by config, never by code changes elsewhere.
3. **The dispatcher's output is validated at the boundary.** Anything that does not match
   `ActionSchema` is rejected and audited, never executed.
4. **At most one code agent works a given branch.** Enforced by the origin gate, and — where origin
   does not determine branch — by an explicit branch gate.
5. **At most one agent works a given origin.** `Store.findActiveTaskByOrigin` gates every dispatch.
6. **The concurrency cap and the pause flag are read by reference every cycle.** Runtime changes take
   effect on the next cycle without a restart.
7. **Nothing side-effectful leaves the machine autonomously unless auto-send is enabled, the action
   type is allow-listed, and the stated confidence clears the threshold.** Otherwise it is drafted
   and escalated.
8. **Every caught failure is recorded through `ErrorLog.record`.** It is persisted, mirrored to
   stderr, and streamed to the cockpit.
9. **Every decision is auditable.** Executed, deferred, rejected and skipped alike, each with a
   human-readable reason and (for rule-dispatcher actions) the rule id that produced it.
10. **The store holds intent; the outside world is the source of truth.** Plan reconciliation folds
    observed reality back onto the store's rows every pulse, and every fold is idempotent.

## Boot sequence

`src/server/main.ts` performs exactly this order:

1. `loadConfig()`.
2. `buildSystem(config)` — wires everything; opens the database and applies the schema + migrations.
3. `system.mcp.listen()` when `mcp.enabled`. A false return is a supported outcome: agents then run
   on the sentinels alone.
4. `reconcileAndResumeOnBoot(...)` — resumes or interrupts agents orphaned by the previous run,
   **before** anything new is dispatched, so resumed agents occupy their concurrency slots first.
5. `buildApp(system)` and `app.listen({ port, host: '0.0.0.0' })`.
6. `harness.start()` (the heartbeat) and one immediate `harness.runCycle('boot')`.

Shutdown on `SIGINT`/`SIGTERM`: stop the heartbeat, `agents.interruptAll()` (interrupt, not kill, so
the next boot can resume), close the MCP server, close the HTTP server, close the store, exit 0.
