import type { ConfigTab, ConsolePanel, ConsoleTab } from './actions.js';
import type {
  TicketOrder,
  TicketStateFacet,
  TicketStateFilter,
  TicketTrackingFilter,
  TicketWatchFilter,
} from '../types.js';

/**
 * Where the cockpit is — every piece of state that answers *what am I looking
 * at*, and nothing that answers *what is true*. The snapshot is the harness's;
 * this is the operator's, and it is the whole of what the address bar carries.
 *
 * One record rather than the ten `useState`s it replaced, because the back
 * button is a single history of *places*: a drawer opened over a goal page on
 * the tickets tab is one place, and stepping back out of it has to restore all
 * three at once. Ten independent pieces of state can express that; ten
 * independent history entries cannot.
 */
export interface Place {
  /** Where the nav is. A selected goal outranks it — see {@link ConsoleTab}. */
  tab: ConsoleTab;
  /** The goal whose page is open, as `issue:<n>`, or null for the tab. */
  goal: string | null;
  /** Which full-surface panel is in front, or null. */
  panel: ConsolePanel;
  /** The agent whose drawer is open. */
  agent: string | null;
  /** The plan whose sheet is open. */
  plan: string | null;
  /** The goal whose retrospective is open, as an `issue:<n>` ref. */
  retro: string | null;
  /**
   * The egg whose shell is coming off, by pet id.
   *
   * A place rather than a `useState` for the reason every field here is one: the
   * back button steps out of the ceremony, and a link to it opens on the creature
   * it named. It survives a reload landing on an already-opened pet, which is the
   * ordinary case — the shell comes off the moment the modal mounts, so a refresh
   * mid-wobble is a reveal rather than a second roll. Nothing is ever re-decided
   * by arriving here. → `docs/spec/22-pets.md#the-egg`
   */
  hatch: string | null;
  /** The goal whose notepad is open, as an `issue:<n>` ref. */
  scratchpad: string | null;
  /** Which section of the config page is in front. */
  configTab: ConfigTab;
  /** The config group the page is showing, or null for the first one. */
  configGroup: string | null;
  spend: boolean;
  reliability: boolean;
  /**
   * The tickets tab's feature headings that are **collapsed**, by issue number.
   *
   * Collapsed rather than expanded, so the default — every feature open — is the
   * empty list and a bare URL. It is a place rather than a `useState` for the
   * usual reason: folding three features away and stepping back into the tab has
   * to restore the same three, and a reload of a shared link has to show what the
   * sender was looking at.
   */
  collapsed: number[];
  /**
   * How the Tickets tab is narrowed, arranged and ordered (issues #329, #351).
   *
   * On `Place` rather than in the panel because the tab exists to be *asked* —
   * "all unclosed watched items" is a question someone sends a link to, and a
   * filter held in a `useState` compiles, renders and works right up until the
   * back button steps over it or a reload drops it. The scroll offset deliberately
   * is not here: a URL restoring an offset into a list that has since grown lands
   * somewhere else entirely, so Back returns to the filter and the list re-reads
   * its first page.
   */
  ticketWatch: TicketWatchFilter;
  /**
   * What the harness is doing about an item, which is not what the tracker calls
   * it. Defaults to `live` — the tab is the surface work happens on now, and
   * opening it on a thousand frozen rows would bury the ones that are still work.
   */
  ticketTracking: TicketTrackingFilter;
  /** The tracker's own word, or `any`. Free-form: the vocabulary is the tracker's. */
  ticketState: TicketStateFilter;
  /** A feature number, `none` for the orphans, or null for every feature. */
  ticketFeature: number | 'none' | null;
  /** Features as headings, or one flat list with a feature column. */
  ticketGroup: 'feature' | 'flat';
  ticketOrder: TicketOrder;
}

/** The cockpit with nothing open: the overview, which is what a bare URL means. */
export const NOWHERE: Place = {
  tab: 'overview',
  goal: null,
  panel: null,
  agent: null,
  plan: null,
  retro: null,
  hatch: null,
  scratchpad: null,
  configTab: 'values',
  configGroup: null,
  spend: false,
  reliability: false,
  collapsed: [],
  ticketWatch: 'any',
  ticketTracking: 'live',
  ticketState: 'any',
  ticketFeature: null,
  ticketGroup: 'feature',
  ticketOrder: 'added',
};

