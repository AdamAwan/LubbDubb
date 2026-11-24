import type { NeedKind, NeedRow } from './needsYou.js';

// → docs/spec/44-needs-you.md#from-the-orchestrator

export type AskFamily = 'wrong' | 'questions' | 'decisions' | 'work' | 'descriptions' | 'fleet';

const FAMILY_ORDER: readonly AskFamily[] = ['wrong', 'questions', 'decisions', 'work', 'descriptions', 'fleet'];

export const FAMILY_LABEL: Record<AskFamily, string> = {
  wrong: "Something's wrong",
  questions: 'Questions',
  decisions: 'Decisions',
  work: 'Work to do',
  descriptions: 'Descriptions',
  fleet: 'Fleet and setup',
};

const KIND_FAMILY: Record<NeedKind, AskFamily> = {
  escalation: 'questions',
  questions: 'questions',
  permission: 'questions',
  profile: 'questions',
  reply: 'questions',
  plan: 'decisions',
  merge: 'decisions',
  shortfall: 'decisions',
  findings: 'decisions',
  intake: 'decisions',
  validation_plan: 'decisions',
  placement: 'decisions',
  assign: 'decisions',
  assigned: 'decisions',
  bot_pr: 'decisions',
  bench: 'work',
  close_out: 'work',
  validate: 'work',
  watch: 'wrong',
  watch_reading: 'work',
  unwatched: 'work',
  describe: 'descriptions',
  description_wrong: 'descriptions',
  description_note: 'descriptions',
  config: 'fleet',
  config_gap: 'fleet',
  recovery: 'fleet',
  dispatch: 'fleet',
  fleet_stall: 'fleet',
  burn: 'fleet',
  limit: 'fleet',
  supply: 'fleet',
  upgrade: 'fleet',
  project_pull: 'fleet',
};

/** Which family a kind stands in. */
export function familyOf(kind: NeedKind): AskFamily {
  return KIND_FAMILY[kind];
}

export interface AskFamilyGroup<E = never> {
  family: AskFamily;
  rows: NeedRow[];
  /** What stands in the family from outside the queue: app errors, in `wrong`. */
  extra: readonly E[];
  /** The rows and the extras. */
  size: number;
  now: number;
}

/**
 * The asks by family, in family order; inside a family the queue's own order, then whatever stands in it
 * from outside the queue (`extras`). Empty families are dropped.
 */
export function askFamilies<E = never>(
  rows: readonly NeedRow[],
  extras: Partial<Record<AskFamily, readonly E[]>> = {},
): AskFamilyGroup<E>[] {
  return FAMILY_ORDER.map((family) => {
    const members = rows.filter((row) => KIND_FAMILY[row.kind] === family);
    const extra = extras[family] ?? [];
    return {
      family,
      rows: members,
      extra,
      size: members.length + extra.length,
      now: members.filter((row) => row.urgency === 'now').length,
    };
  }).filter((group) => group.size > 0);
}
