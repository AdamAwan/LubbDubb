import type { Plan, PlanPart } from '../types.js';
import { planProgress } from './parts.js';

/**
 * The plan's status comment on the tracker item — the one progress channel both
 * GitHub and Azure DevOps share, and the only way plan progress reaches someone
 * who isn't looking at the cockpit (the graph itself lives only in the store).
 *
 * Rendered from the rows every time and written to **one** comment, edited in
 * place, so an issue accumulates a single living status rather than a stream. Pure,
 * so what a human reads is exactly what the scheduler believes.
 */
export function renderPlanComment(plan: Plan, parts: PlanPart[]): string {
  const { merged, total } = planProgress(parts);
  const heading =
    plan.status === 'complete'
      ? `**Plan complete** — all ${total} part${total === 1 ? '' : 's'} merged.`
      : `**Plan in progress** — ${merged}/${total} part${total === 1 ? '' : 's'} merged.`;
  const lines = parts.map((p) => `- ${statusMark(p)} **${p.title}** (\`${p.slug}\`) — ${where(p)}`);
  const why = plan.reason ? `\n\n${plan.reason}` : '';
  // Never a closing instruction, and never a close: completion goes no further
  // than review, and whether the issue is done is a human's call.
  const tail =
    plan.status === 'complete' ? '\n\nNothing further is scheduled for this item. Closing it is a human decision.' : '';
  return `${MARKER}\n\n${heading}${why}\n\n${lines.join('\n')}${tail}`;
}

/** Identifies the comment as the harness's, for anyone reading the thread cold. */
const MARKER = '<!-- lubbdubb:plan -->\n_LubbDubb delivery plan_';

function statusMark(part: PlanPart): string {
  switch (part.status) {
    case 'merged':
      return '[x]';
    case 'in_review':
      return '[~]';
    case 'dispatched':
      return '[>]';
    case 'blocked':
      return '[!]';
    default:
      return '[ ]';
  }
}

function where(part: PlanPart): string {
  if (part.prNumber !== null) return `${label(part)} · PR #${part.prNumber}`;
  if (part.branch !== null) return `${label(part)} · \`${part.branch}\``;
  return label(part);
}

function label(part: PlanPart): string {
  return part.status.replace('_', ' ');
}
