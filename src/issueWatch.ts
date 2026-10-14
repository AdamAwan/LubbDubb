import type { ErrorRecorder } from './errorLog.js';
import { watchCascadeTargets } from './issueRelations.js';
import type { IssueLabelInput, SendResult } from './sink/actionSink.js';
import type { Store } from './store/store.js';
import { investigateLabelFor, watchLabelFor } from './watchLabels.js';

// → docs/spec/06-issue-pickup.md

export interface IssueWatchContext {
  store: Pick<Store, 'world' | 'tickets'>;
  sink: { setIssueLabel(input: IssueLabelInput): Promise<SendResult> };
  errors?: ErrorRecorder;
  labelPrefix: string;
  issueContainerTypes: string[];
}

interface IssueWatchOutcome {
  label: string;
  targets: number[];
  landed: number[];
  failed: { number: number; message: string }[];
}

export function issueWatchContext(system: {
  store: IssueWatchContext['store'];
  connector: IssueWatchContext['sink'];
  errors: ErrorRecorder;
  config: { labelPrefix: string; issueContainerTypes: string[] };
}): IssueWatchContext {
  const { store, connector, errors, config } = system;
  return {
    store,
    sink: connector,
    errors,
    labelPrefix: config.labelPrefix,
    issueContainerTypes: config.issueContainerTypes,
  };
}

export async function applyIssueWatch(
  ctx: IssueWatchContext,
  issueNumber: number,
  watched: boolean,
  because: string,
): Promise<IssueWatchOutcome> {
  const label = watchLabelFor(ctx.labelPrefix);
  if (!label) return { label, targets: [], landed: [], failed: [] };

  const world = ctx.store.world.getWorldBaseline();
  const issue = world?.issues.find((i) => i.number === issueNumber);
  const targets =
    issue === undefined ? [issueNumber] : watchCascadeTargets(issue, world?.issues ?? [], ctx.issueContainerTypes);

  return { label, targets, ...(await applyIssueLabel(ctx, label, targets, watched, `the watch tag`, because)) };
}

export async function applyInvestigateLabel(
  ctx: IssueWatchContext,
  issueNumber: number,
  because: string,
): Promise<void> {
  await applyIssueLabel(
    ctx,
    investigateLabelFor(ctx.labelPrefix),
    [issueNumber],
    true,
    'the investigate label',
    because,
  );
}

async function applyIssueLabel(
  ctx: IssueWatchContext,
  label: string,
  targets: number[],
  present: boolean,
  what: string,
  because: string,
): Promise<Pick<IssueWatchOutcome, 'landed' | 'failed'>> {
  const landed: number[] = [];
  const failed: { number: number; message: string }[] = [];
  for (const target of targets) {
    try {
      await ctx.sink.setIssueLabel({ number: target, label, present });
      landed.push(target);
    } catch (err) {
      const message = (err as Error).message;
      failed.push({ number: target, message });
      ctx.errors?.record({
        source: 'server',
        message: `Failed to ${present ? 'set' : 'drop'} ${what} on #${target} ${because}: ${message}`,
      });
    }
  }

  ctx.store.world.patchWorldLabels({ issues: landed, label, present });
  ctx.store.tickets.patchTicketLabels({ numbers: landed, label, present });
  return { landed, failed };
}
