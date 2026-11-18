import { buildAskQueue, type AskInputs, type PrReadInputs } from '../asks/queue.js';
import { openHandledCount } from '../handled/handled.js';
import { prOnYouReasons } from '../listen/prsOnYou.js';
import type { SetupReading } from '../setup/reading.js';
import type { System } from '../system/system.js';
import type { Store } from '../store/store.js';
import type { CockpitState, DescriptionFeedback, StateSection, UndescribedPart } from '../wire.js';
import type { Reads } from './stateSnapshot.js';
import { once } from './stateReads.js';

// → docs/spec/16-http-api.md#sections

/**
 * Parts with a pull request open and no description written, which is the rail's ask. Read here
 * rather than derived in the cockpit: the described set is not on the wire. Open is the cut the
 * store cannot make. → docs/spec/07-pull-requests.md#the-rail-asks-for-it-and-nothing-waits-on-the-answer
 */
export function undescribedParts(store: Store, open: Set<number>): UndescribedPart[] {
  return store.prDescriptions.undescribedOpenParts().filter((part) => open.has(part.prNumber));
}

/** Checked descriptions that found something, on pull requests still open. → docs/spec/07-pull-requests.md#what-the-check-raises */
export function descriptionFeedback(store: Store, open: Set<number>): DescriptionFeedback[] {
  return store.prDescriptions.descriptionFeedback().filter((f) => open.has(f.prNumber));
}

/** The open escalations and the proposals. */
export function inbox(r: Reads): Pick<CockpitState, 'escalations' | 'proposals'> {
  return { escalations: r.openEscalations(), proposals: r.proposals };
}

/**
 * What the queue reads from each section, off the same reads the section is built from — taken only
 * where the reply did not already build that section, so a partial reply's asks are the full one's.
 */
const ASK_READS: Record<Exclude<StateSection, 'control' | 'asks' | 'listener'>, (r: Reads) => Partial<AskInputs>> = {
  harness: (r) => ({
    config: { watchLabel: r.watchLabel, desktopFolder: r.config.repoRoot },
    build: r.system.updates.reading(),
    fleetStall: r.system.fleetStall.reading(),
    recovery: r.system.recovery.pending(),
  }),
  goals: (r) => ({
    world: {
      takenAt: r.world.takenAt,
      pullRequests: r.openPullRequests(),
      closedPullRequests: r.world.closedPullRequests,
      issues: r.world.issues.map(r.enrichIssue),
    },
    archivedPullRequests: r.archivedPullRequests,
    retainedRuns: r.retainedRuns(),
  }),
  plans: (r) => ({
    plans: r.wirePlans,
    planParts: r.wirePlanParts(),
    undescribedParts: undescribedParts(r.store, r.openPrNumbers),
    descriptionFeedback: descriptionFeedback(r.store, r.openPrNumbers),
  }),
  fleet: (r) => ({
    tasks: r.history().tasks,
    agents: r.history().agents,
    parkedOnLimit: r.system.agents.limitedAgentIds(),
  }),
  queue: (r) => ({ jobs: r.store.jobs.listJobs(), upcoming: r.system.harness.upcoming }),
  inbox: (r) => ({ humanTasks: r.humanTasks, ...inbox(r) }),
  activity: (r) => ({ decisions: r.shiftLog }),
};

/** The open pull requests and the plans and goals they deliver, which is all `pr_read` reads. */
export function prReadInputs(r: Reads): PrReadInputs {
  return {
    world: {
      takenAt: r.world.takenAt,
      pullRequests: r.openPullRequests(),
      closedPullRequests: r.world.closedPullRequests,
      issues: r.world.issues,
    },
    plans: r.wirePlans,
    planParts: r.wirePlanParts(),
    archivedPullRequests: r.archivedPullRequests,
    retainedRuns: r.retainedRuns(),
    refUrls: r.refUrls,
  };
}

/** Every other section feeds the asks. → docs/spec/16-http-api.md#the-asks-section */
export function askInputs(r: Reads, want: ReadonlySet<StateSection>, out: Partial<CockpitState>): AskInputs {
  const inputs: Partial<AskInputs> = { ...out, refUrls: r.refUrls };
  for (const [section, read] of Object.entries(ASK_READS) as [StateSection, (r: Reads) => Partial<AskInputs>][]) {
    if (!want.has(section)) Object.assign(inputs, read(r));
  }
  return inputs as AskInputs;
}

/** The `asks` and `listener` sections, as `want` names them. → docs/spec/44-needs-you.md#the-wait */
export function askSections(
  system: System,
  r: Reads,
  want: ReadonlySet<StateSection>,
  out: Partial<CockpitState>,
  setup: SetupReading | null,
): Partial<Pick<CockpitState, 'asks' | 'handledOpen' | 'listener'>> {
  const asks = once(() => buildAskQueue(askInputs(r, want, out), setup));
  const section = want.has('asks') ? { asks: asks(), handledOpen: openHandledCount(system.store, Date.now()) } : {};
  if (!want.has('listener')) return section;
  const standingAsks = once(() => new Set(asks().flatMap((row) => (row.standing ? [row.id] : []))));
  const openPrs = once(() => new Map(r.openPullRequests().map((pr) => [pr.number, pr])));
  const listener = system.listener.view((item) => {
    if (item.kind === 'ask') return standingAsks().has(item.id);
    const pr = openPrs().get(item.number);
    return pr !== undefined && prOnYouReasons(pr).length > 0;
  });
  return { ...section, listener };
}
