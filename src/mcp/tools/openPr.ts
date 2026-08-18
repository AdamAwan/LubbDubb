import { issueOrigin, planOriginIssue } from '../../plans/planning.js';
import { prTitleFields, renderPrTitle } from '../../prTitle.js';
import { resolveOpenPr } from '../openPr.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const openPr: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Open the pull request for the work you were dispatched to do. The harness supplies the branch, ' +
    'the base — which is the rung beneath you when your work is stacked on another part — and the ' +
    'title convention; you supply what the change does. You cannot open a pull request for another ' +
    "agent's work: the branch and base come from your own origin, never from an argument. If this " +
    'tool reports it is unavailable, open the pull request yourself against the branch and base named ' +
    'in your prompt.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'What the change does, in a few words — it becomes the title. Not a sentence and not a ' +
          'restatement of the issue: "sync cursor table", not "This PR adds a table for sync cursors".',
      },
      type: {
        type: 'string',
        description: 'Optional conventional-commit type: feat, fix, refactor, docs, test, chore. Omit it if none fits.',
      },
      scope: {
        type: 'string',
        description: 'Optional module the change lands in, e.g. "store". Omit it if the change is broad.',
      },
      // Unlike the title, which `pr-title` renders, the body ships as written —
      // the harness appends the reference and rewrites nothing. So this
      // description is the only place a form is expressible, and it states one.
      body: {
        type: 'string',
        description:
          'Optional PR body. The harness adds the issue reference itself, so describe the change, not ' +
          'which ticket it belongs to. Write it as a bullet list: at most five bullets, why the change ' +
          'is needed first and what it does after, one line each. No headings, no prose paragraphs — a ' +
          'reviewer reads this before the diff, not instead of it.',
      },
    },
    required: ['summary'],
  },
  handler: async (args) => {
    const wiring = deps.openPr;
    if (!wiring) {
      return toolError(
        'Pull-request authoring is not wired on this harness. Open the pull request yourself against ' +
          'the branch and base named in your prompt.',
      );
    }
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (!summary) return toolError('open_pr rejected: summary is required and must not be empty.');

    const issueNumber = planOriginIssue(task.originRef);
    const plan = issueNumber === null ? null : deps.store.getPlanByOrigin(issueOrigin(issueNumber));
    const target = resolveOpenPr(task.originRef, {
      issues: deps.store.getWorldBaseline()?.issues ?? [],
      plan,
      parts: plan ? deps.store.listPlanParts(plan.id) : [],
      defaultBranch: wiring.defaultBranch,
    });
    if ('error' in target) return toolError(target.error);

    const title = renderPrTitle(
      wiring.prompts.render('pr-title', {}),
      prTitleFields({
        number: target.issueNumber,
        title: target.issueTitle,
        position: target.position,
        total: target.total,
        type: typeof args.type === 'string' ? args.type : undefined,
        scope: typeof args.scope === 'string' ? args.scope : undefined,
        summary,
      }),
    );

    // The reference is appended, never interpolated into the agent's body — and
    // deliberately never a closing keyword. Whether a PR closes its issue is the
    // agent's judgement (the prompts say so); a harness-written "closes" would
    // shut a ticket whose remaining parts are still open.
    const reference =
      target.total > 1
        ? `Part ${target.position}/${target.total} of #${target.issueNumber}.`
        : `Relates to #${target.issueNumber}.`;
    const given = typeof args.body === 'string' ? args.body.trim() : '';
    const body = given ? `${given}\n\n${reference}` : reference;

    try {
      const result = await wiring.sink.createPullRequest({
        branch: target.branch,
        base: target.base,
        title,
        body,
      });
      return ok({
        opened: result.ok,
        pullRequest: result.ref ? Number(result.ref) : null,
        title,
        branch: target.branch,
        base: target.base,
        note:
          target.base === wiring.defaultBranch
            ? 'Opened against the default branch.'
            : `Opened against ${target.base} — your work is stacked on it, so do not retarget this at the default branch.`,
      });
    } catch (err) {
      return toolError(
        `Opening the pull request failed: ${(err as Error).message}. Open it yourself against ` +
          `${target.branch} -> ${target.base}.`,
      );
    }
  },
});
