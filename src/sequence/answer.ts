import { z } from 'zod';

/**
 * The operator's answer to a proposed order — the schema, beside the rule rather
 * than in the route, `ShortfallBody`'s placement ([16](../../docs/spec/16-http-api.md#shape)).
 *
 * **Two answers, not three.** `proposed` is what an agent writes and nothing else
 * may; a route that accepted it would let the cockpit put a Feature back to
 * unanswered, which is not a thing a person means. `declined` is a real answer and
 * is stored: "run them all" is what somebody says about a Feature whose stories
 * genuinely are independent, and a proposal that came back on the next pulse would
 * make the fleet argue with them once a Feature until they gave in.
 * → `docs/spec/33-story-sequencing.md#declining`
 */
export const SequenceAnswerBody = z.object({
  answer: z.enum(['accepted', 'declined'], {
    errorMap: () => ({ message: 'answer must be "accepted" or "declined" — an agent writes "proposed", nobody else' }),
  }),
  /** Who answered, as it is drawn back on the card. */
  by: z.string({ required_error: 'by must name who answered' }).min(1, 'by must name who answered'),
});

/** A route addressed by a tracker number, the shape `/api/features/:number/…` takes. */
export const NumberParams = z.object({
  number: z.coerce
    .number({ required_error: 'number must be the Feature’s tracker number' })
    .int('number must be the Feature’s tracker number')
    .positive('number must be the Feature’s tracker number'),
});
