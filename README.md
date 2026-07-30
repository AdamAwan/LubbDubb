# LubbDubb

A self-hosted, always-running **orchestration harness** for one software engineer's work — a
_cockpit_ that watches your inputs (issues, PRs, CI, review comments), decides what to do on a
heartbeat, and dispatches Claude Code agents to do it, escalating to you only what genuinely needs
judgment.

The name is the heartbeat: the server's core is a periodic pulse that drives everything.

> **Where to read what.** This file is the overview and the shape of the work.
> [`docs/workflow.md`](docs/workflow.md) is the workflow in full, including where a different one
> slots in. [`docs/spec/`](docs/README.md) is the specification of how every part of the application
> behaves today, written as fact — configuration, dispatch rules, agent runtimes, the API, the
> cockpit. If you want the detail behind anything below, it is in there.

---

## The pulse

One repeating cycle, driven by a heartbeat (`heartbeatIntervalMs`, default 5 minutes) and also
triggerable on demand:

```
snapshot the world  →  diff against the last snapshot  →  reconcile plans
      →  decide (dispatcher)  →  execute (executor)  →  audit
```

Every step is recorded. The dispatcher's rationale, every action it emitted, and the outcome of each
action are persisted — so an idle cycle is as explainable as a busy one. Agents run in per-branch git
worktrees (code work) or scratch dirs (desk work), and report back over a typed tool channel.

## The flow of work

Two entry points, one path. A prompt states a goal and a ticket is found or created for it; a ticket
states its own. Everything downstream keys on the ticket, so work started from a prompt is as
recoverable, reviewable and reportable as work started from the tracker.

<!-- Rendered from docs/assets/flow-of-work.mmd — see that file for the regeneration command. -->
<p align="center">
  <img src="docs/assets/flow-of-work.svg" alt="Flow of work: a prompt states a goal or a ticket states its own; both converge on a ticket, which is gated on whether there is enough information to proceed, then planned, accepted, worked, checked against the goal, reported and written back to the ticket." width="560">
</p>

### The standard steps

| Step                         | What happens                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Intake**                   | Every open issue/PR is fetched and shown. What is _acted on_ is decided by the watch/ignore tags, plus tracker workflow states where the provider has them.      |
| **Enough information?**      | One agent reads the ticket against the repository and says whether there is a goal here to work from. Only an explicit `unclear` holds anything.                 |
| **Plan the work**            | A planning agent reads the repo and returns either _one PR will do_ or a decomposition into dependency-chained parts, each with its own branch and scope.        |
| **Plan accepted?**           | A decomposition appears in **Needs you** as accept/reject. Accepting releases the parts to be scheduled; rejecting falls the issue back to the single-PR path.   |
| **Do the work**              | An agent per part (or one for the whole issue), each in its own worktree. Code is the most common arm, not the only one — a part may finish with a report.       |
| **Quality gates**            | Tests, static analysis, pipeline health, human review. Each failing check is classified per check: fix it, fix it with latitude, or hold because it isn't ours.  |
| **Merge**                    | A green, approved, mergeable, comment-clear PR is merged — bottom-up for a stack, and never while it is based on another in-flight branch.                       |
| **Goal achieved?**           | Asked of what was actually delivered, not of the agent's confidence. A `no` returns to planning, because what is missing may be a different decomposition.       |
| **Report and ticket update** | A desk agent writes the run up from the shared scratchpad and the harness's own record. The tracker state moves and status comments are written; nothing closes. |

### Three gates carry the loop

Each is a decision something has to **make**, not a step that always passes.

- **Enough information to proceed** rejects a goal nothing can act on, before an agent spends itself
  discovering that. Refusal is not silent — it says what is missing, on the ticket — and it is not
  permanent: the hold ends when the goal text changes, or when anyone comments.
- **Plan accepted** is where you see the shape of the work before it happens.
- **Goal achieved** is asked of the delivered work. Its `no` arm proposes a replan, a follow-up part,
  or escalates — depending on what the assessment says fell short.

### Priorities when headroom is scarce

The dispatcher ranks every candidate, then applies the concurrency cut. Roughly, highest first:

