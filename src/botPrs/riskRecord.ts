import type { Store } from '../store/store.js';
import type { BotPrRiskLevel } from '../types.js';
import { botPrRiskRunId } from './riskOrigin.js';

// → docs/spec/37-bot-prs.md#the-risk-summary

export const MAX_RISK_SUMMARY = 400;

export interface BotPrRiskInput {
  prNumber: number;
  risk: BotPrRiskLevel;
  summary: string;
}

export type BotPrRiskRecorded = { ok: true; remaining: number[] } | { ok: false; error: string };

/** The run is resolved from the dispatch origin, so an agent can only rule on the heads it was handed. */
export function recordBotPrRisk(store: Store, originRef: string | null, input: BotPrRiskInput): BotPrRiskRecorded {
  const runId = botPrRiskRunId(originRef);
  const run = runId === null ? null : store.botPrRisks.getRun(runId);
  if (run === null)
    return {
      ok: false,
      error: `bot_pr_risk is only for the agent dispatched to read bot pull requests for risk, and this task's origin is ${originRef ?? '(none)'}.`,
    };
  const subject = run.subjects.find((s) => s.number === input.prNumber);
  if (subject === undefined)
    return {
      ok: false,
      error: `PR ${String(input.prNumber)} is not in this batch. The batch is ${run.subjects.map((s) => s.number).join(', ')}.`,
    };
  const summary = input.summary.trim();
  if (summary === '') return { ok: false, error: 'summary is empty: say what set the risk, in a sentence or two.' };
  if (summary.length > MAX_RISK_SUMMARY)
    return {
      ok: false,
      error: `summary is ${String(summary.length)} characters; keep it to ${String(MAX_RISK_SUMMARY)} — one or two sentences.`,
    };
  store.botPrRisks.recordRisk({
    prNumber: subject.number,
    headSha: subject.headSha,
    risk: input.risk,
    summary,
    runId: run.id,
  });
  const done = store.botPrRisks.assessedIn(run.id);
  return { ok: true, remaining: run.subjects.map((s) => s.number).filter((n) => !done.has(n)) };
}
