# 41 — Repo lessons

`src/lessons/`. **Off by default**: `lessons.minGoals` is `0`, and with it at `0` nothing is grouped
for drafting, nothing is dispatched and nothing is opened. An operator turns it on by setting `2` or
more ([Configuration](#configuration)), because what it does when on is open pull requests on their
repository.

The fleet already knows _why_ it came back to a pull request: every CI fix and review round files a
remedy with a `cause` and a `guard` ([18](18-observability.md#causes-why-the-fleet-came-back)), and
two guards, `undocumented` and `documented`, say the miss was a matter of what the repository tells
an agent — written down nowhere, or written down and missed anyway. Left there, that is a count on
the Causes tab for an operator to read and act on, and that step mostly does not happen, so the same
miss comes back on the next goal with the next agent paying for it again. The prior-remedy note
([18](18-observability.md#the-note-a-later-dispatch-carries)) helps the next agent on the same check,
but only _after_ the miss. Nothing stops it.

A **repo lesson** is the fix for a miss the fleet keeps repeating, drafted by the fleet and ruled on
by the operator as an ordinary pull request review: noticed from the remedies, drafted by one agent,
and landed — or not — on the repository the fleet works on. It exists only as a merged change to that
repository. There is no store of lessons.

**Built.** The [configuration key](#configuration), [the grouping](#noticing-a-repeat-miss) —
`lessonGroups` and `lessonCandidates` in `src/lessons/groups.ts` — and the pull-request-to-goal index it
reads (`prGoalIndex`, `src/graph/prGoals.ts`), [the draft](#drafting-a-lesson) (rule, prompt, outcome
tool), [the ruling](#the-ruling-adopted-or-declined), [the record and the desk that settles
it](#the-record-and-the-desk), [the Causes tab reading](#did-it-work) and [the pool
section](#across-fleets). With `lessons.minGoals` at its default nothing is drafted, and so nothing is
adopted or published.

## Invariants

- **`lessons.minGoals` is `0` by default, and `0` drafts nothing however often a miss repeats; `1` is refused at load.** It opens pull requests on the operator's repository, so it is opt-in, and one miss is noise. → [§](#configuration) · `test/config.test.ts`
- **A group is counted in distinct goals, never in remedies or pull requests; a pull request the work graph roots in no goal stands as its own `pr:<n>`.** Two rounds on one goal are one miss, and counting them twice drafts a lesson from a single bad afternoon. → [§](#counting-goals) · `test/lessonGroups.test.ts`
- **Only `documented` and `undocumented` remedies are grouped, and the causes `other`, `defect`, `flake`, `environment` and `inherited` never are.** Those are misses no edit to the repository's guidance prevents, and a lesson drafted from one is noise the operator has to decline. → [§](#the-group) · `test/lessonGroups.test.ts`
- **Remedies on a bot-authored pull request or on a lesson pull request are left out.** A dependency bot's churn is not the fleet's work, and a lesson learnt from a lesson's own review loops. → [§](#what-is-left-out) · `test/lessonGroups.test.ts`
- **A review remedy is placed only by threads its own task changed code for and that are anchored to a file; with none it joins no group.** A defended thread is not a miss, and an unanchored one has no place to be about. → [§](#where-a-check-or-a-review-area) · `test/lessonGroups.test.ts`
- **An `adopted` or `filed` group is never redrafted; a `declined`, `nothing` or `unanswered` one only once misses since it settled span `max(missCount, minGoals)` goals.** Without the bar a declined lesson comes back on the next miss, and the operator's no is overruled by the pulse. → [§](#the-redraft-rule) · `test/lessonGroups.test.ts`
- **A lesson edits the repository the fleet works on, never LubbDubb's own.** The lessons are about the code the agents were fixing, and that is where its engineers read. → [§](#where-a-lesson-lands) · _no test_
- **Nothing about a lesson is injected into any agent's prompt, and nothing from the pool is dispatched on.** Blanket context is skimmed rather than read, and other fleets' prose is not knowledge about this repository. → [§](#why-the-claim-store-failed) · _no test_
- **A lesson pull request cites the pull requests behind it as full URLs, never `#n` and never with a closing keyword.** On Azure DevOps `#n` links a work item, which would adopt the lesson into another goal. → [§](#the-outcome) · `test/repoLessons.test.ts`
- **One draft is out at a time, at most two lesson pull requests are open, and a group with an open pull request carrying its marker is not drafted.** Each open lesson is watched, so its CI and review are fleet work nobody has asked for yet. → [§](#the-record-and-the-desk) · `test/repoLessons.test.ts`
- **A lesson is concluded only by `lesson_conclude`, from the draft's own task: `open_pr` on a lesson origin refuses and says so, and there is no `body` argument.** A pull request opened by hand carries no marker, label or evidence, and nothing would ever settle its draft. → [§](#the-prompt) · `test/repoLessons.test.ts`
- **A lesson ticket carries the lesson label and never the watch label.** Filing it must not also dispatch for it: the operator decides whether the fleet takes a refactor on. → [§](#a-pull-request-or-a-ticket) · `test/repoLessons.test.ts`
- **A draft whose agent's task ended without concluding settles `unanswered`; a lesson pull request merged is `adopted`, closed is `declined`.** A draft nothing settles holds its group for ever. → [§](#the-record-and-the-desk) · `test/repoLessons.test.ts`
- **An adopted lesson is read as its group's misses — in distinct goals, by `lessonGroups` — per same-kind return dispatch, over the 30 days before its merge and the 30 after; the after side is null, and the verdict `too early`, until those 30 days have passed.** A partial month after compared with a whole one before reads every young lesson as working. → [§](#did-it-work) · `test/lessonInsights.test.ts`
- **The pool carries an adopted lesson as counts and its pull request's URL — never its title, free text or `where` — and nothing from another fleet's lesson is drafted on, briefed from or put in a prompt.** Prose and check names do not cross; a link and a count are read by a person, who decides. → [§](#across-fleets) · `test/poolLessonsSection.test.ts`
- **The lessons reading is not bounded by the Insights page's window.** Its periods are fixed to each merge, and a window that cut one would compare unequal stretches. → [§](#did-it-work) · `test/lessonInsights.test.ts`

## What it is not

| Not                  | Because                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A store of claims    | The repository is the store. A lesson that is not merged does not exist, and one that is merged changes with the code it is about.                                                                           |
| Prompt context       | Nothing is appended to any dispatch. Claude Code already loads `CLAUDE.md` for every agent and every engineer, scoped by directory, and a merged lesson reaches them by that road.                           |
| An operator queue    | A lesson is a pull request (or a ticket), reviewed like any other. Unreviewed, it costs nothing.                                                                                                             |
| A gate               | No rule, desk or gate holds work on a lesson or on a group. The grouping proposes a draft and nothing else.                                                                                                  |
| A change to LubbDubb | The lesson lands on the repository the fleet was working on. LubbDubb's own repository is not where a project's conventions belong, and on most deployments it is not even the one the fleet has a clone of. |

## Why the claim store failed

This has been tried. The **claim store** collected lessons, findings, remedies and retrospectives into
one store, injected them into every agent's prompt, mirrored them across fleets through the pool, and
could graduate a claim into a documentation pull request. All of it was removed
([09](09-execution.md#nothing-fleet-wide-is-appended), [28](28-cross-fleet-pool.md)). Graduation into
a pull request was the right ending; it sat at the end of a pipeline nobody fed. What went wrong, and
how this design answers each by construction rather than by care:

| Failure                  | What went wrong                                                                                         | The answer                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A second source of truth | A store of claims about the repository goes stale the moment the code moves, and nothing keeps it true. | No new store of lessons. The lesson lives in the repository, next to the code, and changes with it. What the harness keeps is only the _draft_'s life. |
| Blanket prompt injection | Context at these sizes is skimmed rather than read, and every line added makes the rest worth less.     | Nothing is injected. A merged lesson is a line in the nearest `CLAUDE.md`, or not prose at all — see [the fix](#the-fix-in-order-of-preference).       |
| An operator queue        | Every claim needed ruling on; the queue grew, and a page had to fold "what has gone cold".              | No new queue. The pull request review is the ruling, and it is a review the operator already knows how to do.                                          |
| Prose crossing fleets    | Other fleets' wording arrived as if it were knowledge about _this_ repository.                          | Fleets on one repository share a lesson through git. Across repositories only links and counts cross, never prose and never a prompt.                  |

## Configuration

One key ([02](02-configuration.md)), declared in `src/lessons/policy.ts` and checked by
`validateLessons` (`src/config/configChecks.ts`):

| Key                | Default | Meaning                                                                                                                      |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `lessons.minGoals` | `0`     | Distinct goals a group must span inside the window before a lesson is drafted. `0` is off; anything else must be at least 2. |

**Off by default** because turning it on opens pull requests on the operator's repository, under the
harness's name, unasked — the class of act ([02](02-configuration.md)) that is never on by default.
**`1` is refused at load**, as are negatives and fractions: one miss on one goal is noise, and a
threshold of one would draft from every remedy filed.

`2` is a guess, and the key exists because it is one. Too low drafts noise the operator declines; too
high leaves the fix to luck. The window and the before-and-after periods are **not** keys: both are
30 days, as named constants (`LESSON_WINDOW_MS` in `src/lessons/groups.ts`). A knob nobody has a
reason to turn is a knob somebody turns for no reason.

## Noticing a repeat miss

`lessonGroups` folds the window's remedies into groups; `lessonCandidates` keeps the groups a lesson
may be drafted for now. Both are pure and take plain data — the remedies, the thread labels, the
pull-request-to-goal index, the pull requests to leave out, the `reviewAreas` rules and the window's
start, and for candidates the group's past drafts and `minGoals` — so the whole decision is testable
without a store.

### The group

A group is keyed **`${kind}/${cause}/${where}`**: what kind of return it was, what was wrong, and
where. The grain is the narrowest one at which "the same miss twice" is still plausibly the same
miss — `ci/missed_gate/lint` is one lesson; `ci/missed_gate` across every check is several.

Only remedies whose guard is **`documented`** or **`undocumented`** are grouped. `local_check` means a
check the agent could have run caught it, which is a gate the fleet already has; `unpreventable` says
nothing could. Both guards ride on the group as **per-guard counts**, because they point at different
fixes: an `undocumented` miss may want writing down, while a `documented` one was written down and
missed anyway, so more words will not help ([the fix](#the-fix-in-order-of-preference)).

Five causes never group, whatever the guard: **`other`**, which names nothing a fix could be about;
**`defect`**, a bug, which a lesson does not prevent; and **`flake`**, **`environment`** and
**`inherited`**, which are about the runner, the machine or another pull request rather than the
repository's guidance.

### Where: a check, or a review area

- **A CI remedy** joins **one group per check** in `remedy.checks` — the checks its dispatch was
  about, which the harness resolved rather than the agent claimed
  ([18](18-observability.md#causes-why-the-fleet-came-back)). A remedy with no checks joins nothing.
- **A review remedy** has no check, so its place is read off the threads the round answered:
  the `pr_thread_labels` rows with the same `taskId` and **`changed_code = 1`**
  ([18](18-observability.md#which-part-of-the-code-a-review-thread-was-about)). The union of
  `areasForPath(path, reviewAreas)` (`src/review/areas.ts`) over those rows is where the remedy
  goes. A thread the agent _defended_ rather than changed code for is not a miss, and a thread
  anchored to no file is about no place, so neither places anything; a review remedy left with no
  anchored, code-changing thread **joins no group**.

**A path no area rule matches falls back to its first two directories** — `services/billing` for
`services/billing/invoice/total.cs`, `app` for `app/main.py`, `.` for a file at the root. The default
`reviewAreas` describe LubbDubb's own layout (`^src/store/`, `^web/src/`), so on most repositories a
fleet works on, nothing would match, and without the fallback every review remedy there would group
nowhere. Two directories is the grain a `CLAUDE.md` is usually kept at.

### A remedy's goal

A remedy names a pull request. The goal behind it is read from the **work graph**: `prGoalIndex`
(`src/graph/prGoals.ts`) walks each `pr:<n>` node's `parentRef` chain up to the `issue:<n>` root it
reaches. The same walk attributes a landing to its goal ([24](24-environments.md#recording-a-landing));
it was extracted from `src/environments/landings.ts` so both read one answer.

It is a different reading from the cockpit's `goalOfPr` (`src/asks/lines.ts`), which matches a pull
request to its goal through a plan part's `prNumber`, an issue's linked pull request or an `issue/<n>`
branch — all read off the world and the plans the state snapshot carries. The grouping cannot use
that one: the window is 30 days, a closed pull request leaves the world after `closedPrWindowMs`
([03](03-world-model.md)), and the graph is the record that still has it.

### Counting goals

A group is counted in **distinct goals**. A pull request the graph roots in no goal — a brief's job,
a pull request the fleet adopted, one recorded before the graph knew it — counts as **its own unit,
`pr:<n>`**, so it is neither dropped nor folded into somebody else's goal. Two pull requests on one
goal, or four CI rounds on one pull request, are **one** miss: one goal that went wrong in one way,
probably for one reason. Two goals is a pattern.

### What is left out

- Remedies filed before the window's start.
- Remedies on a **bot-authored** pull request (`botAuthored`, [37](37-bot-prs.md)): a dependency
  bot's update going red is about the dependency, not about what the repository tells an agent.
- Remedies on a **lesson** pull request: the lesson's own review would otherwise feed the next
  lesson about itself.

The fold takes both as one set of pull request numbers; which pull requests are which is the
caller's reading of the world.

### The limits of the grouping

The grouping is coarse in two ways, both accepted:

- **A round across several areas or checks counts once in each.** A review round that changed code
  under `sql` and `ui` is a miss in both groups, and a red on `lint` and `test` one in each. Areas
  overlap by design ([18](18-observability.md#the-area-is-derived-at-read-time-never-stored)), and a
  remedy is one account of a round, so the alternative is choosing one area for it, which is a guess.
- **A thread re-answered in a later round moves to the later task.** `pr_thread_labels` keeps one row
  per thread and upserts it, so the earlier round's remedy loses that thread's place. The cost is an
  undercount on the earlier round, never a group invented from nothing.

### The window

30 days, `LESSON_WINDOW_MS`. A remedy older than that is not counted, and a group whose misses have
stopped stops being a candidate as they age out.

## The redraft rule

`lessonCandidates` reads a group's past drafts — each with its status, the number of goals it was
drafted on (`missCount`) and when it settled — and decides whether to draft again. The drafts are the
rows of `lesson_drafts` ([the record](#the-record-and-the-desk)).

- **A live draft** — `pending`, `dispatched` or `pr-open` — holds the group: one draft at a time.
- **`adopted` and `filed` are final.** The lesson is merged, or a ticket for it exists and the
  operator decides whether the fleet takes it on. A group that keeps missing after an adopted lesson is
  a lesson that is [not working](#did-it-work), which is a reading for the operator, not a redraft.
- **`declined`, `nothing` and `unanswered` are eligible again** once the misses **after the latest
  settled draft** span at least **`max(missCount, minGoals)`** goals. The same number of _new_ misses
  as the first draft rested on: a declined lesson does not come back on the next single miss, and the
  operator's no is overruled only by as much evidence again as it was drafted on.

Candidates are ranked by the goals they span, most first, then by key.

## Drafting a lesson

Rule `repo-lesson` (`kind: 'rule'`, in the rule book right after `validation-failed` and before
`bot-pr-risk`, [05](05-dispatcher.md#the-rules-in-evaluation-order)) dispatches **one code agent** per
draft, on its own branch `lesson/<id>`, for origin `lessons:draft:<id>` — the shape of
`app-errors:triage:<id>` ([39](39-app-errors.md#agent-triage)), not an `issue:<n>:…` family, because a
lesson is not a goal. `isHarnessBranch` (`src/pr/prOwnership.ts`) treats `lesson/` branches as the
harness's own, so they are reaped. The origin and branch spelling live in
`src/lessons/lessonOrigin.ts`. `RuleConditions` carries whether lessons are on (`lessons`), so
`minGoals: 0` reads as an inert rule rather than an empty one — even over a draft row left from when
it was on. The rule pushes one candidate for the one `pending` draft and nothing else, so it takes a
fleet slot like any rule and queues below the cut when there is none; the dispatch claims the draft
(`pending` → `dispatched`) the way a triage run is claimed. A draft is one assembly rather than a
standing signal, so there is no cooldown budget and no escalation.

### The fix, in order of preference

The agent's job is to pick **the fix that stops the miss for good**, which is often not more prose:

1. **Remove the cause in the code.** A misleading name, two places that must be kept in step, a
   helper that looks reusable and is not — `clarity` and `contract_drift` misses usually point here.
   If the code is the confusion, a document explaining it is a workaround.
2. **Make it enforced.** A lint rule, a type or a test that fails when the miss is made. Best for a
   `documented` miss: the rule was written down and still missed, so more words will not help.
3. **Fix a contradiction.** Where the code and the repository's spec or docs disagree, the agent says
   which is right, citing the evidence, and corrects the other. Where it cannot tell, it **escalates**
   rather than guesses.
4. **Write it down.** Only for what is genuinely a convention, and in the **nearest** `CLAUDE.md` or
   document that would have been read — a directory's file before the root one, because the root file
   is loaded for every agent and every engineer, so each line there costs everyone.
5. **Nothing.** A taste disagreement is not a rule. That settles the group without a pull request.

### A pull request or a ticket

**Small fixes are a pull request; big ones are a ticket.** A rename, a test, a lint rule or a doc edit
the agent makes itself, on `lesson/<id>`. A refactor touching many files is **filed as a ticket**
carrying the evidence, with the lesson label and **without the watch label**: the operator decides
whether the fleet takes it on, and if they do, it goes through appraisal and planning like any other
goal. A lesson agent does not get to start a refactor by itself.

### Where a lesson lands

On **the repository the fleet works on** — the configured `repoRoot` and its tracker — and never on
LubbDubb's own. The misses are about the code the agents were fixing, so that is where the fix belongs,
and where that repository's own engineers will read it. A repository with no `CLAUDE.md` gets one only
if a note is the right fix, at the nearest directory that would have been read.

### The prompt

`PromptId` `'repo-lesson'`, its body in `src/dispatcher/ticketPrompts.ts` and a copy at
`docs/prompt-templates/repo-lesson.md`. The template carries `{cause}`, `{where}` and `{goals}`, the
preference order, the pull-request-or-ticket rule, the repository it may edit, `escalate` for an
undecidable contradiction, and that it finishes with `lesson_conclude` — **never by opening a pull
request by hand**. The evidence — the group's remedy summaries, their pull requests and the
retrospectives of their goals — is **appended** as the briefing, never interpolated
([05](05-dispatcher.md#prompt-templates)).

`open_pr` called from a lesson origin refuses with "call `lesson_conclude`" (`resolveOpenPr`,
`src/mcp/openPr.ts`), never "open it yourself": a lesson pull request opened by hand carries no
marker, no label and no evidence, and nothing would ever settle it.

### The outcome

`lesson_conclude` takes `outcome` (`pull_request`, `ticket` or `nothing`), `fix` (`code`, `guard`,
`contradiction` or `note`), `title`, `summary` and `reason`. There is **no `body` argument**: the pull
request's body is the harness-rendered evidence, so the description rule
([07](07-pull-requests.md)) holds unchanged — the agent's `summary` and `reason` are kept on the draft
and are not in it. The side effects sit behind the `LessonOutcomeDesk` seam
(`src/lessons/outcomeDesk.ts`), and the bodies are rendered by `src/lessons/evidence.ts`. The tool is
fenced to the draft's own task — the origin must parse and the draft's `task_id` must be the caller's
— and answers once: a draft no longer `dispatched` refuses a second call. A title naming a pull
request or work item (`#n`, `!n`) is refused, for the citation rule below.

- **`pull_request`** — `sink.createPullRequest` on `lesson/<id>` against the default branch, the
  lesson label (`${labelPrefix}-lesson`, or `lesson` with no prefix, from `lessonLabelFor` in
  `src/watchLabels.ts`), then `seedPrWatch`, so CI and review on it are answered like any of the
  fleet's own pull requests; the draft goes `pr-open` with the pull request's number. A refused open
  says to push the branch and call again, never to open it by hand.
- **`ticket`** — `ticketFiler` (`src/tickets/filing.ts`) with the lesson label, no watch label and
  `searchKey: lesson:<groupKey>`, carried on `IssueCreateInput` rather than in a prompt; settles the
  draft `filed`.
- **`nothing`** — settles the draft `nothing` with the reason.

The body cites every pull request behind the group as a **full URL**, from the connector's ref URL —
never `#n` and never with a closing keyword. On Azure DevOps `#n` links a work item, which would adopt
the lesson pull request into another goal and hand its merge to that goal's landings. The body carries
the marker `<!-- lubbdubb:lesson:<groupKey> -->`, which is how an open lesson for a group is recognised
in the world.

## The ruling: adopted or declined

The pull request (or ticket) carries the lesson label and cites every remedy behind it. **Merged means
adopted. Closed unmerged means declined**, and the group is not redrafted until the same number of new
misses arrives ([the redraft rule](#the-redraft-rule)). Review is the ruling: the operator reads a
lesson the way they read any pull request, and an unreviewed lesson costs nothing but the open pull
request.

## The record and the desk

`lesson_drafts` (`src/store/schema/lessons.ts`, `src/store/lessons.ts`, reached as `store.lessons`)
holds one row per draft: the group key, the goals and remedies it was drafted on, its status —
`pending`, `dispatched`, `pr-open`, `adopted`, `declined`, `filed`, `nothing` or `unanswered` — and
when it settled. Partial unique indexes hold **one draft `pending` or `dispatched` at a time** and
**one live draft per group**. It records the life of a draft, never a lesson: what the lesson says is
in the repository.

The desk, `src/lessons/lessonDesk.ts`, reads no world of its own (`readWorld: false`, so it runs on a
local cycle too, against the cached snapshot it is handed) and sits directly below the app-error triage
desk, so below `graph` and `environments`. Each pulse it:

- settles a `dispatched` draft whose task ended without `lesson_conclude` as `unanswered`;
- settles a `pr-open` draft `adopted` when its pull request merged and `declined` when it closed,
  from `store.graph.settledPrs()`;
- opens a draft for the top candidate when none is `pending` or `dispatched`, **fewer than 2 are
  `pr-open`**, and no open pull request of its own world carries the group's marker. The pull requests
  left out of the fold are read off the same world: every bot-authored one, every one on a `lesson/`
  branch or carrying the lesson label, and every one a draft recorded. The draft keeps the misses it
  was made on — remedy, pull request, goal, guard, summary — and the briefing, assembled once: the
  misses grouped by goal under each goal's retrospective summary.

The settling runs whatever `minGoals` says; opening runs only when it is on.

**At most two lesson pull requests are open at once**, because each one is watched: its CI and its
review rounds are answered by the fleet ([07](07-pull-requests.md)), which is fleet work spent on a
pull request nobody has asked for yet. What it costs otherwise is one agent per recurring group,
capped like any other rule, and nothing at all on a fleet whose remedies do not repeat.

**What this changes in [18](18-observability.md#causes-why-the-fleet-came-back).** Nothing gates on a
remedy, but with lessons on a desk does read the table and can put an agent to work: `cause` and
`guard` are asserted by an agent and now trigger a dispatch. They still gate no work, and what keeps an
agent's word safe to act on is the threshold of distinct goals, the opt-in, and that the only thing it
can cause is a pull request (or a ticket) a person reviews. Spec 18, the remedies schema comment, the
remedy ask and the `report_remedy` description say so.

## Did it work

The Causes tab ([17](17-cockpit.md#causes)) lists every draft — its group, status, fix and the pull
request or ticket it ended in — and, for each **adopted** lesson, its group **before and after the
merge**: `buildLessonInsights` (`src/insights/lessonInsights.ts`), served on the reliability payload
([16](16-http-api.md#get-apireliability)).

- **The merge instant** is the draft's `settled_at`, which the desk sets on the pulse that sees the
  lesson pull request merged ([the record](#the-record-and-the-desk)). The harness keeps no merge time
  of its own for a pull request that roots in no goal, and a pulse is well inside the 30-day grain.
- **Misses** are the group's distinct goals in each period, folded by `lessonGroups` — the same
  grouping, exclusions and fallbacks that drafted it, never a second one — over the remedies filed in
  `[merge − 30 days, merge)` and `[merge, merge + 30 days)`. The 30 days is `LESSON_WINDOW_MS`.
- **The rate** is misses per **return dispatch of the same kind** in the same period — tasks with
  origin `pr:<n>:ci` for a CI lesson, `pr:<n>:comments` for a review one — leaving out the same bot and
  lesson pull requests the grouping does. A raw count would read a quiet month as a lesson that
  worked; dividing by how often the fleet came back at all is what makes the two sides comparable. With
  no return dispatch in a period the rate is null.
- **The after side is null until 30 days have passed** since the merge, and the verdict is then
  **too early**. A partial month compared with a whole one reads every young lesson as working.
- **Working** is no miss in the after period, or a lower rate after than before (a null rate counting
  as zero). Anything else is **not working**: the miss kept coming back at the same rate or worse with
  the lesson merged — the input a later step that corrects its own lessons would read.

**Not windowed by the page's window bar.** Every draft is listed whatever window is chosen, and each
lesson's periods are fixed to its merge; the tab's method note says so. The reading is pure and
derived at request time, like every fold on the page.

## Across fleets

**Same repository, several fleets: git already does it.** A merged lesson reaches every fleet and every
engineer using Claude Code on that repository with nothing built. Two fleets drafting the same lesson
is avoided through the **world**, not the pool: an open pull request carrying the group's marker is a
fact every fleet sees. That dedupe is own-world only — a fleet does not consult the pool before
drafting.

**Different repositories: the pool carries what landed, as counts.** The daily digest
([28](28-cross-fleet-pool.md#the-digest-arm)) gains a `lessons` section — no new kind, no version
bump — one row per adopted lesson: `kind`, `cause`, `guards`, `fix`, the pull request's URL, when it
merged, and the group's misses before and after, as counts. **No title, no free text and no `where`**:
a title is prose crossing the pool, and check names do not cross projects
([28](28-cross-fleet-pool.md#check-names-cross-within-a-project-and-never-between)). Mirrored rows are
replaced and expired with the digest they came in, and deduplicated by URL. The counts are the [did it
work](#did-it-work) reading's own — `readLessonInsights` (`src/lessons/lessonReading.ts`) serves the
Causes tab and the digest alike — and a lesson whose pull request the connector cannot resolve to a URL
is not published. What the section carries and how it is folded is
[28](28-cross-fleet-pool.md#the-lessons-section); `test/poolLessonsSection.test.ts` holds it.

The Pool tab lists other fleets' lessons ranked by effect, each with its link. When the same `cause`
has adopted lessons in **three or more projects**, it is marked a **company-wide candidate** — a rule
for a shared plugin or an organisation-level `CLAUDE.md` rather than one repository's file. There is no
prefilled brief: an operator who wants one for their own repository opens the link and writes it.

The pool's rule holds untouched: nothing from it is dispatched on, ranked by or injected into a prompt
([28](28-cross-fleet-pool.md#what-it-is-not)). It is read by a page, and a person decides.
