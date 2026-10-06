import { z } from 'zod';
import { MAX_OUTCOME_SUMMARY } from '../../botPrs/outcome.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md, docs/spec/37-bot-prs.md#when-ci-fails-on-one

const DependencyOutcomeArgs = z.object({
  outcome: z
    .enum(['adapted', 'upstream-bug', 'intended-break', 'unclear'])
    .describe(
      'adapted: our code relied on behaviour the update changed on purpose, and you fixed it on this branch. ' +
        'upstream-bug: the dependency itself regressed; do not patch around it. intended-break: the change is ' +
        'deliberate, but adapting is more than a fix here. unclear: you could not tell.',
    ),
  summary: z
    .string()
    .describe(
      `What you found, in a sentence or two, ${String(MAX_OUTCOME_SUMMARY)} characters at the outside, for the ` +
        'person deciding whether to close this pull request: the behaviour that changed and why it fails.',
    ),
  upstream_url: z
    .string()
    .optional()
    .describe("The dependency's issue, pull request or release that shows what you found. Required for upstream-bug."),
  fixed_in: z
    .string()
    .optional()
    .describe('The version the fix ships in, where the upstream issue or release names one.'),
});

export const dependencyOutcome: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    "Record what a failing build on a dependency bot's pull request turned out to be. Call it once you know; " +
    'calling it again replaces what you said. Any outcome but adapted stops the fleet dispatching for CI on this ' +
    'head, and is drawn on the Bot PRs tab beside the pull request, where a person can close it.',
  inputSchema: toolSchema(DependencyOutcomeArgs),
  handler: (args) => {
    const parsed = DependencyOutcomeArgs.safeParse(args);
    if (!parsed.success) return toolError(`Outcome rejected: ${parsed.error.message}`);
    const { outcome, summary, upstream_url, fixed_in } = parsed.data;
    const result = deps.agents.recordBotPrOutcome(agent.id, {
      outcome,
      summary,
      upstreamUrl: upstream_url ?? null,
      fixedIn: fixed_in ?? null,
    });
    if (!result.ok) return toolError(result.error);
    return ok({
      recorded: true,
      note:
        outcome === 'adapted'
          ? 'Recorded. Push your fix if you have not already.'
          : 'Recorded. Now escalate: whether to close this pull request or take the change on is a person’s call.',
    });
  },
});
