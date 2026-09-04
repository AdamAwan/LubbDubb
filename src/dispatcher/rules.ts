/**
 * The dispatcher's rule book, as data — and, for the entries that are rules, as
 * the **order they are evaluated in**.
 *
 * Each branch of the dispatcher tags the actions it emits with one of these ids,
 * the id is persisted on the decision row, and the registry ships to the cockpit
 * (in `/api/state`) so a Decision log row can expand into "which rule fired, and
 * why it exists".
 *
 * There is deliberately **no rule number**. There used to be, hand-written on
 * each entry ('1', '2b', '3c', …), and it rotted exactly as a second copy of an
 * ordering always does: by the time it was removed, `issue-appraisal` was numbered
 * after `issue-plan` and evaluated before it, two entries both claimed '3b', and
 * three claimed positions that were not positions at all ('1–2b', '1–4'). Order
 * now lives in one place — the declaration order of {@link DISPATCH_PIPELINE} —
 * and nothing renders a position. An entry is named, and the name is the id.
 *
 * ## Two vocabularies, one registry
 *
 * `kind` splits them, and the split is the point:
 *
 * - **`rule`** — proposes work from the world. These are the pipeline, in order.
 * - **`admission`** — decides what becomes of something a rule proposed. Not
 *   ordered per-feature and not a stage: every proposal passes the same chain
 *   (see `admission.ts`). Two of them emit actions of their own, and those land
 *   in `decisions.admission` — a **column of its own**, so a throttled pickup
 *   records `issue-pickup` as its proposer *and* `cooldown-escalate` as its
 *   outcome rather than losing the first to the second. {@link AdmissionId} is
 *   what keeps the two columns' vocabularies apart at compile time.
 * - **`terminal`** — a property of the finished cycle rather than of any rule.
 *
 * The registry keeps all three because `decisions.rule` is **persisted**: a row
 * written months ago naming `cooldown-escalate` — before the split gave the
 * outcome its own column — must still resolve to something the Decision log can
 * render. So the registry is the display vocabulary (a superset) and the pipeline
 * is the ordered subset that actually runs.
 */

/**
 * Whether an entry runs as a pipeline stage, transforms what a stage proposed, or
 * describes the cycle itself. See the module doc.
 */
type RuleKind = 'rule' | 'admission' | 'terminal';

/**
 * The operator switches a rule's `enabled` predicate may ask about, flattened to
 * booleans so this module stays dependency-free — it is imported by the server,
 * the cockpit's snapshot builder and the action parser, and a policy type dragged
 * in here would drag the plan/appraisal/retro modules along with it.
 *
 * `workItemStates` is the one that isn't a feature flag: the work-item rules are
 * on when the operator has configured **both** a review state and pickup states,
 * which is a property of `IssuePickupPolicy` rather than a switch of its own.
 * `workItemInProgress` is the same shape over the other two keys — an in-progress
 * state and pickup states — and is separate because the two states are separate
 * knobs: setting one must not switch on the rule that reads the other.
 */
export interface RuleConditions {
  workItemStates: boolean;
  workItemInProgress: boolean;
  /**
   * The fleet review, `config.review.enabled` — the one condition here that is a
   * plain operator switch rather than a property of the provider. It is switched
   * in this way rather than with an `if` inside the concern pass for the reason
   * the work-item rules are: the registry is where a rule is in or out of the
   * pipeline, and a rule held back inside its own body is one the Decision log
   * still advertises as live.
   */
  review: boolean;
  /**
   * `issueSequencing` at `full` — the only level that runs an agent. At `links` the
   * gate is on and the sequencer is not: the edges are ones a person drew, so there
   * is nothing to propose and nothing to accept.
   */
  sequencer: boolean;
}

export interface DispatchRule {
  name: string;
  /** Why the rule exists — the standing rationale, independent of any one firing. */
  description: string;
  kind: RuleKind;
  /**
   * When this rule is live. Omitted => unconditional. Only meaningful for
   * `kind: 'rule'`; this is the single place an optional rule is switched in and
   * out of the pipeline, replacing the `if (this.<feature>.enabled)` blocks that
   * used to wrap four of the rule bodies.
   */
  enabled?: (c: RuleConditions) => boolean;
}

