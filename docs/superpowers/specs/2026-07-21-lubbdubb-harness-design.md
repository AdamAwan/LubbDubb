# LubbDubb — Orchestration Harness (v1 Design)

**Date:** 2026-07-21
**Status:** Approved design, pre-implementation
**Scope of this doc:** The harness *core* only. Real DevOps/calendar/Gmail connectors, strategic (metric-driven) prioritization, confidence-gated auto-send, and learned preferences are designed *around* but explicitly **not built** in v1.

---

## 1. Vision

A self-hosted, always-running Node server that acts as a **cockpit** for one software engineer's work. It is the only web page the user needs open. It shows everything in flight (agents, PRs, stories, backlog health, calendar) and — the point — runs a behind-the-scenes **harness** that watches inputs, decides what to do, and dispatches AI agents to do it autonomously, escalating to the human only what genuinely needs judgment.

The name *LubbDubb* is the heartbeat: the server's core is a periodic pulse that drives everything.

---

## 2. Core decisions (locked)

| Decision | Choice |
|---|---|
| Agent runtime | **Claude Code** driven interactively through a **PTY** (`node-pty`). **Not** `claude -p` / headless. |
| Workspaces | **Git worktrees**, created **on demand only when a task reads/writes code**, keyed by branch, **reused** if a worktree for that branch already exists. Desk tasks get no worktree. |
| Decision engine | An **LLM dispatcher agent** decides what to do each cycle. Free reasoning in, **bounded structured action list** out. Optional "steering priorities" injected into its prompt only as a corrective if it misbehaves. |
| Inputs (v1) | **Fake connector** behind a clean interface; events can be **injected** into it. |
| Restart resilience | **Agents die with the server.** On restart, reconcile: mark dead agents `interrupted`; dispatcher decides whether to resume. |
| Dispatcher execution | **All Claude Code** (no Anthropic API key). Dispatcher is itself a PTY Claude Code "desk" session that returns a structured plan. |
| Persistence | **SQLite** (`better-sqlite3`), single file. |
| Stack | Node + TypeScript, **Fastify** (HTTP) + **ws** (WebSocket), **node-pty**, **React + Vite** SPA. |

---

## 3. Scope

### In scope (v1)
- Always-on Node server with a configurable **heartbeat**.
- **Dispatcher agent**: full state snapshot in → validated ordered action plan out.
- **Agent lifecycle manager**: spawn / stream / detect-waiting / detect-done / feed-input / kill for PTY Claude Code sessions.
- **On-demand worktrees**, keyed by branch, reused if present.
- **Two task types**: code tasks (need a worktree) and desk tasks (no worktree).
- **Fake connector** behind a clean interface + an **inject-event** mechanism.
- **Cockpit UI**: live overview of agents/tasks/escalations, drill-down, live agent output, kill switch.
- **Escalation inbox**: parked items with a way to respond.
- **Persistence + reconcile-on-restart.**
- **Audit log** of every decision and action, with reasons.

### Out of scope (v1) — designed around, not built
- Real Azure DevOps / calendar / Gmail adapters.
- Feature-level, success-metric-driven prioritization.
- Confidence-gated auto-send of side-effectful actions (PR replies, pushes).
- Learned user preferences / review style.
- Detached (tmux-backed) agents that survive restarts.

---

## 4. Architecture

A single Node/TypeScript process exposing HTTP + WebSocket, built as isolated modules that communicate through defined interfaces. Any one module (especially `Connector`) can be swapped without touching the rest.

