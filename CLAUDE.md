# CLAUDE.md

Operating notes for AI agents working in this repo. The [README](README.md) covers what
LubbDubb _is_ and how to run it — this file is the stuff you need to change code safely and
not trip the CI gate. Read the README's Architecture table once; it won't be repeated here.

**[`docs/spec/`](docs/README.md) is the specification of how every part of this application
works, written as fact.** It is the truth of the application: if the code does something a spec
doesn't say, that is a bug in one of them. When you change behaviour, update the spec document
that owns it in the same change. This file stays what it is — the operating notes and sharp
edges — and the specs carry the full description.

## Verify before you commit

One command is the source of truth, and CI enforces the same thing on every PR:

```bash
npm run check   # format:check, lint, typecheck, typecheck:web, knip, test
```

Run it before committing. Two things about how it runs, since neither matches the `&&` chain it
used to be (`scripts/check.ts` is the runner):

- **The six stages run concurrently, and _all_ of them run even when one fails.** A chain stopped
  at the first failure, so a formatting slip hid a type error until the next run; you now get every
  failure in one pass. Output is buffered per stage and printed under its own heading — six
  concurrent writers to one terminal is unreadable — so nothing streams live except a progress line
  per stage and the timing summary at the end.
- **Every static stage is cached** (`node_modules/.cache/`, so `npm ci` invalidates it and no
  `.gitignore` entry is needed): prettier and eslint `--cache`, both typecheckers `--incremental`
  with an explicit `--tsBuildInfoFile`, knip `--cache`. A warm run is ~28s against ~64s for the old
  chain, and the whole static half now finishes inside the time the test suite takes — so the test
  suite _is_ the wall time, and the static stages are effectively free. Cold (right after
  `npm ci`) it's ~39s. If you ever need to rule the cache out, `rm -rf node_modules/.cache`.

Notable failure modes that aren't obvious:

- **knip runs with every rule at `error`** — there is no `warn` tier, so no class of dead code
  accumulates unnoticed. An `export` nothing imports, a **type** nothing names, a dependency you
  don't end up using, or a **public class member** nothing calls all turn `check` red.
  `includeEntryExports` holds test and script files to the same standard. The usual fix for a
  reported type or helper is to **drop the `export` keyword**, not delete it — a type naming an
  exported function's parameters or return value stays usable by callers unexported, and ESLint's
  `no-unused-vars` catches whatever is then genuinely dead. Class-member analysis is **name-based**,
  so a method reached only through a structural seam reads as unused; fix it by declaring the
  `implements` clause when the interface is the class's own contract (`PtySession implements
AgentSession`), or by tagging the member `@public` with a note naming the seam when the interface
  belongs to a consumer that mustn't be depended on backwards (`AgentManager.recordProgress` ←
  `AgentToolTarget`). Don't reach for an ignore list.
- **Two typecheckers**: `typecheck` (server, `tsconfig.json`) and `typecheck:web` (cockpit,
  `web/tsconfig.json`) are separate passes. A change spanning `src/` and `web/` must satisfy
  both.
- **format:check** is Prettier in check mode — run `npm run format` (or
  `npx prettier --write <files>`) to fix, don't hand-format. `test/fixtures/` is in
  `.prettierignore`: those files are **byte-exact goldens** an assertion compares against
  (`test/cockpitSkins.test.ts` vs `classic-markup.html`), so formatting one breaks a test with a
  diff that looks nothing like its cause. The `format` script's globs are `.ts`/`.tsx` only, which
  is why the ignore has to carry it — a bare `npx prettier --write test/` reaches further.

Tests are `node:test` run through `tsx` (`npm test`). `npm run smoke` is a real end-to-end
run (real `node-pty` + a git worktree); the unit/integration suite does **not** need native
processes because it injects fakes (see Testing below).

## Fresh clone

`node_modules` is not committed and **`better-sqlite3` and `node-pty` are native builds**, so
a clean checkout needs `npm ci` (or `npm install`) before anything runs — and it isn't
instant. `npm run web:build` bundles the cockpit SPA into `web/dist`, which the server serves
in production.

## Conventions

- **ESM with explicit `.js` import extensions**, even from `.ts` sources:
  `import { Store } from './store/store.js';`. New files must follow this or module resolution
  breaks. `type: "module"`, TS `nodenext`.
- **Comments explain _why_, not _what_** — match the existing terse, high-signal style. Don't
  narrate the code.
- **Typed `emit`/`on` overrides** on `EventEmitter` subclasses (see `AgentManager`) — keep
  event payloads typed at the call site when you add events.
- Domain types live in `src/types.ts`; the cockpit has its own `web/src/types.ts` (they are
  intentionally separate — the web bundle doesn't import server code).

## Where things live

- **`src/system.ts` is the composition root.** Every module is wired here through its
  interface, so any one is swappable. If you add a component, thread it through here.
- **`src/store/store.ts` is the _only_ thing that touches SQLite.** Everything else goes
  through the `Store`. Schema is `src/store/schema.ts`. Writes are synchronous
  (better-sqlite3), which keeps the harness logic race-free — lean on that. `CREATE TABLE IF
