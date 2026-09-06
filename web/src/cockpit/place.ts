import type { ConfigTab, ConsolePanel, ConsoleTab, InsightsView } from './actions.js';
import { GOAL_SECTIONS } from '../view/goalPage.js';
import type {
  InsightsWindow,
  TicketOrder,
  TicketStateFacet,
  TicketStateFilter,
  TicketTrackingFilter,
  TicketWatchFilter,
} from '../types.js';

/**
 * Where the cockpit is — every piece of state that answers "what am I looking at", never "what
 * is true". One record rather than many `useState`s, because the back button is a single
 * history of places: a drawer over a goal page on the tickets tab is one place, and stepping
 * back restores all three at once. → `docs/spec/17-cockpit.md#the-address-bar`
 */
export interface Place {
  /** Where the nav is. A selected goal outranks it — see {@link ConsoleTab}. */
  tab: ConsoleTab;
  /** The goal whose page is open, as `issue:<n>`, or null for the tab. */
  goal: string | null;
  /**
   * The pull request whose page is open, by number. Outranks the goal, which outranks the tab;
   * held beside {@link goal} rather than replacing it so the crumb back names the goal it was
   * reached from. → `docs/spec/17-cockpit.md#the-pull-request-page`
   */
  pr: number | null;
  /** Which full-surface panel is in front, or null. */
  panel: ConsolePanel;
  /** The agent whose drawer is open. */
  agent: string | null;
  /** The plan whose sheet is open. */
  plan: string | null;
  /** The goal whose retrospective is open, as an `issue:<n>` ref. */
  retro: string | null;
  /**
   * The egg whose shell is coming off, by pet id. Nothing is re-decided by arriving here: the
   * shell comes off when the modal mounts, so a reload mid-wobble is a reveal, not a re-roll.
   * → `docs/spec/22-pets.md#the-egg`
   */
  hatch: string | null;
  /** The goal whose notepad is open, as an `issue:<n>` ref. */
  scratchpad: string | null;
  /** The pull request whose review pack is open over the goal page, by number. → [31](../../../docs/spec/31-review-packs.md#reading-it) */
  reviewPack: number | null;
  /** Which idea of the open pack is unfolded, by its minted id, or `all` for every one. Read as null whenever {@link reviewPack} is null. */
  reviewIdea: string | null;
  /** The obstacle whose sightings are unfolded on the Obstacles page, by id. → `docs/spec/27-obstacles.md#in-the-cockpit` */
  obstacle: string | null;
  /** Whether the Obstacles page's terminal tail is opened — that way round so the default (shut) is a bare URL. */
  obstacleEnded: boolean;
  /**
   * The goal page's foldable sections the operator has opened, by name. Two lists rather than
   * one, because a section's default follows how far the goal has got, and that moves under the
   * operator; a single list could only say "not the default". Both lists outrank the default.
   */
  goalOpen: string[];
  /** The same, for sections the operator has folded away. See {@link goalOpen}. */
  goalShut: string[];
  /** Which section of the config page is in front. */
  configTab: ConfigTab;
  /** The config group the page is showing, or null for the first one. */
  configGroup: string | null;
  /** Which reading the Insights page is showing, and the time window every reading is measured over. Two fields, since a destination cannot be in front of itself. */
  insightsView: InsightsView;
  insightsWindow: InsightsWindow;
  /** Which project the shared pool reading is narrowed to, or null for every one. → `docs/spec/28-cross-fleet-pool.md#in-the-cockpit` */
  poolProject: string | null;
  /** The tickets tab's feature headings that are collapsed, by issue number — that way round so the default (every feature open) is a bare URL. */
  collapsed: number[];
  /**
   * How the Tickets tab is narrowed, arranged and ordered — on `Place` because the tab exists
   * to be asked, and a question is a link somebody sends. The scroll offset is deliberately not
   * here: restoring an offset into a list that has grown lands somewhere else entirely.
   */
  ticketWatch: TicketWatchFilter;
  /** What the harness is doing about an item, not what the tracker calls it. Defaults to `live`, so the tab doesn't open on a thousand frozen rows. */
  ticketTracking: TicketTrackingFilter;
  /** The tracker's own word, or `any`. Free-form: the vocabulary is the tracker's. */
  ticketState: TicketStateFilter;
  /** A feature number, `none` for the orphans, or null for every feature. */
  ticketFeature: number | 'none' | null;
  /** Features as headings, or one flat list with a feature column. */
  ticketGroup: 'feature' | 'flat';
  ticketOrder: TicketOrder;
  /** The table, or the board of state columns. Defaults to the table. */
  ticketView: 'table' | 'card';
  /** The board columns hidden from view, not the shown ones: the default is a bare URL, and a new tracker state appears on its own. */
  ticketColumns: string[];
  /** The Feature (or promoted goal) whose card on the Features tab is open, by issue number, or null. Validated like {@link pr}: `?card=abc` opens nothing. */
  featureCard: number | null;
  /** How the Features tab's list is ordered. Defaults to `wants-you` — the cards asking for a decision first. */
  featureSort: FeatureSort;
  /** Which pull requests the open card lists. Defaults to `open`. */
  featurePrs: FeaturePrFilter;
}

