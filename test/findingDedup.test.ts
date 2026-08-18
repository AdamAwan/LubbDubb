import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { buildSystem, type System } from '../src/system.js';
import { loadConfig } from '../src/config.js';
import type { Finding, FindingInput } from '../src/types.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * One claim, one card.
 *
 * The exact key (agent, kind, ref, summary) only ever caught an agent repeating
 * itself verbatim. The duplicates an operator actually saw came from the two
 * cases it is blind to: a *second agent* on a different task reporting the same
 * discovery, and one agent wording the same claim differently on a later turn.
 * Both merge into the row that already stands; a **dismissed** row is not one
 * that stands, and that asymmetry is the other half of the subject here.
 */

function build(): System {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-findings-'));
  return buildSystem(
    loadConfig({
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
    }),
    { worktrees: new FakeWorktreeManager(), backend: new FakePtyBackend(), errorMirror: () => {} },
  );
}

/** An agent on its own task — findings are attributed through that pair. */
function spawnAgent(system: System, title: string) {
  const task = system.store.createTask({
    kind: 'code',
    title,
    prompt: 'do it',
    branch: `feat/${title}`,
    originRef: null,
  });
  const agent = system.agents.spawn(task, mkdtempSync(join(tmpdir(), 'lubbdubb-wt-')));
  return { agent, task };
}

function report(
  system: System,
  who: ReturnType<typeof spawnAgent>,
  input: Partial<FindingInput> & { summary: string },
) {
  return system.store.recordFinding(who.agent.id, who.task.id, who.task.originRef, {
    kind: 'out_of_scope',
    ref: null,
    where: null,
    detail: null,
    ...input,
  });
}

const CLAIM = 'The ingest route buffers the whole body before rejecting it';

function summaries(system: System): string[] {
  return system.store.listFindings().map((f: Finding) => f.summary);
}

test('a second agent reporting the same claim joins the standing finding', () => {
  const system = build();
  const first = report(system, spawnAgent(system, 'one'), { summary: CLAIM, where: 'src/server/routes/ingest.ts' });
  assert.equal(first.created, true);

  // Different agent, different task, same discovery — and not the same string:
  // punctuation and case are exactly what two agents never agree on.
  const second = report(system, spawnAgent(system, 'two'), {
    summary: `The ingest route buffers the **whole body** before rejecting it.`,
    detail: 'Watched RSS peak at 1.4GB.',
  });
  assert.equal(second.created, false);
  assert.equal(second.finding.id, first.finding.id);
  assert.equal(summaries(system).length, 1);

  // Its evidence is backfilled where the row had none, and the first reporter's
  // own `where` is left alone.
  assert.equal(second.finding.where, 'src/server/routes/ingest.ts');
  assert.equal(second.finding.detail, 'Watched RSS peak at 1.4GB.');
  assert.equal(second.finding.agentId, first.finding.agentId);
});

test('a restatement that only appends a qualifier is the same claim', () => {
  const system = build();
  const who = spawnAgent(system, 'one');
  report(system, who, { summary: CLAIM });
  const again = report(system, who, { summary: `${CLAIM} on large uploads` });
  assert.equal(again.created, false);
  assert.equal(summaries(system).length, 1);
});

test('a different kind or a different ref is a different finding', () => {
  const system = build();
  const who = spawnAgent(system, 'one');
  report(system, who, { summary: CLAIM });
  assert.equal(report(system, who, { summary: CLAIM, kind: 'blocked' }).created, true);
  assert.equal(report(system, who, { summary: CLAIM, ref: 'issue:41' }).created, true);
  assert.equal(summaries(system).length, 3);
});

test('a short claim does not swallow a longer one that contains it', () => {
  const system = build();
  const who = spawnAgent(system, 'one');
  report(system, who, { summary: 'Flaky test' });
  const other = report(system, who, { summary: 'Flaky test in the ingest suite, unrelated to this PR' });
  assert.equal(other.created, true);
  assert.equal(summaries(system).length, 2);
});

test('a dismissed finding is not a standing one: another agent restating it files afresh', () => {
  const system = build();
  const first = report(system, spawnAgent(system, 'one'), { summary: CLAIM });
  assert.ok(system.store.resolveFinding(first.finding.id, 'dismissed'));

  const second = report(system, spawnAgent(system, 'two'), { summary: `${CLAIM}.` });
  assert.equal(second.created, true);
  assert.notEqual(second.finding.id, first.finding.id);
  assert.equal(second.finding.status, 'open');
});

test('an agent repeating its own dismissed report stays on the dismissed row', () => {
  const system = build();
  const who = spawnAgent(system, 'one');
  const first = report(system, who, { summary: CLAIM });
  assert.ok(system.store.resolveFinding(first.finding.id, 'dismissed'));

  const again = report(system, who, { summary: CLAIM, detail: 'Still there.' });
  assert.equal(again.created, false);
  assert.equal(again.finding.id, first.finding.id);
  assert.equal(again.finding.status, 'dismissed');
  // Its own author may overwrite the evidence.
  assert.equal(again.finding.detail, 'Still there.');
  assert.equal(summaries(system).length, 1);
});

test('a promoted finding still absorbs a restatement — it is answered, not gone', () => {
  const system = build();
  const first = report(system, spawnAgent(system, 'one'), { summary: CLAIM });
  assert.ok(system.store.resolveFinding(first.finding.id, 'promoted', 'job_1'));

  const second = report(system, spawnAgent(system, 'two'), { summary: `${CLAIM}!` });
  assert.equal(second.created, false);
  assert.equal(second.finding.id, first.finding.id);
  assert.equal(second.finding.status, 'promoted');
});
