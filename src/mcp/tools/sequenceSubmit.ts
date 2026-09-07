import { z } from 'zod';
import { featureSequenceSubmitOrigin, validateSequenceSubmission } from '../../sequence/sequence.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const sequenceSubmit: ToolFactory = ({ deps, agent, task, ok }) => ({
  description:
    'Record the order the stories under this Feature should be worked in — which of them cannot start until ' +
    'another has produced something. This is not priority: priority is which of two things somebody wants ' +
    'first, and this is whether starting one early would mean throwing the work away. An order holds work, so ' +
    'a wrong edge is a story that never starts with nothing going red; a short order with most stories in the ' +
    'first wave is usually the honest one, and an empty order saying they are independent is a real answer. ' +
    'Nothing is held until a person accepts what you submit, and nothing is written to the tracker.',
  inputSchema: toolSchema(
    z.object({
      order: z
        .array(
          z.object({
            issue: z.number().describe('The story that waits.'),
            waitsOn: z.array(z.number()).describe('The stories it waits on — all under this same Feature.'),
            why: z
              .string()
              .describe('One line on why this edge — what the first produces that the second would otherwise invent.'),
          }),
        )
        .describe(
          'One entry per story that waits on another. A story you do not list waits on nothing and starts ' +
            'immediately, so an empty list is how you say these stories are independent.',
        ),
      reason: z
        .string()
        .describe(
          'Why this order, in your own voice: what you took the shape of this Feature to be, and what the ' +
            'ordering turns on. Required — an order with no stated reason is one nobody can agree or disagree with.',
        ),
      unsure: z
        .string()
        .describe(
          'The edge you would most like argued with, and what would change your mind. Somebody is about to be ' +
            'asked to accept this, and an order with no stated doubt is one they cannot usefully disagree with.',
        )
        .optional(),
    }),
  ),
  handler: (args) => {
    const target = featureSequenceSubmitOrigin(task.originRef);
    if (!target.ok) return toolError(target.error);
    const children = (deps.store.getWorldBaseline()?.issues ?? [])
      .filter((issue) => issue.parent?.number === target.featureNumber && issue.state === 'open')
      .map((issue) => issue.number);
    const parsed = validateSequenceSubmission(args, children);
    if (!parsed.ok) return toolError(`Order rejected: ${parsed.error}`);
    const result = deps.agents.recordFeatureSequence(agent.id, parsed.submission);
    if (!result.ok) return toolError(result.error);
    return ok({
      proposed: true,
      feature: result.featureOrigin,
      edges: result.edges,
      means:
        'the order is on the Feature’s card as a proposal. It holds nothing: every story stays eligible ' +
        'exactly as it is until somebody accepts it, and if they decline, they will not be asked again until ' +
        'the Feature gains or loses a story.',
    });
  },
});
