import type { PlaceKey, UiUsageEvent } from '../types.js';
import type { ConsolePanel, ConsoleTab } from './actions.js';
import type { Place } from './place.js';
import { api } from '../api.js';

// → docs/spec/17-cockpit.md#the-address-bar

export function logUsage(event: UiUsageEvent, at?: PlaceKey): void {
  try {
    const [subject, verb] = event.split('.') as [string, string];
    queue.push({ subject, verb, place: at ?? place, arrival });
    if (queue.length >= BATCH_MAX) flush();
    else schedule();
  } catch {
    // Unreachable in practice — the whole body is a push onto an array — and
    // swallowed anyway, because the caller is a click handler on a control that
    // has to keep working whatever happens here.
  }
}

let place: PlaceKey = 'overview';
let arrival: 'linked' | 'direct' = 'direct';

export function notePlace(next: PlaceKey, how: 'linked' | 'direct'): void {
  place = next;
  arrival = how;
}

interface Pending {
  subject: string;
  verb: string;
  place: PlaceKey;
  arrival: 'linked' | 'direct';
}

const queue: Pending[] = [];

const BATCH_MAX = 500;

const FLUSH_MS = 10_000;

let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_MS);
}

function flush(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const events = queue.splice(0, queue.length);
  try {
    void api.logUsageEvents(events);
  } catch {
    // Fire-and-forget in full: a failure to even start the request is a lost row,
    // and a lost row is explicitly the cost this design accepts.
  }
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);

export function placeReach(place: Place): { key: PlaceKey; view: UiUsageEvent | null } {
  if (place.hatch !== null) return { key: 'hatch', view: 'pet.view' };
  if (place.scratchpad !== null) return { key: 'scratchpad', view: 'scratchpad.view' };
  if (place.reviewPack !== null) return { key: 'review-pack', view: 'review-pack.view' };
  if (place.plan !== null) return { key: 'plan', view: 'plan.view' };
  if (place.retro !== null) return { key: 'retro', view: 'retro.view' };
  if (place.agent !== null) return { key: 'agent', view: 'agent.view' };
  if (place.obstacle !== null) return { key: 'obstacle', view: 'obstacle.view' };
  const panel = place.panel;
  if (panel !== null && typeof panel === 'object') return { key: 'ask', view: 'escalation.view' };
  if (panel !== null) {
    const reach = PANEL_REACH[panel];
    if (reach !== undefined) return reach;
  }
  if (place.pr !== null) return { key: 'pr', view: 'pr.view' };
  if (place.goal !== null) return { key: 'goal', view: 'goal.view' };
  return TAB_REACH[place.tab];
}

const PANEL_REACH: Record<
  Exclude<ConsolePanel, null | { ask: string }>,
  { key: PlaceKey; view: UiUsageEvent | null }
> = {
  faults: { key: 'faults', view: null },
  launch: { key: 'launch', view: 'job.view' },
  build: { key: 'build', view: 'upgrade.view' },
  pets: { key: 'pets', view: 'pet.view' },
  localRun: { key: 'local-run', view: 'local-run.view' },
  setup: { key: 'setup', view: 'config.view' },
  record: { key: 'record', view: null },
  upnext: { key: 'upnext', view: null },
  signals: { key: 'signals', view: null },
  environments: { key: 'environments', view: null },
};

const TAB_REACH: Record<ConsoleTab, { key: PlaceKey; view: UiUsageEvent | null }> = {
  overview: { key: 'overview', view: null },
  tickets: { key: 'tickets', view: 'ticket.view' },
  obstacles: { key: 'obstacles', view: 'obstacle.view' },
  features: { key: 'features', view: 'feature.view' },
  insights: { key: 'insights', view: 'insights.view' },
  pets: { key: 'pets', view: 'pet.view' },
  config: { key: 'config', view: 'config.view' },
};
