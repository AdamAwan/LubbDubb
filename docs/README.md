# LubbDubb documentation

This folder is the **specification of the product LubbDubb is meant to be**. Every statement in
`spec/` describes behaviour the application is supposed to have, in the present tense. If the code
does something other than what a spec says, one of the two is wrong and the discrepancy must be
resolved rather than tolerated — **unless the spec has marked that behaviour as not yet built**,
which is the one honest reason for the two to differ.

That marking is the whole discipline. A specification that may describe unbuilt work is worth more
than one that may not — the design is argued with in the place it will be maintained, rather than in
a proposal that ages out of the tree the moment the code moves — but it is worth that only while a
reader can tell the two apart at a glance. So:

- **Unbuilt behaviour is marked where it is described**, at the top of the document or the section
  that carries it, saying plainly what is outstanding. An unmarked statement is a claim about
  running code, and being wrong about that is a bug.
- **A path that does not exist yet is written in italics** — _src/thing/notYetWritten.ts_ — where a real
  one is backticked. `test/docsReferences.test.ts` asserts that every backticked repo path exists,
  so the two forms stay separated mechanically rather than by good intentions.
- **A marker is removed by the change that makes it true**, in that change and not later. A spec
  still marked unbuilt after its code has landed is the failure this convention has instead of the
  one it replaced.

What the specs are still not: a roadmap or a wish list. "Not yet built" is not a licence to describe
things nobody intends to do — a spec earns its place by being what the next change is written
against, and behaviour that is off by default is still described as off by default, and what turning
it on does.

## Layout

| Path                  | What it holds                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `spec/`               | The specification, one document per subsystem. Numbered by the order they build on each other. |
| `workflow.md`         | The end-to-end workflow the harness is built to run, and where a different one slots in.       |
| `operating.md`        | The operator's guide: what changes about the job, and the five decisions that stay yours.      |
| `operating.html`      | The same guide as a page to skim — open it in a browser. Kept in step with `operating.md`.     |
| `feature-timeline.md` | What landed when, from the walking skeleton onwards — features, not commits.                   |
| `prompt-templates/`   | Ready-to-copy samples of the rule dispatcher's built-in prompt bodies, one file per prompt id. |
| `plans/`              | Build plans for specs still marked unbuilt. Each is deleted by the change that finishes it.    |

`spec/` holds the specification and nothing else. Dated design documents — the proposals that
preceded a feature, recording the options weighed at the time — are **not** kept here: they age out
of agreement with the code the moment it moves, and a reader cannot tell by looking which of two
documents describes the application. The reasoning that is still load-bearing lives in the spec
document that owns the behaviour; the rest is in the git history.

A **build plan** — the staged order a spec still marked unbuilt gets built in — lives under `plans/`
while it is being worked and is **deleted by the change that finishes the last stage**, for the same
reason: once the code has landed it is a second document describing the application, and a reader
cannot tell by looking which of the two is true. There is none open at present.

## `CLAUDE.md` and `spec/` — the division of labour

The two are split by **when they are read**, and that is the whole rule.

[`CLAUDE.md`](../CLAUDE.md) is loaded into **every agent's context on every dispatch**. Its length is
therefore a recurring, fleet-wide cost and its accuracy is a correctness concern rather than a
tidiness one: a stale line there is a false instruction handed to every agent before it reads any
code. So it holds one genre only — the things that, not knowing them, get something broken
**silently**: a failure `npm run check` does not catch, that is not obvious at the call site, and
that no test surfaces. `PtySession.kill()` setting status before signalling qualifies; the argument
for why proposals are a table rather than columns on `escalations` does not.

`spec/` is read **on demand**, by whoever is changing that subsystem. It carries the full
description _and_ the reasoning behind it — which is what stops a later change re-litigating a
settled decision badly, and is exactly why it must not be deleted for being long. A sharp edge that
survives in `CLAUDE.md` links to the document that argues it.

Neither file is a place to record what the other owns. A passage that starts as an operating note
and grows an argument belongs in a spec, with a one-line pointer left behind. `CLAUDE.md`'s length
is asserted rather than intended (`test/docsReferences.test.ts`), because it grew to 2,222 lines
once by nobody noticing.

## Keeping these documents honest

