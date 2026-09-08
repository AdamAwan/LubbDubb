import type { PrReplySent, WorldEvent, WorldEventKind } from './types.js';
import {
  bucketIndexIn,
  inWindow,
  timelineSpan,
  windowView,
  type InsightsWindowView,
  type ResolvedWindow,
} from './insightsWindow.js';

// → docs/spec/18-observability.md

const TOP_ROWS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ThroughputMeasure =
  | 'issue-opened'
  | 'issue-closed'
  | 'pr-opened'
  | 'pr-merged'
  | 'pr-closed'
  | 'pr-approved'
  | 'review-received'
  | 'reply-sent';

export const THROUGHPUT_EVENT_KINDS: readonly WorldEventKind[] = [
  'issue_opened',
  'issue_closed',
  'pr_opened',
  'pr_merged',
  'pr_closed',
  'pr_approved',
  'pr_comment',
];

const MEASURE_OF_KIND: Partial<Record<WorldEventKind, ThroughputMeasure>> = {
  issue_opened: 'issue-opened',
  issue_closed: 'issue-closed',
  pr_opened: 'pr-opened',
  pr_merged: 'pr-merged',
  pr_closed: 'pr-closed',
  pr_approved: 'pr-approved',
  pr_comment: 'review-received',
};

const MEASURE_ORDER: readonly ThroughputMeasure[] = [
  'issue-opened',
  'pr-opened',
  'pr-merged',
  'pr-closed',
  'pr-approved',
  'review-received',
  'reply-sent',
  'issue-closed',
];

const MEASURE_COPY: Record<ThroughputMeasure, { label: string; blurb: string; ours: boolean }> = {
  'issue-opened': {
    label: 'Issues opened',
    blurb: 'Entered the watched set — filed by the fleet or by a person',
    ours: false,
  },
  'issue-closed': { label: 'Issues closed', blurb: 'Left the watched set closed', ours: false },
  'pr-opened': { label: 'PRs opened', blurb: 'First seen open by the world model', ours: false },
  'pr-merged': { label: 'PRs merged', blurb: 'Landed on their base branch', ours: false },
  'pr-closed': { label: 'PRs abandoned', blurb: 'Closed without merging', ours: false },
  'pr-approved': { label: 'Approvals', blurb: 'A pull request first read as approved', ours: false },
  'review-received': { label: 'Review comments', blurb: 'Unresolved comments the world model first saw', ours: false },
  'reply-sent': {
    label: 'Replies sent',
    blurb: 'Review replies that left through the sink — the fleet’s own',
    ours: true,
  },
};

export interface ThroughputTotal {
  measure: ThroughputMeasure;
  label: string;
  blurb: string;
  ours: boolean;
  count: number;
  perDay: number | null;
}

export interface ThroughputSubject {
  ref: string;
  prNumber: number | null;
  opened: boolean;
  merged: boolean;
  closed: boolean;
  commentsReceived: number;
  repliesSent: number;
  toMergeMs: number | null;
  lastAt: string;
}

export interface ThroughputBucket {
  startsAt: string;
  opened: number;
  merged: number;
  closed: number;
  comments: number;
  replies: number;
}

export interface ThroughputLanding {
  opened: number;
  settled: number;
  merged: number;
  abandoned: number;
  mergeRate: number | null;
  paired: number;
  medianToMergeMs: number | null;
  slowestToMergeMs: number | null;
}

export interface ThroughputConversation {
  received: number;
  replied: number;
  replyRate: number | null;
  prsCommented: number;
}

export interface ThroughputInsights {
  generatedAt: string;
  window: InsightsWindowView;
  spanMs: number | null;
  totals: ThroughputTotal[];
  landing: ThroughputLanding;
  conversation: ThroughputConversation;
  busiest: ThroughputSubject[];
  prsTouched: number;
  timeline: { bucketMs: number; startsAt: string; buckets: ThroughputBucket[] };
}

interface ThroughputInput {
  events: readonly WorldEvent[];
  replies: readonly PrReplySent[];
  window: ResolvedWindow;
  now: number;
}

function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function prNumberOf(ref: string): number | null {
  const found = /^pr:(\d+)$/.exec(ref)?.[1];
  return found === undefined ? null : Number(found);
}

