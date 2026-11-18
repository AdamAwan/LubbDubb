import { z } from 'zod';
import { issueAddress, prAddress } from '../asks/lines.js';
import type { AskInputs } from '../asks/queue.js';
import { issueOrigin } from '../plans/planning.js';
import { prOnYouReasons } from '../listen/prsOnYou.js';
import type { OpenPullRequest } from '../wire.js';
import type { DesktopToolFactory } from './desktopContext.js';
import { toolSchema } from './schema.js';
import { toolError, toolJson } from './protocol.js';

// → docs/spec/44-needs-you.md

const WAIT_NEXT = {
  ask: 'Start a fork for it running `/lubbdubb:next <id> only`, then call ask_wait again at once.',
  pr: 'Start a fork for it running `/lubbdubb:pr <number>`, then call ask_wait again at once.',
  none: 'Nothing was sent. Call ask_wait again, saying nothing.',
};

export const askWait: DesktopToolFactory = (deps) => ({
  description:
    'Wait for the operator to send this chat something from the cockpit’s Needs you page — an ask (`id`) or a ' +
    'pull request (`number`). Returns at once when something is waiting; otherwise holds for up to ten ' +
    'minutes and returns `{ item: null }`, and the listen loop calls it again. A newer ask_wait answers an ' +
    'older one with `superseded: true`. Each item is handed out once. Decides nothing.',
  inputSchema: toolSchema(z.object({})),
  handler: async () => {
    const result = await deps.listener.wait();
    const next = result.item === null ? WAIT_NEXT.none : WAIT_NEXT[result.item.kind];
    return toolJson({ ...result, next: result.superseded === true ? 'Another ask_wait took over. Stop here.' : next });
  },
});

function deliversGoal(inputs: AskInputs, pr: OpenPullRequest): Record<string, unknown> | null {
  const part = (inputs.planParts ?? []).find((p) => p.prNumber === pr.number);
  const plan = part === undefined ? undefined : (inputs.plans ?? []).find((p) => p.id === part.planId);
  const ref = plan?.originRef ?? null;
  const issue = inputs.world.issues.find((i) =>
    ref === null ? i.linkedPrNumber === pr.number : issueOrigin(i.number) === ref,
  );
  const goalRef = ref ?? (issue === undefined ? null : issueOrigin(issue.number));
  if (goalRef === null) return null;
  return {
    ref: goalRef,
    title: issue?.title ?? null,
    url: issue === undefined ? null : (issueAddress(inputs, issue) ?? null),
    part: part === undefined ? null : { slug: part.slug, title: part.title },
  };
}

const PR_READ_NEXT =
  'Put this pull request in front of the operator: what it is, why it is on them (`onYou`), CI, and the ' +
  'review threads still open. Where the talk turns on the diff, read it in this checkout or hand the read ' +
  'to a subagent. Act only on their word, through pr_assign, description_read and description_check.';

function notOpen(inputs: AskInputs, n: number): string {
  const closed = (inputs.world.closedPullRequests ?? []).find((p) => p.number === n);
  return closed === undefined
    ? `The harness holds no open pull request #${n}. Check the number; the last world reading does not list it.`
    : `Pull request #${n} is ${closed.merged === true ? 'merged' : 'closed'}, not open — there is nothing on it to act on.`;
}

function describePr(inputs: AskInputs, pr: OpenPullRequest): Record<string, unknown> {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    branch: pr.branch,
    baseBranch: pr.baseBranch ?? null,
    url: pr.url ?? prAddress(inputs, pr.number) ?? null,
    author: pr.author ?? null,
    observedAt: inputs.world.takenAt,
    ci: { status: pr.ciStatus, checks: pr.ciChecks ?? [], verdict: pr.ciVerdict },
    reviewThreads: (pr.reviewThreads ?? []).map((t) => ({
      id: t.id,
      author: t.author,
      state: t.state,
      path: t.path ?? null,
      line: t.line ?? null,
      body: t.body,
      replies: t.replies.map((r) => ({ author: r.author, body: r.body, ours: r.ours })),
    })),
    unresolvedComments: pr.unresolvedComments.map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      handled: c.handled,
      replies: (c.replies ?? []).map((r) => ({ author: r.author, body: r.body, ours: r.ours })),
    })),
    attention: pr.attention,
    onYou: prOnYouReasons(pr),
    assignAsk: pr.assignAsk ?? null,
    goal: deliversGoal(inputs, pr),
  };
}

export const prRead: DesktopToolFactory = (deps) => ({
  description:
    'The harness’s record of one open pull request: title, body, branch, url, CI checks and the CI verdict, ' +
    'review threads with their replies, unresolved comments, `attention` with its reasons, why it is on the ' +
    'operator (`onYou`), the reviewer ask (`assignAsk`), and the goal it delivers. Records nothing.',
  inputSchema: toolSchema(z.object({ number: z.number().describe('The pull request number, e.g. 212.') })),
  handler: (args) => {
    const n = args.number;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0)
      return toolError('number must be the pull request number, e.g. 212.');
    const { inputs } = deps.asks();
    const pr = inputs.world.pullRequests.find((p) => p.number === n);
    if (pr === undefined) return toolError(notOpen(inputs, n));
    return toolJson({ ...describePr(inputs, pr), next: PR_READ_NEXT });
  },
});
