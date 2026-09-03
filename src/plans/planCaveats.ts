import type { Issue, Plan, PlanCaveat, PlanPart, Proposal, PullRequest } from '../types.js';
import { unclaimedIssuePrs, wedgeReasons } from './planWedge.js';

/**
 * What a plan raises that its approver has to have read — and the gate that makes
 * "has to" mean something.
 *
 * ## Why a tick box
 *
 * Approving a plan is the widest verdict in the harness: every part gets an agent,
 * a branch and a pull request on the click. What the operator was told *before*
 * that click was prose — the planner's own uncertainty on the plan sheet, and the
 * "Before you decide" paragraph the approval ask appends when a part is already
 * blocked or an unclaimed pull request is open on the issue. Prose in the body of
 * a card is exactly the thing a decision skips: nothing anywhere recorded whether
 * it had been read, so the safe reading and the careless one produced identical
 * rows.
 *
 * A caveat is that same sentence, made into a thing the operator ticks. The accept
 * refuses while any of them is unticked ({@link unacknowledgedCaveats}), which is
 * what separates this from a warning: the harness can now say the operator saw the
 * blocked part, rather than that it had rendered one.
 *
 * ## What is a caveat and what is not
 *
 * Four sources, and they are two kinds of thing. The planner's own uncertainty —
 * `openQuestions` and `risks` — is what it is least sure about and what it thinks
 * could go wrong, written for this moment and read at it. The other two are facts
 * about the world the plan lands in: a part that is already blocked, and a pull
 * request open on the issue that belongs to no part of the plan.
 *
 * `outOfScope` and `alternatives` are deliberately **not** caveats. Both are the
 * planner being explicit about the shape it chose, which is what the plan sheet is
 * for; neither is a thing that goes wrong if unread, and a gate that fires on every
 * plan ever written is a gate operators learn to tick blind. A plan whose planner
 * declared no uncertainty and whose issue is clear raises none of these, and
 * approving it is the click it always was.
 *
 * ## Why the ids are stored, never re-derived
 *
 * The caveats ride on the `propose_plan` action, so the gate compares what was
 * ticked against what that row declares. Re-deriving them at accept time would ask
 * a world that has moved since the card was drawn: a blocker cleared between the
 * reading and the click would drop a caveat the operator ticked (harmless), and a
 * pull request opened in that window would add one they were never shown and
 * refuse their accept for a sentence nobody put in front of them (not harmless).
 * The verdict is on what was proposed — the same principle as `Proposal.action`
 * being kept verbatim.
 */

/** How much of a planner's field rides in a caveat's detail before it is cut. */
const MAX_DETAIL = 1200;

/**
 * Everything this plan raises, in the order an approver meets it: the world's
 * objections first, because they are the ones that stop the plan running at all,
 * then what the planner itself flagged.
 *
 * Empty is the ordinary case for a clean plan, and empty means no gate.
 */
export function planCaveats(
  plan: Pick<Plan, 'risks' | 'openQuestions'>,
  issue: Issue,
  parts: PlanPart[],
  openPrs: PullRequest[],
): PlanCaveat[] {
  const caveats: PlanCaveat[] = [];
  // Indexed rather than hashed: an id has to be stable for the life of one
  // proposal, and the row it is stored on is written once.
  wedgeReasons(parts).forEach((reason, i) => {
    caveats.push({
      id: `blocked:${i}`,
      label: `Its parts are already blocked and cannot be cut. ${reason}`,
      detail: null,
    });
  });
  for (const pr of unclaimedIssuePrs(issue, parts, openPrs)) {
    caveats.push({
      id: `unclaimed-pr:${pr.number}`,
      label:
        `PR #${pr.number} ("${pr.title}", branch ${pr.branch}) is open for this issue and belongs to no part of ` +
        `this plan. Approving does not close it, hand it to a part, or count it towards the plan — nothing here ` +
        `knows which part, if any, it satisfies.`,
      detail: null,
    });
  }
  const unsure = plan.openQuestions?.trim();
  if (unsure)
    caveats.push({
      id: 'open-questions',
      label: 'The planner is not sure about part of this, and approving it decides those questions its way.',
      detail: clip(unsure),
    });
  const risks = plan.risks?.trim();
  if (risks)
    caveats.push({
      id: 'risks',
      label: 'The planner named what could go wrong with this split.',
      detail: clip(risks),
    });
  return caveats;
}

/**
 * What an operator is told about the caveats — appended to the rendered approval
 * ask, never interpolated into it.
 *
 * Appending is the rule every added instruction follows here and for its reason:
 * `plan-approval` is operator-overridable and `loadPromptTemplates` rejects only
 * *unknown* placeholders, so a `{caveats}` token would be silently dropped by
 * exactly the deployments that customised most — losing the warning on the installs
 * most likely to need it. Appending has no fallback to get wrong.
 *
 * The marker line is `Before you decide:`, unchanged, because the cockpit splits
 * the card's body on it and a surface that never learned about caveats still draws
 * them as the paragraph they were.
 *
 * It says the accept is gated, which the paragraph it replaces could not: a warning
 * that does not block reads as advice, and this one is a precondition.
 */
export function caveatNotice(caveats: PlanCaveat[]): string {
  if (caveats.length === 0) return '';
  const lines = caveats.map((c) => `- ${c.label}${c.detail ? `\n\n  ${c.detail.replace(/\n/g, '\n  ')}` : ''}`);
  return (
    `\n\nBefore you decide:\n\n${lines.join('\n')}\n\n` +
    `Approving is held until each of these is acknowledged — tick them on the card, or send them with the accept. ` +
    `Rejecting, holding and closing the ticket are not gated: this is about releasing work, not about saying no.`
  );
}

/**
 * The caveats an accept has **not** acknowledged. Empty means the verdict may go
 * through, which is also the answer for a plan that raised none.
 *
 * A tick that names nothing on the list is ignored rather than refused: the list is
 * the authority on what must be read, and a client that sends an id from a card it
 * drew a moment before the plan was amended is not something to 400 over. What is
 * refused is the other direction — a caveat with nothing acknowledging it.
 */
export function unacknowledgedCaveats(caveats: PlanCaveat[], acknowledged: readonly string[]): PlanCaveat[] {
  const ticked = new Set(acknowledged);
  return caveats.filter((c) => !ticked.has(c.id));
}

/**
 * The caveats a stored proposal declares, read back defensively.
 *
 * The row has been through JSON and SQLite, and a proposal written before the
 * field existed carries none — which is "no gate", the behaviour that row was
 * proposed under. Anything malformed is dropped for the same reason: a caveat the
 * card cannot draw is one an operator cannot tick, and keeping it would wedge the
 * approval of a plan whose only fault is the shape of a column.
 */
export function proposedCaveats(proposal: Proposal): PlanCaveat[] {
  const raw = (proposal.action as Record<string, unknown>).caveats;
  if (!Array.isArray(raw)) return [];
  const caveats: PlanCaveat[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, label, detail } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || typeof label !== 'string' || label === '') continue;
    caveats.push({ id, label, detail: typeof detail === 'string' && detail ? detail : null });
  }
  return caveats;
}

/** One planner field, bounded — the ask is read on a card, and the plan sheet has the whole of it. */
function clip(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}
