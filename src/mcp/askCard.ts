import type { AskRow } from '../asks/askRow.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE } from '../asks/kinds.js';
import { PART_GROUP, PART_GROUP_WORD, askedPart } from '../plans/partGroup.js';
import type { DesktopToolDeps } from './desktopContext.js';

// → docs/spec/11-mcp-tools.md#the-card

type Tone = (typeof KIND_TONE)[AskRow['kind']];

interface CardKind {
  label: string;
  symbol: string;
  tone: Tone;
}

interface CardPart {
  seq: number;
  title: string;
  state: string;
  here: boolean;
}

interface CardPlan {
  withheld: boolean;
  merged: number;
  total: number;
  parts: CardPart[];
}

interface CardGoal {
  ref: string;
  title: string | null;
  plan: CardPlan | null;
  otherAsks: number;
}

interface AskCard {
  kind: CardKind;
  queue: { kind: string; tone: Tone; here: boolean }[];
  after: number;
  heldInTotal: number;
  goal: CardGoal | null;
}

const kindOf = (row: AskRow): CardKind => ({
  label: KIND_LABEL[row.kind],
  symbol: KIND_SYMBOL[row.kind],
  tone: KIND_TONE[row.kind],
});

function planOf(deps: DesktopToolDeps, goalRef: string, about: string | null): CardPlan | null {
  const plan = deps.store.plans.getPlanByOrigin(goalRef);
  if (plan === null) return null;
  if (deps.planWithheld(plan)) return { withheld: true, merged: 0, total: 0, parts: [] };
  const parts = deps.store.plans
    .listPlanParts(plan.id)
    .flatMap((part) => {
      const group = PART_GROUP[part.status];
      return group === null ? [] : [{ part, group }];
    })
    .sort((a, b) => a.part.seq - b.part.seq);
  return {
    withheld: false,
    merged: parts.filter((p) => p.group === 'merged').length,
    total: parts.length,
    parts: parts.map(({ part, group }) => ({
      seq: part.seq,
      title: part.title,
      state: PART_GROUP_WORD[group],
      here: about !== null && part.slug === about,
    })),
  };
}

function goalOf(deps: DesktopToolDeps, row: AskRow, queue: readonly AskRow[]): CardGoal | null {
  const ref = row.goalRef;
  if (ref === null) return null;
  const number = Number(/^issue:(\d+)$/.exec(ref)?.[1]);
  const issue = deps.store.world.getWorldBaseline()?.issues.find((i) => i.number === number);
  return {
    ref,
    title: issue?.title ?? null,
    plan: planOf(deps, ref, askedPart(row.originRef)),
    otherAsks: queue.filter((r) => r.goalRef === ref && r.id !== row.id).length,
  };
}

/** What Focus mode draws for one ask, as data, so a session draws the same card. */
export function askCard(deps: DesktopToolDeps, row: AskRow, queue: readonly AskRow[]): AskCard {
  const at = queue.indexOf(row);
  return {
    kind: kindOf(row),
    queue: queue.map((r) => ({ kind: KIND_LABEL[r.kind], tone: KIND_TONE[r.kind], here: r.id === row.id })),
    after: queue.length - at - 1,
    heldInTotal: queue.reduce((sum, r) => sum + r.holding, 0),
    goal: goalOf(deps, row, queue),
  };
}