const TABS: readonly ConsoleTab[] = ['overview', 'work', 'tickets', 'pets', 'config'];
const CONFIG_TABS: readonly ConfigTab[] = ['values', 'raw', 'ci', 'prompts', 'mcp', 'notifications', 'theme'];
/**
 * Tabs that no longer exist, and where they went.
 *
 * The backlog was folded into the tickets tab, which is a strict superset of it —
 * and an unknown tab resolves to the overview, so without this every bookmark and
 * shared link to `?tab=backlog` would land somewhere else with nothing saying so.
 * An alias is one entry; a stranded link is a bug report.
 */
const TAB_ALIASES: Readonly<Record<string, ConsoleTab>> = { backlog: 'tickets' };
const TICKET_WATCH: readonly TicketWatchFilter[] = ['any', 'watched', 'unwatched'];
const TICKET_TRACKING: readonly TicketTrackingFilter[] = ['any', 'live', 'frozen'];
const TICKET_GROUP = ['feature', 'flat'] as const;
const TICKET_ORDER: readonly TicketOrder[] = ['added', 'changed', 'cost'];
// Every member of `ConsolePanel` bar the ask, which carries its own parameter. A
// panel missing from here is not merely unshareable: the place round-trips through
// the query string, so an unlisted name is parsed straight back to null and the
// panel will not open at all.
/**
 * Every panel name the address bar round-trips, as a `Record` over the union
 * rather than a hand-written list.
 *
 * A list compiles perfectly well while missing a member, and what that costs is
 * invisible: the panel opens on a click and is simply *not there* after a reload,
 * because `readPlace` did not recognise its own name and fell through to null. A
 * `Record` over `ConsolePanel` makes the omission a compile error instead — the
 * same shape `PANEL_TITLE` in `ConsoleRoot.tsx` already uses, which is what caught
 * the last panel that forgot one of these.
 */
const PANEL_NAMES: Record<Exclude<ConsolePanel, null | { ask: string }>, true> = {
  findings: true,
  lessons: true,
  faults: true,
  output: true,
  launch: true,
  build: true,
  pets: true,
  localRun: true,
  setup: true,
};

const PANELS = Object.keys(PANEL_NAMES) as Exclude<ConsolePanel, null | { ask: string }>[];

/** A parameter's value, with an empty one read as absent — `?goal=` names nothing. */
function param(query: URLSearchParams, key: string): string | null {
  const value = query.get(key);
  return value === null || value === '' ? null : value;
}

/**
 * Read a place out of a query string.
 *
 * **Every value is validated back into its type rather than cast**, because this
 * is the one input to the cockpit an operator can type: a hand-edited `?tab=`,
 * a URL from a version that had a fourth tab, a link someone truncated. An
 * unrecognised tab or panel is not an error worth a screen — it is a place that
 * does not exist, and the answer to that is the overview.
 */
export function readPlace(search: string): Place {
  const query = new URLSearchParams(search);
  const tab = param(query, 'tab');
  const panel = param(query, 'panel');
  const ask = param(query, 'ask');
  return {
    // `?settings=1` opened the modal this page replaced, so it is honoured as a
    // way in for `?tab=backlog`'s reason: a bookmark that lands somewhere else
    // with nothing saying so is a bug report.
    tab: query.has('settings')
      ? 'config'
      : (TABS.find((t) => t === tab) ?? (tab !== null ? TAB_ALIASES[tab] : undefined) ?? 'overview'),
    goal: param(query, 'goal'),
    // The ask panel carries its row, so it is its own parameter rather than a
    // prefix on `panel` — an id is opaque and free to contain whatever the
    // harness minted, including the separator a prefix would have to split on.
    panel: ask !== null ? { ask } : (PANELS.find((p) => p === panel) ?? null),
    agent: param(query, 'agent'),
    plan: param(query, 'plan'),
    retro: param(query, 'retro'),
    hatch: param(query, 'hatch'),
    scratchpad: param(query, 'pad'),
    configTab: CONFIG_TABS.find((t) => t === param(query, 'section')) ?? 'values',
    // `keys`, not `group`: the tickets tab already owns `?group=` (its feature
    // heading mode), and two places reading one parameter is a place that opens
    // showing whatever the other one was set to.
    configGroup: param(query, 'keys'),
    spend: query.has('spend'),
    reliability: query.has('reliability'),
    collapsed: readNumbers(param(query, 'collapsed')),
    // Validated back into their types like every other parameter here, and for
    // the same reason: these are the ones an operator is most likely to hand-edit,
    // since the whole tab is a question spelled in the address bar.
    ticketWatch: TICKET_WATCH.find((w) => w === param(query, 'watch')) ?? 'any',
    ...readTracking(param(query, 'tracking'), param(query, 'state')),
    ticketFeature: readFeature(param(query, 'feature')),
    ticketGroup: TICKET_GROUP.find((g) => g === param(query, 'group')) ?? 'feature',
    ticketOrder: TICKET_ORDER.find((o) => o === param(query, 'order')) ?? 'added',
  };
}