export function buildThroughputInsights(input: ThroughputInput): ThroughputInsights {
  const { now, window } = input;
  const events = input.events.filter((event) => inWindow(window, Date.parse(event.createdAt)));
  const replies = input.replies.filter((reply) => inWindow(window, Date.parse(reply.sentAt)));
  const earliest = [...events.map((e) => Date.parse(e.createdAt)), ...replies.map((r) => Date.parse(r.sentAt))].reduce<
    number | null
  >((oldest, at) => (Number.isNaN(at) ? oldest : oldest === null || at < oldest ? at : oldest), null);
  const span = timelineSpan(window, earliest);

  const counts = new Map<ThroughputMeasure, number>();
  const subjects = new Map<string, ThroughputSubject>();
  const openedAt = new Map<string, number>();
  const toMerge: number[] = [];
  const buckets: ThroughputBucket[] = Array.from({ length: span.buckets }, (_, i) => ({
    startsAt: new Date(span.startMs + i * span.bucketMs).toISOString(),
    opened: 0,
    merged: 0,
    closed: 0,
    comments: 0,
    replies: 0,
  }));

  const bump = (measure: ThroughputMeasure): void => {
    counts.set(measure, (counts.get(measure) ?? 0) + 1);
  };
  const subjectOf = (ref: string, at: string): ThroughputSubject => {
    const found = subjects.get(ref) ?? {
      ref,
      prNumber: prNumberOf(ref),
      opened: false,
      merged: false,
      closed: false,
      commentsReceived: 0,
      repliesSent: 0,
      toMergeMs: null,
      lastAt: at,
    };
    if (at >= found.lastAt) found.lastAt = at;
    subjects.set(ref, found);
    return found;
  };

  for (const event of events) {
    const measure = MEASURE_OF_KIND[event.kind];
    if (measure === undefined) continue;
    const at = Date.parse(event.createdAt);
    if (Number.isNaN(at)) continue;
    bump(measure);

    const bucket = buckets[bucketIndexIn(span, at) ?? -1];
    if (bucket) {
      if (measure === 'pr-opened') bucket.opened += 1;
      else if (measure === 'pr-merged') bucket.merged += 1;
      else if (measure === 'pr-closed') bucket.closed += 1;
      else if (measure === 'review-received') bucket.comments += 1;
    }

    if (event.ref === null || prNumberOf(event.ref) === null) continue;
    const subject = subjectOf(event.ref, event.createdAt);
    if (measure === 'pr-opened') {
      subject.opened = true;
      if (!openedAt.has(event.ref)) openedAt.set(event.ref, at);
    } else if (measure === 'review-received') subject.commentsReceived += 1;
    else if (measure === 'pr-merged' || measure === 'pr-closed') {
      if (measure === 'pr-merged') subject.merged = true;
      else subject.closed = true;
      const opened = openedAt.get(event.ref);
      if (opened !== undefined && measure === 'pr-merged') {
        subject.toMergeMs = at - opened;
        toMerge.push(at - opened);
      }
      openedAt.delete(event.ref);
    }
  }

  for (const reply of replies) {
    const at = Date.parse(reply.sentAt);
    if (Number.isNaN(at)) continue;
    bump('reply-sent');
    const bucket = buckets[bucketIndexIn(span, at) ?? -1];
    if (bucket) bucket.replies += 1;
    subjectOf(`pr:${reply.prNumber}`, reply.sentAt).repliesSent += 1;
  }

  const count = (measure: ThroughputMeasure): number => counts.get(measure) ?? 0;
  const spanMs = window.spanMs ?? (earliest === null ? null : Math.max(0, now - earliest));
  const merged = count('pr-merged');
  const abandoned = count('pr-closed');
  const received = count('review-received');
  const replied = count('reply-sent');
  const ranked = [...subjects.values()].sort(
    (a, b) =>
      b.commentsReceived + b.repliesSent - (a.commentsReceived + a.repliesSent) ||
      (b.lastAt > a.lastAt ? 1 : b.lastAt < a.lastAt ? -1 : 0),
  );

  return {
    generatedAt: new Date(now).toISOString(),
    window: windowView(window, span),
    spanMs,
    totals: MEASURE_ORDER.map((measure) => ({
      measure,
      ...MEASURE_COPY[measure],
      count: count(measure),
      perDay: spanMs === null || spanMs <= 0 ? null : (count(measure) * DAY_MS) / spanMs,
    })),
    landing: {
      opened: count('pr-opened'),
      settled: merged + abandoned,
      merged,
      abandoned,
      mergeRate: merged + abandoned > 0 ? merged / (merged + abandoned) : null,
      paired: toMerge.length,
      medianToMergeMs: median(toMerge),
      slowestToMergeMs: toMerge.length > 0 ? Math.max(...toMerge) : null,
    },
    conversation: {
      received,
      replied,
      replyRate: received > 0 ? replied / received : null,
      prsCommented: ranked.filter((s) => s.commentsReceived > 0).length,
    },
    busiest: ranked.filter((s) => s.commentsReceived + s.repliesSent > 0).slice(0, TOP_ROWS),
    prsTouched: subjects.size,
    timeline: { bucketMs: span.bucketMs, startsAt: new Date(span.startMs).toISOString(), buckets },
  };
}
