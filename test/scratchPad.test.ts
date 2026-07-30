import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PAD_NOTE, normalisePadNote, padOriginFor, padWriteTarget } from '../src/scratch/pad.js';

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

test('an empty note is refused; a topic is collapsed to one short line', () => {
  assert.equal(normalisePadNote('   ', undefined).ok, false);
  const withTopic = normalisePadNote('the migration needed a PRAGMA check', '  store\nschema  ');
  assert.equal(withTopic.ok, true);
  if (!withTopic.ok) return;
  assert.equal(withTopic.topic, 'store schema');
  assert.equal(withTopic.trimmed, false);
});
