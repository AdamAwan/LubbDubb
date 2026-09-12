import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';

test('batched transcript: getTranscript returns the full concatenation', () => {
  const store = new Store(':memory:');
  const agentId = 'agent_x';

  const chunks = Array.from({ length: 500 }, (_, i) => `chunk-${i};`);
  for (const c of chunks) store.transcripts.appendTranscript(agentId, c);

  assert.equal(store.transcripts.getTranscript(agentId), chunks.join(''));
  store.close();
});

test('mid-stream getTranscript flushes the buffer so reads see everything', () => {
  const store = new Store(':memory:');
  const agentId = 'agent_mid';

  store.transcripts.appendTranscript(agentId, 'aaa');
  store.transcripts.appendTranscript(agentId, 'bbb');
  assert.equal(store.transcripts.getTranscript(agentId), 'aaabbb');

  store.transcripts.appendTranscript(agentId, 'ccc');
  assert.equal(store.transcripts.getTranscript(agentId), 'aaabbbccc');
  store.close();
});

test('explicit flushTranscript persists buffered data', () => {
  const store = new Store(':memory:');
  const agentId = 'agent_flush';
  store.transcripts.appendTranscript(agentId, 'hello ');
  store.transcripts.appendTranscript(agentId, 'world');
  store.transcripts.flushTranscript(agentId);
  assert.equal(store.transcripts.getTranscript(agentId), 'hello world');
  store.close();
});

test('batching writes far fewer rows than chunks appended', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-transcript-'));
  const dbPath = join(dir, 'store.db');
  const store = new Store(dbPath);
  const agentId = 'agent_rows';

  const chunks = Array.from({ length: 400 }, (_, i) => `small-${i};`);
  for (const c of chunks) store.transcripts.appendTranscript(agentId, c);
  store.transcripts.getTranscript(agentId);

  const reader = new Database(dbPath);
  const { n } = reader.prepare(`SELECT COUNT(*) AS n FROM agent_transcripts WHERE agent_id=?`).get(agentId) as {
    n: number;
  };
  reader.close();

  assert.ok(n < chunks.length, `expected batching to write fewer than ${chunks.length} rows, got ${n}`);
  assert.ok(n >= 1, 'at least one row should be written');
  assert.equal(store.transcripts.getTranscript(agentId), chunks.join(''));
  store.close();
});
