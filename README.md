# LubbDubb

A self-hosted, always-running **orchestration harness** for one software engineer's work — a _cockpit_ that watches your inputs (PRs, CI, review comments, backlog, calendar), decides what to do on a heartbeat, and dispatches AI agents to do it autonomously, escalating to you only what genuinely needs judgment.

The name is the heartbeat: the server's core is a periodic pulse that drives everything.

> **v1 status — walking skeleton.** The harness _core_ is built and tested end-to-end, now with **confidence-gated auto-send** (opt-in) for side-effectful actions. Real DevOps/calendar/Gmail connectors and metric-driven prioritization are designed _around_ but deliberately **not** built yet. See [`docs/superpowers/specs/2026-07-21-lubbdubb-harness-design.md`](docs/superpowers/specs/2026-07-21-lubbdubb-harness-design.md).

---

## What it does

Every heartbeat (or immediately when an event is injected) the harness:

1. **Snapshots** the world via a `Connector` (v1: a `FakeConnector` you can inject events into).
2. **Dispatches** — hands the full state to a decision engine that returns a **bounded, schema-validated action plan**.
3. **Guards & executes** — de-duplicates work already in flight, enforces a concurrency cap, then runs each action, spawning Claude Code agents in git worktrees (code tasks) or scratch dirs (desk tasks).
4. **Escalates** anything it can't safely decide to a human inbox.
5. **Audits** every decision and action, with reasons.

The default priorities (encoded in the `RuleDispatcher`) come straight from the product vision:

| Signal                                                  | Action                                             |
| ------------------------------------------------------- | -------------------------------------------------- |
| A PR's CI is failing                                    | Spin up a code agent to fix it                     |
| A PR has an unhandled review comment                    | Spin up a code agent to address/defend             |
| A meeting today lacks prep                              | Desk agent reads the docs and summarises           |
| A ready story lacks a description / acceptance criteria | Desk agent drafts them                             |
| A ready story lacks WAF pillars                         | Desk agent fills them in                           |
| Idle capacity                                           | Pick up the highest-priority ready story           |
| Nothing actionable                                      | `no_op` (still recorded, so idleness is auditable) |

## Architecture

A single Node/TypeScript process (HTTP + WebSocket) built as isolated modules that talk only through interfaces — any one (especially the `Connector`) can be swapped without touching the rest.

```
inject ─► Connector ◄── Heartbeat ──► Dispatcher ──► ActionExecutor ──► AgentManager ──► PtySession(s)
             │ (Fake)      (pulse)     (rule|claude)    │ guard/cap          │                │ node-pty
             └── Store (SQLite) ◄───────────────────────┴── EscalationInbox  └── WorktreeManager
                                                            CockpitAPI + WebSocket ──► Cockpit SPA (React)
```