```
                       ┌──────────────────────────────────────────────┐
                       │                LubbDubb server                │
  inject event  ─────► │  ┌───────────┐   tick    ┌───────────────┐    │
                       │  │ Connector │◄──────────│   Heartbeat   │    │
                       │  │ (Fake v1) │           └──────┬────────┘    │
                       │  └─────┬─────┘                  │ cycle       │
                       │        │ getState()             ▼             │
                       │        │              ┌───────────────────┐   │
                       │        └─────────────►│    Dispatcher     │   │
                       │        ┌──────────────│ (PTY claude desk) │   │
                       │        │ actions      └───────────────────┘   │
                       │        ▼                                      │
                       │  ┌───────────────┐   ┌───────────────────┐    │
                       │  │ ActionExecutor│──►│    AgentManager   │──┐ │
                       │  └───────┬───────┘   │  (node-pty)       │  │ │
                       │          │           └─────────┬─────────┘  │ │
                       │          │                     │ needs code │ │
                       │          ▼                     ▼            │ │
                       │  ┌───────────────┐   ┌───────────────────┐  │ │
                       │  │EscalationInbox│   │  WorktreeManager  │  │ │
                       │  └───────┬───────┘   └───────────────────┘  │ │
                       │          │                                  │ │
                       │          ▼         ┌───────────────┐        │ │
                       │      ┌───────┐◄─────│  CockpitAPI   │◄───────┘ │
                       │      │ Store │      │  + WebSocket  │  stream  │
                       │      │(SQLite)│     └───────┬───────┘          │
                       │      └───────┘             │                  │
                       └────────────────────────────┼──────────────────┘
                                                     ▼
                                            Cockpit SPA (React)
```

### Components

- **`Heartbeat`** — a timer; each tick triggers a dispatch cycle. Also fires a cycle immediately when an event is injected.
- **`Connector` (interface)** — `getState()` returns the world snapshot (tickets, PRs, CI status, comments, calendar). v1 impl `FakeConnector` is backed by an editable in-SQLite store plus an inject API.
- **`Dispatcher`** — assembles snapshot + fleet state, runs a PTY Claude Code desk session, returns a **validated** action plan. Optional steering priorities are injected into its prompt from config.
- **`ActionExecutor`** — turns each Action into effects; applies reconcile/guard rules and the concurrency cap; writes the audit log.
- **`AgentManager`** — owns PTY Claude Code sessions: spawn, stream, detect-waiting, detect-done, feed input, kill. Tracks per-agent status.
- **`WorktreeManager`** — lazily creates/reuses git worktrees keyed by branch; code tasks only.
- **`Store`** — SQLite persistence: tasks, agents, escalations, decisions/audit, connector-events.
- **`EscalationInbox`** — parked items + routing of the human's responses.
- **`CockpitAPI` + WebSocket** — serves the SPA and streams live updates.
- **Cockpit SPA** — the single web page.

---

## 5. The heartbeat → dispatch cycle (data flow)

Each cycle (timer-driven or injected-event-driven):

