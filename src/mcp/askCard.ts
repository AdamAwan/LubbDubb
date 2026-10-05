import type { AskKind, AskRow } from '../asks/askRow.js';
import { askGoal } from '../asks/askGoal.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE } from '../asks/kinds.js';
import { issueAddress, prAddress } from '../asks/lines.js';
import type { AskInputs } from '../asks/queue.js';
import { PART_GROUP_WORD } from '../plans/partGroup.js';

// → docs/spec/11-mcp-tools.md#the-card

const kindOf = (kind: AskKind) => ({ label: KIND_LABEL[kind], symbol: KIND_SYMBOL[kind], tone: KIND_TONE[kind] });

function prOf(inputs: AskInputs, number: number | null | undefined) {
  return number === null || number === undefined ? null : { number, url: prAddress(inputs, number) ?? null };
}

function prNumberOf(inputs: AskInputs, row: AskRow): number | null {
  if (row.prNumber !== undefined) return row.prNumber;
  const { subject } = row;
  switch (subject.type) {
    case 'pull_request':
    case 'part':
    case 'description_check':
      return subject.prNumber;
    case 'escalation':
      return inputs.escalations.find((e) => e.id === subject.escalationId)?.context.prNumber ?? null;
    default:
      return null;
  }
}

function goalOf(inputs: AskInputs, row: AskRow, queue: readonly AskRow[]) {
  const goal = askGoal(inputs, row, queue);
  if (goal === null) return null;
  return {
    title: goal.issue?.title ?? null,
    url: goal.issue === undefined ? null : (issueAddress(inputs, goal.issue) ?? null),
    plan: goal.withheld
      ? { withheld: true as const }
      : {
          withheld: false as const,
          parts: goal.parts.map((p) => ({
            seq: p.seq,
            title: p.title,
            state: PART_GROUP_WORD[p.group],
            here: p.here,
            pr: prOf(inputs, p.prNumber),
          })),
        },
  };
}

/** What Focus mode draws for one ask, as data, so a session draws a card that looks like it. */
export function askCard(inputs: AskInputs, row: AskRow, queue: readonly AskRow[], cockpit: string | null) {
  return {
    kind: kindOf(row.kind),
    queue: queue.map((r) => ({ ...kindOf(r.kind), here: r.id === row.id })),
    goal: goalOf(inputs, row, queue),
    pr: prOf(inputs, prNumberOf(inputs, row)),
    cockpit,
  };
}
