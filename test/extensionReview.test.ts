import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { loadExtensions } from '../src/extensions/load.js';
import { EXTENSION_SLOTS } from '../src/extensions/slots.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { DEFAULT_PR_REVIEW, type PrReviewPolicy } from '../src/review/policy.js';
import { buildSystem, type System } from '../src/system/system.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import type { Agent } from '../src/types.js';
import { gitRepo } from './support/gitRepo.js';
import { findTask } from './support/tasks.js';

// → docs/spec/07-pull-requests.md#the-review-from-the-projects-extension

const MODES = { deep: { charterFile: null, profile: null }, quick: { charterFile: null, profile: null } };

const RECORDING = `
const asked = (globalThis.__reviewAsked ??= []);
export default { apiVersion: 1, name: 'acme', slots: {
  routeReview: async (input) => { asked.push(['route', input]); return { mode: 'quick', reason: 'a copy change' }; },
  publishReview: async (input) => { asked.push(['publish', input]); return { thread: 'thread-41' }; },
} };`;

interface Bench {
  system: System;
  logged: string[];
}

interface BenchOptions {
  review?: Partial<PrReviewPolicy>;
  repoRoot?: string;
  dbPath?: string;
}

async function bench(source: string | null, { review = {}, repoRoot = gitRepo(), dbPath }: BenchOptions = {}) {
  if (source !== null) writeFileSync(join(repoRoot, 'ext.mjs'), source);
  const config = loadConfig({
    selfUpdate: { enabled: false } as never,
    auth: { enabled: false } as never,
    labelPrefix: '',
    dbPath: dbPath ?? ':memory:',
    agentMode: 'raw',
    repoRoot,
    deskRoot: join(repoRoot, 'desk'),
    worktreeRoot: join(repoRoot, 'wt'),
    heartbeatIntervalMs: 999_999,
    maxConcurrentAgents: 3,
    review: { ...DEFAULT_PR_REVIEW, enabled: true, modes: MODES, defaultMode: 'deep', ...review },
    extensions: source === null ? [] : ['ext.mjs'],
  });
  const logged: string[] = [];
  const system = buildSystem(config, {
    extensions: await loadExtensions({ paths: config.extensions, book: EXTENSION_SLOTS }),
    worktrees: new FakeWorktreeManager(),
    backend: new FakePtyBackend(),
    gitObserver: new FakeGitObserver(),
    projectConfigFile: join(repoRoot, 'absent.json'),
    errorMirror: (entry) => logged.push(entry.message),
  });
  return { system, logged } satisfies Bench;
}

function asked(): [string, unknown][] {
  const g = globalThis as { __reviewAsked?: [string, unknown][] };
  const all = g.__reviewAsked ?? [];
  g.__reviewAsked = [];
  return all;
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(done(), 'it settled');
}

async function routed(system: System, prNumber: number) {
  await until(() => system.store.prReviewRoutes.listPrReviewRoutes().some((r) => r.prNumber === prNumber));
  return system.store.prReviewRoutes.listPrReviewRoutes().find((r) => r.prNumber === prNumber)!;
}

function openPr(system: System, number: number): void {
  system.connector.inject({ kind: 'new_pr', number, title: 'Fix the footer copy', branch: `feature-${number}` });
}

function reviewer(system: System, prNumber: number): Agent {
  const task = system.store.tasks.createTask({
    kind: 'code',
    title: `Review PR #${prNumber}`,
    prompt: 'review it',
    branch: `review/pr-${prNumber}`,
    originRef: `pr:${prNumber}:review`,
    originTitle: 'Fix the footer copy',
    rule: 'pr-review',
  });
  return system.agents.spawn(task, join(gitRepo(), 'wt'));
}

async function report(system: System, prNumber: number): Promise<void> {
  const session = system.mcp.session(reviewer(system, prNumber).id);
  assert.ok(session);
  const result = (await session.call('review_report', {
    verdict: 'findings',
    summary: 'Changes the footer copy.',
    findings: ['footer.tsx: the link points at the old domain'],
  })) as { isError?: boolean };
  assert.notEqual(result.isError, true);
}