1. **Snapshot.** `Connector.getState()` gathers the world; `Store` adds current fleet state (running / parked / recently-finished).
2. **Dispatch.** Combined snapshot → `Dispatcher` → **validated action plan**: an ordered list of Actions, each from a bounded vocabulary, each carrying a `reason` string.
3. **Reconcile & guard.** Drop actions that duplicate live work (e.g. don't start a second agent for a PR that already has one); enforce the **concurrency cap** (default 3, configurable). Deferred actions wait for the next tick.
4. **Execute.** `ActionExecutor` runs each surviving action. Every decision + action is written to the **audit log** with its reason.
5. **Broadcast.** State changes stream to the cockpit over WebSocket.

### Action vocabulary (bounded)

The dispatcher reasons freely but may only emit these:

| Action | Meaning |
|---|---|
| `dispatch_code_agent` | Start a Claude Code agent in a worktree for a code task. |
| `dispatch_desk_agent` | Start a Claude Code agent in a scratch dir for a non-code task (backlog grooming, WAF pillars, meeting prep). |
| `escalate_to_human` | Park a decision for the user with type + context. |
| `respond_to_agent` | Feed input to an existing waiting agent. |
| `reply_on_pr` | Draft a PR reply (v1: draft only, requires human approval to send). |
| `no_op` | Explicitly do nothing (recorded, so "nothing happened" is auditable). |

Each action is schema-validated after the dispatcher returns; malformed items are rejected and logged rather than executed.

---

## 6. Agent lifecycle (top technical risk)

`AgentManager` runs each Claude Code session via **`node-pty`**:

- **Spawn** — launch `claude` in the task's cwd (worktree for code tasks, scratch dir for desk tasks) and send an initial prompt built from the task.
- **Stream** — capture stdout continuously, persist the transcript, push deltas to the cockpit over WS.
- **Detect "waiting for input"** — watch PTY output for Claude Code's prompt/permission/idle signals. On detection, status → `waiting`; the agent either auto-responds (whitelisted approvals from config) or **escalates**.
- **Detect "done"** — process exit, or a completion sentinel we instruct the agent to emit.
- **Feed input** — write to the PTY (user response, approval, follow-up).
- **Kill** — fleet kill-switch and per-agent stop terminate the process and mark the task `interrupted`.

**Risk & mitigation.** PTY signal-detection is inherently heuristic. We isolate all of it behind a single `PtySession` abstraction (`onWaiting`, `onDone`, `onOutput`, `send`, `kill`) with a well-defined interface, so the heuristics can be tuned and tested independently without affecting the rest of the system. The "read structured output from a PTY" problem is solved once here and reused by the dispatcher.

---

## 7. Human-in-the-loop (escalation)

An **escalation** is created when: the dispatcher chooses `escalate_to_human`; an agent hits a `waiting` state that isn't whitelisted; or an agent finishes work needing sign-off.

- Fields: `type` (`approve_change` | `answer_question` | `resolve_ambiguity` | `review_reply`), `context` (a typed `EscalationContext`), and the agent's current state.
- **`context` carries enough to answer in-place** so the human rarely needs to leave the card: the originating world signal (`originRef`, e.g. `pr:42:ci`/`issue:12`), a sentinel-stripped tail of the agent's output leading up to the question (`recentOutput`), the task title, and — for PR reply/merge escalations — the drafted reply, PR number and confidence. The card links to the agent's transcript drawer and offers one-click Yes/No answers for prompts that read as a yes/no decision.
- Surfaced in the cockpit **inbox** (the **Needs you** column).
- **Response routing:** for a *live parked PTY agent*, the user's answer is typed straight into its session and it continues; for a *dispatcher-level* escalation, the answer becomes an input the next dispatch cycle sees.
- **Safety:** nothing side-effectful (a PR reply, a pushed change) leaves the system without the user's explicit action in v1. The harness drafts; the human approves.

---

## 8. Persistence & restart

- **Store:** SQLite (`better-sqlite3`), one file. Tables: `tasks`, `agents`, `escalations`, `decisions` (audit), `connector_events`.
- **Reconcile on restart:** on boot, any agent still marked `running` is really dead (its PTY died with the server) → mark `interrupted`. The next dispatch cycle decides whether to resume.

---

## 9. Configuration

A single config file controls:
- `heartbeatIntervalMs` (default e.g. 5 min)
- `maxConcurrentAgents` (default 3)
- `whitelistedApprovals` — PTY prompt patterns the harness may auto-answer
- `steeringPriorities` — optional ordered hints injected into the dispatcher prompt (empty by default)
- `claudeCommand` / working-dir roots

---

## 10. Tech stack

- Node + TypeScript
- **Fastify** (HTTP) + **ws** (WebSocket)
- **node-pty** (agent sessions)
- **better-sqlite3** (persistence)
- **React + Vite** (cockpit SPA)

---

## 11. Top risks

1. **PTY state detection** (waiting vs done vs mid-output) is heuristic — isolated behind `PtySession`, tested hard.
2. **Structured output from an interactive REPL** (dispatcher plan) — solved once, reused.
3. **Reconcile correctness** after restart — must never leave a task both "running" and orphaned.

---

## 12. Definition of done (v1 walking skeleton)

You can: start the server, open the cockpit, **inject** "CI failed on PR #42", watch the heartbeat fire, see the dispatcher decide (with a logged reason), watch a Claude Code agent spawn in a reused-or-new worktree, stream its output live, have it hit a `waiting` state that **escalates** to the inbox, **respond** from the cockpit, see the agent continue, and see the whole decision/action trail in the audit log. Restart the server mid-flight and see the fleet reconcile cleanly.
