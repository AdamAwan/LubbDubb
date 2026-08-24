# 28 — The cross-fleet pool

> **Not yet built.** Nothing in this document describes running code: no table, module, route or
> config key named here exists yet. The paths it backticks are the **existing** files a change would
> touch, and it deliberately names no new ones — where a module ends up is the implementing change's
> to decide. It is the design that change is written against, and the marker comes off section by
> section as each becomes true.

Every deployment learns in isolation. [27](27-knowledge.md) models how far a fact carries as a
first-class axis, and its widest distance is `fleet` — meaning *that one operator's* fleet. So a
common problem is solved once per engineer, at full price, on every machine: three people on one
project each pay an agent to discover that the native builds need `npm ci` before the tests, and none
of the three ever finds out the others did.

This is the distance above `fleet`. It carries two things over one mechanism — the claims one fleet
has vouched for, so other fleets' agents are not sent to buy them again, and a daily digest of what
the fleet spent and what coming back to a pull request cost it, so a person can read where the money
goes across a company rather than across a laptop.

**It is a distribution problem and not a measurement one.** `knowledge_facts` already holds claims
with corroboration and contradiction; `src/issueSpend.ts` already prices a goal; `src/remedyInsights.ts`
already folds why the fleet came back and what it cost; `src/spendInsights.ts` already partitions
spend by phase. Nothing here measures anything new. It moves what exists.

## What it is not

**Not a central mirror of the store.** The volume is wrong, the data-classification surface is wrong,
and — the objection that actually decides it — a mirror makes the pool authoritative rather than
derived. The moment the pool is the source of truth, an offline laptop is a fleet that has lost its
knowledge. Every fleet's SQLite stays the truth about that fleet, and everything published is
re-derivable from it.

