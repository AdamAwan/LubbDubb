import type {
  AppState,
  CockpitDecision,
  Escalation,
  HumanTask,
  PlanPart,
  Proposal,
  SetupCheck,
  SetupPayload,
  SetupVerdict,
  OpenPullRequest,
  ViewerAssignment,
} from '../types.js';
import { goalIssue, goalOfPr, standsFor } from './goalPage.js';
import { updateAskRows } from './updateAsks.js';
import { watchBucket } from '../worldBuckets.js';

/**
 * What kind of answer a row wants. `permission`/proposal kinds are escalations underneath,
 * split out because the verdict differs (permission vs accept/reject vs free text). `config` /
 * `config_gap` are the harness's own configuration, split by severity. `intake` is the goal
 * appraisal's `unclear` verdict. `dispatch` comes from the decision log rather than a raised row.
 * `upgrade` / `project_pull` are the two update asks. `KIND_TONE` is total over this union, so a
 * new kind fails the typecheck rather than rendering untinted.
 * → `docs/spec/06-issue-pickup.md#block-or-inform-and-why-blocking-is-safe`, `docs/spec/09-execution.md#a-refusal-that-keeps-repeating`, `docs/spec/21-self-update.md`
 */
export type NeedKind =
  | 'config'
  | 'config_gap'
  | 'recovery'
  | 'escalation'
  | 'permission'
  | 'plan'
  | 'reply'
  | 'merge'
  | 'shortfall'
  | 'intake'
  | 'profile'
  | 'placement'
  | 'bench'
  | 'close_out'
  | 'validate'
  | 'watch'
  | 'burn'
  | 'limit'
  | 'supply'
  | 'dispatch'
  | 'assigned'
  | 'upgrade'
  | 'project_pull';

/**
 * Who is stopped. `blocking` means an agent is parked and cannot proceed; `yours` means the
 * obligation is the operator's and nothing is waiting inside the fleet. The split is strictly
 * about a held slot, not how much is stopped. A usage-limit park is `blocking`.
 * Drawn as weight, not hue — hue belongs to the kind (`KIND_TONE` in `web/src/console/QueueRail.tsx`).
 */
export type NeedGroup = 'blocking' | 'yours';

/**
 * Pull requests a person put on the operator, as rows — nothing behind them: no escalation, no
 * proposal, no task, no rule will ever act on it.
 * Keyed on `attention.assignedToYou`, never the PR's assignment itself, and always `yours`.
 */
function assignedPrRows(state: AppState): NeedRow[] {
  const rows: NeedRow[] = [];
  for (const pr of state.world.pullRequests) {
    const assignment = pr.attention?.assignedToYou;
    if (assignment === undefined) continue;
    const goalRef = goalOfPr(state, pr.number);
    rows.push({
      id: `assigned:pr:${pr.number}`,
      kind: 'assigned',
      group: 'yours',
      // The verdict's leading reason plus the PR's title; the arm's own reason is not carried
      // — it explains the fleet's silence, not the operator's obligation.
      title: askLine(assignedLine(pr), goalRef, state),
      ...(REVIEWER_NOTE[assignment] === undefined ? {} : { note: REVIEWER_NOTE[assignment] }),
      goalRef,
      originRef: `pr:${pr.number}`,
      // The body goes to the PR on the provider; falls back to the ask if there's no address.
      opens: prAddress(state, pr.number) === undefined ? opensAt(goalRef, state) : 'provider',
      details: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      // The review-wait watermark, not when the assignment was made (no provider says that).
      raisedAt: pr.attention?.reviewWaitingSince ?? '',
    });
  }
  return rows;
}

/** Which kind of reviewer, for the metadata line. An `assignee` has no note — the sentence already says it. */
const REVIEWER_NOTE: Partial<Record<ViewerAssignment, string>> = {
  'reviewer-required': 'Required reviewer',
  'reviewer-optional': 'Optional reviewer',
};

/** The row's sentence: what was asked, then the PR it's about — the verdict's own first reason, capitalised. */
function assignedLine(pr: OpenPullRequest): string {
  const lead = pr.attention?.reasons[0] ?? '';
  const sentence = lead === '' ? `PR #${pr.number} is yours` : `${lead[0]?.toUpperCase() ?? ''}${lead.slice(1)}`;
  const title = pr.title.trim();
  return oneLine(title === '' ? sentence : `${sentence} on “${title}”`);
}

