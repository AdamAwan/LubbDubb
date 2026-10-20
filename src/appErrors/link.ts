import { issueOriginNumber } from '../issueOrigins.js';
import { DAY_MS } from '../primitives.js';
import type { AppErrorLink, AppErrorLinkHow, DeployedHead, EnvironmentReading, GoalLanding } from '../types.js';
import type { AppErrorEnvironmentView, AppErrorGroupView, AppErrorsPayload } from '../wire.js';
import { filesTouched, frameFiles } from './frames.js';

// → docs/spec/39-app-errors.md#linking-a-group-to-work

/** A landing recorded longer than this before a window's start is in no window. */
const LANDING_HORIZON_MS = 30 * DAY_MS;

/** With no deploy window, the period before a group's sighting whose arrivals are its candidates. */
const ARRIVAL_LOOKBACK_MS = 7 * DAY_MS;

/** How soon after a goal reached another environment the group must have first appeared there. */
const TEST_ARRIVAL_MS = DAY_MS;

/** What the clone said about each considered landing against an environment's deploy. */
export interface DeployVerdicts {
  deployed: ReadonlyMap<string, boolean | null>;
  previous: ReadonlyMap<string, boolean | null>;
  /** Set when the clone was not asked or did not answer in time, saying why. */
  unanswered: string | null;
}

export interface LinkFacts {
  landings: readonly GoalLanding[];
  readings: readonly EnvironmentReading[];
  /** Goal ref to title, for the route hint. */
  titles: ReadonlyMap<string, string>;
  /** By environment, for every environment whose deploy window some group is held against. */
  deploys: ReadonlyMap<string, DeployVerdicts>;
  /** By commit: the paths it changed, null where the clone could not say. */
  diffs: ReadonlyMap<string, string[] | null>;
  now: number;
}

/** A window's candidate goals and the commits of theirs it holds — or why it cannot be decided. */
export type LinkWindow =
  { known: true; goals: ReadonlyMap<string, string[]>; said: string } | { known: false; why: string };

/**
 * The instant a moved group is held against, or null for a group nothing is linked for: `new` from its
 * first sighting, `returned` from its return, `spiking` from the deploy it spiked after.
 */
export function linkAnchor(group: AppErrorGroupView, head: DeployedHead | null, now: number): number | null {
  if (group.ignored) return null;
  if (group.state === 'new') return Date.parse(group.firstSeen);
  if (group.state === 'returned') return group.returnedAt === null ? null : Date.parse(group.returnedAt);
  if (group.state === 'spiking') {
    const changedAt = head?.changedAt ?? null;
    return changedAt === null ? now - DAY_MS : Date.parse(changedAt);
  }
  return null;
}

/** Whether a group is held against its environment's deploy window rather than the arrivals before it. */
export function heldAgainstDeploy(head: DeployedHead | null, anchor: number): head is ChangedHead {
  return head !== null && head.changedAt !== null && head.previousSha !== null && anchor >= Date.parse(head.changedAt);
}

type ChangedHead = DeployedHead & { changedAt: string; previousSha: string };

/** The landings a deploy window asks the clone about. */
export function deployLandings(landings: readonly GoalLanding[], changedAt: string): GoalLanding[] {
  const floor = Date.parse(changedAt) - LANDING_HORIZON_MS;
  return landings.filter((l) => l.onIntegration !== false && Date.parse(l.recordedAt) >= floor);
}

function deployWindow(
  head: ChangedHead,
  landings: readonly GoalLanding[],
  verdicts: DeployVerdicts | undefined,
): LinkWindow {
  const range = `${short(head.previousSha)}..${short(head.sha)}`;
  if (verdicts === undefined) return { known: false, why: `the clone was not asked about ${range}` };
  const goals = new Map<string, string[]>();
  for (const landing of deployLandings(landings, head.changedAt)) {
    const deployed = verdicts.deployed.get(landing.sha) ?? null;
    if (deployed === false) continue;
    const previous = deployed === null ? null : (verdicts.previous.get(landing.sha) ?? null);
    if (deployed === null || previous === null)
      return {
        known: false,
        why: verdicts.unanswered ?? `the clone could not place ${short(landing.sha)} against ${range}`,
      };
    if (previous) continue;
    goals.set(landing.goalRef, [...(goals.get(landing.goalRef) ?? []), landing.sha]);
  }
  return { known: true, goals, said: `the deploy window ${range}` };
}

