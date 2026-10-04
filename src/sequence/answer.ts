import { z } from 'zod';
import { absentOr } from '../schemaErrors.js';

// → docs/spec/33-story-sequencing.md

export const SequenceAnswerBody = z.object({
  answer: z.enum(['accepted', 'declined'], {
    error: 'answer must be "accepted" or "declined" — an agent writes "proposed", nobody else',
  }),
  by: z.string(absentOr('by must name who answered')).min(1, 'by must name who answered'),
});

export const NumberParams = z.object({
  number: z.coerce
    .number(absentOr('number must be the Feature’s tracker number'))
    .int('number must be the Feature’s tracker number')
    .positive('number must be the Feature’s tracker number'),
});
