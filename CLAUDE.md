# CLAUDE.md

Operating notes for AI agents working in this repo. This file is loaded into **every** agent's
context on **every** dispatch, so it holds one genre only: the things that, not knowing them, break
something **silently** — a failure `npm run check` does not catch, that is not obvious at the call
site, and that no test surfaces.

Everything else — how each subsystem works, and why — is in **[`docs/spec/`](docs/README.md)**,
read on demand. A spec states the behaviour the product is meant to have; if the code differs, one
of them is wrong, unless the spec marks that behaviour as not yet built. The [README](README.md)
covers what LubbDubb _is_ and how to run it.

**When you change behaviour, update the spec document that owns it in the same change.** That is
the repo's one documentation rule, and it is not optional bookkeeping: the specs are where the
_why_ of this codebase lives, so a change that lands without its spec update leaves the only
written account of the behaviour wrong — and every later agent reads that account instead of the
code. A spec left behind is worse than no spec, because it is trusted. Treat the spec edit as part
of the change, not a follow-up: a diff that touches behaviour and no spec is incomplete.
[`docs/README.md`](docs/README.md) says which spec owns what.

## Making a change

1. Find the spec that owns the behaviour and read the invariants it states.
2. Change the code.
3. Update that spec in the same change — the invariants it states, not just the prose around
   them. If the change makes a spec's statement false, the spec is part of the bug.
4. Add or extend a test at the `buildSystem` seam, or a unit test for a pure function.
5. `npm run check` — format:check, lint, typecheck, typecheck:web, knip, test. CI runs the same six.

Two `check` failures are not obvious ([19](docs/spec/19-development.md) has the rest): **knip runs
with every rule at `error`** — the fix for an unused type or helper is to **drop the `export`**,
never an ignore list (unused class members are not checked). And there
are **two typecheckers**: `typecheck` (server) and `typecheck:web` (cockpit) are separate passes.

A fresh clone needs `npm ci` first — `node-pty` is a native build.

## Conventions

- **ESM with explicit `.js` import extensions**, even from `.ts` sources. TS `nodenext`.
- **Explanation belongs in the spec, not in a comment.** The code is deliberately comment-light;
  match that. Where a reader needs the _why_, the spec that owns the behaviour is the place for it —
  a comment carrying reasoning is a second copy that nothing keeps true. Reach for an inline comment
  only for something a spec cannot hold: a local non-obvious workaround at the exact line it applies
  to. Terse, and never restating _what_ the code does.
- **Typed `emit`/`on` overrides** on `EventEmitter` subclasses — keep event payloads typed.
- **Domain types live in `src/types/`; the shapes the HTTP routes ship live in `src/wire/`** — one
  module per subsystem, each re-exported by `export type *` from the `src/types.ts` / `src/wire.ts`
  barrel that every import site names. `web/src/types.ts` re-exports `src/wire.ts`. A wire type either
  **is** a domain type or `extends` it — never a re-declaration, never widened. `src/wire.ts` is the
  only server module `web/src/` may name.
