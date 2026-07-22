import { z } from 'zod';
import type { DeskBriefing } from '../../types.js';

/**
 * The validation boundary for the Claude-bridged desk briefing. The bridge is an
 * untrusted network client, so its POST body is parsed against this schema before
 * anything touches the store — same convention as the dispatcher's action schemas.
 * The inferred type is asserted to match the domain {@link DeskBriefing} so the two
 * can't drift.
 */

const relevance = z.enum(['mine', 'area']);

const meetingSchema = z.object({
  id: z.string().min(1),
  subject: z.string(),
  start: z.string().min(1),
  end: z.string().min(1),
  isOnline: z.boolean(),
  joinUrl: z.string().optional(),
  webLink: z.string().optional(),
  organizer: z.string().optional(),
  attendeeCount: z.number().int().nonnegative().optional(),
  responseRequested: z.boolean().optional(),
  showAs: z.enum(['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown']).optional(),
  relevance,
});

const mailSchema = z.object({
  id: z.string().min(1),
  subject: z.string(),
  from: z.string(),
  receivedAt: z.string().min(1),
  isUnread: z.boolean(),
  isFlagged: z.boolean(),
  webLink: z.string().optional(),
  preview: z.string().max(200).optional(),
  relevance,
  area: z.string().optional(),
});

const pingSchema = z.object({
  id: z.string().min(1),
  source: z.literal('teams'),
  chatOrChannel: z.string(),
  from: z.string(),
  sentAt: z.string().min(1),
  preview: z.string().optional(),
  webLink: z.string().optional(),
  relevance,
});

export const DeskBriefingSchema = z.object({
  generatedAt: z.string().min(1),
  windowStart: z.string().min(1),
  windowEnd: z.string().min(1),
  owner: z.object({ email: z.string().min(1), name: z.string().optional() }),
  areas: z.array(z.string()),
  meetings: z.array(meetingSchema),
  mail: z.array(mailSchema),
  pings: z.array(pingSchema),
});

// Compile-time guarantee the schema and the domain type stay in lock-step.
type _Assert =
  DeskBriefing extends z.infer<typeof DeskBriefingSchema>
    ? z.infer<typeof DeskBriefingSchema> extends DeskBriefing
      ? true
      : never
    : never;
const _assert: _Assert = true;
void _assert;
