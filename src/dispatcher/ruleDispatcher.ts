import type { Dispatcher, DispatchContext, DispatchResult } from './dispatcher.js';
import type { ValidatedAction } from './actions.js';
import { parseActions } from './actions.js';
import { isIssuePickupEligible, issuePriority, type IssuePickupPolicy } from './issuePickup.js';
import type { Task } from '../types.js';

/**
 * A deterministic, dependency-free dispatcher that encodes the harness's default
 * priorities directly from the product vision:
 *
 *   1. A PR's CI is failing        -> spin up a code agent to fix it
 *   2. A PR has an unhandled comment -> spin up a code agent to address it
 *   3. A PR is green/approved/mergeable -> merge it in (gated by auto-send)
 *   4. An open issue has no linked PR -> code agent to resolve it into a PR
 *   5. A meeting today lacks prep    -> desk agent to prepare
 *   6. A ready story lacks a description / acceptance criteria -> desk agent to groom
 *   7. A ready story lacks WAF pillars -> desk agent to fill them
 *   8. Nothing else in flight        -> pick up the highest-priority ready story
 *   9. Otherwise                     -> no_op (recorded, so idleness is auditable)
 *
 * It is the safe default and the reference the LLM dispatcher is measured
 * against. Every branch produces actions with an explicit `reason`.
 */
export class RuleDispatcher implements Dispatcher {
  private readonly pickup: IssuePickupPolicy;

  /**
   * `pickup` gates and orders issue pickup (rule 4). Omitted/partial => no gate
   * and flat priority, so `new RuleDispatcher()` keeps the pre-gate behaviour of
   * acting on every open issue (used by unit tests; the composition root passes
   * the operator's config).
   */
  constructor(pickup: Partial<IssuePickupPolicy> = {}) {
    this.pickup = {
      pickupLabel: pickup.pickupLabel,
      priorityLabels: pickup.priorityLabels ?? {},
      defaultPriority: pickup.defaultPriority ?? 0,
    };
  }

