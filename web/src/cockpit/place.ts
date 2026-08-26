import type { ConfigTab, ConsolePanel, ConsoleTab, InsightsView } from './actions.js';
import type {
  InsightsWindow,
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
  /**
   * The claim whose provenance is open on the Knowledge page, by fact id.
   *
   * A place rather than a `useState` in the panel for the reason every field here
   * is one: "look at what these two agents actually saw" is a thing an operator
   * sends someone a link to, and a row held open in component state works right up
   * until the back button steps over it or a reload drops it.
   * → `docs/spec/27-knowledge.md`
   */
  fact: string | null;
  /**
   * How the Knowledge page is drawn, narrowed and ordered.
   *
   * On `Place` rather than in the panel for the reason every field here is one:
   * "the claims waiting on me, as a table sorted by what the fleet keeps asking
   * for" is a question somebody sends a link to, and a view held in a `useState`
   * works right up until the back button steps over it or a reload drops it.
   *
   * The narrowing is a **filter and never a move**: a disputed claim stays under
   * the heading its reach puts it in whatever this is set to, because lifting one
   * out would draw a demotion that did not happen.
   * → `docs/spec/27-knowledge.md#in-the-cockpit`
   */
  knowledgeView: 'queue' | 'list' | 'table';
  knowledgeShow: 'all' | 'waiting' | 'reaching' | 'settled';
  knowledgeSort: 'reach' | 'claim' | 'scope' | 'observers' | 'disputes' | 'asks' | 'age';
  knowledgeDesc: boolean;
  /**
   * The Knowledge tails an operator has **folded away**, by group id.
   *
   * Folded rather than opened, for `collapsed`'s reason exactly: the default is
   * every heading drawn — a retired claim that vanished would leave no way to tell
   * a list you have finished with from one that lost rows, and *retired* would read
   * as *deleted* — so the empty list is the page as it stands and a bare URL.
   * → `docs/spec/27-knowledge.md#in-the-cockpit`
   */
  knowledgeFolded: string[];
  /**
   * Which claim the Knowledge **queue** is standing on, by fact id, or null for
   * the oldest one that needs a ruling.
   *
   * On `Place` and not a `useState` for the reason every field here is one, and
   * this one twice over: a reload has to land on the card the operator was ruling
   * on rather than back at the top of a queue they have half drained, and *later*
   * has to be a step the back button can step back through. Null rather than the
   * first id, so a bare link to the tab is the queue as the harness orders it and
   * never a claim pinned by whoever last shared the URL.
   * → `docs/spec/27-knowledge.md#the-queue-is-the-page`
   */
  knowledgeQueue: string | null;
  /**
   * The Knowledge **queue's** three folds that an operator has opened, by id.
   *
   * Open rather than closed, which is the other way round from
   * {@link knowledgeFolded} and deliberately a second field rather than the same
   * one read backwards: the empty list has to be the page as it stands, and the
   * queue's tails start shut where the list's start drawn. One field carrying both
   * meanings would be a field that means the opposite thing depending on `?kn=`,
   * which is the drift every parameter here is spelled apart to avoid.
   *
   * What the old rule protected is kept by the count on each heading: a fold that
   * states its own size cannot let *retired* read as *deleted*, and it tells a list
   * you have finished with from one that lost rows.
   * → `docs/spec/27-knowledge.md#the-queue-is-the-page`
   */
  knowledgeOpen: string[];
  /**
   * The goal page's reference sections that are **open**, by name — `ticket` and
   * `record`.
   *
   * Open rather than closed, which is the other way round from `collapsed` and
   * `ticketColumns`, and for the same underlying rule: the empty list has to be
   * the page as it stands. Both of these are drawn shut — neither is owed
   * anything, and the ticket is read once at pickup — so "nothing open" is the
   * default and a bare URL.
   *
   * A place rather than a `useState` in the page for the reason every field here
   * is one: a disclosure opened and then stepped back out of has to come back, and
   * a link somebody sends to a goal's ticket body has to open on it.
   */
  goalOpen: string[];
  /** Which section of the config page is in front. */
  configTab: ConfigTab;
  /** The config group the page is showing, or null for the first one. */
  configGroup: string | null;
  /**
   * Which reading the Insights page is showing, and the stretch of time every
   * reading on it is measured over.
   *
   * Two fields rather than the three booleans they replaced (`spend`,
   * `reliability` and the `output` panel). Those were independent, so
   * `?spend=1&reliability=1&panel=output` was a representable place that drew
   * all three at once — which is precisely the shape {@link ConsolePanel} is one
   * value to rule out, and these two escaped it by being modals rather than
   * panels. A destination cannot be in front of itself.
   */
  insightsView: InsightsView;
  insightsWindow: InsightsWindow;
  /**
   * Which project the shared pool reading is narrowed to, or null for every one.
   *
   * A field of its own rather than a `useState` in the panel, for every reason the
   * two above are places — and one more that is specific to it: `byCheck` is drawn
   * only inside a project, so "which project" is the difference between a table
   * being there and not, and a link somebody sends has to open on the same one.
   * → `docs/spec/28-cross-fleet-pool.md#in-the-cockpit`
   */
  poolProject: string | null;
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
  /**
   * The table, or the board of state columns.
   *
   * A place rather than a `useState` for the reason every field here is one: a view
   * switched and then stepped back out of has to come back, and a link somebody
   * sends has to open on the view they were looking at. Defaults to the table, which
   * is what the tab has always been.
   */
  ticketView: 'table' | 'card';
  /**
   * The board columns hidden from view — the **hidden** ones, not the shown ones.
   *
   * Inverted for `collapsed`'s reason: the default is the empty list and so a bare
   * URL, and a state the tracker starts reporting later appears on its own instead
   * of being excluded by a list written before it existed.
   */
  ticketColumns: string[];
}