**Not a shared page that tooling edits.** That is the failure mode this design exists to avoid: N
writers fighting over one text blob, with merge conflicts as the steady state. Here no two fleets ever
write one address, so a conflict is not a thing that can happen — see [One writer per
namespace](#one-writer-per-namespace).

**Not authoritative about anything.** Nothing arriving from the pool is dispatched on, held on, ranked
by or injected into a prompt on its own. [27](27-knowledge.md)'s gate is unchanged in every respect:
a claim reaches agents when two independent voices agree, and reaches every agent when an operator
says so.

## The transport

The pool is a third capability in the provider registry (`src/integrations/registry.ts`), alongside
`sourceControl` and `issues`. Adding a provider is one line there; selecting it is a config change.

```ts
interface PoolTransport {
  readonly canRead: boolean;
  publish(doc: PoolDocument): Promise<void>; // replaces MY namespace, whole
  fetch(): Promise<PoolDocument[]>; // everyone's, mine included
}
```

Four properties are load-bearing, and each is a property of the **contract** rather than of any one
substrate — so no transport has to be clever, and a substrate added later cannot reintroduce a failure
the first two were careful about.

### One writer per namespace

A fleet writes its own documents and nobody else's. The transport never merges, never reads before
writing, and never reconciles. Conflict-freedom is structural: two fleets cannot disagree about a byte
because they never address the same byte.

### `publish` is a whole-document put

Never an append. Append needs read-modify-write with ordering guarantees, and almost no substrate
offers that safely — which is how a distributed append becomes a lock, a queue and a replay log.

A full replace of your own document is idempotent and retryable everywhere, and it is cheap here
precisely because the local store is the source of truth: **re-deriving the whole document is always
correct**. That one property pays for itself four times over in this document — it is why a failed
publish needs no queue, why a lost dirty flag self-heals, why a withdrawal needs no tombstone, and why
an hourly cadence costs a hash rather than a commit.

### The payload is opaque to the transport

Versioned JSON. The transport moves bytes; the layer above understands claims and digests. A text-only
substrate that stores a document in a fenced code block is first-class.

### `canRead: false` means publish-only

A fleet on such a substrate contributes to the shared page and consumes nothing. It runs no poller and
holds no mirror. Degraded explicitly, drawn as such, and never a fleet that silently believes it is
reading.

### The two transports

`fake` — mandatory, and the seam every test uses. All provider I/O sits behind a scripted fake and the
suite touches no network.

`git` — clone, pull, write your own file under the configured prefix, push. Provider-neutral by
construction, so one implementation covers Azure DevOps with a wiki, Azure DevOps without one, GitHub,
and any bare repository — and, because the prefix means the repository need not be the pool's, a
folder inside a team's existing wiki is a first-class home rather than a workaround
([below](#living-in-somebody-elses-repository)). A provider-specific wiki transport is an optional
extra that may never be worth writing. `http` later is
the service, and by then it is one factory line with nothing above it changing.

**The `git` transport's clone lives under its own root and never under `worktreeRoot`.** The worktree
pool counts every registered worktree under that root as a slot whatever the directory is called
([09](09-execution.md#exhaustion)) — so a pool clone in there is leased to an agent and wiped with
`git clean -ffdx`. This is exactly the hazard `localRunRoot` exists to avoid
([23](23-local-runs.md#the-checkout)), and the answer is the same one: a separate root, touched by
nothing else.

### Living in somebody else's repository

A pool does not need a repository of its own. `pool.path` is a prefix inside the one it is given, so a
team's existing wiki hosts the pool in a folder rather than having its root written into:

```json
{ "pool": { "path": "engineering/fleet-pool" } }
```

It defaults to empty, which is the repository root — right for a dedicated pool repository and wrong
for every shared one, which is why it is a setting rather than a convention.

**The prefix is the transport's and never the payload's.** It is not on the envelope and no document
records it, because it is an address rather than a fact: the layer above says *publish my document* and
the transport decides where that lands. A substrate with no folders — the `http` service later — has
nothing to do with the setting, and one with a different layout can honour it differently without
anything above changing.

Three rules follow from the repository not being the pool's, and each of them is a way to damage
somebody else's work:

- **The write set is exactly `<path>/fleets/<fleetId>/`.** The transport stages its own two files by
  name and commits those paths. Never `git add -A`, never `git add .`, and never `git clean` anywhere
  in the clone. In a dedicated repository a broad stage is untidy; in a wiki it commits whatever else
  happens to be in the tree, under the harness's name, on a schedule, with nobody having asked.
- **The read is scoped to `<path>/fleets/`** rather than to the tree. A pool sharing a wiki is a pool
  whose sibling directories are full of documents that are not documents in this sense, and a `fetch`
  that walked the repository would try to parse the team's meeting notes and record an error for each
  one, every pulse.
- **A rejected push is pulled and retried, never forced.** Other fleets push to this repository and, in
  a shared one, so do people. `--force` on somebody's wiki is the worst outcome this design can
  produce. The rebase is safe by construction rather than by luck: one writer per namespace means the
  incoming changes cannot touch the file this fleet is writing, so there is nothing for a rebase to
  conflict over. Retries are bounded, and a push that keeps being rejected is recorded and left for the
  next pulse like any other failure.

**A path that escapes the clone is refused at config load** — absolute, rooted, or containing `..` —
rather than at write time. A prefix is a coordinate an operator types once, so it is checked where the
rest of the coordinates are, and the failure is a boot error naming the key rather than a write into
whatever the path resolved to.

## Two documents, one envelope

A claim and a digest differ in every property that decides how a document is written, read, retained
and consented to.

|              | Claims                                        | Digest                              |
| ------------ | --------------------------------------------- | ----------------------------------- |
| Changes when | an operator vouches — weekly at most          | a day's numbers move — hourly       |
| Content      | free text an agent wrote                      | numbers over closed vocabularies    |
| Read by      | the importer, per fleet, sentence by sentence | an aggregator, summed across fleets |
| Retention    | while the claim is true                       | ninety days, rolling                |

So they are two documents at two addresses:

```
<pool.path>/fleets/<fleetId>/claims.json
<pool.path>/fleets/<fleetId>/digest.json
```

**The cadence difference is the one that decides it.** One document means republishing the claim text
every time a day's numbers move, so the fleet's file grows a commit an hour with the knowledge diff
buried in it — and the one history worth having, *when did this fleet start believing this*, becomes
unreadable. Two files, and the claims file's own history is that record for free.

**The classification difference is the one that would be expensive to get wrong.** Digests are numbers
over enums; claims are prose that can quote code. Two sections of one document make the consent
decision all-or-nothing, and a project that may contribute cost figures but not claim text would have
no way to say so.

One `fetch()` returns both. `PoolDocument` is a discriminated union under a shared envelope and the
layer above splits on `kind`, so the transport stays opaque and one writer per namespace becomes one
writer per **address** — strictly stronger, and unchanged in every property that matters.

### The envelope

`pool` (schema version), `kind`, `fleetId`, `project`, `publishedAt`, `harnessVersion`.

**The version is on the envelope and never inside the body.** A document written by a newer harness is
skipped *per document*, recorded, and drawn on the page as a fleet that is ahead of you. A version
inside the body fails the whole fetch and takes every other fleet's contribution down with it — one
early adopter silently emptying the pool for everybody.

**`fleetId` is in the body as well as in the address, and a mismatch discards the document.** The
address is the transport's, and a text substrate may have none that survives a round trip. A fleet
publishing under another fleet's name is the single thing that can break one writer per namespace, so
it is checked rather than assumed.

## The claims arm

### What leaves

A fact is in the fleet's document when all four are true:

- its reach is `lookup` or `injected`,
- its `ruled_at` is not null,
- its lifetime is standing,
- it is not marked `keepLocal`.

**`ruled_at` is the vouch, and reading it is what makes the gate mechanical.** It is stamped on any
move an operator makes, including one that changes nothing ([27](27-knowledge.md#reach--how-far-it-carries)),
so *a person has read this sentence and ruled on it* is a column rather than a policy somebody has to
keep true. The awkward case closes by construction: a claim carried to `lookup` by two agents agreeing
and never seen by a person carries a null `ruled_at` and does not leave the machine.

### Three refusals

**A notice never crosses.** An expiring fact is a report on today, and by the time it has crossed a
substrate it is stale. Its resolution condition is worse: `ci-check-green` names a check on a pull
request in a repository the reader cannot see, so nothing at the far end can evaluate it and the clock
silently becomes the whole mechanism on the one kind written to have more than one. This is
[27](27-knowledge.md#what-may-be-committed-to-the-repository)'s argument about committing a notice to
the repository, one level up and unchanged.

**Only `fleet` scope crosses.** A `goal:` scope dies with its goal, and a `check:` scope names another
fleet's pipeline — a provider identifier that is fragile *within* one fleet
([27](27-knowledge.md#scope--who-it-is-relevant-to)) and meaningless outside it.

**A `graduated` claim never crosses.** It is in the repository now. For a fleet working the same
repository, git already carries it and publishing would pay for one sentence twice; for a fleet working
a different one, it was a claim about a repository they do not have. It is
[27](27-knowledge.md#graduated-is-not-the-top-of-a-ladder--it-is-a-different-medium)'s medium argument
making itself again.

### What each entry carries

`id` (the origin's own fact id), `claim`, `where`, `vouchedAt`, `corroborations` and `disputes` as
counts at origin, and `evidence` — the corroborators' own words, capped.

Three omissions, each load-bearing:

- **No claim key.** It is recomputed locally through `src/claims.ts`. A key carried in the document is
  a second matcher, free to disagree with the one that actually decides whether an arriving claim joins
  a local row — and it would disagree silently the first time a fleet on an older build published.
- **No `aboutRef`, no `originRef`.** A ref points into a world the reader cannot see, and
  `<Ref to={ref}/>` would draw it as a live link to a pull request on somebody else's tracker
  ([17](17-cockpit.md#links)). What survives the crossing is the words.
- **No lifetime and no scope**, because of the three refusals above. Everything published stands, and
  everything published is fleet-scoped.

### What arriving means

An arriving claim is proposed locally through the same path an agent's claim takes, so `claimsMatch`
decides whether it is a new proposal or agreement with something this fleet already believes, and
nothing has to know which in advance.

**It lands with exactly one corroboration, attributed to the origin fleet — never the origin's count.**
A fleet arriving with five corroborations would arrive already past `lookup`, which is auto-promotion
crossing a machine boundary: the one transition [27](27-knowledge.md#corroboration) reserves for a clock
or an operator. The origin's counts ride as provenance drawn on the row, in the class that document
calls a reading and never a trigger. The dispute count is the more useful of the two — *the fleet that
vouched for this has since had two agents contradict it* is exactly what an operator needs in front of
them before promoting it here.

**A pooled corroboration's voice is the origin fleet, and one fleet is one voice** however many entries
it publishes and however many times it is polled. `distinctCorroborators` counts over goal and session
transitively today; a pooled row has neither, so the origin fleet folds into that same union in that one
function rather than becoming a second count beside it.

### Withdrawal

A claim retired, rejected or superseded at origin is simply not in the next document. No tombstone, no
delete verb, no ordering — the whole-document put paying for itself again.

**A vanished arrival does not delete the local fact.** By then it may carry local corroborations of its
own, and deleting on a remote operator's ruling would let one person prune another's store. What happens
instead is that the withdrawal is recorded and drawn: *the fleet that vouched for this has withdrawn it*.
A reading, and never a trigger.

## The project name

Pool-wide, `fleet` scope no longer implies *this repository*. A claim about one project's lint
configuration is noise to a fleet working a different one, and nothing in the sentence says which.

**The name is declared in `lubbdubb.project.json`, committed with the repository:**

```json
{ "pool": { "project": "acme-api" } }
```

A committed file travels with the repository. Every clone, every fork and every teammate's deployment
reads the same string with nobody coordinating — which derivation from `github.owner`/`github.repo`
cannot match, because it breaks at exactly the fork, mirror and rename cases. A fork keeps the file and
therefore shares with upstream by default, which is right: a fork hits the same walls. A hard fork that
has genuinely diverged edits one line.

**There is no derivation fallback.** A pool switched on against a project that declares no name is a
clear boot error naming the file and the key — the stance `src/integrations/registry.ts` already takes
when `github` is selected with no owner or repo. A silent fallback would be a second source of truth
for one string, and the two would disagree on precisely the cases the declaration exists to handle.

**The deployment override needs no machinery.** `lubbdubb.config.json` already sits above the project
layer ([02](02-configuration.md#precedence)), so overriding is possible by construction. It is not the
normal thing and it costs what it sounds like: a fleet that overrides the name stops sharing with
everyone else on its own project.

**The name is stamped on each fact as it is written**, because that records what was true when the
claim was learned rather than what is true when it is published. One additive column and one backfill,
below.

### The rule the name decides

**The project name never takes part in claim matching.** Making it part of identity would fragment
exactly the agreement this design exists to gain — the same objection [27](27-knowledge.md) makes about
matching being inside a scope. What it decides is one thing:

> The project name decides whether a **non-matching** arrival is proposed. It never decides whether a
> **matching** arrival corroborates.

| Arrival           | Matches a standing local claim | Matches nothing local                  |
| ----------------- | ------------------------------ | -------------------------------------- |
| Same project      | corroborates                   | proposed locally, awaiting a ruling    |
| Different project | **corroborates**               | held in the mirror; proposed to nobody |

Same project is full solve-once: a teammate vouched for something and it lands on your Knowledge page
as a proposal with their agent's words behind it.

Different project is self-selecting, and that asymmetry is the design. A claim about your project's
lint configuration never reaches a fleet on another project, because no agent there will ever say that
sentence. A claim about the toolchain — Windows refusing `rmdir` on a directory a live process holds
as its cwd, a provider reporting `queued` for a check that never ran — crosses the moment the receiving
fleet's own agent hits it, arriving as the corroboration that carries their own proposal to `lookup`.

**Two fleets on two projects independently saying one sentence is itself the evidence that the sentence
does not depend on the project.** No taxonomy, nobody asked to predict relevance to fleets they cannot
see, and no second control at the vouch. It is [27](27-knowledge.md#corroboration)'s own logic applied
one level up.

**What it costs, stated plainly.** A cross-project claim does not save the first discovery. The
receiving fleet still pays to learn it once; what it saves is the second agent onward instead of the
fifth. Proposing everything to everybody is the alternative, and it is a triage page nobody opens —
which is worth less than nothing.

### The mirror

Unmatched cross-project arrivals go to a mirror of the parsed documents, keyed on
`(fleetId, factId)` — **not** into `knowledge_facts`.

It is **derived and wholly replaceable**: rewritten on every poll, so dropping it and re-polling gives
an identical one. That is what keeps the pool from becoming authoritative locally, and it is not a cost
this rule adds — the mirror is the table the human-facing page reads anyway.

**Nothing reads the mirror into a prompt, and no tool answers from it.** An agent asking
`knowledge_ask` is answered from `knowledge_facts` exactly as it is today. Wiring the mirror to that
tool is the largest surface in this design and the least evidenced part of it — it would put another
team's unvouched prose in front of an agent — and it is deliberately not built until there is a pool
with content in it to judge.

## The digest arm

### The keys

Every dimension is a closed vocabulary that already exists, and none of them is a provider identifier.

| Section       | Keyed by                                     | Measures                                |
| ------------- | -------------------------------------------- | --------------------------------------- |
| `byPhase`     | `SpendPhase` (`src/spendInsights.ts`)        | costUsd, runs                           |
| `byCause`     | `RemedyKind` × `RemedyCause` × `RemedyGuard` | accounts, costUsd                       |
| `byCheck`     | the check's own name                         | accounts, costUsd                       |
| `unaccounted` | —                                            | return dispatches that filed no account |
| `unmeasured`  | —                                            | runs that reported no usage at all      |

`RemedyCause` and `RemedyGuard` are resolved from the dispatch origin rather than claimed, with the
copy for every value in one place (`src/remedies/remedies.ts`). Two fleets on two providers produce
comparable values by construction, and nobody had to agree on anything.

**There is no separate total.** `PHASE_ORDER` includes `other`, so the phases partition the fleet's
spend and the total is their sum. A total shipped beside them would be a second statement of one number,
free to disagree with the one that adds up.

**`unaccounted` and `unmeasured` are not optional.** Without the first, every share is a share of a
minority and reads as authoritative once summed across nine fleets — `src/remedyInsights.ts` already
refuses to draw the causes without it. Without the second, a fleet running on a PTY contributes real
work and no dollars and is drawn as a cheap fleet; a window in which nothing was measured answers null
and never `$0.00`, which is [27](27-knowledge.md#what-it-costs)'s rule and the reason it exists.

**Counts and dollars, never percentages.** A share summed across fleets is meaningless. The aggregator
takes shares from summed counts.

**The dollars are the existing per-account figure** — the filing agent's spend divided evenly across
the accounts it filed, which is the only claim the data supports and is already stated on the local
payload. Re-using it is what stops a fleet's contribution to the company page and its own panel
disagreeing.

### Check names cross within a project and never between

Three fleets, one problem, three keys — `test (windows)`, `ci/test-windows`, `Build & Test (win-latest)`.
Summed across projects that is three rows of one instead of one row of three, and it renders perfectly:
a chart saying no single check causes much pain, with nothing red.

Within one project the names are comparable, because it is one pipeline. *That check cost the team $900
last month across four engineers' fleets* is the reading the whole digest arm is for.

So `byCheck` is a **separate section**, and the aggregator's read of it takes a project name as an
argument. Two sections rather than one with a flag, for the reason `knowledge_corroborations` and
`knowledge_contradictions` are two tables ([27](27-knowledge.md#contradiction-and-why-it-does-not-delete)):
a reader that forgot a filter would sum two unrelated pipelines, and two sections make that unreachable
rather than merely wrong.

**A normalised check bucket is refused.** Classifying every check into `lint` / `unit` / `build` / `e2e`
would let names cross projects, and it is rejected twice over: it is a new measurement invented here
rather than moved from what exists, and `RemedyCause` already answers *what was actually wrong* without
guessing; and it would be regex over provider names, silently misfiling every project whose naming did
not match whoever wrote the patterns, producing confident buckets that are wrong.

### The period is a UTC day

One row per day per key. Coarser than the publish cadence on purpose: the cadence is how fresh the page
is, the bucket is how finely anyone can ask.

A day is the coarsest bucket that still re-cuts into every window a reader wants — a week, a month and
a quarter are whole numbers of days — and fine enough that a bad Tuesday is visible. Hours multiply the
row count twenty-four-fold for a resolution nobody uses across fleets. Weeks cannot be re-cut at all,
and force a decision about which day a week starts on.

**UTC, and this is the sharp edge of the digest.** Two fleets bucketing by local midnight put one
afternoon's work in two different days, and every company-wide daily figure is then wrong by a sliver
that nothing surfaces. Obvious once said, invisible forever if not.

**The current day is marked partial.** Otherwise every average on the page is dragged down by a day that
is not over — wrong by up to its whole width, silently, on the newest and most-read number. Marked, the
rule is one line: a partial day counts in a total and never in an average.

### Retention is ninety days

The publisher includes the last ninety UTC days and drops what falls off the back. That covers a
quarter, which is the longest question anyone asks of a page like this, and it bounds the document.

**The bound matters more than it looks.** Unbounded, a fleet running two years publishes some seven
hundred days against every live key combination, republished hourly — a large file rewritten
twenty-four times a day, per fleet, forever. The clone gets slow for everyone and nothing about it is
visible until it is.

**Stated limitation: the pool answers questions about the last ninety days and nothing older.** A
year-over-year reading is not available. On the `git` transport the older rows do survive in commit
history, and that is deliberately **not** part of the contract — a service has no such history, and a
promise that rested on one substrate would be one the interface could not keep.

## The clocks

One desk in the pulse, and the pulse is the clock. Not a timer of its own: a `setInterval` keeps firing
during a pause, during shutdown and during the upgrade handoff, which is the class of failure
[21](21-self-update.md#where-the-shutdown-handlers-are-registered) is written about.

|                | Attempts when          | With `heartbeatIntervalMs` at its default  |
| -------------- | ---------------------- | ------------------------------------------ |
| Claims publish | the document is dirty  | the next pulse — up to five minutes        |
| Claims poll    | every pulse            | every five minutes                         |
| Digest publish | an hour since the last | the next pulse after the hour              |
| Backstop       | an hour since the last | re-derives **both** documents and compares |

### The dirty flag is a hint. The content hash is the truth.

An operator's ruling marks the claims document dirty and the next pulse publishes it. That is the fast
path, and it is an optimisation rather than a correctness requirement: a flag can be lost to a crash
between the ruling and the pulse, and that claim would then wait for somebody to rule on another one.

So on the slow clock the desk re-derives both documents and compares their hash to what is published.
Different, publish; same, do nothing. Anything the flag misses self-heals within the hour, and the same
comparison is what makes an hourly cadence cheap — an idle fleet computes a hash and writes nothing,
and an active fleet changes only today's rows, which a git substrate deltas well. Without it every idle
fleet commits an identical file twenty-four times a day and the pool's history is almost entirely noise.

### The publish is never inside a route handler

A route that did the network write would make an operator's click wait on a push to another continent,
and a failed push there is a 500 on a ruling that **succeeded locally** — the operator told their
decision failed when the store took it. The store write is the truth and the publish is a consequence.

**Dirty is a flag and not a queue.** Because the put is a whole replace, five rulings in a minute
collapse to one publish and a failed push simply stays dirty. There is no pending-change list to lose,
reorder or replay.

### On boot

The first pulse polls — a deployment may have been off for a week — and runs the backstop rather than
waiting an hour, so claims vouched while the pool was unreachable go out immediately rather than sixty
minutes later.

### What the timing actually is

A vouch on one fleet reaches another fleet's page in **ten minutes worst case and about five typical**:
up to one pulse to publish, up to one more to be polled. That is six to twelve times faster than the
digest and well inside the gap to the receiving fleet's next dispatch, which is what the speed is for.
It is not instant, and nothing here should be described as though it were.

## Data classification

**A promoted claim is already off the machine.** It rides the system prompt of every dispatch to a model
API, and that happened at the vouch. What the pool changes is who *inside the company* can read it — a
compartmentalisation question, not an exfiltration one, and right-sizing it is what keeps the controls
below proportionate.

The controls, in order:

1. **The project opts in**, in a committed file, through code review. The strongest gate in the design,
   and it costs nothing extra.
2. **The vouch is the per-claim gate.** A second click to publish would mean nothing is ever published:
   the pool sits empty and looks like it is working, which is the failure [27](27-knowledge.md#retiring-is-not-rejecting)
   names about a store nobody prunes, pointed the other way. What changes is the wording — the control
   says *promote and publish*, so the consequence is not hidden.
3. **`keepLocal`**, a per-claim opt-out for the one claim in fifty that quotes a customer's
   configuration. Opt-out rather than opt-in, so the cheap vouch stays cheap.
4. **Withdrawal is one click and immediate.** Demote, retire, reject or `keepLocal`, and the claim is not
   in the next publish — which is on the vouch rather than on a timer.
5. **A secret-pattern backstop that refuses and never rewrites.** A claim matching a high-confidence
   structured pattern — a key, a token, a private-key header — is not published, and the row says why.

**A scrub is refused.** A customer name is an English noun and no expression matches it. A scrub that
mostly works is worse than none, because its output *looks* sanitised, so nobody reads it carefully
again and the one it missed is now trusted — it fails in the direction where the claim publishes looking
clean. The backstop above is deliberately the opposite shape: it refuses, and refusing is loud. An
allowlist is refused for a plainer reason: a claim is a sentence, and there is no structure to allow.

### The limitation to read twice

**The pool has no per-row access control and does not pretend to.** Anyone who can read the pool's
substrate can read every claim and every number in it, including the ones a page chooses not to draw.

That makes **who can read the pool** the actual security control here — not the vouch, not `keepLocal`,
not the page. It is a deployment decision, and it is to be made deliberately: a pool readable by a whole
company is a different product from one readable by one team.

### The per-fleet numbers are per person

A fleet is an engineer, so the digest is per-engineer spend and the shared page is one query from a
productivity scoreboard. The page defaults to per project rather than per person, but that is a framing
choice and not a control, because the documents are right there. If per-engineer figures being readable
across a company is a problem, the answer is the pool's read access.

It is named here because it is the likeliest thing to cost the pool its adoption. Engineers who believe
it is a scoreboard turn it off.

### Anything summed is mandatory; anything read alone may be withheld

The rule the two above are instances of. `byCheck` has no off switch, because an optional field makes
every aggregate silently partial — a project's total summed over whichever fleets left it on, rendering
as a complete figure. A claim may be withheld by `keepLocal`, because claims are read one at a time and
never totalled into a number anybody treats as complete: withholding one leaves nothing corrupted, only
absent.

## Configuration

Two layers, split by what the setting is *about* ([02](02-configuration.md#precedence)).

**The project layer, `lubbdubb.project.json`, committed** — which pool, and which project this is:

```json
{
  "integrations": { "pool": "git" },
  "pool": {
    "project": "acme-api",
    "remote": "https://git.internal.example/eng/team-wiki.git",
    "branch": "main",
    "path": "engineering/fleet-pool"
  }
}
```

**The deployment layer, `lubbdubb.config.json`, per machine** — who this fleet is:

```json
{ "fleetId": "alice@acme-api" }
```

`fleetId` is explicit and never derived — not from a git author line, not from the hostname — and it
names **person and target repo**, which is what makes two of one person's deployments distinguishable
in a pool. A fleet with no id configured while the pool is selected is a boot error, exactly as a
project with no name is.

| Key | Layer | Default |
| --- | --- | --- |
| `integrations.pool` | project | `fake` — publishes nowhere, fetches nothing, runs no desk |
| `pool.project` | project | none; required when the pool is selected |
| `pool.remote`, `pool.branch` | project | none; the `git` transport's coordinates |
| `pool.path` | project | empty — the repository root; a prefix when the repository is shared |
| `pool.digestIntervalMs` | either | one hour |
| `fleetId` | deployment | none; required when the pool is selected |

**Off by default.** `fake` is the default provider for the same reason it is for `sourceControl` and
`issues`: a harness that reached a network on a fresh clone would be one nobody could run a test
against. A project that never adds the file is unaffected in every respect.

**No secret is ever a config key** ([02](02-configuration.md#secrets)). The `git` transport
authenticates the way git already does for that host, and `lubbdubb.project.json` stays safe to
commit — which it must be, since committing it is the whole mechanism of the project name.

**The clone gets its own root**, never under `worktreeRoot`, for the reason in
[The two transports](#the-two-transports).

### What is deliberately not a key

- **Retention, and the UTC day.** Stated constants. `KNOWLEDGE_CHARS_PER_TOKEN`'s argument
  ([27](27-knowledge.md#what-it-costs)) applies unchanged: an operator tuning either would be tuning
  the answer rather than the thing measured, and two deployments' figures would stop being comparable
  — which is the one thing a shared page exists to make them.
- **Whether check names ship.** Anything that is summed is mandatory; an optional field makes every
  aggregate silently partial. See
  [Anything summed is mandatory](#anything-summed-is-mandatory-anything-read-alone-may-be-withheld).
- **The poll interval.** The pulse is the clock, so it is `heartbeatIntervalMs` and not a second key
  free to be set below it.

**When this is built, every key above belongs in [02](02-configuration.md) as well**, which owns the
full table of keys, defaults and precedence. A key documented only here is a key an operator looking
in the one place that lists them all will not find.

## When the pool is unreachable

Every failure is caught, recorded through `errors.record` (`src/errorLog.ts`) and non-fatal. There are
no swallowed catches.

- **A publish that fails leaves the document dirty**, so the next pulse retries. There is nothing to
  queue or replay, because the put is a whole replace.
- **A fetch that fails leaves the last-known-good mirror in place** rather than emptying it, and the page
  says the reading is stale and how old it is. *Could not reach the pool* is never folded into *nobody
  has published anything* — [24](24-environments.md#the-three-verdicts)'s discipline, and the same
  reason: read as absence, an outage says in the operator's words that nobody else knows anything.
- **Nothing about the harness stops.** No dispatch is held, no agent waits, no boot fails. A fleet with
  an unreachable pool works exactly as a fleet without one.
- **There is no backoff.** Retry is the next pulse, which is already a five-minute floor; exponential
  backoff on top would mostly mean a recovered pool taking an hour to be noticed. What it needs instead
  is that a persistently failing pool is *visible*: one error record per failure, and the Knowledge page
  saying when this fleet last published successfully.

## In the cockpit

The pool is drawn in two places and is a **view** in both. It is never a database.

**On the Knowledge page**, a pooled claim is an ordinary row under the heading its reach puts it in,
with its origin fleet drawn on it and the origin's corroboration and dispute counts as readings beside
the local ones. Nothing about the page's grouping changes: a pooled claim is not lifted into a section
of its own, for the reason a disputed claim is not
([27](27-knowledge.md#narrowing-is-a-filter-and-a-filter-never-moves-a-claim)) — a section would draw a
promotion nobody made. The page also says when this fleet last published, and which of its claims are
in the pool now.

**The shared insights page** reads the pulled documents live. It is not a committed artefact and there
is no generated file, so there is nothing for two fleets to conflict on. It opens per project, draws
the cross-fleet `byCause` and `byPhase` rollups, and draws `byCheck` only within a project.

Where the page is, which project it is narrowed to and which window it is over all go on `Place`
(`web/src/cockpit/place.ts`), never a `useState` — a surface held outside the query string is one the
back button steps over ([17](17-cockpit.md#the-address-bar)). Every colour it draws is a custom property
on `:root` with an entry in `web/src/cockpit/tokens.ts`, and every reference on it is drawn with
`<Ref to={ref}/>` — except that a pooled claim's origin has no ref to draw, and its fleet is text.

## What nothing does

- **No rule, desk or gate reads a pooled claim.** [27](27-knowledge.md#what-nothing-does)'s stance,
  inherited whole: nothing is dispatched, held or ranked because of one.
- **Nothing arrives injected.** The furthest an arrival reaches on its own is `lookup`, and only by
  agreeing with something a local agent already said.
- **Nothing auto-publishes.** A claim leaves on a ruling a person made.
- **Nothing deletes a local fact because a remote fleet withdrew it.**
- **No reading acts.** The origin's counts, a withdrawal, a stale mirror and a fleet that has not
  published in a month are all drawn for the person who can act on them, and none of them moves a claim.

## Persistence

Two columns on `knowledge_facts`, both additive `ALTER TABLE`s declared in `KNOWLEDGE_COLUMNS`
(`src/store/knowledge.ts`):

- **`project`** — the project name at the moment the fact was written. **It needs a backfill**, gated on
  `ensureColumns` reporting that it added the column: null spells *no project*, which would exclude every
  claim the store already holds from ever being published, and every one of them was in fact learned
  about the deployment's current project. The migration asserts history rather than guessing at it, and
  running it on every boot instead would relabel every claim written since.
  → [14](14-persistence.md#when-a-null-means-something)
- **`keep_local`** — null needs no backfill and is the only true value on every existing row: nothing
  before this could withhold anything.

### The one that is silent

**A pooled corroboration is upserted on `(fleetId, factId)` and never appended.** The poller re-reads
whole documents forever, so an append adds a corroboration on every pulse: with the default heartbeat,
some two hundred and eighty-eight a day against every pooled claim. Nothing errors. Every pooled claim
crosses to `lookup` within one pulse and then goes on climbing. And it looks **exactly** like the design
working — two fleets agreeing, carrying a claim, which is the feature. It would be found by somebody
wondering why the block is full.

It belongs in `CLAUDE.md` when it lands.

The mirror needs no migration of that kind. It is a new table, and a new table is created whole by
`CREATE TABLE IF NOT EXISTS` on every database that lacks one — but being new **once** is what stops
it staying exempt, and the first column added to it later belongs in `ColumnMigrations` exactly as the
two above do. → [14](14-persistence.md#migrations)
