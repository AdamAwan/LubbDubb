import { z } from 'zod';

// → docs/spec/33-story-sequencing.md

export const SequenceAnswerBody = z.object({
  answer: z.enum(['accepted', 'declined'], {
    error: 'answer must be "accepted" or "declined" — an agent writes "proposed", nobody else',
  }),
  by: z
    .string({ error: (issue) => (issue.input === undefined ? 'by must name who answered' : undefined) })
    .min(1, 'by must name who answered'),
});

export const NumberParams = z.object({
  number: z.coerce
    .number({
      error: (issue) => (issue.input === undefined ? 'number must be the Feature’s tracker number' : undefined),
    })
    .int('number must be the Feature’s tracker number')
    .positive('number must be the Feature’s tracker number'),
});
