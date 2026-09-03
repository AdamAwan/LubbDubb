import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { WorldSnapshot } from '../types.js';
import { gateKeys } from './keys.js';
import { harnessSightings } from './voice.js';
import { buildObstacleWorld, reportedChecks } from './world.js';

/**
 * The desk that records the harness's own voice on the obstacle board.
 *
 * **A harness voice is a sighting like any other**, written through
 * `Store.recordObstacleSighting` and attributed to the harness rather than to a
 * goal — no agent, no task, no session and no goal ref, and the transition it saw
 * in their place. That is what makes an obstacle the harness can see `standing`
 * from the **first** agent's report, and it is what makes the two-goal gate safe
 * on a fleet too small for two agents to hit one wall in the same afternoon.
 *
 * **It decides nothing.** What was seen is {@link harnessSightings}' answer over
 * the pair of snapshots; this puts the one key that reading yields through the
 * same three gates an agent's report goes through, and files.
 *
 * On the pulse and not in `src/dispatcher/` for the notice desk's reason: it
 * staffs nobody, holds nothing, and no rule reads what it writes.
 * → `docs/spec/32-obstacles.md#the-harness-is-a-voice`
 */
export class ObstacleVoiceDesk {
  constructor(private readonly deps: { store: Store; errors?: ErrorRecorder }) {}

  /**
   * One pass over what the world has just done.
   *
   * Handed the **pair** the diff is taken from, which is why the pulse skips it on
   * a local cycle: a local cycle re-serves the reading the last real one took, so
   * run with `previousWorld === world` it would read every transition as new or as
   * none, depending only on which snapshot object it was handed.
   */
  run(prev: WorldSnapshot | null, next: WorldSnapshot): void {
    try {
      const sightings = harnessSightings(prev, next);
      if (sightings.length === 0) return;
      const reported = reportedChecks(next);
      const held = this.checkKeysHeld();
      for (const seen of sightings) {
        // **The board already holding this check is the end of it.** A `check` key
        // never binds on its own, and the harness gets no exemption from that — so
        // a second report naming only this check could not join the row that holds
        // it, and would file a *keyless* duplicate instead: a row nothing can
        // deliver, match or ever end. Silence is the honest answer, and the row is
        // already there for the first agent's locating report to carry to
        // `standing`. → `docs/spec/32-obstacles.md#a-key-alone-is-not-always-enough`
        if (held.has(seen.checkName)) continue;
        // The gates, run against the harness's own reading. `dispatchChecks` is the
        // grounding set, and for a report with no dispatch behind it that is the
        // check the transition was seen on: grounding asks whether a key is
        // consistent with what the harness already knows, and here the harness's
        // reading *is* what it knows.
        const world = buildObstacleWorld({
          reported,
          dispatchChecks: [seen.checkName],
          // No branch and no tree: the report offers one check key and nothing
          // else, so there is nothing for either to be asked about.
          branchPaths: [],
          repoRoot: null,
        });
        // Gated but never *extracted*. Extraction is a language judgement over an
        // agent's prose; the harness's key is not read out of a sentence, it is the
        // reading itself — and a prose pass over the harness's own words would
        // happily turn a branch name into a `path` key that the check beside it
        // then grounds.
        const keys = gateKeys([{ kind: 'check', value: seen.checkName }], world);
        if (!keys.some((key) => key.kind === 'check' && key.binds)) continue;
        this.deps.store.recordObstacleSighting(
          // Something broken now, which a fix ends — the whole of what an obstacle
          // is, and the one thing the harness can answer about its own reading.
          // No clock: `until` is the *reporter's* estimate of how transient this
          // is, and the harness makes none. Decay ends what nothing re-reports.
          { what: seen.what, kind: 'obstacle', keys, untilHours: null },
          {
            agentId: null,
            taskId: null,
            goalRef: null,
            sessionId: null,
            // Which transition it saw, which is the identity of this voice.
            transition: seen.transition,
            words: seen.words,
            // Nothing to disclaim: the question is asked of an agent because
            // answering it is the intervention, and the harness has no goal whose
            // own doing this might be.
            whyNotMine: null,
          },
        );
        held.add(seen.checkName);
      }
    } catch (err) {
      // Never into the cycle, the other obstacle desks' rule: a pass that could
      // fail a pulse is a pass an operator turns off, and then the fleet is back to
      // paying twice for a reading the world model already took.
      this.deps.errors?.record({
        source: 'cycle',
        message: `Recording the harness's own obstacle sightings failed: ${(err as Error).message}`,
      });
    }
  }

  /** Every check name the board already has a key for, whatever state its row is in. */
  private checkKeysHeld(): Set<string> {
    const out = new Set<string>();
    for (const obstacle of this.deps.store.listObstacles())
      for (const key of this.deps.store.listObstacleKeys(obstacle.id)) if (key.kind === 'check') out.add(key.value);
    return out;
  }
}
