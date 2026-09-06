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

class RefusingWorktrees extends FakeWorktreeManager {
  private refusing = true;

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
      selfUpdate: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      auth: { enabled: false } as never,
    }),
    { worktrees, streamSpawner: spawner, errorMirror: () => {} },
  );
}

function refusals(system: System, origin: string): number {
  return system.store.listDecisions(200).filter((d) => d.outcome === 'rejected' && d.action.originRef === origin)
    .length;
}

async function pulseTo(system: System, origin: string, n: number): Promise<void> {
  for (let i = 0; i < 30 && refusals(system, origin) < n; i += 1) await system.harness.runCycle('manual');
  assert.equal(refusals(system, origin), n, `the fleet reached ${n} refusals for ${origin}`);
}

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
