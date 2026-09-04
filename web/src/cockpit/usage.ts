import type { PlaceKey, UiUsageEvent } from '../types.js';
import type { ConsolePanel, ConsoleTab } from './actions.js';
import type { Place } from './place.js';
import { api } from '../api.js';

/**
 * `logUsage` — record one thing a person did, and the only writer of
 * `surface_reach`.
 *
 * Nothing durable records a surface being *reached*: a person opening the pull
 * request page leaves no trace in any table, and if the click does not say so,
 * nothing does. This is that call site, and four properties of it are load-bearing
 * rather than stylistic.
 *
 * **The parameter list is the privacy boundary.** There is nowhere to put a ref,
 * an id, a title or a note, so none can be recorded by a call site in a hurry, and
 * the place is a key from a closed vocabulary rather than a URL. That is what lets
 * the aggregate cross to the pool at all, and it is enforced by this signature
 * rather than by review.
 *
 * **It takes {@link UiUsageEvent}, not `UsageEvent`.** Passing an event a table
 * already holds is a *compile* error, so the double count — two readings of one
 * act, disagreeing quietly — is unreachable rather than a rule somebody has to
 * keep. Nothing here checks it at runtime, deliberately: a runtime check would be
 * a second statement of the split, free to disagree with the registry.
 *
 * **It returns `void` and cannot throw.** A telemetry write must never turn a
 * working control into a broken one, so every failure inside is swallowed *here*
 * and nowhere else — this is the one place in the cockpit where that is the right
 * answer, because the alternative is a navigation that fails because a metric
 * could not be recorded. The server's own failures are recorded server-side
 * through `errors.record`, which is where a fault that matters becomes visible.
 *
 * **It is called for its effect and batched.** One request per navigation against
 * a harness the console already polls every couple of seconds is a self-inflicted
 * load with no reading behind it. Events are coalesced here and flushed on a clock
 * and on unload; a lost flush costs a row and nothing else, which is the only
 * reason coalescing is safe.
 *
 * → `docs/spec/34-usage-metrics.md#the-helper`
 */
export function logUsage(event: UiUsageEvent, at?: PlaceKey): void {
  try {
    const [subject, verb] = event.split('.') as [string, string];
    queue.push({ subject, verb, place: at ?? place, arrival });
    // A queue at the batch cap is flushed rather than trimmed: dropping the oldest
    // would make a busy session read as a quiet one, which is the one direction
    // this reading must not be wrong in.
    if (queue.length >= BATCH_MAX) flush();
    else schedule();
  } catch {
    // Unreachable in practice — the whole body is a push onto an array — and
    // swallowed anyway, because the caller is a click handler on a control that
    // has to keep working whatever happens here.
  }
}

/**
 * Where the cockpit is, as a key, and how it got there — held here rather than
 * passed at every call site.
 *
 * `logUsage('plan.expand')` inside a disclosure has no business knowing which
 * surface it was drawn on, and a call site that had to say would say the wrong
 * thing the day the control moved. The cockpit's place plumbing states it once
 * per navigation instead.
 *
 * The arrival is the *place's*, not the event's: `linked` means the cockpit's own
 * navigation carried the operator here, `direct` means an address did — a typed
 * URL, a reload, a bookmark, a link somebody was sent. It is what tells
 * `never-linked` from `linked-never-visited` server-side.
 */
let place: PlaceKey = 'overview';
let arrival: 'linked' | 'direct' = 'direct';

/** Called by the place plumbing on every move. Not a call site's business. */
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

/** The server's own cap, restated so a flush is never refused for its size. */
const BATCH_MAX = 500;

/**
 * How long a batch is held before it goes.
 *
 * Long enough that a burst of navigation is one request, short enough that an
 * operator who reads a page and closes the tab is covered by the clock rather
 * than by the unload path — which is the flush most likely to be lost.
 */
const FLUSH_MS = 10_000;

let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_MS);
}

/**
 * Send what has accumulated, and forget it either way.
 *
 * **The queue is drained before the request, not after it.** A flush that put the
 * rows back on failure would retry for ever against a harness that is down, and a
 * lost row is explicitly the cost this design accepts.
 */
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

/**
 * The unload flush, registered once at module load.
 *
 * `pagehide` rather than `beforeunload`: the latter does not fire on mobile or on
 * a back/forward-cache restore, and this is the flush that covers the operator who
 * read a page and closed the tab. Guarded for the same reason `readToken` is —
 * these modules are imported by the tests under node, where there is no `window`.
 */
if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);

/**
 * The surface a place is on, and the `view` event reaching it emits.
 *
 * One mapping rather than a `logUsage('goal.view')` at every navigation call
 * site, and that is the same argument `collectActions` makes one layer down: a
 * `view` written where a nav button happens to live counts only while *that*
 * button is the way in, and the day a second control opens the goal page the
 * count silently halves. The place is the one thing every way in agrees about, so
 * the reading is taken from the place.
 *
 * The ladder is the cockpit's own — an overlay outranks the pull request page,
 * which outranks the goal page, which outranks the tab — so the key is what an
 * operator would say they were looking at.
 *
 * **Not every place has a subject.** The Up next queue, the world signals, the
 * work record and the errors panel are surfaces the registry has no subject for,
 * because a subject is *a thing the product offers to act on* and none of those
 * is. They still carry a place key, so a `filter` or an `expand` performed there
 * is attributed to the surface it happened on.
 */
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

/**
 * A `Record` over the panel union and the tab union, not a lookup with a default:
 * a panel added without a place key is a **compile** error rather than a surface
 * whose every event files under whatever the operator was looking at before.
 */
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
