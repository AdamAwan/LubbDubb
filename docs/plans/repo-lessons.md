# Build plan — repo lessons

Staged build of the repo-lessons spec (_docs/spec/41-repo-lessons.md_, written in stage A). Each
stage leaves `npm run check` green and updates its owning spec in the same commit. Paths that do not
exist yet are in italics. Deleted by the change that finishes the last stage.

## Decisions

1. **Off by default.** `lessons.minGoals` defaults to `0` (off); an operator sets `2` or more to turn
   it on. It opens pull requests on the operator's repository, so it is opt-in.
2. **Remedy → goal.** The work graph parents a `pr:<n>` node up to an `issue:<n>` root; `goalOfPr`
   in `src/environments/landings.ts` already walks it, privately. Extract to _src/graph/prGoals.ts_
   as `prGoalIndex(nodes)`; landings imports it. Note in spec 41 how it relates to the different
   `goalOfPr` in `src/asks/lines.ts`. A PR with no goal counts as its own unit `pr:<n>`.
   **Excluded:** remedies on bot-authored PRs, and remedies on lesson PRs.
3. **Group key** `${kind}/${cause}/${where}`.
   - CI: one group per check in `remedy.checks`.
   - Review: over `pr_thread_labels` rows with the same `taskId` **and `changed_code = 1`**, the union
     of `areasForPath(path, config.reviewAreas)`; when no area rule matches, fall back to the path's
     first two segments (the default `reviewAreas` describe LubbDubb's own layout, so on most target
     repositories nothing would match). A review remedy with no anchored thread joins no group.
   - Guard `documented` or `undocumented`; excluded causes `other`, `defect`, `flake`,
     `environment`, `inherited`. Per-guard counts ride on the row.
   - Spec 41 states the limits: a round across several areas or checks counts once in each; a
     thread re-answered in a later round moves to the later task (`pr_thread_labels` upserts).
4. **Origin** `lessons:draft:<id>` (shape of `app-errors:triage:<id>`), branch `lesson/<id>`, in
   _src/lessons/lessonOrigin.ts_. Not an `issue:<n>:…` family. Add `^lesson/` to `isHarnessBranch`
   (`src/pr/prOwnership.ts`) so lesson branches are the harness's own and are reaped.
5. **`open_pr` on a lesson origin refuses with "call `lesson_conclude`"** (`resolveOpenPr` in
   `src/mcp/openPr.ts`), never "open it yourself". The prompt says not to open a PR by hand.
6. **Rule** `repo-lesson`, `kind: 'rule'`, in `RULES` right after `validation-failed`, before
   `bot-pr-risk`. Fix `validate-check`'s stale description of what ranks below it. App-error triage
   run-row pattern. `RuleConditions` gains a lessons flag so `minGoals: 0` reads as inert.
7. **Prompt** `PromptId` `'repo-lesson'`, body in `src/dispatcher/ticketPrompts.ts`, copy at
   _docs/prompt-templates/repo-lesson.md_. Placeholders `{cause} {where} {goals}`. Fix preference
   order (code → guard → contradiction → nearest note → nothing); small → PR, big → ticket; edit the
   worked-on repository only; `escalate` when code vs spec cannot be decided; finish with
   `lesson_conclude`; never open a PR by hand. Evidence (remedy summaries, PR refs, retrospectives)
   **appended** as the briefing.
