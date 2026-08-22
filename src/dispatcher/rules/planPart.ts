import { dispatchVerdict } from '../dispatchCooldown.js';
import { issueWatchGateReason } from '../issuePickup.js';
import type { Plan, PlanPart } from '../../types.js';
import {
  bySlug,
  liveParts,
  partBase,
  partBranch,
  partDepth,
  partIsHuman,
  partOrigin,
  partDeclarationNote,
  partOutcomeNote,
  planIssueNumber,
  siblingContext,
} from '../../plans/parts.js';
import type { Candidate, RawAction, StageContext } from './context.js';

/** A part candidate awaiting the cross-plan depth ranking. */
interface PartCandidate {
  depth: number;
  issueNumber: number;
  seq: number;
  candidate: Candidate;
}

/**
 * Schedule the parts of a decomposed issue — what makes a `parts` verdict mean
 * anything. Ranked *after* planners (a planner unblocks work) and *before*
 * one-shot pickups, and within that by dependency depth, so the bottom of a stack
 * is cut before the branch its dependents will base on is needed.
 *
 * Deliberately not driven off `eligibleIssues`: that list gates on the issue having
 * no open PR, and a part's PR is exactly what makes the parent issue look taken.
 * Parts inherit the issue's watch/ignore tag (evaluated once, on the parent) and
 * nothing else — see `issueWatchGateReason` for why the workflow-state gate must
 * not apply here.
 */
export function planPart(s: StageContext): void {
  const { ctx } = s;
  const partCandidates: PartCandidate[] = [];
  for (const plan of ctx.plans ?? []) {
    // `awaiting_approval` is walked too, and dispatches nothing: its parts are
    // queued as `unapproved` so the hold is visible. Skipping the plan outright
    // would make an unapproved decomposition look like an idle fleet with no
    // work in it — the same invisibility that gave `capped` its name.
    const unapproved = plan.status === 'awaiting_approval';
    if (plan.status !== 'active' && !unapproved) continue; // complete/abandoned/single schedule nothing
    const issueNumber = planIssueNumber(plan.originRef);
    if (issueNumber === null) continue;
    const issue = s.liveIssue(issueNumber);
    if (!issue || issue.state !== 'open') continue;
    if (issueWatchGateReason(issue, s.pickup) !== null) continue;

    const parts = liveParts((ctx.planParts ?? []).filter((p) => p.planId === plan.id));
    const index = bySlug(parts);
    // The concurrency cap is on *agents*, so it counts live tasks rather than the
    // `dispatched` status — a part whose agent died is not occupying a slot.
    const inFlight = parts.filter((p) => s.activeOrigins.has(partOrigin(issueNumber, p.slug))).length;
    let room = s.planning.maxConcurrentPartsPerIssue - inFlight;
    const ready = parts
      // A human step is filtered out before anything else looks at it: no
      // candidate, so no cooldown arithmetic, no attempt cap, no slot, and nothing
      // for the headroom cut to hold. It is not "queued and held" the way `capped`
      // and `unapproved` are, because those two say *the fleet will get to this*,
      // and this one never will — it is waiting on a person, and the panel that
      // shows it to them is where it is visible.
      .filter((p) => !partIsHuman(p))
      .filter((p) => p.status === 'ready' && !s.activeOrigins.has(partOrigin(issueNumber, p.slug)))
      .map((part) => ({ part, depth: partDepth(part, index) }))
      .sort((a, b) => a.depth - b.depth || a.part.seq - b.part.seq);
    for (const { part, depth } of ready) {
      const origin = partOrigin(issueNumber, part.slug);
      // An unapproved plan is queued and nothing else: no cooldown arithmetic,
      // no attempt-cap escalation. Both would be answering "why did this part
      // not get an agent" with the wrong reason — it did not get one because
      // you have not approved the plan, and that is the only thing to say.
      if (unapproved) {
        partCandidates.push({
          depth,
          issueNumber,
          seq: part.seq,
          candidate: partCandidate(s, plan, issue, part, parts, index, issueNumber, 'unapproved'),
        });
        continue;
      }
      const verdict = dispatchVerdict(origin, s.now, ctx.recentDecisions, s.cooldown);
      // 'hold' (already escalated) must not eat a slot the plan could give to a
      // sibling — that is how one stuck part would stall a whole plan.
      if (verdict.kind === 'hold') continue;
      if (verdict.kind === 'escalate') {
        s.raw.push({
          type: 'escalate_to_human',
          escalationType: 'resolve_ambiguity',
          prompt: s.templates.render('plan-part-escalation', {
            number: issueNumber,
            part: part.title,
            attempts: verdict.attempts,
          }),
          context: { originRef: origin, taskTitle: part.title },
          rule: 'plan-part',
          admission: 'cooldown-escalate',
          reason: `Origin ${origin} hit the ${s.cooldown.maxAttempts}-attempt cap without producing a PR — escalating instead of looping.`,
        } satisfies RawAction);
        continue;
      }
      // Beyond the plan's own concurrency cap the part is *queued as capped*, not
      // skipped. Skipping made the cap invisible: a part with every dependency
      // satisfied and the whole fleet idle simply never appeared anywhere, and the
      // only way to find out why was to read `maxConcurrentPartsPerIssue`. It is
      // still never dispatched — the cut below treats a held candidate as held.
      const cooling = verdict.kind === 'cooldown';
      const capped = !cooling && room <= 0;
      if (!cooling && !capped) room -= 1;
      const held = cooling ? 'cooldown' : capped ? 'capped' : undefined;
      partCandidates.push({
        depth,
        issueNumber,
        seq: part.seq,
        candidate: partCandidate(s, plan, issue, part, parts, index, issueNumber, held),
      });
    }
  }
  partCandidates.sort((a, b) => a.depth - b.depth || a.issueNumber - b.issueNumber || a.seq - b.seq);
  for (const c of partCandidates) s.candidates.push(c.candidate);
}

