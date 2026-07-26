# LubbDubb vs. aiball — what they do differently, and what we should take

**Subject:** [quazardous/aiball](https://github.com/quazardous/aiball) — "pilot your Claude Code
agents like a GitHub board." MIT, experimental, Node/TypeScript, ~36 stars as of July 2026.
Read from the README, `MCP-CLIENT.md` and `docs/{CLAUDE-LOOP,TICKET_LIFECYCLE,WORKFLOW,HOOKS,SECURITY,SANDBOX,PROMPT-GLOSSARY}.md`.

**Why it's worth reading:** it is the closest thing to a peer project — same substrate (Claude
Code sessions, tmux/PTY, SQLite, a local web board, hooks), same ambition (an operator pilots a
fleet instead of babysitting one chat). It arrives at **almost the opposite architecture on every
axis**, which makes it a useful mirror rather than a competitor.

---

## 1. The one-paragraph difference

**LubbDubb is world-driven and push-based.** A server-side heartbeat snapshots the _outside_ world
(GitHub/Azure PRs, CI, review threads, mergeability, issues, work-item state), diffs it, runs a
deterministic rule book, and **pushes** ephemeral agents at whatever it found — one agent per task,
in its own worktree, dead when it prints `@@LUBBDUBB_DONE@@`.

**aiball is board-driven and pull-based.** Work is a **ticket in aiball's own SQLite**, filed by a
human or by another agent. Each project has **one long-lived `claude` session** living in tmux;
Claude Code `Stop`/`SessionStart` hooks make _the agent_ ask "is there work?" at every turn end, and
a wake is injected into its PTY. The agent never dies, so it keeps its context; the board is a
threaded conversation with the same agent over time.

Everything below follows from that.

| Axis                      | LubbDubb                                                        | aiball                                                                |
| ------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Source of work            | The real world (PRs, CI, issues, work items)                    | Its own ticket board                                                  |
| Source-control awareness  | Deep — CI, review threads, mergeable state, merge, labels        | **None.** The board doesn't know what a PR is                         |
| Agent lifetime            | Ephemeral, one per task, worktree-isolated                       | Persistent, one per project, shared context                           |
| Loop driver               | Server heartbeat → dispatcher → executor (push)                  | Agent-side Stop/SessionStart hook → `checkHasWork()` → wake (pull)     |
| Concurrency               | Fleet of N, cap + headroom cut + per-branch exclusion            | One agent per project; parallel mode (`sandbox`) built then **paused** |
| Scope                     | One repo per process                                             | N projects on one board, one sidebar, cross-project queue             |
| Agent → system channel    | Sentinels on stdout + a `PostToolUse` file-events hook           | **An MCP server: 13 typed tools**                                     |
| Human → agent channel     | Escalation inbox; typing into the drawer                         | Threaded comments with accept/reject **decisions**; _or grab the tmux keyboard_ |
| Deployment                | `npm start` from the repo, no auth, binds `0.0.0.0`              | `install.sh`, systemd, bins on `PATH`, login+password, per-consumer bearer tokens, Tailscale, Windows |
| Migrations                | Hand-rolled `Store.migrate()` guarded by `PRAGMA table_info`     | Drizzle, 27+ numbered migrations                                      |

---

## 2. What aiball does well — ranked by what it's worth to us

### 2.1 An MCP server is the agent's channel back (biggest single idea)

Our agents talk to the harness through a **one-way, lossy side channel**: three sentinels on stdout
(`DONE` / `WAITING:<reason>` / `FLAG:<payload>`) plus a `PostToolUse` hook that captures written
file paths. That's genuinely elegant for what it does — it's skill-agnostic and needs no cooperation
from the prompt — but the vocabulary is fixed at three words, and it only goes one way.

aiball registers an **MCP server per project** (`.mcp.json`, written by `claude-loop init`) exposing
~13 typed tools: `ticket_new`, `ticket_reply`, `ticket_claim`, `ticket_close`, `ticket_decide`,
`search`, `unread`, `poll`… Every response carries a `_status` block (`unread_project`,
`unread_pings`, `my_pending`) so the agent's situational awareness refreshes on _every_ call
without a separate poll. Their agent can therefore **file a new ticket** ("found an unrelated bug"),
**claim** work to prevent collisions, **propose a plan and wait for approval**, and escalate
structurally — none of which our vocabulary can express.

The tell that we need this is already in our tree: `.lubbdubb/plan.json`. The planner agent returns
its verdict by **writing a file to a reserved path**, which the file-events hook notices and zod
validates (`AgentManager.ingestFileEvent` → `src/plans/planDocument.ts`). That is an RPC over the
filesystem, with a hook as the transport, because there is no RPC. An MCP tool `plan_submit(...)`
is the honest version of the same call — validated at the boundary, with an error the agent can
_read and retry_, instead of a silent zod rejection it never learns about.