- **`src/system/system.ts` is the composition root.** A new component is threaded through it.
- **`src/store/` is the only directory that touches SQLite.** Writes are synchronous, which keeps the
  harness logic race-free. One module per table group, each taking a `StoreContext` and reached as a
  named member — `store.tasks.getTask(id)`; `Store` forwards nothing. → [14](docs/spec/14-persistence.md#shape)

## Sharp edges

The ones a selector or a grep can see are lint rules and structural tests, whose failures say the fix
([19](docs/spec/19-development.md#guards)); what follows is what no tool catches.

Most sharp edges belong to one directory and live in a `CLAUDE.md` beside its code, which Claude Code
loads when you read or edit a file there ([Directory notes](#directory-notes)). The ones below can be
tripped from anywhere.

### Prompts and templates

- **Anything new an agent must read is _appended_ to the rendered prompt, never interpolated.**
  Templates are operator-overridable and `loadPromptTemplates` rejects only _unknown_ placeholders,
  so an override that never learned your new `{token}` silently drops it — on exactly the
  deployments that customised most. → [09](docs/spec/09-execution.md), [05](docs/spec/05-dispatcher.md#prompt-templates)
- **A `PromptId` is never deleted — it is marked `retired: true`.** Removing an id turns every
  deployment that overrode it into a harness that will not boot. The same holds one layer over, for a
  **tool name**: a withdrawn name is added to `RETIRED_TOOL_NAMES` (`src/mcp/names.ts`) and answers
  with a refusal that points at what replaced it, because a name that is simply gone comes back as an
  unknown method — a broken channel rather than an out-of-date prompt, appearing in no reading at all.
  → [05](docs/spec/05-dispatcher.md#prompt-templates), [11](docs/spec/11-mcp-tools.md#retired-tools)

### Filing a tracker item

- **What a filed ticket must carry goes in `IssueCreateInput`, never in a sentence in a prompt.**
  Type, labels, assignee and the bug/story relation are arguments to `ActionSink.createIssue`,
  resolved by `ticketFiler` (`src/tickets/filing.ts`). Told to an agent instead, each failure is
  silent: a ticket without the watch label is created, linked, shown complete, and **never dispatched
  for**. → [13](docs/spec/13-jobs-and-tickets.md#filing-a-ticket), [15](docs/spec/15-integrations.md)

### Dispatch

- **A new `issue:<n>:…` origin is a family in `src/issueOrigins.ts`**; lint catches a template literal, not a
  concatenation. → [05](docs/spec/05-dispatcher.md#the-issue-origin-vocabulary)

### Agent launch

- **Never add `ANTHROPIC_API_KEY` to an operator's env or config to "fix" auth** (lint catches it in `src/`): the
  whole fleet moves onto API billing. Fix the login. → [02](docs/spec/02-configuration.md#secrets)

### Errors and config

- **Do not add swallowed `catch`es.** Route every caught failure through `errors.record(...)`
  (`src/errorLog.ts`). Its event is named `logged`, not `error` — an unlistened `error` event
  throws, and recording a failure must never throw. → [18](docs/spec/18-observability.md)
- **No secret is ever a config key.** `GITHUB_TOKEN`, `AZURE_DEVOPS_PAT` and `LUBBDUBB_TOKEN` come
  from the environment. Precedence is explicit overrides → env → `lubbdubb.config.json` →
  `lubbdubb.project.json` → defaults. → [02](docs/spec/02-configuration.md)

## Directory notes

Each holds the sharp edges for the code beside it. Read the one for a directory before changing it.

- [`src/agents/CLAUDE.md`](src/agents/CLAUDE.md) — agent runtimes: reaping, session flags, resume, `agentMode`, usage windows, launch args
- [`src/config/CLAUDE.md`](src/config/CLAUDE.md) — config layers and `mergeLayers`
- [`src/dispatcher/CLAUDE.md`](src/dispatcher/CLAUDE.md) — the rule book, pipeline order, the investigate label, lenses
- [`src/environments/CLAUDE.md`](src/environments/CLAUDE.md) — reach verdicts, landings, arrivals
- [`src/extensions/CLAUDE.md`](src/extensions/CLAUDE.md) — project extensions: slot contracts and the API version
- [`src/git/CLAUDE.md`](src/git/CLAUDE.md) — `resolveCommit` and `GitObserver`
- [`src/integrations/CLAUDE.md`](src/integrations/CLAUDE.md) — providers: label authorship, review-reply attribution, `*Api` fakes
- [`src/mcp/CLAUDE.md`](src/mcp/CLAUDE.md) — the tool channel: `buildTools` names, the desktop channel
- [`src/pets/CLAUDE.md`](src/pets/CLAUDE.md) — one-shot ids
- [`src/pool/CLAUDE.md`](src/pool/CLAUDE.md) — `PoolDesk`
- [`src/pty/CLAUDE.md`](src/pty/CLAUDE.md) — `PtySession` and sentinel matching
- [`src/sequence/CLAUDE.md`](src/sequence/CLAUDE.md) — story sequencing
- [`src/server/CLAUDE.md`](src/server/CLAUDE.md) — `main.ts` signal handlers, routes
- [`src/store/CLAUDE.md`](src/store/CLAUDE.md) — migrations, partial indexes, backfills, issue verdicts
- [`src/system/CLAUDE.md`](src/system/CLAUDE.md) — pulse desk order
- [`src/validation/CLAUDE.md`](src/validation/CLAUDE.md) — check `area`, `fleetCanStart`, failed checks, tenants, the remote desk and sheets
- [`src/worktree/CLAUDE.md`](src/worktree/CLAUDE.md) — the slot pool, the lease, the local-run checkout
- [`test/CLAUDE.md`](test/CLAUDE.md) — fakes every test must inject, and the `buildSystem` seam
- [`web/CLAUDE.md`](web/CLAUDE.md) — the cockpit: tokens, refs, `standsFor`, `Place`

## Where to read further

[`docs/README.md`](docs/README.md) is the index: one spec per subsystem, numbered by the order they
build on each other. Start there rather than grepping. `docs/workflow.md` describes the end-to-end
workflow the harness runs; `docs/prompt-templates/` holds copies of the built-in prompt bodies.
