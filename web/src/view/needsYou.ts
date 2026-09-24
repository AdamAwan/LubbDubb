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

// → docs/spec/17-cockpit.md

export type NeedKind =
  | 'config'
  | 'config_gap'
  | 'recovery'
  | 'escalation'
  | 'permission'
  | 'plan'
  | 'reply'
  | 'merge'
  | 'describe'
  | 'shortfall'
  | 'intake'
  | 'sitting'
  | 'profile'
  | 'placement'
  | 'bench'
  | 'close_out'
  | 'outcome'
  | 'validate'
  | 'validation_plan'
  | 'watch'
  | 'unwatched'
  | 'burn'
  | 'limit'
  | 'supply'
  | 'dispatch'
  | 'assigned'
  | 'upgrade'
  | 'project_pull';

export type NeedGroup = 'blocking' | 'yours';

/**
 * How soon the ask wants answering, which is the rail's first cut and is about
 * what the operator can *do*, not who is stopped. `now` is work the fleet cannot
 * get past without an answer; `next` an obligation that is the operator's and
 * gates something; `later` an ask holding nothing at all, which the rail folds
 * away rather than spending a row on.
 *
 * Total over {@link NeedKind}, like the rail's own tables, so a new kind is
 * placed deliberately rather than inheriting the last one's urgency.
 */
export type NeedUrgency = 'now' | 'next' | 'later';

const KIND_URGENCY: Record<NeedKind, NeedUrgency> = {
  recovery: 'now',
  escalation: 'now',
  permission: 'now',
  dispatch: 'now',
  config: 'now',
  plan: 'now',
  merge: 'now',
  reply: 'next',
  // It holds nothing up — that is the feature, not an oversight — but the pull
  // request it is about is already open and already spending a reviewer's hour,
  // so it is not an ask that keeps. `yours`, never `blocking`: nothing on the
  // fleet is waiting on it. → docs/spec/07-pull-requests.md#the-rail-asks-for-it-and-nothing-waits-on-the-answer
  describe: 'next',
  shortfall: 'next',
  intake: 'next',
  sitting: 'now',
  profile: 'next',
  close_out: 'next',
  // Moment two is skippable by design and holds nothing: it belongs behind
  // everything the fleet is actually waiting on.
  outcome: 'later',
  validate: 'next',
  validation_plan: 'next',
  bench: 'next',
  config_gap: 'next',
  supply: 'next',
  limit: 'later',
  watch: 'later',
  unwatched: 'next',
  burn: 'later',
  placement: 'later',
  assigned: 'later',
  upgrade: 'later',
  project_pull: 'later',
};

/**
 * A row as its source writes it. The tier is derived from the finished row —
 * `holding` is not known where several of these are built — so it is added in
 * one pass at the end rather than restated at each of the fifteen push sites.
 */
export type NeedDraft = Omit<NeedRow, 'urgency'>;

/**
 * Parts held downstream promote any ask to `now`, whatever its kind: a bench row
 * with four parts waiting behind it is stopping more work than most escalations,
 * and a tier read off the kind alone would file it under "when you have a
 * minute".
 */
function urgencyOf(row: NeedDraft): NeedUrgency {
  return row.holding > 0 ? 'now' : KIND_URGENCY[row.kind];
}

function assignedPrRows(state: AppState): NeedDraft[] {
  const rows: NeedDraft[] = [];
  for (const pr of state.world.pullRequests) {
    const assignment = pr.attention?.assignedToYou;
    if (assignment === undefined) continue;
    const goalRef = goalOfPr(state, pr.number);
    rows.push({
      id: `assigned:pr:${pr.number}`,
      kind: 'assigned',
      group: 'yours',
      title: askLine(assignedLine(pr), goalRef, state),
      ...(REVIEWER_NOTE[assignment] === undefined ? {} : { note: REVIEWER_NOTE[assignment] }),
      goalRef,
      originRef: `pr:${pr.number}`,
      opens: prAddress(state, pr.number) === undefined ? opensAt(goalRef, state) : 'provider',
      details: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: pr.attention?.reviewWaitingSince ?? '',
    });
  }
  return rows;
}

/**
 * One ask per part whose pull request is open and which nobody has described.
 *
 * The server decides membership, so this draws what it is given rather than
 * subtracting one list from another the cockpit does not hold.
 * → docs/spec/07-pull-requests.md#the-rail-asks-for-it-and-nothing-waits-on-the-answer
 */
