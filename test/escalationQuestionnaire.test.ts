import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/system.js';
import { buildApp } from '../src/server/app.js';
import type { Spawner, StreamChild } from '../src/agents/streamJsonSession.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';

/**
 * An agent with three things to settle used to have one question line and one
 * answer box, so it wrote all three into `detail` and spent its options on "which
 * shall we start with?". The questionnaire is the shape that was missing: a list
 * of questions on the ask, and one reply carrying all the answers back.
 *
 * What these hold: the list survives the trip to the inbox, the *server* folds the
 * answers into the reply (so a second client cannot phrase it differently), and an
 * unanswered question is sent as such rather than dropped — an agent that hears
 * about two of three would sit waiting on the third.
 */

class FakeChild extends EventEmitter implements StreamChild {
  pid = 556;
  writes: string[] = [];
  private out = new EventEmitter();
  stdout = { on: (ev: string, cb: (d: string) => void) => this.out.on(ev, cb) } as unknown as NodeJS.ReadableStream;
  stderr = null;
  stdin = { write: (d: string) => this.writes.push(d), end: () => {} } as unknown as NodeJS.WritableStream;
  emitLine(obj: unknown): void {
    this.out.emit('data', JSON.stringify(obj) + '\n');
  }
  override on(event: 'exit', cb: (code: number | null) => void): this {
    return super.on(event, cb);
  }
  kill(): void {
    this.emit('exit', 143);
  }
}

const QUESTIONS = [
  { question: 'Split part one, or leave it as two?', options: ['Split into three', 'Keep two'] },
  { question: 'Keep the operator-parks-a-note path?', detail: 'Scope the acceptance criteria do not ask for.' },
  { question: 'Rename the type?' },
];

/** A stream-mode system with one agent parked on a three-question ask. */
async function parkedOnQuestionnaire() {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-qn-'));
  const children: FakeChild[] = [];
  const spawner: Spawner = () => {
    const c = new FakeChild();
    children.push(c);
    return c;
  };
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'stream',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      heartbeatIntervalMs: 999_999,
      auth: { enabled: false } as never,
    }),
    { worktrees: new FakeWorktreeManager(), streamSpawner: spawner, errorMirror: () => {} },
  );
  system.connector.inject({ kind: 'new_issue', number: 902, title: 'Add login' });
  await system.harness.runCycle('manual');
  const child = children[0]!;
  const agentId = system.store.listAgentsByStatus('starting', 'running')[0]!.id;

  const asked = system.agents.ask(agentId, {
    question: "I've read the plan against the code — three things I'd question.",
    kind: 'clarify',
    questions: QUESTIONS,
  });
  assert.ok(asked.ok && asked.escalationId, 'the ask parked the agent');
  const escalation = system.store.listOpenEscalations()[0]!;
  return { system, child, escalation };
}

test('a questionnaire reaches the inbox as a list, headline intact', async () => {
  const { system, escalation } = await parkedOnQuestionnaire();

  assert.match(escalation.prompt, /three things I'd question/, 'the headline is still the prompt');
  const questions = escalation.context.questions;
  assert.equal(questions?.length, 3);
  assert.deepEqual(questions?.[0]?.options, ['Split into three', 'Keep two']);
  assert.match(questions?.[1]?.detail ?? '', /acceptance criteria/);

  system.store.close();
});

test('answering folds every answer into one reply and settles the item', async () => {
  const { system, child, escalation } = await parkedOnQuestionnaire();
  const { app } = await buildApp(system);
  const before = child.writes.length;

  const res = await app.inject({
    method: 'POST',
    url: `/api/escalations/${escalation.id}/answer`,
    payload: { answers: ['Keep two', null, 'Yes — expectedKind'] },
  });
  assert.equal(res.statusCode, 200);

  const answered = system.store.getEscalation(escalation.id)!;
  assert.equal(answered.status, 'answered');
  // One reply, in order, with the questions restated: the agent gets the answers
  // attached to what it asked rather than three bare lines it has to re-pair.
  assert.match(answered.response ?? '', /1\. Split part one, or leave it as two\?\n> Keep two/);
  assert.match(answered.response ?? '', /3\. Rename the type\?\n> Yes — expectedKind/);
  // The one left blank is *told*, not dropped — otherwise the agent waits on it.
  assert.match(answered.response ?? '', /2\. Keep the operator-parks-a-note path\?\n> \(no answer/);

  const typed = child.writes.slice(before).join('');
  assert.match(typed, /Keep two/, 'the reply was typed into the parked session');

  await app.close();
  system.store.close();
});

test('the answers arm refuses what it cannot line up', async () => {
  const { system, escalation } = await parkedOnQuestionnaire();
  const { app } = await buildApp(system);

  const short = await app.inject({
    method: 'POST',
    url: `/api/escalations/${escalation.id}/answer`,
    payload: { answers: ['Keep two'] },
  });
  assert.equal(short.statusCode, 400, 'a client that disagrees about what was asked is refused');
  assert.match(short.json().error, /expected 3 answers/);

  const blank = await app.inject({
    method: 'POST',
    url: `/api/escalations/${escalation.id}/answer`,
    payload: { answers: [null, '  ', null] },
  });
  assert.equal(blank.statusCode, 400, 'a reply saying nothing is not worth typing into a session');

  const both = await app.inject({
    method: 'POST',
    url: `/api/escalations/${escalation.id}/answer`,
    payload: { response: 'Keep two', answers: ['Keep two', 'Cut it', 'Yes'] },
  });
  assert.equal(both.statusCode, 400, 'which text the agent would get is ambiguous');

  // Still open, and still answerable the ordinary way.
  assert.equal(system.store.listOpenEscalations().length, 1);
  const free = await app.inject({
    method: 'POST',
    url: `/api/escalations/${escalation.id}/answer`,
    payload: { response: 'All three: keep two, cut it, rename it.' },
  });
  assert.equal(free.statusCode, 200, 'the free-text route is unchanged by any of this');

  await app.close();
  system.store.close();
});

test('a plain question refuses the answers arm rather than inventing questions for it', async () => {
  const { system } = await parkedOnQuestionnaire();
  const { app } = await buildApp(system);
  const agentId = system.store.listOpenEscalations()[0]!.agentId!;
  system.escalations.dismiss(system.store.listOpenEscalations()[0]!.id, 'making room');
  const asked = system.agents.ask(agentId, { question: 'Which tenant?' });
  assert.ok(asked.ok && asked.escalationId);

  const res = await app.inject({
    method: 'POST',
    url: `/api/escalations/${asked.escalationId}/answer`,
    payload: { answers: ['the default one'] },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /no questionnaire/);

  await app.close();
  system.store.close();
});