/** The orderings the Features tab offers. `FEATURE_SORTS` is exported so the controls and the parser agree on which spellings exist. */
export type FeatureSort = 'wants-you' | 'moved' | 'done' | 'spend';
export const FEATURE_SORTS: readonly FeatureSort[] = ['wants-you', 'moved', 'done', 'spend'];
/** Which of an open card's pull requests are listed. */
export type FeaturePrFilter = 'open' | 'done' | 'all';
const FEATURE_PRS: readonly FeaturePrFilter[] = ['open', 'done', 'all'];

/** Every tab a `?tab=` may name — wider than the nav on purpose. A tab missing here round-trips to the overview with nothing saying so. */
const TABS: readonly ConsoleTab[] = ['overview', 'tickets', 'obstacles', 'features', 'insights', 'pets', 'config'];

/**
 * The tabs a goal or a pull request can hang off — the ones that list work. A selection made
 * from anywhere else moves the nav to {@link DEFAULT_HOME}, so the crumb never leads to a page
 * that doesn't contain the goal. → `docs/spec/17-cockpit.md#nesting`
 */
const HOME_TABS: readonly ConsoleTab[] = ['overview', 'tickets', 'features'];

/** Where a goal or pull request hangs when not reached from a tab that lists one: the overview. */
const DEFAULT_HOME: ConsoleTab = 'overview';

/**
 * The tab a goal or pull request opened from `tab` belongs under: identity on the three that
 * list work, {@link DEFAULT_HOME} otherwise. Exported so `readPlace` and `selectGoal` /
 * `selectPr` cannot disagree.
 */
export function homeTab(tab: ConsoleTab): ConsoleTab {
  return HOME_TABS.includes(tab) ? tab : DEFAULT_HOME;
}
const INSIGHTS_VIEWS: readonly InsightsView[] = [
  'economics',
  'allowance',
  'reliability',
  'causes',
  'trend',
  'mix',
  'mcp',
  'review',
  'usage',
  'pool',
];
/** The windows the time bar offers. Spelled here because `web/src/` may name nothing but `src/wire.ts`. */
const INSIGHTS_WINDOWS: readonly InsightsWindow[] = ['session', '6h', '24h', '7d', '30d', 'all'];
const DEFAULT_INSIGHTS_WINDOW: InsightsWindow = '7d';

/** The cockpit with nothing open: the overview, which is what a bare URL means. */
export const NOWHERE: Place = {
  tab: 'overview',
  goal: null,
  pr: null,
  panel: null,
  agent: null,
  plan: null,
  retro: null,
  hatch: null,
  scratchpad: null,
  reviewPack: null,
  reviewIdea: null,
  goalOpen: [],
  goalShut: [],
  obstacle: null,
  obstacleEnded: false,
  configTab: 'values',
  configGroup: null,
  insightsView: 'economics',
  // Every project: `byCheck` is absent until somebody narrows.
  poolProject: null,
  insightsWindow: DEFAULT_INSIGHTS_WINDOW,
  collapsed: [],
  ticketWatch: 'any',
  ticketTracking: 'live',
  ticketState: 'any',
  ticketFeature: null,
  ticketGroup: 'feature',
  ticketOrder: 'added',
  ticketView: 'table',
  ticketColumns: [],
  featureCard: null,
  featureSort: 'wants-you',
  featurePrs: 'open',
};

