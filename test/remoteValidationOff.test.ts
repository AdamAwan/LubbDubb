import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem, type System } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { FakeEnvironmentObserver, watchRow } from '../src/environments/fakeObserver.js';
import { FakeStateReader } from '../src/remoteValidation/fakeStateReader.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { stateDeclareNote } from '../src/plans/planning.js';
import { queryDigest } from '../src/store/remoteValidation.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';
import { buildGoalPage, goalSectionsOpen } from '../web/src/view/goalPage.js';
import type { AppState } from '../web/src/types.js';
import type { StateQueryInput } from '../src/types.js';

/*
 * The off switch, both directions on one run — `planApproval.test.ts`'s discipline. A deployment
 * that edits no configuration gets no sheet, no row, no reading, no bench mention, no cockpit
 * surface, no prompt note and no spawned command; the same run with one `validate` block on one
 * environment gets all of it.
 *
 * → docs/spec/36-remote-validation.md#off-by-default-and-off-in-one-place
 */

const QUERY: StateQueryInput = {
  id: 'orders-carry-a-channel',
  seq: 1,
  title: 'Every order written since the change carries a channel',
  query: 'select id, channel from orders where channel is null',
  presence: 'select id from orders limit 5',
  why: null,
};

const ON: EnvironmentConfig = {
  name: 'acceptance',
  at: 'echo unused',
  validate: { permits: ['state'], state: { run: './scripts/validation-query.sh acceptance' } },
};

const OFF: EnvironmentConfig = { name: 'acceptance', at: 'echo unused' };

function reader(): FakeStateReader {
  return new FakeStateReader({
    [`${QUERY.id}:presence`]: JSON.stringify([watchRow(QUERY.id, { id: 1 })]),
    [`${QUERY.id}:state`]: JSON.stringify([]),
  });
}

function build(environments: EnvironmentConfig[], stateReader: FakeStateReader): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-remote-off-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    repoRoot: dir,
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environments,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    stateReader,
    projectConfigFile: join(dir, 'absent.json'),
    environmentObserver: new FakeEnvironmentObserver(),
    errorMirror: () => {},
  });
}

function seed(system: System): void {
  system.store.ingestValidation('issue:12', {
    checks: [
      {
        id: 'an-order-places',
        seq: 1,
        title: 'An order still places end to end',
        do: 'Place one',
        expect: 'It places',
        uses: [],
        covers: [],
        fleetCandidate: false,
        candidateWhy: null,
      },
    ],
    resources: [],
    supersededReason: '',
    amendNote: '',
  });
  system.store.recordDelivery({ originRef: 'issue:12', summary: 'PR #40 landed it', by: 'assessor' });
  system.store.saveStateQueries('issue:12', [QUERY], 'agent');
  system.store.approveStateQuery({
    digest: queryDigest(QUERY.query, QUERY.presence),
    environment: 'acceptance',
    originRef: 'issue:12',
    queryId: QUERY.id,
    rows: 0,
    detail: null,
  });
  system.store.recordGoalArrival({
    goalRef: 'issue:12',
    environment: 'acceptance',
    arrivedAt: new Date().toISOString(),
  });
}

/** How many rows the goal page's own card would draw, or null where it draws nothing at all. */
function cardRows(state: Record<string, unknown>): number | null {
  const world = state['world'] as { issues: unknown[] };
  const withGoal = { ...state, world: { ...world, issues: [...world.issues, { number: 12, title: 'A goal' }] } };
  const page = buildGoalPage(withGoal as unknown as AppState, 'issue:12', []);
  if (page === null) return null;
  if (page.remoteSheets.length === 0) {
    assert.equal(goalSectionsOpen(page).remoteValidation, false, 'and the section is not opened for an absent card');
    return null;
  }
  assert.equal(goalSectionsOpen(page).remoteValidation, true);
  return page.remoteSheets[0]!.rows.length;
}

test('a deployment that configured nothing takes the build inert', async () => {
  const asked = reader();
  const system = build([OFF], asked);
  try {
    seed(system);
    await system.harness.runCycle('manual');
    await system.harness.runCycle('manual');

    assert.deepEqual(system.store.listRemoteSheets(), [], 'no sheet');
    assert.deepEqual(system.store.listRemoteSheetRows(), [], 'no sheet row');
    assert.deepEqual(system.store.listRemoteReadings(), [], 'no reading');
    assert.equal(system.store.listGoalArrivals()[0]?.sheetedAt, null, 'no arrival stamped');
    assert.deepEqual(asked.asked, [], 'no command is spawned');

    const bench = system.store.listHumanTasksOfKind('validate');
    assert.equal(bench.length, 1, 'the validate row is filed as it always was');
    assert.doesNotMatch(bench[0]?.detail ?? '', /sheet/i, 'and says nothing about a sheet');

    const state = buildStateSnapshot(system) as unknown as Record<string, unknown>;
    assert.deepEqual(state['remoteSheets'], [], 'the cockpit ships no sheets, so it draws no card');

    assert.equal(cardRows(state), null, 'and the goal page draws no card — not an empty one, and not question marks');

    assert.equal(stateDeclareNote(system.config.environments), '', 'and the note reaches neither work prompt');
  } finally {
    system.store.close();
  }
});

test('and one environment declaring permits: ["state"] with a state.run turns all of it on', async () => {
  const asked = reader();
  const system = build([ON], asked);
  try {
    seed(system);
    await system.harness.runCycle('manual');

    assert.deepEqual(
      system.store.listRemoteSheets().map((s) => `${s.goalRef} ${s.environment}`),
      ['issue:12 acceptance'],
    );
    assert.deepEqual(
      system.store.listRemoteSheetRows().map((r) => r.rowId),
      ['check:an-order-places', `state:${QUERY.id}`],
    );
    assert.equal(
      system.store.listRemoteReadings().find((r) => r.rowId === `state:${QUERY.id}`)?.outcome,
      'passed',
      'an approved row arrives with its reading already on it',
    );
    assert.notEqual(system.store.listGoalArrivals()[0]?.sheetedAt, null, 'the arrival is stamped');
    assert.deepEqual(
      asked.asked.map((a) => `${a.environment}:${a.kind}`),
      ['acceptance:presence', 'acceptance:state'],
      'the command reached its fake, and nothing else',
    );

    const bench = system.store.listHumanTasksOfKind('validate');
    assert.match(bench[0]?.detail ?? '', /A validation sheet is assembled for `acceptance` — 2 rows\./);

    const state = buildStateSnapshot(system) as unknown as Record<string, unknown>;
    const sheets = state['remoteSheets'] as { rows: unknown[] }[];
    assert.equal(sheets.length, 1);
    assert.equal(sheets[0]?.rows.length, 2);

    assert.equal(cardRows(state), 2, 'and the goal page draws the card the sheet earns');

    assert.match(stateDeclareNote(system.config.environments), /state_declare/);
  } finally {
    system.store.close();
  }
});
