import type { Dispatcher, DispatchContext, DispatchResult } from './dispatcher.js';
import type { ValidatedAction } from './actions.js';
import { parseActions } from './actions.js';
import { needsBaseUpdate } from '../prHealth.js';
import type { Agent, Decision, Task } from '../types.js';
import { isIssuePickupEligible, issuePriority, type IssuePickupPolicy } from './issuePickup.js';
import { dispatchVerdict, DEFAULT_COOLDOWN, type CooldownPolicy } from './dispatchCooldown.js';

/**
 * A deterministic, dependency-free dispatcher that encodes the harness's default
 * priorities directly from the product vision:
 *
 *   1. A PR's CI is failing        -> spin up a code agent to fix it
 *   2. A PR's base is out of date  -> code agent to merge base in (resolve
 *                                     conflicts if 'dirty', clean update if 'behind')
 *   2b. A PR has an unhandled comment -> spin up a code agent to address it
 *   3. A PR is green/approved/mergeable -> merge it in (gated by auto-send)
 *   4. An open issue has no linked PR -> code agent to resolve it into a PR
 *
 * At most one code agent works a given PR branch: when a fresh signal lands on a
 * branch that already has a *running* agent, it's delivered to that agent via
 * `respond_to_agent` (deduped through `recentDecisions`) rather than spawning a
 * second one; while the branch's agent is `waiting`, the note is held so a
 * pending human escalation is never disturbed.
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
  private readonly cooldown: CooldownPolicy;

  /**
   * `pickup` gates and orders issue pickup (rule 4). Omitted/partial => no gate
   * and flat priority, so `new RuleDispatcher()` keeps the pre-gate behaviour of
   * acting on every open issue (used by unit tests; the composition root passes
   * the operator's config). `cooldown` throttles re-dispatch of a persistent
   * concern (see {@link dispatchVerdict}); defaults keep the loop bounded.
   */
  constructor(pickup: Partial<IssuePickupPolicy> = {}, cooldown: Partial<CooldownPolicy> = {}) {
    this.pickup = {
      pickupLabel: pickup.pickupLabel,
      requireOwnLabel: pickup.requireOwnLabel,
      priorityLabels: pickup.priorityLabels ?? {},
      defaultPriority: pickup.defaultPriority ?? 0,
      pickupStates: pickup.pickupStates,
      inReviewState: pickup.inReviewState,
    };
    this.cooldown = {
      maxAttempts: cooldown.maxAttempts ?? DEFAULT_COOLDOWN.maxAttempts,
      cooldownMs: cooldown.cooldownMs ?? DEFAULT_COOLDOWN.cooldownMs,
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
    // Origins we've already told a live agent about (from the audit log), so a
    // persistent signal isn't re-notified every cycle. Best-effort over the
    // recent decision window — a note that ages out is harmless (the agent just
    // gets told again).
    const notified = notifiedOriginsByAgent(ctx.recentDecisions);
    // "Now" for cooldown arithmetic — the snapshot's own timestamp, so a cycle is
    // judged against when its world was observed, not wall-clock at decision time.
    const now = ctx.world.takenAt;
    // Throttle a persistent concern: a finished agent that didn't clear its origin
    // cools down instead of re-dispatching every cycle, and escalates once its
    // attempts are spent. Escalations don't claim headroom (no agent is started).
    const throttle = (origin: string, onEscalate: (attempts: number) => RawAction, onDispatch: () => void): void => {
      const verdict = dispatchVerdict(origin, now, ctx.recentDecisions, this.cooldown);
      if (verdict.kind === 'escalate') raw.push(onEscalate(verdict.attempts));
      else if (verdict.kind === 'dispatch') onDispatch();
      // 'cooldown' | 'hold' — leave the origin alone this cycle.
    };

    // 1–3: React to PR signals first — they're time-sensitive. At most one code
    // agent works a given branch, so a fresh signal for a branch that already
    // has a running agent is delivered to it, never a second dispatch.
    for (const pr of ctx.world.pullRequests) {
      if (pr.merged) continue; // a merged PR is done — never act on it.

      // Every concern that would, on its own, warrant a code agent on this
      // branch, ordered by urgency: CI > base-update > review comments.
      const concerns: PrConcern[] = [];
      if (pr.ciStatus === 'failing') {
        concerns.push({
          origin: `pr:${pr.number}:ci`,
          title: `Fix failing CI on PR #${pr.number}`,
          prompt: `CI is failing on PR #${pr.number} ("${pr.title}", branch ${pr.branch}). Investigate the failure and push a fix.`,
          dispatchReason: `PR #${pr.number} has failing CI and no agent is on it.`,
          note: `CI is now failing on PR #${pr.number} — investigate and push a fix.`,
          originTitle: pr.title,
          originSummary: `PR #${pr.number} on branch ${pr.branch} · CI ${pr.ciStatus}${pr.approved ? ' · approved' : ''}`,
        });
      }
      if (needsBaseUpdate(pr)) {
        const base = pr.baseBranch ?? 'main';
        const behind = pr.mergeableState === 'behind';
        concerns.push({
          origin: `pr:${pr.number}:mergeable`,
          title: behind ? `Update PR #${pr.number} with ${base}` : `Resolve merge conflicts on PR #${pr.number}`,
          prompt: behind
            ? `PR #${pr.number} ("${pr.title}") is behind its base branch ${base}. Merge ${base} into ${pr.branch} to bring it up to date, then push. No conflicts are expected — this is a routine update.`
            : `PR #${pr.number} ("${pr.title}") has merge conflicts with its base branch ${base}. Merge ${base} into ${pr.branch}, resolve the conflicts, and push. If you cannot resolve them cleanly, escalate for a human.`,
          dispatchReason: behind
            ? `PR #${pr.number} is behind ${base} and no agent is on it.`
            : `PR #${pr.number} has merge conflicts with ${base} and no agent is on it.`,
          note: behind
            ? `PR #${pr.number} is now behind ${base} — merge ${base} in to bring it up to date, then push.`
            : `The base branch ${base} now conflicts with PR #${pr.number} — merge ${base} in, resolve the conflicts, and push.`,
          originTitle: pr.title,
          originSummary: `PR #${pr.number} on branch ${pr.branch} · ${behind ? `behind ${base}` : `conflicts with ${base}`}`,
        });
      }
      for (const comment of pr.unresolvedComments) {
        if (comment.handled) continue;
        concerns.push({
          origin: `pr:${pr.number}:comment:${comment.id}`,
          title: `Address review comment on PR #${pr.number}`,
          prompt: `A reviewer commented on PR #${pr.number} (branch ${pr.branch}):\n\n"${comment.body}"\n\nDecide whether to fix the code or defend the current approach. If defending, prepare a concise reply.`,
          dispatchReason: `Unhandled review comment from ${comment.author} on PR #${pr.number}.`,
          note: `New review comment from ${comment.author} on PR #${pr.number}: "${comment.body}" — address it or prepare a reply.`,
          originTitle: pr.title,
          originSummary: `Review comment from ${comment.author}: ${comment.body}`,
        });
      }

      if (concerns.length > 0) {
        const branch = resolveBranchAgent(ctx, pr.branch);
        if (branch.kind === 'running') {
          // A running agent already owns this branch — notify it, don't duplicate.
          // Collapse all fresh, not-yet-notified concerns into one note.
          const fresh = concerns.filter(
            (c) => !activeOrigins.has(c.origin) && !notified.has(`${branch.agent.id}::${c.origin}`),
          );
          if (fresh.length > 0) {
            raw.push({
              type: 'respond_to_agent',
              agentId: branch.agent.id,
              response:
                `An update on the branch you're working (PR #${pr.number}):\n` +
                fresh.map((c) => `- ${c.note}`).join('\n'),
              originRefs: fresh.map((c) => c.origin),
              reason: `New PR signal(s) for a branch already staffed by agent ${branch.agent.id}.`,
            } satisfies RawAction);
          }
        } else if (branch.kind === 'free') {
          // No agent on this branch — dispatch one for the most urgent concern,
          // unless the origin is cooling down or has exhausted its attempts.
          const top = concerns[0]!;
          throttle(
            top.origin,
            (attempts) => ({
              type: 'escalate_to_human',
              escalationType: 'resolve_ambiguity',
              prompt: `Auto-resolution of "${top.title}" keeps failing: ${attempts} agent attempt(s) on PR #${pr.number} left the concern unresolved. Please handle it manually.`,
              context: { originRef: top.origin, prNumber: pr.number, taskTitle: top.title },
              reason: `Origin ${top.origin} hit the ${this.cooldown.maxAttempts}-attempt cap without clearing — escalating instead of looping.`,
            }),
            () => {
              if (canDispatch(top.origin)) {
                raw.push({
                  type: 'dispatch_code_agent',
                  branch: pr.branch,
                  title: top.title,
                  prompt: top.prompt,
                  originRef: top.origin,
                  originTitle: top.originTitle,
                  originSummary: top.originSummary,
                  reason: top.dispatchReason,
                } satisfies RawAction);
                claim(top.origin);
              }
            },
          );
        }
        // branch.kind === 'busy' (queued / starting / parked waiting): hold every
        // note. Injecting into a waiting agent would un-park a human escalation,
        // and a starting agent has no live session yet. The signals persist, so a
        // later cycle delivers them once the agent is running.
      }

      // 3: Drive a settled PR the last mile — merge it in. `merge_pr` isn't an
      // agent dispatch (it claims no headroom); the executor's auto-send gate
      // decides whether to merge autonomously or escalate for approval. A
      // 'behind'/'blocked'/'dirty' state is handled above, so it never counts as
      // merge-ready here.
      const mergeReady =
        pr.ciStatus === 'passing' &&
        pr.approved === true &&
        pr.mergeable === true &&
        pr.mergeableState !== 'behind' &&
        pr.mergeableState !== 'blocked' &&
        pr.mergeableState !== 'dirty' &&
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

    // 3b: Back off a work item once a PR is open for it. When an item still in a
    // pickup state ("Ready"/"Doing") has an open PR, move it to the review state so
    // it isn't re-picked while it waits on CI/review. Idempotent: once it's in the
    // review state it no longer matches, so nothing is emitted next cycle. Opt-in —
    // off unless the operator set both a review state and pickup states, and only
    // fires for items that carry a native state (Azure work items; GitHub issues
    // have none, so this is a no-op for them).
    const { inReviewState } = this.pickup;
    if (inReviewState && this.pickup.pickupStates && this.pickup.pickupStates.length > 0) {
      const openPrs = ctx.world.pullRequests.filter((p) => !p.merged);
      for (const issue of ctx.world.issues) {
        const state = issue.workItemState;
        if (state === undefined || !this.pickup.pickupStates.includes(state)) continue;
        // The agent for issue N works branch `issue/N` (see rule 4), so its PR lands
        // on that branch — the reliable link even when Azure hasn't wired the
        // ArtifactLink relation. Fall back to an explicit linked-PR number too.
        const branch = `issue/${issue.number}`;
        const pr = openPrs.find((p) => p.branch === branch || p.number === issue.linkedPrNumber);
        if (!pr) continue;
        raw.push({
          type: 'set_work_item_state',
          number: issue.number,
          state: inReviewState,
          reason: `PR #${pr.number} is open for work item #${issue.number}; move it to "${inReviewState}" so it isn't re-picked while under review.`,
        } satisfies RawAction);
      }
    }

    // 4: Resolve open GitHub issues into PRs — the front of the issue → PR → merge loop.
    // Gate on the pickup label (when configured) so operators can say "work these,
    // leave the rest" — untagged issues stay visible in the world, just unacted-on —
    // and order by label-encoded priority so the important ones claim limited
    // headroom first (tie-break by issue number for determinism).
    const eligibleIssues = ctx.world.issues
      .filter((i) => i.state === 'open' && i.linkedPrNumber === null && isIssuePickupEligible(i, this.pickup).eligible)
      .map((issue) => ({ issue, weight: issuePriority(issue.labels, this.pickup) }))
      .sort((a, b) => b.weight - a.weight || a.issue.number - b.issue.number);
    for (const { issue } of eligibleIssues) {
      const origin = `issue:${issue.number}`;
      // An agent already on this issue owns it — don't throttle/escalate over a
      // live attempt; the active-task de-dup handles it.
      if (activeOrigins.has(origin)) continue;
      throttle(
        origin,
        (attempts) => ({
          type: 'escalate_to_human',
          escalationType: 'resolve_ambiguity',
          prompt: `Auto-resolution of issue #${issue.number} ("${issue.title}") keeps failing: ${attempts} agent attempt(s) produced no linked PR. Please take a look.`,
          context: { originRef: origin, taskTitle: `Resolve issue #${issue.number}` },
          reason: `Origin ${origin} hit the ${this.cooldown.maxAttempts}-attempt cap without producing a PR — escalating instead of looping.`,
        }),
        () => {
          if (canDispatch(origin)) {
            raw.push({
              type: 'dispatch_code_agent',
              branch: `issue/${issue.number}`,
              title: `Resolve issue #${issue.number}`,
              prompt: `GitHub issue #${issue.number} ("${issue.title}") needs resolving.\n\n${issue.body}\n\nImplement the fix on branch issue/${issue.number} and open a pull request that closes this issue.`,
              originRef: origin,
              originTitle: issue.title,
              originSummary: issue.body,
              reason: `Open issue #${issue.number} has no linked PR and no agent is on it.`,
            } satisfies RawAction);
            claim(origin);
          }
        },
      );
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
          originTitle: ev.title,
          originSummary: `Starts ${ev.startsAt}. Prep docs: ${ev.prepDocs.join(', ')}.`,
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
            originTitle: story.title,
            originSummary: story.description,
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
            originTitle: story.title,
            originSummary: story.description,
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
            originTitle: candidate.title,
            originSummary: candidate.description,
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

/** One thing wrong with a PR that would warrant a code agent on its branch. */
interface PrConcern {
  origin: string;
  title: string;
  prompt: string;
  dispatchReason: string;
  note: string;
  // Human-readable context about the originating item, carried onto the task so
  // the cockpit can explain a running agent at a glance (issue #17).
  originTitle: string;
  originSummary: string;
}

/** The agent state of a PR's branch: a running agent to notify, busy (hold), or free (dispatch). */
type BranchAgent = { kind: 'running'; agent: Agent } | { kind: 'busy' } | { kind: 'free' };

function resolveBranchAgent(ctx: DispatchContext, branch: string): BranchAgent {
  const task = ctx.tasks.find((t) => isActive(t) && t.branch === branch);
  if (!task) return { kind: 'free' };
  const agent = task.agentId ? ctx.agents.find((a) => a.id === task.agentId) : undefined;
  if (agent && agent.status === 'running') return { kind: 'running', agent };
  return { kind: 'busy' }; // queued / starting / waiting — hold new notes.
}

/** Agent+origin pairs we've already notified, from executed respond_to_agent decisions. */
function notifiedOriginsByAgent(decisions: Decision[]): Set<string> {
  const set = new Set<string>();
  for (const d of decisions) {
    if (d.outcome !== 'executed') continue;
    const a = d.action;
    if (a.type !== 'respond_to_agent') continue;
    const agentId = a.agentId;
    const origins = a.originRefs;
    if (typeof agentId !== 'string' || !Array.isArray(origins)) continue;
    for (const o of origins) if (typeof o === 'string') set.add(`${agentId}::${o}`);
  }
  return set;
}

function isActive(t: Task): boolean {
  return t.status === 'queued' || t.status === 'running' || t.status === 'waiting';
}

function buildRationale(actions: ValidatedAction[]): string {
  if (actions.length === 1 && actions[0]?.type === 'no_op') return 'Rule dispatcher: nothing actionable.';
  return `Rule dispatcher chose ${actions.length} action(s): ` + actions.map((a) => a.type).join(', ');
}
