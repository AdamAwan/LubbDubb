import type { SendResult } from '../../sink/actionSink.js';
import type { BotPrDetail, BotPullRequest, CiStatus } from '../../types.js';
import { authoredBy } from '../integration.js';
import type { GhPullSummary, GitHubApi } from './githubApi.js';

// → docs/spec/37-bot-prs.md#the-read

export async function listGitHubBotPulls(
  api: GitHubApi,
  authors: readonly RegExp[],
  ciOf: (p: GhPullSummary) => Promise<CiStatus>,
): Promise<BotPullRequest[]> {
  const [viewer, open] = await Promise.all([api.viewerLogin(), api.listOpenPulls()]);
  const pulls = open.filter((p) => authoredBy(authors, p.authorLogin));
  return Promise.all(
    pulls.map(async (p): Promise<BotPullRequest> => {
      const pr: BotPullRequest = {
        number: p.number,
        title: p.title,
        author: p.authorLogin,
        ciStatus: await ciOf(p),
        reviewers: p.assigneeLogins.map((login) => ({ id: login, name: login })),
        viewerReviewing: viewer !== '' && p.assigneeLogins.includes(viewer),
        url: p.url,
        headSha: p.headSha,
      };
      if (p.createdAt !== undefined) pr.createdAt = p.createdAt;
      if (p.body !== undefined) pr.body = p.body;
      return pr;
    }),
  );
}

export async function claimGitHubBotPr(api: GitHubApi, prNumber: number): Promise<SendResult> {
  const login = await api.viewerLogin();
  if (login === '') return { ok: false };
  await api.addPullAssignee(prNumber, login);
  return { ok: true, ref: login };
}

export async function readGitHubBotPrDetail(api: GitHubApi, prNumber: number): Promise<BotPrDetail> {
  return { body: null, files: await api.listPullFiles(prNumber) };
}

export async function readGitHubReleaseNotes(
  api: GitHubApi,
  source: { owner: string; repo: string },
  tags: readonly string[],
): Promise<string | null> {
  for (const tag of tags) {
    const body = await api.getReleaseBody(source.owner, source.repo, tag);
    if (body !== null && body.trim() !== '') return body;
  }
  return null;
}
