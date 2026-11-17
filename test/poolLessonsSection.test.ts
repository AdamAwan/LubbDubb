import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/store.js';
import { FakePoolTransport } from '../src/integrations/fake/fakePool.js';
import { foldPoolLessons } from '../src/pool/aggregate.js';
import { buildDigestDocument, type PoolLessonContext } from '../src/pool/digestArm.js';
import { POOL_SCHEMA_VERSION, parsePoolDocument, serialisePoolDocument } from '../src/pool/document.js';
import { renderPoolMarkdown } from '../src/pool/markdown.js';
import { PoolDesk } from '../src/pool/poolDesk.js';
import type { PoolLessonMirrorRow } from '../src/store/pool.js';
import type { PoolDigestDocument, PoolLessonRow } from '../src/types.js';

// → docs/spec/28-cross-fleet-pool.md#the-lessons-section, docs/spec/41-repo-lessons.md#across-fleets

const SCOPED = { pullRequests: true, issues: true };
const DAY = 24 * 60 * 60 * 1000;
const NOW = '2026-08-24T12:00:00.000Z';

const CONTEXT: PoolLessonContext = {
  reviewAreas: [],
  lessonLabel: 'lesson',
  refUrl: (ref) => (ref.startsWith('pr:') ? `https://git.example/acme/api/pull/${ref.slice(3)}` : null),
};

function lesson(over: Partial<PoolLessonRow> = {}): PoolLessonRow {
  return {
    kind: 'ci',
    cause: 'missed_gate',
    guards: { documented: 0, undocumented: 2 },
    fix: 'guard',
    prUrl: 'https://git.example/acme/api/pull/90',
    mergedAt: '2026-07-01T00:00:00.000Z',
    before: { misses: 4, dispatches: 10 },
    after: { misses: 1, dispatches: 10 },
    ...over,
  };
}

function digest(fleetId: string, project: string, lessons: PoolLessonRow[], publishedAt = NOW): PoolDigestDocument {
  return {
    pool: POOL_SCHEMA_VERSION,
    kind: 'digest',
    fleetId,
    project,
    publishedAt,
    harnessVersion: '0.1.0',
    byPhase: [{ day: publishedAt.slice(0, 10), key: 'build', count: 1, costUsd: 1, partial: false }],
    byCause: [],
    byCheck: [],
    unaccounted: [],
    unmeasured: [],
    byUsage: [],
    byThroughput: [],
    poolableThroughput: [],
    byFault: [],
    byChoice: [],
    byRule: [],
    byVersion: [],
    lessons,
  };
}

function mirrored(over: Partial<PoolLessonMirrorRow>): PoolLessonMirrorRow {
  return { ...lesson(), fleetId: 'bob@acme-api', project: 'acme-api', ...over };
}

function storeWithAdoptedLesson(clock: { at: number }): Store {
  const s = new Store(':memory:', () => new Date(clock.at).toISOString());
  const draft = s.lessons.openDraft({
    groupKey: 'ci/missed_gate/lint',
    kind: 'ci',
    cause: 'missed_gate',
    where: 'lint',
    goals: ['issue:1', 'issue:2'],
    misses: [
      { remedyId: 'r1', prNumber: 1, goal: 'issue:1', guard: 'undocumented', summary: 'lint went red' },
      { remedyId: 'r2', prNumber: 2, goal: 'issue:2', guard: 'documented', summary: 'lint went red again' },
    ],
    briefing: 'evidence',
  });
  assert.ok(draft);
  s.lessons.claimDraft(draft.id, 'task-1');
  s.lessons.concludePr(draft.id, 90, {
    fix: 'guard',
    title: 'Run lint before pushing',
    summary: 'a lint step in the pre-push hook',
    reason: 'the rule was written down and still missed',
  });
  s.lessons.settle(draft.id, 'adopted', ['pr-open']);
  return s;
}