/**
 * What clicking a row opens: `goal` the goal's page; `config` the config page at the group
 * owning the key; `ask` the ask alone; `build` the two update asks; `provider` the assigned row
 * alone; `null` the recovery hold, answered on the banner. Decided in the derivation, since only
 * it can tell a ref with a page from one that only looks like it has one.
 */
type NeedDestination = 'goal' | 'ask' | 'config' | 'build' | 'provider' | null;

/** One row of the merged queue. */
export interface NeedRow {
  /** The source row's own id, so answering it settles exactly this row. */
  id: string;
  kind: NeedKind;
  group: NeedGroup;
  /** The ask on one line. */
  title: string;
  /** `issue:<n>` when the ask belongs to a goal; null for fleet-wide holds. Where it goes is {@link NeedDestination}. */
  goalRef: string | null;
  /** The ref the ask was raised on (`pr:142`, `issue:12:part:signer`) — what it's about, beside {@link goalRef} (what it's read next to). */
  originRef: string | null;
  /** Where a click on the card's body goes. */
  opens: NeedDestination;
  /** The row's other destination, drawn as a control in the action bar — present only where the body leaves the cockpit (the assigned row). */
  details?: NeedDestination;
  /** The agent this row is about, when there is one. Never the agent that merely raised the row. */
  agentId: string | null;
  /** What that agent is on — its task's title. Null when there is no agent, or none the snapshot still carries. */
  agentLabel: string | null;
  /** A short qualifier for the metadata line — currently just which kind of reviewer an assigned PR made you. */
  note?: string;
  /** Live plan parts this ask is holding. Zero when it genuinely holds nothing. */
  holding: number;
  raisedAt: string;
  /** The configuration check behind a `config` / `config_gap` row. Absent on every other kind. */
  check?: SetupCheck;
  /** Set once a fix on this row has been written, until the operator dismisses it. */
  applied?: AppliedFix;
}

/**
 * A config fix that has been written, held until the operator dismisses it. Not part of the
 * verdict — the reading is a fresh look at the file, this is a fact about this session.
 * → `docs/spec/26-setup.md#applying-a-fix`
 */
export interface AppliedFix {
  checkId: string;
  /** `userId = AdamAwan`, in the settled strip's own words. */
  summary: string;
  /** The file it landed in, so the operator can go and look. */
  file: string;
}

/**
 * How many live parts named this slug — direct dependents only, so the queue, goal page and
 * bench station cannot disagree about what an ask is holding.
 */
export function partHolding(planId: string, slug: string, parts: readonly PlanPart[]): number {
  return parts.filter((p) => p.status !== 'retired' && p.planId === planId && p.dependsOn.includes(slug)).length;
}

/**
 * The goal a ref belongs to, as `issue:<n>`. A `pr:<n>` origin resolves through the world
 * (`goalOfPr`); a `job:<n>` origin goes through {@link standsFor} first.
 */
function goalOf(ref: string | null | undefined, state: AppState): string | null {
  const origin = standsFor(state, ref ?? null);
  const m = /^(issue:\d+)/.exec(origin ?? '');
  // noUncheckedIndexedAccess makes a capture group read as possibly undefined even once `m`
  // is non-null; the regex guarantees it's set when `m` matches.
  if (m?.[1]) return m[1];
  const pr = /^pr:(\d+)/.exec(origin ?? '');
  return pr?.[1] ? goalOfPr(state, Number(pr[1])) : null;
}