| Module            | Responsibility                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Heartbeat`       | The pulse — a timer that fires a dispatch cycle; can also be triggered on demand.                                                                    |
| `Connector`       | The seam to the outside world. `FakeConnector` is an editable, persisted world you inject events into.                                               |
| `Dispatcher`      | State in → validated action plan out. `RuleDispatcher` (deterministic default) or `ClaudeDispatcher` (drives a real Claude Code session over a PTY). |
| `ActionExecutor`  | Turns actions into effects; origin de-dup + concurrency cap; writes the audit log.                                                                   |
| `AgentManager`    | Owns the fleet of PTY agent sessions: spawn, stream, detect waiting/done, feed input, kill.                                                          |
| `PtySession`      | **All** the PTY waiting/done heuristics, isolated behind one testable abstraction (the top technical risk).                                          |
| `WorktreeManager` | Lazily creates/reuses git worktrees keyed by branch — code tasks only.                                                                               |
| `EscalationInbox` | The human-in-the-loop surface; routes answers into live agents or the next cycle.                                                                    |
| `Store`           | SQLite persistence + reconcile-on-restart.                                                                                                           |
| `Cockpit SPA`     | The single web page: fleet, inbox, world, live agent output, decision log, inject + kill.                                                            |

## Getting started

```bash
npm install          # builds native deps (better-sqlite3, node-pty)
npm run web:build    # build the cockpit SPA into web/dist
npm start            # start the server (serves the cockpit at http://localhost:4300)
```

Then open the cockpit, use the **Inject event** bar to simulate the world moving (a CI failure, a review comment, a new story, a meeting), and watch the harness react. Click an agent to see its live terminal and type into it; answer items in **Needs you** to unblock parked agents.

### Configuration

Create `lubbdubb.config.json` at the repo root (all keys optional):

```json
{
  "heartbeatIntervalMs": 300000,
  "maxConcurrentAgents": 3,
  "dispatcher": "rule",
  "claudeCommand": "claude",
  "claudeArgs": [],
  "whitelistedApprovals": [{ "match": "Allow running tests", "response": "yes" }],
  "steeringPriorities": [],
  "autoSend": { "enabled": false, "confidenceThreshold": 0.85, "allowedActions": ["reply_on_pr"] }
}
```

- **`dispatcher`** — `"rule"` (deterministic, no model calls) or `"claude"` (an LLM decides each cycle, output still schema-validated).
- **`claudeCommand` / `claudeArgs`** — how an agent session is launched. Defaults to `claude`. The included demo uses a mock agent (see below).
- **`whitelistedApprovals`** — PTY prompts the harness may auto-answer instead of escalating.
- **`steeringPriorities`** — optional hints injected into the LLM dispatcher's prompt.
- **`autoSend`** — confidence-gated autonomy for side-effectful actions. **Off by default**: with `enabled: false` the harness always drafts a PR reply and escalates it for sign-off (the v1 safety guarantee — nothing leaves without you). Turn it on and the harness sends a `reply_on_pr` itself _only_ when the dispatcher's `confidence` is `≥ confidenceThreshold` **and** the action type is in `allowedActions`; anything below the bar still drafts and escalates, and a failed send always falls back to an escalation so a reply is never dropped. Every send or escalation is written to the audit log with the reason. Auto-send goes through the outbound `ActionSink` seam (v1: the `FakeConnector` "sends" into its own fake world), so a real GitHub adapter drops in without touching the gate.
- Env overrides: `PORT`, `LUBBDUBB_DB`.

### Try the demo without a real model

`scripts/mock-agent.sh` is a stand-in that speaks the same PTY protocol as a real `claude` agent. The committed `lubbdubb.config.json` points at it, so `npm start` works with no model auth. Swap `claudeCommand` back to `claude` for the real thing.

## Development

```bash
npm run dev            # server with reload
npm run web:dev        # cockpit with HMR (proxies /api + /ws to the server)
npm run typecheck      # tsc --noEmit (server)
npm run typecheck:web  # tsc --noEmit (cockpit SPA)
npm test               # unit + integration tests (node:test)
npm run test:coverage  # tests with c8 coverage (text + lcov in coverage/)
npm run smoke          # full walking-skeleton E2E with real node-pty + a git worktree
```

### Code quality

```bash
npm run lint           # ESLint (typescript-eslint + react)
npm run lint:fix       # ESLint with autofix
npm run format         # Prettier write
npm run format:check   # Prettier check (what CI enforces)
npm run knip           # unused files / exports / dependencies
npm run audit          # npm audit at the "high" threshold
npm run check          # format:check + lint + typecheck (x2) + knip + test, in one shot
```

### Continuous integration

Every push and pull request against `main` runs three GitHub Actions workflows
(see [`.github/workflows`](.github/workflows)):

| Workflow     | What it does                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **CI**       | Prettier check, ESLint, typecheck (server + web), knip, tests with coverage (uploaded as an artifact), and a full server + cockpit build. |
| **Security** | `npm audit` (advisory), plus a dependency-review gate that blocks any PR introducing a new high-severity vulnerable dependency.           |
| **CodeQL**   | Static security-and-quality analysis of the JavaScript/TypeScript, also on a weekly schedule.                                             |

### The walking skeleton (Definition of Done)

`npm run smoke` proves the whole loop for real: inject _"CI failed on PR #42"_ → the dispatcher decides (with a logged reason) → a Claude-style agent spawns in a reused-or-new git worktree over a PTY → it hits a `waiting` state that **escalates** to the inbox → you answer → it continues → it finishes — and restart reconciliation is clean.

## Safety (v1)

Nothing side-effectful leaves the system autonomously. `reply_on_pr` **drafts** a reply and escalates it for your approval; the harness never posts to a PR or pushes on your behalf without an explicit human action.