/**
 * Every rule, in evaluation order, followed by the entries that are not stages.
 *
 * **Adding a rule is adding an entry here, in the position it should run.** The
 * dispatcher walks this array; there is nothing else to keep in step, and nothing
 * downstream renders an index, so inserting one mid-list renumbers nothing.
 */
const RULES = [
  // ---- Operator work: jumps every world-driven rule. ------------------------
  {
    id: 'manual-job',
    kind: 'rule',
    name: 'Operator-launched job',
    description:
      'A job the operator queued from the cockpit is drained before any world-driven rule, claiming the next free slot first — so a manual request takes priority, and simply waits in the queue when the fleet is at capacity.',
  },
  {
    id: 'local-validation',
    kind: 'rule',
    name: 'Validate a goal on this machine',
    description:
      "The operator pressed Validate locally on a goal, so the harness brought that goal's code up in the machine's one dev environment and this puts one agent on it: write a test plan for the change, wait for the environment, drive the running application through the plan, and report passed, failed or blocked. It is dispatched while the environment is still coming up, because a bring-up is minutes inside one turn and writing the plan is exactly what that wait is worth spending on. The checkout is read-only and pinned to the commit the environment stands at, and the launch carries a browser as a second MCP server — the fleet has none otherwise, and a headless agent cannot open a page without one. It ranks directly behind operator-launched jobs, for their reason: somebody is at a screen waiting, with an environment already running on their machine. A row is one press of a button rather than a standing signal, so there is no cooldown budget and no escalation — it is re-proposed each pulse until it dispatches, the operator calls it off, or the environment goes away, and the last two settle the row.",
  },

  // ---- The fleet's own way, before the work it is in the way of. -----------
  {
    id: 'obstacle-repair',
    kind: 'rule',
    name: 'Something is blocking the fleet',
    description:
      'An obstacle two or more agents reported — and which is blocking the fleet *now*, meaning a base branch is red or three independent voices have hit it — gets one code agent to fix it. It is the second of the two ways an obstacle gets an owner (the other is a ticket, filed by the ownership desk and ranked like any other goal), and it is a capability rather than a convenience: a store that can queue work can put agents on the fleet. So it is one rule, here where it can be seen, taking the headroom cut like every other candidate — and bounded on top of that to **one repair in flight at a time**, because the cut bounds how many agents run and not how many of them this rule may be. It sits above every world-driven rule because what it dispatches for is, by construction, in front of the work those rules are about to propose: an agent sent to a red base is an agent sent to the reason the next four dispatches would have failed. Nothing an agent calls reaches it — no agent stakes a claim on an obstacle, because a lock an agent takes is a lock an agent forgets. A repair that spends its attempt cap escalates rather than looping: an obstacle three agents could not clear is what an operator wants to be told about.',
  },

  // ---- PR concerns. Four of these collect concerns for one branch; the ------
  // order they appear in here *is* the urgency order the fold reads.
  {
    id: 'pr-review-triage',
    kind: 'rule',
    name: 'Choose how to review a pull request',
    description:
      "A watched pull request the fleet has not reviewed, on a project that declares more than one way of reviewing, gets one desk agent to say which. The choice is a model's rather than a threshold's, because what makes a diff worth a careful read — it touches auth, it is the first change in a subsystem, the ticket calls it a spike — is judged rather than counted; it reads the project's routing charter and the shape of the change, never the diff, so routing costs a fraction of what reviewing does. Its verdict is a mode name, which decides the reviewer's prompt, charter and model profile before any of them is resolved. It runs above the PR concerns rather than among them because it takes no branch. Fails open and silent: no route means `pr-review` runs the default mode, so a triage that never answers costs a more careful read and never a pull request nobody reads. Inert where the project declares fewer than two modes — a decision with one option is not a decision.",
    enabled: (c) => c.review,
  },
  {
    id: 'pr-review',
    kind: 'rule',
    name: 'Pull request not yet reviewed',
    description:
      "A watched pull request nothing has reviewed gets a read-only agent to read the diff and say what it found, before a person is asked to. It leads the PR concerns because the review is the earliest thing that can be done to a pull request and the one whose value decays fastest: a diff read on the pulse it opened is read once, where the same reading taken after a CI fix and a base merge is a reading of somebody else's work. It stands down — rather than ranking below — where a human reviewer already has unhandled threads open, since the diff is about to be rewritten and a second opinion on the old one is spent for nothing. One round, ever: the verdict is recorded against the pull request, nothing re-reviews it after a push, and what it found reaches the person whose approval the merge still needs. Off unless the operator turns it on, because it is the one rule that spends an agent on every pull request.",
    enabled: (c) => c.review,
  },
  {
    id: 'pr-review-comment',
    kind: 'rule',
    name: 'Unhandled review comments',
    description:
      'Every unresolved review thread on a PR goes to one code agent together, to either fix the code or draft a reply defending the approach — review feedback must never silently rot. All of them at once, not one per cycle: comments from a single review pass are related, so answering them in isolation produces duplicate or contradictory fixes. It leads the PR concerns because a review is the one signal that can invalidate the diff itself: fixing CI or resolving a conflict against code a reviewer is about to have rewritten spends an agent on work the next push throws away, and re-conflicts the branch a second time.',
  },
  {
    id: 'pr-ci-failing',
    kind: 'rule',
    name: 'Failing CI',
    description:
      'A PR with failing CI gets a code agent on its branch to investigate and push a fix — broken builds block everything downstream, so this outranks every concern but an open review.',
  },
  {
    id: 'pr-ci-blocked',
    kind: 'rule',
    name: 'CI blocked elsewhere',
    description:
      'Every failing check on this PR is one the operator configured as somebody else’s to fix, and at least one asked to be escalated rather than ignored. No agent is dispatched — a human is asked once, since nothing an agent can do would turn the PR green.',
  },
  {
    id: 'pr-ci-gate',
    kind: 'rule',
    name: 'Check waiting on an action',
    description:
      'A blocking check the operator configured with `states: ["pending"]` is sitting queued rather than running — an Azure status policy waiting on a command somebody has to issue. Nothing is red, so no other rule looks at it and the PR would wait forever. One code agent is sent to do what the rule’s guidance names, on its own origin `pr:<n>:ci-gate`: the cooldown budget for a stalled gate is not the budget for a broken build, and a gate the agent cannot clear escalates on its own attempt cap. Ranked below a red build — a failing check is a thing that broke, a waiting one is a thing that has not happened yet.',
  },
  {
    id: 'pr-base-update',
    kind: 'rule',
    name: 'Base out of date',
    description:
      'A PR that has fallen **behind** its base branch is brought back into line so it never sits unmergeable while the base moves on. Behind means the provider has already said the merge is clean, so there is no judgement in it and no agent is spent: the harness asks the provider to merge the base in itself, in one request, and the act is audited under the same origin an agent would have been. A provider that cannot do the merge itself — Azure DevOps has no such endpoint — or one that refuses falls back to a code agent on the next pulse, so the cheap path being unavailable never leaves a PR behind. Second-to-last of the concerns, because a base merged now into code an open review is about to change is a merge done twice.',
  },
  {
    id: 'pr-base-update-conflict',
    kind: 'rule',
    name: 'Conflicts with base',
    description:
      'A PR that **conflicts** with its base branch keeps its code agent, because resolving a conflict is judgement rather than a merge the provider has already called clean — and the prompt tells the agent to escalate if it cannot resolve cleanly. Split from `pr-base-update` so the two arms of one predicate can be priced apart in `agentModels.byRule`: conflict resolution and a routine base merge want different models, and on a provider with no direct-merge endpoint both arms would otherwise dispatch an agent on one profile. It shares the `pr:<n>:mergeable` origin with the behind arm — same PR, same problem, so one cooldown and one attempt budget. Last of the concerns, for the reason the behind arm is second-to-last.',
  },
  {
    id: 'pr-merge-ready',
    kind: 'rule',
    name: 'Merge-ready PR',
    description:
      'A green, approved, mergeable PR with no open comments is driven the last mile — merged in, gated by the auto-send policy (below the confidence bar it escalates for approval instead).',
  },

  // ---- Tracker state. Opt-in: pickup states, plus the state each rule moves to.
  {
    id: 'work-item-in-progress',
    kind: 'rule',
    name: 'Advance to in-progress state',
    description:
      'A work item in a pickup state that an agent is actually working — a live task on the goal itself or on one of its plan parts — is moved to the configured in-progress state, so the board shows work in flight where it is rather than sitting in "Ready". It fires off the observed task rather than off the dispatch that started it: a candidate can be cut by headroom or held on cooldown, and parking an item in "Doing" that nobody is working is the failure the rule exists to avoid. Observational and idempotent, so a provider write that was refused is simply attempted again next cycle. It never fires for an item with an open PR or a decomposed one — those belong to the review state, and the two rules are mutually exclusive by construction.',
    enabled: (c) => c.workItemInProgress,
  },
  {
    id: 'work-item-in-review',
    kind: 'rule',
    name: 'Back off to review state',
    description:
      'A work item still in a pickup state whose PR is already open is moved to the configured review state, so it waits on review/CI instead of being re-picked every cycle.',
    enabled: (c) => c.workItemStates,
  },
  {
    id: 'work-item-back-to-pickup',
    kind: 'rule',
    name: 'Return from review state',
    description:
      'The inverse of the back-off: a still-open work item parked in the review state whose PR is no longer open is moved back to the first configured pickup state, so work left over after that PR merged can be picked up instead of the item staying parked forever.',
    enabled: (c) => c.workItemStates,
  },

  // ---- The funnel in front of an issue, in the order it narrows. ------------
  {
    id: 'issue-appraisal',
    kind: 'rule',
    name: 'Issue goal needs checking',
    description:
      'A watched open issue nothing has been started for yet gets a code agent to read the ticket against the repository and say whether there is a goal here an agent could start from. It is the only gate in front of an issue that asks about *content*: every other one — the watch tag, the workflow state, the cooldown, the attempt cap, headroom — asks whether the harness is allowed to act, never whether there is anything to act on. A verdict of `unclear` stops the funnel for that issue and says what a human would need to supply; it ends by itself the moment the ticket is edited or anything happens on it. Ranked ahead of the planner, because appraising a goal the planner is about to decompose is the whole point. An appraiser that writes no verdict — crashed, killed or capped — leaves the issue to ordinary pickup, so a failure can never park one.',
  },
  {
    id: 'issue-plan',
    kind: 'rule',
    name: 'Issue needs a plan',
    description:
      'A watched open issue with no plan yet gets a planning agent first: it reads the repository and decides whether the work is one pull request or several, biasing hard toward one. Planners rank ahead of pickups because a planner unblocks work. The same rule fires for a *replan* (an operator sent an existing plan back), with the planner primed with the current plan and part states so it amends rather than re-derives. A planner that never produces a plan fails open to the single-PR path after the attempt cap — or, for a replan, back to the decomposition the issue already had — so a failure can never park an issue.',
  },
  {
    id: 'issue-assess',
    kind: 'rule',
    name: 'Issue may be finished',
    description:
      'A watched open issue that has already had agents on it, has nothing in flight and no open PR, gets a code agent to read what was actually delivered and say whether the issue is finished. It writes `delivered` — weaker than the tracker’s `closed`, reversible, and its only effect is to stop pickup — or sends the issue back round with an outstanding-work note. It is what stops `issue-pickup` re-picking work whose PR has merged and left the open list, which on GitHub nothing else prevents, and it ranks ahead of pickup for exactly the issues both would otherwise claim. An assessor that spends its attempt cap fails the issue open to ordinary pickup, so a failure can never park an issue.',
  },
  {
    id: 'issue-shortfall',
    kind: 'rule',
    name: 'Assessment says the goal was missed',
    description:
      'An assessor read the delivered work and said the issue’s goal is still not reached. This is the one consumer of that verdict, and it routes it by what the assessor said fell short rather than sending everything to a replan: a wrong decomposition goes back to a planner, one part that missed its own scope gets a follow-up part appended (the part itself is untouched — its branch is spent), and a wrong or ambiguous goal goes to a human, because no planner or agent can fix one. The first two spend agents, so they are proposed for your approval rather than taken; the third is only ever a question.',
  },
  {
    id: 'issue-retro',
    kind: 'rule',
    name: 'Delivered goal needs a retrospective',
    description:
      'An issue the harness has parked as delivered, with nothing in flight under it and no retrospective yet, gets one desk agent to write the run up: what shipped, and what came out of the process of shipping it. It is handed the shared scratchpad the working agents left and the record the harness kept — which rules fired, what was escalated and how it was answered, replans, shortfalls, what it cost — and it writes one document per goal, read in the cockpit on the station that used to say nothing. It schedules nothing, gates nothing and posts nothing to the tracker, so a retrospective that never gets written costs only the report: an agent that crashes or spends its attempt cap leaves the goal exactly as delivered, with no escalation, because there is nothing a human can do about a write-up that did not happen that they cannot do by reading the issue.',
  },

  // ---- Plans: approve, notice a wedge, then schedule. -----------------------
  {
    id: 'plan-approval',
    kind: 'rule',
    name: 'Plan needs your approval',
    description:
      '**Every** planner verdict is a proposal rather than work: the plan lands as `awaiting_approval`, this rule puts it to you once, and nothing is scheduled until you accept — `plan-part` holds a decomposition\'s parts, `issue-pickup` holds a single verdict\'s issue. Accepting releases the plan, to `active` for a decomposition or to `single` for one pull request. Rejecting a decomposition retires the parts nothing has started for and falls the issue back to a single pull request; rejecting a single verdict sends the plan back to a planner with your reason, since the single-PR route is what a rejected decomposition already falls back to. Either way a "no" leaves the issue a route instead of parking it. A replan asks again — the amended verdict is a new proposal, and the old one cannot release it. There is no deployment in which a verdict commits the moment the planner writes it. A `single` verdict the harness *overruled* — parts are already in flight — is never asked about: the collapse was refused, so there is no decision in it.',
  },
  {
    id: 'plan-amendment',
    kind: 'rule',
    name: 'Change to a running plan needs your approval',
    description:
      'Somebody — an agent working the plan, or you at your own keyboard — has proposed a correction to a plan that is already running, and it waits here until you answer it. This is the alternative to a replan for the case a replan is wrong for: a part whose scope drifted, a dependency that turned out to be the other way round, a step nobody needs any more. **Nothing is paused while you decide.** The plan keeps scheduling exactly as it was, its agents keep working, and accepting ingests the amended document over it — merged on slug, so a part with a branch, a pull request or an outcome keeps all three and only its declaration is refreshed. Rejecting changes nothing at all, which is what "carry on as planned" means. One amendment per plan is asked about at a time.',
  },
  {
    id: 'plan-blocked',
    kind: 'rule',
    name: 'Approved plan is going nowhere',
    description:
      'Every part of a released plan is blocked, so no agent has been dispatched for it and none will be. The only thing that blocks a part is the ref collision — a flat `issue/<n>` branch, which git will not let the part branches sit beneath — and a branch does not clear itself. No agent is dispatched, because none could help; a human is asked once, and told the two ways out: clear the branch, or abandon the decomposition and work the issue as one pull request. Only released plans, since an unapproved one is already in front of you with the same warning on the ask.',
  },
  {
    id: 'local-validation-fix',
    kind: 'rule',
    name: 'Fix what a local validation found',
    description:
      'A local validation was reported `failed` with findings, so one code agent is put on the branch that was validated to fix them. Writable and on that branch rather than a new one, because that is where the change being validated lives; the branch gate defers it while a part agent is already there, which is right — two agents on one branch is the thing that gate exists for. One dispatch per failed reading, latched on the row, so a fix that crashed is not retried behind the operator: pressing the button again is the same decision they made the first time. It opens no pull request and records nothing on the validation — the reading belongs to the agent that took it, and the branch\u2019s own pull request rules pick the push up. A validation that ran from the integration branch gets no fix, because there is no branch of the goal\u2019s to put one on.',
  },
  {
    id: 'plan-part',
    kind: 'rule',
    name: 'Plan part ready',
    description:
      "One part of a multi-PR plan whose dependency has pushed a branch worth stacking on, and which has no agent, gets a code agent on `issue/<n>/<slug>` — based on that dependency's branch while it is still open, on the default branch once it merged. Parts rank after planners and ahead of one-shot pickups, bottom of a stack first, and `maxConcurrentPartsPerIssue` caps how many parts of one plan may have agents at once: a human stacks safely because they hold the decomposition in their head, and N concurrent agents do not. A part held by that cap is queued as `capped` rather than skipped, so the limit is visible instead of looking like nothing happened.",
  },

  // ---- The unplanned path, last: everything above narrows it. ---------------
  {
    id: 'issue-pickup',
    kind: 'rule',
    name: 'Open issue without a PR',
    description:
      'An open, pickup-eligible issue with no *open* PR gets a code agent to resolve it into a PR — the front of the issue → PR → merge loop, ordered by label-encoded priority. Gating on an open PR (rather than on any PR ever having been linked) is what lets an issue take more than one PR. It fires only for an issue whose plan says `single`; its behaviour for such an issue is otherwise unchanged.',
  },

  // ---- Last, deliberately: neither may take a slot from work. ---------------
  {
    id: 'validate-check',
    kind: 'rule',
    name: 'Handed-over validation check',
    description:
      'A validation check on a delivered goal that the **operator** handed to the fleet, and which nobody has recorded a reading against, gets a code agent to run it on a throwaway branch cut from the default branch and report what it saw. The hand-over is the entire gate: a planner’s `fleetCandidate` nomination dispatches nothing, because whether an agent can run a check depends on what logins and browsers this deployment has, which a planner reading the repository cannot know. It ranks last of every rule that produces work, below even one-shot pickup — only `validation-failed`, which is a second opinion on work somebody has already done, and `feature-summary`, which produces no work at all, sit below it — because validation’s standing promise is that it blocks nothing — a check that could take the final slot from a blocked part or a red build would make the one feature that gates nothing the reason something else did not run. An agent that finds it cannot do the work hands the check back with its reason instead of recording a failure, which returns it to the operator; one that crashes or spends its attempt cap leaves the check exactly as it was, `unrun` and still flagged, with no escalation — the flag is already the ask.',
  },

  {
    id: 'validation-failed',
    kind: 'rule',
    name: 'A validation check came back failed',
    description:
      'A validation check that somebody ran against the delivered goal and recorded as **failed** gets one code agent, in a read-only checkout of the default branch, to reproduce it and say what is behind it. It is the one negative verdict in the harness that used to schedule nothing: an assessment that says the goal was not reached reaches `issue-shortfall`, a red build reaches `pr-ci-failing`, and a person who watched the delivered thing not work wrote a note that waited for them to come back to it. It is deliberately **not** wired through a shortfall, which would clear the goal’s delivery row and so un-park the goal, settle its close-out obligation and decline the very bench row the reading was taken for — a shortfall says the work is not finished, and a failed check says the finished work does not do what somebody checked it for. The agent fixes nothing and files nothing on its own authority: it diagnoses, and the doors it already has carry the three honest endings — `escalate` for a real defect somebody has to decide about, `validation_amend` for a check describing something that no longer exists, `raise` for what the next agent should not have to rediscover. It cannot record a reading at all, structurally: `validation_report` resolves its check from the dispatch origin and this rule’s origin is not one it parses, so an agent that decides the check actually passes is refused by the tool rather than by a sentence in a prompt. Each reading gets its own attempt budget — a check that failed, was fixed and failed again is looked at again — and a spent cap escalates nothing, because the flag and the note are already in front of the operator.',
  },

  // ---- Below even validation: the one rule that produces no work. -----------
  {
    id: 'feature-summary',
    kind: 'rule',
    name: 'Feature has moved since anybody said where it was',
    description:
      "Something under a Feature has changed standing since its summary was written — or it has never had one — so one desk agent writes the account a developer would give the person who asked for the Feature: where it is, what of it is usable today and where, what is blocking, and what is left. The trigger is a comparison rather than an event: the summary stores a digest of where every child stood when it was written, and this rule fires exactly when that digest no longer matches, so an unmoved Feature costs one string comparison a pulse and no agent, for ever. What the digest is built from is standings and never text, so a typo fixed in a child's title re-summarises nothing. It ranks below every other rule — `validate-check` included, which is otherwise the bottom — because it is the only rule that produces no work at all: validation is a reading somebody asked for, and this is a paragraph about readings already taken. It schedules nothing, gates nothing and posts nothing to the tracker, so a summary that never gets written costs only the paragraph: an agent that crashes or spends its attempt cap leaves the Feature exactly as it was, with no escalation, because there is nothing a human can do about it that they cannot do by reading the board under it.",
  },

  {
    id: 'feature-sequence',
    kind: 'rule',
    name: 'Feature has stories nobody has put in an order',
    description:
      'A Feature has gained or lost stories since anybody wrote an order for them — or has never had one — so one desk agent reads the Feature and its children and proposes which go first. It writes nothing to the tracker, cuts no branch, and holds nothing until a person accepts it: a proposal an operator has not answered leaves every story eligible exactly as it is today. It sits beside `feature-summary` at the bottom for the same reason — it produces no work of its own — and fails open and silent, because a sequencer that crashed leaves the Feature with the ordering it already had, and an inbox item per unsequenced Feature would be a queue of chores generated by a feature nobody asked for.',
    enabled: (c) => c.sequencer,
  },

  // ---- Not stages. Position here is display order only. ---------------------
  // These two transform what a rule proposed rather than proposing anything, so
  // they take no place in the pipeline — but they emit actions of their own, and
  // `decisions.rule` has been persisting their ids for as long as they have
  // existed, so they stay in the registry for the Decision log to resolve.
  {
    id: 'branch-notify',
    kind: 'admission',
    name: 'One agent per branch',
    description:
      'At most one code agent works a PR branch: a fresh signal for a branch that already has a running agent is delivered to that agent as a note instead of spawning a second one.',
  },
  {
    id: 'cooldown-escalate',
    kind: 'admission',
    name: 'Attempt cap reached',
    description:
      'A persistent concern that repeated agent attempts failed to clear is escalated to a human instead of dispatching again — the cooldown/attempt cap that keeps the loop bounded.',
  },
  {
    id: 'idle',
    kind: 'terminal',
    name: 'Nothing actionable',
    description:
      'No rule matched this cycle, so a no-op is recorded — idleness is a decision too, and stays auditable.',
  },
] as const satisfies readonly ({ id: string } & DispatchRule)[];

