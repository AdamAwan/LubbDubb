import type { AskInputs } from '../asks/queue.js';
import type { Store } from '../store/store.js';
import type { CockpitState, DescriptionFeedback, StateSection, UndescribedPart } from '../wire.js';
import { withheldAction, WITHHELD_PLAN } from './planReveal.js';
import type { Reads } from './stateSnapshot.js';

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

/** The open escalations and the proposals, with a plan still behind the reveal gate withheld. */
export function maskedInbox(r: Reads): Pick<CockpitState, 'escalations' | 'proposals'> {
  const { store, withheld } = r;
  return {
    escalations: store.escalations.listOpenEscalations().map((e) => {
      if (!withheld(e.context.planId)) return e;
      return {
        ...e,
        prompt: WITHHELD_PLAN,
        context: { ...e.context, detail: WITHHELD_PLAN, detailFrom: 'Withheld until the plan is revealed' },
      };
    }),
    proposals: r.proposals.map((p) => {
      if (!withheld(p.action.planId)) return p;
      return { ...p, action: withheldAction(p.action) };
    }),
  };
}

/**
 * What the queue reads from each section, off the same reads the section is built from — taken only
 * where the reply did not already build that section, so a partial reply's asks are the full one's.
 */
const ASK_READS: Record<Exclude<StateSection, 'control' | 'asks'>, (r: Reads) => Partial<AskInputs>> = {
  harness: (r) => ({
    config: { watchLabel: r.watchLabel, desktopFolder: r.config.repoRoot },
    build: r.system.updates.reading(),
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
  queue: (r) => ({ jobs: r.store.jobs.listJobs() }),
  inbox: (r) => ({ humanTasks: r.humanTasks, ...maskedInbox(r) }),
  activity: (r) => ({ decisions: r.shiftLog }),
};

/** Every other section feeds the asks. → docs/spec/16-http-api.md#the-asks-section */
export function askInputs(r: Reads, want: ReadonlySet<StateSection>, out: Partial<CockpitState>): AskInputs {
  const inputs: Partial<AskInputs> = { ...out, refUrls: r.refUrls };
  for (const [section, read] of Object.entries(ASK_READS) as [StateSection, (r: Reads) => Partial<AskInputs>][]) {
    if (!want.has(section)) Object.assign(inputs, read(r));
  }
  return inputs as AskInputs;
}
