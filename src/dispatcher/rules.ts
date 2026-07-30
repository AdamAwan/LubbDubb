/**
 * The RuleDispatcher's rule book, as data. Each branch of the dispatcher tags
 * the actions it emits with one of these ids, the id is persisted on the
 * decision row, and the registry ships to the cockpit (in `/api/state`) so a
 * Decision log row can expand into "which rule fired, and why it exists".
 * The `number` mirrors the priority ordering documented on {@link RuleDispatcher}.
 */
interface DispatchRule {
  /** Position in the dispatcher's priority order ('1'..'9', with sub-rules like '2b'). */
  number: string;
  name: string;
  /** Why the rule exists — the standing rationale, independent of any one firing. */
  description: string;
}

export const DISPATCH_RULES = {
  'manual-job': {
    number: '0',
    name: 'Operator-launched job',
    description:
      'A job the operator queued from the cockpit is drained before any world-driven rule, claiming the next free slot first — so a manual request takes priority, and simply waits in the queue when the fleet is at capacity.',
  },
  'pr-ci-failing': {
    number: '1',
    name: 'Failing CI',
    description:
      'A PR with failing CI gets a code agent on its branch to investigate and push a fix — broken builds block everything downstream, so this outranks all other work.',
  },
  'pr-ci-blocked': {
    number: '1b',
    name: 'CI blocked elsewhere',
    description:
      'Every failing check on this PR is one the operator configured as somebody else’s to fix, and at least one asked to be escalated rather than ignored. No agent is dispatched — a human is asked once, since nothing an agent can do would turn the PR green.',
  },
  'pr-base-update': {
    number: '2',
    name: 'Base out of date',
    description:
      'A PR that is behind its base branch (clean update) or conflicts with it (resolve and push) gets a code agent, so it never sits unmergeable while the base moves on.',
  },
  'pr-review-comment': {
    number: '2b',
    name: 'Unhandled review comment',
    description:
      'An unhandled reviewer comment gets a code agent to either fix the code or draft a reply defending the approach — review feedback must never silently rot.',
  },
  'branch-notify': {
    number: '1–2b',
    name: 'One agent per branch',
    description:
      'At most one code agent works a PR branch: a fresh signal for a branch that already has a running agent is delivered to that agent as a note instead of spawning a second one.',
  },
  'pr-merge-ready': {
    number: '3',
    name: 'Merge-ready PR',
    description:
      'A green, approved, mergeable PR with no open comments is driven the last mile — merged in, gated by the auto-send policy (below the confidence bar it escalates for approval instead).',
  },
  'work-item-in-review': {
    number: '3b',
    name: 'Back off to review state',
    description:
      'A work item still in a pickup state whose PR is already open is moved to the configured review state, so it waits on review/CI instead of being re-picked every cycle.',
  },
  'work-item-back-to-pickup': {
    number: '3b',
    name: 'Return from review state',
    description:
      'The inverse of the back-off: a still-open work item parked in the review state whose PR is no longer open is moved back to the first configured pickup state, so work left over after that PR merged can be picked up instead of the item staying parked forever.',
  },
  'issue-plan': {
    number: '3c',
    name: 'Issue needs a plan',
    description:
      'With the planning funnel enabled, a watched open issue with no plan yet gets a planning agent first: it reads the repository and decides whether the work is one pull request or several, biasing hard toward one. Planners rank ahead of pickups because a planner unblocks work. The same rule fires for a *replan* (an operator sent an existing plan back), with the planner primed with the current plan and part states so it amends rather than re-derives. On by default; turning it off leaves rule 4 un-narrowed and every issue a single pull request. A planner that never produces a plan fails open to the single-PR path after the attempt cap — or, for a replan, back to the decomposition the issue already had — so a failure can never park an issue.',
  },
  'plan-approval': {
    number: '3d',
    name: 'Plan needs your approval',
    description:
      'With `planning.requireApproval` on, a `parts` verdict is a proposal rather than work: the plan lands as `awaiting_approval`, this rule puts it to you once, and rule 4a schedules none of its parts until you accept. Accepting releases the plan; rejecting retires the parts nothing has started for and falls the issue back to a single pull request, so a "no" leaves it a route instead of parking it. A replan asks again — the amended decomposition is a new proposal, and the old verdict cannot release it. On by default, and only meaningful with the funnel on: without the flag a decomposition commits the moment the planner writes it.',
  },
  'issue-assess': {
    number: '3e',
    name: 'Issue may be finished',
    description:
      'A watched open issue that has already had agents on it, has nothing in flight and no open PR, gets a code agent to read what was actually delivered and say whether the issue is finished. It writes `delivered` — weaker than the tracker’s `closed`, reversible, and its only effect is to stop pickup — or sends the issue back round with an outstanding-work note. It is what stops rule 4 re-picking work whose PR has merged and left the open list, which on GitHub nothing else prevents, and it ranks ahead of pickup for exactly the issues both would otherwise claim. On by default; an assessor that spends its attempt cap fails the issue open to ordinary pickup, so a failure can never park an issue.',
  },
  'issue-assay': {
    number: '3f',
    name: 'Issue goal needs checking',
    description:
      'A watched open issue nothing has been started for yet gets a code agent to read the ticket against the repository and say whether there is a goal here an agent could start from. It is the only gate in front of an issue that asks about *content*: every other one — the watch tag, the workflow state, the cooldown, the attempt cap, headroom — asks whether the harness is allowed to act, never whether there is anything to act on. A verdict of `unclear` stops the funnel for that issue and says what a human would need to supply; it ends by itself the moment the ticket is edited or anything happens on it. Ranked ahead of the planner, because assaying a goal the planner is about to decompose is the whole point. On by default; an assayer that writes no verdict — crashed, killed or capped — leaves the issue to ordinary pickup, so a failure can never park one.',
  },
  'issue-shortfall': {
    number: '3g',
    name: 'Assessment says the goal was missed',
    description:
      'An assessor read the delivered work and said the issue’s goal is still not reached. This is the one consumer of that verdict, and it routes it by what the assessor said fell short rather than sending everything to a replan: a wrong decomposition goes back to a planner, one part that missed its own scope gets a follow-up part appended (the part itself is untouched — its branch is spent), and a wrong or ambiguous goal goes to a human, because no planner or agent can fix one. The first two spend agents, so they are proposed for your approval rather than taken; the third is only ever a question. It is what closes the plan → work → assess → re-plan loop, which until now had a check at one end, a replan at the other, and nothing joining them.',
  },
  'issue-retro': {
    number: '3h',
    name: 'Delivered goal needs a retrospective',
    description:
      'An issue the harness has parked as delivered, with nothing in flight under it and no retrospective yet, gets one desk agent to write the run up: what shipped, and what came out of the process of shipping it. It is handed the shared scratchpad the working agents left and the record the harness kept — which rules fired, what was escalated and how it was answered, replans, shortfalls, what it cost — and it writes one document per goal, read in the cockpit on the station that used to say nothing. It schedules nothing, gates nothing and posts nothing to the tracker, so a retrospective that never gets written costs only the report: an agent that crashes or spends its attempt cap leaves the goal exactly as delivered, with no escalation, because there is nothing a human can do about a write-up that did not happen that they cannot do by reading the issue.',
  },
  'plan-part': {
    number: '4a',
    name: 'Plan part ready',
    description:
      "One part of a multi-PR plan whose dependency has pushed a branch worth stacking on, and which has no agent, gets a code agent on `issue/<n>/<slug>` — based on that dependency's branch while it is still open, on the default branch once it merged. Parts rank after planners and ahead of one-shot pickups, bottom of a stack first, and `maxConcurrentPartsPerIssue` caps how many parts of one plan may have agents at once: a human stacks safely because they hold the decomposition in their head, and N concurrent agents do not. A part held by that cap is queued as `capped` rather than skipped, so the limit is visible instead of looking like nothing happened.",
  },
  'issue-pickup': {
    number: '4',
    name: 'Open issue without a PR',
    description:
      'An open, pickup-eligible issue with no *open* PR gets a code agent to resolve it into a PR — the front of the issue → PR → merge loop, ordered by label-encoded priority. Gating on an open PR (rather than on any PR ever having been linked) is what lets an issue take more than one PR. With the planning funnel on, this fires only for an issue whose plan says `single`; its behaviour for such an issue is otherwise unchanged.',
  },
  'cooldown-escalate': {
    number: '1–4',
    name: 'Attempt cap reached',
    description:
      'A persistent concern that repeated agent attempts failed to clear is escalated to a human instead of dispatching again — the cooldown/attempt cap that keeps the loop bounded.',
  },
  'story-groom': {
    number: '5',
    name: 'Story grooming',
    description:
      'A ready story missing a description or acceptance criteria gets a desk agent to draft them — it cannot be safely implemented until it is specified.',
  },
  'story-waf': {
    number: '6',
    name: 'Missing WAF pillars',
    description:
      'A ready story with no Well-Architected Framework pillars gets a desk agent to determine and document which apply.',
  },
  'story-pickup': {
    number: '7',
    name: 'Idle capacity pickup',
    description:
      'With headroom left and nothing urgent, the highest-priority ready story (already groomed) is picked up by a code agent — idle capacity should always pull work.',
  },
  idle: {
    number: '8',
    name: 'Nothing actionable',
    description:
      'No rule matched this cycle, so a no-op is recorded — idleness is a decision too, and stays auditable.',
  },
} as const satisfies Record<string, DispatchRule>;

export type DispatchRuleId = keyof typeof DISPATCH_RULES;
