# LubbDubb

A self-hosted, always-running **orchestration harness** for one software engineer's work — a _cockpit_ that watches your inputs (PRs, CI, review comments, backlog), decides what to do on a heartbeat, and dispatches AI agents to do it autonomously, escalating to you only what genuinely needs judgment.

The name is the heartbeat: the server's core is a periodic pulse that drives everything.

> **v1 status — walking skeleton.** The harness _core_ is built and tested end-to-end, now with **confidence-gated auto-send** (opt-in) for side-effectful actions. Integrations are now **modular** — one interchangeable provider per capability (source control, issues, backlog), swappable via config — and two **real source-control/issues providers** are now built: **GitHub** (`"github"`, reading PRs/issues from the GitHub API, posting replies and merges) and **Azure DevOps** (`"azure"`, reading Repos pull requests + Boards work items, posting PR comments and completing PRs), each selectable per capability with an `integrations` entry plus its config block (`github` / `azureDevOps`) and a token. Metric-driven prioritization is designed _around_ and deliberately **not** built yet; every other capability still ships a `fake` provider. See [`docs/superpowers/specs/2026-07-21-lubbdubb-harness-design.md`](docs/superpowers/specs/2026-07-21-lubbdubb-harness-design.md).

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

You can **re-order it** with the ▲/▼ controls on each row to change what gets picked up
first — for the case where you can see the queue and know that item four is the one
blocking you. Because the queue is a projection, what persists is a priority override
keyed on the item's stable origin (not the array itself), read back into the ranking so
the order survives pulses and restarts. It changes _order_ only: a cooling-down, capped
or unapproved item stays held wherever you move it, and an operator-launched job (rule 0)
always keeps the next free slot. Work the harness surfaces later slots in behind your
arranged order until you re-arrange; an override for work that has since finished is
pruned after `upNextOverrideTtlMs` (default 7 days). Overriding a _hold_ into dispatch is
deliberately not a thing — a cooldown, cap or watch gate is not a priority question.

**Claude usage.** Each agent's cumulative cost, tokens and turns (from the stream
runtime's per-turn `result` events) are persisted and shown on its fleet card and
drawer, and a topbar chip tracks account-level usage: the real subscriber 5h/weekly
limits when available (captured from the status-line payload in `pty` mode — Pro/Max
only), otherwise self-computed rolling 5h/7d cost windows summed from the per-turn
reports. Absent data degrades gracefully — no chip until there is something to show.

## Architecture

> **Full specification:** [`docs/spec/`](docs/README.md) documents how every part of the application works, written as fact — the world model, the dispatch rules, the agent runtimes, the tool channel, the schema, the API, the cockpit. This section is the map; those documents are the detail.

A single Node/TypeScript process (HTTP + WebSocket) built as isolated modules that talk only through interfaces — any one (especially the `Connector`) can be swapped without touching the rest.

```
inject ─► Connector ◄── Heartbeat ──► Dispatcher ──► ActionExecutor ──► AgentManager ──► PtySession(s)
             │ (Fake)      (pulse)     (rule|claude)    │ guard/cap          │                │ node-pty
             └── Store (SQLite) ◄───────────────────────┴── EscalationInbox  └── WorktreeManager
                                                            CockpitAPI + WebSocket ──► Cockpit SPA (React)
```