function undescribedPartRows(state: AppState): NeedDraft[] {
  const parts = state.planParts ?? [];
  const rows: NeedDraft[] = [];
  for (const waiting of state.undescribedParts ?? []) {
    const slug = /^issue:\d+:part:(.+)$/.exec(waiting.originRef)?.[1] ?? null;
    const goalRef = goalOf(waiting.originRef, state);
    const title = parts.find((p) => p.slug === slug)?.title ?? '';
    rows.push({
      id: `describe:${waiting.originRef}`,
      kind: 'describe',
      group: 'yours',
      title: askLine(
        title === ''
          ? `Nobody has said what PR #${waiting.prNumber} does`
          : `Nobody has said what PR #${waiting.prNumber} does \u2014 \u201c${oneLine(title)}\u201d`,
        goalRef,
        state,
      ),
      goalRef,
      originRef: waiting.originRef,
      /* The pull request's own page, because that is where the description is
         written now — the page the change is read on. The part's origin stays on
         the row: it is what this ask is *about*, and what the surfaces that mark
         the part read. → docs/spec/07-pull-requests.md#the-pull-requests-own-page-is-where-it-is-written */
      opens: 'pr',
      prNumber: waiting.prNumber,
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: waiting.openedAt,
    });
  }
  return rows;
}

const REVIEWER_NOTE: Partial<Record<ViewerAssignment, string>> = {
  'reviewer-required': 'Required reviewer',
  'reviewer-optional': 'Optional reviewer',
};

function assignedLine(pr: OpenPullRequest): string {
  const lead = pr.attention?.reasons[0] ?? '';
  const sentence = lead === '' ? `PR #${pr.number} is yours` : `${lead[0]?.toUpperCase() ?? ''}${lead.slice(1)}`;
  const title = pr.title.trim();
  return oneLine(title === '' ? sentence : `${sentence} on “${title}”`);
}

/* `prediction` is `goal` with a pane named: the goal page's prediction card is the
   only surface moment two can be answered on, and the lifecycle rule lands a
   delivered goal on its record. → docs/spec/17-cockpit.md#the-panes */
type NeedDestination = 'goal' | 'prediction' | 'ask' | 'config' | 'build' | 'provider' | 'pr' | null;

export interface NeedRow {
  id: string;
  kind: NeedKind;
  group: NeedGroup;
  urgency: NeedUrgency;
  title: string;
  goalRef: string | null;
  originRef: string | null;
  opens: NeedDestination;
  /**
   * The pull request a `pr` destination opens, on the cockpit's own page for it.
   * Set only with that destination — `provider` reads its number off `originRef`,
   * because that ask *is* about a pull request, while an ask about a part is about
   * the part and keeps the part's origin so the surfaces that mark it still can.
   */
  prNumber?: number;
  details?: NeedDestination;
  agentId: string | null;
  agentLabel: string | null;
  note?: string;
  holding: number;
  raisedAt: string;
  check?: SetupCheck;
  applied?: AppliedFix;
}

export interface AppliedFix {
  checkId: string;
  summary: string;
  file: string;
}

export function partHolding(planId: string, slug: string, parts: readonly PlanPart[]): number {
  return parts.filter((p) => p.status !== 'retired' && p.planId === planId && p.dependsOn.includes(slug)).length;
}

function goalOf(ref: string | null | undefined, state: AppState): string | null {
  const origin = standsFor(state, ref ?? null);
  const m = /^(issue:\d+)/.exec(origin ?? '');
  // TECHDEBT: noUncheckedIndexedAccess makes a capture group read as possibly undefined even once `m`
  // is non-null; the regex guarantees it's set when `m` matches.
  if (m?.[1]) return m[1];
  const pr = /^pr:(\d+)/.exec(origin ?? '');
  return pr?.[1] ? goalOfPr(state, Number(pr[1])) : null;
}

