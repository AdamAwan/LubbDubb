import { validateFeatureSummary } from '../../summaries/featureSummary.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * Where a Feature is, said the way a developer would say it to the person who
 * asked for the Feature.
 *
 * Four fields rather than one document, and that is the load-bearing choice: the
 * card draws them as four blocks, so a reader gets "is any of this usable" without
 * finding it inside a paragraph, and an agent with nothing to put in a block leaves
 * it out rather than padding it. A single `document` would have let the shape drift
 * per Feature, which is the board's own failure — every card read differently —
 * reproduced in prose.
 *
 * **The discriminator lives in the description, not only in the prompt**
 * (`retro_submit`'s rule): the `feature-summary` template is operator-overridable,
 * so a deployment running an override written before a field existed would
 * otherwise dispatch an agent that never hears about it. A tool description always
 * arrives.
 */
export const featureSummary: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Write the summary for the Feature you were dispatched to summarise. The audience is the person ' +
    'who asked for the Feature and does not read the tracker: say where it is in their terms, not in ' +
    "the fleet's. No status words, no percentages, no dates — you have no grounds for a forecast and " +
    'a reader who is given one stops reading the rest.\n\n' +
    'You are handed every item under the Feature, where each one stands, and the sentence whoever ' +
    'ruled on it wrote. Quote and attribute where a verdict earns it; restate a shortfall as what it ' +
    'means for the Feature ("a bucket turned off still shows results on three screens"), not as the ' +
    'assessor said it to another agent. Where the record cannot answer something, say so — an honest ' +
    '"nobody has looked at these four items" is worth more than a confident sentence about them.\n\n' +
    'This is read on the feature board and nowhere else. It schedules nothing, closes nothing, gates ' +
    'nothing and is posted to no tracker. It is rewritten whenever something under the Feature moves, ' +
    'so write where things are now rather than a history of how they got here.',
  inputSchema: {
    type: 'object',
    properties: {
      standing: {
        type: 'string',
        description:
          'Required. Two or three sentences: where this Feature actually is. What works, what it is ' +
          'waiting on, and the one thing a reader should take away. This is the whole of what the card ' +
          'shows before anything is expanded.',
      },
      usable: {
        type: 'string',
        description:
          'What a person can see or do today, and where — which environment holds it, and what they ' +
          'would look at to judge it for themselves. Omit it where nothing has shipped anywhere: ' +
          '"nothing yet" belongs in `standing`, not in a section invented to fill the shape.',
      },
      blocked: {
        type: 'string',
        description:
          'What is stopping the rest, and what it needs from a person — a decision, an answer, an ' +
          'environment. Say which, because "answer me" and "decide" are different asks. Omit it for a ' +
          'Feature that is simply being worked.',
      },
      remaining: {
        type: 'string',
        description:
          'What is left, item by item where that reads better than a paragraph. Include the items ' +
          'nobody is working — an item no agent can see is not queued behind anything, and a reader ' +
          'who is not told that will assume it is in hand. Omit it where nothing is outstanding.',
      },
    },
    required: ['standing'],
  },
  handler: (args) => {
    const parsed = validateFeatureSummary(args);
    if (!parsed.ok) return toolError(`Feature summary rejected: ${parsed.error}`);
    const result = deps.agents.recordFeatureSummary(agent.id, parsed.input);
    if (!result.ok) return toolError(result.error);
    return ok({
      filed: true,
      feature: result.featureOrigin,
      // Named rather than silent, `retro_submit`'s rule: a section quietly cut at
      // its cap is one whose last paragraph nobody will ever read, and the agent
      // has no other way to find out.
      trimmed: parsed.trimmed,
      note:
        "Recorded. It is drawn on the feature board above this Feature's items. Nothing is posted to " +
        'the tracker, nothing is closed and nothing is scheduled from it — and it will be rewritten ' +
        'the next time something under the Feature moves.',
    });
  },
});
