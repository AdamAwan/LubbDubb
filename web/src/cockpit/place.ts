import type { ConfigTab, ConsolePanel, ConsoleTab, InsightsScope, InsightsView } from './actions.js';
import { GOAL_SECTIONS } from '../view/goalPage.js';
import type {
  InsightsWindow,
  TicketOrder,
  TicketStateFacet,
  TicketStateFilter,
  TicketTrackingFilter,
  TicketWatchFilter,
} from '../types.js';

// → docs/spec/17-cockpit.md#the-address-bar

export interface Place {
  tab: ConsoleTab;
  goal: string | null;
  pr: number | null;
  panel: ConsolePanel;
  agent: string | null;
  plan: string | null;
  planRegroup: boolean;
  retro: string | null;
  hatch: string | null;
  scratchpad: string | null;
  reviewPack: number | null;
  reviewIdea: string | null;
  obstacle: string | null;
  obstacleEnded: boolean;
  goalOpen: string[];
  goalShut: string[];
  configTab: ConfigTab;
  configGroup: string | null;
  insightsView: InsightsView;
  insightsScope: InsightsScope;
  insightsWindow: InsightsWindow;
  poolProject: string | null;
  collapsed: number[];
  ticketWatch: TicketWatchFilter;
  ticketTracking: TicketTrackingFilter;
  ticketState: TicketStateFilter;
  ticketFeature: number | 'none' | null;
  ticketGroup: 'feature' | 'flat';
  ticketOrder: TicketOrder;
  ticketView: 'table' | 'card';
  ticketColumns: string[];
  featureCard: number | null;
  featureSort: FeatureSort;
  featurePrs: FeaturePrFilter;
}

export type FeatureSort = 'wants-you' | 'moved' | 'done' | 'spend';
export const FEATURE_SORTS: readonly FeatureSort[] = ['wants-you', 'moved', 'done', 'spend'];
export type FeaturePrFilter = 'open' | 'done' | 'all';
const FEATURE_PRS: readonly FeaturePrFilter[] = ['open', 'done', 'all'];

const TABS: readonly ConsoleTab[] = ['overview', 'tickets', 'obstacles', 'features', 'insights', 'pets', 'config'];

const HOME_TABS: readonly ConsoleTab[] = ['overview', 'tickets', 'features'];

const DEFAULT_HOME: ConsoleTab = 'overview';

export function homeTab(tab: ConsoleTab): ConsoleTab {
  return HOME_TABS.includes(tab) ? tab : DEFAULT_HOME;
}
const INSIGHTS_VIEWS: readonly InsightsView[] = [
  'economics',
  'allowance',
  'reliability',
  'throughput',
  'causes',
  'trend',
  'mcp',
  'review',
  'usage',
];
const INSIGHTS_SCOPES: readonly InsightsScope[] = ['mine', 'pool'];
/* The tabs the pool can answer. The rest are readings only a fleet holds about
   itself. → docs/spec/17-cockpit.md#just-me-or-the-pool */
export const POOL_VIEWS: readonly InsightsView[] = ['economics', 'causes', 'throughput', 'usage'];
const INSIGHTS_WINDOWS: readonly InsightsWindow[] = ['session', '6h', '24h', '7d', '30d', 'all'];
const DEFAULT_INSIGHTS_WINDOW: InsightsWindow = '7d';