/**
 * Every tab a `?tab=` may name — the parser's whole vocabulary, and wider than the
 * nav on purpose: `config` and `pets` are reachable without being drawn there.
 *
 * `features` is listed for the same reason `pets` is: the address bar must
 * round-trip it, or a link an operator saved to the board parses straight back to
 * the overview with nothing saying so. Whether it can be *reached* is a separate
 * question the console answers — see `ConsoleRoot`'s `tabBody`, which sends a
 * stale `?tab=features` to the overview on a deployment with no board.
 */
const TABS: readonly ConsoleTab[] = ['overview', 'tickets', 'knowledge', 'features', 'insights', 'pets', 'config'];
const INSIGHTS_VIEWS: readonly InsightsView[] = ['economics', 'reliability', 'causes', 'trend', 'mix', 'mcp', 'pool'];
/**
 * The windows the time bar offers, and what a bare Insights URL means.
 *
 * Spelled here rather than imported from the server module that owns them,
 * because `web/src/` may name nothing but `src/wire.ts` — so this list and
 * `INSIGHTS_WINDOWS` are two statements of one set, held together by
 * `InsightsWindow` itself: dropping a member server-side turns the unused entry
 * here into a type error rather than a window the page offers and the route
 * refuses.
 */
const INSIGHTS_WINDOWS: readonly InsightsWindow[] = ['6h', '24h', '7d', '30d', 'all'];
const DEFAULT_INSIGHTS_WINDOW: InsightsWindow = '7d';

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
  fact: null,
  goalOpen: [],
  // The queue, which is what a bare link to the tab means: the page an operator
  // opens several times a day answers *what is on me*, and the nine headings that
  // answer *what is in this store* are a click away at `?kn=list`.
  knowledgeView: 'queue',
  knowledgeShow: 'all',
  knowledgeSort: 'reach',
  knowledgeDesc: false,
  knowledgeFolded: [],
  knowledgeQueue: null,
  knowledgeOpen: [],
  configTab: 'values',
  configGroup: null,
  insightsView: 'economics',
  // Every project, which is the honest default: `byCheck` is absent until somebody
  // narrows, rather than summed across pipelines that share no naming.
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
};

const CONFIG_TABS: readonly ConfigTab[] = ['values', 'raw', 'ci', 'prompts', 'mcp', 'notifications', 'theme'];
/**
 * Tabs that no longer exist, and where they went.
 *
 * The backlog was folded into the tickets tab, which is a strict superset of it —
 * and an unknown tab resolves to the overview, so without this every bookmark and
 * shared link to `?tab=backlog` would land somewhere else with nothing saying so.
 * An alias is one entry; a stranded link is a bug report.
 *
 * `work` is the second, and it lands on the same place for a weaker reason worth
 * stating: the tickets tab is not a superset of the work tab. It has the half of
 * it an operator *acted* on — the unrecorded-work call-out — while the record
 * itself is the `record` panel now, reachable from the bar at every width. A tab
 * alias cannot open a panel, and of the two halves this is the one a saved link to
 * `?tab=work` was overwhelmingly about.
 */
const TAB_ALIASES: Readonly<Record<string, ConsoleTab>> = { backlog: 'tickets', work: 'tickets' };