NOT EXISTS` never alters an existing table, so a **column added to an existing table** needs
  an additive `ALTER TABLE` in `Store.migrate()` (guarded by a `PRAGMA table_info` check) or it
  won't appear on databases from an older build.
- **`src/dispatcher/rules.ts`** is the RuleDispatcher's rule book as data (`DISPATCH_RULES`):
  every action the rule dispatcher emits carries a `rule` id from it, the store lifts the id
  into the `decisions.rule` column at `recordDecision` time, and `/api/state` ships the
  registry so the cockpit's Decision log can expand a row into the rule that fired. If you add
  a dispatcher branch, add its registry entry and tag the emitted actions. LLM-dispatcher
  actions carry no rule (null) by design.
- **The "Up next" queue (issue #69)** is a rank-then-slice inside `RuleDispatcher.decide`:
  agent-dispatch rules collect ordered `Candidate`s (PR concerns get a cross-PR urgency
  sort — CI > base-update > comment, then PR number), and only the final walk applies the
  headroom cut, dispatching the above-cut prefix while the whole ranked list is returned
  as `DispatchResult.upcoming` (`QueueItem[]`: `dispatching`/`waiting`/`cooldown`). If you
  add a dispatch rule, route it through the candidate list — an inline `raw.push` of a
  `dispatch_*` action would bypass both the cut and the queue. The `Harness` caches the
  last plan (`harness.upcoming`, null for the LLM dispatcher which returns none) and
  `buildStateSnapshot` ships it as `upcoming`; the cockpit's `UpNext` panel draws the
  cut-line. It's a per-pulse projection — never treat it as a persisted FIFO.
  - **Operator re-ordering (issue #128) is an override keyed on origin, not a mutation of the
    projection.** A drag on the cockpit that rewrote the shipped array would be undone by the
    next pulse a minute later, because the array is recomputed from the world every cycle. So
    what persists is a per-origin priority (`priority_overrides` table, keyed on the same stable
    origin every dispatch rule and gate already keys on), read back into the ranking as
    `DispatchContext.priorityOverrides` (wired in `harness.ts` from `store.listPriorityOverrides()`
    beside `queuedJobs`). The pure `rankByPriorityOverride` (`src/dispatcher/priorityOverride.ts`)
    re-sorts the collected `candidates` **once, just before the headroom cut**, into three tiers:
    rule-0 jobs first (a manual job is distinct work, not a re-prioritisation — an override never
    moves one), then overridden origins by ascending rank (`0` = "do this next"), then everything
    else in its natural order. It **only re-orders**: it never clears a `held` verdict, so a
    cooldown / cap / ignore tag / unapproved plan still holds an item wherever the override placed
    it — the cut loop reads `held` independently. Overriding a hold into dispatch is a different
    feature and out of scope. `QueueItem.origin` is the join the cockpit sends back through
    `POST /api/upnext/order` (replace-all: the body is the whole desired order, ranked `0..n-1`).
    An override for an origin the harness has stopped tracking is pruned by
    `Store.reconcilePriorityOverrides(trackedOrigins, upNextOverrideTtlMs)`, called each pulse from
    `harness.ts`: it refreshes `last_seen_at` for every origin still queued **or staffed** (so a
    long-running item keeps its priority) and drops any untracked longer than the TTL (default 7
    days; `0` disables). Tests: `test/priorityOverride.test.ts` (the pure ranking) and the override
    block in `test/upNext.test.ts` (persistence, restart, held-stays-held, rule-0-first, pruning).
- **Operator-launched jobs (the `jobs` table + rule 0).** A job is an ad-hoc prompt queued from
  the cockpit (`POST /api/jobs` → `Store.createJob`, status `queued`). Unlike a `Task` (created
  the instant an agent spawns), a job persists _ahead of_ dispatch so it can sit in a queue when
  the fleet is at capacity. The dispatcher pushes queued jobs (`DispatchContext.queuedJobs`, wired
  from `store.listQueuedJobs()`) onto the front of the `Candidate` list **before any world-driven
  rule** — rule `manual-job` (number `0`) — so the headroom cut dispatches them first (a manual
  request takes the next free slot); a job below the cut shows as `waiting` in the Up next queue and
  is retried next cycle. No cooldown throttle applies (a job is a one-shot request). The ClaudeDispatcher
  gets the same queue in its prompt. The emitted `dispatch_*` action carries a `jobId`, and the executor
  calls `Store.markJobDispatched(jobId, task.id)` **only after** the agent actually spawns — so a job the
  cap/pause gate holds stays `queued`. `Store.cancelJob` drops a still-queued job; a dispatched one is a
  live agent (kill it instead). The `jobs` table is a fresh `CREATE TABLE`, so no `migrate()` entry is
  needed.
  - **Rule 0 is the one dispatch path where origin and branch are not 1:1 (#116), so it is the one
    that needs the property enforced rather than merely observed.** `job.branch` is a free string the
    operator supplies while the origin is `job:<id>` — unique by construction — so `activeOrigins`
    and `findActiveTaskByOrigin`, which gate the branch for free everywhere else, are both blind to
    it. `WorktreeManager.ensure` being reuse-first makes the failure silent rather than loud: two
    live agents land in **one worktree directory**, editing the same files with no merge anywhere to
    reconcile them. Closed with one predicate, `Store.findActiveTaskByBranch` (the mirror of the
    origin one), asked in two places: `ActionExecutor` **defers** a `dispatch_code_agent` whose
    branch a live task holds, and `POST /api/jobs` **409s** a colliding branch at queue time. Two
    call sites, one predicate — that is what keeps them from disagreeing; they differ only in _when_,
    which is why the earlier one refuses (nothing has been promised yet) and the later one defers (a
    queued job the operator is entitled to have retried when the branch frees). **Deferred, not
    skipped**: `skipped` is the origin gate's word for "already being done", whereas a colliding job
    is distinct work naming a busy branch, and every active task ends. The executor is the site
    because every dispatch passes it, the LLM dispatcher's prose-named branches included. It is a
    **no-op for every world-driven rule** — that is the point, and `test/jobQueue.test.ts` asserts it
    (a broad world, then: the gate never fired, yet no two live tasks share a branch), so a later
    rule that broke the 1:1 property fails a test instead of quietly sharing a checkout.
  - **A code blueprint files a ticket instead of dispatching (#198), entirely at route time — rule 0 is
    untouched.** An operator-injected **code** job is a _blueprint_, and when a tracker is configured
    (`trackerCoordinates(config) !== null`) `POST /api/jobs` does not queue a code job on the raw prompt:
    it renders the overridable `blueprint-ticket` template (pure fields from `blueprintTicketFields`,
    `src/blueprintTicket.ts`) into a **desk** ticket-filing job so the work enters the planning funnel
    (assay → plan → parts → work) like a picked-up issue — the prompt arm of the workflow's
    find-or-create-a-ticket convergence. Keeping the transform at the route is the clean recursion
    boundary: the desk filing job it becomes is never itself a code blueprint. Two things carry it. **The
    ticket must be `-watch`-tagged** (unlike a finding-filed ticket, which lands unwatched on purpose —
    it is deferred, not scheduled): the prompt instructs the agent to add `${labelPrefix}-watch`, and the
    empty-prefix case (watch gate off, act on all) is decided in the pure fields so no `''` label is ever
    instructed. **`link_ticket` resolves via a reused `WorkItemFiling`** keyed on the desk job's own ref
    (`targetRef: job:<id>`) — a blueprint files _for_ no prior work node, and reuse is safe because no
    reader misreads it (the unrecorded-work lens is code-kind only; the fold stands the issue node up and
    hangs the desk job under it). **Fallbacks are today's behaviour**: a desk blueprint, and a code
    blueprint with no tracker, both dispatch directly, and the branch-collision 409 applies only on that
    arm. Tests: `test/blueprintTicket.test.ts`.
  - Tests: `test/jobQueue.test.ts`.
- **Human decisions (`src/proposals/`, the `proposals` table, issue #109 phase 1).** "Something
  proposes an act; a human accepts or rejects it; the accepted act happens" occurred three times
  in the harness, and in the most common one — a `merge_pr` the auto-send gate refuses, which is
  the **default** path — the accept was wired to nothing: `EscalationInbox.answer` recorded
  `routing: 'queued_for_dispatch'` and no consumer existed, so an approval had nowhere to land and
  you merged the PR by hand. A `Proposal` is the object that was missing in the middle. What
  carries it:
  - **A typed verdict is the only genuinely new thing.** An `Escalation` can record that a human
    _typed something_; only `pending → accepted | rejected` lets the harness branch. The escalation
    stays the inbox item and the routing mechanism — `typed_into_agent` is still right for a plain
    question, and a question has no proposal at all. A proposal **hangs off** an escalation
    (`escalation_id`); deciding answers that escalation with the verdict, so "Needs you" empties on
    the click. `POST /api/escalations/:id/answer` **409s** while a pending proposal hangs off it:
    free text can't be branched on, and answering would settle the inbox item while leaving the
    proposal pending — which holds the rule that made it off that PR for good.
  - **A fresh table, not columns on `escalations`.** Not only to dodge the `ALTER TABLE`: an
    escalation is answered once and done, whereas a proposal carries a verdict a rule re-reads every
    pulse and a `ref` the gate keys on. Widening would have given every existing question five
    permanently-null columns and no way to tell "not a proposal" from "not yet decided". The name
    avoids the `decisions` audit table and the `Decision` type in `src/types.ts`.
  - **`pending` is a gate, and so is `rejected`.** `proposalHold(kind, ref, proposals, ctx)` (pure,
    `proposals.ts`) reads the _standing_ verdict for an act and holds on both — pending because
    re-asking is the duplicate that filled the inbox, **rejected because a "no" that expires next
    pulse means "not this second"**, which is worse than not asking (the operator can't make the
    question stop except by doing the act by hand). Phase 4 ends that hold on world signal rather
    than on a timer — see its bullet below. `accepted` holds for a
    **bounded settle window** (`SETTLE_WINDOW_MS`, deliberately the same 15 min as
    `DEFAULT_COOLDOWN` — it is the same statement, "already attempted recently") and then stops:
    long enough that a successful act is not re-proposed while the world catches up, short enough
    that a _failed_ one still is. That window is phase 2's doing and is the one behaviour the fold
    cost — see the phase 2 entry below. Asked in **two places off one predicate** (the jobs
    409/defer pattern):
    rule 3 suppresses itself, and the executor refuses a duplicate whatever produced it — the LLM
    dispatcher's `reply_on_pr` included, since prose-driven actions can't be gated rule-side. The
    dispatcher reads it from `DispatchContext.proposals`, wired in `harness.ts` from
    `store.listProposals()` beside `recentDecisions`/`queuedJobs`. That list is **unbounded** on
    purpose: a rejection that aged out of a window would quietly re-propose a refused act — which is
    also why phase 4's event read is bounded by _time and item_ rather than by row count.
  - **Accept executes inline, through `ActionExecutor.runAuthorized` — not via a next-pulse action.**
    The action is already formed and validated on the row, so emitting one for the next cycle to run
    would only re-emit what the proposal holds, at the cost of a pulse of latency _and_ an
    "accepted but not yet run" state needing its own one-way transition. One transition is the
    point. It stays in the executor rather than the route so `ActionSink` keeps a single caller and
    the outcome lands in the decision log like every other outcome — audited under cycle id
    `human:<proposal id>`, the way `agent-lifecycle` already marks a decision made outside the pulse,
    which is also how the cockpit's Decision log finds its human column with no new column on
    `decisions`.
  - **Idempotence is a property of the write**: `Store.decideProposal` updates
    `WHERE id=? AND status='pending'` and returns null when no row changed, so accepting twice
    merges once without anyone remembering to check first. A send that **fails** mirrors the
    auto-send fallback exactly (`autoSendFailed`/`autoMergeFailed` context + a fresh escalation)
    rather than inventing a second one; the proposal stays `accepted` (you did accept) and the
    now-unheld gate lets the next pulse re-propose if the world still warrants it.
  - **Phase 2 — `autoSend` is a decider, not a parallel system.** The gate answered "may this act go
    out?" from a confidence threshold and an allow-list: the same question a human answers by
    clicking accept, reached a second way, sharing no representation with it. And when it _passed_,
    the executor called the sink itself, so phase 1's "the `ActionSink` keeps one caller" had two
    callers again. Both now converge on `ActionExecutor.authorize`, the one place an outbound act is
    authorized — it hold-checks, asks the gate, and on a yes **writes the proposal and immediately
    settles it** `accepted` / `decidedBy: 'auto_send'` (two store calls, through the same one-way
    `decideProposal` a click uses), then performs it via `runAuthorized`. `reply_on_pr` and
    `merge_pr` differ only in `kind`/`ref`/escalation payload, so they are one path now, not two
    mirrored ones. Four things carry it:
  - **The gate decides only in the affirmative.** `autoSendVerdict` returns `authorized` plus the
    note that becomes the decider's reason on the row (`confidence 0.90 ≥ 0.85 threshold`, which
    `runAuthorized` then quotes verbatim), or `blockedBy` plus the reason the escalation quotes. It
    never returns a **rejection**: rejection is durable, so a machine "no" would suppress the human
    ask for good — blocked means "not mine to authorize", which is what a pending proposal already
    says. Order matters equally: the **hold is asked before the gate**, so a standing verdict
    governs regardless of which decider would answer next.
  - **The decider → cycle id → badge chain is decided once**, in the pure `authorityOf`, which takes
    the proposal plus the pulse's cycle id and returns the `{cycleId, by, approved}` triple: where
    the audit row groups, how the authority reads in the line, how the failure escalation opens its
    sentence. A human
    accept is outside the pulse (`human:<proposal id>`); auto-send accepts _inside_ a cycle and
    keeps that cycle's id, so its row stays grouped with the pulse that produced the action **and
    cannot carry the `human:` prefix** that `DecisionLog.tsx` badges "you · accepted" off. One
    function, not three string checks that can drift. The cockpit deliberately leaves an auto-sent
    row unbadged — that is the harness acting on its own, the already-unlabelled case — with the
    authority named in the detail line instead.
  - **Accepted had to start holding something** (the settle window above). Holding nothing was right
    while only a click could accept: the sole thing an un-held ref could cause was re-proposing an
    act whose send _failed_, which is exactly what should happen. Auto-send accepts on the pulse,
    and a merge that succeeded is still an open PR in the snapshot until the next fetch, so an
    un-held ref would write a fresh accepted row **every pulse** into a list the gate itself re-reads
    unbounded. Not a cost worth paying for the failure path — so the failure path gets a bounded
    window rather than nothing, and a failed act still escalates the instant it fails, so nobody is
    waiting on the gate to find out.
  - **The operator-facing string is chosen, not inherited.** `decidedByLabel` renders `human` as
    **you** and `auto_send` as **auto-send** everywhere: the audit line ("authorized by auto-send
    (confidence 0.90 ≥ 0.85 threshold)"), the hold reason, and the failure prompt ("Auto-send
    authorized merging PR #42, but the merge failed"). The old wording ("Auto-sent reply on PR #42",
    "Auto-merged PR #42 via squash") is gone _because_ the paths converged; the behaviours those
    lines guarded are unchanged and still asserted. One outcome changed honestly: a failed
    auto-send audits as `rejected` now, not `executed` — the act did not go out — with the same
    `autoSendFailed`/`autoMergeFailed` escalation as before.
  - `autoSend` stays **off by default** and phase 2 changes nothing about _what_ it may do, so the
    README's safety guarantee holds literally. Tests:
    `test/proposals.test.ts`, `test/autoSend.test.ts`.
  - **Phase 3 — `planning.requireApproval`, the one proposal with no act.** The planning funnel
    had the same shape and no gate: a `parts` verdict is a proposal in every meaningful sense
    (_decompose this issue into five stacked PRs, on five branches, with agents_), `ingestPlanDocument`
    committed it unconditionally, and rule 4a started dispatching — we built the undo (`replan`)
    instead of the gate. Five decisions carry it, and each is the point where the phase-1/2
    machinery does **not** fit unchanged:
  - **Release is the plan's status, not a verdict lookup.** `amendedPlanStatus` takes
    `requireApproval` and persists a `parts` verdict as **`awaiting_approval`** instead of `active`;
    accepting moves it to `active` and that is the entire effect, because `awaiting_approval` was
    only ever `active` with the gate closed. So rule 4a's question — "is this plan released" — is
    the `plan.status !== 'active'` check it already had, and the old verdict structurally cannot
    release a new one: a replan resets the row. The alternative (rule 4a joining on an accepted
    proposal) needs a "is this proposal for the plan's _current_ verdict" predicate, and the only
    honest key for that is a timestamp against `plan.updatedAt`, which the reconciler moves.
  - **`proposalHold` has the wrong polarity, in both directions**, so plan proposals get
    `planProposalHold` beside it (holds on `pending` only, and the doc comment there is the
    argument). `proposalHold` holds on all three statuses because a merge is proposed off world
    state that _persists_; a plan proposal is made once per **verdict**, and both verdicts rewrite
    the row the gate reads. `rejected` holding would let one "no" veto every future decomposition
    (the plan is only re-askable via a replan the operator asked for); `accepted` expiring after
    `SETTLE_WINDOW_MS` would re-propose a decomposition whose agents are already running. Phase 4's
    signal expiry therefore **stops here too**, and could not have been inherited: it ends a
    _rejected_ hold, which this predicate never applies (the signature takes no signals at all). It
    would read the wrong thing anyway — the transitions on `issue:<n>` are its comments and links,
    none of which say whether a decomposition is the right _shape_, while the row that **is** that
    verdict is rewritten by both settlements. `test/planApproval.test.ts` asserts the polarity in
    both predicates rather than trusting them to stay apart.
  - **Rejection has an effect of its own, because a bare "no" parks the issue.** Once the funnel
    is on, a plan is the only thing that schedules anything for a decomposed issue — rule 3b parks
    the work item in the review state for the life of the plan, and `resolvePlanRoute` fails a spent
    replan back to `parts`, never open to `single`. So `refusePlan` (`plans/planApproval.ts`)
    retires every part `partHasWork` says nothing was started for and then takes whatever
    `amendedPlanStatus('single', …)` makes of the survivors: `single`, so rule 4 works the issue as
    one PR (the arm the funnel already fails open to), or `active` when parts are genuinely in
    flight — that case is a _replan_ being refused, and the amendment's new parts are the ones
    retired. Both arms reuse the two predicates that already decide what an amendment may do; the
    "different split" case is Replan, which is reachable from the same panel.
  - **Born in the executor like every other proposal**, from a new validated action `propose_plan`
    (rule `plan-approval`, 3d) — not at ingestion, which would have to thread an `EscalationInbox`
    into `AgentManager` (constructed _before_ the inbox, which takes the fleet) and into the MCP
    tool deps. Exactly-once falls out of the two gates rather than being asserted: the rule fires
    only on `awaiting_approval`, and a pending proposal holds it. Accepting runs through
    `ActionExecutor.runAuthorized` and `readProposedAct` learns a third `ProposedAct` — the plan act
    is checked _before_ the PR number, or an approved decomposition audits as "names no PR number".
    What matters about `runAuthorized` is that it is the one place an accepted proposal becomes its
    effect **and its audit row**; the sink is only what two of its three acts happen to need.
  - **`requireApproval: false` writes no proposal at all.** Phase 2's "one representation" argument
    cuts the other way here: auto-send is a _decider_ answering the same question a human answers,
    so folding it in removed a parallel system. Nobody is asked about an ungated plan, and a plan
    carries no `confidence` for anyone to decide on — a row per plan recording "not asked" is a
    parallel _record_, not a shared one. `test/planPart.test.ts` asserts the default writes nothing.
  - Consequences worth knowing: `POST /api/plans/:id/replan` **withdraws** a pending plan proposal
    (a pending verdict would hold rule 3d off the amended plan, and the stale card would release a
    decomposition its reader never saw) — routed through the ordinary `ProposalDesk.reject`, which
    is safe precisely because the status write above already moved the plan, so `refusePlan`
    no-ops. The reconciler **does** run for `awaiting_approval` plans (readiness is what makes the
    held parts visible) but does **not** write the tracker status comment for one — an unapproved
    decomposition announces nothing, and a refusal would otherwise leave that announcement
    standing. `QueueItem.status` gained **`unapproved`** for the same reason `capped` exists.
    Tests: `test/planApproval.test.ts`.
  - **Phase 4 — a rejection expires on signal, and its reason reaches an agent.** Phases 1–3 made a
    "no" durable _forever_, deliberately and with a stated reason. That is the safe direction and not
    the right one: **the world moves and the verdict doesn't**, so a merge refused because the PR
    needed one more commit is still held off it after the commit lands, CI goes green and a second
    reviewer approves — and the only way to make the harness act is to merge it yourself, which is
    #109's opening inert-approval failure mirrored. Two things, both off the existing record:
  - **What ends a "no" is the world, and nothing else.** `proposalHold` gained a `ctx`
    (`{now, rejectionSignals}`) and its `rejected` arm now returns null once any `WorldEvent` for the
    proposal's world item is stamped strictly after `decidedAt`. Three choices carry it. **Any
    transition, not a per-kind list** — the rules that would re-propose re-evaluate on exactly these
    events, so a filter here is a _second_ opinion about which changes matter, sitting nowhere near
    the rule it second-guesses. **No timer arm at all**, even though the issue says "cooldown": a
    time-only expiry re-asks a question the world hasn't changed its answer to, which is "not this
    second" under a longer name, and if both existed signal would dominate, leaving the timer able
    only to _delay_ an expiry the signal already granted. (The asymmetry with `accepted`'s
    `SETTLE_WINDOW_MS` is the point: an accepted act waits on the world to _reflect_ something done,
    which is a duration; a rejected one waits on it to _become_ something else, which is an event.)
    And it **cannot flood** — expiring only un-holds the rule, whose own preconditions still decide
    (the commonest signal on a refused PR, a new comment, un-holds rule 3 and then fails its
    merge-readiness test), and the fresh pending proposal re-holds the ref, so the act is re-proposed
    **once**, not once per pulse. `reaskContext` prefixes the re-ask with the refusal, its note and
    the transition that ended it, or a second ask reads as the harness having forgotten the first.
  - **The two records don't agree on ref shape, so one predicate owns the join.** A proposal names an
    _act_ (`pr:42:merge`, `pr:42:comment:c_7`), a world event names an _object_ (`pr:42`).
    `proposalWorldRef` maps one to the other and is **not exported**: it is used to _match_ events
    and to _ask_ for them, and those two answering differently is the bug class fixed twice already.
    The ask is `rejectionSignalQuery(proposals)` → `Store.listWorldEventsSince(since, refs)`, bounded
    by **time and item** rather than row count — `listWorldEvents`' 200-row limit serves a feed, but a
    rejection is unbounded in age, so a count-bounded read would judge an old one against events it
    cannot see. Naming the window removes the case instead of answering it, and the read stays small
    (the handful of items actually carrying a rejection, over the `world_events(created_at)` index);
    nothing standing means no query and no read at all. Wired in `harness.ts` as
    `DispatchContext.rejectionSignals` and re-asked in the executor off the same predicate — a hold
    the two disagreed about would have the rule dispatch a merge the executor then skips.
  - **The note lands in `materializeTask`, on an exact ref match.** A rejected `reply_draft`'s ref
    _is_ rule 2b's dispatch origin, so "what did the human say about this exact thing" is a lookup;
    widening to the world item would put a refusal to _merge_ in front of an agent fixing CI, so a
    rejected merge deliberately reaches no agent. It is in the **executor** for the branch gate's
    reason (every dispatch passes), which is load-bearing here rather than tidy: a `reply_draft` is
    only ever proposed off the LLM dispatcher's `reply_on_pr`, so a rule-dispatcher-side hook would
    miss the one path that produces rejected replies. It is **appended** to the rendered prompt, not
    filled into it — templates are operator-overridable and `loadPromptTemplates` only rejects
    _unknown_ placeholders, so an override omitting a new `{rejection}` token would silently drop a
    human's words on exactly the deployments that customised most. Appending has no fallback to get
    wrong. The note is **attributed and quoted** (an agent will act on it, and must not read it as
    the harness's own instruction), and an **empty note appends nothing**.
  - Out of scope and stated so: `last_actor`/`prAttentionStatus`, any new outbound capability, any
    change to what `autoSend` may authorize, any new proposal kind. `autoSendVerdict` still has no
    rejecting arm — a blocked gate is a _pending_ proposal, never a "no" — and phase 4 must not make
    it cheaper to treat one as the other; `test/autoSend.test.ts` asserts a pending ask is untouched
    by world signal. Tests: `test/proposals.test.ts`, `test/autoSend.test.ts`,
    `test/planApproval.test.ts`.
- **Concluding an issue (`src/issueConclusion.ts`, the `conclude_work` tool).** A work item parked in
  `issueInReviewState` is ambiguous — it sits there when work remains **and** when everything is
  delivered and it is waiting on test — and nothing outside the harness distinguishes the two. Rule 3b's
  inverse arm used to release on the _absence of an open PR_, but `openPrForIssue` reads only the open
  list, so "the PR merged" and "there was never a PR" are one observation: a merged PR bounced its ticket
  back to `Ready` and rule 4 put a fresh agent on work already on the default branch. What carries the fix:
  - **The verdict is asked of whoever owns the whole issue**, which generalises what the decomposed path
    already did rather than adding a parallel notion. `partsPlanFor` counts a `complete` plan as still
    owning its issue precisely so it never bounces back, and `planComment` already tells the operator that
    closing it is theirs. So: a plan **derives** the verdict from its roll-up; an unplanned issue's one
    agent **declares** it. A part agent is never asked — `conclusionOrigin` **refuses** it (as it refuses
    the planner, PR-concern and job origins), which is the structural half of "done means the issue is
    finished, not my slice". Refusing beats silently scoping: an agent handed `{ok: true}` would believe
    it had concluded the issue. `resolveIssueConclusion(stored, plan)` folds it, operator toggle first
    (the escape hatch — the only thing that may contradict a roll-up), then the agent, then the plan.
  - **`undeclared` is a third answer and the whole point.** It is never stored — it is what a missing row
    resolves to — and rule 3b acts _only_ on an explicit `more_work`. Folding it into `more_work` would
    restore the bug for every agent that forgets to declare, i.e. make the fix contingent on model
    diligence; the failure this direction causes instead is a ticket sitting still with a visible marker,
    which is the cheaper and the visible mistake. Same asymmetry as `@@LUBBDUBB_DONE@@` against the
    `result` event. A `single` plan derives **nothing**: that verdict is about delivery _shape_, not
    whether the PR was written.
  - **Nothing gates pickup on it** — `issuePickupStatus` reports it, rule 3b is the only consumer that
    acts. A pickup gate would make `done` silently veto an item the operator had deliberately moved back
    to a pickup state, and would then need signal-based expiry (the phase-4 rejection pattern) to stay
    honest. The work-item state stays the source of truth for pickup, so **moving the ticket in the
    tracker _is_ the override** and no expiry logic exists. Consequence, stated: on GitHub/fake there is
    no review state, so a conclusion is recorded and shown but changes no dispatch.
  - **A fresh `issue_conclusions` table** keyed on the `issue:<n>` origin (no `migrate()` entry), _not_
    columns on the agent row the way `note_progress` is: a conclusion belongs to the **issue** and must
    outlive every agent that touched it, including across a replan, which rewrites the plan row. Clearing
    is a delete, so `undeclared` has exactly one representation. An agent's `more_work` note is
    **appended** to the next dispatched agent's prompt for that issue (`outstandingWorkNote`, attributed
    and quoted) — appended, not filled into a placeholder, for the reason the rejection note is. The loop
    is bounded by the existing `dispatchVerdict` attempt cap on `issue:<n>`; nothing new was added.
    Tests: `test/issueConclusion.test.ts`, and the `return-from-review` block in `test/ruleDispatcher.test.ts`.
  - **A plan in flight outranks a declaration, because ownership does.** The doctrine — _the verdict is
    asked of whoever owns the whole issue_ — was enforced by making the two arms unreachable together:
    `conclusionOrigin` refuses the part agent, the planner and the assessor, so a decomposed issue had
    no declaration to rank and the arm order never had to decide anything. **A replan is the one path
    that breaks it.** Worked `single` → one agent declares `done` → an accepted shortfall flips the plan
    to `planning`; both records now exist, and with the declaration first a spent verdict outranked the
    plan that had just taken the issue back. So `planInFlightVerdict` (`planning` | `active` |
    `awaiting_approval` → more work) sits **above** the stored arm and a `complete` plan stays **below**
    it — an agent saying work remains on an issue whose parts all merged is telling the roll-up
    something it cannot see, and more work is the safe direction. `planning` reads as in flight where it
    used to say nothing: both ways to reach it are unsettled decompositions, and an operator who
    replanned by mistake has arm 1. Two readers were skipping arms and are fixed with it — rule 3b
    passed no shortfall at all, so the assessor's verdict read as the working agent's, against
    `shortfallRecordedNote`'s own promise that the issue "comes back round for pickup"; and the Goal
    Floor's completion record, below.
- **Keeping a finished goal on the floor (`src/floor/completions.ts`, `floor_completions`, #203).**
  `isGoalComplete` folds two kinds of input and the rule between them is **evidence adds; a standing
  verdict subtracts**. A retrospective and a delivery-ever are _evidence_ — each says the goal was
  reached at least once, and they are why the resolver alone is not enough (a finished goal nobody
  declared resolves to `undeclared`). The conclusion and the plan are **not** two more raw signals: they
  are asked through `resolveIssueConclusion`, and a resolved `more_work` outranks all the evidence,
  because the operator, the assessor, the working agent or a plan being re-drawn is saying _now_ that
  work remains. Reading them raw was one defect with two faces — an operator's `more_work` toggle argued
  with by a `complete` plan (the contradiction arm 1 exists to forbid), and a standing shortfall not
  consulted at all, so an assessor's "nothing was delivered" lost to the stale `done` of the agent it
  was assessing. **The gate is on minting, never on keeping**: nothing deletes a row,
  `recordFloorCompletion` is upsert-only and never resurrects a dismissal, and a genuinely finished goal
  resolves to `done` or `undeclared` — never `more_work` — so it cannot fall off the floor on its own.
  Tests: `test/floorCompletions.test.ts`.
- **The planning funnel (`src/plans/`, stage 2 of the multi-PR design).** `planning.enabled`
  (config, **on by default**) puts a planning agent in front of issue pickup. Rule `issue-plan`
  (3c, `ruleDispatcher.ts`) dispatches a **code** agent — it needs a worktree to read the repo —
  on branch **`plan/issue/<n>`**, origin `issue:<n>:plan`. That branch namespace is not
  cosmetic: git stores refs as files, so `refs/heads/issue/12` and `refs/heads/issue/12/plan`
  cannot coexist, and `issue/<n>` is exactly what a `single` verdict's pickup agent will want.
  The planner submits its verdict through the `plan_submit` MCP tool (preferred — synchronous
  validation) _or_ by writing `.lubbdubb/plan.json`, which stays fully wired as the fallback: both
  converge on `ingestPlanDocument` (see "The MCP tool channel" below). On the file path,
  `AgentManager.ingestFileEvent` recognises the reserved path off the **file-events hook**,
  zod-validates it (`src/plans/planDocument.ts`) and persists it via
  `Store.upsertPlan`/`upsertPlanParts`. The read must happen **inside the drain**
  — `src/system.ts` removes a done agent's worktree on the reap, so a later read finds nothing.
  Ingestion is confined to planner origins (`planOriginIssue`): an ordinary pickup agent's
  `plan.json` is ignored, since flipping its own issue to `parts` would strand it while nothing
  schedules parts. `resolvePlanRoute` (`src/plans/planning.ts`, pure) is the one place the arm of
  the funnel is decided — `single` / `parts` / `awaiting_approval` / `planning` — and both the
  dispatcher (rules 3c + 4) and `issuePickupStatus` read it, so the cockpit chip can never disagree
  with what fires. (`awaiting_approval` is `planning.requireApproval`'s arm — see the phase 3
  bullet under "Human decisions" for why the gate is a plan status rather than a proposal lookup.
  It behaves as `parts` for pickup, which is the point: the issue is planned either way.) Two
  properties to preserve: the verdict is persisted for **both** outcomes (without a `single` row
  the planner re-runs every cycle), and a planner that spends its `dispatchVerdict` attempt cap
  **fails open** to `single` with no escalation — narrowing rule 4 without that turns any planner
  crash into a permanently parked issue.
  `plans`/`plan_parts` were fresh `CREATE TABLE`s when introduced, so they needed no `migrate()`
  entry — but columns added to them **since** do, and have them (`risks`/`out_of_scope`/`document`/
  `discussing`, `rationale`/`acceptance`). `CREATE TABLE IF NOT EXISTS` never alters an existing
  table, so a column without an `ensureColumns` entry is invisible on every older database.
  `.lubbdubb/` is gitignored, so the graph genuinely lives only in the store.
  Tests: `test/issuePlan.test.ts`, `test/planIngestion.test.ts`.
  - **Approval on by default, a plan modal, and discussing a plan.**
    `planning.requireApproval` now defaults `true` (only matters once `planning.enabled` is), and a
    plan gained five optional narrative fields (`risks`, `outOfScope`, `document` at plan level;
    `rationale`, `acceptance` per part) that `upsertPlan` preserves on absence rather than clearing.
    A shared `PlanModal`, opened via `viewPlan` on `CockpitActions`, renders the whole decomposition
    plus the markdown write-up from anywhere the plan is mentioned. **Every entry point is keyed on
    the plan existing, never on what it is doing** — two were not, and between them the modal was
    reachable only while the decomposition was `awaiting_approval`: the Goal Floor's controls rode on
    the Blueprint _plate_ (a plate is a stopped machine's reason, and that one draws for that status
    alone), so approving a plan removed the only way to read it back, and `WorldSummary` made the
    _pickup chip_ the button, which is null for `done`/`has_pr` — where an issue sits once its parts
    have PRs. The floor's controls now hang off `GoalFloorModel.planId` (declared for this and never
    wired; `FloorPlate.planId` is gone, so there is one way in rather than a second answer about when
    it may be offered) and the plan has its own `plan · <status>` chip on the issue row. `POST /api/plans/:id/discuss` /
    `.../discuss/end` let an operator talk to the planner before deciding — a replan with a
    conversational prompt (`discuss-plan`), inheriting rule 3c's origin gate, cooldown, attempt cap
    and fail-open rather than earning new ones. See [08](docs/spec/08-planning.md) and
    [17](docs/spec/17-cockpit.md).
- **Plan parts (stage 3 of the multi-PR design).** What makes a `parts` verdict mean something.
  Scheduling is pure in `src/plans/parts.ts` (origin `issue:<n>:part:<slug>`, branch
  `issue/<n>/<slug>`, dependency depth, base selection, the sibling context the prompt carries),
  and rule `plan-part` (4a) walks it. Things to preserve:
  - **Parts are not driven off `eligibleIssues`.** That list gates on the issue having no open
    PR, and a part's PR is exactly what makes the parent look taken (`linkedPrNumber` is sticky
    and _will_ point at one). Rule 4a reads `ctx.plans`/`ctx.planParts` directly and applies only
    `issueWatchGateReason` — the watch/ignore tag, evaluated once on the parent. Not the
    workflow-state gate: rule 3b parks a decomposed work item in the review state for the life of
    the plan (and suppresses its own inverse there), so re-applying the state gate would stop the
    remaining parts ever being scheduled. `issuePickupStatus` answers the `parts` arm **before**
    the open-PR gate for the same reason, reporting `2/5 parts merged`.
  - **A part may declare any number of dependencies, and the arity rule lives in the reconciler
    (#170).** It used to be capped at one in the zod boundary, as the static form of "at most one
    _open_ dependency" — but that cap refused something safe. `PlanReconciler.readiness` now holds a
    part `pending` unless every dependency is satisfied **and at most one is still unsettled**, which
    is the same rule where "open" can actually be observed. So a **rejoin** works: a part naming two
    prerequisites waits for both to settle and then bases on the default branch, because by then
    nothing is open to stack on. A chain is untouched (one dependency → stacks on its branch as soon
    as it has _pushed_), and only an unsettled dependency costs a `hasCommitsBeyond`, so the git cost
    is unchanged. Two things this dragged in: `partDepth` is **longest path**, or a rejoin sorts ahead
    of what it waits on, and `findDependencyCycle` walks **every** edge — a chain walk was the whole
    graph while arity was one, and misses `a → [x, b]`, `b → [a]` the moment it isn't.
  - **Base selection rides on the action.** `dispatch_code_agent` carries `base` + `partId`; the
    executor passes `base` to `WorktreeManager.ensure` and calls `Store.markPartDispatched` only
    _after_ the spawn (same rule as `jobId` — a held dispatch must leave the part `ready`).
  - **The merge gate came forward from stage 4** with this, because this is the first point at
    which stacked PRs exist: `isStackedPr` (beside `prHealth`) holds rule 3 off any PR whose base
    isn't `defaultBranch`, or a green part 2 merges into part 1's branch mid-review.
  - `maxConcurrentPartsPerIssue` counts **live tasks** on part origins, not the `dispatched`
    status, and a `hold` verdict never eats a slot — one stuck part must not stall a plan.
  - **Rule 4a also walks an `awaiting_approval` plan, and dispatches nothing from it** — every
    ready part is queued `held: 'unapproved'`, with the cooldown/attempt-cap arms skipped entirely
    (they would answer "why did this part not get an agent" with the wrong reason). Skipping the
    plan outright is the tempting version and the wrong one: an unapproved decomposition would
    look exactly like an idle fleet, which is the invisibility `capped` was named to fix.
  - **A part can finish without a pull request (#160).** `merged` was the only status meaning "this
    work finished", so a part whose honest answer was _"nothing to build — #98 already fixed this"_
    had nowhere to go: it stayed `dispatched`, `liveParts` never emptied, the roll-up never reached
    `complete`, and rule 3b parked its issue for the life of the plan. **One** new terminal,
    `concluded`, covers the two outcomes that aren't a merge (`report`, `determination`), carried by
    four additive `plan_parts` columns — so they need an `ensureColumns('plan_parts', …)` entry, and
    have one. `merged` is untouched, which is what keeps the whole PR-observation path free of a new
    arm; instead every `=== 'merged'` that meant _reached its terminal_ now asks the pure
    `partSettled`, so those sites can't drift into disagreeing about what done is. `code` is
    **derived** from `merged` by `partOutcomeKind` and never stored — storing it would put a second
    answer inside `observePartPr`'s path. Things to preserve:
    - **The agent declares it; the reconciler does not derive it.** Deriving from an artifact or a
      finding on the part's origin would infer a positive terminal from incidental output — the thing
      refused everywhere else (`undeclared` vs `more_work`, the DONE sentinel vs the `result` event) —
      and a code part that wrote a design note then died before its PR would close as a report,
      silently completing a plan on work that never happened. Declaration's failure mode is cheaper by
      a lot, and only because `foldStalled` already exists: a forgotten call returns the part to
      `ready`, re-dispatches, and escalates on the attempt cap — a visible loop ending at a human.
    - **`conclude_part` refuses `kind: 'code'`, with the reason given.** A merge is observed; letting
      an agent declare one would be the false terminal arriving through the front door.
    - **The reconciler skips a `concluded` part**, and this is the one place its fold genuinely
      differs by kind: a report and a determination have **no outside world** to be the source of
      truth, so the only thing the fold could do is undo them.
    - **`partBase` returns the default branch for a `concluded` dependency** — a real bug if missed,
      not tidying: such a part may never have pushed, and `WorktreeManager.ensure` throws on an
      unresolvable base rather than picking an incidental one. `basePrOf`/`isStackedPr` are reached
      only via a `pr_number` and degrade with no guard (asserted, not assumed).
    - **`concluded` is not a kind of `retired`.** Retired means "dropped before anything was started"
      (`partHasWork` enforces it); a concluded part did the work and found nothing to build.
    - **Dispatch is unchanged** — a report part still gets a code agent, worktree and branch, so
      origin/branch stays 1:1. `partOutcomeNote` is **appended** to the rendered prompt, never
      interpolated, for the reason the rejection and outstanding-work notes are.
      Tests: `test/planPart.test.ts`, `test/planApproval.test.ts`, `test/planReconcile.test.ts`.
- **Stack safety (stage 4 — the last one).** Three things, all in `test/stackedPrs.test.ts`.
  - **CI attribution.** A stacked PR's CI runs the commits of the PR beneath it, so one red base
    turns the whole stack red and rule 1 would put an agent on each of them to fix code that isn't
    theirs. `inheritedCiFailure(pr, openPrs)` (beside `prHealth`, pure) walks down the base chain
    and names the failing ancestor; the CI concern is skipped when it returns one. **Suppress-only —
    the concern is not pushed down**: the bottom PR is in the same world and rule 1 fires on it
    unaided, so pushing would only duplicate it (and land on the `respond_to_agent` path if that
    branch is staffed). The base PR is found from the **world** (`pr.baseBranch` matching another
    open PR's `branch`), never from the plan graph — CI attribution is a PR-level fact and this way
    it covers hand-made stacks too. Two properties to keep: **only the CI concern is suppressed**
    (rule 2 must still fire or a stack stops restacking the moment its parent goes red), and the
    predicate reads `openPrs` — the dispatch world **plus `ctx.excludedPrs`** — so an `-ignore`d
    base still attributes. `prHealth(pr, openPrs?)` takes the same list and renders
    `CI failing on base PR #n`, which is the only place an operator sees why no agent came.
  - **The cockpit plan panel.** `/api/state` ships `plans` + `planParts` (the same rows
    `issuePickupStatus` reads, hoisted to locals so the chip and the panel can't disagree);
    `web/src/components/PlanPanel.tsx` draws each plan's parts as a stack and joins them to
    `upcoming` **by origin** (`issue:<n>:part:<slug>`) for the dispatch cut. `QueueItem.status`
    gained **`capped`**: rule 4a used to `break` out of the loop at `maxConcurrentPartsPerIssue`,
    which made the limit invisible, and now queues the rest as held instead. `Candidate.cooldown`
    became `Candidate.held: 'cooldown' | 'capped'` — a held candidate is never dispatched whatever
    the headroom.
  - **Replan** (`POST /api/plans/:id/replan`). Only flips the plan row to `planning`; rule 3c
    already routes that back to a planner, now with the `issue-replan` prompt carrying
    `currentPlanSummary`. Three things make it work rather than merely fire: `plannerVerdict`
    (`planning.ts`) narrows the cooldown window to decisions **since `plan.updatedAt`**, so the
    original planner's attempt doesn't throttle the replan for 15 minutes (`planning` is only ever
    reached by a replan, so a first-time planner keeps the full throttle); `resolvePlanRoute` takes
    `existingParts` and fails a spent replan back to **`parts`**, not open to `single`, which would
    point rule 4 at the flat `issue/<n>` branch git can't create beside the part refs; and
    ingestion (`AgentManager.ingestPlan`) does the amendment — `partsToRetire` retires parts the
    new document drops **only when nothing was started for them** (`partHasWork`), and
    `amendedPlanStatus` refuses to collapse to `single` while any part has a branch or PR, recording
    an error rather than overriding the planner silently. `retired` is a new `PlanPartStatus`;
    everything that counts parts goes through `liveParts` (progress, roll-up, sibling context,
    rule 4a), and the reconciler skips retired rows so nothing quietly resurrects them.
  - **The closed-unmerged hole, closed** — see "Recently-closed PRs" below.
- **First-party stacked PRs and one naming convention (`src/stacks/`, `src/prTitle.ts`,
  `src/prRename.ts`, `src/prRetarget.ts`, `src/prNamingDesk.ts`, the `open_pr` tool).** Stage 4 left
  stacks entirely _observed_: rule 4a picked a base, the `plan-part` prompt asked an agent **in prose**
  to open a PR into it, and nothing under `src/` ever created a pull request, set a title or retargeted
  a base. Four things carry the close, and each is where the obvious move was wrong:
  - **The stack model is derived and is a lens.** `buildStacks` folds the open list on the edge
    `basePrOf` already walks, so a `stacks` table would be a second answer to a question the world
    answers every pulse. A plan **adopts** a stack and never owns one — rung identity is the pull
    request — which is what makes a hand-opened chain first-class without any storage, since
    `plan_parts` was previously the only record that a chain _was_ a chain. Nothing in
    `src/dispatcher/` may read it (asserted structurally, twice, like `prAttention`): every input it
    folds is already a gate that fires on its own.
  - **`open_pr`'s identity is structural, with more force than `report_finding`'s.** The schema is
    `{summary, type?, scope?, body?}` and nothing that names work; branch, base, issue and stack
    position resolve from the credential's origin, and every other origin is **refused by name** rather
    than silently scoped — an agent handed a target it did not ask for would open a PR for work it is
    not doing. Base selection reuses `partBase` rather than re-deriving it. The floor is asserted, not
    intended: unwired, the tool is still advertised (so `names.ts` stays honest), says so, and every
    prompt still tells the agent how to open its own.
  - **`filters.prAuthor` is the rename gate, and it needed no new attribution logic.** It is already
    the operator's answer to "which PRs are mine" and both providers apply it **at fetch time** — so
    set, every PR in the world is theirs _by construction_; unset, the harness genuinely cannot tell
    and falls back to the branch shapes only a dispatch mints. A colleague's PR is renamed under
    neither arm. The title is `pr-title` in the overridable prompt book (`finding-ticket`'s argument),
    and its fields are **finished clauses** — an empty `{position}` for a lone PR, an empty `{kind}` for
    an undeclared type — so an override is a plain substitution and the conditionals cannot drift
    across overrides. Renaming is a **desk**, not an executor action: nothing decides _whether_ to
    rename, so it is not auto-send gated, and it is idempotent, so a settled world writes nothing.
  - **Restack was not built, and that is the finding.** Rule 2 already fires on `needsBaseUpdate`, and
    `ruleDispatcher.ts` says so in as many words — a git-derived `needsRestack` would have been a second
    opinion about a decision made elsewhere. What is genuinely missing is **provider-shaped**: Azure's
    `normalizeMergeState` has no `behind` arm at all, so a rung that falls behind its base is invisible
    to rule 2 there. Recorded rather than papered over. What _was_ built is `retargetsFor`, because
    `isStackedPr`'s doc rested on "the provider retargets them when their parent merges" — true of
    GitHub, false of Azure, where the rest of a stack simply stopped with nothing saying why. An
    **abandoned** parent strands its child on purpose: the work beneath never landed, so rebasing would
    drop the premise it was built on. Tests: `test/stacks.test.ts`, `test/prTitle.test.ts`,
    `test/openPr.test.ts`.
- **Recently-closed PRs (`WorldSnapshot.closedPullRequests`).** Both providers list only open PRs,
  so a PR that merged used to just _vanish_ — and three things were wrong because of it. The world
  snapshot now carries a **separate** list of PRs that left the open set within
  `config.closedPrWindowMs` (default 6h, `0` disables). Separate, not merged into `pullRequests`:
  rules 1/2/2b/3, `openPrForIssue`, `basePrOf`, `inheritedCiFailure` and `isStackedPr` all take a PR
  list they trust to be open, and carrying closed rows alongside (the way `excludedPrs` is carried
  into `DispatchContext`) keeps that true **by construction** rather than by remembering to skip a
  status in nine places. Nothing in the dispatcher reads the list at all. `PullRequest` gained
  `state?: PrState` + `closedAt?`; read the state through the pure `prState` (`prHealth.ts`), which
  folds a missing value back onto `merged` and **never invents `closed`** — abandonment has to be
  observed, since inferring it from a disappearance is the bug being fixed. What it fixes:

  - **`pr_merged` was fake-provider-only.** `worldDiff` defined it as `!before.merged && pr.merged`,
    which needs the PR to still be in the snapshot; `state: 'open'` / `status: 'active'` guarantee it
    isn't. The merge now arrives as an _appearance_ in the closed list (plus a new `pr_closed` for an
    abandonment). One row is news the first cycle it appears and never again — it lingers for the
    whole window — and a merge already announced off the open list (the fake marks a PR merged in
    place before it closes) is not announced twice.
  - **Plan reconciliation guessed.** `foldPr` read absence as `merged`, which silently _completed_ a
    plan whose part PR had been abandoned. The pure `observePartPr` (`plans/parts.ts`) now orders the
    readings: open PR → merged-in-window (matched by branch _or_ number; merged is terminal so the
    loose match is safe) → closed-unmerged → absence. **Absence-means-merged stays the fallback** —
    the observed signal replaces the inference only _inside_ the window, or a part whose PR merged
    last week would reopen finished work. The closed-unmerged reading matches by **`prNumber` only**
    and clears it: a dead PR sits in the window for hours, so matching by branch would yank the part
    back to `ready` every pulse, including after it was re-dispatched.
  - **The cockpit forgot.** `/api/state` ships the list (and `buildRefUrls` covers its numbers); the
    World panel draws a "Recently closed" section marked merged vs closed-unmerged.

  Cost: **one** extra list request per snapshot per provider, and deliberately no per-PR fan-out — a
  closed row carries no CI/review/comment signal, because nothing acts on a dead PR. GitHub sorts by
  `updated` desc and stops paginating at the first entry outside the window (`updated_at >= closed_at`
  always, so that break is sound); Azure uses `queryTimeRangeType=closed` + `minTime` with
  `status=all`, one request covering completions and abandonments, re-filtered client-side because the
  range is boundary-inclusive and an older API version may ignore the parameters. The fake models the
  transition through a `pr_closed` injectable event, which **moves** the row rather than copying it —
  `mergePr` still marks a PR merged in place so the deterministic loop settles, and a PR in both lists
  would have the diff report one merge twice. Tests: `test/closedPrs.test.ts`.

- **Plan reconciliation (`src/plans/planReconciler.ts`).** The store holds intent; the outside
  world stays the source of truth. Runs each pulse in `harness.ts` next to `worldDiff` and
  **before** `decide`, so a part it readies is dispatchable the same cycle. Two sources:
  **git** (`GitObserver` — this is that seam's consumer) for branch reality, because it's the only
  thing that sees a branch before a PR exists and `hasCommitsBeyond` _is_ "has the dependency
  actually pushed"; **the provider**, from the world snapshot, for PR and merge state, because a
  squash-merged branch has no ancestry to its base and git can never report a merge. Both
  providers list only open PRs, so **a PR that has left the world reads as merged** (the same
  reading `openPrForIssue` relies on) — mapping absence to `ready` instead would re-dispatch on
  every real merge. Every fold is idempotent: each writes a status derived from the observation,
  never toggled against the previous one. It also owns the plan's **single status comment**
  (`IssueCommentCapable.upsertIssueComment`, `plans.status_comment_ref`, edited in place, written
  only when there's news) and the `issue/<n>` **ref collision** guard — the flat branch blocks
  every `issue/<n>/<slug>`, so the parts are parked `blocked` with one clear error rather than a
  git failure per dispatch. **That reason is written twice from one pure function**
  (`refCollisionReason`): into the error, and onto `plan_parts.blocked_reason` for every part it parks.
  The error fires only under `changed && collision` — right for a feed, which carries news, but it left
  a plan blocked yesterday explaining itself to nobody today and to nobody at all across a restart. So
  the feed keeps the news and the standing condition moves onto the row, cleared with the status so a
  part never claims a collision that is resolved. It is a complete account rather than one case of
  several: `readiness` answers `pending` or `ready` and **never `blocked`**, so this is the only thing
  that blocks a part. The Goal Floor draws it as the jammed assembler's plate — the other half of the
  gap, since a blocked part is never queued (so the held-reason plate cannot speak for it) and has no
  PR to be read for one, leaving a red word and no reason anywhere. `blocked_reason` is a column on an
  **existing** table and so needs its `ensureColumns('plan_parts', …)` entry.
  `planning.gitFetchIntervalMs` floors the `fetch`, which is wired only
  for the real observer (tests inject `FakeGitObserver` via `buildSystem`'s `gitObserver` opt and
  get none). Tests: `test/planReconcile.test.ts`.
  - **A plan approved into that wall had no exit (`src/plans/planWedge.ts`).** An issue worked `single`,
    replanned and then _approved_ blocks every part instantly, and every way out is shut: `refusePlan`
    compare-and-sets against `awaiting_approval` (correctly — refusing is a verdict on an unanswered
    question), so the fall-back-to-`single` arm is gone once released, and `resolvePlanRoute` fails a
    spent replan back to `parts`, never open to `single`. Three jobs, kept apart. **Notice**:
    `planIsWedged` — _every_ live part blocked, not any, since the collision blocks them together or
    not at all — drives rule `plan-blocked` (3i), which escalates once, deduped on an open escalation
    for `issue:<n>:plan` **and** a recent executed one exactly as rule 1b, and dispatches nobody
    because nobody could help. `active` plans only: an unapproved one is already in front of a human.
    **Warn**: `planApprovalWarnings` is **appended** to rule 3d's ask (never interpolated, for
    `ciFailureNote`'s reason) and names the blocked parts plus any open PR for the issue no part
    claims. It warns and does **not** block — refusing approval would put a git fact in front of a
    judgement about _shape_, for a branch one command from being gone. **Exit**:
    `abandonDecomposition` (`POST /api/plans/:id/abandon`) retires the parts and collapses to `single`;
    a separate act rather than a loosened guard because it is a different sentence, and gated on
    `partHasWork` so nothing with an agent, branch or PR is retired — which is also what makes the
    collapse safe. **Nothing attaches the existing PR to a part**: it claims to resolve the whole
    issue, which is the claim the decomposition overruled, so deriving an owner would infer a positive
    terminal from incidental evidence. Tests: `test/planApproval.test.ts`, `test/planPart.test.ts`.
- **The goal assay (`src/intake/`, the `issue_assays` table, the `assay_issue` tool, issue #158).**
  Every gate in front of a fresh issue asks about **policy** — the watch tag, the workflow state, the
  cooldown, the attempt cap, headroom, `resolvePlanRoute`. None asks whether the ticket says anything
  an agent could act on, so a vague or already-obsolete goal goes straight into the funnel and the
  first sign anything was wrong is an agent spending its attempt cap and escalating in a way that reads
  as its own failure — `ciPolicy`'s wall, one stage earlier. Rule `issue-assay` (3f, off by default)
  puts a code agent on `assay/issue/<n>` (origin `issue:<n>:assay`, cut from the default branch) for a
  watched open issue nothing has been started for. It is the **assessor's mirror**: `hasPriorWork` is
  the discriminator for both, one taking each arm — nothing started means the goal is all there is to
  judge, something started means the question was answered by someone acting on it. What carries it:
  - **It blocks, and silence is what makes blocking safe.** Only an explicit `unclear` holds; a
    missing row holds nothing, so an assayer that crashed, was killed or spent its cap leaves the
    issue to ordinary pickup with **no escalation** (the planner's fail-open, for its reason). That is
    `undeclared`-vs-`more_work` again: act on what was said, never on silence. `workable` is stored
    too — without a row for the affirmative the assayer re-runs every cycle, exactly as a `single`
    plan verdict must be persisted.
  - **The hold expires on the ticket's own text, not on a timer or only on an event.** The row stores
    `goal_ref`, a NUL-joined fingerprint of the title and body judged (`goalFingerprint`), and the
    hold ends the moment the issue fingerprints differently. It **could not** be an event: `worldDiff`
    emits nothing at all for an edit, and adding one would make the verdict depend on the harness
    having witnessed the moment — a ticket rewritten while it was down would stay parked forever,
    which is `deliveryHold`'s argument for reading current state, with more force. Phase 4's
    signal-expiry arm rides alongside (any transition on `issue:<n>` after the verdict) and is what
    covers a human who answers in a **comment** rather than by editing. No timer arm, for
    `deliveryHold`'s reason. The fingerprint is taken from the **task** (`originTitle`/`originSummary`)
    in `AgentManager.recordAssay`, never re-read from the world — re-reading would swallow an edit
    made while the assayer was running and stamp the verdict with text nobody assayed.
  - **`hasWorkStarted` is now exactly `hasPriorWork`, and the reason is the interesting part.** It
    began as that predicate with the assay's **own** tasks filtered out, because `issue:<n>:assay` is
    inside the subtree it then matched, and without the exclusion one crashed assayer would retire the
    cooldown, the attempt cap and the assessor's arm of the same discriminator in a single stroke. The
    exclusion was right and its scope was wrong — it was written one special case at a time, and the
    next origin added (`issue:<n>:plan`) went unclassified and parked every `single`-routed issue in
    the assessor. `issueOriginRole` makes the distinction for every deliberation origin now (see the
    assessor bullet below), so this is a name for the question rather than a second answer to it.
  - **A comment on the ticket is the third decision, and it is what makes a blocking gate fair.**
    `AssayDesk` (pulse, beside the plan reconciler) keeps **one living comment** per refused goal
    through `IssueCommentCapable.upsertIssueComment` — mechanical bookkeeping like the plan status
    comment, so not auto-send gated, with the one-comment rule the thing that stops it being noise.
    Written only when the body changes; the comment ref is dropped when the goal text changes (a new
    question gets a new comment rather than overwriting the record of the old one); a hold that has
    **ended is retracted** on the thread, because leaving the question standing is what makes people
    distrust a bot's comments. It is the assay's only outbound act — nothing is closed, rejected,
    labelled or edited.
  - **It second-guesses the watch tag, deliberately and only there.** It never filters an untagged
    backlog; it applies to issues the operator asked for, and its answer is not _no_ but _with what?_.
    The operator's own arm and escape hatch is `POST /api/issues/:number/assay`
    (`workable`/`unclear`/`null`). Cost, named rather than discovered: with `planning`, `assessment`,
    `assay` and `retrospective` all on — the defaults — one issue can spend an assayer, a planner, its
    part agents, an assessor and a writer. Each is bounded by the same attempt cap and each fails
    open; the four switches are the way to stop paying for them. `QueueItem`/`issuePickupStatus` gained the `assay`
    status for `capped`'s reason (an issue waiting a cycle for a verdict must not look like an idle
    fleet). Tests: `test/goalAssay.test.ts`.
- **The retrospective and the scratchpad (`src/retro/`, `src/scratch/`, rule 3h).** The Goal Floor drew a
  station called **Manifest**, _Report what was done_, immediately before Launch — and it reported
  nothing: its content was `issue.conclusion?.note` or an em dash, its `link` was null, and nothing
  downstream read it. The floor named a step the harness never took. What was missing was two
  different things, and they are kept apart:
  - **During a run, `scratch_entries`** — the shared per-issue pad. `note_progress` is one overwritten
    line for a fleet card and `report_finding` is testimony about work _outside_ the caller's task;
    neither is "here is what I learned doing this, for whoever works this goal next", which is what
    five part agents rediscovering one constraint costs. **Append-only**, because
    `maxConcurrentPartsPerIssue` permits concurrent part agents and a mutable document would have them
    overwrite each other with no merge anywhere — the loss `detectFileOverlaps` exists to expose. The
    pad is **never named by argument**: `padOriginFor` maps `issue:12`, `:plan`, `:assay`, `:assess`,
    `:retro` and `:part:<slug>` to `issue:12` and everything else to null, so an agent cannot reach
    another goal's record, and a `pr:<m>:*` agent is refused even when the PR is linked (`linkedPrNumber`
    is sticky). **Nothing in the dispatcher reads it at all** — asserted structurally, like the work
    graph's own lens test.
  - **After it, `retrospectives`** — one document per goal. Not a plan part, though `expectedKind:
'report'` exists: a part is work the plan schedules, retired by a replan and available only to a
    decomposed issue, while this is about the whole goal and must survive `plan_parts` being rewritten.
    Not a column on `issue_conclusions` either: a conclusion is a verdict a gate re-reads every pulse,
    this is prose nothing branches on. The document is stored on the row rather than surfaced as an
    artifact chip for `plan.document`'s reason — `GET /artifacts/:id` serves out of a worktree the reap
    removes.
  - **Rule `issue-retro` (3h) is on by default**, unlike its three neighbours, because it runs once
    after the work is over and **gates nothing**: a spent attempt cap costs the write-up and nothing
    else, so it fails open _and silent_ with no escalation. A **desk** agent (no branch, no worktree —
    it writes no files), fenced so only `issue:<n>:retro` may `retro_submit`, which keeps the agent that
    did the work from writing the account of it.
  - **What it is handed is appended, never interpolated** (`padTestimony` + `retroDossier`, assembled in
    `ActionExecutor.materializeTask` for the branch gate's reason): an override that never learned about
    a `{dossier}` token would silently drop the whole briefing. The dossier **reads rows the pulse
    already wrote and derives no verdicts**. Spend is `null` rather than `0` when nothing was reported —
    PTY mode reports none, and a confident `$0.00` is the one reading that would be a lie.
  - **The dispatcher reads existence, never prose**: `DispatchContext.retrospectiveOrigins` is a list of
    origins, so a rule cannot branch on one agent's account of a run. `/api/state` ships the summary and
    `hasDocument`; the document itself comes from `GET /api/retrospectives/:ref` on open, the
    `WorkTreePanel` pattern, because the snapshot is polled. The cockpit control hangs off **the
    retrospective existing**, never off the floor's status — the plan modal's lesson. Tests:
    `test/scratchPad.test.ts`, `test/retrospective.test.ts`, `test/retroDossier.test.ts`.
- **Handing a goal's knowledge forward (`src/briefing/priorWork.ts`).** Every stage of a goal is a
  fresh agent with no memory of the last: the assayer read the ticket against the repo, the planner
  read the repo and argued for a shape, a part agent wrote a constraint on the pad — and the next
  agent started from a title, a body and a branch name, paying again for all of it. The pad's own doc
  says it is written "for whoever works this goal next"; its only reader was the **retrospective**, the
  one agent on a goal that does none of the work. `materializeTask` now appends
  `priorWorkBriefing(...)` beside the rejection and outstanding-work notes. What carries it:
  - **The rule is "only what no prompt already renders"**, which is what stops it becoming a second
    account of things the harness already says. So: the pad; the planner's `document`/`risks`/
    `outOfScope` (which reach the plan modal and no agent — and on a `single` verdict are the entire
    product of a code agent that read the whole repository, against rule 4's title-and-body prompt); a
    part's `rationale`/`acceptance`, stored and rendered **nowhere at all**; and the prose behind each
    standing verdict. It therefore omits `plan.reason` (`currentPlanSummary` and `{plan}` render it)
    and a part's status/branch/PR number (`currentPlanSummary`, `siblingContext`).
  - **No world facts, deliberately.** A PR's state is live through `world_read`; in a prompt it is a
    stale second reading of something the agent can ask about properly. The briefing is testimony.
  - **Scoped by `padOriginFor`, not a fresh predicate** — already the harness's answer to "which goal
    is this agent working". Everything outside one issue's subtree is handed nothing, which is
    `outstandingForOrigin`'s widening rule at the level of a whole goal. The **retro origin is
    excluded** though `padOriginFor` accepts it, or `retroBriefing` renders the pad twice; a **part
    agent gets no parts section**, because `siblingContext` owns it; and the conclusion is dropped when
    the outstanding-work note already carries it. One fact, one place, per prompt.
  - **Bounded, and it names what it dropped.** Appended text lands _after_ the cached prefix, so it is
    fresh input tokens on every dispatch and only pays when it displaces more rediscovery than it
    costs. An untouched goal renders `''`, so a first agent's prompt is byte-identical to one composed
    before this existed — that is what makes it safe on every dispatch. The pad caps at the 15 most
    recent entries and the write-up at 4 000 characters, both stating the elision (`scratch_read`
    named), for the no-silent-caps reason. In the **executor** and appended rather than interpolated,
    for the reasons the rejection note is. Tests: `test/priorWorkBriefing.test.ts`.
- **`src/graph/` is the durable work graph (stages 1 and 3 of 3) — the only thing here that outlives
  the world.** `closedPrWindowMs` bounds how long the _world snapshot_ remembers a merge (6h); every
  panel and predicate reading that snapshot forgets with it, and the edge from an issue to the PR
  that delivered it was then unrecoverable. It bounds nothing about the graph: `work_nodes` is
  upsert-only, never pruned, and a node the fold does not observe this pulse is left exactly as it
  was. `workGraph.ts` is the pure fold (every edge it records was already computed somewhere in the
  pulse — `observePartPr`, `openPrForIssue`, `basePrOf` — this is where they stop being thrown away),
  `workGraphRecorder.ts` its **only** writer, called once per pulse from `harness.ts` after the plan
  reconciler and before `decide`; a throw there records an error and never fails the cycle. Keyed on
  the ref vocabulary that already exists (`issue:12`, `pr:41:ci`) and on the **origin, not the task**,
  so two CI attempts are one node. `parent_ref` is work lineage and write-once; stacking is
  `base_ref`, which keeps it a tree. **Nothing in the dispatcher reads any of it** — stage 1 is a
  lens, the way `findings` and `prAttention` shipped, because a rule consulting the graph is a second
  opinion about a gate living nowhere near the gate it duplicates, and lets an agent's own record
  suppress another's dispatch. `test/workGraph.test.ts` asserts that **structurally**, now in two
  assertions: the original (the only files under `src/` naming `graph/workGraph` are `harness.ts` and
  `system.ts`) plus a **stronger sibling** stage 3 added — no file under `src/dispatcher/` names
  `graph/` at all, which covers every module the directory will ever hold. If either fails, fix the
  file it names rather than the assertion. Served on its own routes (`GET /api/work`, `/api/work/:ref`)
  and never on `/api/state`, which is polled — `web/src/components/WorkTreePanel.tsx`
  fetches on open, and hangs off the shell rather than a skin because a skin may not reach `api.js`.
  - **The one known gap, ruled on and left**: `record` reads `existing` as
    `listWorkRoots().flatMap(listWorkSubtree)`, which reaches a node only if its whole ancestor chain
    has rows — so on a backfill a plan/part whose issue is already closed (providers list open issues
    only) is invisible to the fold. Conservative in consequence (the node stays stale at `open` rather
    than being falsely marked merged) and closing it costs a fourth store method where the spec argued
    for three. Written up in `docs/spec/14-persistence.md` rather than only in a PR body. **Stage 3
    added `listWorkNodes()` for the detector and deliberately did not wire it into the recorder** —
    the method now exists, so closing the gap is cheap, but it stays the operator's call.
  - **Stage 3 — "nothing gets done without a recorded work item; if one is missing we create it."**
    Operator jobs rooted their own trees with nothing in the tracker behind them, and because
    completion is _read_ from the tracker and never computed, an item the tracker has never heard of
    has no terminal state available to it at all. Four decisions carry it, and `src/graph/unrecorded.ts`
    is where the argument lives:
    - **An unparented PR is not a defect.** A hand-made PR with no ticket is normal, and noise in a
      tracker is worse than a gap in a graph. The category was only ever in doubt because it named two
      populations: a job agent's PR was unparented for the same reason a stranger's drive-by is. Two
      adoption arms in the fold split them — **arm A**, a job owns the PR on its own branch (`jobBranch`
      in `src/jobs.ts`, shared with rule 0 so the two cannot disagree about where a job's work lands),
      and **arm B**, a job is adopted by the issue its own PR's `linkedPrNumber` names, which is the
      write-once parent's intended case one level up and means **no ticket is filed when one already
      exists**. Arm A runs before the issue arm because `parent_ref` is work _lineage_ — a branch match
      says what caused the PR, `linkedPrNumber` says what it is about — and nothing is lost, because
      arm B recovers the aboutness as `issue → job → pr`. After both, an unparented PR can only be a
      human's.
    - **Filing is an operator click, never a rule.** A rule that created tracker items would be a new
      outbound capability on the world, larger than anything stages 1–2 took, and the condition it
      fires on is _permanent until acted on_, so a throttle would only set the rate at which somebody's
      backlog fills — and a filed ticket has no undo. The mechanism being reused
      (`POST /api/findings/:id/file`) is defined by a human starting it. `unrecordedWork` narrows hard
      so the click stays rare: **code jobs only** (`detectFileOverlaps`' narrowing, and what stops the
      recursion by construction since a filing job is itself a _desk_ job), **dispatched only**, and
      **parentless**. Deliberately _not_ "produced a PR" — that would only ever record work already
      visible — so `prCount` rides beside the verdict as evidence instead.
    - **A filing is not a `findings` row.** A `Finding` is testimony, `agent_id`/`task_id` `NOT NULL`
      with attribution taken structurally from a credential; a harness-authored row has neither, so
      reusing the table means forging the two columns that carry the guarantee. Fresh
      `work_item_filings`, keyed on `target_ref` so a second click is refused by the primary key.
    - **The fold writes the parent, not the route and not `link_ticket`.** The filing row is _intent_,
      the relationship `plans`/`plan_parts` already have to the fold, so `workGraphRecorder` stays the
      graph's only writer. A linked filing also emits a **placeholder issue node** when the world has
      not — a ticket closed at once, or filed into another project, is never fetched, and the adopted
      job would be reachable from nowhere. `link_ticket` gained a second resolution arm (finding _or_
      filing, never both) and requires an `issue:` ref, since both trackers make a work item an issue
      and guessing a node kind off a `pr:` ref is a case worth removing.
    - Consequence, stated rather than mechanised: a filed ticket is a fresh open issue, and the issue
      watch gate is **opt-in** (`labelPrefix` defaults to `lubbdubb`), so nothing picks it up. Under
      `labelPrefix: ''` — the documented "act on everything" escape hatch — it **is** immediately
      eligible, and an agent may redo the work. Suppressing that would be a gate keyed on provenance
      sitting nowhere near the rule it modifies. Tests: `test/workGraphRoots.test.ts`.
- **`src/delivery/` is stage 2 — the assessor, and the first thing to read the graph.** It reads it
  as an **agent**, not as a rule: `world_read`'s issue payload gained the work subtree (via
  `Store.listWorkSubtree`, so nothing new imports the fold and the lens assertion above is untouched).
  `delivered` is the harness's own park — rule 3b's review-state hold generalised off the tracker,
  because that hold is a _tracker state_ and GitHub has none, which is why `openPrForIssue` reading
  only the open list lets a merged PR's issue back into rule 4 every pulse. It is deliberately weaker
  than the tracker's `closed`: reversible, gates pickup and nothing else, and never closes a ticket.
  What carries it:
  - **A fresh `issue_deliveries` table, not a third `IssueConclusionVerdict`** — the proposals-vs-
    escalations argument again. A conclusion is declared once by the agent that did the work and
    gates nothing; a delivery verdict is re-read by a gate every pulse and expires on world signal.
    The two are mutually exclusive and each write clears the other **in the store**, because a caller
    that remembered one and forgot the other would have rule 3b return an item to pickup while this
    gate held it.
  - **`deliveryHold` has two arms and no timer**, asked in two places off the one predicate (rule 4's
    filter and `issuePickupStatus`). The **tracker move** is arm 1 and reads the issue's _current_
    pickup state rather than a transition, because `worldDiff` emits nothing for a `workItemState`
    change — and state survives a restart where an event between two pulses does not; adding an
    `issue_state` event was refused as reintroducing exactly that fragility. Arm 2 is phase 4's
    rejection expiry (any transition on `issue:<n>` after the verdict), which covers the providers
    where arm 1 cannot fire. **No timer arm**: an accepted proposal waits on the world to _reflect_
    something done (a duration), a delivered issue waits on it to _become_ something else (an event).
    The operator's clear is a delete, which is why it is not an arm.
  - **Rule `issue-assess` (3e) is not driven off `eligibleIssues`**, for rule 4a's reason: that list
    applies the workflow-state gate and the Azure case this covers is precisely an item parked in the
    review state. **`hasPriorWork` does two jobs** — it stops every fresh issue getting an assessor
    that reports nothing was done, _and_ it is the discriminator that lets assess and pickup coexist
    on an issue both would claim (nothing started → pickup, something finished → ask). It is answered
    from `ctx.tasks`, **never the graph**, even though the graph is keyed on the same origin strings.
    An assessed issue is **suppressed** from rule 4 that cycle or two agents land on it, and the rule
    **fails open** like the planner (spent cap → ordinary pickup, no escalation), since narrowing
    rule 4 without that turns an assessor crash into a permanently parked issue.
  - **Which origins count as prior work is decided once, in `issueOriginRole` (`src/issueOrigins.ts`),
    and matching the whole `issue:<n>:*` subtree was a real defect.** The subtree holds two
    materially different things: the pickup root and a plan's parts are the **work**; `:assess` is not
    work but only ever happens downstream of some, so it counts as **evidence**; `:plan` and `:assay`
    are the harness **deliberating**, and a task on one says the issue has been thought about, never
    that anything was built. Counting the planner's own task made every issue the planner routed to
    `single` look worked, so rule 3e fired on an issue nothing had built and suppressed the pickup
    that was the whole point of the verdict — the assessor then honestly reported nothing delivered,
    rule 3g replanned, and the issue cycled the funnel forever with no PR ever written (observed on
    three at once against Azure Boards). Two properties keep it from recurring: an **unrecognised**
    suffix is its own answer rather than a silent default (an implicit "everything counts" is exactly
    how `:plan` slipped through), and `hasPriorWork` does not count it — failing toward a redundant
    pickup an operator can see rather than a parked issue they cannot. `test/issueAssess.test.ts`
    asserts the whole known vocabulary, so the next origin has to be classified rather than inherited.
  - **`assess_issue` refuses every agent that is doing the work** — `conclusionOrigin`'s discipline
    pointed the other way, because judging your own delivery is not an assessment. **On by default**
    (`assessment.enabled`), and unlike `mcp` not purely additive: it gates pickup and spends an agent
    per assessed issue. Tests: `test/delivery.test.ts`, `test/issueAssess.test.ts`,
    `test/issueDelivery.test.ts`.
  - **The negative verdict, and what it drives (#159).** Stage 2 shipped the assessor able to say
    "not delivered" and nothing able to hear it. The intended loop is Plan → Work → is the goal
    achieved? → No → re-plan: the check was rule 3e, the replan was `POST /api/plans/:id/replan`, and
    the middle was missing. Worse than "no representation" — `more_work` **was** recorded, into
    `issue_conclusions`, which is (a) the working agent's own row and (b) read only by rule 3b's
    inverse arm, which emits a **tracker** move. So on GitHub it changed no dispatch at all, and on
    either provider for a decomposed issue rule 4 is gated on the `single` route while rule 4a finds
    every part settled. What carries the fix:
    - **A fresh `issue_shortfalls` table, not a polarity column on `issue_deliveries`**, and the
      polarity is the argument. Every reader of a delivery is a **gate** — `deliveryHold`, each
      pulse, holding pickup off — and this row must gate **nothing**, because releasing work is the
      point. One table would leave every present and future reader remembering which polarity it
      held, from rows identical until you read a column: `proposalHold`-vs-`planProposalHold` again.
      `test/issueShortfall.test.ts` asserts it **structurally** (`src/delivery/delivery.ts` names no
      shortfall type) as well as behaviourally, so a later flag fails a test rather than quietly
      parking an issue. It is mutually exclusive with a delivery (each write clears the other, in the
      store) and deliberately **not** with a conclusion — overwriting the working agent's declaration
      is the bug, so both rows stand and `resolveIssueConclusion` ranks them: operator toggle, then
      shortfall (the assessor is later and better informed), then the agent, then the plan.
    - **The cause is declared, and all three are routed differently.** `plan` → propose a replan
      (arm A: one `setPlanStatus(planning)` write, and rule 3c takes over — `releasePlan`'s pattern);
      `part` → propose one **appended** follow-up part (arm B); `goal` → escalate and schedule
      nothing (arm C, #158's question). Deriving the cause would send all three to a replan and
      re-decompose plans whose shape was fine, which is the issue's own stated failure mode. **No
      cause is a fourth answer**, never one of the three: an unplanned issue that simply is not
      finished names nothing, so nothing fires — folding it into `goal` would escalate "the ticket is
      wrong" every time, a route invented from silence.
    - **Arm B appends; it never resurrects.** `partHasWork` is the existing statement of why — a
      merged part's PR is on the default branch and its branch is spent — so the part that fell short
      is left exactly as it is and "never retire a part with work started" is met _by construction_.
      The plan moves `complete` → `active` through the roll-up it already computes.
    - **Arms A and B are `Proposal`s (kind `shortfall`, ref `issue:<n>:shortfall`); arm C is not.**
      Both spend a fleet, and a plan rewritten without a click would churn `plan_parts` under live
      agents. Arm C schedules nothing, and a proposal whose accept and reject both do nothing is not
      a decision — so it is rule 1b's escalation, deduped on the open inbox item _and_ a recent
      executed decision. The **full** `proposalHold` applies (unlike a plan proposal's): the row
      persists until its arm is performed, so without the durable `rejected` arm one refusal is
      re-asked every pulse. `proposalWorldRef` maps the ref to `issue:<n>` unmodified, so phase 4's
      signal expiry works untouched — it must, or one refused replan vetoes every future one.
    - **The loop is bounded by machinery that already exists**: the human outside, and
      `dispatchVerdict`'s 3-attempt cap on `issue:<n>:assess` inside. Nothing new counts it — a
      second counter for one loop is two answers to one question.
    - Consequences worth knowing: **rejecting leaves the row standing** (the verdict is still true;
      you declined to act), which is the asymmetry with `refusePlan` and why
      `POST /api/issues/:number/shortfall` exists as the operator's clear. **With `planning` off both
      plan-shaped arms degrade to arm C**, since accepting either would park the issue on a
      transition no rule consumes. The assessor's summary reaches a replanner through `plan.reason`
      (which `currentPlanSummary` already renders) rather than a new prompt placeholder an override
      could silently drop. Tests: `test/issueShortfall.test.ts`.
- **`src/harness.ts`** is the pulse: snapshot world → diff against the previous snapshot
  (`src/world/worldDiff.ts`, persisted as `world_events` + streamed as `world:events` for the
  cockpit's Activity feed) → plan reconciliation → work-graph record → `Dispatcher.decide` →
  `ActionExecutor` → audit. Cycles are coalesced (one in flight at a time).
- **`RecoveryDesk.detect()` runs once at boot**, _before_ `harness.runCycle('boot')`. It resumes
  nothing: every agent the last run orphaned is parked for an operator's restore / requeue /
  remove, and `runCycle` **holds every pulse** while any of those is outstanding. See "Crash
  recovery" below — the hold is the first thing `runCycle` asks, ahead of even the world fetch.
- **`src/runtimeControl.ts`** holds the live, in-memory dispatch controls (`cap` +
  `paused`), seeded from `maxConcurrentAgents`/`startPaused` at boot. Both the `Harness`
  (headroom) and `ActionExecutor` (the hard dispatch gate) read it **by reference** each
  cycle — never copy `.cap`/`.paused` into a local at wiring time or runtime changes stop
  taking effect. Mutated via `POST /api/control`; **not persisted**, so a restart reverts
  to config. Pausing defers only `dispatch_*` actions (escalate/answer/etc. still run) and
  scaling the cap down never kills a live agent — both deferrals are audited with a reason.
- **`src/errorLog.ts`** is the one error-recording path. Anything that catches a failure —
  the harness's cycle `catch`, provider snapshot `catch`es (via the optional `errors` in
  `IntegrationContext`/provider opts), `AgentManager` terminal failures (with the exit code
  captured from the session's `exit` event), the Fastify `setErrorHandler`, boot resume —
  calls `errors.record(...)`, which persists to the `error_events` table, mirrors to stderr,
  and emits `logged` (fanned out over WS for the cockpit's Errors panel). Don't add new
  swallowed `catch`es; route them here. The event is named `logged`, not `error` — an
  unlistened `error` event throws, and recording a failure must never throw. Tests silence
  the stderr mirror with `buildSystem(config, { errorMirror: () => {} })`.
  **The stderr mirror sanitises, and only the mirror does.** It writes one line per entry, so
  a newline in a value could end that line early and forge a second `[lubbdubb:error]` one —
  and both halves of the header arrive from outside (an agent id off a request path, provider
  and exception text off the world). `oneLine` flattens the header, which costs nothing since
  a `message` is a sentence by contract; `detail` is deliberately multi-line, so it is
  **indented** rather than flattened — keeping the shape it exists for while making a forged
  header visibly a continuation. The **stored** entry keeps its exact text: the store is
  structured rows, not a line-oriented stream, and the cockpit renders it as DOM text, where a
  newline forges nothing.
- **`src/git/` is the git-shell-out corner.** `gitCli.ts` holds the two primitives
  everything else uses: `runGit(repoRoot, args)` (one place where `cwd: repoRoot` lives) and
  `resolveCommit(repoRoot, ref)`, which resolves a branch name to a **SHA** preferring
  `origin/<ref>` over the local ref — the harness's clone never checks the integration branch
  out, so its `refs/heads/main` is frozen at clone time while the remote-tracking one moves.
  It returns a SHA rather than a ref name on purpose: handing `git worktree add -b` a
  remote-tracking ref sets the new branch's _upstream_ to it. `WorktreeManager.ensure(branch,
base)` cuts a **new** branch from `config.defaultBranch` (threaded through `ExecutorDeps`) —
  but it is **reuse-first**, so an existing worktree or local branch is handed back and `base`
  is ignored entirely: `ensure` does _not_ guarantee the branch is based on `base`, it only
  decides where a branch that didn't exist starts. An unresolvable `base` throws (the
  executor's existing `catch` audits it as a rejected dispatch) rather than falling back to
  HEAD — silently picking an incidental base is the bug the parameter exists to fix.
  **`ensure` reclaims a stale target directory before every `worktree add`.** An interrupted or
  killed agent leaves its checkout de-registered-but-present (admin entry gone, folder on disk),
  which `findExisting` cannot see (it reads the porcelain list) and `worktree add` refuses with
  `fatal: '<dir>' already exists` — and since the path is deterministic, **every retry hits the same
  wall**: the branch is wedged for good and the issue never gets an agent (observed on several at
  once). `git worktree prune` does not cover it — prune is the mirror case, an admin entry whose
  directory vanished — so it runs first only to clear that cruft, and the reclaim then removes a
  path that exists on disk and is absent from `git worktree list --porcelain`. **The porcelain list
  is the guard, not the presence of a `.git` file**: reuse-first is sacred, so a directory git still
  knows about is a live agent's checkout and is never touched (two branches can `sanitize` onto one
  directory; there the `add` fails loudly, which is the honest answer). Reclaiming discards whatever
  the dead orphan held — with no admin entry there is no branch or commit behind those files, so
  nothing could recover them anyway. Porcelain paths are forward-slashed even on Windows, hence
  `registered()` resolves them; an unresolved path would never compare equal to the target.
  `gitObserver.ts` is the read-only `GitObserver` seam (branch presence, ahead/behind,
  `hasCommitsBeyond`) with `fakeGitObserver.ts` alongside; it is deliberately **fetch-free**, and
  its one consumer is plan reconciliation. Refreshing the remote is therefore the _caller's_ half
  of the split: `fetchRemote(repoRoot)` here, run by `PlanReconciler` on the pulse and floored by
  `planning.gitFetchIntervalMs`. Keep new observer methods read-only and fetch-free.
- **Server surface** is `src/server/app.ts` (Fastify REST + the `/ws` route) and
  `src/server/hub.ts` (fans harness/agent events out to sockets). The cockpit SPA is under
  `web/`.
- **`src/server/auth.ts` guards that surface, and the guard is a path prefix, not a per-route
  opt-in.** The severity is `POST /api/jobs`: rule 0 dispatches a queued job ahead of every
  world-driven rule, so an unauthenticated cockpit is an RCE endpoint with repo write and a billing
  side-effect, not a dashboard. `authorizeRequest` is pure — the Fastify `onRequest` hook is a thin
  adapter — and answers **origin and host before the token**, so a leaked credential never re-opens
  the rebinding door. Things to preserve:
  - **The hook is registered before `app.register(websocket)` and every route.** A Fastify hook is
    inherited only by contexts created _after_ it, and `/ws` lives in a child context — register it
    later and the live transcript stream (source, agent output) is the one unguarded surface.
  - **A refused upgrade needs `Connection: close` + an explicit socket destroy.** A 401 answering a
    request that asked to switch protocols leaves a socket neither the HTTP server nor the WS server
    counts, and `app.close()` then waits on it forever — anyone probing `/ws` would stop the harness
    shutting down. `test/cockpitAuth.test.ts` asserts this by closing without forcing connections.
  - **No secret in `Config`**, same rule as `GITHUB_TOKEN`: `auth` carries `enabled` + `tokenFile`
    only, and the token comes from `LUBBDUBB_TOKEN` or a minted 0600 file. `loadConfig` **throws**
    for a routable `host` plus `auth.enabled: false` — each half is a supported choice, the pair
    never is.
  - **The cockpit holds the token in `localStorage` and attaches it by hand** (`web/src/api.ts`),
    arriving via a `#t=` fragment the browser never sends to a server. Not a cookie: a cookie is
    attached unbidden, which is the whole reason cookie auth needs CSRF tokens bolted on. The SPA
    shell is deliberately unguarded — the page must load before it can authenticate.
  - **Refusals are throttled (20/source/minute), successes never counted** — the cockpit polls
    `/api/state` continuously, and throttling that is what `global: false` rate limiting exists to
    avoid. The counter lives in the hook, not in `authorizeRequest`, which takes a `throttled`
    boolean so the verdict stays pure. It isn't what makes the token unguessable (256 bits is); it
    bounds the cost of a hammer.
  - Tests that drive routes opt out with `auth: { enabled: false } as never`; coverage lives in the
    structural test that walks `app.ts`'s route table and requires a refusal from each, so a route
    added later is asserted on the day it is written. That test accepts 401 **or** 429 — walking the
    table spends the failure budget partway through — which doesn't weaken it, because the path check
    precedes the throttle and an unguarded route would answer 200/404 instead.
    Tests: `test/cockpitAuth.test.ts`.

## Agent runtimes (the part that surprises people)

There are **two interchangeable agent runtimes**, both implementing `AgentSession`
(`src/agents/session.ts`) and emitting the _same_ events
(`output`/`waiting`/`done`/`failed`/`status`/`exit`). `AgentManager`, the `Hub`, and the
cockpit are agnostic to which is running:

- **`StreamJsonSession`** (`agentMode: 'stream'`, the **production default**) — real `claude`
  over headless stream-JSON. No PTY, no TUI. This is what runs by default, so "how agents run"
  is usually _not_ a terminal.
- **`PtySession`** (`agentMode: 'pty'`/`'raw'`, and the `ClaudeDispatcher`) — a real
  pseudoterminal via `node-pty`. All the fiddly "is it waiting / is it done" heuristics live
  here behind one testable abstraction (`src/pty/backend.ts` is the swappable spawn seam).

Both speak the **sentinel protocol**: an agent prints `@@LUBBDUBB_DONE@@` when finished and
`@@LUBBDUBB_WAITING:<reason>@@` when it needs a human. These are reserved control strings —
they are detected for status transitions _and_ stripped from displayed output. The protocol
strings and the pure `stripSentinels`/`extractWaitingReason` helpers live in
`src/agents/sentinels.ts`; both runtimes use them. If you touch detection, keep the two
behaviors in sync. `PtySession` additionally handles the cross-chunk case (a sentinel split
across two PTY data chunks); on the line-delimited stream-JSON transport a sentinel always
arrives whole inside one text block, so that machinery isn't needed there.

**PTY sentinel matching goes through `src/pty/sentinelScanner.ts` — never `indexOf`.** The
interactive TUI styles the line it prints a sentinel on, so SGR escapes land _inside_ the token
(`@@LUBB\x1b[0mDUBB_DONE@@`), not merely around it. The scanner matches through the escapes and
reports **raw byte spans** (so the exact range, interleaved escapes included, can be excised from
what's forwarded to the terminal emulator) plus an escape-free payload. `scanSentinels` is the one
matcher for _both_ detection and display-stripping: they used to be two matchers over two views —
detection on an ANSI-stripped copy, stripping on the raw bytes — which disagreed exactly when it
mattered (detection fired, the strip missed, the sentinel leaked into the transcript). Keep them on
the one matcher. Two consequences worth knowing: every hit is **excised from the retained detection
tail**, which is what stops the sliding window re-firing a sentinel on later chunks (the `waiting`
latch is still needed, but it now only guards the "output while parked → running" reset, not
re-detection); and `holdFrom` **bounds** how much output is withheld waiting for a missing suffix
(`MAX_SENTINEL_HOLD`) — unbounded, an agent that merely _mentions_ `@@LUBBDUBB_WAITING:` without
closing it blacked out the transcript for the rest of the run. Tests: `test/ptySentinelScanner.test.ts`.

**Flag sentinel (surfacing artifacts).** A third sentinel, `@@LUBBDUBB_FLAG:<payload>@@`, lets an
agent push an artifact/link to the cockpit mid-run (a design doc, a report) without changing its
status. Payload is a bare ref or a JSON `{kind?,label?,ref}` (`parseFlag`/`extractFlags` in
`sentinels.ts`, pure + tested), where `ref` is a **worktree-relative path or an http(s) URL**. Both
runtimes detect it on the _raw_ stream and emit `flag`; it strips from display through the same
`stripSentinels`/hold machinery as the waiting sentinel (in PtySession that's the shared
`sentinelScanner` above, which excises every hit from the detection tail — a flag doesn't latch a
status, so a sliding window would otherwise re-emit it). `AgentManager.recordFlag` persists it
(`agent_flags`, deduped by `(agent, ref)` so an evolving doc refreshes in place), re-emits it as the
`flag` event, and the `Hub` ships it as `agent:flag` + a `dirty`. `buildStateSnapshot` includes
`flags` per snapshot; the cockpit groups them by agent onto the card/drawer as chips. Local-path
refs are served by `GET /artifacts/:id` (addressed by **flag id**, so the served path comes from
the stored flag row, not the request — the taint never reaches a path expression), **confined to the
flag's agent worktree** (a lexical prefix check runs before any fs access; `realpathSync` then defeats
symlink escape), **rate-limited** (`@fastify/rate-limit`, `global:false` + per-route opt-in so the
cockpit's state polling is never throttled), and sandboxed (`Content-Security-Policy: sandbox`) so
agent-authored HTML can't script the cockpit origin; URL refs are linked directly. It's purely
additive detection — on in every agent mode, gated behind nothing.

**The route lives _outside_ the `/api` prefix, on purpose (issue #129), and authorizes itself.**
Opening a chip is a top-level browser navigation, and a navigation cannot carry the `Authorization`
header the cockpit attaches to every `fetch` (the token lives in the `#t=` fragment a browser never
sends). So a route under `/api` — where `authorizeRequest` refuses anything without the bearer token
— is structurally unreachable by a chip click, which is why every artifact link 401'd once the cockpit
was authenticated (#126). Rather than carve an exception _into_ the prefix guard (which would erode
"guarded by prefix, not per-route opt-in"), the route sits at `/artifacts/:id` and guards itself with
a **per-flag capability** (`src/server/artifactCapability.ts`, pure + tested): a fresh per-run secret
HMAC-signs `<flag id>.<expiry>`, `buildStateSnapshot` mints one into every local artifact URL it ships
(`artifactUrls`, keyed by flag id — the cockpit looks a chip's URL up there the way it looks refs up in
`refUrls`, never string-building it), and the route verifies it against the flag id in its _own path_
before touching the store. Three properties make the capability safe to put in a URL — which the
cockpit token deliberately never is: it is **flag-scoped** (a capability for one artifact can't open
another and can't be replayed against `/api/state` or `/api/jobs`, which accept only the bearer token),
**short-lived** (`ARTIFACT_CAP_TTL_MS`, 5 min — the snapshot re-mints every poll, so a leak dies fast),
and **stateless** (an HMAC, so nothing is stored to leak or evict). The signing key is a per-run random
secret, never the cockpit token, so a capability is not the cockpit token even derived. When
`auth.enabled` is off there is no key and the route serves without a capability (the whole surface is
open by the operator's choice, loopback-only). Tests: the navigation + capability-scoping cases in
`test/cockpitAuth.test.ts`, and `test/artifactCapability.test.ts` for the mint/verify predicate.

**File-events hook (skill-agnostic artifacts).** The flag sentinel only surfaces an artifact if
the agent's _prompt_ tells it to print the sentinel — so every skill that emits a report has to
know the protocol. A Claude Code `PostToolUse` hook removes that coupling: it fires for _any_
file-writing tool (`Write`/`Edit`/…) regardless of what the agent was told, so a report shows up
with zero skill-side knowledge. It's wired once into the launch `--settings` for **both** runtimes
(hooks fire in headless stream mode too — they just don't appear in the stream output), mirroring
the status-line capture: `buildClaudeArgs`/`buildClaudeStreamArgs` take a `fileEvents` opt, and the
`--settings` fragment (`FILE_EVENTS_SETTINGS`, `src/agents/fileEvents.ts`) runs a small `node`
command that dumps each written **path only** (never the file content) into a per-agent spool dir
named by `$LUBBDUBB_EVENTS_DIR` (set in the spawn env by `AgentManager`, like the status file).
Because status-line and file-events must share one `--settings` (the flag has no array form),
`STATUS_LINE_SETTINGS` is now an object and `buildClaudeArgs` merges the enabled fragments.
`AgentManager.drainFileEvents` (piggybacked on the `output` stream + a final drain at
terminal/kill, so no polling timer) folds each captured write in through the pure `classifyArtifact`:
**every** path is recorded in the `agent_files` table (the drawer's "files changed" list, snapshot
key `files`), while **report-like** ones additionally go through the _same_ `Store.recordFlag` +
`flag` event as a sentinel flag — so a report becomes a chip via the identical dedup / `agent:flag` /
confined `GET /artifacts/:id` machinery. Promotion is: under one of the configured `docsFolderPrefix`
entries (`string | string[]` — an artifacts folder, _any_ extension), or under a `reports/` segment, else
the report/doc extension allowlist. A prefix entry is matched **prefix-aware**: a _relative_ entry matches
the worktree-relative path, an _absolute_ entry (e.g. `D:/docs`) matches an _out-of-worktree_ write left
absolute (subfolders included). Absolute paths inside the worktree are stored worktree-relative so the
artifact route can serve them; a write under an **absolute** prefix stays absolute, and the artifact route
widens its confinement to also serve files under each operator-configured absolute prefix
(`absolutePrefixes(config.docsFolderPrefix)` → extra trusted roots in `resolveConfinedArtifact`, still
lexical- + `realpath`-confined per root, so `..`/symlink escape is refused). The `FileEventsSpool` (`dirFor`/`drain`/`dispose`) is the read side; the spool dir is
minted per spawn (independent of the resume session id, so stream agents get one) and disposed on
reap. The flag sentinel stays supported as an optional intent override (URLs, custom `kind`/`label`)
but is no longer _required_. The done/waiting sentinels are unaffected — they're already injected
centrally by `PROTOCOL_SYSTEM_PROMPT` and carry intent a hook can't infer. `agent_files` is a fresh
`CREATE TABLE`, so no `migrate()` entry. Tests: `test/fileEvents.test.ts`.

_Coexists with the target repo's own config (verified)._ LubbDubb agents run in a **git worktree of
the repo they're working on**, so that repo's committed `.claude/settings.json`, `.claude/skills/`,
and `CLAUDE.md` are all present in the cwd and load normally. The hook rides on `--settings`, which
is an _additional_ settings source: hooks **merge** across sources (like permission rules, not
last-one-wins), so our `PostToolUse` entry and the target repo's own hooks **both** fire — confirmed
empirically with a nested `claude` run where a project hook and a `--settings` hook both fired on one
`Write`. Skills/CLAUDE.md are filesystem-discovered and unaffected by `--settings`. Our hook is
additionally env-gated on `$LUBBDUBB_EVENTS_DIR` (set only in the spawn env), so it's a silent no-op
for a human running `claude` in that repo by hand.

**The MCP tool channel (`src/mcp/`, issue #108) — the typed, bidirectional half.** Sentinels and the
file-events hook are both **fire-and-forget**: an agent can announce, but never receive a value back,
never learn that what it sent was rejected, never ask a question. `plan.json` is the proof — a
structured payload smuggled through an artifact-detection hook, whose zod rejection the planner never
hears, costing a whole agent to discover what a synchronous error would have said in one turn. So
every spawned agent is now wired to a tools-only MCP server inside the harness (`--mcp-config`,
config `mcp.enabled`, **on by default** — it is purely additive, unlike `planning`). Phase 1 is two
tools: **`plan_submit`** (replaces the `plan.json` write, same `PlanDocumentSchema`, validated
synchronously with the error returned) and **`escalate`** (the WAITING sentinel's payload, plus a
`kind` and `options` the cockpit renders as one-click answers). Every response carries a `_status`
envelope (origin, task, open escalation, plan roll-up), which is what removes the need for a polling
tool. Phase 2 adds tools one at a time; the first is **`world_read(kind, ref)`** (below). Things to
preserve:

- **Sentinels stay, as the degradation floor.** `MCP_PROTOCOL_ADDENDUM` states a preference, never a
  replacement, and `@@LUBBDUBB_DONE@@` has no tool at all: MCP has no turn-boundary event, so a
  `finish()` the model forgets to call is silence, and silence is indistinguishable from thinking.
  The `result` event plus the sentinel is what disambiguates _finished_ from _stopped mid-task_.
  Everything degrades to today's behaviour — `listen()` returning false, an unwritable config, a
  `claude` that ignores the server, `mcp.enabled: false` — and `test/mcpChannel.test.ts` asserts that
  floor rather than merely intending it.
- **One transition, two detectors.** `escalate` and the WAITING sentinel both route through
  `AgentManager.handleWaiting`, latched by the `parked` set: whichever arrives first owns the park and
  the second is a no-op until `respond`/terminal releases it. Same discipline as `noteSentinel`'s two
  PTY detectors, and for the same reason. Likewise `plan_submit` and the `plan.json` drain both call
  the shared `ingestPlanDocument` (`src/plans/planIngest.ts`) — neither transport gets its own notion
  of what a plan means.
- **Identity is structural, not argued** — for every _write_. No write tool takes an agent, task or
  issue argument: the credential minted at spawn resolves `token -> agent -> task -> origin`, so an
  agent cannot name itself and therefore cannot address another's work. This is what the
  `planOriginIssue` fencing was approximating over a transport that carried no identity. The token is
  a bearer credential — it lives in the 0600 launch-config file, never in argv — and is revoked on
  kill/interrupt/reap. `world_read` is the deliberate exception, argued in its own bullet below.
- **`world_read(kind, ref)` — the harness's view, read out of the store, never re-fetched.** Closes
  the `gh`-shell-out gap: an agent that needed a PR's CI status or review comments had to shell out,
  which is provider-coupled (nothing works under `azure`) and re-fetches what the pulse already holds.
  Things that make it what it is:
  - **`kind` is `pr` / `issue`** (`WORLD_READ_KINDS`, `src/mcp/worldRead.ts`) — the two
    lists a `WorldSnapshot` carries and the three ref prefixes everything else writes, not a new
    taxonomy to keep in step with the rules.
  - **The source is `Store.getWorldBaseline()`**, which is exactly what `Harness.recordWorldChanges`
    persists each pulse. So there is no provider fan-out per agent, no provider-shaped payload, and
    the agent sees the world the dispatch decision was made against. It is a pulse-old reading and
    says so (`observedAt`); the read errors informatively before the first cycle rather than throwing.
    Never route this to a connector — that is the coupling the tool exists to remove.
  - **Same verdicts as the cockpit, from the same functions.** `prHealth` + `basePrOf` +
    `inheritedCiFailure` (all pure, all already there), over the **unfiltered** open list so an
    `-ignore`d base still attributes — the same reason `DispatchContext` carries `excludedPrs`. An
    agent told `CI failing on base PR #7` and an operator reading the same phrase are reading one
    fact. An issue additionally carries its plan graph, which lives only in the store.
  - **`ref` is suffix-tolerant, kind-strict.** `pr:42:ci`, `issue:12:part:schema` and `issue:12:plan`
    all name their world item, so the origin ref an agent is handed in `_status.origin` can be passed
    back verbatim (and omitting `ref` defaults to it). A prefix that contradicts `kind` is an error,
    not a guess. A miss lists the refs the harness is tracking — discovery without a second mode.
  - **It is a general read, deliberately, and the test says so.** It is the first tool where the
    no-cross-origin property doesn't hold by construction. Fencing it to the caller's origin would
    defeat the point: the dispatcher's own reasoning is cross-item, so an agent told its red CI
    belongs to PR #7 must be able to read #7 or it is back to `gh`. What structural identity protects
    is writes; a read forges and mutates nothing, and the cockpit already serves this same snapshot
    unauthenticated over HTTP while this path needs a 0600 bearer token. The part that _is_ kept: an
    agent can only name items the harness already holds, in the harness's own vocabulary — no query,
    no provider passthrough, no path or URL argument, so no reaching another repo or project.
- **`report_finding(kind, ref?, summary)` — what an agent noticed that isn't its task.** Closes
  Exhibit C: "this issue duplicates #41", "the real fix is in a package I don't own", "there's an
  unrelated bug in the module I touched" all used to go into a PR comment and hope. Now they land in
  the `findings` table and the cockpit's Findings panel. The parts that carry the weight:
  - **`kind` is `duplicate` / `blocked` / `out_of_scope`** (`src/mcp/findings.ts`) — three, one per
    gap, split on the axis that matters: each implies a _different operator action_. There is
    deliberately no catch-all fourth; a bucket implying no action is where findings rot, and the
    summary is free text already.
  - **It queues nothing, and that is the design, not an omission.** A queued job is dispatched by
    rule 0 _ahead of every world-driven rule_, so an agent that could queue jobs could put agents on
    the fleet — a capability escalation, and exactly the back-door round the auto-send seam that
    #108's open question 3 warns about. Promotion is the operator's click
    (`POST /api/findings/:id/promote` → `Store.createJob`, `findingJobRequest` carrying the
    provenance into the prompt); `/dismiss` is the other arm. **Nothing in the dispatcher reads
    `findings`.** The tool's description _and_ its response say so, so an agent doesn't report a bug
    and then assume its fix is scheduled.
  - **Identity is structural again, with full force** — the opposite of the `world_read` bullet
    above, and the code says why: a read forges nothing, while this write puts words in an agent's
    mouth in front of an operator and is read as testimony about work its author actually did. So
    the schema is `{kind, summary, ref}` and nothing else; attribution
    (`agentId`/`taskId`/`originRef`) comes from the credential.
  - **`ref` is optional and kind-strict**: the same `pr:`/`issue:` vocabulary, suffix-
    tolerant so an origin ref passes back verbatim, but a **bare number is refused** — unlike
    `world_read` there is no `kind` argument to say whether `41` is an issue or a PR, and a duplicate
    report must not guess. Anything off-vocabulary is refused with "omit ref, describe it in the
    summary": an open-ended ref field is an unqueryable junk drawer.
  - It routes through `AgentManager.recordFinding` (not straight to the store) for the same reason a
    flag does — the `finding` event is what puts it in the cockpit now rather than next pulse — and a
    verbatim repeat (same agent, kind, ref, summary) refreshes the row **without resetting status**,
    so dismissing one means something. Tests: the `report_finding` block in `test/mcpChannel.test.ts`.
  - **Filing a finding as a ticket (`POST /api/findings/:id/file`) is the _defer_ arm beside
    promotion's "work it now"** — the thing a queued job could not express, since a job either runs or
    is cancelled and neither is "deal with this later". Promotion puts an agent on the problem; filing
    puts an agent on the **tracker**. Four things carry it:
    - **An agent files it, with `gh`/`az`, rather than the harness posting through a new
      `IssueCreateCapable` seam.** The _wording_ of a ticket is what an operator has opinions about,
      and a prompt is where those already live: `finding-ticket` is an ordinary overridable entry in
      the template book, so house style is changed by dropping a file in `promptTemplatesDir`, not by
      patching a route. A capability seam would have moved that judgement inside the harness where an
      override cannot reach it. Consequence: the book is no longer only the rule dispatcher's —
      `loadPromptTemplates` is hoisted in `system.ts` and exposed as `System.prompts` so the route
      renders the same under either dispatcher.
    - **The one thing an agent cannot infer is _which_ tracker**, so that is what the harness supplies:
      the pure `trackerCoordinates(config)` renders coordinates from the same config block the
      **`issues` provider** is built from, so a ticket lands where the harness reads issues from and
      nowhere else. Null for `fake` (or a provider selected without its config) → the route 409s and
      the snapshot ships `config.canFileTickets: false`, so the cockpit hides the button off the same
      predicate the route refuses on. It is a **desk** job (filing writes no file), which is exactly
      why the coordinates must be explicit — a scratch cwd has no remote for `gh` to read.
    - **Two statuses, because filing is asynchronous.** `filing` is "an agent is creating it", `filed`
      carries `ticketRef`. Collapsing them would claim a ticket that does not exist yet and leave
      nothing to show for a filing agent that died before making one — which is why a `filing` card is
      drawn among the open ones, not in the resolved tail. `job_id` is **reused** for the filing job
      (a finding is terminal either way, so only one job ever hangs off it); `ticket_ref` is a column
      on an **existing** table and therefore needs its `ensureColumns('findings', …)` entry.
    - **`link_ticket(ref)` closes the loop**, and identity is structural exactly as for
      `report_finding`: the finding is resolved from the credential (agent → task → its `job:<id>`
      origin → the finding that job was created for), so the tool takes only a ref and an agent on any
      other task resolves to none. Same `parseFindingRef` as the finding's own ref (bare number
      refused — nothing here says whether `314` is an issue or a PR), and idempotence is in the write
      (`WHERE id=? AND status='filing'`), not in a read-then-check. Tests: `test/findingTickets.test.ts`.
- **`note_progress(note)` — the agent's own answer to "what is it doing, and is it stuck?"** The
  fleet card's live line is `agent:tail` (`Hub.updateTail`): the last non-empty line the process
  happened to print. It's a byproduct rather than a statement (in stream mode it's as likely to be a
  `renderBlocks` tool label as a sentence), it's **ephemeral** — it lives only in the `Hub`'s map and
  the cockpit's `tails` ref, so a reload or a cockpit opened twenty minutes into a run shows an empty
  card — and it answers "is output still coming out", which is liveness, not progress. Three
  decisions carry this one:

  - **It sits beside the tail, never replacing it.** Same asymmetry as `@@LUBBDUBB_DONE@@` against
    the `result` event: a note an agent forgets to call is _silence_, and silence must not read as
    "no progress". An agent that never calls it leaves a card identical to the pre-tool one — there
    is no placeholder and nothing inferred from output. Where both exist the card shows both: the
    note is a claim (durable, attributed, as old as its timestamp), the tail is evidence the process
    is still emitting.
  - **Latest value, so a column and not a table.** One row per call would be an audit trail, and that
    trail already exists — every call is a tool use in the agent's transcript, in order, with context.
    A second lossier copy in SQLite answers nothing new. What didn't exist is a cheap _current_
    reading for a fleet view, so exactly one is kept: `note` + `noted_at` on the `agents` row,
    overwritten per call, riding to the cockpit inside `listAgents()` with no new snapshot key, no
    route and no panel. Existing table → the pair needs an `ensureColumns('agents', …)` entry in
    `Store.migrate()`. The note deliberately outlives the agent (a finished agent's last note is the
    one-line summary of the run).
  - **`notedAt` is display context, never liveness.** Nothing derives a staleness or health verdict
    from it, and `test/mcpChannel.test.ts` asserts no derived field appears on the shipped agent. The
    reason is that the longest gaps between notes are the long test runs and big refactors — the
    healthiest stretches — so reading age as "stuck" would punish honest use and turn an optional
    note into a heartbeat agents must keep sending. Liveness stays the process, the status
    transitions and the `waiting` park.

  One field, `note`, and the tool's prose says why there isn't a `stage` enum: the only member that
  would imply an operator action is `blocked`, and `escalate` already owns that and does it properly.
  Over-long notes are **trimmed and stored** (with the trim reported) rather than refused — the
  opposite of `report_finding`, because a finding is testimony an operator acts on while a note is a
  status line whose value is being cheap and frequent. Only an empty note is refused. It routes
  through `AgentManager.recordProgress` for the `progress` event, which the `Hub` turns into a plain
  `dirty` (unlike `agent:tail`, the payload is already on the row that the refetch brings).

- **`conclude_part(kind, summary, evidenceRef?)` — the terminal for a plan part that produced no PR**
  (#160; the plan-parts bullet above carries the full argument). Fenced to `issue:<n>:part:<slug>`
  by `partConclusionOrigin`, which refuses every other caller **by name** and points each at the tool
  it actually wants. **`kind` accepts `report` and `determination` only** — a merge is observed, so
  accepting `code` would let an agent declare its own work finished with no pull request behind it.
  The summary is required and refused rather than trimmed when over-long (`conclude_work`'s rule, for
  its reason); the evidence ref is optional, because requiring it would leave a write-up at a path
  `classifyArtifact` doesn't promote unable to close — the parked-plan bug in a narrower case.
  Idempotence is in the write (`WHERE id=? AND status IN ('dispatched','in_review')`).

- **Transport is a Unix socket (named pipe on Windows), never a TCP port** — the cockpit's HTTP
  surface is already unauthenticated on `0.0.0.0`. `bridge.mjs` (spawned by `claude`, shipped `.mjs`
  like `statusCapture.mjs`) is a **byte-transparent pipe** with no protocol logic, so `initialize` /
  `tools/list` / `tools/call` / validation all live in `protocol.ts` + `tools.ts` and are testable
  with no transport at all. A connection that doesn't hand over a token first is dropped unanswered.
- **Two launch flags, both verified empirically** (`claude` 2.1.220, headless `-p`), not assumed —
  the same discipline as the `--settings` hook merge:
  - `--mcp-config` is **additive**. Launched in a cwd holding its own `.mcp.json`, the init event
    reports `mcp_servers: [{theirs}, {ours}]`. So `--strict-mcp-config` is deliberately **not**
    passed: it would suppress the user's own servers in the user's own checkout.
  - `--allowedTools ALLOWED_MCP_TOOLS` is **required**, not defensive. An `--mcp-config` server
    connects with no approval step (a project `.mcp.json` server instead sits at `pending`), but its
    tool _calls_ are still permission-gated and **`acceptEdits` — our default `agentPermissionMode` —
    does not cover them**: without the flag every call returns `"Claude requested permissions to use
mcp__lubbdubb__…, but you haven't granted it yet."` with no human at the prompt. The flag is
    additive, not restrictive (an agent launched with it still uses Bash/Write normally). This is why
    `src/mcp/names.ts` exists: the launch-config key, the tool names and the `mcp__<key>__<tool>`
    grants must agree, and drift between them yields a _connected_ server whose every call is refused
    — invisible until an agent needs it. `test/mcpChannel.test.ts` asserts all three against each other.
  - `--permission-prompt-tool <name>` wires the **permission backstop** (#130 phase B). Passed only
    alongside `--mcp-config` (the tool lives on that server) and only when `mcp.permissionEscalation`
    is on; its value `PERMISSION_PROMPT_TOOL` is derived off the same server id + tool name as the
    grants, so it can't drift. See the permission-model bullet below.
- **`mcpConfigPath` is per-launch, and the `ArgsBuilder` in `src/system.ts` MUST thread it.**
  `AgentManager.spawn` mints the credential and passes `mcpConfigPath` to `buildArgs`; if the
  system.ts closure drops it (as it silently did before #130 — the `ArgsBuilder` type omitted the
  field and every closure ignored it), `appendMcpConfig` never fires and **the whole tool channel is
  dead in production** — no test catches it, because they all drive `mcp.session()` in-process and
  `npm run smoke` builds the bridge by hand from `open()`. `test/mcpChannel.test.ts` now spawns on a
  listening server and asserts `--mcp-config`/`--permission-prompt-tool` actually land on the argv.
- Tests drive `mcp.session(agentId)`, which converges on the same `dispatch` an agent's bridge
  reaches — there is no test-only tool path. `npm run smoke` runs a real `bridge.mjs` child over a
  real socket, which is the half unit tests can't cover.
- **The permission model (#130) — authorise the routine, ask about the rest.** `acceptEdits` (default
  `agentPermissionMode`) auto-accepts _file edits only_, so a headless agent hangs the moment it runs
  `npm run check`/`git`/`gh`, and the escalation it printed was unanswerable (the gate is a launch
  flag, not a conversation). Two mechanisms, same split as `autoSend`: **(A)** `agentAllowedTools`
  merges a `permissions.allow` fragment into `--settings` (`collectSettings`) pre-approving the
  mechanical commands — deliberately **not** `--allowedTools`, which carries the MCP grants (mixing a
  Bash rule in risks dropping them, the exact `names.ts` drift). **(B)** the `request_permission` tool
  - `--permission-prompt-tool`: Claude evaluates allow rules _before_ it, so an allowlisted command
    never reaches it and the unattended path stays synchronous; a miss files an escalation and blocks
    the _same_ agent via the in-memory `PermissionDesk` (`src/agents/permissionDesk.ts`) — **not** a
    `Proposal` (ephemeral single-shot, not a durable re-read verdict). It returns the **bare**
    `{behavior}` verdict (`toolJson`, never `ok()`'s `_status`, never `toolError`), settles the inbox
    out of band (`EscalationInbox.settleResolved`, never typing into a blocked session), and denies on
    agent death via `McpBridgeServer.release` — the one choke point every terminal path hits. Tests:
    `test/agentProtocol.test.ts` (allow-list), the permission-backstop block in `test/mcpChannel.test.ts`.
- **`claim(ref)` was investigated and closed, not forgotten** (#113). Phase 2's table listed it; the
  five tools above are the whole surface, and a sixth should not be added back for symmetry. The
  reasoning, so it isn't re-derived: **origin and branch are 1:1 for every world-driven dispatch
  rule** (`pr:<n>:*`→`pr.branch`, `issue:<n>`→`issue/<n>`, `issue:<n>:plan`→`plan/issue/<n>`,
  `issue:<n>:part:<slug>`→`issue/<n>/<slug>`), so the
  `activeOrigins` / `findActiveTaskByOrigin` gate already _is_ a branch gate and the three existing
  gates leave no dispatch-time collision for a claim to prevent. What they can't see is what an
  agent does once running — and a claim can't fix that either: **advisory** makes it documentation
  an agent may forget, **enforcing** needs a lock that vanishes under `mcp.enabled: false` (a lock
  that silently isn't one), and **letting the dispatcher read claims** would let an agent suppress
  another's dispatch, which is #108's open question 3 in different clothes. The `scope`-violation
  case is not blocked on claims at all: `PlanDocumentSchema` types `scope` as free prose
  (`z.string().min(1)`), so nothing can check it — making it checkable is a schema change, not a
  tool. What shipped instead is the structural detector below.

**Transcript legibility (stream mode).** `StreamJsonSession` doesn't dump raw events. It runs
each message's content blocks through the pure `renderBlocks` in
`src/agents/streamTranscript.ts`: assistant text is passed through (sentinels stripped), a
`tool_use` becomes a labelled line with a one-line input summary, and a `tool_result` (arriving
as a `user` event) is sanitised — ANSI/control chars removed — and truncated to `MAX_RESULT_LINES`
with a "+N more lines" marker. Labels carry SGR colour, which the drawer's HTML transcript pane
renders via the pure SGR parser in `web/src/components/ansi.ts` (the drawer builds coloured DOM
segments, not an xterm terminal — see below); the `Hub` strips ANSI from the compact fleet-card tail
so it never shows as literal escapes. Detection still scans the _raw_ turn text, so keep the
raw-vs-display split intact if you extend rendering.

**Drawer transcript is an HTML pane, not a terminal.** The transcript reaching the cockpit is
already legible text in every mode (`renderBlocks` / settled PTY text), never raw TUI bytes, so
`AgentDrawer` renders it into a scrollable `<div>` (`white-space: pre-wrap; overflow-wrap: anywhere`)
rather than an xterm.js instance: words wrap on their boundaries, the browser scrolls natively (a
full-rewrite `replace` frame no longer snaps you to the bottom — the pane sticks to the bottom only
when you're already there, and offers a "New output" jump pill otherwise), and the text is
selectable. The one terminal feature it reproduces is SGR colour, via `ansi.ts` (pure + tested,
`test/ansi.test.ts`), which parses the five codes `renderBlocks` emits and threads the active style
across streamed deltas. No xterm remains anywhere: the browser-side `@xterm/xterm` +
`@xterm/addon-fit` went first, and `@xterm/headless` went with the server-side screen-scraping
it existed to do.

**Transcript legibility (PTY mode).** The screen is the wrong source. The interactive
claude TUI paints cursor-addressed redraws, so its byte stream carries the slash-command
dropdown, `Tip:` hints, `(ctrl+o to expand)` markers and input-box rules as _content_, with
prose already hard-wrapped at the emulator's column width — and no chrome blacklist recovers
the logical lines. So PTY mode doesn't read the screen at all: Claude Code writes every
session's conversation to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, and since
PTY is the runtime that pins `--session-id`, the harness knows exactly which file is its
agent's. `PtySession` with `sessionTranscript` (wired for `agentMode: 'pty'` only; `raw`/mock
sessions have no session file and stay raw) tails it through `SessionTranscriptTail`
(`src/agents/sessionTranscript.ts`) and renders the records with the _same_ `renderBlocks`
stream mode uses — so both runtimes converge on one legibility seam and the TUI becomes
purely an input device. Consequences worth knowing: the file is append-only, so PTY emits
plain `output` deltas like stream (the old `transcript` full-replacement event, and the whole
`Store.setTranscript` → `agent:transcript` → drawer-replace path behind it, is **gone**);
records are written per content block as each completes, so the transcript is live at block
granularity, not token-by-token; the file is located by globbing `<root>/*/<id>.jsonl` rather
than deriving the directory-encoding rule, so an encoding change can't break it; and
`parseSessionEntries` must drop **local-command envelopes** (`<local-command-caveat>`,
`<command-name>`, `<local-command-stdout>`) or `exitOnDone`'s `/exit` reintroduces exactly the
noise this replaced. Human/injected messages render too (the `human` block), so the drawer
shows both halves of the conversation. Tests: `test/sessionTranscript.test.ts`.

**Sentinel detection is two-source (PTY).** The session file is the _primary_ detector —
clean text through the same `stripSentinels`/`extractWaitingReason` helpers stream mode uses,
so the styled-token bug class simply can't occur there. The raw-stream `scanSentinels` scan
stays as a **backstop**: a terminal sighting is deferred by `SENTINEL_BACKSTOP_MS` to let the
file claim it first, and if that never happens the terminal detection is applied _and_
`onWarning` records it, so drift shows up in the Errors panel instead of rotting silently.
Two detectors that quietly disagree is the bug fixed once in `fd560e6` — the announcing
property is what stops it recurring. The deferral is skipped entirely when the tail hasn't
located a file (`SessionTranscriptTail.located()`), otherwise every transition would wait the
full window on a source that may never speak. Both paths converge on `noteSentinel`, and each
transition is idempotent, so a double report is harmless.

**Exit on done (issue #66).** The interactive claude REPL has no natural end — after a turn
it sits at the prompt forever — so the done sentinel alone would orphan the process and leak
its worktree. `PtySession` with `exitOnDone: true` (wired for `agentMode: 'pty'` only, like
`legibleTranscript`; raw/mock processes exit by themselves) therefore tears the REPL down
after the sentinel-driven `finish('done')`: it writes `/exit` + a delayed Enter (the same
paste-vs-keypress split as `send`, but bypassing the status guards — status is already
`done`), with a `SIGTERM` backstop after `exitGraceMs` (default 5s); `reportExit` already
ignores exits on a `done` session, so neither path reclassifies the finish as `failed`.
`AgentManager` then emits **`reaped`** once a finished (done/failed) agent's process has
_actually exited_ — the two signals arrive in either order (PTY: sentinel first; stream:
exit first) — and the composition root reacts to a `done` reap by removing the task's
worktree via `WorktreeManager.remove` (its only caller). Sequencing matters: a live process
pins the worktree cwd. Failed/killed agents keep their worktree for debugging, and a
shared branch with another active task is left alone. Tests: `test/ptyExitOnDone.test.ts`,
`test/worktreeCleanup.test.ts`.

**Usage capture (issue #60) — two mode-specific sources, don't conflate them.** Stream
mode: each `result` event's _cumulative_ `total_cost_usd`/`usage`/`num_turns` becomes a
`usage` session event (cache tokens folded into input), which `AgentManager` persists via
`Store.recordAgentUsage` — cumulative values onto the `agents` row, the cost _delta_ as a
timestamped `usage_events` row so `/api/state` can SUM rolling 5h/7d cost windows. PTY
mode reports no per-turn usage; instead it captures the **account rate limits** (the
Pro/Max `rate_limits` in the status-line payload — the one programmatic surface for
them): `buildClaudeArgs({ statusLine: true })` wires a `--settings` status command that
atomically dumps each payload to `$LUBBDUBB_STATUS_FILE` (per session id, set in the
spawn env, under the OS tmpdir), and `StatusFileRateLimits.readLatest()` feeds the
freshest one into the snapshot's `usage.rateLimits` (null when absent — the cockpit chip
then falls back to the cost windows). Parsing is pure (`parseStatusLinePayload`,
`src/agents/statusLine.ts`); tests in `test/usage.test.ts`.

### Crash recovery — the harness stopped deciding this for you

A restart kills every agent. The old boot reconciler resumed whatever looked resumable and
buried the rest as `interrupted`, and then the boot cycle dispatched new work over the top —
three decisions an operator has an opinion about, none of which was ever put to anyone. Worse,
it went on staffing the fleet while its own model of that fleet was a lie: rows saying `running`
with no process behind them. So detection no longer decides, and the pulse **holds** until it
has been decided. **What is orphaned is the _work_, not the process** — the unit of recovery is
the task and the agent is optional throughout (`decide(taskId, …)`, `POST /api/recovery/:taskId`,
`OrphanedWork.agentId` nullable), because a restart orphans work two ways. What carries it:

- **The pending set is the rows, not a field.** `RecoveryDesk.detect()` (`recoveryDesk.ts`,
  boot, before `runCycle('boot')`) stamps each orphan `crashed` — a new `AgentStatus` that is
  neither live (`countLiveAgents` excludes it, so a dead row stops eating the cap and stops
  reading as running) nor terminal (`restore` puts the same row back to `running`). Being
  derived is what makes it survive a second restart with nothing to persist, makes `detect`
  idempotent, and stops two cockpits disagreeing. Each verdict moves the row **out** of the
  candidate set — restore makes it live, requeue and remove settle its task — so "already
  decided" needs no separate record, which is the same property the old task check relied on
  to keep a cockpit kill dead. An already-`interrupted` row is left **unstamped**: that is what
  preserves crash-vs-clean-shutdown (`OrphanedWork.died`) with no column to hold it.
- **The second arm is a task with no agent row at all, and it is the worse one.** The executor
  writes the task row and _then_ spawns, so a restart between the two leaves a `queued` task
  nothing is working — and `queued` is _active_ to `activeOrigins`, `findActiveTaskByOrigin` and
  `findActiveTaskByBranch` alike, so its origin and branch are held shut **permanently** while the
  dispatcher reports "nothing actionable" against an idle fleet. `isRecoveryCandidate` is keyed on
  an _agent_ row, so nothing saw it; the hazard was already written down in `crashRecovery.ts` as
  the reason requeue files a job, and now it is also detected. `isAgentlessCandidate` (pure): an
  outstanding task, no agent row pointing at it, **created before this process booted**.
  - **Nothing is stamped, deliberately.** `crashed` exists because an agent row _lied_ (claimed
    `running` with no process), so something had to be written to stop it counting as live. A
    `queued` task with no agent tells the truth about itself; what was missing was a reader. And
    there is no honest status to move it to — every task status that is not outstanding is
    _terminal_ to the three gates, so a new one would either go on wedging the origin or force
    every gate, present and future, to learn a fourth state. The set is computed, and both verdicts
    available to it settle the task, which is what removes it and keeps `detect()` idempotent.
  - **`bootedAt` is the one input not read off a row, and it is load-bearing.** The set is
    re-derived on _every pulse_ (the hold asks for it) and a live dispatch is transiently agentless
    for exactly the window this arm cleans up after; a task older than this process cannot be one.
    Constant per process, so two readings never disagree; `buildSystem`'s `bootedAt` option is the
    test seam. `hasAgent` is asked of the agent **rows**, not `task.agentId` — `spawn` writes the
    row first and back-fills the column, so reading the column lists one piece of work twice.
  - **The window itself is left open, and should stay open.** It cannot be closed, only moved:
    `spawn` needs the task row, and a transaction cannot span a process spawn. Reversing the order
    trades an agentless task for an agentless _process_ — a live `claude` with no row, invisible to
    the cap, to `kill` and to recovery itself — which is strictly worse.
- **The hold is the whole pulse, and it is asked before the world fetch.** Not dispatch alone:
  with undecided orphans every verdict a cycle reaches — merges, replies, plan reconciliation —
  is reached against a fiction, so fetching the world at all is wasted. `runCycle` returns
  `cycleId: 'held'` and emits nothing (same shape as `coalesced`, same reason: no cycle ran).
  Re-asked each beat, so it lifts by itself when the last decision lands — there is no un-hold
  to call and no restart. `test/crashRecovery.test.ts` asserts the world is never fetched.
- **Detection dismisses no escalations.** The old fallback cascade-dismissed them, which is
  right for an agent that is definitely dead and wrong for one that may be restored in a
  minute — a restored agent must come back to the question it parked on. So the dismissal moved
  onto the two verdicts that actually end the agent, and `POST /api/escalations/:id/answer`
  **409s** while its agent is pending (third arm, after proposals and permission requests, for
  the same reason: there is nothing to type into).
- **`requeue` files a job; it cannot reset the task.** A `queued` task with no agent is _active_
  to `activeOrigins`, `findActiveTaskByOrigin` and `findActiveTaskByBranch` alike, so parking
  the work there would wedge its origin and branch shut for good. The job (`requeueJobRequest`,
  pure) carries the original prompt verbatim under a preamble naming the origin, the branch that
  may already carry commits, and the crashed agent's last `note_progress`. Cost, stated: the
  origin becomes `job:<id>`, so the link back to `pr:42:ci` is provenance in prose, not a ref a
  gate keys on. Its signature is `(task, prior)`, `prior` being null when no agent ever ran — the
  two arms say materially different things and must not be collapsed: a task whose agent never
  spawned has had **nothing** done to it, and telling a fresh agent its branch may carry commits
  sends it looking for work that was never started. Settling the task is the load-bearing half of
  both terminal verdicts, and the only half an agentless orphan has; it has no escalations by
  construction, since an escalation is raised by a process and none ever ran.
- **A refused restore is not a decision.** `restorability` (pure) decides whether it is on offer
  and carries _why not_ (**no agent ever started** — answered first, since it makes the rest moot —
  then no session id / worktree gone / runtime can't resume) so the cockpit
  shows the reason instead of a missing button; a refusal or a `resume()` that returns false
  leaves the row `crashed`, so requeue and remove stay available and the hold stands.
- There is deliberately **no config knob to auto-restore**. It would be the old behaviour under
  a new name, and the point of the feature is that this is always asked.
- **Chosen session id** (unchanged). `AgentManager.spawn` mints a UUID (only when
  `opts.resumable`, i.e. PTY) and `buildArgs` passes it as `--session-id`; it's persisted on the
  `agents` row (`session_id` column). Restore passes `--resume <id>` instead. `buildClaudeArgs`
  **re-appends** the protocol system prompt on resume — `--resume` does _not_ retain it, so
  detection would break otherwise.
- **Shutdown ≠ kill** (unchanged). `AgentManager.interruptAll()` (server shutdown) marks agents
  `interrupted` and leaves the task status alone; `kill()` (cockpit button) marks `killed` and
  sets the task `interrupted` — excluded on both counts, so it stays dead.
- **`waitingReason` is the state signal.** `interruptAll` overwrites status to `interrupted` but
  preserves `waitingReason`, so `resume()` knows whether the agent was parked on a human
  (restore its escalation, no nudge) or mid-work (nudge it to continue).
- Stream-JSON resume is still out of scope (those agents get requeue/remove only).
  `spawn`/`resume` share their listener wiring — change one, change both. Tests:
  `test/crashRecovery.test.ts`, `test/resume.test.ts`.

**Marking an agent done (`AgentManager.complete`).** The clean `done` terminal used to be
reachable only by the _agent_, via the sentinel — and in stream mode a turn that ends without
one doesn't fail, it parks `waiting` on "ended its turn without finishing". So an agent that
did the work and forgot the sentinel could be ended only by `kill`, which records the
opposite: task `interrupted`, worktree kept, an abandonment in the log. `complete` is the
missing verdict. It stops the process and routes through the **same** `handleTerminal(…,
'done')` the sentinel drives, so nothing about a completed agent differs from a finished one.
Three things carry it:

- **`session.kill()` marking the session `killed` is fine and load-bearing.** That flag exists
  only to stop the _session_ reclassifying its own exit (`reportExit` / `onExit`); here the
  **manager** decides the record, and it decides `done`.
- **`exited` is left alone — the one line that is the inverse of `kill`**, which deletes it so a
  killed agent is never reaped and keeps its worktree for triage. Both runtimes emit `exit`
  _before_ their killed early-return, so the exit still lands, `maybeReap` finds a `done`
  terminal, and the reap removes the worktree. That clean finish is the whole point of saying
  done rather than killing.
- **Liveness is the whole guard** (a non-live agent 409s): re-labelling a settled record is a
  different question. The `done` event carries `by: 'agent' | 'operator'` so `system.ts` can
  dismiss the escalation the agent was parked on — an answer would route into a session that no
  longer exists. A _sentinel_ done with an open escalation is the same latent class and is
  deliberately **not** swept with it. Audited under cycle id `human:<agentId>` with **no
  proposal**: the act is the operator's own and already taken, where a proposal is a standing
  verdict a rule re-reads. `DecisionLog` badges "you" off the `human:` prefix itself, the
  proposal supplying only the note when there is one. Surfaced on the agent card, the drawer,
  and the escalation card — the last beside the transcript link rather than among the quick
  answers, since those route through `agents.respond`, which types text in and flips the agent
  back to `running`. Tests: `test/agentComplete.test.ts`.

Sharp edge in `PtySession.kill()`: it sets status `killed` **before** signalling the process,
because a synchronously-delivered exit would otherwise be reclassified as `failed` (firing a
terminal event). Keep that ordering.

Sharp edge in `PtySession.send()`: the message text and its submitting carriage return are
written as **two separate writes**, `agentSubmitDelayMs` apart (default 60ms). The claude TUI
coalesces a single input burst into a paste and treats a trailing CR as a literal newline, so a
glued-on CR leaves the message sitting in the input unsubmitted. Trailing newlines in the text
are stripped so the lone CR does the submitting. This is why `send`-related test assertions look
for the payload as its own write (not `payload\r`) and await the delayed CR — don't re-glue them.

Sharp edge in `PtySession.deliverInitial()` (the first-message boot race): a freshly-booted
claude REPL paints its input box a second or two before its input loop honours a submitting
Enter, so the first Enter is silently dropped and the pasted prompt sits unsent — the "agent
pauses after the first message" bug. The prompt is pasted **once** (a re-paste accumulates it
in the box) and only the bare CR is re-sent until the message lands. "Landed" is **observed, not
timed**: the session file records a `user` entry the moment the REPL accepts a message, so a
rise in the tail's accepted-message count is direct proof the paste was submitted — no emulator
and no screen reading involved. Without a session file (`raw`/mock sessions) there's nothing to
observe, so it degrades to the original blind open-loop nudge, bounded by
`initialSubmitAttempts`. Tests (`test/ptyInitialSubmit.test.ts`) append session records by hand,
since `FakePtyBackend` runs no real claude.

## Testing patterns

Tests build a full `System` with fakes injected via `buildSystem(config, opts)`:

- `opts.backend = new FakePtyBackend()` — scripted PTY, no native `node-pty`
  (`src/pty/fakeBackend.ts`; drive it with `.last().emit(...)` / `.emitExit(...)`, inspect
  `.writes`).
- `opts.streamSpawner` — a fake child process for the stream-JSON runtime.
- `dbPath: ':memory:'` — in-memory SQLite.

So you can exercise the whole inject → dispatch → agent → escalate → answer → done loop
without a model or a real terminal. Prefer adding tests at that seam. Put new tests in
`test/*.test.ts`; don't edit unrelated test files.

The **real `github` provider** (`src/integrations/github/`) follows the same pattern: all
GitHub HTTP is behind the narrow `GitHubApi` seam (`githubApi.ts`), `OctokitGitHubApi` is the
only file that imports octokit, and tests (`test/githubIntegration.test.ts`) inject a scripted
fake `GitHubApi` — no network. The field-mapping logic (CI aggregation, approval folding,
comment threading, linked-PR-from-timeline) is exported as pure functions and tested directly.
When you extend it, add to the `GitHubApi` interface + its fake together, and keep new mapping
logic in pure functions so it stays unit-testable without HTTP. `mergeable_state` and `base.ref`
map through this seam too (→ `PullRequest.mergeableState` / `baseBranch`); add a field to the
`Gh*` type _and_ the scripted fake in the same change.

The **`azure` provider** (`src/integrations/azure/`, Azure DevOps Repos + Boards) is the exact
same shape: all HTTP behind the narrow `AzureDevOpsApi` seam (`azureDevOpsApi.ts`),
`RestAzureDevOpsApi` (`restAzureDevOpsApi.ts`) the only file that touches the network _and_
resolves auth, and tests (`test/azureDevOpsIntegration.test.ts`) inject a scripted fake
`AzureDevOpsApi`. Mapping logic — CI aggregation from branch-**policy evaluations**, approval from
reviewer votes, `mergeStatus`→`MergeableState`, thread→comment folding, linked-PR-from-relations —
is exported as pure functions and tested directly. **CI status comes from policy evaluations, not
the PR `statuses` endpoint**: that endpoint returns every status ever posted across _all_ iterations,
so a stale `failed` from a superseded push poisons the PR forever (the false-"failing" bug).
`aggregatePolicyCiStatus` instead reads `listPolicyEvaluations` (`/_apis/policy/evaluations`, keyed by
the `vstfs:///CodeReview/CodeReviewId/{projectId}/{prId}` artifact — so `RestAzureDevOpsApi` resolves
the project GUID once) and folds only _enabled, blocking_ CI-type policies (build-validation +
status; reviewer/comment/work-item policies are human gates that map to `approved`/`unresolvedComments`
instead). **That fold is frozen, and three invariants keep it that way** — it is what `prHealth`'s
blocked verdict and rule 3's merge test read, so anything an operator can widen must be structurally
unable to claim a PR cannot merge when Azure would complete it:

- **No configuration reaches `aggregatePolicyCiStatus`.** Widening happens in `listPolicyCiChecks`,
  which is a **different, wider** list: it carries `blocking` per check and surfaces _Optional_
  (non-blocking) policies too, plus whichever non-CI kinds `azureDevOps.policyChecks` names. Policy
  kinds live in the pure `azure/policyKinds.ts` (`policyKindOf` + a kind→mode map, `check` /
  `advisory` / `off`), which `config.ts` validates without importing the provider.
- **Rule 1, `inheritedCiFailure` and `prAttention` all gate on `ciNeedsAttention`** (`prHealth.ts`) —
  the aggregate _or_ any non-advisory failing check. A fourth reader added later must use it too, or
  the cockpit tells an operator a PR is nobody's turn while an agent is being dispatched for it. The
  `inheritedCiFailure` call site is load-bearing rather than tidy: a non-blocking check runs the
  base's commits like any other, so reading the aggregate there would put a doomed agent on every PR
  above one red format check.
- **An `advisory` check is filtered out by both `classifyCiFailures` and `ciNeedsAttention`**, so no
  `ci.checks` rule — not even `match: '*'` — can claim one. That is what keeps the comment policy
  (advisory by default) from outranking rule 2b, which holds the same signal with the thread's author
  and body attached. Known, deliberately unfixed: `buildUnresolvedComments` marks a thread handled
  when the bot authored its last comment, so an agent's reply settles it for the harness while Azure
  keeps the policy red — the advisory check is what makes that divergence visible.

A policy's name resolves through `settings.displayName` → `statusGenre/statusName` →
`context.buildDefinitionName` → the policy type's own (`policyDisplayName`, exported and unit-tested).
The third arm is not cosmetic: `settings.displayName` is null for every build-validation policy whose
operator never typed one, which on a real repo is most of them, so a repo's **required** builds were
skipped as nameless and could not be reached by a `ci.checks` glob at all.

Auth is unlike GitHub's single env token: `resolveAzureAuth`
prefers `AZURE_DEVOPS_PAT` (Basic) and otherwise shells out to the logged-in `az` CLI (Bearer,
cached), so it's the one place `az` is invoked. Work-item **tags** map onto `Issue.labels`, so the
provider-agnostic pickup/priority gates work unchanged. Merging is Azure "complete PR", which
needs the head commit — the source-control integration caches each PR's `lastMergeSourceCommit`
from the last snapshot, so a `merge_pr` only works on a PR seen in a prior cycle.

The work item's raw **`System.State`** (unlike `Issue.state`, which collapses to open/closed) is
preserved on `Issue.workItemState`, which drives two _state-based_ (not label-based) dispatcher
knobs — orthogonal to the watch/ignore label gate below, don't conflate them. Both are off unless
configured, so standard setups don't regress: **(1)** `issuePickupStates` gates rule-4 pickup to
items in an allowed workflow state (e.g. `["Ready","Doing"]`) via the pure `isIssuePickupEligible`
— items with no `workItemState` (github/fake) bypass it. **(2)** `issueInReviewState` (e.g.
`"In Review"`) is the back-off: when a PR is open for a still-in-pickup work item (matched by its
`issue/{n}` branch or `linkedPrNumber`), the dispatcher emits a new **`set_work_item_state`** action
that PATCHes `System.State`, so the item drops out of pickup while it waits on review/CI instead of
being re-picked every cycle. It's idempotent (once moved, it no longer matches) and routes through
a new outbound capability, `WorkItemStateCapable.setWorkItemState` on the `ActionSink` seam (the
same add-to-the-seam-and-its-fake pattern as `setPrLabel`), implemented by the fake + azure `issues`
providers. Unlike `reply_on_pr`/`merge_pr` it is _not_ auto-send gated — it's mechanical bookkeeping,
so the executor runs it directly.

## PR health & one-agent-per-branch

- **`src/prHealth.ts`** holds the pure PR predicates — `prHealth(pr, openPrs?)` (the
  `{ blocked, reasons }` verdict rendered in the cockpit and included per-PR in
  `buildStateSnapshot`), plus `needsBaseUpdate(pr)` and `isConflicted(pr)`, which the dispatcher's
  conflict/behind rule consumes, `isPrExcluded(pr, label)`, and the stack pair `isStackedPr` /
  `basePrOf` / `inheritedCiFailure` (see "Stack safety" above). Keep these pure and unit-tested
  (`test/prHealth.test.ts` / `test/prExclusion.test.ts` / `test/stackedPrs.test.ts`); don't inline
  the logic.
- **`src/ci/ciPolicy.ts` decides rule 1 per failing check, and it exists because `ciStatus` is a fold.**
  One aggregate verdict meant one response to every failure. That is right for a broken build and wrong
  three ways: a lint failure has a house fix, a flaky suite wants latitude, and a red check another team
  owns is not fixable by an agent at all — dispatching into that last case burns the origin's attempt cap
  and ends in a cooldown escalation blaming the agent for a wall it was never getting through. So
  `PullRequest.ciChecks` carries the names the fold used to discard (GitHub check-runs + commit statuses,
  Azure blocking policy evaluations), and `classifyCiFailures(checks, policy)` says what to do. Five things
  carry it:
  - **Two silences are deliberately different.** A provider reporting **no checks** is missing detail, not
    reporting health, so the verdict is `actionable` with empty lists — today's behaviour, which is what
    keeps the `fake` provider and every persisted pre-feature row working unchanged. A check matching **no
    rule** is actionable _and named_, so a CI job added next week gets fixed rather than silently parking
    every red PR forever. Config is purely additive; the escape hatches are opt-in per check.
  - **The verdict is per PR, not per check**, because one agent works a branch: all its failures are one
    job. Distinct origins per check (`pr:42:ci:lint`) would buy nothing — the branch gate collapses the
    second into a `respond_to_agent` note anyway — so the guidance from every matched rule is **appended**
    to one prompt. Appended, not interpolated: `pr-ci-fix` is operator-overridable and `loadPromptTemplates`
    rejects only _unknown_ placeholders, so a `{checks}` token would be silently dropped by exactly the
    overrides that customised most. Same reason the rejection note and the outstanding-work note append.
  - **Held checks are named to the agent, not hidden from it.** An agent that cannot see them watches CI
    stay red after a correct fix and starts chasing a failure that was never its own.
  - **Escalate fires only when nothing is dispatchable** (rule `pr-ci-blocked`, 1b). An escalation
    alongside a dispatch asks a human to look at a PR an agent is already working. Asked **once**, deduped
    on both an open escalation for `pr:<n>:ci` _and_ a recent executed one in the audit log — each covers
    the other's blind spot (an inbox item outliving the decision window, a decision outliving the item).
  - **`urgent` is a boolean, not a rank.** The harness already has one numeric priority axis
    (`priority_overrides` / `rankByPriorityOverride`); a second claiming to order the same queue is two
    answers to one question. `loadConfig` **throws** on `guidance`/`urgent` attached to a rule that never
    dispatches — both are written for an agent that would never be sent, and dropping them silently is the
    3am failure. Tests: `test/ciPolicy.test.ts`.
- **`src/prAttention.ts` is the second PR verdict, and it answers a different question (#123).**
  `prHealth` answers _can this merge_; `prAttentionStatus(pr, ctx)` answers **whose turn is it** —
  `{status, reasons}` over `done` / `ignored` / `you` / `harness` / `elsewhere` / `settled` /
  `stalled`, first matching arm wins. They are kept apart because they have different right answers
  for the same PR: a stacked PR with red inherited CI is honestly `CI failing on base PR #7` to the
  first and `waiting on PR #7` to the second, and a PR with three unresolved comments and an agent on
  the branch is `3 unresolved comments` to the first and `an agent is working this branch` to the
  second. Fold them and one answer is a lie every time they disagree. Four things carry it:
  - **`last_actor` could not be the predicate**, which is why #109 spun this out rather than porting
    it. That signal works on a closed two-party board where every state change has a participant
    actor; ours is not closed — CI going red, a base branch moving, a third-party review landing all
    arrive through `worldDiff` with **no participant identity attached**, and they are the most common
    reason a PR needs attention. What transfers is the _discipline_ (`issuePickupStatus`'s: many gates,
    one pure verdict, reasons), not the signal. `PrComment.author` is the one place identity genuinely
    exists and is deliberately **not** branched on — an unhandled comment dispatches rule 2b whoever
    wrote it, so `handled` decides and the author only ever appears in the wording of a reason.
  - **It is a lens: nothing in the dispatcher reads it**, following `findings`/`overlaps` and not the
    pending-proposal gate. Every input it folds is already a gate that fires on its own (the branch
    gate, `proposalHold`, `dispatchVerdict`, `isPrExcluded`), so a rule reading it would be a _second_
    opinion about a decision made elsewhere, from a function sitting nowhere near the rule it
    duplicates — the drift class already paid for twice. `test/prAttention.test.ts` asserts it
    structurally (one importer: `src/server/app.ts`) **and** behaviourally (building the snapshot
    between two pulses changes no decision), rather than trusting the import graph.
  - **`settled` and `you` are the two arms that did not exist before.** A pending proposal is named on
    the PR row rather than deferred to "Needs you": that inbox counts open escalations across the whole
    world, and the row not saying why it is stalled is exactly the four-panel re-derivation this
    removes — the cost, one PR in two places, is paid by quoting the proposal id so the surfaces join.
    A standing rejection is _nobody's_ turn by design (#122), and was invisible, which is the same
    invisibility `capped`/`unapproved` were added to `QueueItem` to fix; it quotes the note you left.
    The `settled` arm asks `proposalHold`, **not** the proposal row, so a rejection the world has
    overtaken stops reading as settled at the instant rule 3 starts firing again.
  - **It reads the same lists the predicates beside it read** — the **unfiltered** open PR list
    (dispatch world + `ctx.excludedPrs`), so an `-ignore`d base still attributes exactly as
    `inheritedCiFailure` needs. `-ignore` on the PR itself is a **status**, checked first, because the
    harness filters those out of the dispatch world entirely and every arm below would be describing
    rules that cannot fire. The concern list and the merge-readiness test are re-derived from the same
    predicates rather than shared with the dispatcher (which builds prompt-bearing concerns) — the same
    relationship `issuePickupStatus` has to rule 4. Shipped per-PR in `/api/state` as `attention` and
    drawn by `attentionChip` in `web/src/App.tsx`, which names the court only and leaves the detail to
    the health chip. Tests: `test/prAttention.test.ts`.
- **Issue pickup state is the mirror on the issue side.** `isIssuePickupEligible` returns
  `{ eligible, reasons }` (not a bare bool) for the intrinsic policy gates, and the pure
  `issuePickupStatus(issue, ctx)` (both in `src/dispatcher/issuePickup.ts`) folds in the
  contextual gates — active task on the origin, `dispatchVerdict` cooldown/escalation, and
  pause/headroom — into one per-item `{ eligible, status, reasons }` verdict.
  `buildStateSnapshot` attaches it per-issue as `pickup` (reading the policy via
  `System.issuePickup` and `DEFAULT_COOLDOWN` — the same inputs rule 4 consults, so the
  verdict predicts the next cycle), and the cockpit renders it as the per-issue chip
  (`pickupChip` in `web/src/App.tsx`). If you add a pickup gate, extend both the pure
  verdict and its tests (`test/issuePickup.test.ts`) in the same change.
- **Watch/ignore tags (derived from `labelPrefix`).** The `-ignore`/`-watch` pair is the operator's
  "leave it alone"/"work this" signal, resolved by `src/watchLabels.ts` (see the Gotchas note). PR
  side: `harness.ts` filters `-ignore`-tagged PRs out of the world it hands the dispatcher (via
  `isPrExcluded`), so **both** dispatchers ignore them uniformly, while the cockpit snapshot (reads
  the connector directly) still shows them with their health. Issue side: the opt-in watch
  gate leaves un-watched items visible but unacted-on. The cockpit's per-row toggle writes the tags
  back through outbound capabilities on the `ActionSink` seam, routed by `CompositeConnector`:
  `PrLabelCapable.setPrLabel` (fake + `github` + `azure` sourceControl, `setPullLabel` on each `*Api`),
  `IssueLabelCapable.setIssueLabel` (fake + `github` + `azure` issues; GitHub reuses the labels API,
  Azure read-modify-writes `System.Tags` via `setWorkItemTag`). Add to the seam + its scripted fake
  together, same as the other outbound actions. Endpoints: `POST /api/prs/:n/exclude` (`{excluded}`)
  and `POST /api/issues/:n/watch` (`{watched}` — writes the `-watch`/`-ignore` pair, mutually
  exclusive). They're label writes, **not** dispatcher actions.
- **`IssueCommentCapable.upsertIssueComment`** is the same pattern for the plan's status comment
  (fake + `github` issues via the issue-comments API + `azure` work items via
  `/_apis/wit/workItems/{id}/comments`). It takes a `commentRef` and hands one back, so a plan
  keeps **one** living comment rather than a stream — GitHub's `GhCommentRef` grew an `id` for
  exactly that, and Azure addresses an edit by (work item, comment). Called by the plan reconciler,
  not by the executor: like `set_work_item_state` it's mechanical bookkeeping, so it isn't
  auto-send gated, and the one-comment rule is what keeps it from being noise.
- **A review is answered as a whole, and only a reply settles a thread.** Two defects, one area.
  - **Rule 2b dispatches per PR (`pr:<n>:comments`), not per thread.** A review is written as a unit —
    the same person leaving three comments in one pass, each assuming the others — so one concern per
    thread put one agent on each, a cycle apart, and a fix for comment 1 landed without comment 3 in
    view. The threads are **appended** to the rendered prompt (`reviewThreadsNote`), never
    interpolated, for `ciFailureNote`'s reason; `{author}`/`{comment}` stay declared and filled so an
    override written against the old one-comment prompt still renders something true.
    **De-dup stays per thread** and must: `PrConcern.signals` carries `pr:<n>:comment:<id>` refs, and
    keying notification on the collapsed origin would let a reviewer's first three comments swallow
    the fourth — the signal an operator sends while watching an agent work. `activeOrigins` sees task
    origins only, so it cannot tell that the running agent was launched with those threads; that is
    what `dispatch_code_agent.signalRefs` + `dispatchedSignalsByBranch` record. The same split is why
    `rejectionGuidance` takes a **list** of refs (origin + signals): a refused `reply_draft` is filed
    against one thread, so matching the origin alone would have silently stopped every operator
    refusal reaching an agent — that feature's own opening failure, restored by a rename.
  - **`handled` is positional, never an identity test.** `viewerLogin` is whoever holds
    `GITHUB_TOKEN`, which on a single-operator deployment is the operator — so comparing a thread
    _root's_ author against it marked every review comment the operator left as handled the instant
    they wrote it, and the harness silently ignored exactly the reviews a human took the time to
    write. No author comparison fixes it; the two identities are one string. The harness only ever
    posts _replies_ under a root (a `commentId: null` reply is an issue comment, absent from this
    list), so "the newest **reply** is ours" is the whole of what `handled` can honestly mean, and it
    is right for a bot account too. Azure keeps its native `resolved` status as the primary arm.
    Consequence: nothing else settles a thread, so one an agent fixed _in code_ stays open until a
    reply goes out or the reviewer answers — bounded, because the whole review now shares one attempt
    cap and escalates once. Tests: `test/reviewThreads.test.ts`, the review blocks in
    `test/ruleDispatcher.test.ts`, and the operator-thread cases in the two integration tests.
- **One code agent per PR branch.** The PR rules never dispatch a second agent onto a branch that
  already has an active task. When the branch's agent is **running**, a fresh signal is delivered
  via `respond_to_agent` (the note records the concern origins in `originRefs`); when it's
  **waiting**, the note is **held** (don't inject — `agents.respond` flips `waiting → running` and
  would derail a human escalation). Notify de-dup reads `DispatchContext.recentDecisions` (wired in
  `harness.ts` from `store.listDecisions`), so a persistent signal isn't re-notified every cycle.
- **`src/fileOverlap.ts` is the blind spot behind all of the above** (#113). Those gates are keyed
  on what the dispatcher _dispatches_ — a branch, an origin, a plan's part budget — and are complete
  for that. None can see what an agent does once running: two agents on two branches, each within
  its own gate, both editing one file. Git reports it only when the hunks collide; when they don't,
  the second merge quietly undoes or duplicates the first. The pure `detectFileOverlaps` joins
  `agent_files` **across** agents (the rows the file-events hook already writes for everyone,
  needing no prompt-side knowledge and no tool channel — which is exactly what an advisory `claim`
  could never be) and reports paths written by agents whose lifetimes overlapped. Three narrowings
  carry it: **code tasks only** (a desk agent's scratch-dir `notes.md` is not another's),
  **concurrency not history** (without it every long-lived file reports), and **agent lifetimes not
  write timestamps** (a file row is deduped per agent+path, so its timestamp dates the _last_ write).
  `lifetime()` is the one reading of "still going" so the concurrency test and the panel's `live`
  flag can't disagree. `sameWorktree` marks the bad case: `WorktreeManager` is reuse-first, so one
  branch is one directory — two live agents there are editing one file on disk with no merge to
  reconcile them. It is **diagnostic only** — nothing in the dispatcher reads it, for the same reason
  nothing reads `findings` — and it is deliberately after-the-fact, which is the trade for being
  structural. Shipped in `/api/state` as `overlaps` + `web/src/components/OverlapPanel.tsx`.
  Tests: `test/fileOverlap.test.ts`.

**External references → links.** URL construction lives in the provider, never in `web/`. The
github providers implement the `RefResolvable` capability (`resolveRefUrl(ref)`, backed by the
pure `githubRefUrl` in `src/integrations/github/refUrl.ts`); `CompositeConnector.resolveRefUrl`
routes to it. The server builds a `ref → URL` map (`buildRefUrls`, `src/server/refUrls.ts`) into
the `/api/state` snapshot as `refUrls`, and the cockpit looks refs up there (`linkify` / `refLink`
in `web/src/components/util.tsx`) — it never string-builds a `github.com` URL. A provider that
can't resolve a ref returns `null`; the ref then renders as plain text (the `fake` provider's
behaviour). If you add a new ref shape, extend `githubRefUrl` (+ its unit test) and, if it's a new
structured field, feed it into `buildRefUrls`.

- **A comment the harness maintains on a ticket is stored as a provider id and shipped as a ref
  (#171).** The plan's status comment and the goal assay's refusal are the two, and both are written
  against the world **without anyone authorising them** — mechanical bookkeeping, deliberately not
  auto-send gated, kept from being noise by the one-comment rule. Both of those calls rest on an
  operator being able to _read_ the comment, which they could not: `plans.status_comment_ref` and
  `issue_assays.comment_ref` were server-side only. What the store keeps is the right value for
  `upsertIssueComment` to round-trip and exactly the wrong one to put on the wire — an id resolves to
  nothing alone, and `githubRefUrl` reads a bare number as an **issue number**, so shipping one keys a
  confident link to an unrelated ticket. `issueCommentRef(originRef, commentId)` (pure,
  `src/server/refUrls.ts`) pairs it with its issue into `issue:12:comment:456`, the same suffixed
  vocabulary as `issue:12:plan`; `githubRefUrl` resolves that to `/issues/12#issuecomment-456`
  (**numeric ids only** — another provider's would build an anchor that scrolls nowhere, so it falls
  through to the issue page). One function builds the shipped value _and_ feeds `buildRefUrls`, so the
  key and the lookup cannot disagree. The **store is untouched**: this is a read-only translation on
  the way out, and no new write path exists. **Absent draws nothing** — null on the wire (nothing
  written) and a ref missing from `refUrls` (a provider that builds no URLs; Azure implements no
  `RefResolvable` at all) both degrade to silence, since a caption with no link asserts a comment
  exists while giving nobody a way to read it. `refChip` (`web/src/components/util.tsx`) is where that
  rule lives for the cockpit — it renders nothing unless the ref resolved. On the Goal Floor the
  _reading_ ("status comment · written") and the _way in_ (`Machine.link`) are deliberately separate,
  so a plan under a URL-less provider can still say a notice went out. Tests:
  `test/statusComments.test.ts`, plus the comment arms in `test/refUrls.test.ts`.

## Gotchas

- **Don't launch the server from inside a Claude Code session** when using `agentMode: 'pty'`.
  `NodePtyBackend` merges `process.env` into the agent's env, so the parent session's
  `CLAUDE_CODE_SESSION_ID` / `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` leak into the spawned
  `claude`, which then treats itself as a child of _that_ session and **writes no session
  transcript of its own**. The agent still runs and its sentinels still fire (the terminal
  backstop), but the transcript falls back to raw screen output with a recorded warning. Run
  `npm start` from an ordinary terminal, or unset the `CLAUDE_*` vars first.
- The default `agentMode` is `stream`, **not** a PTY — don't assume terminal semantics when
  reasoning about the default path.
- Relative paths in `claudeArgs` are resolved to absolute at config load, because agents run
  in a worktree/scratch `cwd` (`src/config.ts`).
- `bypassPermissions` maps to `--dangerously-skip-permissions`, which `claude` refuses under
  root — run as non-root if you need it. You should rarely need it: `agentAllowedTools` +
  the permission backstop (#130, above) make the default `acceptEdits` complete a task unattended
  without handing every agent unrestricted shell access.
- **Don't allow-list Bash via `claudeArgs: ["--allowedTools", …]`** — operator args are appended
  last and an explicit `--allowedTools` there wins over the harness's, silently dropping the
  `mcp__lubbdubb__*` grants (a _connected_ server whose every call is refused). Use
  `agentAllowedTools` instead; it rides in `--settings`, a different flag from the MCP grants.
- Config precedence: explicit overrides → `lubbdubb.config.json` → defaults, with `PORT` and
  `LUBBDUBB_DB` env overrides. `autoSend` is deep-merged.
- The `github` provider's auth token comes from `GITHUB_TOKEN` **only** — never from `Config`
  or a config file (so a secret can't be committed). Selecting `github` without the token or
  without `github.owner`/`github.repo` throws a clear error at `buildIntegrations` time.
- **Model auth is inherited, and `-p` never prompts.** Nothing in the harness supplies agent
  credentials: `StreamJsonSession` spawns with `{ ...process.env, ...spec.env }` and
  `AgentManager` only adds `LUBBDUBB_EVENTS_DIR` / the status file, so agents authenticate as
  whatever the parent shell is. That matters because of an asymmetry in `claude`'s
  [credential precedence](https://code.claude.com/docs/en/authentication#authentication-precedence):
  `ANTHROPIC_API_KEY` outranks subscription OAuth, and while _interactive_ `claude` prompts once
  to approve the key, **in non-interactive mode (`-p`) "the key is always used when present"** —
  the approval gate the default `stream` runtime would rely on does not exist. So a stray
  exported key silently moves every agent in the fleet onto API billing. Headless usage
  otherwise draws on the Pro/Max subscription: the announced move of `claude -p`/Agent-SDK usage
  to a separate credit pool at API rates was
  [paused](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  on 2026-06-15, so treat "subscription-billed" as current-but-provisional rather than settled.
  Don't add an `ANTHROPIC_API_KEY` to spawn env or config to "fix" an auth problem — it changes
  who pays; fix the login instead.
- **One label model — watch/ignore, derived from `labelPrefix`.** `src/watchLabels.ts` is the
  single source: `watchLabelsFor(prefix)` derives `${prefix}-watch` / `${prefix}-ignore`, and
  the pure `resolveWatchState(labels, {watchLabel, ignoreLabel, defaultWatched})` folds the
  precedence — **ignore wins, then watch, else the type default**. The default differs by kind:
  PRs are opt-out (`defaultWatched: true` → worked unless `-ignore`), issues are opt-in
  (`defaultWatched: false` → left alone unless `-watch`). An **empty prefix** yields empty labels =
  both gates off (the escape hatch tests use via `labelPrefix: ''`). There is **no ingest filter**
  anymore — every open issue is fetched and displayed; the gate only decides what's _acted on_.
  - PR side: `isPrExcluded(pr, ignoreLabel)` in `prHealth.ts` (still a plain `-ignore` includes,
    since PR default is watched) — `harness.ts` filters excluded PRs out of the dispatch world.
  - Issue side: `isIssuePickupEligible` / `issuePickupStatus` (`src/dispatcher/issuePickup.ts`)
    require `watchLabel` present and `ignoreLabel` absent; the status splits into `ignored`
    (explicit `-ignore`) vs `unwatched` (no `-watch` / state-gated) so the cockpit marks them apart.
    An **empty `watchLabel` leaves the watch gate off** (act on all) — that's how the no-arg
    `RuleDispatcher` and `labelPrefix: ''` keep the old act-on-all behaviour.
  - Priority stays label-encoded (`issuePriorityLabels`/`issueDefaultPriority`, pure `issuePriority`).
    `issuePickupRequireOwnLabel` refines the **watch** gate: when on, the watch check reads
    `issue.labelsAddedByViewer` instead of `labels`, so a `-watch` tag someone else added is ignored
    (anti-abuse). Authorship is resolved only in the real providers — GitHub reads the timeline's
    `labeled`/`unlabeled` events (`viewerAddedLabels`), Azure diffs work-item revisions
    (`viewerAddedTags`) — and only for items carrying the tag (the registry passes the derived
    `watchLabel` as `ownershipLabel`/`ownershipTag` only when the flag is set). The `fake` provider
    leaves `labelsAddedByViewer` unset, so the gate fails closed there.
