import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { ciHeldByOutcome } from '../src/botPrs/outcome.js';
import { dependencyCiBrief } from '../src/botPrs/ciBrief.js';
import { toolsForRule } from '../src/mcp/names.js';
import type { BotPrOutcome, PullRequest } from '../src/types.js';
import type { BotPrsPayload } from '../src/wire.js';

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-botpr-ci-'));
  return buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      maxConcurrentAgents: 3,
      botPrs: { authors: ['^renovate\\[bot\\]$'], riskSchedule: '' },
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

const RENOVATE_BODY = [
  '| Package | Change |',
  '|---|---|',
  '| [dotenv](https://github.com/motdotla/dotenv) | `16.4.5` -> `17.0.1` |',
  '',
  '### Release Notes',
  '',
  '`config()` now throws when the file is missing.',
  '',
  '### Configuration',
].join('\n');

function injectBotPr(system: System, number: number, headSha: string): void {
  system.connector.inject({
    kind: 'new_pr',
    number,
    title: 'Update dependency dotenv to v17',
    branch: 'renovate/dotenv-17.x',
    labels: ['lubbdubb-watch'],
    author: 'renovate[bot]',
    viewerAuthored: false,
    botAuthored: true,
    headSha,
  });
  system.connector.inject({ kind: 'pr_body_edited', prNumber: number, body: RENOVATE_BODY });
  system.connector.inject({ kind: 'ci_failed', prNumber: number });
}

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  id: 'p',
  number: 7,
  title: 'Update dependency dotenv to v17',
  branch: 'renovate/dotenv-17.x',
  ciStatus: 'failing',
  unresolvedComments: [],
  botAuthored: true,
  headSha: 'h1',
  ...over,
});

const outcome = (over: Partial<BotPrOutcome> = {}): BotPrOutcome => ({
  prNumber: 7,
  headSha: 'h1',
  outcome: 'upstream-bug',
  summary: 'x',
  upstreamUrl: 'https://github.com/motdotla/dotenv/issues/1',
  fixedIn: null,
  recordedAt: '2026-10-06T00:00:00.000Z',
  ...over,
});

test('an outcome holds CI on its own head only, never adapted, and never a pull request that is not a bot’s', () => {
  assert.ok(ciHeldByOutcome(pr(), [outcome()]));
  assert.equal(ciHeldByOutcome(pr({ headSha: 'h2' }), [outcome()]), null, 'a new head is unread');
  assert.equal(ciHeldByOutcome(pr(), [outcome({ outcome: 'adapted' })]), null);
  assert.equal(ciHeldByOutcome(pr({ botAuthored: false }), [outcome()]), null);
  assert.equal(ciHeldByOutcome(pr({ headSha: '' }), [outcome({ headSha: '' })]), null, 'no head fails open');
});

test('the dependency brief is appended only for a bot’s pull request', () => {
  assert.equal(dependencyCiBrief(pr({ botAuthored: undefined }), null), '');
  const brief = dependencyCiBrief(pr({ body: RENOVATE_BODY, author: 'renovate[bot]' }), null);
  assert.ok(brief.includes('dotenv from 16.4.5 to 17.0.1 (major)'));
  assert.ok(brief.includes('https://github.com/motdotla/dotenv'), 'the dependency’s repository is named');
  assert.ok(brief.includes('`config()` now throws'), 'the release notes ride along');
  assert.ok(brief.includes('dependency_outcome'));
});

test('the CI-fix agent on a watched bot pull request gets the brief and the tool', async () => {
  const system = build();
  injectBotPr(system, 7, 'h1');
  try {
    await system.harness.runCycle('manual');
    const task = system.store.tasks.listTasks().find((t) => t.originRef === 'pr:7:ci');
    assert.ok(task, 'the CI fix is dispatched');
    assert.ok((system.store.tasks.getTask(task.id)?.prompt ?? '').includes('## This is a dependency update'));
    assert.ok(toolsForRule('pr-ci-failing').has('dependency_outcome'));
  } finally {
    system.store.close();
  }
});

test('the outcome is recorded against the world’s head, refused where it means nothing, and drawn on the tab', async () => {
  const system = build();
  injectBotPr(system, 7, 'h1');
  const { app } = await buildApp(system);
  try {
    await system.harness.runCycle('manual');
    const task = system.store.tasks.listTasks().find((t) => t.originRef === 'pr:7:ci')!;
    assert.ok(task.agentId);

    const bare = system.agents.recordBotPrOutcome(task.agentId, {
      outcome: 'upstream-bug',
      summary: 'A regression in dotenv.',
      upstreamUrl: null,
      fixedIn: null,
    });
    assert.equal(bare.ok, false, 'upstream-bug without the upstream link is refused');

    const recorded = system.agents.recordBotPrOutcome(task.agentId, {
      outcome: 'upstream-bug',
      summary: 'config() throws on a missing file; upstream calls it a regression.',
      upstreamUrl: 'https://github.com/motdotla/dotenv/issues/1',
      fixedIn: '17.0.2',
    });
    assert.ok(recorded.ok);
    assert.equal(recorded.outcome.headSha, 'h1');

    const read = (await app.inject({ method: 'GET', url: '/api/bot-prs' })).json<BotPrsPayload>();
    assert.equal(read.pullRequests[0]!.outcome?.outcome, 'upstream-bug');
    assert.equal(read.pullRequests[0]!.outcome?.fixedIn, '17.0.2');

    const heads = system.store.botPrOutcomes.onHeads([{ prNumber: 7, headSha: 'h1' }]);
    assert.equal(heads.length, 1);
    assert.deepEqual(system.store.botPrOutcomes.onHeads([{ prNumber: 7, headSha: 'h2' }]), []);
  } finally {
    await app.close();
    system.store.close();
  }
});

test('dependency_outcome is refused off a CI-fix origin, and on a pull request that is not a bot’s', async () => {
  const system = build();
  system.connector.inject({
    kind: 'new_pr',
    number: 9,
    title: 'Our change',
    branch: 'feat',
    labels: ['lubbdubb-watch'],
    viewerAuthored: true,
  });
  system.connector.inject({ kind: 'ci_failed', prNumber: 9 });
  try {
    await system.harness.runCycle('manual');
    const task = system.store.tasks.listTasks().find((t) => t.originRef === 'pr:9:ci')!;
    assert.ok(task.agentId);
    const refused = system.agents.recordBotPrOutcome(task.agentId, {
      outcome: 'unclear',
      summary: 'x',
      upstreamUrl: null,
      fixedIn: null,
    });
    assert.equal(refused.ok, false);
    assert.equal(
      (system.store.tasks.getTask(task.id)?.prompt ?? '').includes('This is a dependency update'),
      false,
      'the fleet’s own pull request gets no dependency brief',
    );
  } finally {
    system.store.close();
  }
});

test('closing a bot pull request takes it off the tab, and is refused off the list', async () => {
  const system = build();
  injectBotPr(system, 7, 'h1');
  system.connector.inject({ kind: 'new_pr', number: 8, title: 'Fix the thing', branch: 'issue/8', author: 'someone' });
  const { app } = await buildApp(system);
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/bot-prs/8/close' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/bot-prs/7/close' })).statusCode, 200);
    const after = (await app.inject({ method: 'GET', url: '/api/bot-prs' })).json<BotPrsPayload>();
    assert.deepEqual(after.pullRequests, [], 'the close is not served from the cached reading');
  } finally {
    await app.close();
    system.store.close();
  }
});
