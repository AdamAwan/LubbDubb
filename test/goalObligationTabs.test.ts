import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import { buildGoalNav, buildGoalPage, goalPaneOf, goalPanes, obligationEnvironment } from '../web/src/view/goalPage.js';
import type { AppState } from '../web/src/types.js';
import type { EnvironmentConfig } from '../src/environments/policy.js';

// The goal page's tabs are the obligations a goal owes, each naming the environment that
// carries it — derived from `arrival.opens` and the `watch` block, never hard-coded.
// → docs/spec/17-cockpit.md#the-panes

const TEST: EnvironmentConfig = {
  name: 'test',
  at: 'echo unused',
  arrival: { opens: ['validate', 'close_out'] },
};
const PROD: EnvironmentConfig = {
  name: 'prod',
  at: 'echo unused',
  watch: { observe: './scripts/telemetry.sh' },
};

function build(environments: EnvironmentConfig[]): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-obligations-'));
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: ':memory:',
    agentMode: 'raw',
    deskRoot: join(dir, 'desk'),
    worktreeRoot: join(dir, 'wt'),
    heartbeatIntervalMs: 999_999,
    environments,
  });
  return buildSystem(config, {
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    errorMirror: () => {},
  });
}

/** One goal on a deployment configured this way, as the cockpit's own view model reads it. */
async function page(environments: EnvironmentConfig[]) {
  const system = build(environments);
  system.connector.inject({ kind: 'new_issue', number: 12, title: 'Job X keeps timing out' });
  await system.harness.runCycle();
  const state = buildStateSnapshot(system) as unknown as AppState;
  const built = buildGoalPage(state, 'issue:12', []);
  assert.ok(built, 'the injected goal must resolve to a page');
  system.store.close();
  return built;
}

async function row(environments: EnvironmentConfig[]): Promise<{ tab: string; on: string[] }[]> {
  return buildGoalNav(await page(environments)).map((e) => ({ tab: e.tab, on: e.on }));
}

test('each obligation tab names the environment whose arrival opens it', async () => {
  assert.deepEqual(await row([TEST, PROD]), [
    { tab: 'ask', on: [] },
    { tab: 'plan', on: [] },
    { tab: 'validate', on: ['test'] },
    { tab: 'close', on: ['test'] },
    { tab: 'watch', on: ['prod'] },
  ]);
});

test('an environment carrying more than one gate is named on each tab it carries', async () => {
  /* The tabs are obligations and one place can owe several, so the same name appears twice
     rather than one gate quietly taking the environment for itself. */
  const both: EnvironmentConfig = { ...PROD, arrival: { opens: ['validate', 'close_out'] } };
  assert.deepEqual(await row([both]), [
    { tab: 'ask', on: [] },
    { tab: 'plan', on: [] },
    { tab: 'validate', on: ['prod'] },
    { tab: 'close', on: ['prod'] },
    { tab: 'watch', on: ['prod'] },
  ]);
});

test('a deployment with no environments still owes its checks and its close-out', async () => {
  /* Validation is always on, and a deployment that configured no environments must not be
     left with nowhere to see its checks. Both stand unqualified: the obligation is a
     person's, by hand or on a local run. */
  assert.deepEqual(await row([]), [
    { tab: 'ask', on: [] },
    { tab: 'plan', on: [] },
    { tab: 'validate', on: [] },
    { tab: 'close', on: [] },
  ]);
});

test('no environment declares a watch, so there is no watch tab', async () => {
  const tabs = await row([TEST]);
  assert.deepEqual(
    tabs.map((t) => t.tab),
    ['ask', 'plan', 'validate', 'close'],
    'a tab for a window that can never open is a stage the goal can never reach',
  );
});

test('an environment that opens nothing places no obligation, and is not named on a tab', async () => {
  const observed: EnvironmentConfig = { name: 'preview', at: 'echo unused', arrival: { comment: true } };
  assert.deepEqual(await row([TEST, observed]), [
    { tab: 'ask', on: [] },
    { tab: 'plan', on: [] },
    { tab: 'validate', on: ['test'] },
    { tab: 'close', on: ['test'] },
  ]);
});

test('two environments opening the same gate put both on that tab, in promotion order', async () => {
  const second: EnvironmentConfig = { ...PROD, arrival: { opens: ['close_out'] } };
  const built = await page([TEST, second]);
  assert.deepEqual(built.obligations.close, ['test', 'prod'], 'the picker is scoped to just those two');
  assert.deepEqual(built.obligations.validate, ['test'], 'and the other tab is not widened by it');
});

test('a pick on one tab does not scope a tab that environment does not owe', async () => {
  /* One `?sheet=` is read by every obligation pane, so each falls back to an environment
     that actually carries its own obligation rather than showing another tab's pick. */
  const built = await page([TEST, PROD]);
  assert.equal(obligationEnvironment(built, 'validate', 'prod'), 'test');
  assert.equal(obligationEnvironment(built, 'watch', 'prod'), 'prod');
  assert.equal(obligationEnvironment(built, 'validate', null), 'test');
});

test('an obligation no environment carries scopes to nothing rather than to the first environment', async () => {
  const built = await page([TEST]);
  assert.equal(built.obligations.watch.length, 0);
  assert.equal(
    obligationEnvironment(built, 'watch', 'test'),
    null,
    'a pane scoped to an environment that does not owe it would draw another obligation’s readings',
  );
});

test('the signals fold onto the close where a deployment draws no watch tab', async () => {
  /* No card may vanish because a deployment declared no watch: the signals are still the
     goal's, and folded into `close` they land where an operator finishing a goal is. */
  const watched = await page([TEST, PROD]);
  assert.equal(goalPaneOf(watched, 'signals'), 'watch');

  const unwatched = await page([TEST]);
  assert.ok(!goalPanes(unwatched).includes('watch'));
  assert.equal(goalPaneOf(unwatched, 'signals'), 'close');
});

test('every section a deployment draws is behind a pane that deployment draws', async () => {
  for (const environments of [[], [TEST], [TEST, PROD]]) {
    const built = await page(environments);
    const drawn = goalPanes(built);
    for (const section of ['prediction', 'validation', 'signals', 'environments', 'tail', 'record'] as const) {
      assert.ok(
        drawn.includes(goalPaneOf(built, section)),
        `${section} is behind a pane this deployment does not draw — a card nothing draws is a card nobody reads`,
      );
    }
  }
});
