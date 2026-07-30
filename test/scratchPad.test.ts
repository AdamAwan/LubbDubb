import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PAD_NOTE, normalisePadNote, padOriginFor, padWriteTarget } from '../src/scratch/pad.js';
import { Store } from '../src/store/store.js';

test('padOriginFor maps every origin in an issue subtree to the issue', () => {
  assert.equal(padOriginFor('issue:12'), 'issue:12');
  assert.equal(padOriginFor('issue:12:plan'), 'issue:12');
  assert.equal(padOriginFor('issue:12:assay'), 'issue:12');
  assert.equal(padOriginFor('issue:12:assess'), 'issue:12');
  assert.equal(padOriginFor('issue:12:retro'), 'issue:12');
  assert.equal(padOriginFor('issue:12:part:schema'), 'issue:12');
});

test('padOriginFor refuses everything outside one issue', () => {
  assert.equal(padOriginFor('pr:42:ci'), null);
  assert.equal(padOriginFor('job:job_abc'), null);
  assert.equal(padOriginFor('story:s-1:work'), null);
  assert.equal(padOriginFor(null), null);
  assert.equal(padOriginFor('issue:notanumber'), null);
});

test('padWriteTarget names the tool a refused caller actually wants', () => {
  assert.deepEqual(padWriteTarget('issue:12:part:schema'), { ok: true, padRef: 'issue:12' });
  const refused = padWriteTarget('pr:42:ci');
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.error, /pr:42:ci/);
  assert.match(refused.error, /report_finding|note_progress/);
});

test('a pad note is trimmed rather than refused, and says so', () => {
  const long = normalisePadNote('x'.repeat(MAX_PAD_NOTE + 50), undefined);
  assert.equal(long.ok, true);
  if (!long.ok) return;
  assert.equal(long.trimmed, true);
  assert.equal(long.note.length, MAX_PAD_NOTE);
  assert.equal(long.topic, null);
});

test('pad entries are appended and read back oldest first, one pad per issue', () => {
  const store = new Store(':memory:');
  store.appendScratchEntry({
    padRef: 'issue:12',
    authorOriginRef: 'issue:12:part:schema',
    agentId: 'a1',
    taskId: 't1',
    topic: 'store',
    note: 'the migration needed a PRAGMA check',
  });
  store.appendScratchEntry({
    padRef: 'issue:12',
    authorOriginRef: 'issue:12:part:dispatcher',
    agentId: 'a2',
    taskId: 't2',
    topic: null,
    note: 'reused the schema part branch as a base',
  });
  store.appendScratchEntry({
    padRef: 'issue:99',
    authorOriginRef: 'issue:99',
    agentId: 'a3',
    taskId: 't3',
    topic: null,
    note: 'another goal entirely',
  });

  const entries = store.listScratchEntries('issue:12');
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.note, 'the migration needed a PRAGMA check');
  assert.equal(entries[0]?.authorOriginRef, 'issue:12:part:schema');
  assert.equal(entries[0]?.topic, 'store');
  assert.equal(entries[1]?.topic, null);
  assert.ok((entries[0]?.createdAt ?? '') <= (entries[1]?.createdAt ?? ''));
  assert.deepEqual(
    store.listScratchEntries('issue:99').map((e) => e.note),
    ['another goal entirely'],
  );
  assert.deepEqual(store.listScratchEntries('issue:7'), []);
});

test('an empty note is refused; a topic is collapsed to one short line', () => {
  assert.equal(normalisePadNote('   ', undefined).ok, false);
  const withTopic = normalisePadNote('the migration needed a PRAGMA check', '  store\nschema  ');
  assert.equal(withTopic.ok, true);
  if (!withTopic.ok) return;
  assert.equal(withTopic.topic, 'store schema');
  assert.equal(withTopic.trimmed, false);
});
