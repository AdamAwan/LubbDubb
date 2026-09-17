import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedFiles, diffFacts, renderDiffFacts } from '../src/pr/prDiff.js';
import {
  EMPTY_EVIDENCE,
  PR_EVIDENCE,
  coordinates,
  evidenceRefusal,
  renderEvidence,
  type EvidenceContext,
  type PrEvidence,
} from '../src/pr/prEvidence.js';

function diff(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, added]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n+${added}`)
    .join('\n');
}

const CODE_ONLY = diff({ 'src/sync/resume.ts': 'const cursor = read();' });
const CODE_AND_TEST = diff({
  'src/sync/resume.ts': 'const cursor = read();',
  'test/sync.test.ts': "test('resumes', () => {});",
});

function evidence(over: Partial<PrEvidence> = {}): PrEvidence {
  return { ...EMPTY_EVIDENCE, ...over };
}

function ctx(over: Partial<EvidenceContext> = {}): EvidenceContext {
  return { criteria: [], facts: diffFacts(CODE_AND_TEST), ...over };
}

const REACH = ['`src/sync/resume.ts:88` runs on every boot, with no config flag on it.'];

test('a coordinate is a path in the diff, and a bare word is not one', () => {
  assert.deepEqual(coordinates('`src/sync/resume.ts:88` runs on boot'), ['src/sync/resume.ts:88']);
  assert.deepEqual(coordinates('the resume path runs on boot, e.g. after a crash'), []);
  assert.deepEqual(coordinates('see prDiff.ts and web/src/app.tsx'), ['prDiff.ts', 'web/src/app.tsx']);
});

test('a change that touches nothing one-way is never asked about a one-way door', () => {
  const facts = diffFacts(CODE_AND_TEST);
  assert.deepEqual(facts?.oneWay, []);
  assert.equal(evidenceRefusal(evidence({ reach: REACH }), ctx()), null);
});

test('reach is owed by every code change, and the refusal says what is owed', () => {
  const refusal = evidenceRefusal(evidence(), ctx());
  assert.match(refusal ?? '', /`reach` is empty/);
  assert.match(refusal ?? '', /changes code that runs/);
});

test('code with no test beside it owes what nothing pins', () => {
  const only = ctx({ facts: diffFacts(CODE_ONLY) });
  const refusal = evidenceRefusal(evidence({ reach: REACH }), only);
  assert.match(refusal ?? '', /`unverified` is empty/);
  assert.match(refusal ?? '', /no test under/);
  assert.equal(
    evidenceRefusal(
      evidence({ reach: REACH, unverified: ['`src/sync/resume.ts:88` has no test for a database with rows.'] }),
      only,
    ),
    null,
  );
});

test('a schema statement in the diff owes what a revert would not take back', () => {
  const facts = diffFacts(diff({ 'src/store/sync.ts': "db.exec('ALTER TABLE sync_cursor ADD COLUMN last_seen');" }));
  assert.ok(facts!.oneWay.length >= 2, 'the path family and the statement both catch it');
  const refusal = evidenceRefusal(evidence({ reach: ['`src/store/sync.ts:41` runs at boot.'] }), ctx({ facts }));
  assert.match(refusal ?? '', /`oneWay` is empty/);
  assert.match(refusal ?? '', /database schema/);
});

test('a clone that could not read the diff owes nothing — every trigger fails open', () => {
  assert.equal(diffFacts(null), null);
  assert.equal(evidenceRefusal(evidence(), ctx({ facts: null })), null);
});

test('an entry with no coordinate is refused, because a reviewer cannot go and check it', () => {
  const refusal = evidenceRefusal(evidence({ reach: ['This runs on every boot with nothing gating it.'] }), ctx());
  assert.match(refusal ?? '', /names no place in the code/);
});

test('a coordinate the diff does not contain is refused, and the refusal quotes it', () => {
  const refusal = evidenceRefusal(evidence({ reach: ['`src/sync/poller.ts:12` runs on every boot.'] }), ctx());
  assert.match(refusal ?? '', /src\/sync\/poller\.ts:12/);
  assert.match(refusal ?? '', /changes no such file/);
});

test('a word that answers the question for the reviewer is refused by name', () => {
  for (const [word, entry] of [
    ['safe', '`src/sync/resume.ts:88` is a safe read on boot.'],
    ['minimal', '`src/sync/resume.ts:88` is a minimal change to the boot path.'],
    ['no risk', 'There is no risk to `src/sync/resume.ts:88` on an old database.'],
  ] as const) {
    const refusal = evidenceRefusal(evidence({ reach: [entry] }), ctx());
    assert.match(refusal ?? '', new RegExp(`says "${word}"`), entry);
    assert.match(refusal ?? '', /answers the reviewer's question for them/);
  }
});

test('the plainness rules and the entry caps apply to evidence as they do to bullets', () => {
  assert.match(
    evidenceRefusal(evidence({ reach: ['`src/sync/resume.ts:88` runs on boot; nothing gates it.'] }), ctx()) ?? '',
    /semicolon/,
  );
  const long = `\`src/sync/resume.ts:88\` ${'runs on every boot and reads the cursor back '.repeat(4)}again.`;
  assert.match(evidenceRefusal(evidence({ reach: [long] }), ctx()) ?? '', /One line each/);
  const many = Array.from({ length: PR_EVIDENCE.entries + 1 }, () => '`src/sync/resume.ts:88` runs on boot.');
  assert.match(evidenceRefusal(evidence({ reach: many }), ctx()) ?? '', /the limit is 4/);
});

