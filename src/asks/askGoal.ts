import type { Issue } from '../wire.js';
import type { AskRow } from './askRow.js';
import { goalIssue } from './lines.js';
import type { AskInputs } from './queue.js';
import { PART_GROUP, askedPart, type PartGroup } from '../plans/partGroup.js';

// → docs/spec/17-cockpit.md#the-setting-beside-the-act

export interface AskGoalPart {
  id: string;
  seq: number;
  title: string;
  group: PartGroup;
  here: boolean;
  prNumber: number | null;
}

interface AskGoal {
  ref: string;
  issue: Issue | undefined;
  /** True while the plan waits on the operator's reveal: its parts are not on the wire. */
  withheld: boolean;
  parts: AskGoalPart[];
  otherAsks: number;
}

type GoalInputs = Pick<AskInputs, 'plans' | 'planParts' | 'retainedRuns'> & {
  world: Pick<AskInputs['world'], 'issues'>;
};

/** The goal an ask is about, as Focus mode draws it beside the ask and `ask_next`'s card carries it. */
export function askGoal(
  state: GoalInputs,
  row: Pick<AskRow, 'id' | 'goalRef' | 'originRef'>,
  asks: readonly Pick<AskRow, 'id' | 'goalRef'>[],
): AskGoal | null {
  const ref = row.goalRef;
  if (ref === null) return null;
  const plan = (state.plans ?? []).find((p) => p.originRef === ref);
  const about = askedPart(row.originRef);
  const parts = (state.planParts ?? [])
    .filter((part) => plan !== undefined && part.planId === plan.id)
    .flatMap((part) => {
      const group = PART_GROUP[part.status];
      return group === null
        ? []
        : [
            {
              id: part.id,
              seq: part.seq,
              title: part.title,
              group,
              here: about !== null && part.slug === about,
              prNumber: part.prNumber,
            },
          ];
    })
    .sort((a, b) => a.seq - b.seq);
  return {
    ref,
    issue: goalIssue(state, ref),
    withheld: plan !== undefined && !plan.revealed,
    parts,
    otherAsks: asks.filter((a) => a.goalRef === ref && a.id !== row.id).length,
  };
}