1. An operator queued a job from the cockpit — takes the next free slot.
2. A PR with problems: failing CI, a stale or conflicting base, an unhandled review comment.
3. A PR that is ready to merge.
4. Planning, approval, assay and assessment for issues.
5. Plan parts, then fresh issue pickup.
6. Story grooming and idle-capacity pickup.

PR work runs _before_ new issue pickup, so a PR in trouble is always worked ahead of starting new
tickets. The full ordered plan ships to the cockpit as **Up next**, with a cut-line at the current
headroom; you can re-order it, and the override persists.

### Where you are in the loop

The harness owns the loop; you own the verdicts. You are asked when — and only when — a decision is
genuinely yours:

- **Needs you** collects escalations, plan approvals, outbound-act proposals, and permission requests
  from agents that hit a command outside the allow-list.
- **Nothing side-effectful leaves without a human**, unless you opt a specific action into
  confidence-gated auto-send (off by default). A rejection stands until the world gives a reason to
  ask again — a push, a CI result, an approval, a comment — and the reason you typed is handed to the
  next agent that works that item.
- **A restart never decides for you.** Agents orphaned by a crash or shutdown are parked, and the
  heartbeat is held until you restore, requeue or remove each one.

Two things are deliberately fixed: every act reaching the outside world is authorized, and an agent
**declares** that it finished — silence never reads as success.

## Getting started

```bash
npm install                                          # builds native deps (better-sqlite3, node-pty)
cp lubbdubb.config.example.json lubbdubb.config.json # your local config (gitignored)
npm start                                            # builds the cockpit, serves on 127.0.0.1:4300
```

The example config runs a mock agent, so no model or provider credentials are needed to see the loop
turn. `npm start` prints the link to open:

```
[lubbdubb] open the cockpit: http://127.0.0.1:4300/#t=<token>
```

Open it once per browser and the cockpit remembers the token. The harness binds **loopback only** and
every route needs that token, because the cockpit can queue a job — and a job spawns a real agent with
write access to your repo. The token is minted into `.lubbdubb/cockpit-token` (0600, gitignored) and
reused across restarts.

Then: use **Inject event** to simulate the world moving (a CI failure, a review comment) and watch the
harness react; click an agent to see its live transcript and type into it; answer items in **Needs
you**; use **New job** to launch an ad-hoc prompt. The **Decision log** shows what was decided each
cycle and which rule produced it; **Activity** shows how the world itself changed.

### Pointing it at real work

Set `integrations` to choose a provider per capability, and configure that provider:

```json
{
  "integrations": { "sourceControl": "github", "issues": "github" },
  "github": { "owner": "acme", "repo": "app" },
  "agentMode": "stream",
  "maxConcurrentAgents": 3,
  "defaultBranch": "main"
}
```

Tokens never live in the config file: `GITHUB_TOKEN` for GitHub, `AZURE_DEVOPS_PAT` (or a logged-in
`az` CLI) for Azure DevOps. Agents inherit your shell's model credentials — note that a stray
`ANTHROPIC_API_KEY` silently bills the API for every agent in the fleet.

Every key, its default and its precedence is in [`docs/spec/02-configuration.md`](docs/spec/02-configuration.md).

## Development

```bash
npm run dev        # server with reload
npm run web:dev    # cockpit with HMR (proxies /api + /ws)
npm test           # unit + integration tests (node:test)
npm run smoke      # full end-to-end with real node-pty + a git worktree
npm run check      # format, lint, typecheck ×2, knip, test — concurrently, in one shot
```

`npm run check` is the gate CI enforces. It runs its stages in parallel and reports every failure
rather than stopping at the first; a warm run costs about as long as the test suite alone.

See [`docs/spec/19-development.md`](docs/spec/19-development.md) for the test seams, the coverage and
security workflows, and the hosted GitHub Pages demo build.

## Documentation

| Where                                              | What it is                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`docs/workflow.md`](docs/workflow.md)             | The end-to-end workflow, its variation points, and what is narrower than drawn |
| [`docs/spec/`](docs/README.md)                     | The specification of every subsystem as it behaves today                       |
| [`docs/prompt-templates/`](docs/prompt-templates/) | The rule dispatcher's built-in prompt bodies, ready to override                |
| [`CLAUDE.md`](CLAUDE.md)                           | Operating notes for agents working in this repo — the sharp edges              |
