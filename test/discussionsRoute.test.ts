import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { buildSystem, type System } from '../src/system/system.js';
import { loadConfig } from '../src/config/config.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { buildStateSnapshot } from '../src/server/stateSnapshot.js';
import type { Issue } from '../src/types.js';
import type { DiscussionReading } from '../src/wire.js';

function build(opts: { discussions: boolean; vault?: boolean }): { system: System; folder: string } {
  const root = mkdtempSync(join(tmpdir(), 'lubbdubb-discussion-route-'));
  const repoRoot = join(root, 'widgets');
  mkdirSync(repoRoot);
  const notes = join(root, 'notes');
  mkdirSync(notes);
  if (opts.vault === true) mkdirSync(join(notes, '.obsidian'));
  const system = buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      repoRoot,
      deskRoot: join(root, 'desk'),
      worktreeRoot: join(root, 'wt'),
      heartbeatIntervalMs: 999_999,
      ...(opts.discussions ? { discussionsDir: join(notes, 'discussions') } : {}),
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
  return { system, folder: join(notes, 'discussions', 'widgets') };
}

function issue(number: number, title: string, parent: number | null): Issue {
  return {
    id: `I_${number}`,
    number,
    title,
    body: '',
    labels: [],
    state: 'open',
    linkedPrNumber: null,
    parent:
      parent === null
        ? null
        : { number: parent, title: 'Reporting', issueType: 'Feature', workItemState: 'Active', state: 'open' },
  };
}

function world(system: System): void {
  system.store.world.setWorldBaseline({
    takenAt: new Date().toISOString(),
    pullRequests: [],
    issues: [issue(87, 'Reporting', null), issue(142, 'Export to CSV', 87), issue(143, 'Export to XLSX', 87)],
  });
}

const STORY = `---
ref: issue:142
kind: story
title: Export to CSV
parent: '[[87 Reporting]]'
---

## Decision · 2026-11-03 · operator ^d-7f3a

Export uses the browser's download.

## Question · open · 2026-11-03 · agent planner#912 ^q-21bc

Should empty columns be dropped?

## Idea · parked · 2026-11-02 · @sam (tracker) ^i-0c11

Offer XLSX as well.
`;

const FEATURE = `---
ref: issue:87
kind: feature
title: Reporting
---

## Decision · 2026-11-01 · operator ^d-0001

Every export is UTF-8.

## Decision · 2026-11-02 · operator ^d-0002

Supersedes ^d-0001

Every export is UTF-8 with a BOM.

## Question · open · 2026-11-02 · operator ^q-0003

Do we need PDF?

## Note · 2026-11-02 · operator ^n-0004

Talked to finance.
`;

async function read(system: System, number: number): Promise<DiscussionReading> {
  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: `/api/discussions/${number}` });
  await app.close();
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as DiscussionReading;
}

test('with discussionsDir unset the route says the feature is off, and the snapshot agrees', async () => {
  const { system } = build({ discussions: false });
  world(system);
  const reading = await read(system, 142);
  assert.equal(reading.enabled, false);
  assert.deepEqual(reading.entries, []);
  assert.deepEqual(reading.related, []);
  assert.equal(reading.path, null);
  assert.equal(buildStateSnapshot(system).config.discussions, false);
  system.store.close();
});

test("a story's reading carries its entries and its feature's standing decisions and open questions", async () => {
  const { system, folder } = build({ discussions: true });
  world(system);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '142 Export to CSV.md'), STORY);
  writeFileSync(join(folder, '87 Reporting.md'), FEATURE);

  const reading = await read(system, 142);
  assert.equal(reading.enabled, true);
  assert.equal(reading.kind, 'story');
  assert.equal(reading.title, 'Export to CSV');
  assert.equal(reading.path, join(folder, '142 Export to CSV.md'));
  assert.equal(reading.obsidianUrl, null, 'no .obsidian folder above the file, so no vault link');
  assert.deepEqual(
    reading.entries.map((e) => [e.kind, e.state, e.id]),
    [
      ['decision', null, 'd-7f3a'],
      ['question', 'open', 'q-21bc'],
      ['idea', 'parked', 'i-0c11'],
    ],
  );
  assert.equal(reading.related.length, 1);
  const [feature] = reading.related;
  assert.equal(feature!.number, 87);
  assert.equal(feature!.kind, 'feature');
  assert.deepEqual(
    feature!.standingDecisions.map((e) => e.id),
    ['d-0002'],
    'a superseded decision is not standing',
  );
  assert.deepEqual(
    feature!.openQuestions.map((e) => e.id),
    ['q-0003'],
  );
  assert.equal(buildStateSnapshot(system).config.discussions, true);
  system.store.close();
});

test("a feature's reading gathers its stories' open questions, and skips a story with nothing to say", async () => {
  const { system, folder } = build({ discussions: true, vault: true });
  world(system);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '142 Export to CSV.md'), STORY);
  writeFileSync(join(folder, '87 Reporting.md'), FEATURE);
  writeFileSync(
    join(folder, '143 Export to XLSX.md'),
    '---\nref: issue:143\nkind: story\n---\n\n## Note · 2026-11-03 · me\n\nhi\n',
  );

  const reading = await read(system, 87);
  assert.equal(reading.kind, 'feature');
  assert.equal(reading.entries.length, 4);
  assert.deepEqual(
    reading.related.map((r) => [r.number, r.kind, r.openQuestions.map((q) => q.id)]),
    [[142, 'story', ['q-21bc']]],
  );
  const path = join(folder, '87 Reporting.md');
  assert.equal(reading.obsidianUrl, `obsidian://open?path=${encodeURIComponent(path)}`);
  assert.equal(reading.related[0]!.obsidianUrl?.startsWith('obsidian://open?path='), true);
  system.store.close();
});

test('an issue with no file reads as empty but enabled, and a bad number is a 400', async () => {
  const { system } = build({ discussions: true });
  world(system);
  const reading = await read(system, 143);
  assert.equal(reading.enabled, true);
  assert.equal(reading.kind, 'story');
  assert.equal(reading.path, null);
  assert.deepEqual(reading.entries, []);

  const { app } = await buildApp(system);
  const res = await app.inject({ method: 'GET', url: '/api/discussions/nope' });
  assert.equal(res.statusCode, 400);
  await app.close();
  system.store.close();
});
