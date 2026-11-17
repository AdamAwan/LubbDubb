# Proposal — lessons the repository keeps

**Status: under discussion.** Nothing here is built. It covers two pieces of work that share one
shape: turning what the fleet keeps relearning into a written rule in the repository, and letting
other fleets see the rules that worked.

## The problem

The fleet already knows _why_ it came back to a pull request. Every CI fix and review round files a
remedy with a `cause` and a `guard` ([18](../spec/18-observability.md#causes-why-the-fleet-came-back)),
and one guard, `undocumented`, means _this was written down nowhere_. The spec calls it "the one an
operator can fix", and leaves the fixing to an operator who reads the Causes tab and writes the rule
down themselves.

That step mostly doesn't happen. So the same miss comes back on the next goal, with the next agent
paying again for it. The prior-remedy note helps the next CI or review agent, but only _after_ the
miss, and only on the same check. Nothing stops the miss.

Across fleets it is worse: each fleet relearns every lesson on its own.

## Why the last attempt was removed

This has been tried. The **claim store** collected lessons, findings, remedies and retrospectives
into one store, injected them into every agent's prompt, mirrored them across fleets through the pool,
and could graduate a claim into a documentation pull request. All of it was removed
([09](../spec/09-execution.md#nothing-fleet-wide-is-appended),
[28](../spec/28-cross-fleet-pool.md)). What went wrong, as the specs record it:

1. **A second source of truth.** A store of claims about the repository goes stale the moment the
   code moves, and nothing keeps it true.
2. **Blanket prompt injection.** "Blanket context at these sizes is skimmed rather than read, and
   adding to it makes every line already in it worth less."
3. **An operator queue.** Every claim needed ruling on. The queue grew; a page had to fold "what
   has gone cold".
4. **Prose crossing fleets.** Other fleets' wording arrived as if it were knowledge about _this_
   repository.

Graduation into a pull request was the right ending. It sat at the end of a pipeline nobody fed.

## The idea

**Skip the store. The repository is the store.** A lesson exists only as a merged edit to the
repository's own documentation — the nearest `CLAUDE.md`, or the spec that owns the behaviour.
The harness's job is to notice a repeat miss and draft that edit. **The pull request review is the
ruling**, and it is a review the operator already knows how to do.

Each failure above is answered by construction:

| Failure                | Answer                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Second source of truth | No new store. The lesson lives in the repository, next to the code, and changes with it.                                    |
| Blanket injection      | Nothing is injected. Claude Code already loads `CLAUDE.md` for every agent and every human, scoped by directory.            |
| Operator queue         | No new queue. A lesson is a pull request, reviewed like any other. Unreviewed, it costs nothing.                            |
| Prose crossing fleets  | Fleets on the same repository share the lesson through git. Across repositories only links and counts cross, never prompts. |

## How it works (#1 — repo lessons)

1. **Notice.** Group remedies whose guard is `undocumented` or `documented` by **cause and where**:
   the check name for a CI remedy, the review area (`areasForPath`) for a review remedy. A group
   that recurs across **at least two distinct goals** inside the window is a candidate. One miss is
   noise; two on different goals is a pattern.
2. **Draft.** Rule _repo-lesson_ dispatches one code agent on its own branch, handed the group's
   remedy summaries, their pull request links and the retrospectives of those goals. It edits the
   **nearest** document that would have been read — a directory `CLAUDE.md` before the root one,
   following this repo's own rule that the root file is a fleet-wide cost.
   - For `undocumented`: write the rule down.
   - For `documented` (the rule exists and was missed): don't add more prose. Move it closer to the
     code, or propose a lint rule or test that enforces it.
   - The agent may conclude **no edit is warranted** — a taste disagreement is not a rule. That
     settles the group without a pull request.
3. **Rule.** The pull request carries a `${labelPrefix}-lesson` label and cites every remedy behind
   it. **Merged** means adopted. **Closed** means declined, and the group is not redrafted until the
   same number of _new_ misses arrives.
4. **Check it worked.** The Causes tab shows each landed lesson's group before and after its merge.
   A lesson whose miss keeps coming back is shown as not working — the input for a later
   self-correcting step (#2).

What it costs: one agent per recurring group, capped like any other rule, and nothing at all on a
fleet whose remedies don't repeat.

## How it works (#4 — across fleets)

**Same repository, several fleets: git already does it.** A merged lesson reaches every fleet and
every engineer using Claude Code on that repository, with nothing built. Two fleets drafting the
same lesson is avoided through the **world**, not the pool: an open pull request with the lesson
label for the same group is already a fact every fleet sees.

**Different repositories: the pool carries what landed, and how well it worked.** The daily digest
gains a `lessons` section — one row per landed lesson: cause, guard, repository, pull request link
and title, and the group's miss rate before and after. The Insights page lists other fleets' lessons
ranked by effect. From one, an operator can **file it as a brief** for their own repository, and the
normal flow takes over.

When the same cause has landed lessons in **three or more repositories**, the page marks it as a
**company-wide candidate** — a rule for the shared plugin or an organisation-level `CLAUDE.md`,
rather than one repository's file.

The pool's existing rule holds untouched: nothing from the pool is dispatched on, ranked by or
injected into a prompt. It is read by a page, and a person decides.

## What changes in the specs

- **[18](../spec/18-observability.md#causes-why-the-fleet-came-back) — "Nothing gates on a remedy."**
  This is the one invariant the proposal breaks: a rule now reads the remedies table. It still gates
  no work — it only proposes a documentation pull request — and the spec needs to say exactly that.
- **[05](../spec/05-dispatcher.md)** — a new rule, origin family and prompt id.
- **[28](../spec/28-cross-fleet-pool.md)** — a new digest kind. A pull request title is prose
  crossing the pool; the spec has to decide whether a title is acceptable or only the link.

## Open questions

- **The threshold.** Two goals is a guess. Too low drafts noise; too high leaves the fix to luck.
- **The grouping key.** Check name and review area are the natural grain, but `other` and `defect`
  probably should never trigger a lesson.
- **Fleet budget.** Does a lesson draft take a fleet slot like a goal, or wait for idle headroom?
- **Repositories without a `CLAUDE.md`.** Create one, or edit the README / contributing guide?

## Why this scores, and why it matters anyway

The point is fewer return trips to pull requests. It also happens to move every layer of the maturity
model: **Knowledge** (writes to the repository, the system of record, owned by its reviewers),
**Feedback** (outputs recorded, evaluated before and after, corrections proposed automatically),
**Integration** (a cross-fleet channel other teams can consume), and **Agent** (a well-scoped agent
with a measurable outcome).
