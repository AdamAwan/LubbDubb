import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import { graduationReading } from './graduation.js';

/**
 * The sweep that ends a graduation: what became of the documentation pull request
 * an operator opened for a claim (`docs/spec/27-knowledge.md#committing-to-the-repository`).
 *
 * **A landing is swept for, never hooked**, which is the argument
 * `docs/spec/24-environments.md#recording-a-landing` makes and which binds harder
 * here: a hook on the merge loses the landing to any restart that straddles it, or
 * to a person merging in the web UI between two pulses, and what is lost is a claim
 * that goes on being injected into every prompt forever — the exact cost this whole
 * subsystem exists to cap. It reads the **work graph** rather than the world for
 * the other half of the same reason: `closedPullRequests` forgets a merge after
 * `closedPrWindowMs` and the graph does not.
 *
 * It is a **writer** of facts and lives outside `src/dispatcher/` for
 * `src/knowledge/noticeDesk.ts`' reason exactly — `test/knowledge.test.ts` matches
 * this store's method names over that directory, so a writer put among the rules
 * fails the same assertion a reader does.
 *
 * The one thing it will not do is guess. A pull request the graph marks merged by
 * *inference* — it vanished from the world without ever being seen closed — is
 * `unknown`, and `unknown` settles nothing: acting on it would take a claim out of
 * every prompt for a pull request that may never have merged. That reading is drawn
 * on the page instead, where the operator can answer it.
 */
export class KnowledgeGraduationDesk {
  constructor(private readonly deps: { store: Store; errors?: ErrorRecorder }) {}

  run(): void {
    try {
      for (const graduation of this.deps.store.openGraduations()) {
        // The job's own subtree: the fold parents a pull request onto the job whose
        // branch carries it, so this is one query per graduation in flight and the
        // list is the operator's own clicks.
        const nodes = this.deps.store.listWorkSubtree(`job:${graduation.jobId}`);
        const pr = nodes.find((n) => n.kind === 'pr');
        // Stamped as soon as there is one, and before the verdict: a graduation that
        // lands and one that is closed unmerged both need the reference drawn, and
        // the graph's memory of *which job* produced a pull request is only as long
        // as the job list the fold reads.
        if (pr && graduation.prRef === null) this.deps.store.noteGraduationPr(graduation.id, pr.ref);
        const reading = graduationReading(graduation, nodes);
        if (reading === 'landed' || reading === 'abandoned') this.deps.store.settleGraduation(graduation.id, reading);
      }
    } catch (error) {
      // Recorded rather than thrown, `KnowledgeNoticeDesk`'s stance: this runs
      // inside the pulse, the next one re-reads the same graph, and nothing here
      // holds partial state to recover — each graduation is settled in its own
      // guarded transaction.
      this.deps.errors?.record({
        source: 'cycle',
        message: 'Could not sweep the knowledge graduations',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
