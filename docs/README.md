# LubbDubb documentation

This folder is the **specification of LubbDubb as it is**. Every statement in `spec/` describes
behaviour the application has today, in the present tense. If the code does something other than
what a spec says, that is a **bug** — in the code or in the spec, and the discrepancy must be
resolved rather than tolerated.

What the specs are not: a roadmap, a proposal, or a wish list. Nothing here is written as "will",
"should eventually", or "planned". Behaviour that does not exist is not described; behaviour that is
off by default is described as off by default, and what turning it on does.

## Layout

| Path                | What it holds                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `spec/`             | The specification, one document per subsystem. Numbered by the order they build on each other. |
| `workflow.md`       | The end-to-end workflow the harness is built to run, and where a different one slots in.       |
| `operating.md`      | The operator's guide: what changes about the job, and the five decisions that stay yours.      |
| `operating.html`    | The same guide as a page to skim — open it in a browser. Kept in step with `operating.md`.     |
| `prompt-templates/` | Ready-to-copy samples of the rule dispatcher's built-in prompt bodies, one file per prompt id. |

`spec/` holds the specification and nothing else. Dated design documents — the proposals that
preceded a feature, recording the options weighed at the time — are **not** kept here: they age out
of agreement with the code the moment it moves, and a reader cannot tell by looking which of two
documents describes the application. The reasoning that is still load-bearing lives in the spec
document that owns the behaviour; the rest is in the git history.

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

| #                                    | Document                   | Covers                                                                               |
| ------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------ |
| [01](spec/01-overview.md)            | System overview            | What the harness is, its components, the pulse, the seams, the standing invariants   |
| [02](spec/02-configuration.md)       | Configuration              | Every config key, its default, precedence, env overrides, path resolution            |
| [03](spec/03-world-model.md)         | World model                | Domain types, the world snapshot, the ref vocabulary, world diffing, closed PRs      |
| [04](spec/04-harness-cycle.md)       | The harness cycle          | Heartbeat, pulse ordering, coalescing, the world baseline, headroom, exclusion       |
| [05](spec/05-dispatcher.md)          | Dispatch                   | The dispatcher seam, the rule book, ranking, the Up next queue, cooldowns, actions   |
| [06](spec/06-issue-pickup.md)        | Issue pickup and labels    | The watch tag, priority, workflow states, the per-issue pickup verdict               |
| [07](spec/07-pull-requests.md)       | Pull requests              | Health predicates, conflicts, stacks, inherited CI, the merge gate                   |
| [08](spec/08-planning.md)            | The planning funnel        | Plans, parts, the plan document, reconciliation, replan                              |
| [09](spec/09-execution.md)           | Action execution           | The executor's gates, outbound authority, task materialisation, worktrees, git       |
| [10](spec/10-agent-runtimes.md)      | Agent runtimes             | Sessions, sentinels, PTY and stream runtimes, transcripts, resume, usage             |
| [11](spec/11-mcp-tools.md)           | The MCP tool channel       | The tools, identity, transport, launch flags, degradation                            |
| [12](spec/12-artifacts-and-files.md) | Artifacts, files, overlaps | Flag sentinel, the file-events hook, artifact serving, file-overlap detection        |
| [13](spec/13-jobs-and-findings.md)   | Jobs, findings, lessons    | The operator job queue, agent findings, durable lessons, and work only a person does |
| [14](spec/14-persistence.md)         | Persistence                | The SQLite schema, migrations, the Store API surface, durability rules               |
| [15](spec/15-integrations.md)        | Integrations               | The connector/sink seams, and the fake, GitHub and Azure DevOps providers            |
| [16](spec/16-http-api.md)            | HTTP and WebSocket API     | Every route, the state snapshot, the event stream                                    |
| [17](spec/17-cockpit.md)             | The cockpit                | The console: the queue rail, goal pages, the overview, the backlog, live updates     |
| [18](spec/18-observability.md)       | Observability              | The error log, decision log, activity feed, usage accounting, debug logging          |
| [19](spec/19-development.md)         | Development and quality    | The `check` gate, test seams, the smoke run, build outputs                           |
| [20](spec/20-validation.md)          | Validation                 | Checks on the delivered goal, resources, the verdict, and the close-out flag         |
| [21](spec/21-self-update.md)         | Self-update                | The harness's own build: the watch, the drain, the handoff, the supervisor           |
| [22](spec/22-pets.md)                | Pets                       | The vivarium: what hatches from an operator's actions, beats, growth, the corner     |

## Conventions used throughout

- **Present tense, indicative mood.** "The dispatcher ranks candidates", not "should rank".
- **Defaults are stated explicitly** wherever a behaviour is configurable.
- **Identifiers are exact.** File paths, config keys, table names, rule ids, tool names and event
  names are written as they appear in the code.
- **"Pure"** means a function with no I/O, no clock and no store access — testable in isolation.
- **A "seam"** is an interface with more than one implementation, at least one of which is a test
  fake.
