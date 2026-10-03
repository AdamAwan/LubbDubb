import type { AskKind, AskRow } from '../asks/askRow.js';
import { askGoal } from '../asks/askGoal.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE } from '../asks/kinds.js';
import type { AskInputs } from '../asks/queue.js';
import { PART_GROUP_WORD } from '../plans/partGroup.js';

// → docs/spec/11-mcp-tools.md#the-card

const kindOf = (kind: AskKind) => ({ label: KIND_LABEL[kind], symbol: KIND_SYMBOL[kind], tone: KIND_TONE[kind] });

function goalOf(inputs: AskInputs, row: AskRow, queue: readonly AskRow[]) {
  const goal = askGoal(inputs, row, queue);
  if (goal === null) return null;
  return {
    title: goal.issue?.title ?? null,
    plan: goal.withheld
      ? { withheld: true as const }
      : {
          withheld: false as const,
          parts: goal.parts.map((p) => ({ seq: p.seq, title: p.title, state: PART_GROUP_WORD[p.group], here: p.here })),
        },
  };
}

/** What Focus mode draws for one ask, as data, so a session draws a card that looks like it. */
export function askCard(inputs: AskInputs, row: AskRow, queue: readonly AskRow[]) {
  return {
    kind: kindOf(row.kind),
    queue: queue.map((r) => ({ ...kindOf(r.kind), here: r.id === row.id })),
    goal: goalOf(inputs, row, queue),
  };
}