**What it unlocks for us, concretely:**

- `plan_submit` — replaces the `plan.json` side channel; the agent gets validation errors back.
- `escalate(question, options[])` — a _structured_ escalation instead of free text scraped out of a
  sentinel, so the cockpit can render real choices and route a typed answer back.
- `report_finding(kind, ref, summary)` — the thing an agent currently has no way to say: "the fix
  needs a change in a package I'm not allowed to touch", "this issue is a duplicate of #41".
- `world_read(pr | issue)` — today an agent re-derives PR state by shelling out to `gh`; we already
  hold a fresh, provider-agnostic snapshot in the `Store`.

Cost is real but bounded: an MCP server over stdio/UDS, a `--mcp-config` fragment merged into the
same `--settings` machinery `fileEvents.ts` already builds, and per-agent identity so a tool call is
attributable to the task that made it. **This is the highest-leverage item on the list.**

### 2.2 Decisions as a first-class object (propose → accept/reject)

aiball hangs a **decision sidecar** on a comment: `meta.decision = { kind: "plan" | "resolution",
status: "pending" | "accepted" | "rejected" }`. The agent proposes; the human accepts or rejects
_in place on the thread_; an accepted `plan` is a go-signal that re-enters the actionable pool, an
accepted `resolution` closes the ticket. One primitive, and the thread is the audit trail.

We have that shape latent in **three unrelated mechanisms**:

- **`autoSend`** — a confidence threshold gating `reply_on_pr` / `merge_pr`, else escalate.
- **The escalation inbox** — free-text question in, free-text answer out.
- **The planning funnel** — a planner writes a `parts` verdict and rule 4a **immediately starts
  building stacked PRs off it**. No human ever approves the decomposition.

That last one is the gap worth closing first. A `parts` verdict commits several agents, several
branches and a PR stack, on the strength of one planner's unreviewed judgement — and our own
`replan` button exists precisely because that judgement is sometimes wrong. Making the plan a
**proposal that the cockpit accepts or rejects** (opt-in, e.g. `planning.requireApproval`) is a
small change to `resolvePlanRoute` + one cockpit control, and it turns replan-after-the-fact into
approve-before-the-fact.

Generalising further — one `Decision` record with `kind`, `status` and a payload, which escalations,
auto-send sign-off and plan approval all instantiate — would collapse three code paths into one and
give the Decision log a genuine human column.

### 2.3 "Whose court is it?" as a single derived predicate

aiball's `TICKET_LIFECYCLE.md` §4.1 is the sharpest piece of design in the project. Everything
reduces to one stored signal, `last_actor`: **a ticket is actionable for consumer C iff
`last_actor ≠ C`, or C is the sole participant.** Three cases fall out of one rule — someone else
moved (your turn), your solo task (still yours), you moved last toward someone else (gated). Layered
on top are orthogonal gates (blocked, dependency, hold/claim, snoozed) and a **tier ladder** for
ordering: unread → actionable → other open → rest, tie-broken by priority, own claim, assignment,
"hot", then age.

Compare our answer to the same question, which is spread across at least six places:
`dispatchCooldown`, the attempt cap, notify de-dup via `recentDecisions`, the `waiting` latch, the
"hold a note while the agent is parked" rule, and the gate stack in `issuePickupStatus`. Each is
individually justified; collectively they are a hand-rolled `last_actor`.

I am **not** recommending we adopt their model wholesale — ours is genuinely harder, because our
counterparty is an external world we don't control and a CI system that acts without being an
"actor". But `issuePickupStatus` already proves the value of folding gates into **one pure verdict
with reasons**, and the same treatment for "does this PR need an agent right now" — a single
`prAttentionStatus(pr, ctx)` folding health, in-flight agent, cooldown, stacked-CI suppression and
notify de-dup — would make the PR side as explainable as the issue side, and give the cockpit the
same per-row "why nothing is happening" chip PRs currently lack.

Their **hot-zone** idea is a cheap, immediate steal for `upcoming`: a candidate touched by agent
activity in the last N seconds sorts above cold ones _within_ its tier. Focus is worth something;
our ranking is currently blind to it.

### 2.4 The presence model — the human can take the wheel, and the system notices

This is aiball's signature feature and it has no analogue in LubbDubb. Their looped session is
_your ordinary terminal with a coach attached_. Three nested gates keep the loop from typing over
you:

1. **An explicit AFK state machine** — F9 cycles autonomous → held 10 min → held indefinitely, with
   the state shown in the tmux status bar (`loop` / `wait` / `stop`).
2. **Live keystroke detection** — a PTY proxy between tmux and claude tells _your_ keystrokes from
   claude's output (5s TTL on `humanTypingAtMs`), auto-arming the 10-minute hold when you type; a
   `wakeInFlightAtMs` stamp marks loop-sourced input so it isn't mistaken for a human.