/**
 * One part's dispatch candidate. The prompt carries what the siblings have done
 * and what is still to come — goal 3 of the multi-PR design, and the thing a
 * second agent on the same issue has never had.
 *
 * `base` is the branch this part stacks on, resolved from the dependency's state
 * (its branch while its PR is open, the integration branch once it merged) and
 * carried on the action so the executor cuts the worktree from it. Whether the
 * PR *body* states the plan context is left to the prompt: making it automatic
 * would need either a new outbound capability or an instruction the agent may
 * ignore anyway, and prompt-only degrades quietly rather than wrongly.
 */
function partCandidate(
  s: StageContext,
  plan: Plan,
  issue: { number: number; title: string },
  part: PlanPart,
  parts: PlanPart[],
  index: Map<string, PlanPart>,
  issueNumber: number,
  held: 'cooldown' | 'capped' | 'unapproved' | undefined,
): Candidate {
  const origin = partOrigin(issueNumber, part.slug);
  const branch = part.branch ?? partBranch(issueNumber, part.slug);
  const base = partBase(part, index, issueNumber, s.defaultBranch);
  const { done, remaining } = siblingContext(parts, part);
  const title = `Issue #${issueNumber} part: ${part.title}`;
  const stacks =
    base === s.defaultBranch
      ? `Part "${part.slug}" of issue #${issueNumber} is ready and has no agent.`
      : `Part "${part.slug}" of issue #${issueNumber} is ready and stacks on ${base}.`;
  const reason =
    held === 'capped'
      ? `${stacks} Held: issue #${issueNumber} is already at its ${s.planning.maxConcurrentPartsPerIssue}-part concurrency cap.`
      : held === 'unapproved'
        ? `${stacks} Held: the plan for issue #${issueNumber} is awaiting your approval — nothing is scheduled until you accept it.`
        : stacks;
  return {
    origin,
    rule: 'plan-part',
    title,
    kind: 'code',
    branch,
    reason,
    held,
    action: {
      type: 'dispatch_code_agent',
      branch,
      base,
      partId: part.id,
      title,
      // Appended, not interpolated: `loadPromptTemplates` rejects only *unknown*
      // placeholders, so an override that never learned a `{kind}` token would
      // silently drop the one instruction a non-code part needs to finish at all.
      prompt:
        s.templates.render('plan-part', {
          number: issueNumber,
          title: issue.title,
          part: part.title,
          scope: part.scope,
          branch,
          base,
          plan: plan.reason ?? 'the planner gave no reason',
          done,
          remaining,
        }) +
        partDeclarationNote(part) +
        partOutcomeNote(part),
      originRef: origin,
      originTitle: `${issue.title} — ${part.title}`,
      originSummary: part.scope,
      rule: 'plan-part',
      reason,
    } satisfies RawAction,
  };
}