/** Every id that can appear in `decisions.rule`, rules and non-rules alike. */
export type DispatchRuleId = (typeof RULES)[number]['id'];

/**
 * The ids that can appear in `decisions.admission` — what *became* of a proposal,
 * as against the `rule` column's what *proposed* it.
 *
 * Derived from the registry rather than written out, so a rule id structurally
 * cannot land in the admission column: that conflation is the whole defect the
 * split exists to end, and a hand-written union would let it back in the moment
 * somebody added an id. `idle` is excluded with the rules — it is a property of
 * the finished cycle, not a verdict on anything proposed.
 */
export type AdmissionId = Extract<(typeof RULES)[number], { kind: 'admission' }>['id'];

/**
 * The ids that are pipeline stages, in evaluation order. The dispatcher walks
 * this; `StageRuleId` is what makes "every rule has an implementation" a
 * compile-time question rather than a test.
 */
export type StageRuleId = Extract<(typeof RULES)[number], { kind: 'rule' }>['id'];

/** The rules, in evaluation order. */
export const DISPATCH_PIPELINE: readonly { id: StageRuleId; enabled?: (c: RuleConditions) => boolean }[] = RULES.filter(
  (r): r is Extract<(typeof RULES)[number], { kind: 'rule' }> => r.kind === 'rule',
);

/** The whole vocabulary, keyed by id — what `/api/state` ships to the cockpit. */
export const DISPATCH_RULES = Object.fromEntries(RULES.map(({ id, ...rule }) => [id, rule])) as Record<
  DispatchRuleId,
  DispatchRule
>;

/**
 * Cross-PR rank of a concern class: review comment beats CI beats base-update.
 *
 * Read off the pipeline rather than restated anywhere. It used to be three
 * hardcoded numbers that happened to agree with the order the concerns are pushed
 * in and with the registry's own numbering — three copies of one fact, which is
 * the arrangement the rule numbers rotted under. It lives here, beside the
 * pipeline it reads, because it has two callers: rule `pr-ci-failing`, which
 * ranks the concerns it dispatches for, and `prAttention`'s lens, which has to
 * name the same one (#562 — the lens encoded the pre-reorder order in statement
 * order and led with CI while the agent went out for the review). A rule with no
 * pipeline position sorts last rather than throwing: this only orders concerns,
 * and a wrong order is a worse failure than a late one.
 */
export function concernUrgency(rule: DispatchRuleId): number {
  const at = DISPATCH_PIPELINE.findIndex((r) => r.id === rule);
  return at === -1 ? Number.MAX_SAFE_INTEGER : at;
}
