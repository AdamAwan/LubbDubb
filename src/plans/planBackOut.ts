import type { Config } from '../config.js';
import type { ErrorLog } from '../errorLog.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import { issueConclusionOrigin } from '../issueConclusion.js';
import { applyIssueWatch } from '../issueWatch.js';
import { originIssueNumber } from './planning.js';
import { declinePlan, refusePlan } from './planApproval.js';

// → docs/spec/08-planning.md

export type BackOutVerdict = 'close' | 'hold';

export interface BackOutContext {
  store: Store;
  sink: ActionSink;
  config: Pick<Config, 'labelPrefix' | 'issueContainerTypes'>;
  errors: ErrorLog;
}

interface BackOutResult {
  ok: boolean;
  detail: string;
}

export async function backOutOfPlan(
  ctx: BackOutContext,
  act: { planId: string; originRef: string },
  verdict: BackOutVerdict,
  note: string | null,
): Promise<BackOutResult> {
  const { store } = ctx;
  const issueNumber = originIssueNumber(act.originRef);
  if (issueNumber === null) return { ok: false, detail: `${act.originRef} names no issue to back out of` };

  const done: string[] = [];

  if (verdict === 'hold') {
    done.push(refusePlan(store, act.planId, act.originRef, note).detail);
  }

  if (verdict === 'close') {
    const settled = declinePlan(store, act.planId, act.originRef, note);
    done.push(settled.detail);
    store.verdicts.recordIssueConclusion({
      originRef: issueConclusionOrigin(issueNumber),
      verdict: 'done',
      note: note ?? 'An operator closed this ticket from the plan approval card.',
      by: 'operator',
    });
    done.push('concluded the goal, so nothing picks it up again');
  }

  done.push(await unwatch(ctx, issueNumber));

  if (verdict === 'close') {
    done.push(await comment(ctx, issueNumber, note));
    done.push(await closeTicket(ctx, issueNumber));
  }

  return { ok: true, detail: done.join('; ') };
}

async function unwatch(ctx: BackOutContext, issueNumber: number): Promise<string> {
  const { store, config, errors } = ctx;
  const outcome = await applyIssueWatch(
    { store, sink: ctx.sink, errors, labelPrefix: config.labelPrefix, issueContainerTypes: config.issueContainerTypes },
    issueNumber,
    false,
    `while backing out of #${issueNumber}`,
  );
  if (!outcome.label) return 'left the watch tag alone (this deployment configures no label prefix)';
  const { targets, landed, failed } = outcome;
  if (failed.length === 0) return `dropped the watch tag on ${targets.length} item(s)`;
  return `dropped the watch tag on ${landed.length} of ${targets.length} item(s) — #${failed.map((f) => f.number).join(', #')} kept it`;
}

async function comment(ctx: BackOutContext, issueNumber: number, note: string | null): Promise<string> {
  if (note === null) return 'posted no comment (none was given)';
  try {
    await ctx.sink.upsertIssueComment({ number: issueNumber, body: note, commentRef: null });
    return `commented on #${issueNumber}`;
  } catch (err) {
    const message = (err as Error).message;
    ctx.errors.record({
      source: 'server',
      message: `Failed to comment on #${issueNumber} while closing it: ${message}`,
    });
    return `could not comment on #${issueNumber} (${message}) — your words are on the decision instead`;
  }
}

async function closeTicket(ctx: BackOutContext, issueNumber: number): Promise<string> {
  if (!ctx.sink.canCloseIssue())
    return `left #${issueNumber} open — this tracker has no close the harness can write, so that stays a human act`;
  try {
    await ctx.sink.closeIssue({ number: issueNumber, reason: 'not_planned' });
    return `closed #${issueNumber} as not planned`;
  } catch (err) {
    const message = (err as Error).message;
    ctx.errors.record({
      source: 'server',
      message: `Failed to close #${issueNumber} from the plan back-out: ${message}`,
    });
    return `could not close #${issueNumber} (${message}) — it is un-watched, so nothing will work it`;
  }
}