Prose about code cannot be typechecked, and its failure mode is confident wrongness — nobody
notices, so it is acted on. `test/docsReferences.test.ts` closes the one class that is both common
and mechanically decidable: a backticked repo-relative path that no longer names anything. What is
deliberately left unchecked, and why, is in
[19 — Development](spec/19-development.md#what-holds-the-documentation-honest).

## The specification

| #                                    | Document                   | Covers                                                                                                                  |
| ------------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [01](spec/01-overview.md)            | System overview            | What the harness is, its components, the pulse, the seams, the standing invariants                                      |
| [02](spec/02-configuration.md)       | Configuration              | Every config key, its default, precedence, env overrides, path resolution                                               |
| [03](spec/03-world-model.md)         | World model                | Domain types, the world snapshot, the ref vocabulary, world diffing, closed PRs                                         |
| [04](spec/04-harness-cycle.md)       | The harness cycle          | Heartbeat, pulse ordering, coalescing, the world baseline, headroom, exclusion                                          |
| [05](spec/05-dispatcher.md)          | Dispatch                   | The dispatcher seam, the rule book, ranking, the Up next queue, cooldowns, actions                                      |
| [06](spec/06-issue-pickup.md)        | Issue pickup and labels    | The watch tag, priority, workflow states, the per-issue pickup verdict                                                  |
| [07](spec/07-pull-requests.md)       | Pull requests              | Health predicates, conflicts, stacks, inherited CI, the merge gate                                                      |
| [08](spec/08-planning.md)            | The planning funnel        | Plans, parts, the plan document, reconciliation, replan                                                                 |
| [09](spec/09-execution.md)           | Action execution           | The executor's gates, outbound authority, task materialisation, worktrees, git                                          |
| [10](spec/10-agent-runtimes.md)      | Agent runtimes             | Sessions, sentinels, PTY and stream runtimes, transcripts, resume, usage                                                |
| [11](spec/11-mcp-tools.md)           | The MCP tool channel       | The tools, identity, transport, launch flags, degradation                                                               |
| [12](spec/12-artifacts-and-files.md) | Artifacts, files, overlaps | Flag sentinel, the file-events hook, artifact serving, file-overlap detection                                           |
| [13](spec/13-jobs-and-tickets.md)    | Jobs, tickets, human tasks | The operator job queue, schedules, filing a tracker item, and work only a person does                                   |
| [14](spec/14-persistence.md)         | Persistence                | The SQLite schema, migrations, the Store API surface, durability rules                                                  |
| [15](spec/15-integrations.md)        | Integrations               | The connector/sink seams, and the fake, GitHub and Azure DevOps providers                                               |
| [16](spec/16-http-api.md)            | HTTP and WebSocket API     | Every route, the state snapshot, the event stream                                                                       |
| [17](spec/17-cockpit.md)             | The cockpit                | The console: the queue rail, goal pages, the overview, the backlog, live updates                                        |
| [18](spec/18-observability.md)       | Observability              | The error log, decision log, activity feed, usage accounting, debug logging                                             |
| [19](spec/19-development.md)         | Development and quality    | The `check` gate, test seams, the smoke run, build outputs                                                              |
| [20](spec/20-validation.md)          | Validation                 | Checks on the delivered goal, resources, the verdict, and the close-out flag                                            |
| [21](spec/21-self-update.md)         | Self-update                | The harness's own build: the watch, the drain, the handoff, the supervisor                                              |
| [22](spec/22-pets.md)                | Pets                       | The vivarium: the eggs an operator's actions drop, hatching, beats, growth, the corner                                  |
| [23](spec/23-local-runs.md)          | Local runs                 | The machine's one dev environment: which goal is in it, the process, the panel                                          |
| [24](spec/24-environments.md)        | Environments               | Where landed work has got to: merge attribution, the probe, the three verdicts, the lens                                |
| [25](spec/25-supply.md)              | Supply and the runway      | Whether there is work left for the fleet, and whether the reason there is not is you                                    |
| [26](spec/26-setup.md)               | Configuration health       | The checks that catch a silently-misconfigured harness, the fixes they carry, and the sheet that points it at a project |
| [27](spec/27-obstacles.md)           | Obstacles                  | What is in the fleet's way: keys, the two-voice gate, who owns it, and how an agent is told to stand down               |
| [28](spec/28-cross-fleet-pool.md)    | The cross-fleet pool       | One namespace per fleet, and the shared digest of what each one spent                                                   |
| [29](spec/29-post-deploy-watch.md)   | The post-deploy watch      | Whether shipped work behaves: the declaration, the dry run, the window, and the three verdicts                          |
| [30](spec/30-ingress.md)             | Event-driven ingress       | The inbound webhook endpoint: what it verifies, what one delivery invalidates, and what it does not trust               |
| [31](spec/31-review-packs.md)        | Review packs               | How a change is restated for a human: the witness log, the ideas, the claims, and the check                             |
| [32](spec/32-local-validation.md)    | Local validation           | The fleet driving that environment: the plan, the browser, the reading, and the fix it schedules                        |
| [33](spec/33-story-sequencing.md)    | Story sequencing           | The order the stories under a Feature are worked in, where it comes from, and the hold it puts on a story               |
| [34](spec/34-usage-metrics.md)       | Usage metrics              | What the harness asks of a person and what they do about it: the ledger, surface reach, the digest section              |

## Conventions used throughout

- **Present tense, indicative mood.** "The dispatcher ranks candidates", not "should rank". This
  holds for unbuilt behaviour too — the marker says it is unbuilt, so the prose does not have to
  hedge, and a section written in "will" has to be rewritten to become true rather than unmarked.
- **Defaults are stated explicitly** wherever a behaviour is configurable.
- **Identifiers are exact.** File paths, config keys, table names, rule ids, tool names and event
  names are written as they appear in the code — backticked once they exist, italic until then.
- **"Pure"** means a function with no I/O, no clock and no store access — testable in isolation.
- **A "seam"** is an interface with more than one implementation, at least one of which is a test
  fake.
