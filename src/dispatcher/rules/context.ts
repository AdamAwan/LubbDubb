import type { DispatchContext } from '../dispatcher.js';
import type { AdmissionId, DispatchRuleId } from '../rules.js';
import type { CooldownPolicy } from '../dispatchCooldown.js';
import type { IssuePickupPolicy } from '../issuePickup.js';
import type { PromptTemplates } from '../promptTemplates.js';
import type { RuleHeld } from '../admission.js';
import type { CiPolicy } from '../../ci/ciPolicy.js';
import type { PlanningPolicy } from '../../plans/planning.js';
import type {
  Issue,
  IssueAssay,
  IssueConclusion,
  IssueRelative,
  IssueShortfall,
  Plan,
  PullRequest,
  Task,
} from '../../types.js';
import type { PlanRouteVerdict } from '../../plans/planning.js';

/**
 * The state a pipeline stage runs against — the coupling that used to be
 * implicit.
 *
 * Every rule body was a closure inside `decide`, capturing some twenty locals
 * without naming any of them, so what a stage read (and, for two of the sets
 * below, what it *wrote* for a later stage to read) was discoverable only by
 * reading every other stage. The bodies are modules now and this is the seam
 * between them: a stage takes exactly this and reaches back into nothing.
 *
 * It carries the operator's policy objects too, rather than a reference to the
 * dispatcher — a stage that could reach the class could reach anything on it,
 * which is the coupling being removed rather than relocated.
 *
 * ## Two fields are written by one stage and read by later ones
 *
 * `assaying` and `assessing` are **outputs** of `issue-assay` and `issue-assess`
 * and **inputs** to the stages after them (`issue-plan` reads the first;
 * `issue-pickup` reads both), which is how a rule supersedes a later one for the
 * same issue this cycle. That ordering dependency is load-bearing: it is the
 * whole mechanism behind `superseded`, and it works because
 * {@link DISPATCH_PIPELINE} runs the writers first. Moving either rule below its
 * readers in the pipeline would not fail to compile — it would silently stop
 * suppressing, and two agents would land on one issue. Both sets are built once,
 * here, so no two rules can hold different opinions about which issues are in
 * them.
 *
 * Nothing else in this object is order-dependent: `raw` and `candidates` are
 * append-only collectors read after the whole walk, and everything else is
 * derived from the world before the first stage runs.
 */
