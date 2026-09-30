import type { SendResult } from '../../sink/actionSink.js';
import type { BotPrDetail, BotPrFile, BotPullRequest, CiStatus } from '../../types.js';
import { lineDiff } from '../../botPrs/lineDiff.js';
import type { ErrorRecorder } from '../../errorLog.js';
import { isLockfile } from '../../botPrs/lockfiles.js';
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
  const diffable = new Set(
    base === null || head === null ? [] : changes.files.filter((f) => !isLockfile(f.path)).slice(0, MAX_DIFFED_FILES),
  );
  const files: BotPrFile[] = [];
  for (const file of changes.files) {
    files.push(
      diffable.has(file)
        ? await diffedFile(api, file, base!, head!, prNumber, errors)
        : { path: file.path, additions: null, deletions: null, patch: null },
    );
  }
  return { body, files };
}

async function diffedFile(
  api: AzureDevOpsApi,
  { path, from }: { path: string; from: string | null },
  base: string,
  head: string,
  prNumber: number,
  errors: ErrorRecorder | undefined,
): Promise<BotPrFile> {
  try {
    const [before, after] = await Promise.all([
      api.getFileAtCommit(from ?? path, base),
      api.getFileAtCommit(path, head),
    ]);
    return { path, ...lineDiff(before, after) };
  } catch (err) {
    errors?.record({
      source: 'provider',
      message: `Reading ${path} on bot PR ${String(prNumber)} failed; it goes out without its diff: ${(err as Error).message}`,
    });
    return { path, additions: null, deletions: null, patch: null };
  }
}
