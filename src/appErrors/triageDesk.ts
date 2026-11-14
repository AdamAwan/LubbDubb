import type { ErrorRecorder } from '../errorLog.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import { DAY_MS } from '../primitives.js';
import type { Store } from '../store/store.js';
import { isActiveTask } from '../tasks.js';
import type { AppErrorTriageRun, AppErrorTriageTrigger } from '../types.js';
import type { AppErrorsPayload } from '../wire.js';
import { groupId, linkAnchor } from './link.js';
import {
  episodeAnchor,
  episodeId,
  goalOfTicket,
  pickForTriage,
  triageBriefing,
  triageCandidates,
  triageSubject,
  TRIAGE_BATCH_LIMIT,
  unlinkedGroups,
  type TriageBriefEntry,
  type UnlinkedGroup,
} from './triage.js';

// → docs/spec/39-app-errors.md#agent-triage

const ALREADY_OUT = 'a triage run is already out; press again when it ends';

/** Settled runs are kept this long, for the record of what was asked. */
const RUN_RETENTION_MS = 30 * DAY_MS;

interface LinkedReader {
  readLinked(now: number): Promise<{ payload: AppErrorsPayload; answered: boolean }>;
}

interface AppErrorTriageDeskDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  /** `appErrorTriagePerDay`, read live: the groups automatic runs may put in front of an agent each UTC day. */
  perDay: () => number;
  current: LinkedReader;
  /** The view without links: whether any moved episode is unanswered, asked before the clone is. */
  view: () => AppErrorsPayload;
  /** What the linker already holds for a commit; never a question to the clone. */
  knownChangedFiles: (sha: string) => string[] | null;
  errors?: ErrorRecorder;
  now?: () => number;
}

export type TriageRequestOutcome =
  { ok: true; run: AppErrorTriageRun } | { ok: false; status: 404 | 409 | 422; refusal: string };

/**
 * Opens triage runs over the moved groups the deterministic linker left without a goal. The pulse
 * never waits on it: a pass starts an assembly — which awaits the shared linked read, the clone's
 * five seconds included — and returns; the run lands in the store when the read does, and is
 * dispatched on a later pulse.
 */
export class AppErrorTriageDesk {
  private readonly now: () => number;
  private assembling: Promise<TriageRequestOutcome | null> | null = null;
  /** What the store looked like when an assembly last found nothing to open: unchanged, it is not asked again. */
  private quiet: string | null = null;

  constructor(private readonly deps: AppErrorTriageDeskDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** @public called by the pulse, directly below `appErrorTracker`. Starts the assembly it owes and does not wait. */
  run(): void {
    this.settle();
    if (this.assembling !== null || this.deps.perDay() <= 0) return;
    if (!this.deps.environments.some((e) => e.errors !== undefined)) return;
    if (this.deps.store.appErrorTriage.openRunNow() !== null) return;
    const mark = this.mark();
    if (mark === this.quiet) return;
    this.assembling = this.assemble()
      .then((outcome) => {
        if (outcome === null) this.quiet = mark;
        return outcome;
      })
      .catch((err: unknown) => {
        this.deps.errors?.record({
          source: 'cycle',
          message: `assembling an app error triage run failed: ${(err as Error).message}`,
        });
        return null;
      })
      .finally(() => (this.assembling = null));
  }

  /** @public resolves once the assembly a pass started has landed; tests read the store after it */
  async settled(): Promise<void> {
    await this.assembling;
  }

  /** The operator's Triage press: one group, whatever its link, the cap or an earlier verdict on it. */
  async request(environment: string, fingerprint: string): Promise<TriageRequestOutcome> {
    const { store } = this.deps;
    this.settle();
    if (store.appErrorTriage.openRunNow() !== null) return { ok: false, status: 409, refusal: ALREADY_OUT };
    const { payload } = await this.deps.current.readLinked(this.now());
    const view = payload.environments.find((e) => e.environment === environment);
    const group = view?.groups.find((g) => g.fingerprint === fingerprint);
    if (view === undefined || group === undefined) return { ok: false, status: 404, refusal: 'no such error group' };
    const anchor = episodeAnchor(group, view.head);
    if (anchor === null)
      return {
        ok: false,
        status: 422,
        refusal: `this group is ${group.ignored ? 'ignored' : group.state}: only a group that moved has an episode to triage`,
      };
    const run = this.open('operator', [{ group, head: view.head, anchor }]);
    return run === null ? { ok: false, status: 409, refusal: ALREADY_OUT } : { ok: true, run };
  }

  private settle(): void {
    const { store } = this.deps;
    const open = store.appErrorTriage.openRunNow();
    if (open?.status !== 'dispatched' || open.taskId === null) return;
    const task = store.tasks.getTask(open.taskId);
    if (task === null || !isActiveTask(task)) store.appErrorTriage.settleRun(open.id);
  }

  /** The reads, the last run and the day: an assembly that found nothing is asked again only once one moves. */
  private mark(): string {
    const { store } = this.deps;
    const last = store.appErrorTriage.lastRun();
    return [
      ...store.appErrors.listReads().map((r) => `${r.environment}@${r.readAt}`),
      `run ${last?.id ?? ''}:${last?.status ?? ''}`,
      `day ${dayStart(this.now())}`,
      `cap ${String(this.deps.perDay())}`,
    ].join('\n');
  }

  private async assemble(): Promise<TriageRequestOutcome | null> {
    const { store } = this.deps;
    const now = this.now();
    const held = new Set(store.appErrors.listGroupIds().map(groupId));
    store.appErrorTriage.prune(new Date(now - RUN_RETENTION_MS).toISOString(), held);
    const used = store.appErrorTriage.autoSubjectsSince(dayStart(now));
    const room = Math.min(TRIAGE_BATCH_LIMIT, this.deps.perDay() - used);
    if (room <= 0) return null;
    const done = new Set(store.appErrorTriage.listTriages().map(episodeId));
    if (pickForTriage(unlinkedGroups(this.deps.view()), done, 1).length === 0) return null;
    const { payload, answered } = await this.deps.current.readLinked(now);
    if (!answered) return null;
    const chosen = pickForTriage(unlinkedGroups(payload), done, room);
    if (chosen.length === 0) return null;
    const run = this.open('auto', chosen);
    return run === null ? null : { ok: true, run };
  }

  private open(trigger: AppErrorTriageTrigger, groups: readonly UnlinkedGroup[]): AppErrorTriageRun | null {
    const { store } = this.deps;
    const now = this.now();
    const landings = store.environments.listGoalLandings();
    const titles = new Map(store.graph.listWorkNodes().map((n) => [n.ref, n.title]));
    const entries = groups.map(({ group, head, anchor }): TriageBriefEntry => {
      const at = linkAnchor(group, head, now) ?? now;
      const prime = group.state === 'returned' ? goalOfTicket(group.tracker?.ticketRef ?? null) : null;
      const candidates = triageCandidates({
        anchor: at,
        frames: group.frames,
        landings,
        titles,
        diff: (sha) => this.deps.knownChangedFiles(sha),
        prime,
      });
      return { group, anchor, candidates };
    });
    return store.appErrorTriage.openRun({
      trigger,
      subjects: entries.map(triageSubject),
      briefing: triageBriefing(entries),
    });
  }
}

function dayStart(now: number): string {
  return new Date(Math.floor(now / DAY_MS) * DAY_MS).toISOString();
}
