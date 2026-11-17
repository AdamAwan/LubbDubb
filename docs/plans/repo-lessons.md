# Build plan — repo lessons

Staged build of [41](../spec/41-repo-lessons.md). Each stage leaves `npm run check` green and updates
its owning spec in the same commit. Paths that do not exist yet are in italics. Deleted by the change
that finishes the last stage.

## Decisions

1. **Remedy → goal.** The work graph parents a `pr:<n>` node up to an `issue:<n>` root; `goalOfPr`
   in `src/environments/landings.ts` already walks it, privately. Extract to _src/graph/prGoals.ts_
   as `prGoalIndex(nodes): Map<number,string>`; landings imports it. Input
   `store.graph.listWorkNodes()`. A PR with no goal counts as its own unit `pr:<n>` (stated). Remedies
   on a lesson PR never count toward a group.
2. **Group key** `${kind}/${cause}/${where}`. CI: one group per check in `remedy.checks`. Review: the
   union of `areasForPath(path, config.reviewAreas)` over `pr_thread_labels` rows with the same
   `taskId`; a review remedy with no anchored thread joins no group. Guard must be `documented` or
   `undocumented`; excluded causes `other`, `defect`, `flake`, `environment`, `inherited`. Per-guard
   counts ride on the row; guard is not in the key.
3. **Origin** `lessons:draft:<id>` (shape of `app-errors:triage:<id>`), branch `lesson/<id>`, in
   _src/lessons/lessonOrigin.ts_. Not an `issue:<n>:…` family.
4. **Rule** `repo-lesson`, `kind: 'rule'`, in `RULES` right after `validation-failed`, before
   `bot-pr-risk`. Fix `validate-check`'s stale description of what ranks below it. App-error triage
   run-row pattern: one pending row, re-proposed each pulse, no cooldown, no escalation.
5. **Prompt** `PromptId` `'repo-lesson'`, body in `src/dispatcher/pullRequestPrompts.ts`,
   placeholders `{cause} {where} {goals}`. Fix preference order; small → PR, big → ticket; work on
   the worked-on repository only; `escalate` when code vs spec cannot be decided; finish with
   `lesson_conclude`. Evidence (remedy summaries, PR refs, retrospectives) **appended** as the
   briefing.
6. **Outcome tool** `lesson_conclude` (`open_pr` is bound to issue origins). Input `outcome`
   (`pull_request | ticket | nothing`), `fix` (`code | guard | contradiction | note`), `summary`,
   `body` (checked by `prBodyRefusal`), `reason`. Fenced on the lesson origin; side effects behind a
   `LessonOutcomeDesk` deps seam. PR: `sink.createPullRequest` on `lesson/<id>` with a
   harness-rendered citation and marker `<!-- lubbdubb:lesson:<groupKey> -->`, then the lesson label
   (`lessonLabelFor`), then `seedPrWatch`. Ticket: `ticketFiler` with the lesson label and **no**
   watch label, `searchKey: lesson:<groupKey>`, settles `filed`. Nothing: settles `nothing`.
7. **Settlement** _src/lessons/lessonDesk.ts_, `readWorld: true`, after `graph` in
   `src/system/pulseDesks.ts`. Settles a dispatched row whose task ended unconcluded as
   `unanswered`; `pr-open` → `adopted` on merge, `declined` on close; opens a new draft when none is
   out. Pure fold _src/lessons/groups.ts_ `lessonCandidates`. Redraft: a `declined`, `filed`,
   `nothing` or `unanswered` group is eligible again once misses after `settled_at` span
   ≥ `max(miss_count, minGoals)` goals. `adopted` is never redrafted.
8. **Store** table `lesson_drafts` (_src/store/schema/lessons.ts_, _src/store/lessons.ts_, member
   `store.lessons`). Status `pending | dispatched | pr-open | adopted | declined | filed | nothing |
unanswered`. Partial unique indexes: one draft out at a time; one live draft per group.
9. **Config** `lessons: { minGoals: 2, windowDays: 30, effectDays: 30, publish: true }`;
   `minGoals: 0` turns it off; validation `0 or ≥ 2`.
10. **Pool** a `lessons` section on the digest (no new kind, no schema-version bump): rows of
    `{kind, cause, where, guards, fix, prUrl, title|null, mergedAt, before, after|null}` as counts.
    Mirror table `pool_lessons`, replaced and expired with the digest. A title matching a secret
    pattern is withheld. Company-wide candidate at ≥3 projects.
11. **Cockpit** Causes tab gains a Lessons section (status, ref, before/after, verdict). Pool scope
    lists other fleets' lessons ranked by effect, with a File-as-brief composer over
    `api.launchJob`.

## Stages

0. **Spec.** New `docs/spec/41-repo-lessons.md` marked not yet built; delete the proposal; index.
1. **Pure fold and config.** _src/lessons/policy.ts_, _src/lessons/groups.ts_, _src/graph/prGoals.ts_;
   config keys; `test/lessonGroups.test.ts`. Specs 41, 02.
2. **Store, desk, rule.** Table, origin, desk, `repo-lesson` rule and prompt, `RULE_TOOLS` row,
   wiring; `buildSystem`-seam test. Specs 05, 14, 18 (rewrite "Nothing gates on a remedy"), 41.
3. **`lesson_conclude` and settlement.** Tool, outcome desk, lesson label, world settlement and
   own-world dedupe; rewrite "schedules nothing" in `remedyAskNote` and `report_remedy`. Specs 05,
   07, 11, 13, 41.
4. **Causes tab.** _src/insights/lessonInsights.ts_, reliability payload, `CausesTab.tsx`. Specs 16,
   17, 18, 41.
5. **Pool section.** Digest rows, reader, mirror, aggregate, secret backstop, pool tab and composer.
   Specs 14, 17, 28, 41.
6. **Cross-fleet lock and finish.** Provider search for lesson keys on other fleets' PRs (GitHub and
   Azure, with fakes); timeline row; delete this plan. Specs 15, 41.

## Risks

- Five texts claim remedies schedule nothing (specs 18 and 14, `src/store/schema/remedies.ts`,
  `remedyAskNote`, `report_remedy`); all change in stages 2–3.
- Spec 28's data classification: a PR title and link now cross the pool.
- Spec 28 "nothing arriving reaches a prompt": File-as-brief is a person's composed send.
- Spec 07 "operator writes the description": a lesson PR body is harness-composed.
- `ownWorkOnly` hides other fleets' lesson PRs until stage 6.
- A ticket outcome settles `filed` at once; its close is not observed.
- knip: stage-1 helpers stay unexported until a consumer lands.