/**
 * Panels that became destinations, and the tab each is now — the same apology
 * {@link TAB_ALIASES} makes, owed to the other half of the address bar.
 *
 * Knowledge was a panel, so every link an operator saved to a claim spells
 * `?panel=knowledge&fact=…`. `knowledge` is no longer a name `PANELS` knows, so
 * without this the panel parses back to null and the link opens the overview with
 * the fact id still in the URL — the shape of a stranded link, and silent.
 *
 * It is consulted only when nothing else named a tab, so `?tab=tickets&panel=knowledge`
 * still lands on tickets: an explicit tab is the operator saying where they meant
 * to be, and an alias must not overrule one.
 */
const PANEL_ALIASES: Readonly<Record<string, ConsoleTab>> = {
  knowledge: 'knowledge',
  // Findings and lessons became sections of the knowledge page rather than panels
  // of their own, so every link an operator saved to either spells a panel name
  // `PANELS` no longer knows. Aliased for the reason `knowledge` itself is: without
  // this the panel parses back to null and the link opens the overview, which is
  // the shape of a stranded link and is silent.
  findings: 'knowledge',
  lessons: 'knowledge',
};
const KNOWLEDGE_VIEW: readonly Place['knowledgeView'][] = ['queue', 'list', 'table'];
/**
 * The queue's three folds, validated on the way in like every other parameter
 * here: a hand-edited `?see=` naming no fold is a section held open that does not
 * exist. Spelled here rather than imported from `knowledgeQuery.ts` because that
 * module names this one — the list is held to `QUEUE_FOLDS` by
 * `test/knowledgeQuery.test.ts`.
 */
const KNOWLEDGE_QUEUE_FOLDS: readonly string[] = ['cold', 'settled', 'store'];
const KNOWLEDGE_SHOW: readonly Place['knowledgeShow'][] = ['all', 'waiting', 'reaching', 'settled'];
const KNOWLEDGE_SORT: readonly Place['knowledgeSort'][] = [
  'reach',
  'claim',
  'scope',
  'observers',
  'disputes',
  'asks',
  'age',
];
/**
 * The goal page's two reference sections, validated like every other parameter
 * here: a name this list does not carry is dropped rather than carried, because a
 * hand-edited `?open=` is an input an operator can type and an unknown entry would
 * be a section held open that does not exist.
 */
const GOAL_SECTIONS: readonly string[] = ['record', 'ticket'];
const TICKET_WATCH: readonly TicketWatchFilter[] = ['any', 'watched', 'unwatched'];
const TICKET_TRACKING: readonly TicketTrackingFilter[] = ['any', 'live', 'frozen'];
const TICKET_GROUP = ['feature', 'flat'] as const;
const TICKET_ORDER: readonly TicketOrder[] = ['added', 'changed', 'cost'];
const TICKET_VIEW: readonly Place['ticketView'][] = ['table', 'card'];
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
  faults: true,
  launch: true,
  build: true,
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
      : (TABS.find((t) => t === tab) ??
        (tab !== null ? TAB_ALIASES[tab] : undefined) ??
        (panel !== null ? PANEL_ALIASES[panel] : undefined) ??
        'overview'),
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
    fact: param(query, 'fact'),
    goalOpen: readStrings(param(query, 'open')).filter((name) => GOAL_SECTIONS.includes(name)),
    // `kn`, not `view`: the tickets tab and the Insights page already share that
    // parameter between them, and a third reader of it is a page that opens
    // showing whatever one of the other two was last set to.
    knowledgeView: KNOWLEDGE_VIEW.find((v) => v === param(query, 'kn')) ?? 'queue',
    knowledgeShow: KNOWLEDGE_SHOW.find((s) => s === param(query, 'show')) ?? 'all',
    ...readKnowledgeSort(param(query, 'sort')),
    knowledgeFolded: readStrings(param(query, 'fold')),
    knowledgeQueue: param(query, 'q'),
    // `see`, not `open`: the goal page's disclosures already own that parameter,
    // and two places reading one is a page that opens showing whatever the other
    // one was set to.
    knowledgeOpen: readStrings(param(query, 'see')).filter((id) => KNOWLEDGE_QUEUE_FOLDS.includes(id)),
    configTab: CONFIG_TABS.find((t) => t === param(query, 'section')) ?? 'values',
    // `keys`, not `group`: the tickets tab already owns `?group=` (its feature
    // heading mode), and two places reading one parameter is a place that opens
    // showing whatever the other one was set to.
    configGroup: param(query, 'keys'),
    insightsView: INSIGHTS_VIEWS.find((v) => v === param(query, 'view')) ?? 'economics',
    poolProject: param(query, 'project') ?? null,
    insightsWindow: INSIGHTS_WINDOWS.find((w) => w === param(query, 'win')) ?? DEFAULT_INSIGHTS_WINDOW,
    collapsed: readNumbers(param(query, 'collapsed')),
    // Validated back into their types like every other parameter here, and for
    // the same reason: these are the ones an operator is most likely to hand-edit,
    // since the whole tab is a question spelled in the address bar.
    ticketWatch: TICKET_WATCH.find((w) => w === param(query, 'watch')) ?? 'any',
    ...readTracking(param(query, 'tracking'), param(query, 'state')),
    ticketFeature: readFeature(param(query, 'feature')),
    ticketGroup: TICKET_GROUP.find((g) => g === param(query, 'group')) ?? 'feature',
    ticketOrder: TICKET_ORDER.find((o) => o === param(query, 'order')) ?? 'added',
    ticketView: TICKET_VIEW.find((v) => v === param(query, 'view')) ?? 'table',
    ticketColumns: readStrings(param(query, 'hide')),
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

