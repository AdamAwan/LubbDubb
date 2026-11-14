import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';
import { utcDay } from '../primitives.js';
import type { StoredDetailRead, StoredTriage, TriageEpisode } from '../store/appErrorTriage.js';
import type {
  AppErrorRead,
  AppErrorState,
  AppErrorTriage,
  AppErrorTriageRun,
  AppErrorTriageSubject,
  DeployedHead,
  GoalLanding,
} from '../types.js';
import type { AppErrorGroupView, AppErrorsPayload } from '../wire.js';
import { filesTouched, frameFiles } from './frames.js';
import { LANDING_HORIZON_MS } from './link.js';
import { MOVED, STATE_RANK, type MovedState } from './states.js';

// → docs/spec/39-app-errors.md#agent-triage

/** The most groups one triage agent is handed. */
export const TRIAGE_BATCH_LIMIT = 10;

/** The most candidate goals and changed paths a group's briefing lists. */
const MAX_CANDIDATES = 40;
const MAX_FILES = 30;

/**
 * The instant a moved group's episode is anchored at, as text: `new` from its first sighting, `returned`
 * from its return, `spiking` from the deploy it spiked after — and, for a spike with no deploy on record,
 * the empty string, so the episode does not move with the clock the way the link's own anchor does.
 * Null for a group that has no episode: muted, steady, gone.
 */
export function episodeAnchor(group: AppErrorGroupView, head: DeployedHead | null): string | null {
  if (group.ignored || !MOVED.has(group.state)) return null;
  if (group.state === 'new') return group.firstSeen;
  if (group.state === 'returned') return group.returnedAt;
  return head?.changedAt ?? '';
}

export function episodeId(e: TriageEpisode): string {
  return [e.environment, e.fingerprint, e.state, e.anchor].join('\u0000');
}

/** A moved group the deterministic link left without a goal, with its episode. */
export interface UnlinkedGroup {
  group: AppErrorGroupView;
  head: DeployedHead | null;
  anchor: string;
}

/** Every moved, unmuted group of a linked payload whose link names no goal — undecided and tied included. */
export function unlinkedGroups(payload: AppErrorsPayload): UnlinkedGroup[] {
  const out: UnlinkedGroup[] = [];
  for (const view of payload.environments)
    for (const group of view.groups) {
      const anchor = episodeAnchor(group, view.head);
      if (anchor === null || (group.link?.goalRef ?? null) !== null) continue;
      out.push({ group, head: view.head, anchor });
    }
  return out;
}

/**
 * The groups an automatic run takes: never an episode already answered, one group per key, the most
 * moved first and then the most frequent.
 */
export function pickForTriage(
  groups: readonly UnlinkedGroup[],
  answered: ReadonlySet<string>,
  limit: number,
): UnlinkedGroup[] {
  const keys = new Set<string>();
  const out: UnlinkedGroup[] = [];
  const ordered = [...groups].sort(
    (a, b) => STATE_RANK[a.group.state] - STATE_RANK[b.group.state] || b.group.count - a.group.count,
  );
  for (const g of ordered) {
    if (out.length >= limit) break;
    if (keys.has(g.group.key) || answered.has(episodeId(episodeOf(g)))) continue;
    keys.add(g.group.key);
    out.push(g);
  }
  return out;
}

function episodeOf(g: UnlinkedGroup): TriageEpisode {
  return { environment: g.group.environment, fingerprint: g.group.fingerprint, state: g.group.state, anchor: g.anchor };
}

/** One goal a group's briefing offers as a possible cause. */
export interface TriageCandidate {
  goalRef: string;
  title: string | null;
  /** The latest of its landings in the period. */
  landedAt: string | null;
  /** What its landings changed, where the linker's cache holds every one of them; null where it does not. */
  files: string[] | null;
  /** The group's frame files its changes touched. */
  touched: string[];
  /** The goal of the group's tracker ticket: for a returned group, the fix that did not hold. */
  prime: boolean;
}

/** The goal a tracker ticket is: the fleet works a bug as its own goal, so it is the ticket's own ref. */
export function goalOfTicket(ticketRef: string | null): string | null {
  const n = issueOriginNumber('root', ticketRef);
  return n === null ? null : issueOriginRef('root', n);
}

/**
 * The wider list the agent chooses from: every goal with a landing on the integration branch in the
 * thirty days before the anchor, latest first — and, for a returned group, its tracker ticket's goal,
 * first, wherever it landed. Changed paths come only from what the linker already holds.
 */
