import type { RemedyCause, RemedyGuard, RemedyKind } from '../types.js';

// → docs/spec/18-observability.md

export const CAUSE_COPY: Record<RemedyCause, { label: string; blurb: string }> = {
  flake: { label: 'Flake', blurb: 'The same commit answers differently on a re-run — nothing in the diff' },
  environment: { label: 'Environment', blurb: 'The runner, a dependency, the network or a credential — not the diff' },
  inherited: { label: 'Inherited', blurb: 'Already red before this branch, or red from the base it sits on' },
  stale_test: { label: 'Stale test', blurb: 'The change was right; the test still encoded the old behaviour' },
  missed_gate: { label: 'Missed gate', blurb: 'The repository’s own check would have caught it, and it was not run' },
  contract_drift: {
    label: 'Contract drift',
    blurb: 'The change broke a caller, a type, or a second place the thing had to be registered',
  },
  missed_requirement: { label: 'Missed requirement', blurb: 'The ticket asked for it and the diff did not do it' },
  convention: { label: 'Convention', blurb: 'A house rule or repository idiom the agent did not know' },
  approach: { label: 'Approach', blurb: 'The reviewer wanted the problem solved a different way' },
  scope: { label: 'Scope', blurb: 'Too much, or too little, for what was asked' },
  docs: { label: 'Docs', blurb: 'The document that owns the behaviour was not updated with it' },
  clarity: { label: 'Clarity', blurb: 'Naming, comments or structure the reviewer could not read' },
  defect: { label: 'Defect', blurb: 'A genuine bug in the change' },
  other: { label: 'Other', blurb: 'None of the above — the summary carries it' },
};

export const CAUSES_BY_KIND: Record<RemedyKind, readonly RemedyCause[]> = {
  ci: ['flake', 'environment', 'inherited', 'stale_test', 'missed_gate', 'contract_drift', 'defect', 'other'],
  review: ['missed_requirement', 'convention', 'approach', 'scope', 'docs', 'clarity', 'defect', 'other'],
};

export const GUARD_ORDER: readonly RemedyGuard[] = ['local_check', 'documented', 'undocumented', 'unpreventable'];

export const GUARD_COPY: Record<RemedyGuard, { label: string; blurb: string }> = {
  local_check: {
    label: 'The local check',
    blurb: 'Running the repository’s own gate before pushing would have caught it',
  },
  documented: {
    label: 'Already written down',
    blurb: 'The rule exists in the repository and the agent did not read it',
  },
  undocumented: {
    label: 'Written down nowhere',
    blurb: 'Nothing available to the agent said this — the one an operator can fix',
  },
  unpreventable: {
    label: 'Nothing would have',
    blurb: 'A flake, the environment, or a judgement only the reviewer could make',
  },
};

const CAUSES = new Set<string>(Object.keys(CAUSE_COPY));

const MAX_REMEDY_SUMMARY = 400;

export function remedyOrigin(
  originRef: string | null,
): { ok: true; kind: RemedyKind; prNumber: number; originRef: string } | { ok: false; error: string } {
  const match = originRef ? /^pr:(\d+):(ci|comments)$/.exec(originRef) : null;
  if (match) {
    return { ok: true, kind: match[2] === 'ci' ? 'ci' : 'review', prNumber: Number(match[1]), originRef: originRef! };
  }
  return {
    ok: false,
    error:
      `report_remedy is only for an agent dispatched to answer a pull request's failing CI or its ` +
      `review threads, and this task's origin is ${originRef ?? '(none)'}. If you are finishing work on ` +
      `an issue, use conclude_work; if you are writing up a goal, use retro_submit; if you noticed ` +
      `something that is not your task at all, use raise.`,
  };
}

export function remedyAskNote(kind: RemedyKind): string {
  const subject = kind === 'ci' ? 'why CI was red' : 'why the reviewer asked for changes';
  return (
    `\n\n---\n\nBefore you finish, call \`report_remedy\` to say ${subject} and what settled it. ` +
    `Two enums and a line — it takes a moment, and it is the only record anywhere of *why* the ` +
    `fleet keeps coming back to pull requests. It schedules nothing and changes nothing about your ` +
    `work; answer the "what would have caught it" half honestly even when the answer is unflattering.\n`
  );
}

export interface RemedySubmission {
  cause: RemedyCause;
  guard: RemedyGuard;
  summary: string;
}

export function validateRemedy(
  kind: RemedyKind,
  raw: unknown,
): { ok: true; submission: RemedySubmission } | { ok: false; error: string } {
  const args = (raw ?? {}) as Record<string, unknown>;
  const cause = typeof args.cause === 'string' ? args.cause : '';
  const allowed = CAUSES_BY_KIND[kind];
  if (!CAUSES.has(cause) || !allowed.includes(cause as RemedyCause)) {
    return {
      ok: false,
      error: `cause must be one of ${allowed.join(', ')} for a ${kind === 'ci' ? 'CI failure' : 'review round'}`,
    };
  }
  const guard = typeof args.guard === 'string' ? args.guard : '';
  if (!GUARD_ORDER.includes(guard as RemedyGuard)) {
    return { ok: false, error: `guard must be one of ${GUARD_ORDER.join(', ')}` };
  }
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (summary.length === 0) {
    return { ok: false, error: 'summary is required — one line: what was wrong, and what fixed it' };
  }
  if (summary.length > MAX_REMEDY_SUMMARY) {
    return { ok: false, error: `summary must be ${MAX_REMEDY_SUMMARY} characters or fewer` };
  }
  return {
    ok: true,
    submission: {
      cause: cause as RemedyCause,
      guard: guard as RemedyGuard,
      summary,
    },
  };
}
