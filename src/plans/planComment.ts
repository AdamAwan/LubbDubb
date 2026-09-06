import type { Plan, PlanPart, ValidationCheck } from '../types.js';
import { liveChecks, validationVerdict } from '../validation/verdict.js';
import { partOutcomeKind, planProgress } from './parts.js';
import { prRef, type PrRefStyle } from '../prRef.js';

// → docs/spec/08-planning.md

export function renderPlanComment(
  plan: Plan,
  parts: PlanPart[],
  style: PrRefStyle,
  checks: ValidationCheck[] = [],
): string {
  const { settled, total } = planProgress(parts);
  const heading =
    plan.status === 'complete'
      ? `**Plan complete** — all ${total} part${total === 1 ? '' : 's'} finished.`
      : `**Plan in progress** — ${settled}/${total} part${total === 1 ? '' : 's'} done.`;
  const lines = parts.map((p) => `- ${statusMark(p)} **${p.title}** (\`${p.slug}\`) — ${where(p, style)}`);
  const why = plan.reason ? `\n\n${plan.reason}` : '';
  const tail =
    plan.status === 'complete' ? '\n\nNothing further is scheduled for this item. Closing it is a human decision.' : '';
  return `${MARKER}\n\n${heading}${why}\n\n${lines.join('\n')}${validation(checks)}${narrative(plan)}${tail}`;
}

function validation(checks: ValidationCheck[]): string {
  const live = liveChecks(checks);
  if (live.length === 0) return '';
  const verdict = validationVerdict(live);
  const heading =
    verdict.state === 'clear'
      ? `**Validation** — all ${verdict.total} check${verdict.total === 1 ? '' : 's'} settled.`
      : `**Validation** — ${verdict.passed + verdict.waived}/${verdict.total} settled.`;
  const lines = live.map(
    (c) =>
      `- ${checkMark(c)} **${c.title}**${c.resultNote === null ? '' : ` — ${c.resultNote}`}${recorder(c)}${amended(c)}`,
  );
  return `\n\n${heading}\n\n${lines.join('\n')}`;
}

function recorder(check: ValidationCheck): string {
  if (check.resultBy === 'agent') return ' _(recorded by an agent)_';
  if (check.resultBy === 'desktop') return ' _(recorded from a desktop session)_';
  return '';
}

function amended(check: ValidationCheck): string {
  const withdrawn = check.revision?.state;
  return withdrawn == null ? '' : ` _(amended after it was ${withdrawn} — needs running again)_`;
}

function checkMark(check: ValidationCheck): string {
  switch (check.state) {
    case 'passed':
      return '✅';
    case 'failed':
      return '❌';
    case 'waived':
      return '➖';
    case 'deferred':
      return '⏸️';
    default:
      return '⬜';
  }
}

function narrative(plan: Plan): string {
  const sections: string[] = [];
  if (plan.diagnosis) sections.push(`**What's wrong**\n\n${plan.diagnosis}`);
  if (plan.approach) sections.push(`**What we'll do**\n\n${plan.approach}`);
  if (plan.verification) sections.push(`**How we'll know it worked**\n\n${plan.verification}`);
  if (plan.alternatives) sections.push(`**Considered and rejected**\n\n${plan.alternatives}`);
  if (plan.outOfScope) sections.push(`**Deliberately out of scope**\n\n${plan.outOfScope}`);
  if (plan.evidence.length > 0) {
    const cites = plan.evidence
      .map((e) => `- \`${e.path}${e.line === null ? '' : `:${e.line}`}\`${e.note === null ? '' : ` — ${e.note}`}`)
      .join('\n');
    sections.push(`**Where it was found**\n\n${cites}`);
  }
  if (plan.document) sections.push(`**The full write-up**\n\n${plan.document}`);
  if (sections.length === 0) return '';
  return `\n\n<details>\n<summary>The plan, as the planner wrote it</summary>\n\n${sections.join('\n\n')}\n\n</details>`;
}

const MARKER = '<!-- lubbdubb:plan -->\n_LubbDubb delivery plan_';

function statusMark(part: PlanPart): string {
  switch (part.status) {
    case 'merged':
    case 'concluded':
      return '[x]';
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

function where(part: PlanPart, style: PrRefStyle): string {
  if (part.status === 'concluded') {
    const kind = partOutcomeKind(part) ?? 'concluded';
    const planned = part.expectedKind && part.expectedKind !== kind ? ` (planned as ${part.expectedKind})` : '';
    const summary = part.outcomeSummary ? ` — ${part.outcomeSummary}` : '';
    return `${kind}${planned}${summary}`;
  }
  if (part.prNumber !== null) return `${label(part)} · PR ${prRef(part.prNumber, style)}`;
  if (part.branch !== null) return `${label(part)} · \`${part.branch}\``;
  return label(part);
}

function label(part: PlanPart): string {
  return part.status.replace('_', ' ');
}