export function triageCandidates(input: {
  anchor: number;
  frames: readonly string[];
  landings: readonly GoalLanding[];
  titles: ReadonlyMap<string, string>;
  diff: (sha: string) => string[] | null;
  prime: string | null;
}): TriageCandidate[] {
  const from = input.anchor - LANDING_HORIZON_MS;
  const byGoal = new Map<string, GoalLanding[]>();
  for (const l of input.landings) {
    if (l.onIntegration === false) continue;
    const at = Date.parse(l.recordedAt);
    const inPeriod = at >= from && at <= input.anchor;
    if (!inPeriod && l.goalRef !== input.prime) continue;
    byGoal.set(l.goalRef, [...(byGoal.get(l.goalRef) ?? []), l]);
  }
  if (input.prime !== null && !byGoal.has(input.prime)) byGoal.set(input.prime, []);
  const files = frameFiles(input.frames);
  const out = [...byGoal].map(([goalRef, landed]): TriageCandidate => {
    const diffs = landed.map((l) => input.diff(l.sha));
    const known = landed.length > 0 && diffs.every((d) => d !== null);
    const changed = known ? [...new Set(diffs.flatMap((d) => d ?? []))] : null;
    return {
      goalRef,
      title: input.titles.get(goalRef) ?? null,
      landedAt:
        landed
          .map((l) => l.recordedAt)
          .sort()
          .at(-1) ?? null,
      files: changed,
      touched: changed === null ? [] : filesTouched(files, changed),
      prime: goalRef === input.prime,
    };
  });
  return out
    .sort(
      (a, b) =>
        Number(b.prime) - Number(a.prime) ||
        b.touched.length - a.touched.length ||
        (b.landedAt ?? '').localeCompare(a.landedAt ?? ''),
    )
    .slice(0, MAX_CANDIDATES);
}

/** What one group's section of a briefing is drawn from. */
export interface TriageBriefEntry {
  group: AppErrorGroupView;
  anchor: string;
  candidates: TriageCandidate[];
}

export function triageSubject(entry: TriageBriefEntry): AppErrorTriageSubject {
  const { group } = entry;
  return {
    key: group.key,
    environment: group.environment,
    fingerprint: group.fingerprint,
    state: group.state,
    anchor: entry.anchor,
    candidates: entry.candidates.map((c) => c.goalRef),
  };
}

const ANCHOR_SAID: Record<MovedState, string> = {
  new: 'first seen',
  returned: 'came back',
  spiking: 'the deploy it spiked after',
};

/**
 * The groups, appended to the rendered prompt, then the query each of their environments was read with.
 * Never a message or a stack: the agent asks for those.
 */
export function triageBriefing(
  entries: readonly TriageBriefEntry[],
  context: { readings?: readonly AppErrorRead[]; detailQueries?: ReadonlySet<string> } = {},
): string {
  const readings = context.readings ?? [];
  const detail = context.detailQueries ?? new Set<string>();
  const sections = entries.map((e) => entrySection(e, detail.has(e.group.environment)));
  const groups = `\n\n## The error groups (${String(entries.length)})\n\n${sections.join('\n\n')}`;
  const named = new Set(entries.map((e) => e.group.environment));
  const queries = readings.filter((r) => named.has(r.environment) && (r.query !== null || r.queryLink !== null));
  if (queries.length === 0) return groups;
  return `${groups}\n\n## How these errors were found\n\n${queries.map(querySection).join('\n\n')}`;
}

