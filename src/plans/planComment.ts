import type { Plan, PlanPart, ValidationCheck } from '../types.js';
import { liveChecks, validationVerdict } from '../validation/verdict.js';
import { partOutcomeKind, planProgress } from './parts.js';

/**
 * The plan's status comment on the tracker item — the one progress channel both
 * GitHub and Azure DevOps share, and the only way plan progress reaches someone
 * who isn't looking at the cockpit (the graph itself lives only in the store).
 *
 * Rendered from the rows every time and written to **one** comment, edited in
 * place, so an issue accumulates a single living status rather than a stream. Pure,
 * so what a human reads is exactly what the scheduler believes.
 *
 * It carries the planner's reasoning as well as its progress — see
 * {@link narrative}. The two belong in one comment because they are one thing from
 * the thread's point of view: what the harness is doing here, and why.
 */
export function renderPlanComment(plan: Plan, parts: PlanPart[], checks: ValidationCheck[] = []): string {
  const { settled, total } = planProgress(parts);
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
  return `${MARKER}\n\n${heading}${why}\n\n${lines.join('\n')}${validation(checks)}${narrative(plan)}${tail}`;
}

/**
 * The validation plan, as a checklist in the same one living comment.
 *
 * **Open rather than folded**, unlike {@link narrative} — and that is the whole
 * decision. The reasoning is what a reader reads once; this is what a reader of
 * the thread next month is trying to find out, and a goal closed with two checks
 * never run should say so on the ticket rather than only in a cockpit nobody
 * outside the operator's machine can open.
 *
 * Live checks only: a check an amendment withdrew is kept in the harness for its
 * record, and publishing it here would ask the thread about work the plan has
 * stopped asking for.
 */
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

/**
 * That an agent took this reading rather than a person.
 *
 * Said only for the agent, not for both: this comment is read by somebody trying
 * to find out whether the goal was checked, and "a person checked it" is what a
 * validation checklist already means. The exception is the one worth a word — an
 * agent ran a procedure the operator handed it, which is a weaker thing than a
 * person having sat in front of the running system, and a reader deciding how
 * much the tick is worth is entitled to know which they are looking at.
 */
function recorder(check: ValidationCheck): string {
  if (check.resultBy === 'agent') return ' _(recorded by an agent)_';
  // A third thing, and worth its own words on a ticket somebody else may read:
  // the operator's own Claude ran the procedure at their keyboard. Stronger than
  // the fleet's reading — it reached the real environment — and weaker than a
  // person's, because no person carried the steps out.
  if (check.resultBy === 'desktop') return ' _(recorded from a desktop session)_';
  return '';
}

/**
 * That an amendment took a reading back, said on the ticket as well as in the
 * cockpit.
 *
 * Only when one was actually withdrawn — an amendment to a check nobody had run
 * cost nothing. Without it, a check somebody passed and an amendment then rewrote
 * renders here as a plain `⬜`, which reads as one the operator never got round
 * to. That is the single most misleading line this comment could carry, because it
 * is the case where somebody *did* the work.
 */
function amended(check: ValidationCheck): string {
  const withdrawn = check.revision?.state;
  return withdrawn == null ? '' : ` _(amended after it was ${withdrawn} — needs running again)_`;
}

/** The one-glyph reading of a check's state, `statusMark`'s convention. */
function checkMark(check: ValidationCheck): string {
  switch (check.state) {
    case 'passed':
      return '✅';
    case 'failed':
      return '❌';
    // Said out loud, with a reason, and settled — so it is marked settled rather
    // than outstanding. `deferred` deliberately is not: it is a check still owed.
    case 'waived':
      return '➖';
    case 'deferred':
      return '⏸️';
    default:
      return '⬜';
  }
}

/**
 * The planner's reasoning, folded into the same one living comment.
 *
 * **Because the tracker is where everyone who is not the operator reads this.**
 * The diagnosis, the approach, what was rejected and how anyone will know it
 * worked are the product of an agent that read the whole repository, and until now
 * they reached the cockpit and stopped there — someone looking at the issue on
 * GitHub got a progress table and no reasoning at all, on work a plan had been
 * approved for.
 *
 * **One comment, not a second one**, so this changes nothing about the channel:
 * `writeStatusComment` still edits in place, still writes only on news, and still
 * writes nothing at all while a plan is `awaiting_approval` — which is what keeps
 * this honest. An unapproved verdict announces nothing; what lands here is a
 * commitment the operator has made, and it lands the pulse after they make it.
 *
 * Folded shut in `<details>` because the progress list is what a reader of the
 * thread comes back to, several times, and the reasoning is what they read once.
 * `risks` and `openQuestions` are deliberately absent: they are caveats *on the
 * verdict*, addressed to whoever is deciding whether the work happens, and that
 * decision is already made by the time this is written.
 */
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
  // The write-up last and whole. Not trimmed: this is the one place it is
  // published, and a reader who opened the fold asked for it.
  if (plan.document) sections.push(`**The full write-up**\n\n${plan.document}`);
  if (sections.length === 0) return '';
  return `\n\n<details>\n<summary>The plan, as the planner wrote it</summary>\n\n${sections.join('\n\n')}\n\n</details>`;
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