/**
 * The two coarse axes, and the one alias between them — the cockpit's half of the
 * route's `coarseAxes`, and it has to stay its half.
 *
 * `state` used to be `open` / `closed` and is now the tracker's own word, with the
 * harness's reading moved to `tracking`. Reading those two literals as the old axis
 * is what keeps every saved link working; the alternative is a filter that quietly
 * matches nothing. No tracker spells a state that way — Azure capitalises, GitHub
 * has none at all — so the alias cannot swallow a real one.
 *
 * The state is otherwise **not validated against a list**, unlike every other
 * parameter here, because the list is the tracker's and this file cannot know it. A
 * state no item carries narrows to an empty list, which is a filter that found
 * nothing rather than a place that does not exist.
 */
function readTracking(
  tracking: string | null,
  state: string | null,
): { ticketTracking: TicketTrackingFilter; ticketState: TicketStateFilter } {
  if (state === 'open') return { ticketTracking: 'live', ticketState: 'any' };
  if (state === 'closed') return { ticketTracking: 'frozen', ticketState: 'any' };
  return {
    ticketTracking: TICKET_TRACKING.find((t) => t === tracking) ?? 'live',
    ticketState: state ?? 'any',
  };
}

/**
 * Where picking a state chip lands — the state itself, and the tracking axis it
 * has to be reachable under.
 *
 * A closing state is on frozen rows by definition, so under the tab's default
 * `live` narrowing a pick of `Closed` would return an empty list while the chip
 * that was just clicked counted sixty-eight. Widening is the only reading of that
 * click that is not a lie: the reader asked for the closed items, and the axis
 * they are behind is not one anything told them about. **Only ever widened, and
 * only where the two axes actually conflict** — a state with live rows narrows
 * exactly as it always did, and nothing here ever makes the list smaller than the
 * chip's own count implies.
 *
 * Here rather than in the panel because it is a statement about two `Place`
 * fields, and because a `.tsx` is a module no test can import.
 * → `docs/spec/17-cockpit.md#three-axes-because-they-are-three-questions`
 */
export function statePick(
  facet: TicketStateFacet | null,
  tracking: TicketTrackingFilter,
): { state: TicketStateFilter; tracking?: TicketTrackingFilter } {
  if (facet === null) return { state: 'any' };
  if (facet.live === 0 && tracking === 'live') return { state: facet.state, tracking: 'any' };
  return { state: facet.state };
}

/**
 * The coarse pair the tab lands on: the harness's own work surface, with the
 * history behind it.
 *
 * Read off {@link NOWHERE} rather than written out, because it is *the landing
 * view* that has to be offered back and not a second opinion about what that is —
 * a literal here would go stale the day the tab's default narrowing changes, and
 * silently, since a control offering the wrong pair still works.
 */
export const LIVE_WORK: { tracking: TicketTrackingFilter; state: TicketStateFilter } = {
  tracking: NOWHERE.ticketTracking,
  state: NOWHERE.ticketState,
};

