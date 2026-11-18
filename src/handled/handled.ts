import type { AgentModels } from '../agents/modelPolicy.js';
import type { ErrorRecorder } from '../errorLog.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import { resolveModelTag } from '../modelLabels.js';
import { isAreaPathMissing, type AreaPathTree } from '../intake/placement.js';
import { settlePlacement } from '../intake/placementSettle.js';
import { applyProfilePin, lowerProfilePin } from '../intake/profilePin.js';
import type { IssueLabelInput, SendResult, WorkItemAreaPathInput } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { HandledAction, Issue, IssueAppraisal } from '../types.js';
import type { Config } from '../config/config.js';

// → docs/spec/43-handled-for-you.md

export interface HandledContext {
  store: Pick<Store, 'verdicts' | 'world' | 'tickets' | 'handled'>;
  sink: {
    setIssueLabel(input: IssueLabelInput): Promise<SendResult>;
    canPlaceWorkItem(): boolean;
    setWorkItemAreaPath(input: WorkItemAreaPathInput): Promise<SendResult>;
  };
  errors?: ErrorRecorder;
  labelPrefix: string;
  agentModels: AgentModels | undefined;
  areaPaths: () => AreaPathTree | null;
}

export function handledContext(
  config: Pick<Config, 'labelPrefix' | 'agentModels'>,
  base: {
    store: HandledContext['store'];
    sink: HandledContext['sink'];
    errors?: ErrorRecorder;
    areaPaths: { current(): AreaPathTree | null };
  },
): HandledContext {
  return {
    store: base.store,
    sink: base.sink,
    ...(base.errors ? { errors: base.errors } : {}),
    labelPrefix: config.labelPrefix,
    agentModels: config.agentModels,
    areaPaths: () => base.areaPaths.current(),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayBefore(nowMs: number): string {
  return new Date(nowMs - DAY_MS).toISOString();
}

export function recentHandled(store: Pick<Store, 'handled'>, nowMs: number): HandledAction[] {
  return store.handled.since(dayBefore(nowMs));
}

export function openHandledCount(store: Pick<Store, 'handled'>, nowMs: number): number {
  return store.handled.countOpenSince(dayBefore(nowMs));
}

function pinContext(ctx: HandledContext) {
  return { store: ctx.store, sink: ctx.sink, labelPrefix: ctx.labelPrefix, agentModels: ctx.agentModels };
}

async function setAreaPath(ctx: HandledContext, issueNumber: number, areaPath: string): Promise<string | null> {
  const outcome = await settlePlacement(
    { store: ctx.store, connector: ctx.sink, ...(ctx.errors ? { errors: ctx.errors } : {}) },
    issueNumber,
    'areaPath',
    async () => {
      await ctx.sink.setWorkItemAreaPath({ number: issueNumber, areaPath });
    },
  );
  return outcome.ok ? null : outcome.error;
}

async function setProfile(ctx: HandledContext, issueNumber: number, profile: string | null): Promise<string | null> {
  const outcome = await applyProfilePin(
    { ...pinContext(ctx), ...(ctx.errors ? { errors: ctx.errors } : {}) },
    issueNumber,
    profile,
  );
  return outcome.ok ? null : outcome.error;
}

async function handleProfile(
  ctx: HandledContext,
  issueNumber: number,
  appraisal: IssueAppraisal,
  issue: Issue | undefined,
): Promise<number | null> {
  const profile = appraisal.proposedProfile;
  if (profile === null || appraisal.profileAnsweredAt !== null) return null;
  const before = resolveModelTag(issue?.labels, ctx.labelPrefix, ctx.agentModels).profile ?? null;
  if ((await setProfile(ctx, issueNumber, profile)) !== null) return null;
  return ctx.store.handled.record({
    kind: 'profile',
    issueNumber,
    before,
    after: profile,
    reason: `The appraisal proposed “${profile}”`,
  });
}

async function handleAreaPath(
  ctx: HandledContext,
  issueNumber: number,
  appraisal: IssueAppraisal,
  issue: Issue | undefined,
): Promise<number | null> {
  const tree = ctx.areaPaths();
  const areaPath = appraisal.proposedAreaPath;
  if (areaPath === null || appraisal.areaPathSettledAt !== null || issue === undefined || tree === null) return null;
  if (!ctx.sink.canPlaceWorkItem() || !isAreaPathMissing(issue, tree)) return null;
  const before = issue.areaPath ?? tree.root;
  if ((await setAreaPath(ctx, issueNumber, areaPath)) !== null) return null;
  return ctx.store.handled.record({
    kind: 'placement',
    issueNumber,
    before,
    after: areaPath,
    reason: 'The appraisal proposed this board',
  });
}

/** Answers the appraisal's profile and board asks for the operator, recording each so it can be put back. */
export async function handleAppraisal(ctx: HandledContext, issueNumber: number): Promise<HandledAction[]> {
  const appraisal = ctx.store.verdicts.getAppraisal(issueConclusionOrigin(issueNumber));
  if (appraisal === null || appraisal.verdict !== 'workable') return [];
  const issue = ctx.store.world.getWorldBaseline()?.issues.find((i) => i.number === issueNumber);
  const ids = [
    await handleProfile(ctx, issueNumber, appraisal, issue),
    await handleAreaPath(ctx, issueNumber, appraisal, issue),
  ];
  return ids.flatMap((id) => (id === null ? [] : (ctx.store.handled.get(id) ?? [])));
}

type Outcome = { ok: true; action: HandledAction } | { ok: false; error: string };

async function apply(ctx: HandledContext, action: HandledAction, value: string | null): Promise<string | null> {
  switch (action.kind) {
    case 'profile':
      return setProfile(ctx, action.issueNumber, value);
    case 'placement':
      return value === null ? 'There is no board recorded to put back.' : setAreaPath(ctx, action.issueNumber, value);
  }
}

/** Puts an action back (`undo`) or does it again (`redo`). Nothing changes when the write fails. */
export async function revertHandled(ctx: HandledContext, id: number, direction: 'undo' | 'redo'): Promise<Outcome> {
  const action = ctx.store.handled.get(id);
  if (action === null) return { ok: false, error: `No handled action ${id}.` };
  if ((direction === 'undo') !== (action.state !== 'undone'))
    return { ok: false, error: direction === 'undo' ? 'Already undone.' : 'Not undone.' };
  const error = await apply(ctx, action, direction === 'undo' ? action.before : action.after);
  if (error !== null) return { ok: false, error };
  ctx.store.handled.setState([id], direction === 'undo' ? 'undone' : 'open');
  const updated = ctx.store.handled.get(id);
  return updated === null ? { ok: false, error: `No handled action ${id}.` } : { ok: true, action: updated };
}

/** What the appraiser's verdict writes for the operator: a cheaper profile before it, the handled asks after. */
export function appraisalWrites(
  config: Pick<Config, 'labelPrefix' | 'agentModels'>,
  base: Parameters<typeof handledContext>[1],
): {
  lowerProfile: (issueNumber: number, profile: string) => Promise<boolean>;
  handleAppraisal: (issueNumber: number) => Promise<HandledAction[]>;
} {
  const ctx = handledContext(config, base);
  return {
    lowerProfile: (issueNumber, profile) => lowerProfilePin(ctx, issueNumber, profile),
    handleAppraisal: (issueNumber) => handleAppraisal(ctx, issueNumber),
  };
}