test('the extension chooses the mode: no triage agent, and the review runs what it chose', async () => {
  asked();
  const { system } = await bench(RECORDING, { review: { routeExtension: true } });
  openPr(system, 12);
  await system.harness.runCycle('manual');

  const route = await routed(system, 12);
  assert.deepEqual([route.mode, route.skipped, route.reason, route.agentId], ['quick', false, 'a copy change', null]);
  const [[slot, input]] = asked() as [[string, { pr: { number: number }; modes: string[]; allowSkip: boolean }]];
  assert.equal(slot, 'route');
  assert.deepEqual([input.pr.number, input.modes, input.allowSkip], [12, ['deep', 'quick'], false]);
  assert.equal(
    findTask(system.store, (t) => t.originRef === 'pr:12:review-triage'),
    undefined,
  );

  await system.harness.runCycle('manual');
  const review = findTask(system.store, (t) => t.originRef === 'pr:12:review');
  assert.ok(review);
  assert.match(review.title, /\(quick\)$/);
  system.store.close();
});

test('opted out, a loaded extension is never asked and the triage agent chooses', async () => {
  asked();
  const { system } = await bench(RECORDING);
  openPr(system, 12);
  await system.harness.runCycle('manual');

  assert.ok(findTask(system.store, (t) => t.originRef === 'pr:12:review-triage'));
  assert.deepEqual(asked(), []);
  assert.deepEqual(system.store.prReviewRoutes.listPrReviewRoutes(), []);
  system.store.close();
});

test('with no extension at all the triage agent chooses and the reviewer is told publish none', async () => {
  const { system } = await bench(null, { review: { modes: { deep: MODES.deep } } });
  openPr(system, 12);
  await system.harness.runCycle('manual');

  const review = findTask(system.store, (t) => t.originRef === 'pr:12:review');
  assert.ok(review);
  assert.match(review.prompt, /Do not comment on the pull request\. Your report through `review_report` is how this/);
  system.store.close();
});

test('an extension that throws is recorded, and the review runs the default mode', async () => {
  const { system, logged } = await bench(
    `export default { apiVersion: 1, name: 'acme', slots: {
      routeReview: () => { throw new Error('the routing API said 503'); },
    } };`,
    { review: { routeExtension: true } },
  );
  openPr(system, 12);
  await system.harness.runCycle('manual');

  const route = await routed(system, 12);
  assert.equal(route.mode, 'deep');
  assert.match(
    route.reason,
    /did not choose \(extension "acme" failed the "routeReview" slot: the routing API said 503\)/,
  );
  assert.ok(logged.some((m) => /the routing API said 503/.test(m)));
  system.store.close();
});

test('a wrong-shaped answer, an undeclared mode or a skip not allowed each run the default mode', async () => {
  for (const [answer, why] of [
    ['{ mode: "quick" }', /wrong shape/],
    ['{ mode: "thorough", reason: "x" }', /"thorough", which is not one of review\.modes/],
    ['{ skip: true, reason: "x" }', /does not allow skipping/],
  ] as const) {
    const { system, logged } = await bench(
      `export default { apiVersion: 1, name: 'acme', slots: { routeReview: () => (${answer}) } };`,
      { review: { routeExtension: true } },
    );
    openPr(system, 12);
    await system.harness.runCycle('manual');
    const route = await routed(system, 12);
    assert.equal(route.mode, 'deep');
    assert.match(route.reason, why);
    assert.ok(
      logged.some((m) => why.test(m)),
      'a refused answer is on the error log, not only in the reason',
    );
    system.store.close();
  }
});

test('a skip is honoured where the project allows one', async () => {
  const { system } = await bench(
    `export default { apiVersion: 1, name: 'acme', slots: { routeReview: () => ({ skip: true, reason: 'a lockfile' }) } };`,
    { review: { routeExtension: true, allowSkip: true } },
  );
  openPr(system, 12);
  await system.harness.runCycle('manual');
  const route = await routed(system, 12);
  assert.deepEqual([route.skipped, route.reason], [true, 'a lockfile']);
  system.store.close();
});

test('opting in with no extension filling the slot refuses to build', async () => {
  await assert.rejects(
    bench(null, { review: { routeExtension: true } }),
    /"review.routeExtension" is set and no extension fills the "routeReview" slot/,
  );
  await assert.rejects(
    bench(null, { review: { publishExtension: true } }),
    /"review.publishExtension" is set and no extension fills the "publishReview" slot/,
  );
});

test('the opt-in beside the config it replaces is refused at load', () => {
  const load = (review: Partial<PrReviewPolicy>) => () =>
    loadConfig({
      dbPath: ':memory:',
      repoRoot: gitRepo(),
      review: { ...DEFAULT_PR_REVIEW, enabled: true, modes: MODES, ...review },
    });
  assert.throws(load({ routeExtension: true, routingCharterFile: 'docs/routing.md' }), /both choose how/);
  assert.throws(load({ routeExtension: true, modes: { deep: MODES.deep } }), /nothing to choose/);
  assert.throws(load({ publishExtension: true, publish: 'comment' }), /both decide where the findings go/);
  assert.throws(load({ publishExtension: 'yes' as never }), /must be true or false/);
  assert.doesNotThrow(load({ routeExtension: true, publishExtension: true }));
});