/**
 * The goals with a landing the reach probe first found on the environment in the period before the
 * anchor. Undecided if any landing that could have been there is `unknown` or not yet asked about.
 */
export function arrivalWindow(input: {
  environment: string;
  anchor: number;
  lookbackMs: number;
  landings: readonly GoalLanding[];
  readings: readonly EnvironmentReading[];
}): LinkWindow {
  const reach = new Map(input.readings.filter((r) => r.environment === input.environment).map((r) => [r.sha, r]));
  const from = input.anchor - input.lookbackMs;
  const goals = new Map<string, string[]>();
  for (const landing of input.landings) {
    if (landing.onIntegration === false) continue;
    const recorded = Date.parse(landing.recordedAt);
    if (recorded > input.anchor) continue;
    const reading = reach.get(landing.sha);
    if (reading?.status === 'reached') {
      const at = Date.parse(reading.observedAt);
      if (at >= from && at <= input.anchor)
        goals.set(landing.goalRef, [...(goals.get(landing.goalRef) ?? []), landing.sha]);
      continue;
    }
    if (reading?.status === 'absent' || recorded < input.anchor - LANDING_HORIZON_MS) continue;
    return {
      known: false,
      why: `whether ${short(landing.sha)} is on ${input.environment} is ${reading === undefined ? 'not yet asked' : 'unknown'}`,
    };
  }
  return {
    known: true,
    goals,
    said: `the ${period(input.lookbackMs)} of arrivals on ${input.environment} before it`,
  };
}

function windowFor(view: AppErrorEnvironmentView, anchor: number, facts: LinkFacts): LinkWindow {
  if (heldAgainstDeploy(view.head, anchor))
    return deployWindow(view.head, facts.landings, facts.deploys.get(view.environment));
  return arrivalWindow({
    environment: view.environment,
    anchor,
    lookbackMs: ARRIVAL_LOOKBACK_MS,
    landings: facts.landings,
    readings: facts.readings,
  });
}

/** Every linked group's window, keyed by {@link groupId}: what the linker asks the clone to diff. */
export function linkWindows(payload: AppErrorsPayload, facts: LinkFacts): Map<string, LinkWindow> {
  const out = new Map<string, LinkWindow>();
  for (const view of payload.environments)
    for (const group of view.groups) {
      const anchor = linkAnchor(group, view.head, facts.now);
      if (anchor !== null) out.set(groupId(group), windowFor(view, anchor, facts));
    }
  return out;
}

export function groupId(group: { environment: string; fingerprint: string }): string {
  return `${group.environment}\u0000${group.fingerprint}`;
}

/** Fills `link` on every moved group of the payload. Nothing else in it changes. */
export function linkGroups(payload: AppErrorsPayload, facts: LinkFacts): void {
  const windows = linkWindows(payload, facts);
  for (const view of payload.environments)
    for (const group of view.groups) {
      const window = windows.get(groupId(group));
      if (window === undefined) continue;
      const anchor = linkAnchor(group, view.head, facts.now)!;
      group.link = decideLink({
        window,
        frames: group.frames,
        operation: group.operation,
        diffs: facts.diffs,
        titles: facts.titles,
        arrival: window.known ? testArrival(payload, group, anchor, window, facts) : null,
      });
    }
}

interface TestArrival {
  goalRef: string;
  environments: string[];
}