const CONFIG_TABS: readonly ConfigTab[] = ['values', 'raw', 'ci', 'prompts', 'mcp', 'notifications', 'theme'];
/**
 * Tabs that no longer exist, and where they went. `work` lands on tickets even though that
 * isn't a superset of it — a tab alias can't open the `record` panel, and tickets is the half a
 * saved `?tab=work` was overwhelmingly about.
 */
const TAB_ALIASES: Readonly<Record<string, ConsoleTab>> = {
  backlog: 'tickets',
  work: 'tickets',
  // Knowledge was a tab until the claim store went; lands on the obstacle board.
  knowledge: 'obstacles',
};

/** Panels that became destinations, and the tab each is now. A `fact` id beside them is dropped, since no row could open. Consulted only when nothing else named a tab. */
const PANEL_ALIASES: Readonly<Record<string, ConsoleTab>> = {
  knowledge: 'obstacles',
  findings: 'obstacles',
  lessons: 'obstacles',
};
/** The goal page's foldable sections. Read off {@link GOAL_SECTIONS} rather than written again, or a section this list never learned about would fold only until reload. */
const SECTIONS: readonly string[] = GOAL_SECTIONS;
const TICKET_WATCH: readonly TicketWatchFilter[] = ['any', 'watched', 'unwatched'];
const TICKET_TRACKING: readonly TicketTrackingFilter[] = ['any', 'live', 'frozen'];
const TICKET_GROUP = ['feature', 'flat'] as const;
const TICKET_ORDER: readonly TicketOrder[] = ['added', 'changed', 'cost'];
const TICKET_VIEW: readonly Place['ticketView'][] = ['table', 'card'];
/**
 * Every panel name the address bar round-trips — every member of `ConsolePanel` bar the ask,
 * which carries its own parameter. A `Record` over the union, not a list: a list compiles while
 * missing a member and the omission costs a panel that opens on a click and is gone after reload.
 */
const PANEL_NAMES: Record<Exclude<ConsolePanel, null | { ask: string }>, true> = {
  faults: true,
  launch: true,
  build: true,
  upnext: true,
  signals: true,
  environments: true,
  pets: true,
  localRun: true,
  setup: true,
  record: true,
};

const PANELS = Object.keys(PANEL_NAMES) as Exclude<ConsolePanel, null | { ask: string }>[];

/** A parameter's value, with an empty one read as absent — `?goal=` names nothing. */
function param(query: URLSearchParams, key: string): string | null {
  const value = query.get(key);
  return value === null || value === '' ? null : value;
}

/**
 * Read a place out of a query string. Every value is validated back into its type rather than
 * cast: this is the one input to the cockpit an operator can type, and an unrecognised tab or
 * panel is a place that doesn't exist, which resolves to the overview.
 */
