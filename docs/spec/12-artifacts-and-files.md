# 12 — Artifacts, files and overlaps

Three related mechanisms: an agent can _announce_ an artifact, the harness _observes_ every file an
agent writes, and it _detects_ when two agents wrote the same file at the same time.

## The flag sentinel

`@@LUBBDUBB_FLAG:<payload>@@` lets an agent push an artifact or link to the cockpit mid-run — a design
doc, a report — **without changing its status**. Payload parsing is pure (`parseFlag` / `extractFlags`,
`src/agents/sentinels.ts`); see [10](10-agent-runtimes.md).

Both runtimes detect it on the _raw_ stream and emit `flag`. It strips from display through the same
`stripSentinels` / hold machinery as the waiting sentinel — in `PtySession` via the shared
`sentinelScanner`, which excises every hit from the detection tail (a flag latches no status, so a
sliding window would otherwise re-emit it).

`AgentManager.recordFlag` persists it to `agent_flags`, **deduped by `(agent, ref)`** so an evolving doc
refreshes in place rather than piling up duplicates, re-emits it as `flag`, and the `Hub` ships it as
`agent:flag` plus a `dirty`. `buildStateSnapshot` includes `flags`, and the cockpit groups them by
agent onto the card and drawer as chips.

The flag sentinel is purely additive detection: on in every agent mode, gated behind nothing.

## The file-events hook

The flag sentinel only surfaces an artifact if the agent's **prompt** tells it to print the sentinel —
so every skill that emits a report has to know the protocol. A Claude Code `PostToolUse` hook removes
that coupling: it fires for _any_ file-writing tool regardless of what the agent was told.

`src/agents/fileEvents.ts`.

### The hook

`FILE_EVENTS_SETTINGS` is a `--settings` fragment matching `Write|Edit|MultiEdit|NotebookEdit` — the
tools whose `tool_input` carries a `file_path`/`notebook_path`. It is wired once into the launch
`--settings` for **both** runtimes (hooks fire in headless stream mode too; they just do not appear in
the stream output). Because `--settings` has no array form, the status-line and file-events fragments
are merged into one JSON object.

The hook body reads the tool payload on stdin, extracts **the written path only — never the file
content** — and drops a `{path, tool}` record into `$LUBBDUBB_EVENTS_DIR` as its own file, written to
`.tmp` then renamed, so a concurrent drain never reads a partial and parallel tool batches never
interleave.

Two deliberate choices:

- **Exec form, not shell form.** The hook is `{command: "node", args: ["-e", …]}`, which Claude Code
  spawns as a bare executable with that argv — **no shell**. A shell-string form breaks on Windows:
  Claude Code runs hook strings through Git Bash only when it is installed, else PowerShell, and a
  POSIX body like `if [ -n "$VAR" ]; then …; fi` is a PowerShell parse error, so the hook silently
  no-ops and no artifacts ever surface. Exec form sidesteps every shell's quoting and builtins, which
  is why the env-var guard lives **inside** the script and `node` is invoked directly (always on PATH —
  `claude` is a node CLI).
- **Env-gated on `$LUBBDUBB_EVENTS_DIR`**, which is set only in the spawn env, so it is a silent no-op
  for a human running `claude` in that repo by hand.

When `LUBBDUBB_EVENTS_DEBUG` is set (the harness sets it alongside the events dir whenever
`LUBBDUBB_DEBUG` is on), every fire appends a breadcrumb to `_hook-debug.log` recording the tool name,
the `tool_input` **key names** (never their values) and the extracted path. This is the one signal that
proves the hook actually ran: its absence when a write clearly happened localises the fault to
`--settings` not taking effect, rather than anything downstream.

### Coexistence with the target repo's config

Verified, not assumed. LubbDubb agents run in a **git worktree of the repo they are working on**, so
that repo's committed `.claude/settings.json`, `.claude/skills/` and `CLAUDE.md` are present in the cwd
and load normally. The hook rides on `--settings`, which is an _additional_ settings source, and hooks
**merge** across sources (like permission rules, not last-one-wins), so our `PostToolUse` entry and the
target repo's own hooks **both** fire — confirmed empirically with a nested `claude` run where a project
hook and a `--settings` hook both fired on one `Write`. Skills and `CLAUDE.md` are filesystem-discovered
and unaffected by `--settings`.