const CRITERIA = ['The cursor is stored per source.', 'Resume reads the cursor at boot.'];

test('a part with criteria owes one entry per criterion, and the refusal lists them', () => {
  const withCriteria = ctx({ criteria: CRITERIA });
  const missing = evidenceRefusal(evidence({ reach: REACH }), withCriteria);
  assert.match(missing ?? '', /`satisfies` is empty/);
  assert.match(missing ?? '', /1\. The cursor is stored per source\./);

  const short = evidenceRefusal(evidence({ reach: REACH, satisfies: ['`src/sync/resume.ts:88`'] }), withCriteria);
  assert.match(short ?? '', /has 1 entries and this part has 2 acceptance criteria/);
});

test('a criterion that is not met is said so rather than pointed at a file', () => {
  assert.equal(
    evidenceRefusal(
      evidence({
        reach: REACH,
        satisfies: ['`src/sync/resume.ts:88`', 'not met: the backfill is part 2 of the plan.'],
      }),
      ctx({ criteria: CRITERIA }),
    ),
    null,
  );
});

test('a decided entry must name the road not taken', () => {
  const refusal = evidenceRefusal(evidence({ reach: REACH, decided: ['Used a per-source cursor.'] }), ctx());
  assert.match(refusal ?? '', /does not say what it was decided against/);
  assert.equal(
    evidenceRefusal(evidence({ reach: REACH, decided: ['A per-source cursor, not one global cursor.'] }), ctx()),
    null,
  );
});

test('evidence that is short and still hard to read is refused as a set', () => {
  const dense = [
    '`src/sync/resume.ts:88` instantiates deterministic reconciliation.',
    '`src/sync/resume.ts:88` guarantees idempotent materialization.',
  ];
  assert.match(evidenceRefusal(evidence({ reach: dense }), ctx()) ?? '', /reading ease/);
});

test('the rendered block draws the criteria from the plan and never from the agent', () => {
  const rendered = renderEvidence({
    evidence: evidence({ reach: REACH, satisfies: ['`src/store/sync.ts:41`', 'not met: part 2.'] }),
    criteria: CRITERIA,
    issueNumber: 412,
    issueTitle: 'Resume the sync',
    facts: diffFacts(CODE_AND_TEST),
  });
  assert.match(rendered, /1\. The cursor is stored per source\. → `src\/store\/sync\.ts:41`/);
  assert.match(rendered, /2\. Resume reads the cursor at boot\. → not met: part 2\./);
  assert.match(rendered, /\*\*Cannot be undone\*\*\n- _none named_/);
  assert.doesNotMatch(rendered, /Tests changed/, 'the test flag is on the pull request already');
  assert.doesNotMatch(rendered, /2 files/, 'so is the list of files, one tab over');
  assert.doesNotMatch(rendered, /One-way surfaces/, 'and this diff touches none');
});

test('a pickup with no criteria renders the issue instead, rather than an empty list', () => {
  const rendered = renderEvidence({
    evidence: evidence({ reach: REACH }),
    criteria: [],
    issueNumber: 412,
    issueTitle: 'Resume the sync',
    facts: null,
  });
  assert.match(rendered, /- #412 Resume the sync/);
  assert.match(rendered, /No acceptance criteria were recorded/);
  assert.match(rendered, /The clone could not read this diff\./);
});

test('changed files are read off the diff, including a rename’s new name', () => {
  const renamed =
    'diff --git a/src/old.ts b/src/new.ts\nsimilarity index 98%\nrename from src/old.ts\nrename to src/new.ts';
  assert.deepEqual(changedFiles(renamed), ['src/new.ts']);
  assert.deepEqual(changedFiles(CODE_AND_TEST), ['src/sync/resume.ts', 'test/sync.test.ts']);
});

test('the computed block names the one-way surfaces it found, and nothing else', () => {
  const facts = diffFacts(diff({ 'src/store/sync.ts': "db.exec('DELETE FROM sync_cursor');" }))!;
  const lines = renderDiffFacts(facts).join('\n');
  assert.match(lines, /database schema and its migrations: `src\/store\/sync\.ts`/);
  assert.match(lines, /rows this deletes/);
});