/**
 * A column and the end of it being read from, out of one parameter — `-asks` is
 * the most-asked-for first.
 *
 * Validated back into the union like every other parameter here: a hand-edited
 * `?sort=` naming no column is not an error worth a screen, it is an order that
 * does not exist, and the answer to that is the order the page opens in.
 */
function readKnowledgeSort(value: string | null): {
  knowledgeSort: Place['knowledgeSort'];
  knowledgeDesc: boolean;
} {
  const desc = value !== null && value.startsWith('-');
  const key = desc ? value.slice(1) : value;
  const sort = KNOWLEDGE_SORT.find((s) => s === key);
  return sort === undefined
    ? { knowledgeSort: 'reach', knowledgeDesc: false }
    : { knowledgeSort: sort, knowledgeDesc: desc };
}

/** A feature number, the orphan bucket, or null. Junk narrows nothing, as everywhere here. */
function readFeature(value: string | null): number | 'none' | null {
  if (value === null) return null;
  if (value === 'none') return 'none';
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * A comma-separated list of tracker state words, validated the way every parameter
 * here is: blanks are dropped rather than carried, because a hand-edited `?hide=` is
 * an input an operator can type and an empty entry would hide a column that does not
 * exist. Deduplicated and sorted, so one set of hidden columns has one spelling.
 *
 * A comma is therefore the one character a state word cannot contain here. Encoding
 * one would be a second grammar in the address bar, for a case no tracker produces.
 */
function readStrings(value: string | null): string[] {
  if (value === null) return [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const state = part.trim();
    if (state !== '') seen.add(state);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
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
  if (place.fact !== null) query.set('fact', place.fact);
  // `readStrings` already sorted these on the way in, so opening the ticket then
  // the record and the record then the ticket are one place rather than two
  // history entries.
  if (place.goalOpen.length > 0) query.set('open', place.goalOpen.join(','));
  if (place.knowledgeView !== 'queue') query.set('kn', place.knowledgeView);
  if (place.knowledgeQueue !== null) query.set('q', place.knowledgeQueue);
  // Sorted on the way out as on the way in, so opening cold then settled and
  // settled then cold are one place rather than two history entries.
  if (place.knowledgeOpen.length > 0) {
    query.set('see', [...place.knowledgeOpen].sort((a, b) => a.localeCompare(b)).join(','));
  }
  if (place.knowledgeShow !== 'all') query.set('show', place.knowledgeShow);
  // One parameter for the pair, because they are one answer: a column and the end
  // of it you are reading from. Two would make `?sort=asks&dir=desc` and
  // `?dir=desc` both spellings of places, one of which sorts nothing.
  if (place.knowledgeSort !== 'reach' || place.knowledgeDesc) {
    query.set('sort', `${place.knowledgeDesc ? '-' : ''}${place.knowledgeSort}`);
  }
  // Sorted on the way out as on the way in, so folding A then B and B then A are
  // one place rather than two history entries.
  if (place.knowledgeFolded.length > 0) {
    query.set('fold', [...place.knowledgeFolded].sort((a, b) => a.localeCompare(b)).join(','));
  }
  if (place.configTab !== 'values') query.set('section', place.configTab);
  if (place.configGroup !== null) query.set('keys', place.configGroup);
  if (place.insightsView !== 'economics') query.set('view', place.insightsView);
  if (place.poolProject !== null) query.set('project', place.poolProject);
  if (place.insightsWindow !== DEFAULT_INSIGHTS_WINDOW) query.set('win', place.insightsWindow);
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
  if (place.ticketView !== 'table') query.set('view', place.ticketView);
  // Sorted on the way out as on the way in, so hiding A then B and B then A are
  // one place rather than two history entries.
  if (place.ticketColumns.length > 0) {
    query.set('hide', [...place.ticketColumns].sort((a, b) => a.localeCompare(b)).join(','));
  }
  const encoded = query.toString();
  return encoded === '' ? '' : `?${encoded}`;
}