export interface StageContext {
  /** The cycle's world + fleet, verbatim. */
  ctx: DispatchContext;
  /**
   * "Now" for cooldown arithmetic — the snapshot's own ISO timestamp, so a cycle
   * is judged against when its world was observed, not wall-clock at decision
   * time.
   */
  now: string;
  /** Actions that claim no headroom, emitted directly. Append-only. */
  raw: unknown[];
  /**
   * Ranked agent-dispatch candidates, in pipeline order. Append-only; the
   * headroom cut runs after the whole walk (rank-then-slice, issue #69).
   */
  candidates: Candidate[];
  /** Origins with an active task. The cut adds to this as it dispatches. */
  activeOrigins: Set<string>;
  /** `agentId::origin` pairs already delivered as a note (see `notifiedOriginsByAgent`). */
  notified: Set<string>;
  /** `branch::signal` pairs a dispatch already put in an agent's prompt. */
  dispatchedSignals: Set<string>;
  /**
   * Every open PR the world knows about: the dispatch view plus the ones the
   * operator's ignore tag hid from it. Nothing acts on an excluded PR — they are
   * here only so "no PR in the world" can't be mistaken for "the PR merged", and
   * so a stack's base PR is still found when the operator has ignored it.
   */
  openPrs: PullRequest[];
  /**
   * The plan funnel's memory, keyed on `issue:<n>`, read by the work-item, plan
   * and pickup rules alike so none of them can hold a different opinion about an
   * issue. Empty with the funnel off.
   */
  plansByOrigin: Map<string, Plan>;
  /** Standing "is this issue finished" verdicts, on the same origin. */
  conclusions: Map<string, IssueConclusion>;
  /** The negative half of that verdict, on the same origin. */
  shortfallsByOrigin: Map<string, IssueShortfall>;
  /** Standing goal assays, on the same origin again (issue #158). */
  assays: Map<string, IssueAssay>;
  /**
   * Issues in the world that are **retained runs**, not the tracker's answer
   * (issue #234) — a goal worked, forgotten by the tracker, and not yet dismissed.
   *
   * Exactly two rules may act on one: `issue-assess` and `issue-retro`, the two
   * steps that come after a merge and so used to be lost to the close. **Every
   * other rule skips them explicitly**, in its own body, rather than relying on
   * the `closed` state of the stub — that is the accidental safety this set exists
   * to replace, and the kind a later change removes with nothing failing.
   */
  retained: Set<number>;
  /**
   * The world issue with this number, **unless it is a retained run** — the
   * lookup the rules that reach an issue through a plan or a shortfall use, so
   * "this rule acts on live issues only" is written at the call site rather than
   * inferred from a `state` check two lines down. Null for both absences, which
   * is what those rules already do with them.
   */
  liveIssue: (issueNumber: number) => Issue | null;
  /** Is this issue decomposed — i.e. owned by the part scheduler, not by pickup? */
  partsPlanFor: (issueNumber: number) => Plan | null;
  /** Is a standing `delivered` verdict parking this issue? */
  deliveryParked: (issue: Issue) => boolean;
  /** Is a standing `unclear` goal assay parking this issue? */
  assayParked: (issue: Issue) => boolean;
  /**
   * Open, watched, un-parked issues with no open PR, in label-encoded priority
   * order. Derived once and shared by every issue-side rule that wants the
   * narrowed list (three deliberately do not — see their own bodies).
   */
  eligibleIssues: { issue: Issue; weight: number }[];
  /**
   * The open containers an item with no parent could belong to — the *suggestion*
   * offered beside an orphan flag, derived once from the whole world (see
   * `candidateParents`). Empty on a tracker with no hierarchy, which is what
   * leaves the note off the GitHub path entirely.
   */
  parentCandidates: IssueRelative[];
  /**
   * Which arm of the plan funnel each eligible issue is on, keyed by issue
   * number. Shared by `issue-plan` and `issue-pickup` so the two can never
   * disagree. With planning disabled every issue routes to `single`.
   */
  routes: Map<number, PlanRouteVerdict>;
  /** Issues `issue-assay` claimed this cycle. Written by it, read after it — see the class doc. */
  assaying: Set<number>;
  /** Issues `issue-assess` claimed this cycle. Written by it, read after it — see the class doc. */
  assessing: Set<number>;
  /**
   * Throttle a persistent concern: a finished agent that didn't clear its origin
   * cools down instead of re-dispatching every cycle, and escalates once its
   * attempts are spent. Escalations don't claim headroom (no agent is started); a
   * dispatchable candidate joins the ranked queue, a cooling one is kept there
   * greyed so the cockpit can explain why it isn't moving.
   */
  consider: (candidate: Candidate, onEscalate: (attempts: number) => RawAction) => void;

  // ---- The operator's policy, rather than a handle on the dispatcher. -------
  pickup: IssuePickupPolicy;
  cooldown: CooldownPolicy;
  templates: PromptTemplates;
  planning: PlanningPolicy;
  ci: CiPolicy;
  /** The base a PR is assumed to target when the provider doesn't report one. */
  defaultBranch: string;
  /**
   * The two work-item rules' config, narrowed to non-null once so each reads it
   * off a value the type system already knows is present. Null when the operator
   * has not configured both a review state and pickup states — which is also
   * what the `workItemStates` condition switches the two rules out on, so a
   * stage seeing null here has been run by a caller that ignored the pipeline.
   */
  workItemStates: { inReviewState: string; pickupStates: string[] } | null;
}

/**
 * One thing a stage emits that isn't routed through the candidate list.
 *
 * `rule` names what **proposed** the action and `admission` what **became** of
 * it; they are separate because one field answering both is what made a
 * throttled pickup audit as `cooldown-escalate` with no trace of the pickup.
 * `rule` is nullable for exactly one emission — the branch note, which folds
 * signals from several concerns and so has no single proposer (see
 * `prCiFailing`); everything else names one.
 */
export type RawAction = Record<string, unknown> & {
  type: string;
  reason: string;
  rule: DispatchRuleId | null;
  admission?: AdmissionId;
};

/** A ranked agent-dispatch candidate awaiting the headroom cut. */
export interface Candidate {
  origin: string;
  rule: DispatchRuleId;
  title: string;
  kind: 'code' | 'desk';
  branch: string | null;
  reason: string;
  action: RawAction;
  /**
   * Held this cycle for a reason that isn't fleet headroom — kept visible in the
   * queue, never dispatched. See {@link RuleHeld}; `waiting` is absent because
   * only the headroom cut can decide it.
   */
  held?: RuleHeld;
}

export function isActive(t: Task): boolean {
  return t.status === 'queued' || t.status === 'running' || t.status === 'waiting';
}
