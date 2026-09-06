import type { ErrorRecorder } from './errorLog.js';
import { watchCascadeTargets } from './issueRelations.js';
import type { IssueLabelInput, SendResult } from './sink/actionSink.js';
import type { Store } from './store/store.js';
import { watchLabelFor } from './watchLabels.js';

// → docs/spec/06-issue-pickup.md

export interface IssueWatchContext {
  store: Pick<Store, 'getWorldBaseline' | 'patchWorldLabels' | 'patchTicketLabels'>;
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

export async function applyIssueWatch(
  ctx: IssueWatchContext,
  issueNumber: number,
  watched: boolean,
  because: string,
): Promise<IssueWatchOutcome> {
  const label = watchLabelFor(ctx.labelPrefix);
  if (!label) return { label, targets: [], landed: [], failed: [] };

  const world = ctx.store.getWorldBaseline();
  const issue = world?.issues.find((i) => i.number === issueNumber);
  const targets =
    issue === undefined ? [issueNumber] : watchCascadeTargets(issue, world?.issues ?? [], ctx.issueContainerTypes);

  const landed: number[] = [];
  const failed: { number: number; message: string }[] = [];
  for (const target of targets) {
    try {
      await ctx.sink.setIssueLabel({ number: target, label, present: watched });
      landed.push(target);
    } catch (err) {
      const message = (err as Error).message;
      failed.push({ number: target, message });
      ctx.errors?.record({
        source: 'server',
        message: `Failed to ${watched ? 'set' : 'drop'} the watch tag on #${target} ${because}: ${message}`,
      });
    }
  }

  ctx.store.patchWorldLabels({ issues: landed, label, present: watched });
  ctx.store.patchTicketLabels({ numbers: landed, label, present: watched });
  return { label, targets, landed, failed };
}
