# LubbDubb

A self-hosted, always-running **orchestration harness** for one software engineer's work — a _cockpit_ that watches your inputs (PRs, CI, review comments, backlog, calendar), decides what to do on a heartbeat, and dispatches AI agents to do it autonomously, escalating to you only what genuinely needs judgment.

The name is the heartbeat: the server's core is a periodic pulse that drives everything.

> **v1 status — walking skeleton.** The harness _core_ is built and tested end-to-end, now with **confidence-gated auto-send** (opt-in) for side-effectful actions. Integrations are now **modular** — one interchangeable provider per capability (source control, issues, backlog, calendar), swappable via config — and two **real source-control/issues providers** are now built: **GitHub** (`"github"`, reading PRs/issues from the GitHub API, posting replies and merges) and **Azure DevOps** (`"azure"`, reading Repos pull requests + Boards work items, posting PR comments and completing PRs), each selectable per capability with an `integrations` entry plus its config block (`github` / `azureDevOps`) and a token. The remaining real adapters (calendar, Gmail) and metric-driven prioritization are designed _around_ and deliberately **not** built yet; every other capability still ships a `fake` provider. See [`docs/superpowers/specs/2026-07-21-lubbdubb-harness-design.md`](docs/superpowers/specs/2026-07-21-lubbdubb-harness-design.md).

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
| An operator queued a job from the cockpit               | Drain it first — take the next free slot           |
| A PR's CI is failing                                    | Spin up a code agent to fix it                     |
| A PR's base branch is out of date (conflicts / behind)  | Code agent merges the base in and resolves         |
| A PR has an unhandled review comment                    | Spin up a code agent to address/defend             |
| A PR is green, approved and mergeable                   | Merge it in (gated by auto-send)                   |
| An open GitHub issue has no linked PR                   | Spin up a code agent to resolve it into a PR       |
| A meeting today lacks prep                              | Desk agent reads the docs and summarises           |
| A ready story lacks a description / acceptance criteria | Desk agent drafts them                             |
| A ready story lacks WAF pillars                         | Desk agent fills them in                           |
| Idle capacity                                           | Pick up the highest-priority ready story           |
| Nothing actionable                                      | `no_op` (still recorded, so idleness is auditable) |

Together the issue and PR rules close the loop the harness is built around: **pick up
a GitHub issue → resolve it into a PR → drive that PR (CI green, comments handled,
base up to date, approved, mergeable) the last mile to merged.** The PR rules run
_before_ new-issue pickup, so a PR with problems is always worked ahead of starting
new tickets under limited headroom.

**Conflict vs behind.** GitHub's `mergeable_state` is mapped through the stack
(`dirty` / `behind` / `blocked` / `clean` / `unknown`) alongside the PR's `baseBranch`,
so the harness reacts precisely: a `dirty` PR gets a _resolve-the-conflicts_ agent, a
`behind` PR gets a clean _bring-it-up-to-date_ update (no conflict framing), and a
`blocked` PR (required checks/reviews unmet) is surfaced but never auto-acted. When the
state is `unknown`, a firm `mergeable === false` is treated as a conflict.

**One code agent per PR branch.** A PR can raise several concerns at once (failing CI,
a conflict, review comments). To avoid two agents racing the same worktree, when a
signal lands on a branch that already has a **running** agent the harness _tells that
agent_ (via `respond_to_agent`) instead of spawning a second one — deduped so the same
signal isn't repeated every cycle. While that branch's agent is parked **waiting** on a
human, the note is **held** (injecting would un-park the escalation) and delivered on a
later cycle once the agent is running again.

**PR health.** Every PR in `/api/state` carries a computed `health` (`{ blocked,
reasons }`) folding conflicts, behind-base, failing CI and unhandled comments, so the
cockpit shows _why_ a PR is stuck rather than leaving it implied by the absence of
activity.

**Issue pickup state.** Likewise every issue/work item carries a computed `pickup`
(`{ eligible, status, reasons }`) folding every gate that decides pickup — the policy
gates (pickup label, tag ownership, workflow state) _and_ the runtime ones (an agent
already on it, dispatch cooldown / spent attempt cap, paused or capacity-exhausted
fleet) — so the cockpit says what the harness is doing with each item (`agent
running`, `eligible`, `has open PR #N`) or exactly why it's leaving it alone
(`no pickup label "agent-ready"`, `dispatch paused`, `on cooldown after 2 attempts`).

