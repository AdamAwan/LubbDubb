/**
 * The RuleDispatcher's rule book, as data. Each branch of the dispatcher tags
 * the actions it emits with one of these ids, the id is persisted on the
 * decision row, and the registry ships to the cockpit (in `/api/state`) so a
 * Decision log row can expand into "which rule fired, and why it exists".
 * The `number` mirrors the priority ordering documented on {@link RuleDispatcher}.
 */
export interface DispatchRule {
  /** Position in the dispatcher's priority order ('1'..'9', with sub-rules like '2b'). */
  number: string;
  name: string;
  /** Why the rule exists — the standing rationale, independent of any one firing. */
  description: string;
}

export const DISPATCH_RULES = {
  'pr-ci-failing': {
    number: '1',
    name: 'Failing CI',
    description:
      'A PR with failing CI gets a code agent on its branch to investigate and push a fix — broken builds block everything downstream, so this outranks all other work.',
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
  'issue-pickup': {
    number: '4',
    name: 'Open issue without a PR',
    description:
      'An open, pickup-eligible issue with no linked PR gets a code agent to resolve it into a PR — the front of the issue → PR → merge loop, ordered by label-encoded priority.',
  },
  'cooldown-escalate': {
    number: '1–4',
    name: 'Attempt cap reached',
    description:
      'A persistent concern that repeated agent attempts failed to clear is escalated to a human instead of dispatching again — the cooldown/attempt cap that keeps the loop bounded.',
  },
  'meeting-prep': {
    number: '5',
    name: 'Meeting prep',
    description: 'A meeting today with unread prep docs gets a desk agent to read and summarise them before it starts.',
  },
  'story-groom': {
    number: '6',
    name: 'Story grooming',
    description:
      'A ready story missing a description or acceptance criteria gets a desk agent to draft them — it cannot be safely implemented until it is specified.',
  },
  'story-waf': {
    number: '7',
    name: 'Missing WAF pillars',
    description:
      'A ready story with no Well-Architected Framework pillars gets a desk agent to determine and document which apply.',
  },
  'story-pickup': {
    number: '8',
    name: 'Idle capacity pickup',
    description:
      'With headroom left and nothing urgent, the highest-priority ready story (already groomed) is picked up by a code agent — idle capacity should always pull work.',
  },
  idle: {
    number: '9',
    name: 'Nothing actionable',
    description:
      'No rule matched this cycle, so a no-op is recorded — idleness is a decision too, and stays auditable.',
  },
} as const satisfies Record<string, DispatchRule>;

export type DispatchRuleId = keyof typeof DISPATCH_RULES;
