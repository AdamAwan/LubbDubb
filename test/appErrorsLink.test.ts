import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesTouched, frameFiles, framePath, samePath } from '../src/appErrors/frames.js';
import { arrivalWindow, decideLink, hintWords, type LinkWindow } from '../src/appErrors/link.js';
import type { EnvironmentReading, GoalLanding } from '../src/types.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const at = (ms: number): string => new Date(NOW - ms).toISOString();

test('a frame is a path: line numbers, backslashes, drive letters and case do not matter', () => {
  assert.equal(framePath('src/Orders/OrderService.cs:118'), 'src/Orders/OrderService.cs');
  assert.equal(framePath('src/app.ts:12:7'), 'src/app.ts');
  assert.equal(framePath('C:\\build\\src\\Cart\\Cart.cs:line 40'), 'build/src/Cart/Cart.cs');
  assert.equal(framePath('Orders/OrderService.cs(118,5)'), 'Orders/OrderService.cs');
  assert.ok(samePath('/app/src/Orders/OrderService.cs', 'src/Orders/OrderService.cs'), 'a deployed prefix');
  assert.ok(samePath('orders/orderservice.cs', 'src/Orders/OrderService.cs'), 'a shorter frame, any case');
  assert.ok(!samePath('src/Billing/OrderService.cs', 'src/Orders/OrderService.cs'), 'whole segments, not a tail');
  assert.ok(!samePath('src/Orders/MyOrderService.cs', 'src/Orders/OrderService.cs'));
  assert.ok(!samePath('', 'src/a.ts'));
});

test('a group names each file once, and a diff touches the files it changed', () => {
  const files = frameFiles([
    'src/Orders/OrderService.cs:118',
    'src\\Orders\\OrderService.cs:240',
    'src/Cart.cs:9',
    ' ',
  ]);
  assert.deepEqual(files, ['src/Orders/OrderService.cs', 'src/Cart.cs']);
  assert.deepEqual(filesTouched(files, ['README.md', 'api/src/Orders/OrderService.cs']), [
    'src/Orders/OrderService.cs',
  ]);
  assert.deepEqual(filesTouched(files, []), []);
});

test('route hint words drop verbs, ids and short tokens, and stem plurals', () => {
  assert.deepEqual([...hintWords('POST /api/v2/orders/{id}/deliveries')], ['order', 'delivery']);
  assert.deepEqual([...hintWords('GET /users/3fa85f6457174562b3fc2c963f66afa6')], ['user']);
});

function known(goals: Record<string, string[]>): LinkWindow {
  return { known: true, goals: new Map(Object.entries(goals)), said: 'the deploy window aaaaaaa..bbbbbbb' };
}

const decide = (over: Partial<Parameters<typeof decideLink>[0]>) =>
  decideLink({
    window: known({ 'issue:412': ['a1'], 'issue:415': ['b1'], 'issue:420': ['c1'] }),
    frames: [],
    operation: null,
    diffs: new Map([
      ['a1', ['src/Orders/OrderService.cs', 'src/Shared/Money.cs']],
      ['b1', ['src/Cart/Cart.cs', 'src/Shared/Money.cs']],
      ['c1', ['docs/readme.md']],
    ]),
    titles: new Map(),
    arrival: null,
    ...over,
  });

test('an undecided window is no link, and says why; an empty one is a known zero', () => {
  const unknown = decide({ window: { known: false, why: 'the clone could not place aaaaaaa' } });
  assert.equal(unknown.goalRef, null);
  assert.equal(unknown.candidates, null, 'unknown is never zero');
  assert.match(unknown.why, /cannot be decided — the clone could not place aaaaaaa/);
  const empty = decide({ window: known({}) });
  assert.equal(empty.candidates, 0);
  assert.equal(empty.goalRef, null);
});

test('a frame in a file only one candidate changed links to it', () => {
  const link = decide({ frames: ['src/Orders/OrderService.cs:118'] });
  assert.equal(link.goalRef, 'issue:412');
  assert.deepEqual(link.how, ['frame-match']);
  assert.equal(link.candidates, 3);
  assert.equal(link.why, 'OrderService.cs changed only by #412, of 3 goals in the deploy window aaaaaaa..bbbbbbb.');
});