| Module              | Responsibility                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Heartbeat`         | The pulse — a timer that fires a dispatch cycle; can also be triggered on demand.                                                                                                                                                                                                                                                                   |
| `Connector`         | The seam to the outside world. Behind it, the world is assembled from modular per-capability **integrations** (source control, issues, backlog), each with an interchangeable provider chosen in config; `CompositeConnector` merges their slices. v1 ships a `fake` provider per capability (an editable, persisted world you inject events into). |
| `Dispatcher`        | State in → validated action plan out. `RuleDispatcher` (deterministic default) or `ClaudeDispatcher` (drives a real Claude Code session over a PTY).                                                                                                                                                                                                |
| `ActionExecutor`    | Turns actions into effects; origin de-dup + concurrency cap; writes the audit log.                                                                                                                                                                                                                                                                  |
| `AgentManager`      | Owns the fleet of agent sessions: spawn, stream, detect waiting/done, feed input, kill — over any runtime.                                                                                                                                                                                                                                          |
| `StreamJsonSession` | The production agent runtime: real `claude` over headless stream-JSON. No TUI, unattended, supports the waiting/answer loop.                                                                                                                                                                                                                        |
| `PtySession`        | Terminal runtime (mock agent / interactive claude); all PTY waiting/done heuristics isolated behind one testable abstraction.                                                                                                                                                                                                                       |
| `WorktreeManager`   | Lazily creates/reuses git worktrees keyed by branch — code tasks only. A cleanly finished agent's worktree is removed once its process exits (failed/killed ones keep theirs for debugging).                                                                                                                                                        |
| `EscalationInbox`   | The human-in-the-loop surface; routes answers into live agents or the next cycle, and auto-dismisses an agent's open escalations when it dies (restart/kill/crash) so "Needs you" never lingers un-actionable.                                                                                                                                      |
| `ProposalDesk`      | Where your accept/reject on a proposed act is applied. An accepted merge/reply is performed through the same outbound seam — and the same effect path — auto-send uses when the confidence gate authorizes an act itself; a rejection sends nothing and stops the rule re-asking.                                                                   |
| `McpBridgeServer`   | The agents' typed channel _back_ to the harness: a tools-only MCP server over a Unix socket, wired into every launch. Lets an agent submit a validated plan or raise a structured question and hear the answer — where the sentinels can only announce, one way.                                                                                    |
| `Store`             | SQLite persistence + reconcile-on-restart.                                                                                                                                                                                                                                                                                                          |
| `ErrorLog`          | The central error-recording path: every caught failure (cycle exceptions, provider outages, agent crashes + exit codes, route 500s) is persisted, mirrored to stderr, and streamed to the cockpit's Errors panel.                                                                                                                                   |
| `Cockpit SPA`       | The single web page: fleet, inbox, world, live agent output, decision log, activity feed, error log, inject + kill. External references (issues, PRs, branches) render as clickable links, using URLs the provider supplies.                                                                                                                        |

## Getting started

```bash
npm install                                        # builds native deps (better-sqlite3, node-pty)
cp lubbdubb.config.example.json lubbdubb.config.json # your local config (gitignored); the example runs the mock agent, so no model or provider credentials are needed
npm run web:build                                  # build the cockpit SPA into web/dist
npm start                                          # start the server (binds 127.0.0.1:4300)
```

`npm start` prints the link to open:

```
[lubbdubb] open the cockpit: http://127.0.0.1:4300/#t=<token>
```

Open that once per browser and the cockpit remembers the token. The harness binds **loopback only**
and every API route needs that token, because the cockpit can queue a job — and a job spawns a real
agent with write access to your repo and your shell's environment. The token is minted on first start
into `.lubbdubb/cockpit-token` (0600, gitignored) and reused across restarts, so the link stays the
same. Set `LUBBDUBB_TOKEN` to choose your own, or see **`host` / `auth`** below to expose the cockpit
on your network deliberately. Nothing here talks to an identity provider or any other service: it is
32 random bytes and a header.

Then open the cockpit, use the **Inject event** bar to simulate the world moving (a CI failure, a review comment, a new story), and watch the harness react. The inject bar (and its `/api/inject` route) only exists while a `fake` provider is configured — synthetic events can't land on real integrations, so a real deployment hides it. Click an agent to see its live terminal and type into it — the drawer also shows the originating item (its title, a body excerpt or state summary, and the dispatcher's reason), captured at dispatch time so you can understand the work without leaving the cockpit. Use the **New job** panel to launch an ad-hoc job from a prompt — it queues server-side and the dispatcher drains it _ahead of_ all world-driven work (rule 0), so it takes the next free agent slot and simply waits in the queue (shown with its place in line, cancellable) when the fleet is at its concurrency cap. Answer items in **Needs you** to unblock parked agents. **Up next** shows the dispatcher's ordered pickup plan from the last pulse, with the cut-line at the current concurrency headroom — above it dispatches now, below it waits for a free slot; use the ▲/▼ controls on a row to re-prioritise what gets picked up first (the order persists as an origin-keyed override, held items stay held, and jobs stay first). The **Decision log** shows what the harness decided each cycle — click a row to expand the dispatcher rule that produced it (its number, name and standing rationale); the **Activity** feed beside it shows how the _world itself_ changed over time — each cycle diffs the fresh `WorldSnapshot` against the previous one and records every observed transition (PR opened, CI green, story moved), so it works for the real GitHub provider too, not just injected events.

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
  "integrations": { "sourceControl": "fake", "issues": "fake", "backlog": "fake" },
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
  "issueDefaultPriority": 2,
  "closedPrWindowMs": 21600000
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
- **`docsFolderPrefix`** — folder(s) the **file-events hook** treats as the artifacts area; a string or an array. Any file an agent writes _under_ a prefix (e.g. `"docs"` → everything in `docs/`) is promoted to an **artifact chip** in the cockpit regardless of extension, on top of the built-in report/doc heuristic (report extensions like `.md`/`.html`/`.pdf` and any `reports/` folder); a file promotes if it's under _any_ entry. A **relative** entry is worktree-relative; an **absolute** entry (e.g. `"D:/shared/reports"`) also matches files an agent writes under that real directory _outside_ its worktree, and — being operator-configured — widens the artifact-serving boundary so those chips open too (still `..`/symlink-confined to the configured root). Unset = heuristic only. Artifact detection itself needs no per-skill cooperation: a `PostToolUse` hook captures every write, so a report surfaces without the agent's prompt knowing the flag protocol; **every** written file is also listed in the agent drawer's "files changed" view.
- **`host` / `auth`** — who can reach the cockpit. `host` defaults to `"127.0.0.1"` (this machine only); `auth.enabled` defaults to `true`, requiring a bearer token on every `/api/*` route and on the `/ws` stream. The token comes from `LUBBDUBB_TOKEN` or is minted into `auth.tokenFile` (default `.lubbdubb/cockpit-token`, mode 0600) and printed as a `#t=` link at startup — it is deliberately **not** a config-file key, for the same reason `GITHUB_TOKEN` isn't: `lubbdubb.config.json` should stay safe to paste. Setting `host` to something reachable (e.g. `"0.0.0.0"`) works, but with `auth.enabled: false` it is **refused at startup** — that pair hands anyone on the network an endpoint that spawns agents with write access to your repo. Cross-origin requests and non-loopback `Host` headers are refused too, which is what stops a web page you happen to visit from driving your harness.
- **`whitelistedApprovals`** — waiting prompts the harness may auto-answer instead of escalating.
- **`steeringPriorities`** — optional hints injected into the LLM dispatcher's prompt.
- **`integrations`** — which provider fulfils each capability. The world behind the `Connector` is built from one integration per capability — `sourceControl` (pull requests, including their merge-readiness for PR monitoring), `issues` (GitHub-style issues the harness resolves into PRs), `backlog` (stories) — and each capability has interchangeable providers registered in `src/integrations/registry.ts`. This is the **swap switch**: change a value to point a capability at another provider without touching the harness, executor, or the other integrations. Three providers ship: the built-in `fake` (an editable, persisted world you inject events into) and two real ones for `sourceControl` and `issues` — **`github`** (see **`github`** below) and **`azure`** (Azure DevOps, see **`azureDevOps`** below). Unlisted capabilities keep the `fake` default; further real adapters are drop-ins — add them to the registry and select them here.
- **`github`** — the target for the real `github` provider (required when `integrations.sourceControl` or `integrations.issues` is `"github"`). `owner`/`repo` name the repository; optional `filters.prAuthor` narrows the PR slice to one author. Every open issue is ingested — what's _acted on_ is decided by the watch/ignore gate (`labelPrefix`), not an ingest filter. The **auth token is not configured here** — it comes from the `GITHUB_TOKEN` environment variable so a secret never lands in a committed config file. Selecting `github` without a `GITHUB_TOKEN` or without `owner`/`repo` is a clear startup error. `github` reads from the GitHub REST API each cycle (PRs with CI/checks status, review approvals, mergeability and unresolved review threads; issues with state and their linked PR) and, for auto-send, posts PR replies and merges through it; a transient GitHub error serves the last-good snapshot rather than dropping items from the world. It also builds the **canonical `github.com` URL** for any reference (a PR/issue number, an `issue/N` branch, a commit) so the cockpit can render external references as clickable links — URL construction lives here in the provider, never in the web layer.
- **`azureDevOps`** — the target for the real `azure` provider (required when `integrations.sourceControl` or `integrations.issues` is `"azure"`). `organization`/`project`/`repository` name the Azure DevOps Repo; optional `filters.prAuthor` narrows the PR slice to one author (by uniqueName/UPN) and `filters.workItemTag` narrows work items to one tag. As with `github`, the **auth is not configured here**: set `AZURE_DEVOPS_PAT` to a Personal Access Token, or — if that's unset — the provider falls back to an access token from the logged-in **`az` CLI** (`az login`). Selecting `azure` without `organization`/`project`/`repository` is a clear startup error; an auth/login problem surfaces at snapshot time (logged, last-good snapshot served) rather than blocking boot. `azure` maps Azure DevOps Repos **pull requests** onto `sourceControl` — reading branch, CI/build **PR statuses**, reviewer **votes** (approval), `mergeStatus` (conflict/clean/blocked) and comment **threads**, and posting PR comment replies + completing (merging) PRs — and Azure Boards **work items** onto `issues` (open work items with their tags→labels and any linked PR, via the WIQL + batch API). Work-item **tags** map onto issue labels, so the watch/ignore gate (`labelPrefix`) and `issuePriorityLabels` gate Azure exactly as they gate GitHub.
- **`labelPrefix`** — the prefix behind the cockpit's **watch / ignore** toggle, shared by PRs, issues and stories (default `"lubbdubb"`). It derives two labels — `${labelPrefix}-watch` ("work this") and `${labelPrefix}-ignore` ("leave this alone") — read by the dispatcher gates and written by the toggle. Precedence: an explicit `-ignore` always wins, then `-watch`, else the **type default**, which differs by kind: **PRs are opt-out** (worked unless tagged `-ignore` — the historical `lubbdubb-ignore` behaviour) and **issues/stories are opt-in** (left alone unless tagged `-watch`). Every open issue/PR/story stays fully visible in the cockpit and `/api/state` (with its health / pickup verdict, so you see _why_ it's untouched) — the gate only decides what's _acted on_, provider-agnostically (`fake`/`github`/`azure`). Toggle an item from the cockpit's per-row **watch / ignore** button (which writes the labels through the provider) or apply the labels directly in GitHub/Azure. Set `labelPrefix` to `""` to disable both gates entirely (PRs never excluded, all open issues/stories worked).
- **`issuePickupRequireOwnLabel`** — tighten the issue **watch** gate so `${labelPrefix}-watch` only counts when **you** applied it. Off by default (any tagger counts). Turn it on and the harness ignores the watch tag unless the account it authenticates as (the same identity used to decide whether a PR comment is "handled") is the one that added it — so another user can't tag a work item / issue to get an agent onto it. Only meaningful with a real provider (`github` or `azure`) that can resolve tag authorship: the provider reads authorship from the GitHub issue timeline (`labeled` events) or Azure work-item revisions, and only for items already carrying the tag, so the extra lookups stay cheap. The `fake` provider doesn't track authorship, so with this on nothing passes the gate.
- **`closedPrWindowMs`** — how far back the source-control provider looks for pull requests that have **left the open set**, so a merge or an abandonment is _observed_ rather than inferred from the PR disappearing (default `21600000`, six hours; `0` disables the lookup). Both real providers list only open PRs, so without this a PR you were watching simply vanishes mid-session. Turn it on and three things follow: the cockpit's World panel keeps a **Recently closed** list marked _merged_ vs _closed unmerged_; the activity feed gets real `pr_merged` / `pr_closed` events (the merge transition was previously unobservable outside the `fake` provider); and **plan reconciliation stops guessing** — a plan part whose PR was closed without merging goes back to `ready` and is re-done, instead of quietly completing the plan. Recently-closed PRs are carried in the world snapshot **separately** from the open ones, so no dispatcher rule ever sees a dead PR. Cost is one extra list request per snapshot per provider, bounded by the window, with **no per-PR fan-out** — a closed PR is read in summary form only (no CI, reviews or comments), because nothing acts on it. Outside the window nothing changes: a PR that closed longer ago is still absent, and absence still reads as merged.
- **`issuePriorityLabels` / `issueDefaultPriority`** — a label-encoded priority scheme so that, when agent headroom is limited, the important issues are picked up first. `issuePriorityLabels` maps a label to a weight (default `priority:high`→3, `priority:medium`→2, `priority:low`→1); an issue with no matching label gets `issueDefaultPriority` (default 2). The highest weight among an issue's labels wins; equal weights break by issue number (oldest first). Providing your own `issuePriorityLabels` **replaces** the default map wholesale rather than merging, so you can define an entirely different convention (e.g. `p0`/`p1`/`p2`). The `"rule"` dispatcher enforces this deterministically; the `"claude"` dispatcher receives it as prompt guidance.
- **`planning`** — the **planning funnel** for multi-PR issues. **Off by default** (`planning.enabled: false`), and off leaves it out entirely: no planner is ever dispatched, no plan is reconciled, and issue pickup behaves exactly as it does without plans. Turn it on and every watched, open issue gets a **planning agent first** (rule 3c, on its own branch `plan/issue/<n>`): it reads the repository and writes a verdict to `.lubbdubb/plan.json` in its worktree — `"single"` (one PR will do, so the issue falls through to ordinary pickup unchanged) or `"parts"` (a decomposition into stacked PRs, each with a `slug`, `scope` and at most one `dependsOn`). The verdict is **persisted for both outcomes**, so a planner never re-runs on the same issue, and a planner that crashes or writes no plan **fails open** — once the usual attempt cap is spent the issue routes to `single`, so a planner failure can never park an issue.

  A `parts` verdict is then scheduled by rule 4a: each part gets a code agent on `issue/<n>/<slug>`, against its own origin `issue:<n>:part:<slug>` (so cooldown, the attempt cap and escalation are per part), with a prompt carrying what the sibling parts have done and what is still to come. A part **stacks**: while its dependency's PR is open its branch is cut from that dependency's branch and its PR targets it; once the dependency merges the base is `defaultBranch` again. Two knobs and two consequences worth predicting before you enable it: **planners outrank parts outrank pickups** for scarce headroom, and `planning.maxConcurrentPartsPerIssue` (default 2) caps how many parts of one plan may have agents at once — so **one issue can occupy several of your `maxConcurrentAgents` slots**. Progress is mirrored back to the tracker as a **single status comment per plan**, edited in place (not auto-send gated — it is bookkeeping, and the one-comment rule is what keeps it from being noise), and completion goes **no further than review**: the comment is updated, an Azure work item moves to `issueInReviewState`, and nothing ever closes the issue. `planning.gitFetchIntervalMs` (default 60000) floors how often plan reconciliation runs `git fetch` before reading branch reality — the git observer is fetch-free, so without a fetch it never sees a push from another machine. The graph lives only in LubbDubb's store (`.lubbdubb/` is gitignored, so `plan.json` is a side channel, not a committed artefact) — but it is **visible**: the cockpit draws a plan panel per issue, each part with its status, branch, PR, what it stacks on, and where it sits in the dispatcher's own "Up next" projection (including `capped`, meaning the plan's own concurrency limit is holding it rather than the fleet being full). Only the `"rule"` dispatcher implements the funnel. The prompts are operator-overridable as the `issue-plan`, `issue-replan`, `plan-part` and `plan-part-escalation` templates.

  **Approve before, instead of replanning after.** `planning.requireApproval` (**off by default**, and off means a `parts` verdict commits the moment the planner writes it, exactly as above) makes a decomposition a **proposal** rather than work. The verdict still lands — the plan and every part are persisted, so the planner never re-runs — but the plan is `awaiting_approval`, rule 4a starts nothing, and the decomposition appears in **Needs you** as an accept/reject item carrying every part and what it stacks on. Accepting releases the plan and the parts schedule from the next pulse, audited as `authorized by you` like any other approval. Rejecting **leaves the issue a route** rather than parking it: the parts nothing has started for are retired and the issue falls back to the single-PR path (if some parts are already in flight — you are refusing a _replan_ — those keep running and the amendment's new parts are dropped). If what you want is a different split, press Replan; that asks the planner again and comes back here. Nothing else changes: the parts are still visible in the plan panel and the "Up next" queue, each marked `unapproved` so the hold is explicit rather than looking like an idle fleet, and the plan's tracker status comment is not written until you approve — an unapproved decomposition announces nothing.

  **Stacked CI.** Part 2's CI runs part 1's commits, so part 1 going red turns part 2 red. The CI rule is therefore suppressed on any PR whose base PR is itself failing — otherwise an agent is dispatched onto every PR in the stack to fix code that is not theirs. The failure is not pushed anywhere: the red PR at the bottom is in the same world and rule 1 fires on it on its own merits, and the children go green when its fix lands. Only the CI rule is held; the base-update rule still fires, so a stack keeps restacking as its parent pushes. The base PR is identified from the world (`pr.baseBranch` matching another open PR's branch), not from the plan graph, so it works for a stack a human made by hand too.

  **Replan.** The cockpit's per-plan **replan** button sends a plan back through the funnel: the plan row returns to `planning`, and the next cycle dispatches a planner primed with the current plan and part states (the `issue-replan` prompt). With `requireApproval` on it also **withdraws** an approval still being asked for — an amended plan is a new proposal, and the superseded card must not be able to release a decomposition its reader never saw. It is also the way out of a `complete` plan, which otherwise parks its issue for good while a human decides whether to close it. **Nothing is torn down when you press it** — agents keep running and open PRs stay open. What an amended plan does to the parts is decided when it lands: parts merge on `slug`, so a re-declared part keeps its branch and PR; a part the amended plan no longer declares is **retired** (a status, not a disappearance — it stays in the graph and out of the counts) but **only if nothing was started for it**. A part with an agent, a branch or an open PR is kept whatever the amendment says, and a `single` verdict is only honoured while no part has reached the outside world.

- **`autoSend`** — confidence-gated autonomy for side-effectful actions. **Off by default**: with `enabled: false` the harness always drafts a PR reply and escalates it for sign-off (the v1 safety guarantee — nothing leaves without you). Turn it on and the harness sends a `reply_on_pr` itself _only_ when the dispatcher's `confidence` is `≥ confidenceThreshold` **and** the action type is in `allowedActions`; anything below the bar still drafts and escalates, and a failed send always falls back to an escalation so a reply is never dropped. Every send or escalation is written to the audit log with the reason — and with the **authority**: a cleared gate settles a proposal as `decidedBy: "auto_send"`, the same record and the same effect path an approval of yours takes, so the two are one authorization representation rather than two (see Safety). Auto-send goes through the outbound `ActionSink` seam (v1: the `FakeConnector` "sends" into its own fake world), so a real GitHub adapter drops in without touching the gate.
- **`repoRoot`** — the git repository the harness operates on; per-branch worktrees are cut from it. **Defaults to the directory you launch the app from (`process.cwd()`)**, so the common case needs no configuration. Set it (in the config file or via the `LUBBDUBB_REPO_ROOT` env override) to point the harness at a repo elsewhere; a relative path is resolved against the launch directory. (`worktreeRoot`/`deskRoot` — where worktrees and no-code scratch dirs live — default to `.lubbdubb/worktrees` and `.lubbdubb/desk`. A relative value resolves **against `repoRoot`**, not the launch directory, so pointing the harness at a repo elsewhere keeps that repo's worktrees with it instead of scattering them into the app folder; set an absolute path to put them anywhere.)
- **`defaultBranch`** — the repository's integration branch (default `"main"`). Two things read it: a **new** agent branch is cut from it (`origin/<defaultBranch>` if that ref exists, else the local one), and it's the base named in a PR's base-update prompt when the provider doesn't report one. It replaces what used to be a hardcoded `'main'` fallback in both places, which meant a new branch actually forked from **whatever `repoRoot` happened to be checked out on** — set this if your repo's integration branch isn't `main`, and note that on a checkout parked on a feature branch the branch point changes on first deploy. It is deliberately configured rather than detected from the clone: the harness may run against a checkout whose HEAD is anywhere, and a wrong guess silently mis-bases work. Existing branches are never re-based — a worktree or branch that already exists is reused as-is, so an in-flight agent keeps its base. It also gates merging: rule 3 never merges a PR whose base is something _other_ than `defaultBranch`, because that PR is stacked on another in-flight branch and merging it would land the change into a sibling branch mid-review. Set it correctly or nothing merges.
- Env overrides: `PORT`, `LUBBDUBB_DB`, `LUBBDUBB_REPO_ROOT`. Secrets: `GITHUB_TOKEN` (required by the `github` provider); `AZURE_DEVOPS_PAT` (used by the `azure` provider when set, otherwise it uses the logged-in `az` CLI).
- **Agent auth and who pays.** The harness never supplies model credentials — it spawns `claude` with the environment it inherits, so the agent authenticates exactly as your own `claude` does. On a Pro/Max plan the headless `stream` runtime bills against your **subscription**: Anthropic announced moving `claude -p`/Agent-SDK usage onto a separate credit pool at API rates, then [paused that change](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) on 2026-06-15 ("for now, nothing has changed"). Treat it as a paused rollout, not a settled design. **The sharp edge is `ANTHROPIC_API_KEY`**: it [outranks subscription OAuth](https://code.claude.com/docs/en/authentication#authentication-precedence), and while interactive `claude` prompts you once to approve the key, in non-interactive mode (`-p`) "the key is always used when present" — no prompt. A key left exported therefore bills the API silently for **every** agent the fleet spawns, at fleet multiples. Check with `claude /status` (a `Login method` row shows the subscription; an `API key` row appears when a key is in use) or `env | grep ANTHROPIC_`, and `unset ANTHROPIC_API_KEY` to fall back to the subscription. For unattended hosts with no browser login, `claude setup-token` mints a year-long `CLAUDE_CODE_OAUTH_TOKEN` that authenticates against the subscription — but it still ranks _below_ `ANTHROPIC_API_KEY`, so unsetting the key is what actually decides the bill.
- **`LUBBDUBB_DEBUG`** — set it (to anything) to turn on opt-in `[lubbdubb:debug:…]` stderr tracing. Most useful for the **file-events artifact pipeline** when a report an agent wrote never shows up as a chip: it logs the per-agent spool dir at spawn, each captured write and how it classified (`promoted`/`kind`), and — crucially — dumps the hook's own breadcrumbs at teardown. Empty breadcrumbs mean the `PostToolUse` hook never even ran (the fault is `--settings` not taking effect: matcher, `node` on `PATH`, or a shell mangling the command), so you can tell "hook didn't fire" apart from "fired but wasn't surfaced" without guessing.

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
# The cockpit token — minted at first start, printed in the `#t=` link.
TOKEN=$(cat .lubbdubb/cockpit-token)

curl -XPOST localhost:4300/api/control -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"cap":5}'
curl -XPOST localhost:4300/api/control -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"paused":true}'
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
TOKEN=$(cat .lubbdubb/cockpit-token)

curl -XPOST localhost:4300/api/prs/42/exclude -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"excluded":true}'
curl -XPOST localhost:4300/api/issues/208/watch -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"watched":true}'
curl -XPOST localhost:4300/api/stories/st-9/watch -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"watched":false}'
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

Agents also get a **typed channel back**. Every launch is wired to a small MCP server inside the harness (`mcp.enabled`, on by default), which today exposes two tools: `plan_submit` — a planning agent's verdict, validated on the spot so a rejected plan comes back with the reason instead of silently costing an attempt — and `escalate` — a question with a `kind` and concrete `options`, which the cockpit renders as one-click answers. Identity rides on a per-agent credential rather than a tool argument, so an agent can only ever write its own work. The channel is strictly additive: the sentinels stay, and are what everything falls back to if the tools are off, unavailable, or simply unused. `@@LUBBDUBB_DONE@@` in particular has no tool equivalent — a tool call an agent forgets to make is indistinguishable from an agent still thinking, whereas the end of a turn is observable.

The sentinels are detected for status _and_ stripped from the displayed transcript, so they never leak into the cockpit. In `stream` mode the transcript is also normalised for legibility: assistant reasoning is shown as plain text, tool calls appear on their own labelled line with a concise input summary, and tool results are sanitised (ANSI/control noise removed) and truncated to keep the view scannable. The fleet-card one-line preview is ANSI-stripped so coloured labels never show as raw escapes.

In `pty` mode the raw byte stream is the interactive claude TUI — cursor-addressed redraws, an animated spinner, a slash-command dropdown — which no amount of escape-stripping can make readable. So the cockpit doesn't read the screen at all: Claude Code writes every session's conversation to `~/.claude/projects/<project>/<session-id>.jsonl`, and because `pty` mode pins the session id (for resume), the harness tails that file and renders it with the same formatter stream mode uses. The drawer, the persisted transcript, and the fleet-card preview all read that, so a PTY agent is as legible as a stream one — and the TUI is reduced to an input device.

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
npm run knip           # unused files / exports / types / dependencies / class members (all fatal)
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

What the gate produces is a **proposal**: the inbox item offers _approve_ / _reject_
rather than a text box, and approving is what performs the act — the harness merges the
PR, or sends the draft, through that same seam. Approving twice performs it once; a
send that fails re-escalates rather than dropping; and while a proposal is unanswered —
or after you reject it — the rule that raised it stops proposing the same act, so one
question is asked once.

**A "no" stands until the world gives a reason to ask again.** Not for a fixed number of
minutes: re-asking on a timer would make "no" mean "not this second", and the only way to
make the question stop would be to do the act by hand. So a rejection holds its act for as
many heartbeats as you like, and ends at the first thing that actually happens to the item
it was about — a push, a CI result, an approval, a comment. Reject a merge because the PR
needs one more commit and the harness stays quiet; when the commit lands and CI goes green
it asks once more, saying what you told it and what has changed since. A pull request
nobody touches is never re-proposed, which is the right answer: nothing about it has
changed. And the reason you typed is not filed away — it is handed to the next agent the
harness puts on that exact item, quoted as your words, so "too defensive, just fix the
lint" reaches the agent instead of the draft you refused.

A proposal is also what the gate produces when it **passes**. Auto-send is a decider on
that same record rather than a second authorization system beside it: enabled and
confident, the harness accepts _its own_ proposal (`decidedBy: "auto_send"`) and performs
it down the identical path your click takes. So the audit log answers "who authorized
this outbound act" the same way for both — `authorized by you` or `authorized by
auto-send (confidence 0.90 ≥ 0.85 threshold)` — and an auto-sent act is as queryable
after the fact as an approved one. This changes nothing about _what_ auto-send may do: it
is still off by default, still allow-listed per action, and a refused gate still asks you.

The same record covers one act that goes nowhere near the outside world:
`planning.requireApproval` (off by default) makes an issue's **decomposition** a proposal
too. Accepting it publishes nothing — it releases the rule that puts agents on the parts —
so the guarantee above is unchanged in either direction, and what you gain is the gate we
had previously only built the undo for. Refusing it is the one rejection with a
consequence of its own: a plan is the only thing that schedules work for a decomposed
issue, so a bare "no" would park that issue for good. Instead the unstarted parts are
retired and the issue falls back to being worked as a single pull request.
