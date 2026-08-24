import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { buildNeedsYou, type NeedRow } from '../web/src/view/needsYou.js';
import { failPlanningOpen } from './support/plans.js';

/**
 * A dispatch that is refused on every pulse used to be invisible.
 *
 * The refusal itself is correct — `WorktreeManager.ensure` will not lease a
 * branch a checkout outside the pool is standing on, and it will not invent a
 * slot an exhausted pool does not have — but every trace of it stopped at a
 * `decisions` row nothing draws: no error is recorded, no escalation is raised,
 * and `abandonUnstarted` settles the attempt's task `interrupted`. So a fleet
 * stuck on one presents as a fleet with nothing to do.
 *
 * The worktree manager is **injected** for the usual reason — without it the
 * dispatch cuts a real branch in whatever checkout the suite is running in — and
 * here it is also the subject: the refusal is what these tests stage. The stream
 * spawner is injected for the same class of reason: the default `agentMode` is
 * `stream`, so the pulse that finally gets through would otherwise launch a real
 * `claude`.
 */

/**
 * A pool that refuses every branch lease, in the words the real one uses for a
 * checkout it cannot take — until {@link relent}, which is the operator switching
 * their own checkout off the branch.
 *
 * Only `ensure` refuses. `ensureReadOnly` hands out a slot as usual, which is
 * what a checkout standing on one branch actually does to the rest of the pool —
 * and it keeps the read-only dispatches out of the origin these tests count.
 */
class RefusingWorktrees extends FakeWorktreeManager {
  private refusing = true;

  /** The operator has moved what was in the way; leases go through again. */
  relent(): void {
    this.refusing = false;
  }

  override ensure(branch: string, base?: string): Promise<string> {
    if (!this.refusing) return super.ensure(branch, base);
    return Promise.reject(
      new Error(
        `Cannot lease a worktree for ${branch}: it is already checked out at D:\\_git\\${branch}, which is not a ` +
          `pool slot (the pool is C:\\pool). Git refuses to check one branch out twice, and this checkout is not ` +
          `the harness's to switch. Switch it to another branch and the dispatch goes through on the next pulse.`,
      ),
    );
  }
}

/** A `claude` that says nothing and never exits — enough for a dispatch to have started. */
class SilentChild extends EventEmitter implements StreamChild {
  pid = 4242;
  stdout = { on: () => {} } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: () => {}, end: () => {} } as unknown as NodeJS.WritableStream;
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {}
}

function refusingSystem(worktrees: FakeWorktreeManager): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-refusal-'));
  const spawner: Spawner = () => new SilentChild();
  return buildSystem(
    loadConfig({
      labelPrefix: '',
      dbPath: ':memory:',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      // The funnel in front of pickup defaults on; this file is about what the
      // executor does with a dispatch, not about the gates in front of one.
      auth: { enabled: false } as never,
    }),
    { worktrees, streamSpawner: spawner, errorMirror: () => {} },
  );
}

/** How many pulses running have refused a dispatch for this origin. */
function refusals(system: System, origin: string): number {
  return system.store.listDecisions(200).filter((d) => d.outcome === 'rejected' && d.action.originRef === origin)
    .length;
}

/**
 * Pulse until the origin has been refused `n` times.
 *
 * A loop rather than `n` cycles, because a pulse chooses one action and the
 * pipeline has other rules with an opinion about a fresh goal — which of them
 * wins on any given pulse is not what these tests are about.
 */
async function pulseTo(system: System, origin: string, n: number): Promise<void> {
  for (let i = 0; i < 30 && refusals(system, origin) < n; i += 1) await system.harness.runCycle('manual');
  assert.equal(refusals(system, origin), n, `the fleet reached ${n} refusals for ${origin}`);
}

/** Whether a dispatch for this origin has since started an agent. */
function dispatched(system: System, origin: string): boolean {
  return system.store
    .listDecisions(200)
    .some((d) => d.outcome === 'executed' && d.action.originRef === origin && d.action.type === 'dispatch_code_agent');
}

async function refusalRow(system: System, origin: string): Promise<NeedRow | undefined> {
  return buildNeedsYou(await buildStateSnapshot(system)).find((r) => r.id === `dispatch:${origin}`);
}

test('a dispatch refused on every pulse reaches the operator, and one bad pulse does not', async () => {
  const system = refusingSystem(new RefusingWorktrees());
  system.connector.inject({ kind: 'new_issue', number: 901, title: 'Add login' });
  failPlanningOpen(system.store, 901);

  // One bad pulse is not news. A slot is held from `ensure` until the agent's
  // process is reaped, so a fleet at its cap trips a transient refusal that the
  // next pulse clears — a rail crying wolf on that is noise on a working fleet.
  await pulseTo(system, 'issue:901', 1);
  assert.equal(system.store.listAgentsByStatus('starting', 'running').length, 0, 'nothing started on that branch');
  assert.equal(system.store.listErrors().length, 0, 'the refusal is not recorded as a failure, and never was');
  assert.equal(await refusalRow(system, 'issue:901'), undefined, 'one refusal raises nothing');

  await pulseTo(system, 'issue:901', 2);
  assert.equal(await refusalRow(system, 'issue:901'), undefined, 'two refusals still raise nothing');

  await pulseTo(system, 'issue:901', 3);
  const row = await refusalRow(system, 'issue:901');
  assert.ok(row, 'a dispatch refused on three pulses running is something that needs you');
  assert.equal(row.kind, 'dispatch');
  assert.equal(row.group, 'yours', 'nothing is leased, and the fix is outside the harness');
  assert.equal(row.holding, 0);
  assert.equal(row.goalRef, 'issue:901', 'the row names the origin that is stuck');
  assert.match(row.title, /Refused on 3 pulses running/, 'and that it is not one bad pulse');
  assert.match(row.title, /already checked out/, 'and why, in the refusal’s own words');
  assert.ok(row.opens !== null, 'a row nothing opens is a row nobody reads');

  system.store.close();
});

test('the refusal row clears itself the moment a dispatch for that origin gets through', async () => {
  const worktrees = new RefusingWorktrees();
  const system = refusingSystem(worktrees);
  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Add login' });
  failPlanningOpen(system.store, 902);

  await pulseTo(system, 'issue:902', 3);
  assert.ok(await refusalRow(system, 'issue:902'), 'the refusal is up');

  // The operator switches their checkout off the branch. Nothing tells the
  // cockpit that — the next pulse simply gets through, and the run is over.
  worktrees.relent();
  for (let i = 0; i < 30 && !dispatched(system, 'issue:902'); i += 1) await system.harness.runCycle('manual');
  assert.ok(dispatched(system, 'issue:902'), 'the dispatch for that origin went through');
  assert.equal(
    await refusalRow(system, 'issue:902'),
    undefined,
    'a refusal that has cleared stops being an ask on the very next snapshot',
  );

  system.store.close();
});