test('several candidates touching the frames: the one matching most, or no link and the tie named', () => {
  const most = decide({ frames: ['src/Shared/Money.cs:3', 'src/Cart/Cart.cs:9'] });
  assert.equal(most.goalRef, 'issue:415');
  assert.match(most.why, /changed most by #415/);

  const tied = decide({ frames: ['src/Shared/Money.cs:3'] });
  assert.equal(tied.goalRef, null);
  assert.deepEqual(tied.tied, ['issue:412', 'issue:415']);
  assert.equal(tied.candidates, 3, 'candidates stays the window size');
});

test('a test arrival breaks a frame tie, agrees with a frame match, or links on its own', () => {
  const arrival = { goalRef: 'issue:415', environments: ['test'] };
  const broken = decide({ frames: ['src/Shared/Money.cs:3'], arrival });
  assert.equal(broken.goalRef, 'issue:415');
  assert.deepEqual(broken.how, ['frame-match', 'test-arrival']);

  const agreed = decide({ frames: ['src/Cart/Cart.cs'], arrival });
  assert.deepEqual(agreed.how, ['frame-match', 'test-arrival']);

  const frameWins = decide({ frames: ['src/Orders/OrderService.cs'], arrival });
  assert.equal(frameWins.goalRef, 'issue:412', 'the frame is the stronger evidence');
  assert.deepEqual(frameWins.how, ['frame-match']);
  assert.match(frameWins.why, /test arrival pointed at #415/);

  const alone = decide({ arrival });
  assert.equal(alone.goalRef, 'issue:415');
  assert.deepEqual(alone.how, ['test-arrival']);
  assert.match(alone.why, /^It first appeared on test within a day of #415 reaching it/);
});

test('a diff the clone could not list makes frame evidence unknown, never a miss', () => {
  const link = decide({
    frames: ['src/Orders/OrderService.cs'],
    diffs: new Map([['a1', ['src/Orders/OrderService.cs']]]),
    operation: 'POST /orders',
    titles: new Map([['issue:412', 'Orders: submit in one step']]),
  });
  assert.equal(link.goalRef, null, 'neither a frame link nor a route hint over an unknown');
  assert.match(link.why, /could not list what b1 changed/);
});

test('the route hint is the last resort, and only on a unique match', () => {
  const titles = new Map([
    ['issue:412', 'Orders: submit in one step'],
    ['issue:415', 'Cart totals'],
    ['issue:420', 'Docs'],
  ]);
  const hint = decide({ operation: 'POST /orders/{id}/submit', titles });
  assert.equal(hint.goalRef, 'issue:412');
  assert.deepEqual(hint.how, ['route-hint']);
  assert.match(hint.why, /^A hint only/);

  const none = decide({ operation: 'GET /health', titles });
  assert.equal(none.goalRef, null);
  assert.match(none.why, /^Nothing in the error points at one of 3 goals/);
});

function landing(goalRef: string, sha: string, recordedAgo: number): GoalLanding {
  return { prNumber: sha.length, goalRef, sha, recordedAt: at(recordedAgo), onIntegration: true };
}

function reach(sha: string, status: EnvironmentReading['status'], observedAgo: number): EnvironmentReading {
  return { sha, environment: 'test', status, detail: null, observedAt: at(observedAgo) };
}

test('the arrival window: what reached the environment in the period, undecided while any landing is unknown', () => {
  const landings = [
    landing('issue:1', 'a', 30 * HOUR),
    landing('issue:2', 'bb', 30 * HOUR),
    landing('issue:3', 'ccc', 30 * HOUR),
    landing('issue:4', 'dddd', 40 * 24 * HOUR),
  ];
  const input = { environment: 'test', anchor: NOW, lookbackMs: 24 * HOUR, landings };
  const window = arrivalWindow({
    ...input,
    readings: [reach('a', 'reached', 2 * HOUR), reach('bb', 'reached', 28 * HOUR), reach('ccc', 'absent', HOUR)],
  });
  assert.ok(window.known);
  assert.deepEqual([...window.goals.keys()], ['issue:1'], 'reached before the period, absent and too old are out');

  const undecided = arrivalWindow({
    ...input,
    readings: [reach('a', 'reached', 2 * HOUR), reach('bb', 'unknown', HOUR)],
  });
  assert.equal(undecided.known, false);
  assert.ok(!undecided.known && /bb is on test is unknown/.test(undecided.why));
});