function agentLabelOf(agentId: string | null, state: AppState): string | null {
  if (agentId === null) return null;
  const agent = state.agents.find((a) => a.id === agentId);
  const title = agent === undefined ? null : (state.tasks.find((t) => t.id === agent.taskId)?.title ?? null);
  const line = title?.split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

function askLine(summary: string, goalRef: string | null, state: AppState): string {
  const issue = goalRef === null ? undefined : goalIssue(state, goalRef);
  if (issue === undefined) return summary;
  const named = new RegExp(`#${issue.number}(?!\\d)`).test(summary);
  return `${summary}${named ? '' : ` for #${issue.number}`} · ${issue.title}`;
}

const MAX_SUMMARY = 110;

/**
 * A summary's first line, clamped. Exported because an ask *body* indexing what is
 * waiting — the threads on an assigned pull request — is asking the same question
 * of the same kind of text, and two clamps drift into two different summaries of
 * one comment.
 *
 * @public shared with the ask bodies in `web/src/console/NeedsBand.tsx`
 */
export function oneLine(text: string | null | undefined): string {
  const line = (text ?? '').split('\n')[0]?.trim() ?? '';
  return line.length <= MAX_SUMMARY ? line : `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
}

function commentAuthor(state: AppState, prNumber: unknown, commentId: unknown): string | null {
  if (typeof prNumber !== 'number' || typeof commentId !== 'string') return null;
  const pr = state.world.pullRequests.find((p) => p.number === prNumber);
  return pr?.unresolvedComments.find((c) => c.id === commentId)?.author ?? null;
}

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

const PROPOSAL_KIND: Record<Proposal['kind'], NeedKind> = {
  plan: 'plan',
  plan_amendment: 'plan',
  reply_draft: 'reply',
  merge: 'merge',
  shortfall: 'shortfall',
  // Its own kind rather than `validate`: that one is a *bench task*, and `needBody` reads it out of
  // `humanTasks` by the row's id. A proposal routed there finds no task and the card draws nothing —
  // the ask disappears while the rail still counts it.
  validation_plan: 'validation_plan',
};

function isShortfallAsk(originRef: string | null): boolean {
  return /^issue:\d+:shortfall$/.test(originRef ?? '');
}

function kindOf(e: Escalation, proposal: Proposal | undefined, originRef: string | null): NeedKind {
  if (e.context.permission) return 'permission';
  if (proposal) return PROPOSAL_KIND[proposal.kind];
  return isShortfallAsk(originRef) ? 'shortfall' : 'escalation';
}

const TASK_KIND: Record<HumanTask['kind'], NeedKind> = {
  ask: 'bench',
  close_out: 'close_out',
  outcome: 'outcome',
  validate: 'validate',
  watch: 'watch',
  unwatched: 'unwatched',
  burn: 'burn',
  supply: 'supply',
};

function needKindOfTask(kind: HumanTask['kind']): NeedKind {
  return TASK_KIND[kind];
}

function opensAt(goalRef: string | null, state: AppState): NeedDestination {
  return goalRef !== null && goalIssue(state, goalRef) !== undefined ? 'goal' : 'ask';
}

function predictionOpensAt(goalRef: string | null, state: AppState): NeedDestination {
  return opensAt(goalRef, state) === 'goal' ? 'prediction' : 'ask';
}

/**
 * Whether the plan this ask is about is still withheld pending the reveal.
 *
 * It decides where the row goes and what it says it will do, because while the
 * gate stands the ask **cannot** be answered where it is drawn: approving,
 * refusing and backing out are all refused server-side
 * ([16](../../../docs/spec/16-http-api.md#the-plan-body-is-withheld-until-it-is-revealed)),
 * so a row that lands anywhere but the gate is a press that ends in a 409.
 */
function planWithheld(e: Escalation, state: AppState): boolean {
  const { planId } = e.context;
  if (typeof planId !== 'string') return false;
  return (state.plans ?? []).some((p) => p.id === planId && !p.revealed);
}

/** What the rail says a withheld plan's row will do, rather than leaving "Plan ready" to imply a verdict. */
const REVEAL_NOTE = 'Withheld — reveal it to read it, and the prediction is asked first';

function prAddress(state: AppState, number: number): string | undefined {
  return state.refUrls[`pr:${number}`] ?? state.refUrls[`#${number}`];
}

const KIND_FOR_VERDICT: Record<SetupVerdict, NeedKind | null> = {
  bad: 'config',
  warn: 'config_gap',
  ok: null,
  unknown: null,
};

function configRows(setup: SetupPayload | null, applied: readonly AppliedFix[]): NeedDraft[] {
  if (setup === null) return [];
  return setup.checks
    .filter((check) => {
      if (KIND_FOR_VERDICT[check.verdict] !== null) return true;
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
      raisedAt: '',
      check,
      applied: applied.find((entry) => entry.checkId === check.id),
    }));
}

const REFUSAL_PULSES = 3;

/**
 * A dispatch the executor has refused on every recent pulse, and what the last refusal said.
 *
 * @public read back by the needs band, which draws the refusal in full under the row
 */