function querySection(reading: AppErrorRead): string {
  const lines = [`### ${reading.environment}`];
  if (reading.queryLink !== null) lines.push('', `Open it in the telemetry: ${reading.queryLink}`);
  if (reading.query !== null) {
    const fence = '`'.repeat(Math.max(3, ...[...reading.query.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    lines.push('', 'The query the errors command ran:', '', fence, reading.query, fence);
  }
  return lines.join('\n');
}

function entrySection({ group, anchor, candidates }: TriageBriefEntry, detailQuery: boolean): string {
  const link = group.link;
  const lines = [
    `### ${group.key} — ${group.title}`,
    '',
    ...groupFacts(group, anchor, detailQuery),
    '',
    '#### Frames',
    '',
    group.frames.length === 0 ? 'None reported.' : group.frames.map((f) => `- \`${f}\``).join('\n'),
    '',
    '#### What the deterministic link found',
    '',
    link === null ? 'It was not linked.' : link.why,
    ...(link !== null && link.tied.length > 0 ? ['', `Tied between: ${link.tied.join(', ')}.`] : []),
    ...(group.tracker === null || group.tracker.ticketRef === null
      ? []
      : [
          '',
          `Its tracker ticket: ${group.tracker.ticketRef} (${group.tracker.status}${group.tracker.note === null ? '' : `, ${group.tracker.note}`}).`,
        ]),
    '',
    '#### Candidate goals',
    '',
    candidates.length === 0
      ? 'No goal landed on the integration branch in the thirty days before the anchor.'
      : candidates.map(candidateLine).join('\n'),
  ];
  return lines.join('\n');
}

function groupFacts(group: AppErrorGroupView, anchor: string, detailQuery: boolean): string[] {
  return [
    `- Environment: ${group.environment}`,
    `- State: ${group.state}, anchored at ${anchor === '' ? 'no deploy on record (the last day)' : anchor} (${ANCHOR_SAID[group.state as MovedState]})`,
    `- Occurrences over the retained fortnight: ${String(group.count)}; first seen ${group.firstSeen}, last seen ${group.lastSeen}`,
    ...(group.spike === null
      ? []
      : [`- Rate: ${String(group.spike.perDay)} a day against ${String(group.spike.baselinePerDay)} usual`]),
    `- Operation: ${group.operation ?? '(none reported)'}`,
    `- Version: ${group.version ?? '(none reported)'}`,
    `- Stored sample message and stack: ${group.hasDetail ? 'yes — app_error_detail returns them' : 'none'}`,
    ...(detailQuery
      ? [`- Detail query: declared on ${group.environment} — app_error_detail runs it for this group`]
      : []),
    ...(group.url === null ? [] : [`- In the telemetry: ${group.url}`]),
  ];
}

function candidateLine(c: TriageCandidate): string {
  const head = `- ${c.goalRef}${c.title === null ? '' : ` — ${c.title}`}`;
  const prime = c.prime ? ' — **the goal of its tracker ticket: the fix that did not hold is the prime suspect**' : '';
  const landed = c.landedAt === null ? ' — no landing recorded' : ` — landed ${utcDay(c.landedAt)}`;
  const touched = c.touched.length === 0 ? '' : ` — changed the frame file(s) ${c.touched.join(', ')}`;
  return `${head}${prime}${landed}${touched}${changedPaths(c)}`;
}

function changedPaths(c: TriageCandidate): string {
  if (c.files === null)
    return c.landedAt === null ? '' : '\n  - changed paths: not listed (the clone has not answered for its commits)';
  if (c.files.length === 0) return '\n  - changed paths: none';
  const more = c.files.length > MAX_FILES ? `, and ${String(c.files.length - MAX_FILES)} more` : '';
  return `\n  - changed paths: ${c.files.slice(0, MAX_FILES).join(', ')}${more}`;
}

/**
 * Folds each group's triage onto the payload, by its current episode: the verdict for it, whether a
 * run holding it is still out, and when its stored detail was last read by a triage agent.
 */
export function withTriage(
  payload: AppErrorsPayload,
  input: {
    triages: readonly StoredTriage[];
    reads: readonly StoredDetailRead[];
    open: AppErrorTriageRun | null;
  },
): AppErrorsPayload {
  const verdicts = new Map(input.triages.map((t) => [episodeId(t), t]));
  const reads = new Map(input.reads.map((r) => [episodeId(r), r]));
  const queued = new Set((input.open?.subjects ?? []).map(episodeId));
  return {
    ...payload,
    environments: payload.environments.map((env) => ({
      ...env,
      groups: env.groups.map((g) => {
        const anchor = episodeAnchor(g, env.head);
        if (anchor === null) return { ...g, triage: null };
        const id = episodeId({ environment: g.environment, fingerprint: g.fingerprint, state: g.state, anchor });
        const stored = verdicts.get(id);
        const waiting = queued.has(id) && stored?.runId !== input.open?.id;
        return { ...g, triage: triageOf(stored, waiting, reads.get(id) ?? null) };
      }),
    })),
  };
}

function triageOf(
  stored: StoredTriage | undefined,
  queued: boolean,
  read: StoredDetailRead | null,
): AppErrorTriage | null {
  if (stored === undefined && !queued && read === null) return null;
  return { ...verdictOf(stored), queued, detailReadAt: read?.at ?? null, detailQuery: read?.query ?? null };
}

function verdictOf(
  stored: StoredTriage | undefined,
): Pick<AppErrorTriage, 'verdict' | 'goalRef' | 'confidence' | 'reason' | 'at'> {
  if (stored === undefined) return { verdict: null, goalRef: null, confidence: null, reason: null, at: null };
  const { verdict, goalRef, confidence, reason, at } = stored;
  return { verdict, goalRef, confidence, reason, at };
}
