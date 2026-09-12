import { z } from 'zod';
import { issueOrigin, originIssueNumber } from '../../plans/planning.js';
import { toolSchema } from '../schema.js';
import { prTitleFields, renderPrTitle } from '../../prTitle.js';
import { openPrFailure, resolveOpenPr } from '../openPr.js';
import { linkPrWorkItem } from '../../prWorkItemDesk.js';
import { seedPrWatch } from '../../prWatchDesk.js';
import { toolError } from '../protocol.js';
import type { PrRefStyle } from '../../prRef.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

function prRefGuidance(style: PrRefStyle): string {
  return style === '!'
    ? 'If you name another pull request in it — the one your work stacks on, say — write it as `!12`, ' +
        'not `#12`: this provider reads `#12` as work item 12, so the wrong sigil links to an unrelated ticket.'
    : 'If you name another pull request in it — the one your work stacks on, say — write it as `#12`.';
}

export const openPr: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Open the pull request for the work you were dispatched to do. The harness supplies the branch, ' +
    'the base — which is the rung beneath you when your work is stacked on another part — and the ' +
    'title convention; you supply what the change does. Commit and push your branch before you call ' +
    'this — the harness never pushes, and the provider refuses a pull request whose head it cannot ' +
    'see. You cannot open a pull request for another ' +
    "agent's work: the branch and base come from your own origin, never from an argument. If this " +
    'tool reports it is unavailable, open the pull request yourself against the branch and base named ' +
    'in your prompt.',
  inputSchema: toolSchema(
    z.object({
      summary: z
        .string()
        .describe(
          'What the change does, in a few words — it becomes the title. Not a sentence and not a ' +
            'restatement of the issue: "sync cursor table", not "This PR adds a table for sync cursors".',
        ),
      type: z
        .string()
        .describe('Optional conventional-commit type: feat, fix, refactor, docs, test, chore. Omit it if none fits.')
        .optional(),
      scope: z
        .string()
        .describe('Optional module the change lands in, e.g. "store". Omit it if the change is broad.')
        .optional(),
      body: z
        .string()
        .describe(
          'Optional PR body. The harness adds the issue reference itself, so describe the change, not ' +
            'which ticket it belongs to. Write it as a bullet list: at most five bullets, why the change ' +
            'is needed first and what it does after, one line each. No headings, no prose paragraphs — a ' +
            'reviewer reads this before the diff, not instead of it. ' +
            prRefGuidance(deps.openPr?.prRefStyle ?? '#'),
        )
        .optional(),
    }),
  ),
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

    const issueNumber = originIssueNumber(task.originRef);
    const plan = issueNumber === null ? null : deps.store.plans.getPlanByOrigin(issueOrigin(issueNumber));
    const target = resolveOpenPr(task.originRef, {
      issues: deps.store.world.getWorldBaseline()?.issues ?? [],
      plan,
      parts: plan ? deps.store.plans.listPlanParts(plan.id) : [],
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
      const prNumber = result.ref ? Number(result.ref) : null;
      if (prNumber !== null && Number.isFinite(prNumber)) {
        await seedPrWatch(
          { prNumber, branch: target.branch },
          { sink: wiring.sink, store: deps.store, watchLabel: wiring.watchLabel, errors: deps.errors },
        );
        await linkPrWorkItem(
          { prNumber, workItemNumber: target.issueNumber },
          { sink: wiring.sink, store: deps.store, errors: deps.errors },
        );
      }
      return ok({
        opened: result.ok,
        pullRequest: prNumber,
        title,
        branch: target.branch,
        base: target.base,
        note:
          target.base === wiring.defaultBranch
            ? 'Opened against the default branch.'
            : `Opened against ${target.base} — your work is stacked on it, so do not retarget this at the default branch.`,
      });
    } catch (err) {
      return toolError(openPrFailure((err as Error).message, target.branch, target.base));
    }
  },
});