  async decide(ctx: DispatchContext): Promise<DispatchResult> {
    const raw: unknown[] = [];
    const activeOrigins = new Set(
      ctx.tasks.filter((t) => isActive(t) && t.originRef).map((t) => t.originRef as string),
    );
    let headroom = ctx.agentHeadroom;

    const canDispatch = (origin: string): boolean => headroom > 0 && !activeOrigins.has(origin);
    const claim = (origin: string): void => {
      activeOrigins.add(origin);
      headroom -= 1;
    };

    // 1 & 2: React to PR signals first — they're time-sensitive.
    for (const pr of ctx.world.pullRequests) {
      const ciOrigin = `pr:${pr.number}:ci`;
      if (pr.ciStatus === 'failing' && canDispatch(ciOrigin)) {
        raw.push({
          type: 'dispatch_code_agent',
          branch: pr.branch,
          title: `Fix failing CI on PR #${pr.number}`,
          prompt: `CI is failing on PR #${pr.number} ("${pr.title}", branch ${pr.branch}). Investigate the failure and push a fix.`,
          originRef: ciOrigin,
          reason: `PR #${pr.number} has failing CI and no agent is on it.`,
        } satisfies RawAction);
        claim(ciOrigin);
      }

      for (const comment of pr.unresolvedComments) {
        if (comment.handled) continue;
        const cOrigin = `pr:${pr.number}:comment:${comment.id}`;
        if (canDispatch(cOrigin)) {
          raw.push({
            type: 'dispatch_code_agent',
            branch: pr.branch,
            title: `Address review comment on PR #${pr.number}`,
            prompt: `A reviewer commented on PR #${pr.number} (branch ${pr.branch}):\n\n"${comment.body}"\n\nDecide whether to fix the code or defend the current approach. If defending, prepare a concise reply.`,
            originRef: cOrigin,
            reason: `Unhandled review comment from ${comment.author} on PR #${pr.number}.`,
          } satisfies RawAction);
          claim(cOrigin);
        }
      }

      // 3: Drive a settled PR the last mile — merge it in. `merge_pr` isn't an
      // agent dispatch (it claims no headroom); the executor's auto-send gate
      // decides whether to merge autonomously or escalate for approval.
      const mergeReady =
        pr.ciStatus === 'passing' &&
        pr.approved === true &&
        pr.mergeable === true &&
        pr.merged !== true &&
        pr.unresolvedComments.every((c) => c.handled);
      if (mergeReady) {
        raw.push({
          type: 'merge_pr',
          prNumber: pr.number,
          method: 'squash',
          confidence: 0.9,
          reason: `PR #${pr.number} is green, approved and mergeable; merge it in.`,
        } satisfies RawAction);
      }
    }

    // 4: Resolve open GitHub issues into PRs — the front of the issue → PR → merge loop.
    // Gate on the pickup label (when configured) so operators can say "work these,
    // leave the rest" — untagged issues stay visible in the world, just unacted-on —
    // and order by label-encoded priority so the important ones claim limited
    // headroom first (tie-break by issue number for determinism).
    const eligibleIssues = ctx.world.issues
      .filter((i) => i.state === 'open' && i.linkedPrNumber === null && isIssuePickupEligible(i, this.pickup))
      .map((issue) => ({ issue, weight: issuePriority(issue.labels, this.pickup) }))
      .sort((a, b) => b.weight - a.weight || a.issue.number - b.issue.number);
    for (const { issue } of eligibleIssues) {
      const origin = `issue:${issue.number}`;
      if (canDispatch(origin)) {
        raw.push({
          type: 'dispatch_code_agent',
          branch: `issue/${issue.number}`,
          title: `Resolve issue #${issue.number}`,
          prompt: `GitHub issue #${issue.number} ("${issue.title}") needs resolving.\n\n${issue.body}\n\nImplement the fix on branch issue/${issue.number} and open a pull request that closes this issue.`,
          originRef: origin,
          reason: `Open issue #${issue.number} has no linked PR and no agent is on it.`,
        } satisfies RawAction);
        claim(origin);
      }
    }

    // 5: Meeting prep.
    for (const ev of ctx.world.calendar) {
      if (ev.prepDone || ev.prepDocs.length === 0) continue;
      const origin = `meeting:${ev.id}:prep`;
      if (canDispatch(origin)) {
        raw.push({
          type: 'dispatch_desk_agent',
          title: `Prep for "${ev.title}"`,
          prompt: `You have a meeting "${ev.title}" at ${ev.startsAt}. Read and summarise these docs so I'm ready: ${ev.prepDocs.join(', ')}.`,
          originRef: origin,
          reason: `Meeting "${ev.title}" has unread prep docs.`,
        } satisfies RawAction);
        claim(origin);
      }
    }

    // 6 & 7: Backlog hygiene on ready stories.
    for (const story of ctx.world.stories) {
      if (story.state !== 'ready') continue;

      if (!story.description || !story.acceptanceCriteria) {
        const origin = `story:${story.id}:groom`;
        if (canDispatch(origin)) {
          raw.push({
            type: 'dispatch_desk_agent',
            title: `Groom story "${story.title}"`,
            prompt: `Story "${story.title}" is missing ${!story.description ? 'a description' : ''}${!story.description && !story.acceptanceCriteria ? ' and ' : ''}${!story.acceptanceCriteria ? 'acceptance criteria' : ''}. Draft them.`,
            originRef: origin,
            reason: `Ready story "${story.title}" lacks description/acceptance criteria.`,
          } satisfies RawAction);
          claim(origin);
        }
      }

      if (story.wafPillars.length === 0) {
        const origin = `story:${story.id}:waf`;
        if (canDispatch(origin)) {
          raw.push({
            type: 'dispatch_desk_agent',
            title: `Fill WAF pillars for "${story.title}"`,
            prompt: `Story "${story.title}" has no Well-Architected Framework pillars set. Determine which pillars apply and document them.`,
            originRef: origin,
            reason: `Ready story "${story.title}" has no WAF pillars.`,
          } satisfies RawAction);
          claim(origin);
        }
      }
    }

    // 8: If there's still headroom and nothing urgent, pick up work.
    if (headroom > 0) {
      const candidate = ctx.world.stories
        .filter((s) => s.state === 'ready' && s.description && s.acceptanceCriteria)
        .sort((a, b) => b.priority - a.priority)[0];
      if (candidate) {
        const origin = `story:${candidate.id}:work`;
        if (canDispatch(origin)) {
          raw.push({
            type: 'dispatch_code_agent',
            branch: `story/${candidate.id}`,
            title: `Implement "${candidate.title}"`,
            prompt: `Implement story "${candidate.title}".\n\nDescription: ${candidate.description}\n\nAcceptance criteria: ${candidate.acceptanceCriteria}`,
            originRef: origin,
            reason: `Idle capacity; "${candidate.title}" is the highest-priority ready story.`,
          } satisfies RawAction);
          claim(origin);
        }
      }
    }

    if (raw.length === 0) {
      raw.push({ type: 'no_op', reason: 'Nothing actionable this cycle.' } satisfies RawAction);
    }

    const parsed = parseActions(raw);
    return {
      ...parsed,
      rationale: buildRationale(parsed.actions),
    };
  }
}

type RawAction = Record<string, unknown> & { type: string; reason: string };

function isActive(t: Task): boolean {
  return t.status === 'queued' || t.status === 'running' || t.status === 'waiting';
}

function buildRationale(actions: ValidatedAction[]): string {
  if (actions.length === 1 && actions[0]?.type === 'no_op') return 'Rule dispatcher: nothing actionable.';
  return `Rule dispatcher chose ${actions.length} action(s): ` + actions.map((a) => a.type).join(', ');
}
