import type { PrReviewThread } from '../types.js';
import type { PrReviewPolicy } from './policy.js';
import { defaultReviewMode, resolvedReviewMode, reviewSkipped, triageRuns, type PrReviewReading } from './prReview.js';

// → docs/spec/31-review-packs.md

export type PrReviewStatus = 'deciding' | 'routed' | 'clear' | 'findings' | 'skipped' | 'elsewhere';

export interface PrReviewState {
  status: PrReviewStatus;
  mode: string | null;
  routeReason: string | null;
  summary: string | null;
  findings: readonly string[];
  addressed: boolean;
  reviewedAt: string | null;
  routedAt: string | null;
  agentId: string | null;
  routeAgentId: string | null;
  headSha: string | null;
}

function reviewAddressed(
  publishedThread: string | null,
  threads: readonly PrReviewThread[],
  policy: PrReviewPolicy,
): boolean {
  if (publishedThread !== null && threads.some((t) => t.id === publishedThread && t.state === 'resolved')) return true;
  const key = policy.publishedThreadProperty;
  if (key === null || key === '') return false;
  const role = policy.publishedThreadRole;
  const stamped = threads.filter((t) => {
    const props = t.properties;
    if (props === undefined || props[key] === undefined) return false;
    return role === null || role === '' || props[`${key}.role`] === role;
  });
  return stamped.length > 0 && stamped.every((t) => t.state === 'resolved');
}

export function prReviewState(
  prNumber: number,
  reading: PrReviewReading,
  policy: PrReviewPolicy,
  threads?: readonly PrReviewThread[],
): PrReviewState | null {
  if (!policy.enabled) return null;
  const { review, route } = reading;
  const base = {
    mode: null,
    routeReason: route?.reason ?? null,
    summary: null,
    findings: [],
    addressed: false,
    reviewedAt: null,
    routedAt: route?.decidedAt ?? null,
    agentId: null,
    routeAgentId: route?.agentId ?? null,
    headSha: null,
  } satisfies Omit<PrReviewState, 'status'>;

  if (review !== null) {
    return {
      ...base,
      status: review.verdict === 'findings' ? 'findings' : 'clear',
      mode: resolvedReviewMode(route, policy),
      summary: review.summary,
      findings: review.findings,
      addressed: reviewAddressed(review.publishedThread, threads ?? [], policy),
      reviewedAt: review.reviewedAt,
      agentId: review.agentId,
      headSha: review.headSha,
    };
  }
  if (reading.elsewhere.has(prNumber)) return { ...base, status: 'elsewhere' };
  if (reviewSkipped(route, policy)) return { ...base, status: 'skipped', mode: null };
  if (route !== null) return { ...base, status: 'routed', mode: resolvedReviewMode(route, policy) };
  return triageRuns(policy)
    ? { ...base, status: 'deciding' }
    : { ...base, status: 'routed', mode: defaultReviewMode(policy) };
}
