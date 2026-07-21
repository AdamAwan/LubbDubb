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
  for (const c of chunks) store.appendTranscript(agentId, c);

  assert.equal(store.getTranscript(agentId), chunks.join(''));
  store.close();
});

test('mid-stream getTranscript flushes the buffer so reads see everything', () => {
  const store = new Store(':memory:');
  const agentId = 'agent_mid';

  store.appendTranscript(agentId, 'aaa');
  store.appendTranscript(agentId, 'bbb');
  // A read before any threshold flush must still return the buffered data.
  assert.equal(store.getTranscript(agentId), 'aaabbb');

  // Appending after a read keeps concatenation order intact.
  store.appendTranscript(agentId, 'ccc');
  assert.equal(store.getTranscript(agentId), 'aaabbbccc');
  store.close();
});

test('explicit flushTranscript persists buffered data', () => {
  const store = new Store(':memory:');
  const agentId = 'agent_flush';
  store.appendTranscript(agentId, 'hello ');
  store.appendTranscript(agentId, 'world');
  store.flushTranscript(agentId);
  assert.equal(store.getTranscript(agentId), 'hello world');
  store.close();
});

test('batching writes far fewer rows than chunks appended', () => {
  // Use a real file so a second connection can count rows independently.
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-transcript-'));
  const dbPath = join(dir, 'store.db');
  const store = new Store(dbPath);
  const agentId = 'agent_rows';

  const chunks = Array.from({ length: 400 }, (_, i) => `small-${i};`); // each tiny, well under 16KB
  for (const c of chunks) store.appendTranscript(agentId, c);
  store.getTranscript(agentId); // force a flush of the remaining buffer

  const reader = new Database(dbPath);
  const { n } = reader.prepare(`SELECT COUNT(*) AS n FROM agent_transcripts WHERE agent_id=?`).get(agentId) as {
    n: number;
  };
  reader.close();

  assert.ok(n < chunks.length, `expected batching to write fewer than ${chunks.length} rows, got ${n}`);
  assert.ok(n >= 1, 'at least one row should be written');
  assert.equal(store.getTranscript(agentId), chunks.join(''));
  store.close();
});
