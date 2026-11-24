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

export interface AskFamilyGroup {
  family: AskFamily;
  rows: NeedRow[];
  now: number;
}

/**
 * The asks by family, in family order; inside a family the queue's own order. Empty families are dropped,
 * except that `wrong` is kept while `extraWrong` problems from outside the queue — app errors — stand in it.
 */
export function askFamilies(rows: readonly NeedRow[], extraWrong = 0): AskFamilyGroup[] {
  return FAMILY_ORDER.map((family) => {
    const members = rows.filter((row) => KIND_FAMILY[row.kind] === family);
    return { family, rows: members, now: members.filter((row) => row.urgency === 'now').length };
  }).filter((group) => group.rows.length > 0 || (group.family === 'wrong' && extraWrong > 0));
}