function testArrival(
  payload: AppErrorsPayload,
  group: AppErrorGroupView,
  anchor: number,
  here: Extract<LinkWindow, { known: true }>,
  facts: LinkFacts,
): TestArrival | null {
  const votes = new Map<string, string[]>();
  for (const view of payload.environments) {
    if (view.environment === group.environment) continue;
    const there = view.groups.find((g) => g.fingerprint === group.fingerprint);
    if (there === undefined || Date.parse(there.firstSeen) > anchor) continue;
    const window = arrivalWindow({
      environment: view.environment,
      anchor: Date.parse(there.firstSeen),
      lookbackMs: TEST_ARRIVAL_MS,
      landings: facts.landings,
      readings: facts.readings,
    });
    if (!window.known) continue;
    const narrowed = [...window.goals.keys()].filter((g) => here.goals.has(g));
    if (narrowed.length !== 1) continue;
    const goal = narrowed[0]!;
    votes.set(goal, [...(votes.get(goal) ?? []), view.environment]);
  }
  if (votes.size !== 1) return null;
  const [goalRef, environments] = [...votes][0]!;
  return { goalRef, environments };
}

type FrameEvidence =
  | { kind: 'none' }
  | { kind: 'unknown'; why: string }
  | { kind: 'one'; goalRef: string; files: string[]; others: number }
  | { kind: 'tied'; goalRefs: string[]; files: string[] };

function frameEvidence(
  frames: readonly string[],
  goals: ReadonlyMap<string, string[]>,
  diffs: ReadonlyMap<string, string[] | null>,
): FrameEvidence {
  const files = frameFiles(frames);
  if (files.length === 0) return { kind: 'none' };
  const touched = new Map<string, string[]>();
  for (const [goalRef, shas] of goals) {
    const changed: string[] = [];
    for (const sha of shas) {
      const paths = diffs.get(sha);
      if (paths === undefined || paths === null)
        return { kind: 'unknown', why: `the clone could not list what ${short(sha)} changed` };
      changed.push(...paths);
    }
    const hit = filesTouched(files, changed);
    if (hit.length > 0) touched.set(goalRef, hit);
  }
  if (touched.size === 0) return { kind: 'none' };
  const best = Math.max(...[...touched.values()].map((f) => f.length));
  const leaders = [...touched].filter(([, f]) => f.length === best);
  if (leaders.length === 1) {
    const [goalRef, hit] = leaders[0]!;
    return { kind: 'one', goalRef, files: hit, others: touched.size - 1 };
  }
  return {
    kind: 'tied',
    goalRefs: leaders.map(([g]) => g),
    files: [...new Set(leaders.flatMap(([, f]) => f))],
  };
}

interface LinkDecisionInput {
  window: LinkWindow;
  frames: readonly string[];
  operation: string | null;
  diffs: ReadonlyMap<string, string[] | null>;
  titles: ReadonlyMap<string, string>;
  arrival: TestArrival | null;
}

/** The link for one group, from its window and the evidence in it. Pure. */
export function decideLink(input: LinkDecisionInput): AppErrorLink {
  const { window } = input;
  if (!window.known) return unlinked(`No link: the window cannot be decided — ${window.why}.`, null);
  const n = window.goals.size;
  if (n === 0) return unlinked(`No goal is in ${window.said}.`, 0);
  const of = `of ${String(n)} goal${n === 1 ? '' : 's'} in ${window.said}`;
  const frames = frameEvidence(input.frames, window.goals, input.diffs);
  const arrival = input.arrival;
  if (frames.kind === 'one' || frames.kind === 'tied') return byFrames(frames, arrival, of, n);
  if (arrival !== null) {
    const unsure = frames.kind === 'unknown' ? ` (frames not matched: ${frames.why})` : '';
    return linked(arrival.goalRef, ['test-arrival'], `${capital(arrivalSaid(arrival))}, ${of}${unsure}.`, n);
  }
  if (frames.kind === 'unknown') return unlinked(`No link: ${frames.why}, ${of}.`, n);
  return byHint(input, window.goals, of, n);
}

