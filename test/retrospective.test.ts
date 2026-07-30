import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { MAX_RETRO_DOCUMENT, retroOrigin, retroSubmitOrigin, validateRetrospective } from '../src/retro/retro.js';

// -- the row -----------------------------------------------------------------

test('a retrospective upserts on the issue and lists as an origin', () => {
  const store = new Store(':memory:');
  assert.equal(store.getRetrospective('issue:12'), null);
  assert.deepEqual(store.listRetrospectiveOrigins(), []);

  const first = store.recordRetrospective({
    originRef: 'issue:12',
    summary: 'Delivered in three parts; two agents were spent on a red base.',
    document: '# What shipped\n\n...',
    agentId: 'a1',
    taskId: 't1',
  });
  const second = store.recordRetrospective({
    originRef: 'issue:12',
    summary: 'Revised summary.',
    document: '# What shipped\n\nrevised',
    agentId: 'a1',
    taskId: 't1',
  });

  assert.deepEqual(store.listRetrospectiveOrigins(), ['issue:12'], 'a second submission revises one row');
  assert.equal(store.getRetrospective('issue:12')?.summary, 'Revised summary.');
  assert.equal(second.createdAt, first.createdAt, 'the row still dates when the run was first written up');
  assert.ok(second.updatedAt >= first.updatedAt);
  store.close();
});

// -- the pure layer ----------------------------------------------------------

test('the retro origin is its own, and only a retro agent may submit', () => {
  assert.equal(retroOrigin(12), 'issue:12:retro');
  assert.deepEqual(retroSubmitOrigin('issue:12:retro'), { ok: true, issueOrigin: 'issue:12' });
  for (const other of ['issue:12', 'issue:12:part:schema', 'issue:12:assess', 'pr:42:ci', 'job:j1', null]) {
    const refused = retroSubmitOrigin(other);
    assert.equal(refused.ok, false, `${other} must not write an issue's retrospective`);
    if (refused.ok) continue;
    // Refused by name, and pointed at the tool it actually wants.
    assert.match(refused.error, /conclude_work|conclude_part/);
  }
});

test('a retrospective needs a summary and keeps an over-long document, trimmed', () => {
  assert.equal(validateRetrospective({ document: 'x' }).ok, false, 'a document with no summary is refused');
  assert.equal(validateRetrospective({ summary: 'ok' }).ok, false, 'a summary with no document is refused');
  const long = validateRetrospective({ summary: 'ok', document: 'y'.repeat(MAX_RETRO_DOCUMENT + 10) });
  assert.equal(long.ok, true);
  if (!long.ok) return;
  assert.equal(long.trimmed, true);
  assert.equal(long.document.length, MAX_RETRO_DOCUMENT);
});