**"Up next" queue.** The rule dispatcher ranks every agent-dispatch candidate before
applying the concurrency headroom cut, and the full ordered plan ships in `/api/state`
as `upcoming` — the cockpit renders it as an **Up next** panel with a cut-line between
what is dispatching this cycle and what waits for a free slot (cooling-down candidates
show greyed). It's a projection, not a committed queue: the dispatcher is stateless per
cycle, so the plan is "what's next as of the last pulse" and reorders as the world
changes. The LLM dispatcher materialises no plan (the panel says so).

**Claude usage.** Each agent's cumulative cost, tokens and turns (from the stream
runtime's per-turn `result` events) are persisted and shown on its fleet card and
drawer, and a topbar chip tracks account-level usage: the real subscriber 5h/weekly
limits when available (captured from the status-line payload in `pty` mode — Pro/Max
only), otherwise self-computed rolling 5h/7d cost windows summed from the per-turn
reports. Absent data degrades gracefully — no chip until there is something to show.

## Architecture

A single Node/TypeScript process (HTTP + WebSocket) built as isolated modules that talk only through interfaces — any one (especially the `Connector`) can be swapped without touching the rest.

```
inject ─► Connector ◄── Heartbeat ──► Dispatcher ──► ActionExecutor ──► AgentManager ──► PtySession(s)
             │ (Fake)      (pulse)     (rule|claude)    │ guard/cap          │                │ node-pty
             └── Store (SQLite) ◄───────────────────────┴── EscalationInbox  └── WorktreeManager
                                                            CockpitAPI + WebSocket ──► Cockpit SPA (React)
```

