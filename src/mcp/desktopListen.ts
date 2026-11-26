import { z } from 'zod';
import { goalIssue, goalOfPr, issueAddress, prAddress } from '../asks/lines.js';
import type { PrReadInputs } from '../asks/queue.js';
import { prOnYouReasons } from '../listen/prsOnYou.js';
import { prSkillOf, type ListenPolicy } from '../listen/policy.js';
import { prState } from '../pr/prHealth.js';
import { knownPrs, prView, replyView } from './worldRead.js';
import type { OpenPullRequest } from '../wire.js';
import type { AutoSendWhy, ListenItem } from '../types.js';
import type { DesktopToolFactory } from './desktopContext.js';
import { toolSchema } from './schema.js';
import { toolError, toolJson } from './protocol.js';

// → docs/spec/44-needs-you.md

const WAIT_NEXT = {
  item: 'Start a session or fork for it running `skill`, titled `title`, then call ask_wait again at once.',
  none: 'Nothing was sent. Call ask_wait again, saying nothing.',
};

const PR_TITLE: Record<AutoSendWhy | 'sent', string> = {
  review: 'Review',
  ready: 'Ready',
  sent: 'Talk through',
};

function itemSkill(item: ListenItem, policy: ListenPolicy): { skill: string; title: string } {
  if (item.kind === 'ask') return { skill: `/lubbdubb:next ${item.id} only`, title: `Talk through ask ${item.id}` };
  return { skill: `${prSkillOf(policy)} ${item.number}`, title: `${PR_TITLE[item.why ?? 'sent']} #${item.number}` };
}

export const askWait: DesktopToolFactory = (deps) => ({
  description:
    'Wait for what is sent to this chat — an ask (`id`) or a pull request (`number`) from the cockpit’s Needs ' +
    'you page, or a pull request the harness sent by itself (`why`: review or ready). Returns at once when ' +
    'something is waiting; otherwise holds for up to ten minutes and returns `{ item: null }`, and the listen ' +
    'loop calls it again. An item comes with the `skill` line to run and the `title` to give its session. A ' +
    'newer ask_wait answers an older one with `superseded: true`. Each item is handed out once. Decides nothing.',
  inputSchema: toolSchema(z.object({})),
  handler: async () => {
    const result = await deps.listener.wait();
    if (result.superseded === true) return toolJson({ ...result, next: 'Another ask_wait took over. Stop here.' });
    if (result.item === null) return toolJson({ ...result, next: WAIT_NEXT.none });
    return toolJson({ ...result, ...itemSkill(result.item, deps.listen()), next: WAIT_NEXT.item });
  },
});

function deliversGoal(inputs: PrReadInputs, pr: OpenPullRequest): Record<string, unknown> | null {
  const ref = goalOfPr(inputs, pr.number);
  if (ref === null) return null;
  const issue = goalIssue(inputs, ref);
  const part = (inputs.planParts ?? []).find((p) => p.prNumber === pr.number);
  return {
    ref,
    title: issue?.title ?? null,
    url: issue === undefined ? null : (issueAddress(inputs, issue) ?? null),
    part: part === undefined ? null : { slug: part.slug, title: part.title },
  };
}

const PR_READ_NEXT =
  'Put this pull request in front of the operator: what it is, why it is on them (`onYou`), CI, and the ' +
  'review threads still open. Where the talk turns on the diff, read it in this checkout or hand the read ' +
  'to a subagent. Act only on their word, through pr_assign, description_read and description_check.';

function notOpen(inputs: PrReadInputs, n: number): string {
  const closed = (inputs.world.closedPullRequests ?? []).find((p) => p.number === n);
  return closed === undefined
    ? `The harness holds no open pull request #${n}. ${knownPrs(inputs.world)}`
    : `Pull request #${n} is ${prState(closed)}, not open — there is nothing on it to act on.`;
}

function describePr(inputs: PrReadInputs, pr: OpenPullRequest): Record<string, unknown> {
  return {
    ...prView(pr, inputs.world),
    url: pr.url ?? prAddress(inputs, pr.number) ?? null,
    body: pr.body ?? null,
    author: pr.author ?? null,
    observedAt: inputs.world.takenAt,
    ciVerdict: pr.ciVerdict,
    reviewThreads: (pr.reviewThreads ?? []).map((t) => ({
      id: t.id,
      author: t.author,
      state: t.state,
      path: t.path ?? null,
      line: t.line ?? null,
      body: t.body,
      replies: t.replies.map(replyView),
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
    'operator (`onYou`: review, call, comments, assign, describe), the reviewer ask (`assignAsk`), and the goal ' +
    'it delivers. Records nothing.',
  inputSchema: toolSchema(z.object({ number: z.number().describe('The pull request number, e.g. 212.') })),
  handler: (args) => {
    const n = args.number;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0)
      return toolError('number must be the pull request number, e.g. 212.');
    const inputs = deps.prInputs();
    const pr = inputs.world.pullRequests.find((p) => p.number === n);
    if (pr === undefined) return toolError(notOpen(inputs, n));
    return toolJson({ ...describePr(inputs, pr), next: PR_READ_NEXT });
  },
});
