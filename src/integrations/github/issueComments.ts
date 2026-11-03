import type { Octokit } from '@octokit/rest';
import type { GhIssueComment } from './githubApi.js';

// → docs/spec/15-integrations.md

export async function listIssueComments(
  octokit: Octokit,
  base: { owner: string; repo: string },
  number: number,
  since?: string,
): Promise<GhIssueComment[]> {
  const comments = await octokit.paginate(octokit.issues.listComments, {
    ...base,
    issue_number: number,
    per_page: 100,
    ...(since === undefined ? {} : { since }),
  });
  return comments.map((c) => ({
    id: c.id,
    authorLogin: c.user?.login ?? 'ghost',
    body: c.body ?? '',
    createdAt: c.created_at,
  }));
}
