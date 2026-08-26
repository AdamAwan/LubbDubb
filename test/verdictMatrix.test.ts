import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { SCHEMA } from '../src/store/schema.js';
import { VERDICT_EXCLUSIONS, VERDICT_KINDS, VERDICT_TABLES, type VerdictKind } from '../src/store/verdicts.js';

// Issue #222. The mutual-exclusion matrix used to be four half-rows, one inline
// DELETE per writer, covered pairwise where somebody remembered — so a fifth
// verdict table's row was covered only if its author thought to add a test. This
// walks the *declaration* instead, so a cell nobody thought to assert cannot
// exist: the fixture map is `Record<VerdictKind, …>`, which makes a new kind a
// compile error here as well as in `VERDICT_EXCLUSIONS` itself.

type Fixture = {
  write(store: Store, originRef: string): void;
  read(store: Store, originRef: string): unknown | null;
};

const FIXTURES: Record<VerdictKind, Fixture> = {
  conclusion: {
    write: (s, ref) => void s.recordIssueConclusion({ originRef: ref, verdict: 'done', note: 'shipped', by: 'agent' }),
    read: (s, ref) => s.getIssueConclusion(ref),
  },
  delivery: {
    write: (s, ref) => void s.recordDelivery({ originRef: ref, summary: 'every criterion is met', by: 'assessor' }),
    read: (s, ref) => s.getDelivery(ref),
  },
  shortfall: {
    write: (s, ref) =>
      void s.recordShortfall({ originRef: ref, cause: 'plan', summary: 'the shape was wrong', by: 'assessor' }),
    read: (s, ref) => s.getShortfall(ref),
  },
  appraisal: {
    write: (s, ref) =>
      void s.recordAppraisal({
        originRef: ref,
        verdict: 'workable',
        summary: 'clear enough',
        goalRef: 'g1',
        by: 'appraiser',
      }),
    read: (s, ref) => s.getAppraisal(ref),
  },
};

test('every declared cell: writing a verdict clears exactly what the matrix says, and nothing else', () => {
  for (const written of VERDICT_KINDS) {
    const cleared = VERDICT_EXCLUSIONS[written];
    for (const standing of VERDICT_KINDS) {
      if (standing === written) continue;
      const s = new Store(':memory:');

      FIXTURES[standing].write(s, 'issue:12');
      FIXTURES[written].write(s, 'issue:12');

      assert.ok(FIXTURES[written].read(s, 'issue:12'), `writing a ${written} should leave one standing`);
      const expectCleared = cleared.includes(standing);
      assert.equal(
        FIXTURES[standing].read(s, 'issue:12') === null,
        expectCleared,
        expectCleared
          ? `a ${written} must clear a standing ${standing}`
          : `a ${written} must leave a standing ${standing} alone — they answer different questions`,
      );
      s.close();
    }
  }
});

test('a kind that clears nothing is a declared empty row, not an omission', () => {
  // The one cell the prose could not distinguish from "nobody considered this".
  assert.deepEqual(VERDICT_EXCLUSIONS.appraisal, []);

  const s = new Store(':memory:');
  // A shortfall and a conclusion may stand together — the assessor's verdict does
  // not overwrite the working agent's own statement about its own run — so this
  // is the widest honest state, and an appraisal written over it disturbs none of it.
  FIXTURES.shortfall.write(s, 'issue:12');
  FIXTURES.conclusion.write(s, 'issue:12');
  FIXTURES.appraisal.write(s, 'issue:12');

  assert.ok(FIXTURES.appraisal.read(s, 'issue:12'));
  assert.ok(FIXTURES.shortfall.read(s, 'issue:12'));
  assert.ok(FIXTURES.conclusion.read(s, 'issue:12'));
  s.close();
});

test('the matrix is applied per issue', () => {
  const s = new Store(':memory:');
  for (const written of VERDICT_KINDS) {
    for (const standing of VERDICT_EXCLUSIONS[written]) {
      FIXTURES[standing].write(s, 'issue:13');
      FIXTURES[written].write(s, 'issue:12');
      assert.ok(FIXTURES[standing].read(s, 'issue:13'), `issue 13 kept its ${standing}`);
    }
  }
  s.close();
});

test('every kind names a real table', () => {
  // The walk above exercises a table name only where some kind clears it, so
  // `appraisal`'s would otherwise be unchecked until a later row named it.
  for (const kind of VERDICT_KINDS) {
    assert.ok(
      SCHEMA.includes(`CREATE TABLE IF NOT EXISTS ${VERDICT_TABLES[kind]}`),
      `${kind} → ${VERDICT_TABLES[kind]}`,
    );
  }
});
