import type { SendResult } from '../../sink/actionSink.js';
import type { BotPrDetail, BotPullRequest, CiStatus } from '../../types.js';
import { authoredBy } from '../integration.js';
import type { AzPolicyEvaluation, AzureDevOpsApi } from './azureDevOpsApi.js';
import { namedReviewers, viewerAssignment } from './reviewers.js';

// → docs/spec/37-bot-prs.md#the-read

export function azAuthorName(p: { authorDisplayName?: string; authorUniqueName: string }): string {
  return p.authorDisplayName || p.authorUniqueName;
}

export async function listAzureBotPulls(
  api: AzureDevOpsApi,
  authors: readonly RegExp[],
  ciOf: (evals: AzPolicyEvaluation[]) => CiStatus,
): Promise<BotPullRequest[]> {
  const [viewer, active] = await Promise.all([api.viewerUniqueName(), api.listActivePullRequests()]);
  const pulls = active.filter((p) => authoredBy(authors, p.authorUniqueName, p.authorDisplayName));
  return Promise.all(
    pulls.map(async (p): Promise<BotPullRequest> => {
      const evals = await api.listPolicyEvaluations(p.pullRequestId);
      const optional = p.reviewers.filter((r) => !r.isRequired);
      const pr: BotPullRequest = {
        number: p.pullRequestId,
        title: p.title,
        author: azAuthorName(p),
        ciStatus: ciOf(evals),
        reviewers: namedReviewers(optional),
        viewerReviewing: viewer !== '' && viewerAssignment(optional, viewer) !== undefined,
        url: p.url,
      };
      if (p.lastMergeSourceCommit) pr.headSha = p.lastMergeSourceCommit;
      if (p.createdAt !== undefined) pr.createdAt = p.createdAt;
      if (p.description !== undefined) pr.body = p.description;
      return pr;
    }),
  );
}

export async function claimAzureBotPr(api: AzureDevOpsApi, prNumber: number): Promise<SendResult> {
  const id = await api.viewerId();
  if (id === '') return { ok: false };
  await api.addPullReviewer(prNumber, id);
  return { ok: true, ref: id };
}

export async function readAzureBotPrDetail(api: AzureDevOpsApi, prNumber: number): Promise<BotPrDetail> {
  const [body, paths] = await Promise.all([api.getPullBody(prNumber), api.listPullChangedPaths(prNumber)]);
  return { body, files: paths.map((path) => ({ path, additions: null, deletions: null, patch: null })) };
}