| Module              | Responsibility                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Heartbeat`         | The pulse — a timer that fires a dispatch cycle; can also be triggered on demand.                                                                                                                                                                                                                                                                     |
| `Connector`         | The seam to the outside world. Behind it, the world is assembled from modular per-capability **integrations** (source control, backlog, calendar), each with an interchangeable provider chosen in config; `CompositeConnector` merges their slices. v1 ships a `fake` provider per capability (an editable, persisted world you inject events into). |
| `Dispatcher`        | State in → validated action plan out. `RuleDispatcher` (deterministic default) or `ClaudeDispatcher` (drives a real Claude Code session over a PTY).                                                                                                                                                                                                  |
| `ActionExecutor`    | Turns actions into effects; origin de-dup + concurrency cap; writes the audit log.                                                                                                                                                                                                                                                                    |
| `AgentManager`      | Owns the fleet of agent sessions: spawn, stream, detect waiting/done, feed input, kill — over any runtime.                                                                                                                                                                                                                                            |
| `StreamJsonSession` | The production agent runtime: real `claude` over headless stream-JSON. No TUI, unattended, supports the waiting/answer loop.                                                                                                                                                                                                                          |
| `PtySession`        | Terminal runtime (mock agent / interactive claude); all PTY waiting/done heuristics isolated behind one testable abstraction.                                                                                                                                                                                                                         |
| `WorktreeManager`   | Lazily creates/reuses git worktrees keyed by branch — code tasks only. A cleanly finished agent's worktree is removed once its process exits (failed/killed ones keep theirs for debugging).                                                                                                                                                          |
| `EscalationInbox`   | The human-in-the-loop surface; routes answers into live agents or the next cycle, and auto-dismisses an agent's open escalations when it dies (restart/kill/crash) so "Needs you" never lingers un-actionable.                                                                                                                                        |
| `Store`             | SQLite persistence + reconcile-on-restart.                                                                                                                                                                                                                                                                                                            |
| `ErrorLog`          | The central error-recording path: every caught failure (cycle exceptions, provider outages, agent crashes + exit codes, route 500s) is persisted, mirrored to stderr, and streamed to the cockpit's Errors panel.                                                                                                                                     |
| `Cockpit SPA`       | The single web page: fleet, inbox, world, live agent output, decision log, activity feed, error log, inject + kill. External references (issues, PRs, branches) render as clickable links, using URLs the provider supplies.                                                                                                                          |

## Getting started

```bash
npm install                                        # builds native deps (better-sqlite3, node-pty)
cp lubbdubb.config.example.json lubbdubb.config.json # your local config (gitignored); the example runs the mock agent, no auth needed
npm run web:build                                  # build the cockpit SPA into web/dist
npm start                                          # start the server (serves the cockpit at http://localhost:4300)
```

Then open the cockpit, use the **Inject event** bar to simulate the world moving (a CI failure, a review comment, a new story, a meeting), and watch the harness react. The inject bar (and its `/api/inject` route) only exists while a `fake` provider is configured — synthetic events can't land on real integrations, so a real deployment hides it. Click an agent to see its live terminal and type into it — the drawer also shows the originating item (its title, a body excerpt or state summary, and the dispatcher's reason), captured at dispatch time so you can understand the work without leaving the cockpit. Use the **New job** panel to launch an ad-hoc job from a prompt — it queues server-side and the dispatcher drains it _ahead of_ all world-driven work (rule 0), so it takes the next free agent slot and simply waits in the queue (shown with its place in line, cancellable) when the fleet is at its concurrency cap. Answer items in **Needs you** to unblock parked agents. **Up next** shows the dispatcher's ordered pickup plan from the last pulse, with the cut-line at the current concurrency headroom — above it dispatches now, below it waits for a free slot. The **Decision log** shows what the harness decided each cycle — click a row to expand the dispatcher rule that produced it (its number, name and standing rationale); the **Activity** feed beside it shows how the _world itself_ changed over time — each cycle diffs the fresh `WorldSnapshot` against the previous one and records every observed transition (PR opened, CI green, story moved, meeting prep done), so it works for the real GitHub provider too, not just injected events.

### Configuration

Config lives in `lubbdubb.config.json` at the repo root (gitignored — it's your local file).
Copy the tracked `lubbdubb.config.example.json` as a starting point. All keys are optional:

```json
{
  "heartbeatIntervalMs": 300000,
  "maxConcurrentAgents": 3,
  "startPaused": false,
  "dispatcher": "rule",
  "claudeCommand": "claude",
  "claudeArgs": [],
  "whitelistedApprovals": [{ "match": "Allow running tests", "response": "yes" }],
  "steeringPriorities": [],
  "autoSend": { "enabled": false, "confidenceThreshold": 0.85, "allowedActions": ["reply_on_pr"] },
  "integrations": { "sourceControl": "fake", "issues": "fake", "backlog": "fake", "calendar": "fake" },
  "github": { "owner": "acme", "repo": "app", "filters": { "prAuthor": "lubbdubb-bot" } },
  "azureDevOps": {
    "organization": "acme",
    "project": "app",
    "repository": "app",
    "filters": { "prAuthor": "bot@acme.com", "workItemTag": "agent" }
  },
  "labelPrefix": "lubbdubb",
  "issuePickupRequireOwnLabel": false,
  "issuePriorityLabels": { "priority:high": 3, "priority:medium": 2, "priority:low": 1 },
  "issueDefaultPriority": 2
}
```

- **`maxConcurrentAgents`** — the concurrency cap seeding runtime control (see **Runtime control** below). Adjustable live without a restart; a restart reverts to this value.
- **`startPaused`** — boot with dispatch paused (default `false`). The only config-level pause knob; live pause/resume is runtime-only and ephemeral, so a restart reverts to this value.
- **`dispatcher`** — `"rule"` (deterministic, no model calls) or `"claude"` (an LLM decides each cycle, output still schema-validated).
- **`agentMode`** — how agents run:
  - `"stream"` _(default)_ — real Claude Code over headless stream-JSON (`claude -p --output-format stream-json`). No interactive TUI, runs unattended, and stays alive across turns so the waiting/answer loop works. The harness injects its status protocol via an appended system prompt.
  - `"pty"` — real Claude Code as an interactive terminal. Requires a `claude` that has completed first-run onboarding (theme, trust, login). This is the runtime that **resumes across restarts** (see below). The interactive REPL never ends a session by itself, so on the done signal the harness actively shuts it down (`/exit`, with a `SIGTERM` backstop) instead of leaving it parked at the prompt.
  - `"raw"` — run `claudeCommand`/`claudeArgs` verbatim (the mock-agent demo and tests).
- **`agentPromptDelayMs` / `agentSubmitDelayMs`** — PTY timing knobs (`agentMode: "pty"` only; ignored by `stream`). `agentPromptDelayMs` (default `1200`) waits for the interactive TUI to boot before the task is typed in. `agentSubmitDelayMs` (default `60`) is the gap between typing a message and sending its submitting carriage return: the claude TUI folds a single input burst into a paste and treats a trailing CR as a literal newline, so without the gap the message just sits in the input unsubmitted. Set it to `0` to write both at once.
- **`agentPermissionMode`** — passed to `claude --permission-mode` so unattended tool calls don't hang (default `acceptEdits`). Note: `bypassPermissions` maps to `--dangerously-skip-permissions`, which `claude` refuses under root — run the harness as a non-root user if you need it.
- **`claudeCommand` / `claudeArgs`** — the agent binary and any extra args. Defaults to `claude`.
- **`docsFolderPrefix`** — a worktree-relative folder that the **file-events hook** treats as the artifacts area. Any file an agent writes _under_ this prefix (e.g. `"docs"` → everything in `docs/`) is promoted to an **artifact chip** in the cockpit regardless of extension, on top of the built-in report/doc heuristic (report extensions like `.md`/`.html`/`.pdf` and any `reports/` folder). Unset = heuristic only. Artifact detection itself needs no per-skill cooperation: a `PostToolUse` hook captures every write, so a report surfaces without the agent's prompt knowing the flag protocol; **every** written file is also listed in the agent drawer's "files changed" view.
- **`whitelistedApprovals`** — waiting prompts the harness may auto-answer instead of escalating.
- **`steeringPriorities`** — optional hints injected into the LLM dispatcher's prompt.
- **`integrations`** — which provider fulfils each capability. The world behind the `Connector` is built from one integration per capability — `sourceControl` (pull requests, including their merge-readiness for PR monitoring), `issues` (GitHub-style issues the harness resolves into PRs), `backlog` (stories), `calendar` (meetings) — and each capability has interchangeable providers registered in `src/integrations/registry.ts`. This is the **swap switch**: change a value to point a capability at another provider without touching the harness, executor, or the other integrations. Three providers ship: the built-in `fake` (an editable, persisted world you inject events into) and two real ones for `sourceControl` and `issues` — **`github`** (see **`github`** below) and **`azure`** (Azure DevOps, see **`azureDevOps`** below). Unlisted capabilities keep the `fake` default; other real adapters (calendar, Gmail) are drop-ins — add them to the registry and select them here.
- **`github`** — the target for the real `github` provider (required when `integrations.sourceControl` or `integrations.issues` is `"github"`). `owner`/`repo` name the repository; optional `filters.prAuthor` narrows the PR slice to one author. Every open issue is ingested — what's _acted on_ is decided by the watch/ignore gate (`labelPrefix`), not an ingest filter. The **auth token is not configured here** — it comes from the `GITHUB_TOKEN` environment variable so a secret never lands in a committed config file. Selecting `github` without a `GITHUB_TOKEN` or without `owner`/`repo` is a clear startup error. `github` reads from the GitHub REST API each cycle (PRs with CI/checks status, review approvals, mergeability and unresolved review threads; issues with state and their linked PR) and, for auto-send, posts PR replies and merges through it; a transient GitHub error serves the last-good snapshot rather than dropping items from the world. It also builds the **canonical `github.com` URL** for any reference (a PR/issue number, an `issue/N` branch, a commit) so the cockpit can render external references as clickable links — URL construction lives here in the provider, never in the web layer.
- **`azureDevOps`** — the target for the real `azure` provider (required when `integrations.sourceControl` or `integrations.issues` is `"azure"`). `organization`/`project`/`repository` name the Azure DevOps Repo; optional `filters.prAuthor` narrows the PR slice to one author (by uniqueName/UPN) and `filters.workItemTag` narrows work items to one tag. As with `github`, the **auth is not configured here**: set `AZURE_DEVOPS_PAT` to a Personal Access Token, or — if that's unset — the provider falls back to an access token from the logged-in **`az` CLI** (`az login`). Selecting `azure` without `organization`/`project`/`repository` is a clear startup error; an auth/login problem surfaces at snapshot time (logged, last-good snapshot served) rather than blocking boot. `azure` maps Azure DevOps Repos **pull requests** onto `sourceControl` — reading branch, CI/build **PR statuses**, reviewer **votes** (approval), `mergeStatus` (conflict/clean/blocked) and comment **threads**, and posting PR comment replies + completing (merging) PRs — and Azure Boards **work items** onto `issues` (open work items with their tags→labels and any linked PR, via the WIQL + batch API). Work-item **tags** map onto issue labels, so the watch/ignore gate (`labelPrefix`) and `issuePriorityLabels` gate Azure exactly as they gate GitHub.
- **`labelPrefix`** — the prefix behind the cockpit's **watch / ignore** toggle, shared by PRs, issues and stories (default `"lubbdubb"`). It derives two labels — `${labelPrefix}-watch` ("work this") and `${labelPrefix}-ignore` ("leave this alone") — read by the dispatcher gates and written by the toggle. Precedence: an explicit `-ignore` always wins, then `-watch`, else the **type default**, which differs by kind: **PRs are opt-out** (worked unless tagged `-ignore` — the historical `lubbdubb-ignore` behaviour) and **issues/stories are opt-in** (left alone unless tagged `-watch`). Every open issue/PR/story stays fully visible in the cockpit and `/api/state` (with its health / pickup verdict, so you see _why_ it's untouched) — the gate only decides what's _acted on_, provider-agnostically (`fake`/`github`/`azure`). Toggle an item from the cockpit's per-row **watch / ignore** button (which writes the labels through the provider) or apply the labels directly in GitHub/Azure. Set `labelPrefix` to `""` to disable both gates entirely (PRs never excluded, all open issues/stories worked).
- **`issuePickupRequireOwnLabel`** — tighten the issue **watch** gate so `${labelPrefix}-watch` only counts when **you** applied it. Off by default (any tagger counts). Turn it on and the harness ignores the watch tag unless the account it authenticates as (the same identity used to decide whether a PR comment is "handled") is the one that added it — so another user can't tag a work item / issue to get an agent onto it. Only meaningful with a real provider (`github` or `azure`) that can resolve tag authorship: the provider reads authorship from the GitHub issue timeline (`labeled` events) or Azure work-item revisions, and only for items already carrying the tag, so the extra lookups stay cheap. The `fake` provider doesn't track authorship, so with this on nothing passes the gate.
- **`issuePriorityLabels` / `issueDefaultPriority`** — a label-encoded priority scheme so that, when agent headroom is limited, the important issues are picked up first. `issuePriorityLabels` maps a label to a weight (default `priority:high`→3, `priority:medium`→2, `priority:low`→1); an issue with no matching label gets `issueDefaultPriority` (default 2). The highest weight among an issue's labels wins; equal weights break by issue number (oldest first). Providing your own `issuePriorityLabels` **replaces** the default map wholesale rather than merging, so you can define an entirely different convention (e.g. `p0`/`p1`/`p2`). The `"rule"` dispatcher enforces this deterministically; the `"claude"` dispatcher receives it as prompt guidance.
- **`autoSend`** — confidence-gated autonomy for side-effectful actions. **Off by default**: with `enabled: false` the harness always drafts a PR reply and escalates it for sign-off (the v1 safety guarantee — nothing leaves without you). Turn it on and the harness sends a `reply_on_pr` itself _only_ when the dispatcher's `confidence` is `≥ confidenceThreshold` **and** the action type is in `allowedActions`; anything below the bar still drafts and escalates, and a failed send always falls back to an escalation so a reply is never dropped. Every send or escalation is written to the audit log with the reason. Auto-send goes through the outbound `ActionSink` seam (v1: the `FakeConnector` "sends" into its own fake world), so a real GitHub adapter drops in without touching the gate.
- **`repoRoot`** — the git repository the harness operates on; per-branch worktrees are cut from it. **Defaults to the directory you launch the app from (`process.cwd()`)**, so the common case needs no configuration. Set it (in the config file or via the `LUBBDUBB_REPO_ROOT` env override) to point the harness at a repo elsewhere; a relative path is resolved against the launch directory. (`worktreeRoot`/`deskRoot` — where worktrees and no-code scratch dirs live — default to `.lubbdubb/worktrees` and `.lubbdubb/desk`. A relative value resolves **against `repoRoot`**, not the launch directory, so pointing the harness at a repo elsewhere keeps that repo's worktrees with it instead of scattering them into the app folder; set an absolute path to put them anywhere.)
- Env overrides: `PORT`, `LUBBDUBB_DB`, `LUBBDUBB_REPO_ROOT`. Secrets: `GITHUB_TOKEN` (required by the `github` provider); `AZURE_DEVOPS_PAT` (used by the `azure` provider when set, otherwise it uses the logged-in `az` CLI).

### Resume across restarts (PTY runtime)

Agents are child processes of the server, so restarting it — a crash _or_ a graceful `SIGINT`/`SIGTERM` — used to kill every agent and lose the work in flight. In `agentMode: "pty"` the harness now **resumes** them instead.

- Each PTY agent is launched with a session id we choose up front (`claude --session-id <uuid>`), persisted on its `agents` row. The worktree and transcript already persist, so a restart is missing only the live process.
- On boot, _before_ the harness reacts to any new findings, reconciliation re-attaches each orphaned in-flight agent to the **same** Claude session in its original worktree (`claude --resume <id>`, protocol system prompt re-applied). Resumed agents count against `maxConcurrentAgents` before new work is dispatched. An agent that was mid-work is nudged to continue; one that was parked on a question keeps its escalation, and your answer routes straight into it.
- It's best-effort: an agent with no usable session id (e.g. it died before one existed) or a missing worktree falls back to the previous `interrupted` behaviour, and boot never blocks on a resume. A deliberate **kill from the cockpit stays dead** — only a restart-induced stop is resumable. The stream-JSON runtime does not resume (out of scope).

### Runtime control (cap + pause, no restart)

The concurrency cap and a pause flag are **live, in-memory controls** — change them
while the harness is running and they take effect on the next cycle, no restart. They
are **ephemeral**: a restart reverts to `maxConcurrentAgents` / `startPaused`.

- **Cap** — raise it and more agents spawn immediately (subject to available work);
  lower it and new dispatch is deferred until the live count drops below the new cap.
  Scaling down **never kills** a running agent.
- **Pause** — stops new dispatch only. Live agents keep running to completion, and the
  harness keeps cycling, so escalations, human answers, world snapshots and the audit
  log all continue. Unpausing resumes dispatch at the cap you had chosen. Every
  pause/cap deferral is written to the audit log with its reason.

Drive it from the cockpit topbar (the `−`/`+` cap stepper and the Pause/Resume toggle)
or the endpoint directly:

```bash
curl -XPOST localhost:4300/api/control -H 'content-type: application/json' -d '{"cap":5}'
curl -XPOST localhost:4300/api/control -H 'content-type: application/json' -d '{"paused":true}'
```

`POST /api/control` accepts `{ cap?, paused? }` (`cap` must be a non-negative integer),
broadcasts the change over the WebSocket so every open cockpit updates live, and the
current values appear in `/api/state` under a `control` block.

### Watch / ignore an item (the label toggle, no restart)

Every PR, issue and story carries a per-row **watch / ignore** button in the cockpit's
World panel, driven by one label pair derived from `labelPrefix` (default `lubbdubb`):
`${labelPrefix}-watch` and `${labelPrefix}-ignore`. Ignore always wins, then watch, else
the type default — **PRs opt-out** (worked unless `-ignore`), **issues/stories opt-in**
(left alone unless `-watch`). An ignored PR is filtered out of the dispatch view — no CI
fix, base update, review-comment note, or merge — and an un-watched issue/story is never
picked up; both stay fully visible in the cockpit and `/api/state` (with their health /
pickup verdict, so you still see why they're untouched). Toggling an item that already has
a live agent never kills it; it just stops _new_ signals from being acted on.

Because these are real labels on the item, they're **provider-driven and durable** (they
survive a restart) and work identically for the `fake`, `github` and `azure` providers.
Use the cockpit button — which writes the labels through the provider — apply the labels
directly in GitHub/Azure, or call the endpoints:

```bash
curl -XPOST localhost:4300/api/prs/42/exclude -H 'content-type: application/json' -d '{"excluded":true}'
curl -XPOST localhost:4300/api/issues/208/watch -H 'content-type: application/json' -d '{"watched":true}'
curl -XPOST localhost:4300/api/stories/st-9/watch -H 'content-type: application/json' -d '{"watched":false}'
```

`POST /api/prs/:number/exclude` (`{ excluded: boolean }`) toggles the `-ignore` tag on a
PR; `POST /api/issues/:number/watch` and `POST /api/stories/:id/watch`
(`{ watched: boolean }`) set the `-watch`/`-ignore` pair on an issue/story. Each writes
through the source-control/issues provider and triggers a cycle so the change takes effect
immediately. (For the real `github` provider the labels must exist in the repo; create
them once in the repo's Labels settings.)

### Try the demo without a real model

`scripts/mock-agent.sh` is a stand-in that speaks the same protocol as a real `claude` agent. The tracked `lubbdubb.config.example.json` uses `agentMode: "raw"` pointed at it, so copying it to `lubbdubb.config.json` makes `npm start` work with no model auth. For real agents, set `agentMode` to `"stream"` (recommended) and `claudeCommand` to `claude`.

How real agents speak the protocol: the harness appends a system prompt telling the agent to print `@@LUBBDUBB_WAITING:<reason>@@` when it needs a human and `@@LUBBDUBB_DONE@@` when finished. In `stream` mode each turn ends in a `result` event; the harness reads those sentinels to decide _waiting_ (→ escalate, then deliver your answer as the next message) vs _done_. This has been verified end-to-end against a live `claude`.

The sentinels are detected for status _and_ stripped from the displayed transcript, so they never leak into the cockpit. In `stream` mode the transcript is also normalised for legibility: assistant reasoning is shown as plain text, tool calls appear on their own labelled line with a concise input summary, and tool results are sanitised (ANSI/control noise removed) and truncated to keep the view scannable. The fleet-card one-line preview is ANSI-stripped so coloured labels never show as raw escapes.

In `pty` mode the raw byte stream is the interactive claude TUI — cursor-addressed redraws, an animated spinner, a status line — which no amount of escape-stripping can make readable. So each PTY agent's output is run through a headless terminal emulator (`@xterm/headless`) server-side, and the cockpit gets the _settled screen text_ instead: transcript content with the TUI chrome (spinner, input box, shortcut hints) filtered out. The drawer, the persisted transcript, and the fleet-card preview all read this settled text, so a PTY agent is as legible as a stream one.

### Hosted demo (GitHub Pages)

The cockpit is a static Vite SPA, so it can be published to GitHub Pages on its own — with the server, SQLite, and every integration replaced by an **in-browser fake backend**. There is no Node process, no network, and no real repositories behind it; the connections are simulated.

- **Build it:** `npm run web:build:demo` — sets `VITE_DEMO=1` (see `web/.env.demo`) and a Pages base path, then bundles to `web/dist`. `npm run web:dev:demo` runs the same mode with HMR at `localhost:5173`.
- **How it works:** `web/src/demo/` provides `demoApi` and `connectDemoWs`, drop-in replacements for the `/api/*` REST surface and the `/ws` socket. `web/src/api.ts` swaps them in when `VITE_DEMO=1`; the flag is dead-code-eliminated from the production build, so nothing demo-related ships in the real server bundle. `App.tsx` is unchanged — it can't tell the fake backend from the real one. The demo is fully interactive: inject events, pulse, answer escalations, pause/scale the fleet, and open an agent's live transcript.
- **Deploy:** `.github/workflows/pages.yml` builds the demo and publishes it on every push to `main`. Enable it once under **Settings → Pages → Source → GitHub Actions**; the site lands at `https://<user>.github.io/LubbDubb/`. If your repo name or owner differs, adjust the `--base` in the `web:build:demo` script to match (`/<repo>/`).

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

> **Enabling the GitHub security features.** CodeQL and dependency-review need
> **Code scanning** and the **Dependency graph** turned on under _Settings → Code
> security_ (on a private repo this may require GitHub Advanced Security). Until
> they're enabled those two jobs run but are marked `continue-on-error`, so they
> report without blocking. Once the features are on, drop `continue-on-error` from
> the two jobs to promote them to hard gates.

### The walking skeleton (Definition of Done)

`npm run smoke` proves the whole loop for real: inject _"CI failed on PR #42"_ → the dispatcher decides (with a logged reason) → a Claude-style agent spawns in a reused-or-new git worktree over a PTY → it hits a `waiting` state that **escalates** to the inbox → you answer → it continues → it finishes — and restart reconciliation is clean.

## Safety (v1)

Nothing side-effectful leaves the system autonomously. Both outbound PR actions —
`reply_on_pr` (posting a review reply) and `merge_pr` (landing a PR) — go through the
same confidence-gated auto-send seam, which is **off by default**: the harness
**drafts** the reply / **escalates** the merge for your approval and never posts,
pushes, or merges on your behalf without an explicit human action. Opt a specific
action into autonomy by enabling `autoSend` and adding it to `allowedActions` (e.g.
`["reply_on_pr", "merge_pr"]`).