test('an adopted lesson is published as counts and a link, and never a title, a where or free text', () => {
  const clock = { at: Date.parse('2026-07-01T00:00:00Z') };
  const s = storeWithAdoptedLesson(clock);
  clock.at = Date.parse(NOW);

  const document = buildDigestDocument(s, {
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: NOW,
    scope: SCOPED,
    lessons: CONTEXT,
  });

  assert.equal(document.lessons.length, 1);
  const [row] = document.lessons;
  assert.deepEqual(Object.keys(row!).sort(), [
    'after',
    'before',
    'cause',
    'fix',
    'guards',
    'kind',
    'mergedAt',
    'prUrl',
  ]);
  assert.equal(row!.prUrl, 'https://git.example/acme/api/pull/90');
  assert.deepEqual(row!.guards, { documented: 1, undocumented: 1 });
  assert.deepEqual(row!.before, { misses: 0, dispatches: 0 });
  assert.notEqual(row!.after, null, 'merged more than 30 days before the publish');

  const text = serialisePoolDocument(document);
  for (const prose of [
    'Run lint before pushing',
    'pre-push hook',
    'still missed',
    'lint went red',
    '"where"',
    '"title"',
  ]) {
    assert.ok(!text.includes(prose), `${prose} never crosses`);
  }
});

test('a lesson whose link cannot be resolved, or one outside the retention, is not published', () => {
  const clock = { at: Date.parse('2026-07-01T00:00:00Z') };
  const s = storeWithAdoptedLesson(clock);
  const base = { fleetId: 'alice@acme-api', project: 'acme-api', harnessVersion: '0.1.0', scope: SCOPED };

  const unresolved = buildDigestDocument(s, { ...base, now: NOW, lessons: { ...CONTEXT, refUrl: () => null } });
  assert.deepEqual(unresolved.lessons, []);

  const later = new Date(Date.parse('2026-07-01T00:00:00Z') + 91 * DAY).toISOString();
  const retired = buildDigestDocument(s, { ...base, now: later, lessons: CONTEXT });
  assert.deepEqual(retired.lessons, [], 'past the ninety days');

  const young = buildDigestDocument(s, { ...base, now: '2026-07-10T00:00:00.000Z', lessons: CONTEXT });
  assert.equal(young.lessons[0]?.after, null, 'too early: the after side is null');
});

test('a document without the section parses to no lessons, and a malformed row is dropped', () => {
  const { lessons: _lessons, ...without } = digest('bob@acme-api', 'acme-api', []);
  const parsedWithout = parsePoolDocument(JSON.stringify(without));
  assert.ok(parsedWithout.ok);
  assert.deepEqual(parsedWithout.document.lessons, []);

  const raw = {
    ...digest('bob@acme-api', 'acme-api', []),
    lessons: [
      { ...lesson(), title: 'Run lint before pushing', where: 'lint', summary: 'prose' },
      { ...lesson(), cause: 'not-a-cause' },
      { ...lesson(), kind: 'review', cause: 'missed_gate' },
      { ...lesson(), fix: 'magic' },
      { ...lesson(), prUrl: 'javascript:alert(1)' },
      { ...lesson(), mergedAt: 'yesterday' },
      { ...lesson(), before: null },
      { ...lesson(), after: 'soon' },
      'a string',
    ],
  };
  const parsed = parsePoolDocument(JSON.stringify(raw));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.document.lessons, [lesson()], 'one row survives, rebuilt without its extra fields');
  assert.ok(!('title' in parsed.document.lessons[0]!) && !('where' in parsed.document.lessons[0]!));
});

test('own fleet’s lessons are never mirrored, another fleet’s are, and expiry drops them with the digest', async () => {
  let at = Date.parse(NOW);
  const s = new Store(':memory:', () => new Date(at).toISOString());
  const transport = new FakePoolTransport();
  transport.seed(digest('alice@acme-api', 'acme-api', [lesson({ prUrl: 'https://git.example/own/1' })]));
  transport.seed(digest('bob@acme-api', 'acme-api', [lesson()]));
  const desk = new PoolDesk({
    store: s,
    transport,
    fleetId: 'alice@acme-api',
    project: 'acme-api',
    harnessVersion: '0.1.0',
    now: () => new Date(at).toISOString(),
    digestIntervalMs: 60 * 60 * 1000,
    worldScope: SCOPED,
  });

  await desk.run();
  assert.deepEqual(
    s.pool.listPoolLessons().map((l) => [l.fleetId, l.prUrl]),
    [['bob@acme-api', 'https://git.example/acme/api/pull/90']],
  );

  at += 8 * DAY;
  await desk.run();
  assert.deepEqual(s.pool.listPoolLessons(), [], 'a week past its digest, its lessons go with its rows');
});