export const NOWHERE: Place = {
  tab: 'overview',
  goal: null,
  pr: null,
  panel: null,
  agent: null,
  plan: null,
  planRegroup: false,
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
  insightsScope: 'mine',
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
const TAB_ALIASES: Readonly<Record<string, ConsoleTab>> = {
  backlog: 'tickets',
  work: 'tickets',
  knowledge: 'obstacles',
};

const PANEL_ALIASES: Readonly<Record<string, ConsoleTab>> = {
  knowledge: 'obstacles',
  findings: 'obstacles',
  lessons: 'obstacles',
};
const SECTIONS: readonly string[] = GOAL_SECTIONS;
const TICKET_WATCH: readonly TicketWatchFilter[] = ['any', 'watched', 'unwatched'];
const TICKET_TRACKING: readonly TicketTrackingFilter[] = ['any', 'live', 'frozen'];
const TICKET_GROUP = ['feature', 'flat'] as const;
const TICKET_ORDER: readonly TicketOrder[] = ['added', 'changed', 'cost'];
const TICKET_VIEW: readonly Place['ticketView'][] = ['table', 'card'];
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

function param(query: URLSearchParams, key: string): string | null {
  const value = query.get(key);
  return value === null || value === '' ? null : value;
}

export function readPlace(search: string): Place {
  const query = new URLSearchParams(search);
  const tab = param(query, 'tab');
  const panel = param(query, 'panel');
  const ask = param(query, 'ask');
  const goal = param(query, 'goal');
  const pr = readPrNumber(param(query, 'pr'));
  const named: ConsoleTab = query.has('settings')
    ? 'config'
    : (TABS.find((t) => t === tab) ??
      (tab !== null ? TAB_ALIASES[tab] : undefined) ??
      (panel !== null ? PANEL_ALIASES[panel] : undefined) ??
      'overview');
  return {
    tab: goal !== null || pr !== null ? homeTab(named) : named,
    goal,
    pr,
    panel: ask !== null ? { ask } : (PANELS.find((p) => p === panel) ?? null),
    agent: param(query, 'agent'),
    plan: param(query, 'plan'),
    planRegroup: query.has('regroup'),
    retro: param(query, 'retro'),
    hatch: param(query, 'hatch'),
    scratchpad: param(query, 'pad'),
    ...readReviewPack(param(query, 'pack'), param(query, 'idea')),
    goalOpen: readStrings(param(query, 'open')).filter((name) => SECTIONS.includes(name)),
    goalShut: readStrings(param(query, 'shut')).filter((name) => SECTIONS.includes(name)),
    obstacle: param(query, 'obs'),
    obstacleEnded: query.has('ended'),
    configTab: CONFIG_TABS.find((t) => t === param(query, 'section')) ?? 'values',
    configGroup: param(query, 'keys'),
    ...readInsights(param(query, 'view'), param(query, 'scope')),
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
    featureCard: readPrNumber(param(query, 'card')),
    featureSort: FEATURE_SORTS.find((s) => s === param(query, 'sort')) ?? 'wants-you',
    featurePrs: FEATURE_PRS.find((f) => f === param(query, 'prs')) ?? 'open',
  };
}

/* `view=pool` was a tab of its own before the pool became a scope, so a saved
   link naming it lands on the scope with the tab the old one opened on. */
function readInsights(
  view: string | null,
  scope: string | null,
): { insightsView: InsightsView; insightsScope: InsightsScope } {
  if (view === 'pool') return { insightsView: 'economics', insightsScope: 'pool' };
  /* `mix` asked Economics' own question of the same payload, so its two tables are
     sections of that tab now and a link naming it lands there. */
  if (view === 'mix') return { insightsView: 'economics', insightsScope: 'mine' };
  const chosen = INSIGHTS_VIEWS.find((v) => v === view) ?? 'economics';
  const where = INSIGHTS_SCOPES.find((s) => s === scope) ?? 'mine';
  if (where === 'pool' && !POOL_VIEWS.includes(chosen)) return { insightsView: 'economics', insightsScope: 'pool' };
  return { insightsView: chosen, insightsScope: where };
}

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

export function statePick(
  facet: TicketStateFacet | null,
  tracking: TicketTrackingFilter,
): { state: TicketStateFilter; tracking?: TicketTrackingFilter } {
  if (facet === null) return { state: 'any' };
  if (facet.live === 0 && tracking === 'live') return { state: facet.state, tracking: 'any' };
  return { state: facet.state };
}

export const LIVE_WORK: { tracking: TicketTrackingFilter; state: TicketStateFilter } = {
  tracking: NOWHERE.ticketTracking,
  state: NOWHERE.ticketState,
};

export function widenedFor(
  state: TicketStateFilter,
  tracking: TicketTrackingFilter,
  states: readonly TicketStateFacet[],
): TicketStateFacet | null {
  if (tracking !== 'any' || state === 'any') return null;
  const facet = states.find((f) => f.state === state);
  return facet && facet.live === 0 ? facet : null;
}

function readPrNumber(value: string | null): number | null {
  const number = Number(value);
  return value !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function readReviewPack(pack: string | null, idea: string | null): Pick<Place, 'reviewPack' | 'reviewIdea'> {
  const number = pack === null ? NaN : Number(pack);
  if (!Number.isInteger(number) || number <= 0) return { reviewPack: null, reviewIdea: null };
  return { reviewPack: number, reviewIdea: idea };
}

function readFeature(value: string | null): number | 'none' | null {
  if (value === null) return null;
  if (value === 'none') return 'none';
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function readStrings(value: string | null): string[] {
  if (value === null) return [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const state = part.trim();
    if (state !== '') seen.add(state);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function readNumbers(value: string | null): number[] {
  if (value === null) return [];
  const seen = new Set<number>();
  for (const part of value.split(',')) {
    const n = Number(part);
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

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
  if (place.plan !== null) {
    query.set('plan', place.plan);
    if (place.planRegroup) query.set('regroup', '1');
  }
  if (place.retro !== null) query.set('retro', place.retro);
  if (place.hatch !== null) query.set('hatch', place.hatch);
  if (place.scratchpad !== null) query.set('pad', place.scratchpad);
  if (place.reviewPack !== null) {
    query.set('pack', String(place.reviewPack));
    if (place.reviewIdea !== null) query.set('idea', place.reviewIdea);
  }
  if (place.goalOpen.length > 0) query.set('open', place.goalOpen.join(','));
  if (place.goalShut.length > 0) query.set('shut', place.goalShut.join(','));
  if (place.obstacle !== null) query.set('obs', place.obstacle);
  if (place.obstacleEnded) query.set('ended', '1');
  if (place.configTab !== 'values') query.set('section', place.configTab);
  if (place.configGroup !== null) query.set('keys', place.configGroup);
  if (place.insightsView !== 'economics') query.set('view', place.insightsView);
  if (place.insightsScope !== 'mine') query.set('scope', place.insightsScope);
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
