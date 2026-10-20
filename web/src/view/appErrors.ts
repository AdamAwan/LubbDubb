import type { AppErrorBandView, AppErrorEnvironmentView, AppErrorGroupView, AppErrorsPayload } from '../types.js';

// → docs/spec/39-app-errors.md#in-the-cockpit

export type ErrorState = AppErrorGroupView['state'];
export type ErrorLink = NonNullable<AppErrorGroupView['link']>;
export type ErrorTracker = NonNullable<AppErrorGroupView['tracker']>;
export type ErrorReading = NonNullable<AppErrorEnvironmentView['reading']>;

/** The three states that say something moved. The other two are folded away by default. */
const MOVED: ReadonlySet<ErrorState> = new Set<ErrorState>(['new', 'returned', 'spiking']);

export function isMoved(state: ErrorState): boolean {
  return MOVED.has(state);
}

/** One row of the Errors table: a band group, with what its members' groups carry folded onto it. */
export interface ErrorRow {
  key: string;
  title: string;
  state: ErrorState;
  count: number;
  environments: string[];
  operation: string | null;
  firstSeen: string;
  lastSeen: string;
  frame: string | null;
  url: string | null;
  daily: number[];
  link: ErrorLink | null;
  tracker: ErrorTracker | null;
}

/** The band a place names, or the first one when it names none the payload holds. */
export function pickBand(payload: AppErrorsPayload, band: string | null): AppErrorBandView | null {
  return payload.bands.find((b) => b.band === band) ?? payload.bands[0] ?? null;
}

export function bandLabel(band: AppErrorBandView): string {
  return band.declared ? `${band.band}: ${band.environments.join(', ')}` : band.band;
}

export function bandMembers(payload: AppErrorsPayload, band: AppErrorBandView): AppErrorEnvironmentView[] {
  return payload.environments.filter((e) => band.environments.includes(e.environment));
}

/**
 * The band's groups as rows. The band roll-up names the state, the count and the members; the
 * detail — operation, frames, the link out, the fortnight — is each member's own, so it is taken
 * from the member whose state the band reports (the most moved one), with the days summed.
 */
export function bandRows(payload: AppErrorsPayload, band: AppErrorBandView): ErrorRow[] {
  const members = bandMembers(payload, band);
  return band.groups.map((bandGroup) =>
    bandRow(
      bandGroup,
      members.flatMap((m) => m.groups.filter((g) => g.key === bandGroup.key)),
    ),
  );
}

function bandRow(bandGroup: AppErrorBandView['groups'][number], held: readonly AppErrorGroupView[]): ErrorRow {
  const lead = held.find((g) => g.state === bandGroup.state) ?? held[0];
  return {
    key: bandGroup.key,
    title: bandGroup.title,
    state: bandGroup.state,
    count: bandGroup.count,
    environments: bandGroup.environments,
    operation: lead?.operation ?? null,
    firstSeen: held.map((g) => g.firstSeen).sort()[0] ?? bandGroup.lastSeen,
    lastSeen: bandGroup.lastSeen,
    frame: lead?.frames[0] ?? null,
    url: lead?.url ?? null,
    daily: sumDaily(held),
    link: firstOf(lead, held, (g) => g.link),
    tracker: firstOf(lead, held, (g) => g.tracker),
  };
}

function firstOf<T>(
  lead: AppErrorGroupView | undefined,
  held: readonly AppErrorGroupView[],
  pick: (g: AppErrorGroupView) => T | null,
): T | null {
  const own = lead === undefined ? null : pick(lead);
  if (own !== null) return own;
  for (const g of held) {
    const value = pick(g);
    if (value !== null) return value;
  }
  return null;
}

function sumDaily(groups: readonly AppErrorGroupView[]): number[] {
  const out: number[] = [];
  for (const g of groups) g.daily.forEach((d, i) => (out[i] = (out[i] ?? 0) + d.count));
  return out;
}

export type StateCounts = Record<ErrorState, number>;

export function stateCounts(rows: readonly ErrorRow[]): StateCounts {
  const counts: StateCounts = { new: 0, returned: 0, spiking: 0, steady: 0, gone: 0 };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

export function shownRows(rows: readonly ErrorRow[], steady: boolean): ErrorRow[] {
  return steady ? [...rows] : rows.filter((r) => isMoved(r.state));
}

/**
 * A link made only from an operation hint is not a claim the work caused the error, so it is
 * not counted on the goal. Read off `how` by word, because the linking stage names its methods
 * in prose: a `how` every entry of which is a hint is a hint.
 */
export function countsOnGoal(link: ErrorLink): boolean {
  return link.how.length === 0 || !link.how.every((how) => /\bhint\b/i.test(how));
}

/** What the goal card says about one environment: the moved groups linked to this goal there. */
export interface GoalErrorLine {
  environment: string;
  band: string;
  count: number;
  how: string[];
}

export function goalErrorLines(payload: AppErrorsPayload, goalRef: string): GoalErrorLine[] {
  return payload.environments.flatMap((env) => {
    const linked = env.groups.filter(
      (g) => isMoved(g.state) && g.link !== null && g.link.goalRef === goalRef && countsOnGoal(g.link),
    );
    if (linked.length === 0) return [];
    const how = [...new Set(linked.flatMap((g) => g.link?.how ?? []))];
    return [{ environment: env.environment, band: env.band, count: linked.length, how }];
  });
}
