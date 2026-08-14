import type { ConsolePanel, ConsoleTab } from './actions.js';

/**
 * Where the cockpit is — every piece of state that answers *what am I looking
 * at*, and nothing that answers *what is true*. The snapshot is the harness's;
 * this is the operator's, and it is the whole of what the address bar carries.
 *
 * One record rather than the ten `useState`s it replaced, because the back
 * button is a single history of *places*: a drawer opened over a goal page on
 * the backlog tab is one place, and stepping back out of it has to restore all
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
  /** The goal whose notepad is open, as an `issue:<n>` ref. */
  scratchpad: string | null;
  settings: boolean;
  spend: boolean;
  reliability: boolean;
}

/** The cockpit with nothing open: the overview, which is what a bare URL means. */
export const NOWHERE: Place = {
  tab: 'overview',
  goal: null,
  panel: null,
  agent: null,
  plan: null,
  retro: null,
  scratchpad: null,
  settings: false,
  spend: false,
  reliability: false,
};

const TABS: readonly ConsoleTab[] = ['overview', 'backlog', 'work'];
const PANELS = ['findings', 'faults', 'output', 'launch'] as const;

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
    tab: TABS.find((t) => t === tab) ?? 'overview',
    goal: param(query, 'goal'),
    // The ask panel carries its row, so it is its own parameter rather than a
    // prefix on `panel` — an id is opaque and free to contain whatever the
    // harness minted, including the separator a prefix would have to split on.
    panel: ask !== null ? { ask } : (PANELS.find((p) => p === panel) ?? null),
    agent: param(query, 'agent'),
    plan: param(query, 'plan'),
    retro: param(query, 'retro'),
    scratchpad: param(query, 'pad'),
    settings: query.has('settings'),
    spend: query.has('spend'),
    reliability: query.has('reliability'),
  };
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
  if (place.scratchpad !== null) query.set('pad', place.scratchpad);
  if (place.settings) query.set('settings', '1');
  if (place.spend) query.set('spend', '1');
  if (place.reliability) query.set('reliability', '1');
  const encoded = query.toString();
  return encoded === '' ? '' : `?${encoded}`;
}