function byFrames(
  frames: Extract<FrameEvidence, { kind: 'one' | 'tied' }>,
  arrival: TestArrival | null,
  of: string,
  n: number,
): AppErrorLink {
  if (frames.kind === 'one') {
    const sole = frames.others === 0;
    const said = `${files(frames.files)} ${sole ? 'changed only by' : 'changed most by'} ${label(frames.goalRef)}, ${of}`;
    if (arrival?.goalRef === frames.goalRef)
      return linked(frames.goalRef, ['frame-match', 'test-arrival'], `${said}; and ${arrivalSaid(arrival)}.`, n);
    const against = arrival === null ? '' : ` (test arrival pointed at ${label(arrival.goalRef)})`;
    return linked(frames.goalRef, ['frame-match'], `${said}${against}.`, n);
  }
  const tied = `${files(frames.files)} changed as much by ${frames.goalRefs.map(label).join(' as by ')}, ${of}`;
  if (arrival !== null && frames.goalRefs.includes(arrival.goalRef))
    return linked(arrival.goalRef, ['frame-match', 'test-arrival'], `${tied}; ${arrivalSaid(arrival)}.`, n);
  return { ...unlinked(`No link: ${tied}, and nothing else separates them.`, n), tied: frames.goalRefs };
}

function arrivalSaid(arrival: TestArrival): string {
  return `it first appeared on ${arrival.environments.join(' and ')} within a ${period(TEST_ARRIVAL_MS)} of ${label(arrival.goalRef)} reaching it`;
}

function byHint(input: LinkDecisionInput, goals: ReadonlyMap<string, string[]>, of: string, n: number): AppErrorLink {
  const hint = routeHint(input.operation, goals, input.titles);
  if (hint !== null)
    return linked(
      hint.goalRef,
      ['route-hint'],
      `A hint only: ${hint.words.map((w) => `“${w}”`).join(', ')} in ${input.operation ?? ''} matches the title of ${label(hint.goalRef)} alone, ${of}.`,
      n,
    );
  return unlinked(`Nothing in the error points at one ${of}.`, n);
}

const STOP_WORDS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'api',
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'add',
  'fix',
  'new',
]);

/** The words an operation or a title names, stemmed: ids, verbs and short tokens dropped. */
export function hintWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && /[a-z]/.test(w) && !/^[0-9a-f]{8,}$/.test(w) && !STOP_WORDS.has(w))
      .map(stem),
  );
}

function stem(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function routeHint(
  operation: string | null,
  goals: ReadonlyMap<string, string[]>,
  titles: ReadonlyMap<string, string>,
): { goalRef: string; words: string[] } | null {
  if (operation === null) return null;
  const asked = hintWords(operation);
  if (asked.size === 0) return null;
  const scored = [...goals.keys()].map((goalRef) => {
    const title = hintWords(titles.get(goalRef) ?? '');
    return { goalRef, words: [...asked].filter((w) => title.has(w)) };
  });
  const best = Math.max(0, ...scored.map((s) => s.words.length));
  const leaders = scored.filter((s) => s.words.length === best);
  return best > 0 && leaders.length === 1 ? leaders[0]! : null;
}

function linked(goalRef: string, how: AppErrorLinkHow[], why: string, candidates: number): AppErrorLink {
  return { goalRef, how, why, candidates, tied: [] };
}

function unlinked(why: string, candidates: number | null): AppErrorLink {
  return { goalRef: null, how: [], why, candidates, tied: [] };
}

function label(goalRef: string): string {
  const n = issueOriginNumber('root', goalRef);
  return n === null ? goalRef : `#${String(n)}`;
}

function files(paths: readonly string[]): string {
  const names = paths.map((p) => p.split('/').pop() ?? p);
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

function short(sha: string): string {
  return sha
    .split(' ')
    .map((s) => s.slice(0, 7))
    .join(' ');
}

function period(ms: number): string {
  const days = Math.round(ms / DAY_MS);
  return days === 1 ? 'day' : `${String(days)} days`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
