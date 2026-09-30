import type { SendResult } from '../../sink/actionSink.js';
import type { BotPrDetail, BotPrFile, BotPullRequest, CiStatus } from '../../types.js';
import { lineDiff } from '../../botPrs/lineDiff.js';
import type { ErrorRecorder } from '../../errorLog.js';
import { isLockfile } from '../../botPrs/riskBrief.js';
import { authoredBy } from '../integration.js';
import type { AzPolicyEvaluation, AzureDevOpsApi } from './azureDevOpsApi.js';
import { namedReviewers, viewerAssignment } from './reviewers.js';

// → docs/spec/37-bot-prs.md#the-read

/** Azure serves contents and no patch, so each diffed file is two reads: bounded per pull request. */
const MAX_DIFFED_FILES = 10;

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

export async function readAzureBotPrDetail(
  api: AzureDevOpsApi,
  prNumber: number,
  errors?: ErrorRecorder,
): Promise<BotPrDetail> {
  const [body, changes] = await Promise.all([api.getPullBody(prNumber), api.listPullChanges(prNumber)]);
  const { base, head } = changes;
  const files: BotPrFile[] = [];
  let diffed = 0;
  for (const { path, from } of changes.files) {
    const bare: BotPrFile = { path, additions: null, deletions: null, patch: null };
    if (isLockfile(path) || base === null || head === null || diffed >= MAX_DIFFED_FILES) {
      files.push(bare);
      continue;
    }
    diffed += 1;
    try {
      const [before, after] = await Promise.all([
        api.getFileAtCommit(from ?? path, base),
        api.getFileAtCommit(path, head),
      ]);
      files.push({ path, ...lineDiff(before ?? '', after ?? '') });
    } catch (err) {
      errors?.record({
        source: 'provider',
        message: `Reading ${path} on bot PR ${String(prNumber)} failed; it goes out without its diff: ${(err as Error).message}`,
      });
      files.push(bare);
    }
  }
  return { body, files };
}
