import type { Plan, PlanPart } from '../types.js';
import { partOutcomeKind, planProgress } from './parts.js';

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
  const { settled, total } = planProgress(parts);
  // The single-PR arm has no rows, and rendering it through the count below said
  // "0/0 parts done" — a progress report on work that was never split. What it has
  // to report is the shape itself and the planner's reason for it; the pull request
  // is on the issue's own timeline, where the reader already is.
  if (total === 0) {
    const why = plan.reason ? `\n\n${plan.reason}` : '';
    return `${MARKER}\n\n**One pull request** — this issue is being delivered whole, not decomposed.${why}`;
  }
  // "merged" was the only terminal when this was written, and is not any more. An
  // operator reading "3/4 parts merged" on a plan whose fourth part was a write-up
  // is being told something false.
  const heading =
    plan.status === 'complete'
      ? `**Plan complete** — all ${total} part${total === 1 ? '' : 's'} finished.`
      : `**Plan in progress** — ${settled}/${total} part${total === 1 ? '' : 's'} done.`;
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
    // A concluded part is finished, so it ticks like a merged one. *What kind* of
    // finish it was is carried by `where`, not by a second mark a reader of the
    // thread would have no way to interpret.
    case 'merged':
    case 'concluded':
      return '[x]';
    // Shown, not hidden: a reader of the thread should see that a part was dropped
    // by a replan rather than find it silently missing from the list.
    case 'retired':
      return '[–]';
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
  if (part.status === 'concluded') {
    const kind = partOutcomeKind(part) ?? 'concluded';
    // Surfaced, never validated: the planner expecting code and the agent finding a
    // duplicate is information an operator wants, not an error — and refusing it
    // would be refusing the truthful close.
    const planned = part.expectedKind && part.expectedKind !== kind ? ` (planned as ${part.expectedKind})` : '';
    const summary = part.outcomeSummary ? ` — ${part.outcomeSummary}` : '';
    return `${kind}${planned}${summary}`;
  }
  if (part.prNumber !== null) return `${label(part)} · PR #${part.prNumber}`;
  if (part.branch !== null) return `${label(part)} · \`${part.branch}\``;
  return label(part);
}

function label(part: PlanPart): string {
  return part.status.replace('_', ' ');
}
