# Proposal — atoms: the unit a change is made in, declared before it is written

**Status: proposed, nothing built.** This argues for a change to [08](../spec/08-planning.md),
[07](../spec/07-pull-requests.md) and [31](../spec/31-review-packs.md), and for one new table. It is
not a description of the application; every path it names that does not exist yet is in _italics_.
Per [docs/README.md](../README.md) it is deleted by the change that lands the work, with whatever
reasoning is still load-bearing moved into the specs that own the behaviour.

## The problem

[31](../spec/31-review-packs.md) attacks the right thing. A diff is what is left over after the
thinking, and the pack recovers the thinking as **ideas** — a claim plus an ordered walk through
every file one idea touched, in the order the reasoning ran rather than the order paths sort in.
That is the correct unit, and the document says so: a change here is naturally vertical, and
reviewing its six files separately is how a whole class of the sharp edges gets missed.

Two things are wrong with where that unit comes from.

**It is reverse-engineered.** The idea was real twice — once when the planner decided what the work
was, and again when the agent wrote it — and both times it was thrown away. A third agent then
rebuilds it from the diff and a witness log it is explicitly told to distrust. The pack's own
strongest finding, _the author said it did X and it does Y_, is available only where the witness
happened to record a fork.

**It is not a decision.** An idea cannot be merged, reverted or approved on its own. So the pack
removes the cost of _reading_ a large change and leaves the cost of _deciding_ on it entirely
intact: the reviewer still says yes or no to one indivisible thing, and still has to hold all of it
in their head to do that. A pack makes a wide pull request readable. It does not make it decidable
in pieces.