### The spool

`FileEventsSpool` is the read side: one directory per key under `<tmpdir>/lubbdubb/events`.

- `dirFor(key)` — the directory, exported as `LUBBDUBB_EVENTS_DIR` at spawn.
- `drain(key)` — reads and removes every settled `.json` record, oldest first (names are
  timestamp-prefixed), so a record is delivered **exactly once**.
- `readDebug(key)` — the breadcrumbs, non-destructive.
- `dispose(key)` — drops the directory.

The key is minted **per spawn**, independent of the resume session id — so the `raw` runtime, which
pins no session id, still gets one. It is disposed on reap, kill and `interruptAll`; a resume mints a
fresh one.

### Draining and classification

`AgentManager.drainFileEvents` is piggybacked on the `output` stream — an agent that writes a file also
produces output around it, so writes surface promptly with **no polling timer** — plus a final drain at
terminal, at kill, and when parking on a human.

Each record folds in through the pure `classifyArtifact(path, docsFolderPrefix)`:

- **Every** path is recorded in `agent_files` (deduped per agent+path) — the drawer's "files changed"
  list, snapshot key `files`.
- **Report-like** paths are additionally promoted through the _same_ `Store.recordFlag` and `flag`
  event as a sentinel flag, so a report becomes a chip via identical dedup / `agent:flag` / confined
  artifact-route machinery.

Promotion rules, in order:

1. The path is under one of the configured `docsFolderPrefix` entries — **any extension**.
2. The path contains a `reports/` (or `report/`) segment.
3. The extension is in the allowlist: `md`, `markdown`, `html`, `htm`, `pdf`, `txt`, `rst`, `adoc` →
   kind `report`; `csv`, `tsv` → `data`; `svg` → `diagram`.

Otherwise `{promoted: false, kind: 'file'}`.

Prefix matching is segment-wise and case-insensitive, and a file _under_ the prefix must have strictly
more segments than the prefix itself. A **relative** entry matches the worktree-relative path; an
**absolute** entry (e.g. `D:/docs`) matches an out-of-worktree write left absolute. The two never
cross.

`toWorktreeRelative` reduces a hook-reported path to worktree-relative when it landed inside the
agent's cwd (so the confined artifact route can serve it) and leaves it as reported otherwise. The
result is normalised to forward slashes, because the stored path is used as an artifact **ref** —
served by a URL-oriented route and linked in the cockpit — so it must match the forward-slash form
every other platform produces.

The plan side channel rides the same drain: `isPlanFile(path)` recognises `.lubbdubb/plan.json`, and
the read must happen **inside the drain** while `agent.cwd` still exists.

Tests: `test/fileEvents.test.ts`.

## Serving artifacts

`GET /artifacts/:id`, addressed by **flag id** — so the served path comes from the stored flag row,
never from the request, and the taint never reaches a path expression. Four layers:

1. **Only a real flag.** An unknown id 404s. A URL ref 400s ("url refs are linked directly, not
   served"); the cockpit links those.
2. **Confinement.** `resolveConfinedArtifact(cwd, ref, trustedRoots)` resolves a relative ref against
   the agent's worktree and honours an absolute ref only if it lands inside a trusted root. Trusted
   roots are the agent's `cwd` plus the **absolute** entries of `docsFolderPrefix`
   (`absolutePrefixes(...)`) — operator-configured, so widening the boundary is the operator's own
   decision. A **lexical** containment check against some root runs **before any filesystem access**,
   then `realpathSync` on both sides defeats symlink traversal. A missing path, a broken symlink, a
   permission error or a non-regular file all read as not found.
3. **Rate limiting.** `@fastify/rate-limit` is registered with `global: false` and this route opts in
   at 120 requests per minute, so the cockpit's frequent state polling is never throttled while a route
   that reads off disk is.
4. **Sandboxing.** `Content-Security-Policy: sandbox allow-scripts allow-downloads` and
   `X-Content-Type-Options: nosniff`, so agent-authored HTML cannot script the cockpit origin. The
   content type is chosen by extension from a fixed map, falling back to `application/octet-stream`.

### The route lives outside `/api`, and authorizes itself (issue #129)

Opening a chip is a **top-level browser navigation**, and a navigation cannot carry the
`Authorization` header the cockpit attaches to every `fetch` — the token lives in a `#t=` fragment a
browser never sends to a server. So a route under `/api`, where `authorizeRequest` refuses anything
without the bearer token, is structurally unreachable by a chip click, and every artifact link 401'd
once the cockpit was authenticated.

Rather than carve an exception _into_ the prefix guard — which would erode "guarded by prefix, not by
per-route opt-in" ([16](16-http-api.md#authentication)) — the route sits at `/artifacts/:id` and
guards itself with a **per-flag capability** (`src/server/artifactCapability.ts`, pure). A fresh
per-run secret HMAC-signs `<flag id>.<expiry>`; `buildStateSnapshot` mints one into every local
artifact URL it ships (`artifactUrls`, keyed by flag id — the cockpit looks a chip's URL up there the
way it looks refs up in `refUrls`, and never string-builds one); and the route verifies it against
the flag id in its **own path** before touching the store.

Three properties make a capability safe to put in a URL, which the cockpit token deliberately never
is:

- **Flag-scoped.** A capability for one artifact cannot open another, and cannot be replayed against
  `/api/state` or `/api/jobs`, which accept only the bearer token.
- **Short-lived.** `ARTIFACT_CAP_TTL_MS` is 5 minutes, and the snapshot re-mints on every poll, so a
  leaked URL dies fast.
- **Stateless.** It is an HMAC, so there is nothing stored to leak or evict.

The signing key is a per-run random secret, never the cockpit token, so a capability is not the
cockpit token even derived. With `auth.enabled` off there is no key and the route serves without a
capability — the whole surface is open by the operator's choice, loopback-only.

Tests: `test/artifactCapability.test.ts` for the mint/verify predicate, and the navigation and
capability-scoping cases in `test/cockpitAuth.test.ts`.

## File-overlap detection

`src/fileOverlap.ts`. The three dispatch gates — one code agent per PR branch,
`findActiveTaskByOrigin`, `maxConcurrentPartsPerIssue` — are keyed on what the dispatcher _dispatches_,
and are complete for that. **None of them can see what an agent does once running**: two agents on two
branches, each perfectly within its own gate, both editing one file. Git reports it only when the hunks
collide; when they do not, the second merge quietly undoes or duplicates the first.

`detectFileOverlaps({files, agents, tasks})` is pure and joins `agent_files` **across** agents — rows
the file-events hook already writes for everyone, needing no prompt-side knowledge and no tool channel,
which is exactly what an advisory `claim` could never be.

Three narrowings carry it:

- **Code tasks only.** A desk agent works in a scratch directory, so its `notes.md` and another's are
  different files with one name. Only code agents write into checkouts of the same repository.
- **Concurrency, not history.** Two agents that wrote a path at different times are ordinary: the later
  one's worktree was cut from a base that already held the earlier one's work. Without this filter
  every long-lived file in the repo is an "overlap".
- **Agent lifetimes, not write timestamps.** A file row is deduped per (agent, path) and its timestamp
  is bumped on rewrite, so it dates the _last_ write. Overlapping lifetimes is the reading the data
  actually supports.

`lifetime(agent)` is the **one** reading of "was it still going", so the concurrency test and the
panel's `live` flag cannot disagree. Status decides whether the window is open (the same liveness
signal `countLiveAgents` uses) and `endedAt` closes it; a dead row lacking a stamp is closed at its
start, so a data defect under-reports rather than accuses.

A writer is included only if it overlapped _someone_: three agents on one path where only two were ever
concurrent is a two-agent collision, and naming the third would be an accusation the data does not
support.

`sameWorktree` marks the bad case: `WorktreeManager` is reuse-first, so one branch is one directory —
two live agents there are editing one file **on disk**, with no merge anywhere to reconcile them.

Results are sorted live-first (the only ones an operator can still act on), then `sameWorktree`, then
most recent. Shipped in `/api/state` as `overlaps` and folded to `liveOverlapCount` on the cockpit's
view model. No console surface draws the list itself: the floor's findings desk did, and deleting the
floor took the only reader with it.

It is **diagnostic only** — nothing in the dispatcher reads it, for the same reason nothing reads
`findings` — and it is deliberately after-the-fact, which is the trade for being structural.

Tests: `test/fileOverlap.test.ts`.
