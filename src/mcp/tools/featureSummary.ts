import { z } from 'zod';
import { validateFeatureSummary } from '../../featureSummaries/featureSummary.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

const FeatureSummaryArgs = z.object({
  headline: z
    .string()
    .optional()
    .describe(
      'How far along this is, in a few words — 90 characters at the outside. The half-sentence ' +
        'somebody repeats when they are asked how the Feature is going: "most of the way there, ' +
        'nothing on live yet", "barely started", "done bar the deploy". Describe where the work has ' +
        'got to, which you have read; do not predict where it will get to, which you have not — no ' +
        'dates, no percentages, no "on track" and no "at risk". Where you cannot tell, leave it out ' +
        'rather than hedging in it.',
    ),
  standing: z
    .string()
    .describe(
      'Required. Two sentences, 360 characters at the outside: where this Feature actually is. ' +
        'What works, and the one thing standing between the reader and the rest. This is the whole ' +
        'of what the card shows before anything is expanded, and the bullets carry the detail.',
    ),
  usable: z
    .string()
    .describe(
      'Up to four bullets, one line each, each beginning with "- ": what a person can see or do ' +
        'today and where — name the environment, because "built" and "on live" are the difference ' +
        'the reader cares about. Omit it where nothing has shipped anywhere: "nothing yet" belongs ' +
        'in `standing`, not in a section invented to fill the shape.',
    )
    .optional(),
  blocked: z
    .string()
    .describe(
      'Up to four bullets, same shape: what is stopping the rest, and what it wants from a person ' +
        '— an answer, a decision, a deploy. Say which, because "answer me", "decide" and "release ' +
        'it" read the same on a board and are not the same ask. Drawn under "Needs a person". Omit ' +
        'it for a Feature that is simply being worked.',
    )
    .optional(),
  remaining: z
    .string()
    .describe(
      'One line, drawn as a footnote under the two blocks above. What nobody is working, as a ' +
        'count where a count says it — an item no agent can see is not queued behind anything, and ' +
        'a reader who is not told that will assume it is in hand. Omit it where nothing is ' +
        'outstanding.',
    )
    .optional(),
});

export const featureSummary: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Write the summary for the Feature you were dispatched to summarise. The audience is the person ' +
    'who asked for the Feature and does not read the tracker: say where it is in their terms, not in ' +
    "the fleet's. No status words, no percentages, no dates — you have no grounds for a forecast and " +
    'a reader who is given one stops reading the rest.\n\n' +
    'Keep it short enough to take in at a glance: two sentences of lede, then short one-line bullets. ' +
    'The lengths are enforced rather than advised — an over-long `standing` is refused and an ' +
    'over-long section is cut at a line boundary, so choose what to leave out yourself.\n\n' +
    'You are handed every item under the Feature, where each one stands, and the sentence whoever ' +
    'ruled on it wrote. Restate a shortfall as what it means for the Feature ("a bucket turned off ' +
    'still shows results on three screens"), not as the assessor said it to another agent. The items ' +
    'are drawn beside your summary, so a bullet per ticket says the same thing twice; where the ' +
    'record cannot answer something, say so — an honest "nobody has looked at these four items" is ' +
    'worth more than a confident sentence about them.\n\n' +
    'This is read on the feature board and nowhere else. It schedules nothing, closes nothing, gates ' +
    'nothing and is posted to no tracker. It is rewritten whenever something under the Feature moves, ' +
    'so write where things are now rather than a history of how they got here.',
  inputSchema: toolSchema(FeatureSummaryArgs),
  handler: (args) => {
    const parsed = validateFeatureSummary(args);
    if (!parsed.ok) return toolError(`Feature summary rejected: ${parsed.error}`);
    const result = deps.agents.recordFeatureSummary(agent.id, parsed.input);
    if (!result.ok) return toolError(result.error);
    return ok({
      filed: true,
      feature: result.featureOrigin,
      trimmed: parsed.trimmed,
      note:
        "Recorded. It is drawn on the feature board above this Feature's items. Nothing is posted to " +
        'the tracker, nothing is closed and nothing is scheduled from it — and it will be rewritten ' +
        'the next time something under the Feature moves.',
    });
  },
});
