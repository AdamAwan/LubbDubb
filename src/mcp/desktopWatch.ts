import { z } from 'zod';
import { toolSchema } from './schema.js';
import { toolError, toolJson } from './protocol.js';
import type { DesktopToolFactory } from './desktopContext.js';

// → docs/spec/29-post-deploy-watch.md#a-source-only-the-operator-can-run

const watchReading: DesktopToolFactory = (deps) => ({
  description:
    'The post-deploy watch readings only a person can take — checks on a telemetry source the harness has no ' +
    'credential for, typically a SQL database — and recording one. Called with nothing, it lists the open asks, ' +
    'each with its query ready to run as it stands, the period already filled in. Run that query here, with the ' +
    "operator's own client and credential, and call again with the ask's id and what it returned: the rows as " +
    "JSON, or a measure's one number, and a signal's presence rows. The harness records it as read by the " +
    'operator, exactly as the cockpit’s paste box does.',
  inputSchema: toolSchema(
    z.object({
      ask: z
        .string()
        .describe("An ask's `taskId` from the list, to record its answer. Left out, the open asks are listed.")
        .optional(),
      answer: z
        .string()
        .describe(
          'What the query returned: the rows as a JSON array, or — for a measure — its one number. Exactly what came ' +
            'back; a reading nobody took is the one thing this cannot tell apart from a real one.',
        )
        .optional(),
      presence: z
        .string()
        .describe("A signal's presence query's rows, as a JSON array. Required for a signal, left out for a measure.")
        .optional(),
    }),
  ),
  handler: (args) => {
    const asks = deps.watchAsks();
    if (typeof args.ask !== 'string') {
      const open = asks.open();
      return toolJson({ asks: open, next: open.length === 0 ? NOTHING_OPEN : LIST_NEXT });
    }
    if (typeof args.answer !== 'string')
      return toolError('Give "answer" with "ask": what the query returned, as rows of JSON or one number.');
    const answered = asks.answer(args.ask, {
      answer: args.answer,
      presence: typeof args.presence === 'string' ? args.presence : null,
    });
    if (!answered.ok) return toolError(answered.error);
    deps.changed({ type: 'world:changed' });
    return toolJson({ recorded: answered.recorded, ...answered.ask, readBy: 'operator' });
  },
});

const LIST_NEXT =
  'Run each query as it stands — the period is already in it — against the source it names, with whatever ' +
  "client and login the operator uses for it. Then call watch_reading with the ask's taskId and what came back. " +
  'If you cannot run it, say so and leave it: an unanswered closing ask reads unknown at its closesAt, ' +
  'which is the honest answer, and a number you did not read is not.';

const NOTHING_OPEN =
  'Nothing is asked of a person right now: every reading the watch needs, the harness can take itself.';

export const DESKTOP_WATCH_TOOLS = { watch_reading: watchReading };