export function readPlace(search: string): Place {
  const query = new URLSearchParams(search);
  const tab = param(query, 'tab');
  const panel = param(query, 'panel');
  const ask = param(query, 'ask');
  const goal = param(query, 'goal');
  const pr = readPrNumber(param(query, 'pr'));
  // `?settings=1` opened the modal this page replaced, honoured for `?tab=backlog`'s reason.
  const named: ConsoleTab = query.has('settings')
    ? 'config'
    : (TABS.find((t) => t === tab) ??
      (tab !== null ? TAB_ALIASES[tab] : undefined) ??
      (panel !== null ? PANEL_ALIASES[panel] : undefined) ??
      'overview');
  return {
    // A goal or PR is one rung in, so the tab is narrowed to one that could have led there.
    tab: goal !== null || pr !== null ? homeTab(named) : named,
    goal,
    pr,
    // The ask panel carries its row, so it is its own parameter: an id is opaque and free to
    // contain the separator a prefix would split on.
    panel: ask !== null ? { ask } : (PANELS.find((p) => p === panel) ?? null),
    agent: param(query, 'agent'),
    plan: param(query, 'plan'),
    retro: param(query, 'retro'),
    hatch: param(query, 'hatch'),
    scratchpad: param(query, 'pad'),
    ...readReviewPack(param(query, 'pack'), param(query, 'idea')),
    goalOpen: readStrings(param(query, 'open')).filter((name) => SECTIONS.includes(name)),
    goalShut: readStrings(param(query, 'shut')).filter((name) => SECTIONS.includes(name)),
    obstacle: param(query, 'obs'),
    obstacleEnded: query.has('ended'),
    configTab: CONFIG_TABS.find((t) => t === param(query, 'section')) ?? 'values',
    // `keys`, not `group`: the tickets tab owns `?group=`.
    configGroup: param(query, 'keys'),
    insightsView: INSIGHTS_VIEWS.find((v) => v === param(query, 'view')) ?? 'economics',
    poolProject: param(query, 'project') ?? null,
    insightsWindow: INSIGHTS_WINDOWS.find((w) => w === param(query, 'win')) ?? DEFAULT_INSIGHTS_WINDOW,
    collapsed: readNumbers(param(query, 'collapsed')),
    ticketWatch: TICKET_WATCH.find((w) => w === param(query, 'watch')) ?? 'any',
    ...readTracking(param(query, 'tracking'), param(query, 'state')),
    ticketFeature: readFeature(param(query, 'feature')),
    ticketGroup: TICKET_GROUP.find((g) => g === param(query, 'group')) ?? 'feature',
    ticketOrder: TICKET_ORDER.find((o) => o === param(query, 'order')) ?? 'added',
    ticketView: TICKET_VIEW.find((v) => v === param(query, 'view')) ?? 'table',
    ticketColumns: readStrings(param(query, 'hide')),
    // `card`, `sort` and `prs`: the tickets tab owns `feature`, `order` and `view`.
    featureCard: readPrNumber(param(query, 'card')),
    featureSort: FEATURE_SORTS.find((s) => s === param(query, 'sort')) ?? 'wants-you',
    featurePrs: FEATURE_PRS.find((f) => f === param(query, 'prs')) ?? 'open',
  };
}

/**
 * The two coarse axes, and the one alias between them. `state` used to be `open` / `closed`, so
 * those two literals are read as the old axis to keep saved links working; no tracker spells a
 * state that way, so the alias can't swallow a real one. Otherwise not validated against a list
 * — that list is the tracker's, and an unknown state narrows to an empty list.
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
 * Where picking a state chip lands: the state itself, and the tracking axis it must be
 * reachable under. A closing state is on frozen rows, so under the default `live` narrowing the
 * pick would return empty while the chip counted sixty-eight. Only ever widened, and only where
 * the two axes conflict. → `docs/spec/17-cockpit.md#three-axes-because-they-are-three-questions`
 */
export function statePick(
  facet: TicketStateFacet | null,
  tracking: TicketTrackingFilter,
): { state: TicketStateFilter; tracking?: TicketTrackingFilter } {
  if (facet === null) return { state: 'any' };
  if (facet.live === 0 && tracking === 'live') return { state: facet.state, tracking: 'any' };
  return { state: facet.state };
}

/** The coarse pair the tab lands on. Read off {@link NOWHERE} rather than written out, so it can't silently go stale. */
export const LIVE_WORK: { tracking: TicketTrackingFilter; state: TicketStateFilter } = {
  tracking: NOWHERE.ticketTracking,
  state: NOWHERE.ticketState,
};

/**
 * The state the tracking axis is currently widened for, or null — {@link statePick}'s predicate
 * read back off the place it wrote. Without it the widening is a one-way door: nothing moves
 * `tracking` back, so a reader who picks `Closed` and then asks for every state is left on the
 * whole history with nothing saying the axis moved. The way back is the pair ({@link LIVE_WORK}),
 * not the axis, since narrowing to `live` alone is the empty list the widening exists to avoid.
 * It announces and offers; it never moves an axis nobody touched.
 * → `docs/spec/17-cockpit.md#three-axes-because-they-are-three-questions`
 */
export function widenedFor(
  state: TicketStateFilter,
  tracking: TicketTrackingFilter,
  states: readonly TicketStateFacet[],
): TicketStateFacet | null {
  if (tracking !== 'any' || state === 'any') return null;
  // Unknown to the facets — a hand-edited `?state=` — is not a widening anybody asked for.
  const facet = states.find((f) => f.state === state);
  return facet && facet.live === 0 ? facet : null;
}