/** The name of the work an agent is on: its task's title, clamped to one line. */
function agentLabelOf(agentId: string | null, state: AppState): string | null {
  if (agentId === null) return null;
  const agent = state.agents.find((a) => a.id === agentId);
  const title = agent === undefined ? null : (state.tasks.find((t) => t.id === agent.taskId)?.title ?? null);
  const line = title?.split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

/**
 * A row's line: what is being asked, then the goal it's about. Named `#395 · <its title>`, and
 * the ref is dropped where the summary already spells it out. @see docs/spec/17-cockpit.md
 */
function askLine(summary: string, goalRef: string | null, state: AppState): string {
  const issue = goalRef === null ? undefined : goalIssue(state, goalRef);
  if (issue === undefined) return summary;
  const named = new RegExp(`#${issue.number}(?!\\d)`).test(summary);
  return `${summary}${named ? '' : ` for #${issue.number}`} · ${issue.title}`;
}

/** Long enough for a sentence, short enough that two rows fit where one used to. */
const MAX_SUMMARY = 110;

/** Free text as one clamped line. Absent text is an empty line rather than a throw. */
function oneLine(text: string | null | undefined): string {
  const line = (text ?? '').split('\n')[0]?.trim() ?? '';
  return line.length <= MAX_SUMMARY ? line : `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
}

/** Who wrote the review comment a drafted reply answers, when the world still carries it. Null degrades to a line that doesn't name them. */
function commentAuthor(state: AppState, prNumber: unknown, commentId: unknown): string | null {
  if (typeof prNumber !== 'number' || typeof commentId !== 'string') return null;
  const pr = state.world.pullRequests.find((p) => p.number === prNumber);
  return pr?.unresolvedComments.find((c) => c.id === commentId)?.author ?? null;
}

/**
 * What an escalation-backed row says, in the harness's words rather than the ask's prose: each
 * arm states the act that is waiting, not why. Derived from the proposal where there is one; a
 * plain question uses its own first line.
 */
function escalationSummary(
  e: Escalation,
  proposal: Proposal | undefined,
  originRef: string | null,
  state: AppState,
): string {
  const { context } = e;
  const pr = typeof context.prNumber === 'number' ? ` for PR #${context.prNumber}` : '';
  if (proposal) {
    switch (proposal.kind) {
      case 'plan':
        return 'Plan ready';
      case 'plan_amendment':
        return 'Change to a running plan';
      case 'reply_draft': {
        const author = commentAuthor(state, context.prNumber, context.commentId);
        return `Draft reply${author === null ? '' : ` to ${author}`}${pr}`;
      }
      case 'merge':
        return `Merge waiting on your verdict${pr}`;
      case 'shortfall':
        return 'The delivered work did not reach the goal';
    }
  }
  if (context.permission) return oneLine(`${context.permission.toolName}: ${context.permission.summary}`);
  // No proposal under it: the goal itself is what the assessor found wrong.
  if (isShortfallAsk(originRef)) return 'Assessed as not delivered';
  const questions = Array.isArray(context.questions) ? context.questions.length : 0;
  if (questions > 0) return `${questions} questions from the agent`;
  return oneLine(e.prompt);
}

function holdingForTask(task: HumanTask, parts: readonly PlanPart[]): number {
  if (!task.partId) return 0;
  const step = parts.find((p) => p.id === task.partId);
  return step ? partHolding(step.planId, step.slug, parts) : 0;
}

function holdingForEscalation(e: Escalation, state: AppState): number {
  const originRef = state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef ?? null;
  const m = /^issue:\d+:part:(.+)$/.exec(originRef ?? '');
  if (!m) return 0;
  const step = (state.planParts ?? []).find((p) => p.slug === m[1]);
  return step ? partHolding(step.planId, step.slug, state.planParts ?? []) : 0;
}

/** Which row kind a proposal draws as — total over {@link Proposal.kind}, so a new act fails the typecheck. */
const PROPOSAL_KIND: Record<Proposal['kind'], NeedKind> = {
  plan: 'plan',
  // Still a decision about the plan, so it draws in the plan's tone; only the headline differs.
  plan_amendment: 'plan',
  reply_draft: 'reply',
  merge: 'merge',
  shortfall: 'shortfall',
};

/**
 * A shortfall the harness is asking about rather than proposing an arm for. Still a shortfall —
 * reading as `Escalation` would file it with the stuck-agent asks. → [13](../../../docs/spec/13-jobs-and-tickets.md)
 */
function isShortfallAsk(originRef: string | null): boolean {
  return /^issue:\d+:shortfall$/.test(originRef ?? '');
}

function kindOf(e: Escalation, proposal: Proposal | undefined, originRef: string | null): NeedKind {
  if (e.context.permission) return 'permission';
  if (proposal) return PROPOSAL_KIND[proposal.kind];
  return isShortfallAsk(originRef) ? 'shortfall' : 'escalation';
}

/** Which row kind a human task draws as. Total, so a new {@link HumanTask.kind} fails the typecheck. */
const TASK_KIND: Record<HumanTask['kind'], NeedKind> = {
  ask: 'bench',
  close_out: 'close_out',
  validate: 'validate',
  watch: 'watch',
  burn: 'burn',
  supply: 'supply',
};

function needKindOfTask(kind: HumanTask['kind']): NeedKind {
  return TASK_KIND[kind];
}

/** Where an answerable row goes: its goal's page when it has one, the ask panel otherwise. */
function opensAt(goalRef: string | null, state: AppState): NeedDestination {
  return goalRef !== null && goalIssue(state, goalRef) !== undefined ? 'goal' : 'ask';
}

/** A pull request's address on the provider, by the two keys `buildRefUrls` writes — `pr:<n>` first since `#<n>` is shared with an issue. */
function prAddress(state: AppState, number: number): string | undefined {
  return state.refUrls[`pr:${number}`] ?? state.refUrls[`#${number}`];
}

/**
 * The harness's own configuration, as rows. An `ok` or `unknown` check draws nothing —
 * `unknown` has no evidence to state a fault with. Always `yours`, never `blocking`.
 */
const KIND_FOR_VERDICT: Record<SetupVerdict, NeedKind | null> = {
  bad: 'config',
  warn: 'config_gap',
  // Neither draws a row. Total over the verdict, so a fourth fails the typecheck.
  ok: null,
  unknown: null,
};

function configRows(setup: SetupPayload | null, applied: readonly AppliedFix[]): NeedRow[] {
  if (setup === null) return [];
  return setup.checks
    .filter((check) => {
      if (KIND_FOR_VERDICT[check.verdict] !== null) return true;
      // A check just fixed keeps its row until dismissed: the write would otherwise vanish mid-click.
      return applied.some((entry) => entry.checkId === check.id);
    })
    .map((check) => ({
      id: `setup:${check.id}`,
      kind: KIND_FOR_VERDICT[check.verdict] ?? 'config_gap',
      group: 'yours' as const,
      title: check.detail,
      goalRef: null,
      originRef: null,
      opens: 'config' as const,
      agentId: null,
      agentLabel: null,
      holding: 0,
      // Fetched, not stamped: there is no instant a credential started being missing.
      raisedAt: '',
      check,
      applied: applied.find((entry) => entry.checkId === check.id),
    }));
}

/**
 * How many separate pulses a dispatch must be refused on, unbroken, before the rail says
 * anything. Three, not one: a fleet at its cap trips exhaustion transiently.
 * → `docs/spec/09-execution.md#a-refusal-that-keeps-repeating`
 */
const REFUSAL_PULSES = 3;

/**
 * A dispatch the executor has refused on every recent pulse, and what the last refusal said.
 *
 * @public read back by the needs band, which draws the refusal in full under the row
 */
export interface RefusedDispatch {
  /** What the run is grouped by: the action's `originRef`, or its branch when it has none. */
  key: string;
  originRef: string | null;
  /** The branch the dispatch wanted, on a code dispatch. Null for a desk one. */
  branch: string | null;
  /** How many separate pulses the refusal has survived. */
  pulses: number;
  /** The newest refusal's reason, verbatim as the executor recorded it. */
  detail: string;
  /** The rule that keeps proposing it, when the row carries one. */
  rule: string | null;
  /** When the unbroken run of refusals started. */
  since: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Every dispatch being refused every pulse, newest run first. Keyed on the outcome, never the
 * message, so every refusal the pool raises arrives here too. `deferred` is not a refusal — the
 * branch, pause and cap gates defer by design and clear themselves. The run must be unbroken at
 * the head of that origin's history, so the row clears itself on the next snapshot.
 * → [09](../../../docs/spec/09-execution.md#exhaustion)
 */
function refusedDispatches(state: AppState): RefusedDispatch[] {
  const runs = new Map<string, CockpitDecision[]>();
  const settled = new Set<string>();
  // Newest first, so the first non-rejection for a key ends the run.
  for (const d of state.decisions ?? []) {
    if (d.action.type !== 'dispatch_code_agent' && d.action.type !== 'dispatch_desk_agent') continue;
    const key = d.subjectRef ?? str(d.action.branch);
    if (key === null || settled.has(key)) continue;
    if (d.outcome !== 'rejected') {
      settled.add(key);
      continue;
    }
    const run = runs.get(key);
    if (run) run.push(d);
    else runs.set(key, [d]);
  }
  const out: RefusedDispatch[] = [];
  for (const [key, run] of runs) {
    // Distinct cycles, not rows: two refusals inside one cycle are still one bad pulse.
    const pulses = new Set(run.map((d) => d.cycleId)).size;
    if (pulses < REFUSAL_PULSES) continue;
    const newest = run[0];
    const oldest = run[run.length - 1];
    if (!newest || !oldest) continue;
    out.push({
      key,
      originRef: newest.subjectRef,
      branch: str(newest.action.branch),
      pulses,
      detail: newest.detail,
      rule: newest.rule,
      since: oldest.createdAt,
    });
  }
  return out;
}

/**
 * One refused run by its row id, through the same derivation the rail's row came from.
 *
 * @public the needs band resolves the row it was handed back to its refusal
 */
export function refusedDispatchFor(state: AppState, id: string): RefusedDispatch | null {
  return refusedDispatches(state).find((r) => `dispatch:${r.key}` === id) ?? null;
}

/** The refusal, clamped to a line the rail can hold. A display clamp, not a parse. */
function refusalLine(detail: string): string {
  const stop = detail.indexOf('. ');
  if (stop > 0 && stop < 200) return detail.slice(0, stop + 1);
  return detail.length > 200 ? `${detail.slice(0, 199)}…` : detail;
}

/**
 * Rows for dispatches that keep being refused. `yours`, not `blocking`: no slot was leased.
 * Red, on `config`'s terms: the harness will keep proposing and refusing until somebody acts.
 */
function refusedDispatchRows(state: AppState): NeedRow[] {
  return refusedDispatches(state).map((r) => {
    const goalRef = goalOf(r.originRef, state);
    return {
      // Prefixed so a bare `pr:142` doesn't collide with anything else keyed on the ref.
      id: `dispatch:${r.key}`,
      kind: 'dispatch' as const,
      group: 'yours' as const,
      title: askLine(`Refused on ${r.pulses} pulses running — ${refusalLine(r.detail)}`, goalRef, state),
      goalRef,
      originRef: r.originRef ?? r.branch,
      opens: opensAt(goalRef, state),
      // The dispatch never started: an id here would name an earlier, unrelated attempt.
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: r.since,
    };
  });
}

const GROUP_RANK: Record<NeedGroup, number> = { blocking: 0, yours: 1 };

/**
 * The merged queue, ordered: recovery first (no pulse runs while it's up), then blocking before
 * yours, then whatever holds the most work, then oldest first.
 */
export function buildNeedsYou(
  state: AppState,
  setup: SetupPayload | null = null,
  applied: readonly AppliedFix[] = [],
  /** Now, so a snooze that has run out is a row again without waiting for the next snapshot. */
  nowIso: string = new Date().toISOString(),
): NeedRow[] {
  const parts = state.planParts ?? [];
  const proposals = state.proposals ?? [];
  const rows: NeedRow[] = [];

  rows.push(...configRows(setup, applied));
  rows.push(...updateAskRows(state, nowIso));
  rows.push(...refusedDispatchRows(state));
  rows.push(...assignedPrRows(state));

  if ((state.recovery ?? []).length > 0) {
    rows.push({
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: `${state.recovery.length} runs were orphaned by a restart`,
      goalRef: null,
      originRef: null,
      // The one row with nowhere to go: it is answered on the banner already on screen.
      opens: null,
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: '',
    });
  }

  for (const e of state.escalations.filter((x) => x.status === 'open')) {
    const proposal = proposals.find((p) => p.escalationId === e.id);
    const originRef = state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef ?? null;
    const goalRef = goalOf(originRef, state);
    rows.push({
      id: e.id,
      kind: kindOf(e, proposal, originRef),
      group: 'blocking',
      title: askLine(escalationSummary(e, proposal, originRef, state), goalRef, state),
      goalRef,
      originRef,
      opens: opensAt(goalRef, state),
      agentId: e.agentId,
      agentLabel: agentLabelOf(e.agentId, state),
      holding: holdingForEscalation(e, state),
      raisedAt: e.createdAt,
    });
  }

  // Agents the account's usage limit stopped, keyed on the agent id, which the row's control resumes.
  for (const agentId of state.parkedOnLimit) {
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) continue;
    const originRef = state.tasks.find((t) => t.id === agent.taskId)?.originRef ?? null;
    const goalRef = goalOf(originRef, state);
    rows.push({
      id: agentId,
      kind: 'limit',
      group: 'blocking',
      title: askLine(oneLine(agent.waitingReason ?? 'Parked: no usage allowance left right now.'), goalRef, state),
      goalRef,
      originRef,
      opens: opensAt(goalRef, state),
      agentId,
      agentLabel: agentLabelOf(agentId, state),
      holding: 0,
      // The park has no row of its own to stamp, so the agent's own clock is the reading.
      raisedAt: agent.startedAt,
    });
  }

  // The goal appraisal's refusal — has no row of its own elsewhere. Filtered on the watch tag:
  // a verdict on an unwatched item predates the drop, and the drop outranks it.
  for (const issue of state.world.issues) {
    if (issue.state !== 'open' || issue.appraisal?.verdict !== 'unclear') continue;
    if (watchBucket(issue.labels, state.config.watchLabel) !== 'watched') continue;
    const goalRef = `issue:${issue.number}`;
    rows.push({
      id: `intake:${goalRef}`,
      kind: 'intake',
      group: 'yours',
      title: askLine('Held at intake', goalRef, state),
      goalRef,
      originRef: goalRef,
      opens: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: issue.appraisal.decidedAt,
    });
  }

  // The goal-profile gate: a hold with no row of its own anywhere, expiring only on the answer.
  for (const issue of state.world.issues) {
    const appraisal = issue.appraisal;
    if (!appraisal?.awaitingProfileAnswer || appraisal.proposedProfile === null) continue;
    const goalRef = `issue:${issue.number}`;
    rows.push({
      id: `profile:${goalRef}`,
      kind: 'profile',
      group: 'yours',
      title: askLine(`Wants to run on “${appraisal.proposedProfile}”`, goalRef, state),
      goalRef,
      originRef: goalRef,
      opens: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: appraisal.decidedAt,
    });
  }

  // Where a goal belongs on the backlog. Unlike every other row here nothing is held — work
  // runs regardless; the ticket is just invisible to whoever plans the backlog.
  for (const issue of state.world.issues) {
    for (const ask of issue.appraisal?.placement ?? []) {
      const goalRef = `issue:${issue.number}`;
      rows.push({
        id: `placement:${ask.field}:${goalRef}`,
        kind: 'placement',
        group: 'yours',
        title: askLine(
          ask.field === 'parent'
            ? ask.proposedParent === null
              ? 'No parent Feature'
              : `No parent — #${ask.proposedParent} proposed`
            : `On no team's board — “${ask.proposedAreaPath}” proposed`,
          goalRef,
          state,
        ),
        goalRef,
        originRef: goalRef,
        opens: opensAt(goalRef, state),
        agentId: null,
        agentLabel: null,
        holding: 0,
        raisedAt: issue.appraisal?.decidedAt ?? '',
      });
    }
  }

  for (const t of (state.humanTasks ?? []).filter((x) => x.status === 'open')) {
    const goalRef = goalOf(t.originRef, state);
    rows.push({
      id: t.id,
      kind: needKindOfTask(t.kind),
      group: 'yours',
      title: askLine(oneLine(t.title), goalRef, state),
      goalRef,
      originRef: t.originRef ?? null,
      opens: opensAt(goalRef, state),
      // A burn notice is about its agent; every other human task's `agentId` would name
      // whichever agent happened to ask, so it stays null there.
      agentId: t.kind === 'burn' ? t.agentId : null,
      agentLabel: t.kind === 'burn' ? agentLabelOf(t.agentId, state) : null,
      holding: holdingForTask(t, parts),
      raisedAt: t.createdAt,
    });
  }

  return rows.sort((a, b) => {
    if ((a.kind === 'recovery') !== (b.kind === 'recovery')) return a.kind === 'recovery' ? -1 : 1;
    if (a.group !== b.group) return GROUP_RANK[a.group] - GROUP_RANK[b.group];
    if (a.holding !== b.holding) return b.holding - a.holding;
    return a.raisedAt.localeCompare(b.raisedAt);
  });
}