/**
 * The state the tracking axis is currently widened for, or null — {@link statePick}'s
 * predicate read back off the place it wrote (issue #418).
 *
 * The widening is a one-way door without this. `statePick` moves `tracking` to
 * `any` on a pick of a state with nothing live under it, which is the only reading
 * of that click that is not a lie; but nothing moves it back, and the State tier's
 * own `Any` returns `{state: 'any'}` alone — so a reader who lands on the tab, picks
 * `Closed`, and then asks for every state again is left on the whole history with
 * the axis that widened it two controls away and no sentence anywhere saying it
 * moved. The reported symptom is exactly that: the filter set the tab *starts* on
 * turns out to be the one it cannot offer.
 *
 * So the axis says so where it landed, and the way back is the pair rather than the
 * axis: narrowing to `live` while `Closed` is still picked is the empty list the
 * widening exists to avoid, so the offer is {@link LIVE_WORK} — both coarse axes at
 * once, which is the view the reader is asking to return to.
 *
 * **It announces and offers; it never moves an axis nobody touched.** An operator
 * who chose `any` by hand and then picked a closing state sits under this same
 * predicate, and their axis is theirs: undoing it for them would be the silent move
 * this exists to apologise for, in the other direction.
 *
 * Here rather than in the panel for `statePick`'s reason — it is a statement about
 * two `Place` fields, and a `.tsx` is a module no test can import.
 * → `docs/spec/17-cockpit.md#three-axes-because-they-are-three-questions`
 */
export function widenedFor(
  state: TicketStateFilter,
  tracking: TicketTrackingFilter,
  states: readonly TicketStateFacet[],
): TicketStateFacet | null {
  if (tracking !== 'any' || state === 'any') return null;
  // Unknown to the facets — a hand-edited `?state=` — narrows to nothing and is not
  // a widening anybody asked for, so it is left alone like every other junk value here.
  const facet = states.find((f) => f.state === state);
  return facet && facet.live === 0 ? facet : null;
}

/** A feature number, the orphan bucket, or null. Junk narrows nothing, as everywhere here. */
function readFeature(value: string | null): number | 'none' | null {
  if (value === null) return null;
  if (value === 'none') return 'none';
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * A comma-separated issue-number list, validated the way every other parameter
 * here is: anything that is not a positive integer is dropped rather than
 * carried, because a hand-edited `?collapsed=` is an input an operator can type
 * and a `NaN` in this list would fold a heading that does not exist. Deduplicated
 * and sorted so one set of folded features has one spelling.
 */
function readNumbers(value: string | null): number[] {
  if (value === null) return [];
  const seen = new Set<number>();
  for (const part of value.split(',')) {
    const n = Number(part);
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * The query string for a place, `?…` or empty — the inverse of {@link readPlace}
 * for every place `readPlace` can produce.
 *
 * Defaults are omitted rather than written out, so the overview with nothing
 * open is a bare URL. That is what makes the comparison in `useNavigation`
 * sound: two spellings of one place would push a history entry that goes
 * nowhere.
 */
export function placeQuery(place: Place): string {
  const query = new URLSearchParams();
  if (place.tab !== 'overview') query.set('tab', place.tab);
  if (place.goal !== null) query.set('goal', place.goal);
  if (place.panel !== null) {
    if (typeof place.panel === 'object') query.set('ask', place.panel.ask);
    else query.set('panel', place.panel);
  }
  if (place.agent !== null) query.set('agent', place.agent);
  if (place.plan !== null) query.set('plan', place.plan);
  if (place.retro !== null) query.set('retro', place.retro);
  if (place.hatch !== null) query.set('hatch', place.hatch);
  if (place.scratchpad !== null) query.set('pad', place.scratchpad);
  if (place.configTab !== 'values') query.set('section', place.configTab);
  if (place.configGroup !== null) query.set('keys', place.configGroup);
  if (place.spend) query.set('spend', '1');
  if (place.reliability) query.set('reliability', '1');
  // Sorted on the way out as on the way in, so folding A then B and folding B
  // then A are one place rather than two history entries.
  if (place.collapsed.length > 0) {
    query.set('collapsed', [...place.collapsed].sort((a, b) => a - b).join(','));
  }
  // Defaults omitted, so "all items, newest first" is a bare `?tab=tickets` rather
  // than a second spelling of the same page — which is what keeps the comparison in
  // `useNavigation` sound.
  if (place.ticketWatch !== 'any') query.set('watch', place.ticketWatch);
  if (place.ticketTracking !== 'live') query.set('tracking', place.ticketTracking);
  if (place.ticketState !== 'any') query.set('state', place.ticketState);
  if (place.ticketFeature !== null) query.set('feature', String(place.ticketFeature));
  if (place.ticketGroup !== 'feature') query.set('group', place.ticketGroup);
  if (place.ticketOrder !== 'added') query.set('order', place.ticketOrder);
  const encoded = query.toString();
  return encoded === '' ? '' : `?${encoded}`;
}