3. **Busy-defer** — no wake while the agent is mid-turn.

We have exactly one presence control: the global **pause**. But we _do_ inject into live agents
(`respond_to_agent`), and the drawer lets an operator type into one. Nothing stops a
dispatcher-authored note landing in the middle of a sentence an operator is typing. We already
solved the harder half of this — the "hold the note while the agent is `waiting`" rule — so the
missing piece is small: **a per-agent "human has the wheel" latch**, armed by typing into the
drawer, auto-releasing after a few minutes, that defers `respond_to_agent` the same way `waiting`
does and shows on the fleet card. Cheap, and it removes a real race.

### 2.5 The operator story: install, auth, remote, migrations

aiball is _packaged_; we are a `git clone` and an `npm start`. They ship `install.sh` (+ `.ps1`),
systemd units, three bins on `PATH`, a **one-shot tokenized setup URL** that expires in 24h,
login/password auth, per-consumer bearer tokens, a documented three-boundary trust model
(`docs/SECURITY.md`), `aiball check` for wiring diagnostics, Tailscale exposure as a first-class
path (`aiball init tailscale`), HTTP+token slaving of remote hosts, an experimental Windows path,
and 27+ numbered Drizzle migrations with a `MIGRATIONS.md`.

Two of these are not "nice to have":

