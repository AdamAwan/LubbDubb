# 28 — The cross-fleet pool

Every deployment measures itself in isolation. What one fleet cost, where it spent it and what coming
back to a pull request took is a reading each operator has of their own laptop, and of nothing else —
so a person deciding whether this is working reads one machine's number with nothing to read it
against.

This is the distance above one fleet. It carries a **daily digest** of what a fleet spent and what its
returns to pull requests cost, so a person can read where the money goes across a company rather than
across a laptop — plus, on a person's own say-so, one [shared review pack](#a-third-document-rides-this-and-is-not-a-claim)
at a time.

**It carried a second thing and no longer does.** A fleet's vouched **claims** crossed here too, so
other fleets' agents were not sent to buy them again — and the claim store behind that arm is gone
([27](27-obstacles.md#what-the-claim-store-left-behind)). There is nothing vouched to publish, and an
obstacle is about _this_ repository's state right now, which crosses to nobody. The claims arm went
with it: no `claims.json`, no importer, no mirror of other fleets' prose, and no per-claim opt-out.
What is documented below as the mechanism — one writer per namespace, a whole-document put, an
envelope with the version on the outside — is unchanged and carries the digest alone.

**It is a distribution problem and not a measurement one.** `src/issueSpend.ts` already prices a goal;
`src/remedyInsights.ts` already folds why the fleet came back and what it cost; `src/spendInsights.ts`
already partitions spend by phase. Nothing here measures anything new. It moves what exists.

## What it is not

**Not a central mirror of anybody's store.** The volume is wrong, the data-classification surface is
wrong, and — the objection that actually decides it — a mirror makes the pool authoritative rather than
derived. The moment the pool is the source of truth, an offline laptop is a fleet that has lost its
own record. Every fleet's SQLite stays the truth about that fleet, and everything published is
re-derivable from it.

**Not a shared page that tooling edits.** That is the failure mode this design exists to avoid: N
writers fighting over one text blob, with merge conflicts as the steady state. Here no two fleets ever
write one address, so a conflict is not a thing that can happen — see [One writer per
namespace](#one-writer-per-namespace).

**Not authoritative about anything.** Nothing arriving from the pool is dispatched on, held on, ranked
by or injected into a prompt. It is read by a page and by nothing else — which is stronger now than it
was when claims crossed here, because there is no longer an arm that could propose anything locally at
all.

## The transport

The pool is a third capability in the provider registry (`src/integrations/registry.ts`), alongside
`sourceControl` and `issues`. Adding a provider is one line there; selecting it is a config change.

```ts
interface PoolTransport {
  readonly id: string; // `pool:git` — for the audit log and the cockpit
  readonly canRead: boolean;
  publish(doc: PoolDocument): Promise<void>; // replaces MY namespace, whole
  unpublish(pack: PoolPackRef): Promise<void>; // removes MY shared pack for one pull request
  fetch(): Promise<PoolFetchedDocument[]>; // everyone's, mine included
}

interface PoolFetchedDocument {
  addressedTo: string | null; // the fleet the *address* named, or null on a substrate with none
  text: string;
}
```

`unpublish` is the one delete, and it is narrow on purpose: only a
[shared review pack](#a-third-document-rides-this-and-is-not-a-claim) is ever removed — pruned on the
pull request's retention clock, or withdrawn because somebody unshared it — so nothing can be asked to
remove `digest.json`. It is inside this fleet's own directory, so one writer per namespace
is untouched, and removing what is not there is a success — the inverse of a whole-document put has to
be as retryable as one.

`fetch` hands up **bytes and an address**, not parsed documents, because checking the one against the
other is the layer above's job — see [the envelope](#the-envelope). A substrate whose addresses do not
survive says `null`, and the check is skipped rather than failed.

It lives in a registry of its own (`POOL_REGISTRY`) beside the world capabilities' rather than as a
third entry in theirs, because a pool transport is **not** an `Integration`: it reads no slice of the
world and has no `snapshot`. Folding it in would mean either widening that interface with two methods
nothing else implements, or a `snapshot` that returns nothing — and the second is the one that would go
wrong silently, since a capability the composite believes it has is one it will ask.

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

Versioned JSON. The transport moves bytes; the layer above understands what a digest and a pack are. A
text-only substrate that stores a document in a fenced code block is first-class.

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

### The clone and its root

The clone is made once and reused, so the transport asks on every publish and every fetch whether it
is already there. **The question is whether the repository is _this root's own_, and never whether
some repository encloses it.** `git rev-parse --git-dir` answers the second: it walks _up_ the
directory tree, so a pool root inside another repository's working tree reports that repository's git
dir and the guard returns early.

That is the default configuration and not an exotic one. The pool root is `<deskRoot>/pool`, and
`deskRoot` defaults to `.lubbdubb/desk` resolved against `repoRoot` — so unless an operator has moved
it, the pool root is _always_ inside the target repository's working tree. Read that way, the pool is
never cloned at all, and `publish` writes the fleet's document into a plain directory inside the
operator's checkout and stages it **there**:

- Where the enclosing repository happens to ignore the path, `git add` refuses and the desk records a
  failure every pulse. That is the lucky case, because it is the loud one.
- Where it does not, the `git add` succeeds and the harness commits a pool document into the
  operator's repository, under their name, on a schedule, with nobody having asked. Same cause, no
  error, and the worse outcome.

So the check is `git rev-parse --show-toplevel` compared against the root itself, with both sides
resolved through `realpath` — git answers with symlinks resolved, and a root under a symlinked
temporary directory would otherwise read as somebody else's repository and be re-cloned every pulse.
The walk stops mattering once the answer must equal the root.

It stays a git question rather than becoming a plain directory check, for the reason it always was:
the root may exist and be empty from a `mkdir` a failed earlier attempt left behind, and cloning into
a directory that is already a repository is the failure mode that would strand a pool.

**The clone's `origin` must be the configured remote before anything is written into it.** A clone
left behind by an earlier `pool.remote` is a real repository at the right path, so every check above
it passes and the only thing wrong is _which_ repository the fleet's documents, commits and pushes
land in — which is one writer per namespace holding, in the wrong building. A mismatch is refused and
recorded, naming both URLs, rather than re-cloned: wiping a repository on the strength of a config
edit is the more expensive way to be wrong, and an operator who meant the move deletes the root.

**Anything at the root that is not that clone is removed before cloning, and that is where a deployment
already affected by this recovers.** Such a deployment has a stray document tree sitting in the
enclosing repository's working directory, at exactly the path the pool clone needs; `git clone` refuses
a non-empty directory, so left alone it would fail forever on a directory only an operator could clear.
Removing it is safe by the same property that makes the whole design cheap: the put is a whole replace
and every document is re-derivable from the local store, so a stray one is worth nothing. The root is
the transport's alone and nothing else writes there, which is what makes this a removal of its own
output rather than of somebody's files.

The transport clears the directory it owns and no more. **A commit the bug already made into the
enclosing repository is the operator's to revert** — it is a commit in their history, under their name,
and the pool has no business rewriting it. The stray tree disappears on the next pulse; a commit stays
until they drop it.

### Living in somebody else's repository

A pool does not need a repository of its own. `pool.path` is a prefix inside the one it is given, so a
team's existing wiki hosts the pool in a folder rather than having its root written into:

```json
{ "pool": { "path": "engineering/fleet-pool" } }
```

It defaults to empty, which is the repository root — right for a dedicated pool repository and wrong
for every shared one, which is why it is a setting rather than a convention.

**The prefix is the transport's and never the payload's.** It is not on the envelope and no document
records it, because it is an address rather than a fact: the layer above says _publish my document_ and
the transport decides where that lands. A substrate with no folders — the `http` service later — has
nothing to do with the setting, and one with a different layout can honour it differently without
anything above changing.

Three rules follow from the repository not being the pool's, and each of them is a way to damage
somebody else's work:

- **The write set is exactly `<path>/fleets/<fleetId>/`.** The transport stages its own files by
  name — each document and its companion — and commits those paths. Never `git add -A`, never `git add .`, and never `git clean` anywhere
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

## One document, one envelope

The digest is published at one address, with a companion a person can read
([below](#the-human-readable-companion)):

```
<pool.path>/fleets/<fleetId>/digest.json   <pool.path>/fleets/<fleetId>/digest.md
```

**It stays a `kind` on an envelope rather than a bare body**, and that is worth stating now there is
one of them. `PoolDocument` is still a discriminated union — the shared review pack is a second kind,
published by a person and never polled — so the layer above splits on `kind` and the transport stays
opaque. A document whose kind the parser does not know is skipped **per document**, which is what a
second clock document costs to add and what a stranger's file in a shared wiki costs to ignore.

**One writer per namespace becomes one writer per address**, which is strictly stronger and unchanged
in every property that matters.

### The envelope

`pool` (schema version), `kind`, `fleetId`, `project`, `publishedAt`, `harnessVersion`.

**The version is on the envelope and never inside the body.** A document written by a newer harness is
skipped _per document_, recorded, and drawn on the page as a fleet that is ahead of you. A version
inside the body fails the whole fetch and takes every other fleet's contribution down with it — one
early adopter silently emptying the pool for everybody.

**`fleetId` is in the body as well as in the address, and a mismatch discards the document.** The
address is the transport's, and a text substrate may have none that survives a round trip. A fleet
publishing under another fleet's name is the single thing that can break one writer per namespace, so
it is checked rather than assumed.

### What a retired kind leaves behind

**A kind that leaves the union must leave `fetch` in the same change, and the list is the one place
that says which kinds exist** (`POOL_CLOCK_KINDS`). `claims` did not: the arm went, the type narrowed
to `digest`, the parser lost its grammar for it — and the git transport went on naming `claims.json`
in every fleet's directory. Every pool that had ever run the old build then fetched its own stale
file, failed to parse it, and recorded `unknown document kind "claims"` on every pulse, for as long
as the file existed. Nothing was broken and nothing was red; the error log simply filled up with one
sentence about a document nobody had published in months.

**The files themselves are cleared by the fleet that wrote them, on its next publish**
(`POOL_RETIRED_CLOCK_KINDS`, `poolRetiredPaths`). Nobody else can: one writer per namespace cuts both
ways, and another fleet's leftovers are not this fleet's to delete — so a pool heals as its fleets
upgrade, each clearing its own document and its own companion. The companion matters as much as the
document, because a wiki that keeps a page about an arm that is gone describes a harness nobody is
running.

Two properties keep that safe. **Only paths that are actually there** are unlinked and staged — `git
add` on a path that never existed is a fatal pathspec error, so a deployment that predates nothing
would otherwise fail every publish. And the removal rides along on the publish's own commit, inside
the write set that is already exactly `<path>/fleets/<fleetId>/`. A retired kind is **added** to the
retired list and never removed from it afterwards: the deployment that has not published since the
retirement is exactly the one still holding the file.

## The human-readable companion

A pool lives where people already are — a team's wiki, a repository somebody browses on the web. What
they find there is a JSON document written for an aggregator, and the fleet's own numbers are
consequently readable only by the fleets. So each document is published with a rendering of itself
beside it, at the same address: markdown for the digest, and for a
[shared review pack](#a-third-document-rides-this-and-is-not-a-claim) the HTML companion
[31](31-review-packs.md#reading-it) specifies. `poolCompanion` in `src/pool/companion.ts` is the one
place that decides which, because what matters is a property of the pair — every document goes out
with its companion, written and committed together.

**It is derived output and never an input.** `fetch` names `digest.json` by name, so nothing ever
reads a companion back — which is the whole of why it is safe to have one. A markdown file the
aggregator parsed would be a second grammar for one number, free to disagree with the JSON the moment
either is edited, and it would disagree silently: a hand-corrected figure in a wiki would arrive at
every other fleet as a reading the origin never took. `renderPoolMarkdown` in `src/pool/markdown.ts`
is a pure function of the same `PoolDocument` the JSON is serialised from, and holds no state of its own.

**The two files are written and committed together.** The write set is unchanged — still exactly
`<path>/fleets/<fleetId>/`, still staged by name — and the content hash still covers the JSON document
alone, so an idle fleet writes nothing and a publish that happens writes both. A companion that were
committed separately would be a second commit an hour saying the same thing.

**The digest companion summarises rather than transcribes.** Ninety days across six sections is some
thousands of rows, and a markdown table of them is a file nobody opens — which defeats the one thing it
is for. It totals the trailing 7, 30 and 90 days per key and says in the file that `digest.json` holds
the series. The windows are cut on the **document's own** publish day rather than the reader's clock,
since a reader a few hours the other side of midnight would otherwise drop the origin's newest day out
of its own seven-day window.

**The words come from the same copy the panels use.** `poolPhaseLabel` and `poolCauseLabel` are shared
with the cockpit's fold rather than restated, for the reason that fold gives: two spellings of one
closed vocabulary is how a fleet's page and its file come to disagree in the operator's language while
agreeing in the data.

**No setting.** It is derived output in a directory that is already the fleet's alone, it costs one file
write on a publish that was happening anyway, and a fleet that published one and not the other would be
a pool whose wiki is right for some fleets and stale for others.

## The project name

Pool-wide, one fleet's numbers are only comparable to another's inside one project: a check name is a
provider identifier and two pipelines' `test (windows)` are two different jobs.

**The name is declared in `lubbdubb.project.json`, committed with the repository:**

```json
{ "pool": { "project": "acme-api" } }
```

A committed file travels with the repository. Every clone, every fork and every teammate's deployment
reads the same string with nobody coordinating — which derivation from `github.owner`/`github.repo`
cannot match, because it breaks at exactly the fork, mirror and rename cases. A fork keeps the file and
therefore shares with upstream by default, which is right: a fork runs the same pipeline. A hard fork
that has genuinely diverged edits one line.

**There is no derivation fallback.** A pool switched on against a project that declares no name is a
clear boot error naming the file and the key — the stance `src/integrations/registry.ts` already takes
when `github` is selected with no owner or repo. A silent fallback would be a second source of truth
for one string, and the two would disagree on precisely the cases the declaration exists to handle.

**The deployment override needs no machinery.** `lubbdubb.config.json` already sits above the project
layer ([02](02-configuration.md#precedence)), so overriding is possible by construction. It is not the
normal thing and it costs what it sounds like: a fleet that overrides the name stops sharing with
everyone else on its own project.

**The name is on the document rather than on any row.** It was stamped onto each fact as it was
written, because that recorded what was true when the claim was learned; the digest is derived per
publish from rows the fleet already holds, so the envelope carries it and nothing needs a column.

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
| `byFault`     | `ErrorLogEntry['source']`                    | faults recorded (no cost)               |

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
and never `$0.00`: unmeasured is never free, and a confident zero is the one reading that would be a
lie.

**Counts and dollars, never percentages.** A share summed across fleets is meaningless. The aggregator
takes shares from summed counts.

**The dollars are the existing per-account figure** — the filing agent's spend divided evenly across
the accounts it filed, which is the only reading the data supports and is already stated on the local
payload. Re-using it is what stops a fleet's contribution to the company page and its own panel
disagreeing.

### Check names cross within a project and never between

Three fleets, one problem, three keys — `test (windows)`, `ci/test-windows`, `Build & Test (win-latest)`.
Summed across projects that is three rows of one instead of one row of three, and it renders perfectly:
a chart saying no single check causes much pain, with nothing red.

Within one project the names are comparable, because it is one pipeline. _That check cost the team $900
last month across four engineers' fleets_ is the reading the whole digest arm is for.

So `byCheck` is a **separate section**, and the aggregator's read of it takes a project name as an
argument. Two sections rather than one with a flag: a reader that forgot a filter would sum two
unrelated pipelines, and two sections make that unreachable rather than merely wrong.

**A normalised check bucket is refused.** Classifying every check into `lint` / `unit` / `build` / `e2e`
would let names cross projects, and it is rejected twice over: it is a new measurement invented here
rather than moved from what exists, and `RemedyCause` already answers _what was actually wrong_ without
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

### The faults section

Four of the five sections above measure the **work**, and every one of them sums across fleets into the
shared insights page. `byFault` measures the **harness**: what the fleet's own error log
([18](18-observability.md)) recorded, keyed by `ErrorLogEntry['source']` — `cycle`, `provider`, `agent`,
`server`, `boot` — and counted per UTC day like everything else here.

**It goes into the file and no further.** Nothing mirrors it, nothing aggregates it, and nothing at any
far end reads it back: `digestSections` in `src/store/pool.ts` names the five sections the mirror stores
and this is deliberately not among them. A fault is this harness failing on this operator's machine —
comparable to nothing on anybody else's, and answering no question a company page asks. What it is for
is a person opening the fleet's own `digest.md` in the pool repository and seeing what has been going
wrong, which is the one place the harness's faults are readable without a cockpit in front of you.

So it is in the document rather than only in the markdown, and the reason is
[the companion's](#the-human-readable-companion): `renderPoolMarkdown` is a pure function of the
`PoolDocument` and holds no state of its own. A section the markdown drew from somewhere else would be
a second source for one page, and the two would disagree the first time either moved.

**It carries no cost, and that is not an omission.** A fault has no dollar figure anywhere in the
harness, and deriving one here would be a new measurement invented for the pool rather than a move of
what exists — which is the rule the whole digest arm is held to. The companion draws no cost column for
it at all; a column of dashes is worse than no column.

**What it counts is the fault log as it stands, and the file says so under the table.** `clearErrors`
drops the whole table ([18](18-observability.md)) — it is a list an operator reads and clears, not a
record anything decides on — so an operator who clears the log publishes a fleet that had no faults this
quarter. Unstated, an empty table reads as a clean quarter, which is the one way this section can lie.
Stated where a person reads it, it is a reading like every other number here.

## The clocks

One desk in the pulse, and the pulse is the clock. Not a timer of its own: a `setInterval` keeps firing
during a pause, during shutdown and during the upgrade handoff, which is the class of failure
[21](21-self-update.md#where-the-shutdown-handlers-are-registered) is written about.

|                | Attempts when          | At the default cadence (30s busy, 5 minutes idle)         |
| -------------- | ---------------------- | --------------------------------------------------------- |
| Poll           | every pulse            | 30s busy, up to five minutes idle                         |
| Digest publish | an hour since the last | the next pulse after the hour                             |
| Packs          | a share is standing    | the next pulse — and prunes the pull requests long closed |

### The dirty flag is a hint. The content hash is the truth.

**There is no fast path left**, and that is what the claims arm's departure took with it: nothing an
operator does moves a number the way a ruling moved a claim, so the clock is the whole of what makes a
publish due. The dirty flag survives on the row because a publish that fails leaves it set, and the
next attempt is the next hour rather than a retry queue.

On the clock the desk re-derives the document and compares its hash to what is published. Different,
publish; same, do nothing. The comparison is what makes an hourly cadence cheap — an idle fleet computes a hash and writes nothing,
and an active fleet changes only today's rows, which a git substrate deltas well. Without it every idle
fleet commits an identical file twenty-four times a day and the pool's history is almost entirely noise.

### The publish is never inside a route handler

A route that did the network write would make an operator's click wait on a push to another continent,
and a failed push there is a 500 on something that **succeeded locally** — the operator told their
action failed when the store took it. The store write is the truth and the publish is a consequence.
The one route that still asks for a publish is a pack share, and it marks and returns.

**Dirty is a flag and not a queue.** Because the put is a whole replace, a failed push simply stays
dirty. There is no pending-change list to lose, reorder or replay.

### On boot

The first pulse polls — a deployment may have been off for a week — and publishes rather than waiting
an hour, so a day that ran while the pool was unreachable goes out immediately rather than sixty
minutes later.

### What the timing actually is

A day's numbers reach another fleet's page within **about an hour**: up to one hour to publish, up to
one pulse to be polled. The bucket is a day, so that is well inside the resolution anybody reads it at.
It is not instant, and nothing here should be described as though it were.

## Data classification

**What crosses is numbers over closed vocabularies**, and that is the whole of the surface now the
claims arm is gone. A digest row is a day, a key from an enum the harness owns (a spend phase, a remedy
cause and guard) or a provider's own check name, a count and a dollar figure. There is no free text in
it, and nothing an agent wrote crosses at all.

The controls, in order:

1. **The project opts in**, in a committed file, through code review. The strongest gate in the design,
   and it costs nothing extra.
2. **`byCheck` is the one field that carries anything a person chose**, and what it carries is a
   provider's own job name. A deployment for which that is sensitive does not publish at all: it is
   not optional, for [the rule below](#anything-summed-is-mandatory-anything-read-alone-may-be-withheld).
3. **The secret-pattern backstop is gone with the prose it guarded.** It refused a claim matching a
   high-confidence structured pattern — a key, a token, a private-key header — and there is no longer a
   document with a sentence in it to refuse. A pool that carries prose again brings it back, refusing
   rather than rewriting: a scrub that mostly works is worse than none, because its output _looks_
   sanitised and the one it missed is now trusted.

### The limitation to read twice

**The pool has no per-row access control and does not pretend to.** Anyone who can read the pool's
substrate can read every number in it, including the ones a page chooses not to draw.

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

The rule the two above are instances of, and it is the reason there is no per-field opt-out anywhere in
the digest. `byCheck` has no off switch, because an optional field makes every aggregate silently
partial — a project's total summed over whichever fleets left it on, rendering as a complete figure.
The one thing that ever _was_ withheld was a single claim, through `keepLocal`, and that was allowed
precisely because claims were read one at a time and never totalled: withholding one left nothing
corrupted, only absent. Nothing in a digest has that shape, so nothing in a digest may be withheld.

## Configuration

Two layers, split by what the setting is _about_ ([02](02-configuration.md#precedence)).

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
in a pool.

**The config page asks for it in the same breath as the provider.** `fleetId` declares
`requiredWhen: { path: 'integrations.pool', unless: 'fake' }`
([02](02-configuration.md#a-key-another-key-requires)), so the row is drawn even while unset, is
marked the moment the pool provider is staged as anything but `fake`, and the write is refused until
it holds something. Without that, an operator who has just turned the pool on gets a 400 from the save
over a key the page did not draw — told their config is wrong, with nothing to fix it in — and a fleet
that published nothing with nothing saying why.

Beside the empty field it **offers** `userId@pool.project` — `adam@lubbdubb` — as a button and a
placeholder. That is not the derivation this section rules out: nothing writes it, the offer is absent
unless both parts resolve, and what lands in the file is what the operator accepted. It is the shape
of the answer, spelled out, for a field whose whole job is to be an address nobody else writes to.

### A fleet with no name yet

**A pool selected with no `fleetId` boots.** The other coordinates are refused at load
(`validatePool`, `src/config.ts`) and this one deliberately is not, because of who each of them
belongs to: `pool.project`, `pool.remote` and `pool.branch` arrive in the **committed**
`lubbdubb.project.json`, so a missing one is a mis-committed file every clone shares and every clone
should refuse. The fleet's own name is the **deployment's**, per machine — so the day a team commits
the pool, a boot error over it is every operator on that team handed a harness that will not start,
over a key whose one editor is the cockpit that will not open. The refusal put the only person who
could answer in front of a terminal.

So there are three things instead, and they have to be read together:

- **The desk sits out.** `system.ts` wires no `PoolDesk` while the id is empty, exactly as it wires
  none for the `fake` provider. This is the part that must not be got wrong: the address is
  `fleets/<fleetId>/digest.json`, so a `?? ''` publishing under `fleets//` puts a document with no
  author in somebody else's repository, and the parse on the other side reads the directory name as
  the address ([The envelope](#the-envelope)). Nothing publishes and nothing polls until the fleet
  has a name.
- **The rail asks.** `fleet` is a check on **Needs you** ([26](26-setup.md#the-checks)) — `bad`, since
  a deployment whose project file says it is in the pool is publishing nothing and reading nobody.
  Beside the empty field it makes the same `userId@pool.project` offer the config page does, from the
  same `suggest` declaration, and it is `assumed`: nothing writes it on the operator's behalf, which
  is what keeps "never derived" true. Where either part is missing there is nothing whole to offer and
  the row is a `goto` — half an address is `alice@`.
- **The panel still draws nothing.** `PoolStatus` (`web/src/components/PoolStatus.tsx`) reads a null
  status, which is also what the `fake` default looks like. The row is what tells the two apart, and it
  is why the row is `bad` rather than a gap: without it, a fleet that was configured into the pool and
  never named it would be indistinguishable from one that never opted in.

`fleetId` has no arm in `src/configApply.ts`, so writing it lands in the file and the desk stays out
until a restart — which the reading restates rather than suppresses, in the shape
[26](26-setup.md#a-fault-the-file-has-already-answered) describes for every other restart-only key.

| Key                          | Layer      | Default                                                                      |
| ---------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `integrations.pool`          | project    | `fake` — publishes nowhere, fetches nothing, runs no desk                    |
| `pool.project`               | project    | none; required when the pool is selected                                     |
| `pool.remote`, `pool.branch` | project    | none; the `git` transport's coordinates                                      |
| `pool.path`                  | project    | empty — the repository root; a prefix when the repository is shared          |
| `pool.digestIntervalMs`      | either     | one hour                                                                     |
| `fleetId`                    | deployment | none; required when the pool is selected — the desk sits out until it is set |

**Off by default.** `fake` is the default provider for the same reason it is for `sourceControl` and
`issues`: a harness that reached a network on a fresh clone would be one nobody could run a test
against. A project that never adds the file is unaffected in every respect.

**No secret is ever a config key** ([02](02-configuration.md#secrets)). The `git` transport
authenticates the way git already does for that host, and `lubbdubb.project.json` stays safe to
commit — which it must be, since committing it is the whole mechanism of the project name.

**The clone gets its own root**, never under `worktreeRoot`, for the reason in
[The two transports](#the-two-transports).

### What is deliberately not a key

- **Retention, and the UTC day.** Stated constants. An operator tuning either would be tuning the
  answer rather than the thing measured, and two deployments' figures would stop being comparable —
  which is the one thing a shared page exists to make them.
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
  says the reading is stale and how old it is. _Could not reach the pool_ is never folded into _nobody
  has published anything_ — [24](24-environments.md#the-three-verdicts)'s discipline, and the same
  reason: read as absence, an outage says in the operator's words that nobody else knows anything.
- **Nothing about the harness stops.** No dispatch is held, no agent waits, no boot fails. A fleet with
  an unreachable pool works exactly as a fleet without one.
- **There is no backoff.** Retry is the next pulse — 30s at its fastest, five minutes on an idle
  fleet; exponential backoff on top would mostly mean a recovered pool taking an hour to be noticed. What it needs instead
  is that a persistently failing pool is _visible_: one error record per failure, and the Insights page
  saying when this fleet last published successfully.

## In the cockpit

The pool is drawn in two places and is a **view** in both. It is never a database.

**On the Insights page**, above the readings it is about: what this fleet has published and when, when
the pool was last polled, and which fleets have been heard from — the ones ahead of this build drawn as
such rather than as fleets that have published nothing. It draws nothing at all where no pool is
configured, because an empty panel there would say in the operator's words that something is broken.

It sat above the Knowledge page until that page went with the claim store behind it
([27](27-obstacles.md#what-the-claim-store-left-behind)), and Insights is where it belongs anyway: it
is a reading about what this fleet publishes and reads, on the tab that answers what the fleet is
costing and reaching.

**The shared insights page** reads the pulled documents live. It is not a committed artefact and there
is no generated file, so there is nothing for two fleets to conflict on. It opens per project, draws
the cross-fleet `byCause` and `byPhase` rollups, and draws `byCheck` only within a project.

Where the page is, which project it is narrowed to and which window it is over all go on `Place`
(`web/src/cockpit/place.ts`), never a `useState` — a surface held outside the query string is one the
back button steps over ([17](17-cockpit.md#the-address-bar)). Every colour it draws is a custom property
on `:root` with an entry in `web/src/cockpit/tokens.ts`, and every reference on it is drawn with
`<Ref to={ref}/>` — except that a pooled fleet has no ref to draw, and its name is text.

## A third document rides this, and is not a claim

_Built_ — specified in [31](31-review-packs.md#sharing-a-pack) rather than here, but it lands in this
fleet's namespace, so it is named where a reader of this document would look for it.

A **review pack** is the restatement of one change for a human reviewer: ideas, claims about the code,
and the code they point at, embedded. A shared one is published as a second kind of document beside
`digest.json`, over the same `PoolTransport`, under the same one-writer-per-namespace
rule — with an HTML companion beside it, rendered the way
[the markdown companion](#the-human-readable-companion) is: a pure function of the document, written
together with it, never read back. The companion is the whole of the standalone rendering, for a
reviewer with no harness.

**One per pull request rather than one per fleet**, so it has an address of its own inside the
namespace:

```
<pool.path>/fleets/<fleetId>/packs/pr-<n>.json   <pool.path>/fleets/<fleetId>/packs/pr-<n>.html
```

Which is also why **nothing polls it**. `fetch` names `digest.json` by name and never walks
([the clone](#the-clone-and-its-root)), so a pack is published for a person to open and is never read
back, landed or mirrored — and `parsePoolDocument` never sees one. `PoolDocumentKind` carries both
values and `PoolClockKind` is the one a clock publishes and `pool_publications` tracks: a pack has no
dirty flag, no content hash and no cadence, because it goes out when a person shares it and comes out
when its pull request is long closed. Removing it is the one delete a transport does — `unpublish`,
narrowed to a pack of this fleet's, so nothing can be asked to remove `digest.json`.

**It rides the transport and nothing else.** Nothing about it is injected into a prompt or read by a
rule. Two properties are worth stating here, because both cut against the arrangements above:

- **Publishing is a person's act, per pack.** A digest is derived and goes out on a clock; a pack is
  source, in volume, and goes nowhere until somebody says so. A pack unshared costs nobody anything.
  The secret backstop that guarded the claims arm survives here, over every embedded line: a pack is
  the only prose this pool still carries.
- **Shared packs are pruned.** A pack for a merged pull request is dead weight in a substrate every
  fleet clones, and the cost of keeping it is paid by whoever pulls rather than by whoever published.
  The publishing fleet drops it from its namespace once the pull request has been closed for
  `closedPrWindowMs`, the clock that drops the pull request from the world; the fleet's own local row
  is kept.
- **A pack can also be taken back out on the ask, and that is the same removal.** A pack shared by
  mistake must not wait weeks for the prune, so the share row carries a `withdrawnAt` and the packs
  arm calls the same `unpublish` on the next pulse before it looks at whether the pull request is dead
  ([31](31-review-packs.md#unsharing-a-pack)). The **network write stays out of the route** for this
  half exactly as for the publish: the route records the withdrawal and answers `202`, and a withdrawal
  that throws leaves the row standing so the next pulse tries again. A share the pool never carried has
  nothing to remove and no commit is made to say so.

## What nothing does

- **No rule, desk or gate reads anything that arrives.** Nothing is dispatched, held or ranked because
  of a pooled reading.
- **Nothing arriving reaches a prompt.** There is no arm that could put another fleet's words in front
  of an agent, and the one that used to is gone with the store behind it
  ([27](27-obstacles.md#what-the-claim-store-left-behind)).
- **No reading acts.** A stale mirror and a fleet that has not published in a month are drawn for the
  person who can act on them, and neither moves anything.
- **Nothing reads another fleet's faults.** `byFault` is published and never mirrored, never summed and
  never drawn on the shared insights page — see [the faults section](#the-faults-section).

## Persistence

**No columns, and that is the change.** The claims arm needed three additive `ALTER TABLE`s — a
project stamp on each fact, a per-claim `keep_local`, and the pool fleet a corroborating voice came
from — and all three went with the tables they were on
([27](27-obstacles.md#what-the-claim-store-left-behind)). What the digest arm needs is derived per
publish from rows the fleet already holds, and the envelope carries the project name.

### The mirror's own tables

`pool_digest_rows`, `pool_fleets` and this fleet's own `pool_publications` are the three that remain;
`pool_claims` went with the arm that filled it. Each is created whole by `CREATE TABLE IF NOT EXISTS`
on any database that lacks one — but being new **once** is what stops one staying exempt, and the first
column added to any of them later belongs in `ColumnMigrations`.
→ [14](14-persistence.md#migrations)

**Nothing dropped `pool_claims`.** An existing database still holds whatever its last poll wrote; the
table simply stops being created, and nothing reads it. The rows are re-derivable from the pool by
construction, which is what made a mirror safe to keep in the first place — and it is what makes
deleting one a change an operator asks for rather than one an upgrade takes.
