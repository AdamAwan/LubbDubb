import type { SurfaceReach } from '../types.js';
import { SUBJECT_LABEL, USAGE_SUBJECTS, VERB_LABEL, type UsageSubject, type UsageVerb } from '../usage/events.js';
import { inWindow, type ResolvedWindow } from './insightsWindow.js';

// → docs/spec/18-observability.md

export type SurfaceVerdict =
  | 'console-dark'
  | 'never-linked'
  | 'linked-never-visited'
  | 'visited-never-operated'
  | 'operated';

export interface SurfaceRow {
  subject: UsageSubject;
  label: string;
  verdict: SurfaceVerdict;
  verdictLabel: string;
  verdictBlurb: string;
  views: number;
  operations: number;
  linkedViews: number;
  byVerb: { verb: UsageVerb; label: string; count: number }[];
}

export interface SurfaceReachInsights {
  rows: SurfaceRow[];
  total: number;
  places: number;
}

interface SurfaceReachRead {
  rows: readonly SurfaceReach[];
  everLinked: ReadonlySet<string>;
  window: ResolvedWindow;
}

export function buildSurfaceReach({ rows, everLinked, window }: SurfaceReachRead): SurfaceReachInsights {
  const inside = rows.filter((r) => inWindow(window, Date.parse(r.at)));
  const dark = inside.length === 0;
  const places = new Set(inside.map((r) => r.place)).size;
  return {
    rows: USAGE_SUBJECTS.map((subject) => row(subject, inside, everLinked, dark)),
    total: inside.length,
    places,
  };
}

function row(
  subject: UsageSubject,
  inside: readonly SurfaceReach[],
  everLinked: ReadonlySet<string>,
  dark: boolean,
): SurfaceRow {
  const mine = inside.filter((r) => r.subject === subject);
  const views = mine.filter((r) => r.verb === 'view');
  const operations = mine.length - views.length;
  const linkedViews = views.filter((r) => r.arrival === 'linked').length;
  const counts = new Map<UsageVerb, number>();
  for (const r of mine) if (r.verb !== 'view') counts.set(r.verb, (counts.get(r.verb) ?? 0) + 1);
  const reading = verdict({ dark, views: views.length, operations, linked: everLinked.has(subject) });
  return {
    subject,
    label: SUBJECT_LABEL[subject],
    verdict: reading,
    verdictLabel: SURFACE_VERDICT_COPY[reading].label,
    verdictBlurb: SURFACE_VERDICT_COPY[reading].blurb,
    views: views.length,
    operations,
    linkedViews,
    byVerb: [...counts].map(([verb, count]) => ({ verb, label: VERB_LABEL[verb], count })),
  };
}

function verdict(ev: { dark: boolean; views: number; operations: number; linked: boolean }): SurfaceVerdict {
  if (ev.dark) return 'console-dark';
  if (ev.operations > 0) return 'operated';
  if (ev.views > 0) return 'visited-never-operated';
  return ev.linked ? 'linked-never-visited' : 'never-linked';
}

const SURFACE_VERDICT_COPY: Record<SurfaceVerdict, { label: string; blurb: string }> = {
  'console-dark': {
    label: 'Console dark',
    blurb: 'Nothing was reached at all in this window, so no reading of this surface in it means anything',
  },
  'never-linked': {
    label: 'Never linked',
    blurb: 'Nothing in the cockpit has ever carried anybody here — it is reachable only by address',
  },
  'linked-never-visited': {
    label: 'Linked, never visited',
    blurb: 'A link to it exists and has been taken before; in this window nobody went',
  },
  'visited-never-operated': {
    label: 'Visited, never operated',
    blurb: 'Reached, and nothing was done there — the one case where the silence is the surface’s own',
  },
  operated: { label: 'Operated', blurb: 'Somebody did something here' },
};
