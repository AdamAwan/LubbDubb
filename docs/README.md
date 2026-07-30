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
| `prompt-templates/` | Ready-to-copy samples of the rule dispatcher's built-in prompt bodies, one file per prompt id. |

`spec/` holds the specification and nothing else. Dated design documents — the proposals that
preceded a feature, recording the options weighed at the time — are **not** kept here: they age out
of agreement with the code the moment it moves, and a reader cannot tell by looking which of two
documents describes the application. The reasoning that is still load-bearing lives in the spec
document that owns the behaviour, or beside the code in `CLAUDE.md`; the rest is in the git history.

## The specification

| #                                    | Document                   | Covers                                                                             |
| ------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------- |
| [01](spec/01-overview.md)            | System overview            | What the harness is, its components, the pulse, the seams, the standing invariants |
| [02](spec/02-configuration.md)       | Configuration              | Every config key, its default, precedence, env overrides, path resolution          |
| [03](spec/03-world-model.md)         | World model                | Domain types, the world snapshot, the ref vocabulary, world diffing, closed PRs    |
| [04](spec/04-harness-cycle.md)       | The harness cycle          | Heartbeat, pulse ordering, coalescing, the world baseline, headroom, exclusion     |
| [05](spec/05-dispatcher.md)          | Dispatch                   | The dispatcher seam, the rule book, ranking, the Up next queue, cooldowns, actions |
| [06](spec/06-issue-pickup.md)        | Issue pickup and labels    | Watch/ignore tags, priority, workflow states, the per-issue pickup verdict         |
| [07](spec/07-pull-requests.md)       | Pull requests              | Health predicates, conflicts, stacks, inherited CI, the merge gate                 |
| [08](spec/08-planning.md)            | The planning funnel        | Plans, parts, the plan document, reconciliation, replan                            |
| [09](spec/09-execution.md)           | Action execution           | The executor's gates, auto-send, task materialisation, worktrees, git              |
| [10](spec/10-agent-runtimes.md)      | Agent runtimes             | Sessions, sentinels, PTY and stream runtimes, transcripts, resume, usage           |
| [11](spec/11-mcp-tools.md)           | The MCP tool channel       | The tools, identity, transport, launch flags, degradation                          |
| [12](spec/12-artifacts-and-files.md) | Artifacts, files, overlaps | Flag sentinel, the file-events hook, artifact serving, file-overlap detection      |
| [13](spec/13-jobs-and-findings.md)   | Jobs and findings          | The operator job queue, agent findings, promotion                                  |
| [14](spec/14-persistence.md)         | Persistence                | The SQLite schema, migrations, the Store API surface, durability rules             |
| [15](spec/15-integrations.md)        | Integrations               | The connector/sink seams, and the fake, GitHub and Azure DevOps providers          |
| [16](spec/16-http-api.md)            | HTTP and WebSocket API     | Every route, the state snapshot, the event stream                                  |
| [17](spec/17-cockpit.md)             | The cockpit                | The web UI: panels, live updates, demo mode                                        |
| [18](spec/18-observability.md)       | Observability              | The error log, decision log, activity feed, usage accounting, debug logging        |
| [19](spec/19-development.md)         | Development and quality    | The `check` gate, test seams, the smoke run, build outputs                         |

## Conventions used throughout

- **Present tense, indicative mood.** "The dispatcher ranks candidates", not "should rank".
- **Defaults are stated explicitly** wherever a behaviour is configurable.
- **Identifiers are exact.** File paths, config keys, table names, rule ids, tool names and event
  names are written as they appear in the code.
- **"Pure"** means a function with no I/O, no clock and no store access — testable in isolation.
- **A "seam"** is an interface with more than one implementation, at least one of which is a test
  fake.
