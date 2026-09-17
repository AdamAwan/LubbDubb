import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';

function store(): Store {
  return new Store(':memory:');
}

test('the first press mints version 1, superseding nothing', () => {
  const s = store();
  try {
    const first = s.goalCriteria.appendCriteria({
      originRef: 'issue:1',
      text: 'the button is primary and the dialog closes on save',
      author: 'operator',
      reason: null,
    });
    assert.equal(first.version, 1);
    assert.equal(first.supersedes, null, 'there was nothing before it to point at');
    assert.equal(first.originRef, 'issue:1');
  } finally {
    s.close();
  }
});

test('an edit mints version 2 pointing at version 1', () => {
  const s = store();
  try {
    const first = s.goalCriteria.appendCriteria({
      originRef: 'issue:1',
      text: 'the button is primary',
      author: 'operator',
      reason: null,
    });
    const second = s.goalCriteria.appendCriteria({
      originRef: 'issue:1',
      text: 'the button is primary and the dialog closes on save',
      author: 'operator',
      reason: 'the dialog was never mentioned',
    });
    assert.equal(second.version, 2);
    assert.equal(second.supersedes, first.id, 'the chain names what it replaced');
    assert.equal(second.reason, 'the dialog was never mentioned');
  } finally {
    s.close();
  }
});

test('currentCriteria answers the newest version, and null for a goal nobody wrote on', () => {
  const s = store();
  try {
    assert.equal(s.goalCriteria.currentCriteria('issue:9'), null, 'never written is not the same as empty');
    s.goalCriteria.appendCriteria({ originRef: 'issue:1', text: 'first', author: null, reason: null });
    s.goalCriteria.appendCriteria({ originRef: 'issue:1', text: 'second', author: null, reason: null });
    const third = s.goalCriteria.appendCriteria({ originRef: 'issue:1', text: 'third', author: null, reason: null });

    const current = s.goalCriteria.currentCriteria('issue:1');
    assert.equal(current?.id, third.id);
    assert.equal(current?.text, 'third');
    assert.equal(current?.version, 3);
  } finally {
    s.close();
  }
});

test('listCriteriaVersions reads the chain oldest first', () => {
  const s = store();
  try {
    for (const text of ['first', 'second', 'third'])
      s.goalCriteria.appendCriteria({ originRef: 'issue:1', text, author: null, reason: null });
    const chain = s.goalCriteria.listCriteriaVersions('issue:1');
    assert.deepEqual(
      chain.map((v) => v.text),
      ['first', 'second', 'third'],
      'the order they were written in is the order they read in',
    );
    assert.deepEqual(
      chain.map((v) => v.version),
      [1, 2, 3],
    );
    assert.deepEqual(
      chain.map((v) => v.supersedes),
      [null, chain[0]?.id, chain[1]?.id],
      'each version but the first points back at the one before it',
    );
  } finally {
    s.close();
  }
});

test('an edit leaves the superseded text readable unchanged — the store is append-only', () => {
  const s = store();
  try {
    const first = s.goalCriteria.appendCriteria({
      originRef: 'issue:1',
      text: 'the button is primary',
      author: 'operator',
      reason: null,
    });
    s.goalCriteria.appendCriteria({
      originRef: 'issue:1',
      text: 'the button is secondary after all',
      author: 'operator',
      reason: 'design changed its mind',
    });

    const [oldest] = s.goalCriteria.listCriteriaVersions('issue:1');
    assert.equal(oldest?.id, first.id, 'the first row is still there');
    assert.equal(oldest?.text, 'the button is primary', 'and says what it said when it was written');
    assert.equal(oldest?.authoredAt, first.authoredAt, 'including when');
    assert.equal(s.goalCriteria.listCriteriaVersions('issue:1').length, 2, 'an edit adds, it does not replace');
  } finally {
    s.close();
  }
});

test('each goal keeps its own chain', () => {
  const s = store();
  try {
    s.goalCriteria.appendCriteria({ originRef: 'issue:1', text: 'one', author: null, reason: null });
    s.goalCriteria.appendCriteria({ originRef: 'issue:1', text: 'one again', author: null, reason: null });
    const other = s.goalCriteria.appendCriteria({ originRef: 'issue:2', text: 'two', author: null, reason: null });
    assert.equal(other.version, 1, 'a second goal starts its own numbering');
    assert.equal(other.supersedes, null);
    assert.equal(s.goalCriteria.listCriteriaVersions('issue:1').length, 2);
    assert.equal(s.goalCriteria.listCriteriaVersions('issue:2').length, 1);
  } finally {
    s.close();
  }
});
