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
 * ordering always does: by the time it was removed, `issue-assay` was numbered
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
 * in here would drag the plan/assay/retro modules along with it.
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

  // ---- PR concerns. Four of these collect concerns for one branch; the ------
  // order they appear in here *is* the urgency order the fold reads.
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
    id: 'issue-assay',
    kind: 'rule',
    name: 'Issue goal needs checking',
    description:
      'A watched open issue nothing has been started for yet gets a code agent to read the ticket against the repository and say whether there is a goal here an agent could start from. It is the only gate in front of an issue that asks about *content*: every other one — the watch tag, the workflow state, the cooldown, the attempt cap, headroom — asks whether the harness is allowed to act, never whether there is anything to act on. A verdict of `unclear` stops the funnel for that issue and says what a human would need to supply; it ends by itself the moment the ticket is edited or anything happens on it. Ranked ahead of the planner, because assaying a goal the planner is about to decompose is the whole point. An assayer that writes no verdict — crashed, killed or capped — leaves the issue to ordinary pickup, so a failure can never park one.',
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
    id: 'plan-blocked',
    kind: 'rule',
    name: 'Approved plan is going nowhere',
    description:
      'Every part of a released plan is blocked, so no agent has been dispatched for it and none will be. The only thing that blocks a part is the ref collision — a flat `issue/<n>` branch, which git will not let the part branches sit beneath — and a branch does not clear itself. No agent is dispatched, because none could help; a human is asked once, and told the two ways out: clear the branch, or abandon the decomposition and work the issue as one pull request. Only released plans, since an unapproved one is already in front of you with the same warning on the ask.',
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

  // ---- Last, deliberately: it must never take a slot from work. -------------
  {
    id: 'validate-check',
    kind: 'rule',
    name: 'Handed-over validation check',
    description:
      'A validation check on a delivered goal that the **operator** handed to the fleet, and which nobody has recorded a reading against, gets a code agent to run it on a throwaway branch cut from the default branch and report what it saw. The hand-over is the entire gate: a planner’s `fleetCandidate` nomination dispatches nothing, because whether an agent can run a check depends on what logins and browsers this deployment has, which a planner reading the repository cannot know. It ranks **last of every rule**, below even one-shot pickup, because validation’s standing promise is that it blocks nothing — a check that could take the final slot from a blocked part or a red build would make the one feature that gates nothing the reason something else did not run. An agent that finds it cannot do the work hands the check back with its reason instead of recording a failure, which returns it to the operator; one that crashes or spends its attempt cap leaves the check exactly as it was, `unrun` and still flagged, with no escalation — the flag is already the ask.',
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
