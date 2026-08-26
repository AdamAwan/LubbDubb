import { claimKey, claimOverlap, claimsSimilar } from '../claims.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { KnowledgeFact } from '../types.js';

/**
 * The pass that suggests two agents wrote down one claim
 * (`docs/spec/27-knowledge.md#one-claim-written-two-ways`).
 *
 * Agreement is what carries a claim out of one agent's head, and `claimsMatch` —
 * equality or whole-word containment over a character floor — answers yes for a
 * restatement that appends a qualifier and no for everything else. Two agents who
 * hit one wall and wrote it down in their own words are everything else. What that
 * costs is not the duplicate row, which is cheap: it is that **the gate never
 * fires**, so both claims sit at `proposal` with one voice each, reaching nobody,
 * and the fleet re-learns the same wall a third time.
 *
 * **It writes suggestions and nothing else.** No claim is joined, promoted, merged
 * or barred here; the rows go to `knowledge_similarities`, the page draws a cluster
 * and an operator's click is what moves anything. `claimsMatch` is untouched and
 * stays what `proposeFact` joins on and what the rejection bar is enforced by —
 * two functions, one strict and one advisory, is what keeps a suggestion from
 * being enforcement.
 *
 * It writes facts about facts and reads no world; **nothing reads what it writes
 * except the cockpit**. It is not in `src/dispatcher/` for
 * {@link KnowledgeNoticeDesk}'s reason, and `test/knowledge.test.ts` holds the
 * whole directory to that.
 */
export class KnowledgeClusterDesk {
  /** When the last pass ran, so a pulse is not a comparison of every proposal against every other. */
  private lastRunAt = 0;

  constructor(
    private readonly deps: { store: Store; errors?: ErrorRecorder; now?: () => number },
    private readonly intervalMs: number = CLUSTER_INTERVAL_MS,
  ) {}

  /**
   * One pass over the `proposal` set, on its own cadence.
   *
   * **Not every pulse**, which is the one thing about this that is not free: the
   * comparison is every proposal against every other within its scope, and the
   * proposal set is the part of the store that grows. A pulse is seconds and a
   * cluster is a suggestion nobody is waiting on, so the reading is taken on a
   * clock of its own rather than made a per-pulse cost that nothing measures.
   */
  run(): void {
    const now = (this.deps.now ?? Date.now)();
    if (now - this.lastRunAt < this.intervalMs) return;
    this.lastRunAt = now;
    try {
      this.deps.store.recordSimilarities(similarPairs(this.deps.store.listFacts(CLUSTER_READ_LIMIT)));
    } catch (err) {
      // Recorded rather than thrown, `KnowledgeNoticeDesk`'s stance: this runs
      // inside the pulse, and a suggestion nobody asked for must not be able to
      // stop the harness.
      this.deps.errors?.record({
        source: 'cycle',
        message: 'Could not cluster the knowledge proposals',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * How often the pass runs. Ten minutes because a cluster is a suggestion an
 * operator meets when they open the page, and nothing waits on one.
 */
const CLUSTER_INTERVAL_MS = 600_000;

/**
 * How many claims the pass reads. The bound `askFacts` and the block renderer both
 * take, for their reason: a pass with no bound is a pass whose cost is the store's
 * whole history.
 */
const CLUSTER_READ_LIMIT = 500;

/**
 * Every pair of live proposals within one scope that look like one claim.
 *
 * **Scope is part of the match, as it is everywhere else here**: the same sentence
 * about one check and about the fleet are two claims — they carry different costs
 * to be wrong and are delivered to different agents — so a cluster never crosses
 * that line.
 *
 * **`proposal` and nothing else.** A claim that already reaches somebody has been
 * ruled on or carried by agreement, and offering to fold it into another claim is
 * offering to take what the fleet is being told and hide it inside something else.
 * What this pass is for is the half of the store that answers no question.
 *
 * Pure, and exported for the test that holds it against `claimsMatch`.
 */
export function similarPairs(facts: readonly KnowledgeFact[]): { leftId: string; rightId: string; score: number }[] {
  const proposals = facts.filter((fact) => fact.reach === 'proposal');
  const keys = new Map(proposals.map((fact) => [fact.id, claimKey(fact.claim)]));
  const pairs: { leftId: string; rightId: string; score: number }[] = [];
  for (let i = 0; i < proposals.length; i += 1) {
    for (let j = i + 1; j < proposals.length; j += 1) {
      const left = proposals[i]!;
      const right = proposals[j]!;
      if (left.scope !== right.scope) continue;
      const a = keys.get(left.id)!;
      const b = keys.get(right.id)!;
      // What `claimsMatch` already joins is not a suggestion: those two are one row
      // in the store, so a pair here would offer a merge of a claim with itself.
      if (!claimsSimilar(a, b)) continue;
      // `listFacts` is newest-first or oldest-first depending on nothing this
      // function should depend on, so the older id is chosen here — one likeness is
      // one row however the set was walked.
      const older = new Date(left.createdAt).getTime() <= new Date(right.createdAt).getTime() ? left : right;
      const newer = older === left ? right : left;
      pairs.push({ leftId: older.id, rightId: newer.id, score: claimOverlap(a, b) });
    }
  }
  return pairs;
}