test('two fleets publishing one lesson are one row, read from the newer digest', () => {
  const s = new Store(':memory:', () => NOW);
  for (const [fleetId, publishedAt, misses] of [
    ['bob@acme-api', '2026-08-20T00:00:00.000Z', 3],
    ['carol@acme-api', '2026-08-23T00:00:00.000Z', 5],
  ] as const) {
    s.pool.replaceFleetDigest(
      fleetId,
      'acme-api',
      digest(fleetId, 'acme-api', [lesson({ before: { misses, dispatches: 10 } })], publishedAt),
    );
    s.pool.recordFleetReading({ fleetId, project: 'acme-api', digestAt: publishedAt, ahead: false });
  }
  const rows = s.pool.listPoolLessons();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.fleetId, 'carol@acme-api');
  assert.equal(rows[0]!.before.misses, 5);
});

test('a cause is a company-wide candidate at three projects, counting this fleet’s own, and not at two', () => {
  const two = [mirrored({ project: 'a', prUrl: 'https://x/1' }), mirrored({ project: 'b', prUrl: 'https://x/2' })];
  assert.deepEqual(foldPoolLessons(two, { project: null, causes: [] }).companyWide, []);
  assert.deepEqual(
    foldPoolLessons(two, { project: 'a', causes: ['missed_gate'] }).companyWide,
    [],
    'own lesson in a project already counted adds nothing',
  );

  const three = foldPoolLessons(two, { project: 'c', causes: ['missed_gate'] });
  assert.deepEqual(
    three.companyWide.map((c) => [c.cause, c.projects]),
    [['missed_gate', 3]],
  );
  assert.ok(three.lessons.every((l) => l.companyWide));
});

test('lessons are ranked by the relative drop in rate, with too-early last', () => {
  const folded = foldPoolLessons(
    [
      mirrored({ prUrl: 'https://x/early', after: null }),
      mirrored({
        prUrl: 'https://x/half',
        before: { misses: 4, dispatches: 10 },
        after: { misses: 2, dispatches: 10 },
      }),
      mirrored({
        prUrl: 'https://x/worse',
        before: { misses: 2, dispatches: 10 },
        after: { misses: 4, dispatches: 10 },
      }),
      mirrored({ prUrl: 'https://x/gone', before: { misses: 3, dispatches: 10 }, after: { misses: 0, dispatches: 4 } }),
      mirrored({
        prUrl: 'https://x/unread',
        before: { misses: 0, dispatches: 0 },
        after: { misses: 1, dispatches: 3 },
      }),
    ],
    { project: null, causes: [] },
  );
  assert.deepEqual(
    folded.lessons.map((l) => [l.prUrl, l.effectPct]),
    [
      ['https://x/gone', 100],
      ['https://x/half', 50],
      ['https://x/worse', -100],
      ['https://x/unread', null],
      ['https://x/early', null],
    ],
  );
});

test('the companion renders the lessons section with each link and no prose', () => {
  const markdown = renderPoolMarkdown(
    digest('alice@acme-api', 'acme-api', [
      lesson(),
      lesson({ prUrl: 'https://git.example/acme/api/pull/91', after: null }),
    ]),
  );
  assert.match(markdown, /## Lessons the repository kept/);
  assert.match(
    markdown,
    /\| CI · .+ \| guard \| 0 \| 2 \| 2026-07-01 \| 4 \/ 10 \| 1 \/ 10 \| <https:\/\/git\.example\/acme\/api\/pull\/90> \|/,
  );
  assert.match(markdown, /\| too early \| <https:\/\/git\.example\/acme\/api\/pull\/91> \|/);

  const none = renderPoolMarkdown(digest('alice@acme-api', 'acme-api', []));
  assert.match(none, /No lesson adopted in the last ninety days\./);
});