`planning.fileBudget` is the harness's current answer and it is honest about being a prompt to look
rather than a verdict ([07](../spec/07-pull-requests.md#how-wide-a-pull-request-is)). But twenty
files is a **size** heuristic standing in for a **shape** question, and the specs already say the
shape question better than the number does: a rename across sixty files is one concept, and a
twenty-minute fix cut into three parts costs far more than it saves. What separates them is whether
the pieces could have been reviewed, merged and reverted independently — which no count can see.

## What is proposed

An **atom** is the smallest piece of a change that could land, be reviewed and be rolled back on its
own without breaking the tree. Not the smallest piece imaginable — the smallest **independently
revertable** one.

The planner declares atoms. The operator groups them into the parts that become branches, agents and
pull requests. The part agent commits one per atom. The pack's ideas are then the atoms, checked
against the code rather than guessed from it.

Four surfaces, one new object:

| Stage   | Who      | What it is                                                              |
| ------- | -------- | ----------------------------------------------------------------------- |
| Declare | planner  | atoms, each with its intent, its paths, and the routes it did not take  |
| Group   | operator | which atoms each part carries — the merge boundary, set before any code |
| Build   | agent    | one commit per atom, so the pull request reads as a series              |
| Review  | pack     | ideas keyed on atoms, and a table of atoms rather than of files         |

## The shape: atoms are a flat list, and parts name them

The document grows a top-level `atoms` array, and each part names the atom slugs it carries.

```jsonc
{
  "version": 1,
  "reason": "...",
  "atoms": [
    {
      "slug": "resolve-job-origin",
      "title": "Resolve a job origin to the work it redoes",
      "intent": "The job row is the only place the real work is named.",
      "touches": ["web/src/view/goalPage.ts"],
      "acceptance": "A job: ref resolves through Job.originRef; every other ref is unchanged.",
      "dependsOn": [],
      "rejected": [
        {
          "route": "Resolve on the server and ship a second wire field.",
          "because": "The work graph already draws this edge off the same field; a second one can disagree with it.",
        },
      ],
    },
  ],
  "parts": [{ "slug": "resolve", "atoms": ["resolve-job-origin"], "title": "...", "scope": "..." }],
}
```

**Why flat, rather than steps nested inside a part.** Regrouping is the operator's act and it must be
cheap. Nested, moving an atom between parts is a document rewrite that carries its prose with it;
flat, it is one string moving between two arrays and every atom keeps its identity across the move.
It also means an atom's slug is stable through a regroup, which is what lets a pack idea and a commit
both name it.

**Nothing downstream changes.** `plan_parts`, `PlanReconciler`, `partBase`, `dependencySatisfied`,
branches and dispatch are untouched, because a part is still a part. The atom list is a second field
on a document that already carries parts, and the grouping is the mapping between them.

**Regrouping needs no new write path.** [08](../spec/08-planning.md#amending-a-running-plan) already
says an `awaiting_approval` plan is amended in place. A regroup is an amended document with the same
atoms in a different `parts` mapping, ingested by `ingestPlanDocument` exactly as any other. The
operator surface writes a document; there is no second route that could disagree with the first.

### What the schema refuses

In `PartSchema`'s `superRefine` (`src/plans/planDocument.ts`), beside the checks already there:

- **Every atom is carried by exactly one part.** An orphan atom is work nobody is scheduled to do; an
  atom in two parts is two agents on one piece. Both are refused, naming the atom.
- **A part's atoms may not induce a cycle between parts.** Atom dependencies are resolved to the parts
  that carry them; if that graph has a cycle the grouping is refused, naming both atoms _and_ both
  parts. This is the one refusal that must be loud: a grouping that induces a cycle is a part that is
  held `pending` forever with nothing red — the failure mode
  [33](../spec/33-story-sequencing.md#fail-open) exists to avoid one layer up.
- **Nothing refuses a plan for its atom count.** Same rule as parts today. A plan is not better for
  having more atoms in it, and a count check would turn the criterion back into a size one.

`part.touches` becomes the union of its atoms' `touches` when the part does not state its own, so the
existing field keeps its meaning and `scopeDrift` (`src/plans/scopeDrift.ts`) keeps working unchanged.

### Persistence

Two changes, and the second is the one that is easy to get wrong.

- **_plan_atoms_ is a new table.** It gets a `ColumnMigrations` entry in `PLAN_COLUMNS`
  (`src/store/plans.ts`) from the day it lands, not later: a table being new **once** does not keep it
  exempt, and the next column added to it is invisible on every database from before without one.
- **`plan_parts` grows an `atoms` column, which needs an additive `ALTER TABLE`.** It is an existing
  table, so `CREATE TABLE IF NOT EXISTS` will never add it. It goes in `PLAN_COLUMNS.plan_parts`
  beside `touches` and the rest.
- **Null means "this plan predates atoms", and that is the right answer for every existing row — so
  no backfill is owed.** Stated explicitly because
  [14](../spec/14-persistence.md#when-a-null-means-something) is exactly the trap here: a backfill
  that invented one atom per part would put a declaration in front of a reviewer that no planner ever
  wrote, and it would read as the planner's.

**An atomless plan must work end to end.** Every reader of atoms falls back to today's behaviour when
the list is empty — the plan sheet draws parts as it does now, the part prompt appends nothing extra,
and the pack's author derives its ideas the way it does today. This is not politeness to old rows: it
is what keeps a human-authored pull request, a replan of a live plan and a deployment mid-upgrade
from silently losing their pack.

## What each stage does

### Declare

`atomNote` is **appended** to the planner's rendered prompt beside `budgetNote`, never interpolated —
`loadPromptTemplates` rejects only _unknown_ placeholders, so a new `{atoms}` token is dropped in
silence by exactly the deployments that overrode most
([05](../spec/05-dispatcher.md#prompt-templates)).

What it must say, and the wording is the whole risk: **the criterion is revertability, not size.**
Asked for the smallest possible pieces a model produces `add the type` / `add the field` /
`add the test` — fourteen slices that must all land together, which is more ceremony for no decision
benefit. The note gives the test as a question the planner answers per atom: _could this land on its
own, be reviewed on its own, and be rolled back on its own without breaking the tree?_

`rejected` is the field worth the most and the one nothing else can recover. The plan already
carries `alternatives` as one prose field for the whole plan; per-atom rejections are a different
object and both stay — `alternatives` is why this approach, `rejected` is why this atom is written
this way.

### Group

An operator surface off the plan panel (`web/src/components/PlanMap.tsx`), reached from the approval
card's existing **Read the full plan** control. It is **not a question on the approval card**:
[08](../spec/08-planning.md#the-approval-gate) deliberately took the split out of the ask body,
because how the work is cut up is a question you reach after agreeing the work is right. Putting a
grouping exercise back at that moment would undo that.

Which means the planner's proposed grouping has to be **good enough to accept blind**, and regrouping
is a screen an operator visits when they want it. The two things it must draw: the cycle refusal
above, and what each grouping costs — a part with one atom is one more review round and one more
merge, which is sometimes right and often is not.

### Build

`partDeclarationNote` (`src/plans/parts.ts`) grows the part's atoms, appended like the rest of it: the
atom list, each with its intent and paths, and the convention that each becomes one commit.

**Commits are narrative, not risk boundaries.** They do not survive the squash and nothing after the
merge needs them. What they buy is a reviewer who can walk the change in the order it was reasoned
before opening a pack at all — and, since the atoms are already declared, the message writes itself.

### Review

`ReviewIdea` (`src/types.ts`, `src/wire.ts`) grows `atom: string | null`. Null is the honest answer for
a pull request with no atoms behind it, and the renderers draw the gap rather than guessing, exactly
as they do for a cue the author omitted.

The author's prompt (`src/reviewPacks/author.ts`, `'review-pack-author'` in
`src/dispatcher/promptTemplates.ts`) is handed the part's atoms and told an idea corresponds to one.
It may still write an idea the atoms do not cover — that is a finding, not an error, and it is the
most valuable sentence in the pack: _the work went somewhere the plan did not declare._

The page's contents change in one way and one way only: **the ideas table is keyed on the atom, and
the files are a column.** A row per file is the wall with better typography — it re-sorts by path,
it duplicates a file that several atoms touch, and it structurally cannot carry a `region` anchor,
which is the pack's answer to _you changed A and did not change B_ and most of what
[`CLAUDE.md`](../../CLAUDE.md) catalogues.

Both renderings move together and their two copies of the derivations
(`src/reviewPacks/derive.ts`, `web/src/view/reviewPack.ts`) must agree, which
`test/reviewPackCompanion.test.ts` already asserts.

**A plan-time rejection reaches the pack as provenance, never as a claim.**
[31](../spec/31-review-packs.md#the-witness-log) already settles this for the witness log's
`rejected`: an alternative is an intention, the checker's honest verdict on one is `cant_tell` by
construction, and it is shown as the entry it came from rather than as a sentence with a verdict
beside it. The same holds for the plan's, and it has to be said again here because the plan's
rejections are more authoritative-looking and will be trusted harder.

## Cost

**No new agent runs.** Atoms ride the planner's existing run. Grouping is an operator's click. The
commits are the part agent's own. The pack's author and checker already run. What this costs is
prompt length in two places and a table.

## What is decided here, and why

**Atoms are a flat list the parts name, not steps nested in a part.** Nested, a regroup is a document
rewrite and an atom's identity does not survive it; flat, the slug is stable and the grouping is one
field. → [The shape](#the-shape-atoms-are-a-flat-list-and-parts-name-them)

**Regrouping is the existing amendment route, before approval only.** A second write path into
`plan_parts` would be a place for the two to disagree. `awaiting_approval` already amends in place.

**The criterion is independent revertability, and `fileBudget` is unchanged.** The budget stays what
it is — a prompt to look. This adds the shape question the number was standing in for; it does not
replace the number, and rule `pr-split` still exists for the seam only visible once code exists.

**Nothing is refused for its atom count, and nothing blocks a merge.** The whole subsystem stays a
reading. A count check would reintroduce size as the criterion by the back door.

**Commits are the journey, not the boundary.** They die at the squash and that is fine; nobody
reviews after the merge. The boundary is the part.

**An atomless plan behaves exactly as today.** Every reader falls back. Fail open, on every arm.

## What is still open

**Whether a planner can declare good atoms at all.** This is the claim the whole proposal rests on and
nothing here proves it. Over-fragmentation is the failure to watch for — fourteen atoms that must all
land together — and the only defence proposed is the prompt's wording. Nothing measures it. Stage 2
below exists to look at the output before anything is built on top of it, and if the atoms are bad
the rest should not be built.

**Whether the commit series should be embedded in the pack.** Commits do not survive the squash, so a
pack read after the merge has no series to point at. The document already
[carries its code](../spec/31-review-packs.md#the-document-carries-its-code); whether it should also
carry the ordered messages is undecided, and the answer probably depends on whether anyone reads a
pack after its pull request has landed.

**Whether a plan-time rejection goes stale, and what to do about it.** If an atom rules out a route
_because the work graph already draws this edge_ and a later atom changes that, the pack is showing a
reason that is no longer true — which is worse than showing nothing, for the reason a stale spec is
worse than no spec. The pack has currency by head sha; a plan's rejections have none.

**Whether scope drift should move to the atom.** `scopeDrift` reads a part's `touches` today. Atom-level
touches are narrower and would catch more, but a diff that lands inside the part and outside the atom
is a much weaker signal, and drift that fires constantly gets ignored.

**Everything about stacks with several reviewers is deliberately not here.** The map of a whole plan,
per-part reviewer assignment, the assume-done / yours / not-yours bands on a part's pack, and knowing
that a lower part moved under somebody who already read an upper one — that last one being the piece
with no home today and the only one whose absence is silent. It is a separate proposal and it depends
on this one landing first.

## Staging

Each stage is worth landing on its own, and stage 2 is the one that decides whether to continue.

1. **Atoms in the document and the store.** `PartSchema`'s sibling and the two refusals,
   _plan_atoms_, `plan_parts.atoms`, `atomNote` on the planner. Nothing reads them.
2. **The plan sheet draws them, read-only.** The cheapest possible look at whether the planner
   declares atoms worth having. **Stop here and judge before building stages 3–5.**
3. **Regroup.** The operator surface, writing an amended document. The cycle refusal made visible.
4. **Commits.** `partDeclarationNote` grows the atom list and the one-commit-per-atom convention.
5. **The pack keyed on the atom.** `ReviewIdea.atom`, the author's prompt, the table on the page,
   both renderers and their two copies of the derivations.

Stages 1, 3, 4 and 5 each change behaviour and so each carries its own spec edit —
[08](../spec/08-planning.md) for 1 and 3, [08](../spec/08-planning.md) and
[09](../spec/09-execution.md) for 4, [31](../spec/31-review-packs.md) for 5, and
[14](../spec/14-persistence.md) for the table and the column.