test('the extension publishes a recorded review, and its thread is the publication', async () => {
  asked();
  const { system } = await bench(RECORDING, { review: { publishExtension: true } });
  system.store.prReviewRoutes.recordPrReviewRoute({
    prNumber: 7,
    mode: 'deep',
    skipped: false,
    reason: 'x',
    agentId: null,
  });
  await report(system, 7);

  await until(() => system.store.prReviews.listPrReviews()[0]?.publishedThread !== null);
  assert.equal(system.store.prReviews.listPrReviews()[0]?.publishedThread, 'thread-41');
  assert.deepEqual(asked(), [
    [
      'publish',
      {
        pr: 7,
        headSha: null,
        mode: 'deep',
        verdict: 'findings',
        summary: 'Changes the footer copy.',
        findings: ['footer.tsx: the link points at the old domain'],
      },
    ],
  ]);
  system.store.close();
});

test("the reviewer's prompt says the project's code publishes", async () => {
  const { system } = await bench(RECORDING, { review: { modes: { deep: MODES.deep }, publishExtension: true } });
  openPr(system, 12);
  await system.harness.runCycle('manual');
  const review = findTask(system.store, (t) => t.originRef === 'pr:12:review');
  assert.ok(review);
  assert.match(review.prompt, /handed to this project's own code, which publishes it/);
  system.store.close();
});

test('a failed publication leaves the review recorded, unpublished, and on the error log', async () => {
  const { system, logged } = await bench(
    `export default { apiVersion: 1, name: 'acme', slots: {
      publishReview: () => { throw new Error('the review API said 500'); },
    } };`,
    { review: { publishExtension: true } },
  );
  await report(system, 7);

  await until(() => logged.some((m) => /the review API said 500/.test(m)));
  const [review] = system.store.prReviews.listPrReviews();
  assert.equal(review?.verdict, 'findings');
  assert.equal(review?.publishedThread, null);
  system.store.close();
});

test('opted out, a recorded review is not handed to a loaded extension', async () => {
  asked();
  const { system } = await bench(RECORDING);
  await report(system, 7);
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked(), []);
  assert.equal(system.store.prReviews.listPrReviews()[0]?.publishedThread, null);
  system.store.close();
});

test('a restart asks a lost route again, and never asks a lost publication again', async () => {
  asked();
  const held: ((answer: unknown) => void)[] = [];
  (globalThis as { __reviewHeld?: typeof held }).__reviewHeld = held;
  const repoRoot = gitRepo();
  const dbPath = join(repoRoot, 'lubbdubb.db');
  const review = { routeExtension: true, publishExtension: true };
  const hanging = `
const asked = (globalThis.__reviewAsked ??= []);
const held = (globalThis.__reviewHeld ??= []);
export default { apiVersion: 1, name: 'acme', slots: {
  routeReview: (input) => { asked.push(['route', input.pr.number]); return new Promise((r) => held.push(r)); },
  publishReview: (input) => { asked.push(['publish', input.pr]); return new Promise((r) => held.push(r)); },
} };`;
  const before = await bench(hanging, { repoRoot, dbPath, review });
  openPr(before.system, 12);
  await before.system.harness.runCycle('manual');
  await report(before.system, 7);
  await until(() => held.length === 2);
  assert.deepEqual(
    asked().map(([slot]) => slot),
    ['route', 'publish'],
  );

  // The process that asked is gone: a new one boots on the same database with nothing in flight.
  const after = await bench(RECORDING, { dbPath, review });
  openPr(after.system, 12);
  await after.system.harness.runCycle('manual');
  const route = await routed(after.system, 12);
  assert.equal(route.mode, 'quick', 'the route nobody answered is asked again');
  await after.system.harness.runCycle('manual');
  assert.deepEqual(
    asked().map(([slot]) => slot),
    ['route'],
    'and the publication is not: a second ask could post twice',
  );
  assert.equal(after.system.store.prReviews.listPrReviews()[0]?.publishedThread, null);

  for (const release of held.splice(0)) release({ thread: null, mode: 'deep', reason: 'late' });
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  after.system.store.close();
  before.system.store.close();
});
