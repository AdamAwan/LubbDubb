import type { Store } from '../store/store.js';
import type { BotPrOutcome, BotPrOutcomeKind, PullRequest } from '../types.js';

// → docs/spec/37-bot-prs.md#when-ci-fails-on-one

export const MAX_OUTCOME_SUMMARY = 600;

export interface BotPrOutcomeInput {
  outcome: BotPrOutcomeKind;
  summary: string;
  upstreamUrl: string | null;
  fixedIn: string | null;
}

export type BotPrOutcomeRecorded = { ok: true; outcome: BotPrOutcome } | { ok: false; error: string };

function ciFixPrNumber(originRef: string | null): number | null {
  const match = /^pr:(\d+):ci$/.exec(originRef ?? '');
  return match ? Number(match[1]) : null;
}

/** The pull request is resolved from the dispatch origin and the head from the world, never from the agent. */
export function recordBotPrOutcome(
  store: Store,
  task: { id: string; originRef: string | null },
  input: BotPrOutcomeInput,
): BotPrOutcomeRecorded {
  const prNumber = ciFixPrNumber(task.originRef);
  if (prNumber === null)
    return {
      ok: false,
      error: `dependency_outcome is only for an agent fixing CI on a dependency bot's pull request, and this task's origin is ${task.originRef ?? '(none)'}.`,
    };
  const pr = store.world.getWorldBaseline()?.pullRequests.find((p) => p.number === prNumber);
  if (pr?.botAuthored !== true)
    return {
      ok: false,
      error: `PR #${String(prNumber)} is not a dependency bot's pull request, so there is no update to rule on. Fix the build, or escalate.`,
    };
  const summary = input.summary.trim();
  if (summary === '') return { ok: false, error: 'summary is empty: say what you found, in a sentence or two.' };
  if (summary.length > MAX_OUTCOME_SUMMARY)
    return {
      ok: false,
      error: `summary is ${String(summary.length)} characters; keep it to ${String(MAX_OUTCOME_SUMMARY)}.`,
    };
  const upstreamUrl = input.upstreamUrl?.trim() || null;
  if (input.outcome === 'upstream-bug' && upstreamUrl === null)
    return {
      ok: false,
      error:
        "upstream-bug needs upstream_url: the issue or release that shows the bug is the dependency's. If you found none, the outcome is unclear.",
    };
  return {
    ok: true,
    outcome: store.botPrOutcomes.record({
      prNumber,
      headSha: pr.headSha ?? '',
      outcome: input.outcome,
      summary,
      upstreamUrl,
      fixedIn: input.fixedIn?.trim() || null,
      taskId: task.id,
    }),
  };
}

/**
 * Whether a recorded outcome holds CI dispatches on this pull request's current head. Fails open: a
 * pull request that is not a bot's, a head the provider did not report, or an outcome on any other
 * head holds nothing.
 */
export function ciHeldByOutcome(pr: PullRequest, outcomes: readonly BotPrOutcome[]): BotPrOutcome | null {
  if (pr.botAuthored !== true || !pr.headSha) return null;
  return outcomes.find((o) => o.prNumber === pr.number && o.headSha === pr.headSha && o.outcome !== 'adapted') ?? null;
}
