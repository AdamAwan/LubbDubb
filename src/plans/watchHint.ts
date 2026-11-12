import { z } from 'zod';
import { strictObject } from '../schemaErrors.js';
import type { WatchHint } from '../types.js';

// → docs/spec/29-post-deploy-watch.md#the-planner-at-plan-time-writes-a-hint

const MAX_INTENTS = 12;

const WatchIntentSchema = strictObject(
  {
    kind: z.enum(['signal', 'measure']),
    source: z.string().trim().min(1),
    says: z.string().trim().min(1),
    why: z.string().trim().min(1).optional(),
  },
  'an intent declares only kind/source/says/why — it carries no query, threshold or presence',
);

export const WatchHintSchema = strictObject(
  {
    intents: z.array(WatchIntentSchema).min(1).max(MAX_INTENTS).optional(),
    none: z.string().trim().min(1).optional(),
  },
  'a watch hint is either "intents" or "none"',
).superRefine((hint, ctx) => {
  const intents = hint.intents !== undefined;
  const none = hint.none !== undefined;
  if (intents && none)
    ctx.addIssue({
      code: 'custom',
      message: 'a watch hint is "intents" or "none", never both — say what worked would look like, or why nothing can',
    });
  if (!intents && !none)
    ctx.addIssue({
      code: 'custom',
      message: 'a watch hint needs "intents", or "none" with the reason there is nothing running to watch',
    });
});

type WatchHintInput = z.infer<typeof WatchHintSchema>;

export const WATCH_HINT_MISSING =
  'watchHint: required — some environment here declares a watch, so say what "worked" would look like once ' +
  'this is running ("intents"), or why nothing can be watched ("none" with the reason)';

export function watchHintOf(input: WatchHintInput | undefined): WatchHint | null {
  if (input === undefined) return null;
  if (input.intents !== undefined)
    return {
      intents: input.intents.map((i) => ({ kind: i.kind, source: i.source, says: i.says, why: i.why ?? null })),
    };
  return input.none === undefined ? null : { none: input.none };
}

export function watchHintDetail(hint: WatchHint): string {
  if ('none' in hint) return `Nothing to watch: ${hint.none}`;
  return hint.intents
    .map((i) => `- **${i.kind}** · ${i.source} — ${i.says}${i.why === null ? '' : ` (${i.why})`}`)
    .join('\n');
}

export function storedWatchHint(raw: string | null | undefined): WatchHint | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value === 'object' && value !== null && Array.isArray((value as { intents?: unknown }).intents)) {
    const intents = (value as { intents: unknown[] }).intents.map((i) =>
      typeof i === 'object' && i !== null && (i as { why?: unknown }).why === null ? { ...i, why: undefined } : i,
    );
    value = { ...value, intents };
  }
  const parsed = WatchHintSchema.safeParse(value);
  return parsed.success ? watchHintOf(parsed.data) : null;
}
