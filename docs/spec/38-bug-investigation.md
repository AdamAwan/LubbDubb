# 38 — Bug investigation

`src/intake/investigation.ts`, `src/dispatcher/rules/issueInvestigate.ts`. Finding why a bug happens
before anything is planned for it, and the hold that keeps the planner off it until a person has read
the answer.

A planner handed a bug report with a clear symptom and no cause plans the symptom. It decomposes "the
export crashes on an empty selection" into parts that guard the export, the selection and the button,
an operator approves three pull requests, and the cause — one `reduce()` with no initial value, two
files away — is fixed by none of them or by the third by accident. The fleet's whole funnel assumes
the ticket says what to build; a bug whose cause nobody knows says only what is wrong.

This is one read-only agent that finds the cause first, the record it writes, and the four ways an
operator answers it.

## What it is not

| Not                           | Because                                                                                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read off the ticket's type    | A `Bug` type and a `bug` tag say how the reporter filed it, not whether the cause is known. Plenty of bug reports name the line; plenty of stories are bugs. The appraisal, which already reads the ticket against the repository, judges that. → [who sets it](#the-label) |
| A fix                         | The investigator is in a read-only checkout and its prompt and tool both say not to implement. Its findings are testimony for the agent that does the work, never a patch.                                                                                                  |
| A verdict in the matrix       | It answers neither _is this finished_ nor _can it be worked from_. It parks nothing on its own: the hold it feeds is lifted the moment the label comes off. → [14](14-persistence.md#issue-verdicts-and-the-exclusion-matrix)                                               |
| Something that acts by itself | The agent's `recommendation` is advice. Only an operator's resolution moves the issue, and _close_ and _ask_ close nothing and post nothing. → [resolving them](#resolving-the-findings)                                                                                    |

## The label

**The investigate label is the only switch the rule reads.** `investigateLabelFor(prefix)` in
`src/watchLabels.ts` derives it: `${labelPrefix}-investigate`, so `lubbdubb-investigate` on a stock
deployment. Unlike the watch tag an empty prefix does not switch it off — the label is then bare
`investigate`. An empty watch label can mean "watch everything"; an empty investigate label has no
reading at all, and a deployment without a prefix should still have the switch.

`carriesInvestigateLabel` reads it **exactly as the watch gate is read**: under `requireOwnLabel`
(`userId` set) it reads `labelsAddedByViewer`, not `labels`, so a label somebody else put on the
ticket does not send the fleet to investigate it — the same trust boundary as the watch tag, and the
same failure if a provider cannot report authorship ([02](02-configuration.md#userid)). The label is
only read on an issue that already passes the watch gate: the rule walks `eligibleIssues`, so an
unwatched issue carrying it is left alone like any other.

Two hands put it on:

- **An operator, by hand**, on the tracker. That is the whole interface for "investigate this first".
- **The goal appraisal, once.** `appraise_issue` takes an optional `investigate` flag, honoured only
  with `workable` — an `unclear` ticket gets its questions first, and a goal nobody can start from has
  no cause to look for ([06](06-issue-pickup.md#a-bug-whose-cause-is-not-known)). It is stored on the
  appraisal row as `issue_appraisals.investigate`, and the `appraisal` event carries it. A listener in
  `src/system/system.ts` applies the label through `applyInvestigateLabel` (`src/issueWatch.ts`) — the
  same `ActionSink.setIssueLabel` write the watch toggle makes — and folds it onto the stored world and
  the ticket mirror, so the pulse after the appraisal sees the label without waiting for a hydrate.
  Without that fold the planner, released when the appraiser exits, could start on the pulse between.

**The label is applied at record time and never by a sweep**, and that is what makes removing it
stick. `issue_appraisals.investigate` is a record of what the appraiser asked for, not a desired
state: nothing reconciles the label against it. An operator who takes the label off a ticket the
appraiser labelled has answered _no, plan it as it is_, and a reconciler that put it back would
overrule them on every pulse with nothing red. The label returns only if a fresh appraisal asks
again — and an appraisal runs again only on a rewritten ticket, since its verdict is keyed to the
text.

A failed label write is recorded through `errors.record` and investigates nothing: the issue goes on
to the planner as though the appraiser had not asked. That is the fail-open direction.

## The rule — `issue-investigate`

Unconditional, registered in `DISPATCH_PIPELINE` directly after `issue-appraisal` and before
`criteria-alignment` and `issue-plan`. For each eligible issue it proposes one investigator when all
of these hold:

- the issue carries the label;
- it is not being appraised (`appraising`) — the appraisal goes first, because it may be the thing
  that asks for the investigation;
- there is no investigation against the issue's **current** text;
- it has no plan row and no work started (`hasWorkStarted`) — an issue already planned or worked has
  had its cause answered by someone acting on it, and a label added mid-flight investigates nothing;
- nothing else is live on `issue:<n>` or any `issue:<n>:*`.

The dispatch is a **code** agent in a read-only checkout of the default branch
([09](09-execution.md#the-read-only-checkout)), leased under `investigate/issue/<n>`, origin
`issue:<n>:investigate` — a `deliberation` family in `src/issueOrigins.ts`, so it is not prior work
and does not retire the appraisal or the planner. The prompt is `issue-investigate`
([05](05-dispatcher.md#prompt-templates)): reproduce it, find the root cause and say how sure, name
where it lives and what else shares the cause, then call `report_investigation` once with a
recommendation. `readOnlyNote` and `relatedWorkNote` are appended. Its only extra tool is
`report_investigation` ([11](11-mcp-tools.md#report_investigation)).

A story held behind its predecessors is held here too, queued as `held: 'sequenced'`, for the
appraiser's reason: it reads the repository as it stands, and a predecessor that has not landed is
code it would be investigating without ([33](33-story-sequencing.md#the-appraiser-is-held-as-well)).

## The holds

While the investigation is owed, **rule `issue-plan` and rule `issue-pickup` stand aside**. Both ask
`investigationSupersedes`, and it holds in two cases, both only while the label is on:

| Case                                                                  | Plan and pickup are queued                             |
| --------------------------------------------------------------------- | ------------------------------------------------------ |
| An investigator is proposed, on cooldown, sequenced, or running       | `superseded`, naming `issue-investigate`               |
| A current record waits on the operator, or was resolved _close_/_ask_ | `superseded`, with `investigationHold`'s reason quoted |

The first case is the `investigating` set on the `StageContext`, written by the rule and read by the
two after it — the same mechanism as `appraising`, with the same two properties
([05](05-dispatcher.md#where-a-rules-body-lives)). It is written **before** the active-origin guard
when the investigator's own origin is what is active, so the hold lasts as long as the agent does
rather than only the pulse that proposed it. And it is load-bearing state: moved below `issue-plan`,
the rule would compile, stop holding, and put a planner beside the investigator.

**Removing the label lifts every hold**, both cases, on the next pulse. It is the one lever, so it has
to be total: an operator who has decided the findings do not matter, or that a closed-out finding was
wrong, should not have to find a second control to release the issue. What the label does _not_
undo is a resolution's effect on the route and the prompt — those read the record, not the label
([below](#resolving-the-findings)).

## The findings

`report_investigation` writes one row of `issue_investigations` (`src/store/investigations.ts`),
keyed `issue:<n>` — one row per issue, overwritten by each new report, which resets its resolution:

| Field            | What it carries                                                                  |
| ---------------- | -------------------------------------------------------------------------------- |
| `reproduction`   | The smallest steps or inputs that show the bug, or what was tried and ruled out. |
| `root_cause`     | Why it happens, not where the symptom surfaces.                                  |
| `confidence`     | `high`, `medium` or `low`.                                                       |
| `locations`      | The files, functions and lines involved.                                         |
| `blast_radius`   | What else shares the cause or would be touched by fixing it.                     |
| `recommendation` | `plan`, `pickup`, `close` or `ask` — the agent's advice.                         |
| `resolution`     | Null while it waits on the operator; then theirs, from the same four.            |

**It is fingerprinted to the ticket text.** `goal_ref` is `goalFingerprint` of the title and body the
investigator was **dispatched with**, read off its task, so an edit made mid-run is not swallowed.
`currentInvestigation` drops a record whose fingerprint no longer matches, and every reader goes
through it: an edited ticket has no current findings, so its holds lift and — with the label still on
— the rule re-arms and investigates the new text. A rewrite usually means the reporter said
something new, and findings about the old text are about a different report.

The issue's state snapshot carries the current record as `Issue.investigation`, null when there is
none ([16](16-http-api.md#post-apiissuesnumberinvestigation)), and its pickup verdict reads `planning`
with the investigation's reason while the label holds it ([06](06-issue-pickup.md#a-bug-whose-cause-is-not-known)).
`investigationHold` and `FINDINGS_WAITING_REASON` live in `src/intake/investigationHold.ts`, apart from
the rest of `src/intake/investigation.ts`, because the cockpit's ask reads that reason and the fingerprint
beside it imports `node:crypto`, which the web bundle cannot.

In the cockpit the findings are a **`findings` ask** on the rail, standing exactly while that reason
holds the goal: the four fields drawn whole, the agent's recommendation marked on its button among the
four resolutions, and **Investigate again** beside them. The goal header carries an `Investigation ·`
chip while a current record exists. → [17](17-cockpit.md#hue-is-the-kind-weight-is-the-group)

## Resolving the findings

`POST /api/issues/:number/investigation` with `{resolution}` writes the operator's answer; `{clear:
true}` deletes the row.

| Resolution | What happens                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`     | The holds lift and the planner runs, with the findings **appended** to its prompt by `investigationNote`.                                                                                                             |
| `pickup`   | The holds lift and planning is skipped: `resolvePlanRoute` answers `unplanned` for an issue with no plan row ([08](08-planning.md#the-four-arms)), so rule `issue-pickup` works it whole, with the findings appended. |
| `close`    | The issue stays held while the label is on. The harness closes nothing — closing the ticket is the operator's own move on the tracker.                                                                                |
| `ask`      | The same hold. The harness posts nothing to the reporter; the operator asks, and the rewrite that answers it re-arms the rule.                                                                                        |
| _clear_    | The row is gone. With the label still on, the rule investigates again — the way to ask for a second look.                                                                                                             |

The note is appended, never interpolated, for the reason every addition to a prompt is
([05](05-dispatcher.md#prompt-templates)): the planner's and the pickup's templates are
operator-overridable, and an override that never learned a `{findings}` token would drop the findings
on exactly the deployments that customised most. It tells the agent the findings are one agent's
reading, accepted by an operator, to be checked against the repository.

The route and the note read the **record**, not the label: a `pickup` resolution skips planning and
both resolved arms carry the note whether or not the label is still on. Taking the label off after
resolving _pickup_ does not put a planner back on the issue; clearing the findings does.

## Fail open

Every one of these leaves the issue to the ordinary funnel, exactly as it would be with no label:

- no label, or a label the provider cannot attribute under `requireOwnLabel`;
- a failed label write after an appraisal asked;
- an investigator that crashed, was killed or spent its attempt cap — `consider` returns false on an
  `escalate` or `hold` verdict and the rule passes no escalation, so nothing is written to
  `investigating`, no record exists to hold on, and the planner runs. **No escalation is raised**, the
  appraisal's rule ([05](05-dispatcher.md#issue-appraisal--the-goal-appraisal)): narrowing the funnel
  without that would make an investigator that cannot finish the most effective way to stop the
  fleet;
- an edited ticket — the old findings are no longer current;
- the label taken off.

The one arm that holds without an agent running is a record waiting on, or resolved by, a person —
and the label is always there to lift it.

## Cost

A labelled bug spends one more agent before a line of its work is written: appraisal, investigation,
planner. It is spent only where somebody — an operator, or an appraiser that read the ticket against
the code — said the cause is unknown, and it is the agent that makes the planner's spend land on the
cause.

## Persistence

`issue_investigations` is a new table and needs no `ColumnMigrations` entry.
`issue_appraisals.investigate` is a column on an existing one and has one, `INTEGER NOT NULL DEFAULT
0`; every row from before it reads `false`, which is the truth — no appraiser asked — so no backfill is
owed. → [14](14-persistence.md#migrations)

## Tests

`test/issueInvestigation.test.ts`, at the `RuleDispatcher` seam and through `buildSystem`:

- the label's name, with and without a prefix, and that it is read under `requireOwnLabel` exactly as
  the watch tag is;
- a labelled issue is investigated read-only before it is planned; an unlabelled one is not, and one
  still being appraised is not;
- a running investigator and unresolved findings each hold plan and pickup; removing the label lifts
  both;
- an edit re-arms the rule;
- _plan_ runs the planner with the findings appended; _pickup_ skips planning and carries them;
  _close_ and _ask_ dispatch nothing;
- a spent attempt cap fails open to the planner with no escalation;
- `report_investigation` is named, placed only on the investigator's row, fenced to its origin, and
  fingerprints the text the agent was handed;
- an appraisal that asks labels the issue once, one that does not ask leaves it, and an `unclear`
  appraisal never labels;
- the route resolves, clears, and refuses an unknown resolution with 400 and a missing record with 404.

`test/investigationCockpit.test.ts` covers the cockpit half: the pickup verdict's investigation reasons
and their fall-back once answered or unlabelled, and the `findings` ask — what it draws, that it stands
only while the pickup verdict says the findings hold the goal, and that each answer and **Investigate
again** reach the route.