8. **Outcome tool** `lesson_conclude`: `outcome` (`pull_request | ticket | nothing`), `fix`
   (`code | guard | contradiction | note`), `title`, `summary`, `reason`. **No `body` argument**: the
   PR body is the harness-rendered evidence (spec 07's description rule stays untouched). Cited PRs
   are rendered as full URLs (via the connector's ref URL), **never** `#n` and never with closing
   keywords — on Azure `#n` links work items and would adopt the lesson PR into another goal. Marker
   `<!-- lubbdubb:lesson:<groupKey> -->`. Side effects behind a `LessonOutcomeDesk` deps seam.
   - PR: `sink.createPullRequest` on `lesson/<id>`, lesson label (`lessonLabelFor` in
     `src/watchLabels.ts`), then `seedPrWatch` so CI and review are answered. Spec 41 states that
     watching costs fleet work, which is why at most **2** lesson PRs may be open at once.
   - Ticket: `ticketFiler` with the lesson label and **no** watch label, `searchKey:
lesson:<groupKey>`; settles `filed`.
   - Nothing: settles `nothing` with the reason.
9. **Desk** _src/lessons/lessonDesk.ts_, `readWorld: false`, placed beside `appErrorTriage` (below
   `environments`; do not break `test/pulsePipeline.test.ts`), using `store.graph.settledPrs()` for
   merge/close. Settles a dispatched row whose task ended unconcluded as `unanswered`; `pr-open` →
   `adopted` on merge, `declined` on close; opens a draft when none is out, fewer than 2 are
   `pr-open`, and no open own-world PR carries the group's marker. Pure fold
   _src/lessons/groups.ts_ `lessonCandidates`.
10. **Redraft.** `declined`, `nothing` or `unanswered` is eligible again once misses after
    `settled_at` span ≥ `max(miss_count, minGoals)` goals. `adopted` and `filed` are never redrafted.
11. **Store** `lesson_drafts` (_src/store/schema/lessons.ts_, _src/store/lessons.ts_, `store.lessons`).
    Status `pending | dispatched | pr-open | adopted | declined | filed | nothing | unanswered`.
    Partial unique indexes: one draft `pending`/`dispatched` at a time; one live draft per group.
12. **Config** `lessons: { minGoals: 0 }` only. Window and effect periods are named constants (30
    days) in spec 41. Declared in `CONFIG_FIELDS`, `runningConfig`, `configChecks` (`0` or `≥ 2`).
13. **Spec 18/14 rewrite.** `cause` and `guard` are agent-asserted and now trigger a dispatch; the
    ≥2-goal threshold, the opt-in and PR review are what keep that safe. Same for
    `src/store/schema/remedies.ts`, `remedyAskNote` and the `report_remedy` description.
14. **Pool (#4), minimal.** A `lessons` section on the digest (no new kind, no version bump): per
    adopted lesson `{kind, cause, guards, fix, prUrl, mergedAt, before, after|null}` as counts. **No
    title, no free text, no `where`** (check names do not cross projects, spec 28). No per-field
    opt-out. Mirror `pool_lessons`, replaced and expired with the digest; deduped by `prUrl`; the
    companion markdown renders it. Company-wide candidate keyed on `cause` only, at ≥3 projects.
    Pool tab lists other fleets' lessons ranked by effect, each with a link. **No prefilled brief**:
    an operator may open the link and write their own brief. Cross-fleet dedupe on one repository
    stays own-world only; spec 41 says so.

## Stages

A. **Spec + pure fold + config.** `docs/spec/41-repo-lessons.md` (opens with `## Invariants`, every
line `_no test_` or linking a test that exists; unbuilt sections marked; future paths italic),
delete `docs/proposals/repo-lessons.md`, update `docs/README.md`. _src/graph/prGoals.ts_,
_src/lessons/groups.ts_, config key; `test/lessonGroups.test.ts`, config test. Specs 02, 41.
B. **Store, rule, tool, desk, settlement — one stage** (a rule that cannot conclude must not land
alone). Everything in decisions 4–11 and 13; `buildSystem`-seam tests with `FakeWorktreeManager`.
Specs 04, 05, 07, 11, 13, 14, 18, 41.
C. **Causes tab.** _src/insights/lessonInsights.ts_, reliability payload, `CausesTab.tsx`. Specs 16,
17, 18, 41.
D. **Pool section** per decision 14. Specs 14, 16, 17, 28, 41. Then the timeline row, remove the
last unbuilt marker, delete this plan.
