import { z } from 'zod';
import { MAX_RISK_SUMMARY } from '../../botPrs/riskRecord.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md, docs/spec/37-bot-prs.md#the-risk-summary

const BotPrRiskArgs = z.object({
  pr: z.number().int().describe('The pull request number, as its heading in your brief gives it.'),
  risk: z
    .enum(['low', 'medium', 'high'])
    .describe(
      'low: safe to approve on a green build without reading. medium: probably fine, but one named thing is ' +
        'worth a glance. high: somebody should read it properly before it goes in.',
    ),
  summary: z
    .string()
    .describe(
      `One or two sentences, ${String(MAX_RISK_SUMMARY)} characters at the outside, for the person deciding ` +
        'whether to approve: the thing that set the risk, not the version numbers again. Say so where the ' +
        'release notes were missing.',
    ),
});

export const botPrRisk: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Record how risky one dependency-bot pull request in your batch is to merge. Call it once for every pull ' +
    'request you were handed; calling it again for the same one replaces what you said. It is drawn beside the ' +
    'pull request on the Bot PRs tab and nowhere else: nothing is approved, merged or posted from it.',
  inputSchema: toolSchema(BotPrRiskArgs),
  handler: (args) => {
    const parsed = BotPrRiskArgs.safeParse(args);
    if (!parsed.success) return toolError(`Risk rejected: ${parsed.error.message}`);
    const { pr, risk, summary } = parsed.data;
    const result = deps.agents.recordBotPrRisk(agent.id, { prNumber: pr, risk, summary });
    if (!result.ok) return toolError(result.error);
    return ok({
      recorded: true,
      remaining: result.remaining,
      note:
        result.remaining.length === 0
          ? 'Recorded. That was the last one in the batch; you are done.'
          : `Recorded. Still to do: ${result.remaining.join(', ')}.`,
    });
  },
});