- **We have no authentication at all, and `src/server/main.ts:28` binds `0.0.0.0`.** Anyone who can
  reach the port can `POST /api/jobs` — which queues an arbitrary prompt that becomes a Claude Code
  agent with our configured permission mode, in a worktree of the operator's repo — or `POST
  /api/control`, or answer escalations. On a laptop behind a firewall that's academic; the moment
  anyone runs this on a dev box, a VM, or forwards a port to use it from a phone, it is remote code
  execution as the operator. At minimum: bind `127.0.0.1` by default and make the bind address
  configurable. Beyond that, a shared bearer token on `/api/*` + `/ws` is an afternoon's work, and
  their Tailscale write-up is a good model for the "use it from my phone" case that motivates
  exposing it at all.
- **Migrations.** `Store.migrate()` with `PRAGMA table_info` guards is fine at our size and is
  honestly documented in `CLAUDE.md`, but it has no version, no ordering, no down-path and no record
  of what ran. Their numbered-migration discipline (including a **one-time backfill** as migration
  0027 when they changed the actionable rule) is where we end up the first time a shipped schema
  needs a data transform rather than an additive column.

### 2.6 A prompt glossary — "verb = tool"

`docs/PROMPT-GLOSSARY.md` fixes one canonical verb per MCP tool (`claim` → `ticket_claim`, `reply`
→ `ticket_reply`, …) and requires wake phrases, tool descriptions and skill templates to use it,
so the agent-facing surface can't drift into synonyms. It also **reserves six human-only
catchphrases** ("Engage", "Make it so", …) that never appear in an agent-authored prompt — a neat
trick for keeping a human go-signal unforgeable — and bans fuzzy words ("work on", "drain", "pick
up") from agent-facing text.

We have four operator-overridable prompt templates and growing (`issue-plan`, `issue-replan`,
`plan-part`, `plan-part-escalation`, plus the per-rule prompts). A one-page glossary in
`docs/prompt-templates/` costs nothing and prevents exactly the drift we're set up for.

### 2.7 Backlog nudges instead of silence

When aiball has open tickets but nothing _actionable_, it doesn't go quiet: a configurable strategy
(`silent` / `once` / `stale` / `backoff` / `persistent`) nudges, deduped by a **landscape hash**
(SHA1 of sorted ticket ids + timestamps) so an unchanged world doesn't re-nag. Backing it, a tier
ladder classifies _why_ each item is stuck (0 hot focus, 1 ball in court, 2 follow-up, 3 waiting,
4 blocked), and a fired nudge cools that item down for a bounded window.

Our equivalent state is `no_op` — recorded, auditable, and completely silent. When every issue is
gated (unwatched, cooldown, spent attempts) the cockpit is honest about it per row, but nothing ever
says "you have 9 items and all of them are waiting on _you_". Their landscape hash is exactly the
right dedup primitive if we add it.

---

## 3. What we do better — and shouldn't trade away

- **We are connected to reality.** aiball's board is a closed universe: tickets it created. It has
  no CI awareness, no PR health, no review threads, no mergeability, no merge. LubbDubb reads all of
  that from GitHub _or_ Azure DevOps behind one seam and writes back (replies, merges, labels,
  work-item state, plan status comments). This is the whole product and they don't have it.
- **Headless-first was the right call.** aiball's architecture is load-bearing on tmux + a PTY proxy
  that sniffs the input stream, pane-diff polling every ~1.5s, and reading `esc to interrupt` out of
  the TUI footer to detect "busy". Their own `HOOKS.md` lists candidate hooks "that would replace
  existing pane-scraping detectors" — they know. Our default runtime is stream-JSON with no terminal
  at all, and PTY is the _option_; the screen-scraping we do keep is confined behind
  `sentinelScanner.ts` with a documented backstop that _announces_ when it disagrees with the
  session file. We chose the smaller fragile surface.
- **Parallelism with isolation.** They built parallel autonomous agents (`aiball sandbox`) and
  **paused it**: "one looped agent per project proved the better grain." Worth taking seriously as
  evidence — but they had no worktree isolation and no one-agent-per-branch rule, so their parallel
  agents shared a checkout. Ours don't. The failure mode they hit isn't the one we'd hit.
- **Explainable decisions.** `DISPATCH_RULES` is a rule book _as data_, every action carries a rule
  id, the store lifts it into the `decisions` table, and the cockpit expands a row into the rule
  that fired. aiball's ordering is a tier ladder in code; you can see the result, not the reason.
- **The planning funnel and stacked PRs.** Multi-PR decomposition, dependency-aware stacking, CI
  attribution down the base chain, replan-with-amendment. They have nothing in this area (the
  paused sandbox "plate" is the nearest thing).
- **Test seam.** `buildSystem(config, { backend, streamSpawner, dbPath: ':memory:' })` lets us drive
  inject → dispatch → agent → escalate → answer → done with no model and no native processes. Their
  `fake-claude` scenario harness is the same instinct; ours is at least as good and better
  documented.
- **Provider swappability.** One interchangeable provider per capability, selected in config. They
  have exactly one backend: themselves.

---

## 4. Recommended evolution — ranked

**Near-term, high value, small:**

1. **Bind `127.0.0.1` by default**; make the bind address configurable (`host`, `LUBBDUBB_HOST`).
   One line, closes an unauthenticated-RCE-shaped hole for anyone not on a firewalled laptop.
2. **Optional shared bearer token** on `/api/*` and `/ws` (env-supplied, like `GITHUB_TOKEN`), so
   exposing the cockpit deliberately is a supported act rather than a foot-gun.
3. **Human-has-the-wheel latch per agent** — typing in the drawer defers `respond_to_agent` for N
   minutes, shown on the fleet card, auto-releasing. Reuses the existing "hold while waiting" path.
4. **Plan approval gate** (`planning.requireApproval`) — a `parts` verdict becomes a cockpit
   proposal before rule 4a commits a stack of agents to it.
5. **Prompt glossary** in `docs/prompt-templates/` — one canonical verb per action across every
   agent-facing surface.

**Mid-term, the structural bets:**

6. **An MCP server for agents** (§2.1). Start with `plan_submit` + `escalate(question, options[])`
   — the two places our current channel is provably too narrow — and retire `plan.json` as a
   transport. Keep the sentinels: they're injected centrally and carry intent an MCP call doesn't
   need to duplicate.
7. **A unified `Decision` record** (§2.2) that escalations, auto-send sign-off and plan approval all
   instantiate, with accept/reject as the one primitive and the Decision log as the audit trail.
8. **`prAttentionStatus(pr, ctx)`** — the PR-side mirror of `issuePickupStatus`, folding health,
   in-flight agent, cooldown, stacked-CI suppression and notify de-dup into one pure verdict with
   reasons, rendered as a per-PR chip.
9. **Numbered migrations** with a recorded schema version, before the first change that needs a data
   backfill rather than an additive column.

**Longer-term, only if the direction is right:**

10. **Multi-project in one instance.** `projects: [{ repoRoot, integrations, … }]` with one global
    fleet, cap and queue across them. This is the single largest thing aiball has that we don't, and
    the config is already shaped for it (provider-per-capability); the work is threading a project
    id through `Store`, worktrees and the dispatch context, plus a cockpit sidebar.
11. **A persistent agent per repo, alongside the ephemeral fleet.** Their strongest claim is context
    continuity — an agent that has been working your repo all week knows things a fresh worktree
    agent re-derives every time. Our model deliberately trades that for isolation and parallelism,
    and I'd keep the trade; but a single long-lived "desk" agent for triage-shaped work (drafting,
    labelling, answering questions about the repo) would capture most of the benefit without
    touching the code path that makes parallel PR work safe.
12. **Backlog nudge strategies** with a landscape hash (§2.7), so a fully-gated world says so
    instead of showing an empty plan.

**Explicitly not recommended:** adopting the pull-based hook loop, the tmux dependency, the PTY
proxy, or an internal ticket board. Each is a consequence of aiball's persistent-session bet, and
each is a step away from ours.
