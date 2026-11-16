import type { CockpitEnvironment, GoalEnvironmentReachView, GoalWatchView, WatchSourceDeclaration } from '../types.js';
import {
  goalPanes,
  livePageChecks,
  type GoalNavEntry,
  type GoalPageView,
  type GoalTab,
  type GoalTabOpening,
  type ObligationTab,
} from './goalPage.js';

// → docs/spec/17-cockpit.md#the-panes

export function pickedGoalTab(page: GoalPageView, picked: GoalTab | null): GoalTab | null {
  return picked !== null && goalPanes(page).includes(picked) ? picked : null;
}

export function goalTabTitle(
  entry: GoalNavEntry,
  selected: GoalTab,
  chosen: GoalTab | null,
  opening: GoalTabOpening,
): string {
  return entry.tab === selected && chosen === null
    ? `Opened here because ${opening.why}`
    : `${entry.label}: ${entry.reading} — go to it`;
}

export function goalTabCarrier(on: readonly string[]): { text: string; title: string } | null {
  if (on.length === 0) return null;
  return {
    text: on.length === 1 ? (on[0] ?? '') : `${String(on.length)} environments`,
    title: `Carried by ${on.join(' and ')}`,
  };
}

interface ObligationChoice {
  name: string;
  status: GoalEnvironmentReachView['status'] | null;
  showing: boolean;
}

/** Empty where fewer than two environments carry the obligation: one is named on the tab already. */
export function obligationChoices(page: GoalPageView, tab: ObligationTab, showing: string | null): ObligationChoice[] {
  const names = page.obligations[tab];
  if (names.length < 2) return [];
  return names.map((name) => ({
    name,
    status: page.environments.find((e) => e.environment === name)?.status ?? null,
    showing: name === showing,
  }));
}

export function checkTally(page: GoalPageView): { live: number; settled: number } {
  const live = livePageChecks(page);
  return { live: live.length, settled: live.filter((c) => c.state === 'passed' || c.state === 'waived').length };
}

export function watchWindowOf(page: GoalPageView, showing: string | null): GoalWatchView | undefined {
  return page.watches.find((w) => w.environment === showing);
}

export function watchSourcesOf(
  environments: readonly CockpitEnvironment[],
  showing: string | null,
): WatchSourceDeclaration[] {
  return environments.find((e) => e.name === showing)?.watchSources ?? [];
}