export interface RefusedDispatch {
  key: string;
  originRef: string | null;
  branch: string | null;
  pulses: number;
  detail: string;
  rule: string | null;
  since: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function refusedDispatches(state: AppState): RefusedDispatch[] {
  const runs = new Map<string, CockpitDecision[]>();
  const settled = new Set<string>();
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

function refusalLine(detail: string): string {
  const stop = detail.indexOf('. ');
  if (stop > 0 && stop < 200) return detail.slice(0, stop + 1);
  return detail.length > 200 ? `${detail.slice(0, 199)}…` : detail;
}

function refusedDispatchRows(state: AppState): NeedDraft[] {
  return refusedDispatches(state).map((r) => {
    const goalRef = goalOf(r.originRef, state);
    return {
      id: `dispatch:${r.key}`,
      kind: 'dispatch' as const,
      group: 'yours' as const,
      title: askLine(`Refused on ${r.pulses} pulses running — ${refusalLine(r.detail)}`, goalRef, state),
      goalRef,
      originRef: r.originRef ?? r.branch,
      opens: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: r.since,
    };
  });
}

const GROUP_RANK: Record<NeedGroup, number> = { blocking: 0, yours: 1 };
const URGENCY_RANK: Record<NeedUrgency, number> = { now: 0, next: 1, later: 2 };

export function buildNeedsYou(
  state: AppState,
  setup: SetupPayload | null = null,
  applied: readonly AppliedFix[] = [],
  nowIso: string = new Date().toISOString(),
): NeedRow[] {
  const parts = state.planParts ?? [];
  const proposals = state.proposals ?? [];
  const rows: NeedDraft[] = [];

  rows.push(...configRows(setup, applied));
  rows.push(...updateAskRows(state, nowIso));
  rows.push(...refusedDispatchRows(state));
  rows.push(...assignedPrRows(state));
  rows.push(...undescribedPartRows(state));

  if ((state.recovery ?? []).length > 0) {
    rows.push({
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: `${state.recovery.length} runs were orphaned by a restart`,
      goalRef: null,
      originRef: null,
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
    const withheld = planWithheld(e, state);
    rows.push({
      id: e.id,
      kind: kindOf(e, proposal, originRef),
      group: 'blocking',
      title: askLine(escalationSummary(e, proposal, originRef, state), goalRef, state),
      goalRef,
      originRef,
      opens: withheld ? predictionOpensAt(goalRef, state) : opensAt(goalRef, state),
      ...(withheld ? { note: REVEAL_NOTE } : {}),
      agentId: e.agentId,
      agentLabel: agentLabelOf(e.agentId, state),
      holding: holdingForEscalation(e, state),
      raisedAt: e.createdAt,
    });
  }

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
      raisedAt: agent.startedAt,
    });
  }

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

  // Planning waits on the operator here, so the ask blocks: nothing is planned for the goal
  // until the sitting is closed. → docs/spec/08-planning.md#the-intake-sitting-stands-in-front-of-the-planner
  for (const issue of state.world.issues) {
    if (issue.state !== 'open' || issue.pickup.status !== 'sitting') continue;
    const goalRef = `issue:${issue.number}`;
    rows.push({
      id: `sitting:${goalRef}`,
      kind: 'sitting',
      group: 'blocking',
      title: askLine('Planning waits on your prediction and criteria', goalRef, state),
      goalRef,
      originRef: goalRef,
      opens: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: issue.appraisal?.decidedAt ?? state.world.takenAt,
    });
  }

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
      opens: t.kind === 'outcome' ? predictionOpensAt(goalRef, state) : opensAt(goalRef, state),
      agentId: t.kind === 'burn' ? t.agentId : null,
      agentLabel: t.kind === 'burn' ? agentLabelOf(t.agentId, state) : null,
      holding: holdingForTask(t, parts),
      raisedAt: t.createdAt,
    });
  }

  return rows
    .map((row) => ({ ...row, urgency: urgencyOf(row) }))
    .sort((a, b) => {
      if ((a.kind === 'recovery') !== (b.kind === 'recovery')) return a.kind === 'recovery' ? -1 : 1;
      if (a.urgency !== b.urgency) return URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
      if (a.group !== b.group) return GROUP_RANK[a.group] - GROUP_RANK[b.group];
      if (a.holding !== b.holding) return b.holding - a.holding;
      return a.raisedAt.localeCompare(b.raisedAt);
    });
}