/** The pull request whose page is open, validated into a number: `?pr=main` is a place that doesn't exist rather than a page drawn for `NaN`. */
function readPrNumber(value: string | null): number | null {
  const number = Number(value);
  return value !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function readReviewPack(pack: string | null, idea: string | null): Pick<Place, 'reviewPack' | 'reviewIdea'> {
  const number = pack === null ? NaN : Number(pack);
  if (!Number.isInteger(number) || number <= 0) return { reviewPack: null, reviewIdea: null };
  return { reviewPack: number, reviewIdea: idea };
}

/** A feature number, the orphan bucket, or null. Junk narrows nothing, as everywhere here. */
function readFeature(value: string | null): number | 'none' | null {
  if (value === null) return null;
  if (value === 'none') return 'none';
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** A comma-separated list of tracker state words: blanks dropped, deduplicated and sorted, so a comma is the one character a state word can't contain here. */
function readStrings(value: string | null): string[] {
  if (value === null) return [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const state = part.trim();
    if (state !== '') seen.add(state);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** A comma-separated issue-number list: anything but a positive integer is dropped, deduplicated and sorted. */
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
 * The query string for a place, `?…` or empty — the inverse of {@link readPlace}. Defaults are
 * omitted, so the overview with nothing open is a bare URL; two spellings of one place would
 * push a history entry in `useNavigation` that goes nowhere.
 */
export function placeQuery(place: Place): string {
  const query = new URLSearchParams();
  if (place.tab !== 'overview') query.set('tab', place.tab);
  if (place.goal !== null) query.set('goal', place.goal);
  if (place.pr !== null) query.set('pr', String(place.pr));
  if (place.panel !== null) {
    if (typeof place.panel === 'object') query.set('ask', place.panel.ask);
    else query.set('panel', place.panel);
  }
  if (place.agent !== null) query.set('agent', place.agent);
  if (place.plan !== null) query.set('plan', place.plan);
  if (place.retro !== null) query.set('retro', place.retro);
  if (place.hatch !== null) query.set('hatch', place.hatch);
  if (place.scratchpad !== null) query.set('pad', place.scratchpad);
  if (place.reviewPack !== null) {
    query.set('pack', String(place.reviewPack));
    if (place.reviewIdea !== null) query.set('idea', place.reviewIdea);
  }
  // Already sorted on the way in, so opening two sections in either order is one place.
  if (place.goalOpen.length > 0) query.set('open', place.goalOpen.join(','));
  if (place.goalShut.length > 0) query.set('shut', place.goalShut.join(','));
  if (place.obstacle !== null) query.set('obs', place.obstacle);
  if (place.obstacleEnded) query.set('ended', '1');
  if (place.configTab !== 'values') query.set('section', place.configTab);
  if (place.configGroup !== null) query.set('keys', place.configGroup);
  if (place.insightsView !== 'economics') query.set('view', place.insightsView);
  if (place.poolProject !== null) query.set('project', place.poolProject);
  if (place.insightsWindow !== DEFAULT_INSIGHTS_WINDOW) query.set('win', place.insightsWindow);
  if (place.collapsed.length > 0) {
    query.set('collapsed', [...place.collapsed].sort((a, b) => a - b).join(','));
  }
  if (place.ticketWatch !== 'any') query.set('watch', place.ticketWatch);
  if (place.ticketTracking !== 'live') query.set('tracking', place.ticketTracking);
  if (place.ticketState !== 'any') query.set('state', place.ticketState);
  if (place.ticketFeature !== null) query.set('feature', String(place.ticketFeature));
  if (place.ticketGroup !== 'feature') query.set('group', place.ticketGroup);
  if (place.ticketOrder !== 'added') query.set('order', place.ticketOrder);
  if (place.ticketView !== 'table') query.set('view', place.ticketView);
  if (place.ticketColumns.length > 0) {
    query.set('hide', [...place.ticketColumns].sort((a, b) => a.localeCompare(b)).join(','));
  }
  if (place.featureCard !== null) query.set('card', String(place.featureCard));
  if (place.featureSort !== 'wants-you') query.set('sort', place.featureSort);
  if (place.featurePrs !== 'open') query.set('prs', place.featurePrs);
  const encoded = query.toString();
  return encoded === '' ? '' : `?${encoded}`;
}
