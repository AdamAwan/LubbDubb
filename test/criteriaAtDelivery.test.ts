import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { buildApp } from '../src/server/app.js';
import { buildSystem } from '../src/system.js';
import { FakePtyBackend } from '../src/pty/fakeBackend.js';
import { FakeGitObserver } from '../src/git/fakeGitObserver.js';
import { FakeWorktreeManager } from '../src/worktree/fakeWorktreeManager.js';
import { criteriaItems } from '../src/criteria/items.js';
import { coverageLines, criteriaCoverage } from '../src/criteria/coverage.js';
import { validationCheckInputs, validationCheckSetInputs } from '../src/validation/checkDocument.js';
import { NO_STEP_CAPABILITIES } from '../src/validation/steps.js';
import { authoringBriefing } from '../src/validation/authoring.js';
import { closeOutPass } from '../src/delivery/closeOut.js';
import type { IssueDelivery, ValidationCheck, ValidationCheckState } from '../src/types.js';
import { planWithOnePart } from './support/plans.js';

// → docs/spec/20-validation.md#satisfies-and-the-goals-criteria

test('a criteria version is read as its list, markers stripped and blanks dropped', () => {
  assert.deepEqual(
    criteriaItems('- Refunds post in a minute\n\n* The customer is emailed\n1. No double entry\n[x] Audited'),
    ['Refunds post in a minute', 'The customer is emailed', 'No double entry', 'Audited'],
  );
  assert.deepEqual(criteriaItems(null), []);
});

test('a check names only criteria the current version states; anything else is dropped', () => {
  const [input] = validationCheckSetInputs(
    [
      {
        id: 'refund',
        title: 'Refund',
        do: 'Refund an order',
        expect: 'One ledger row',
        uses: [],
        covers: [],
        satisfies: ['No double entry', 'Something the operator never wrote'],
        fleetCandidate: false,
      },
    ],
    [],
    [],
    NO_STEP_CAPABILITIES,
    ['No double entry', 'Audited'],
  );
  assert.deepEqual(input!.satisfies, ['No double entry']);
});

function check(letter: string, state: ValidationCheckState, satisfies: string[], over: Partial<ValidationCheck> = {}) {
  return { letter, state, satisfies, supersededReason: null, ...over } as ValidationCheck;
}

test('each criterion reads off the live checks that name it, and one nothing names is a gap', () => {
  const items = ['Met', 'Missed', 'Waived', 'Out', 'Nobody'];
  const coverage = criteriaCoverage(items, [
    check('A', 'passed', ['Met', 'Out']),
    check('B', 'failed', ['Missed']),
    check('C', 'passed', ['Missed']),
    check('D', 'waived', ['Waived']),
    check('E', 'unrun', ['Out']),
    check('F', 'passed', ['Nobody'], { supersededReason: 'withdrawn' }),
    check('G', 'declined', ['Nobody']),
  ]);
  assert.deepEqual(
    coverage.map((c) => [c.criterion, c.reading, c.checks]),
    [
      ['Met', 'met', ['A']],
      ['Missed', 'not-met', ['B', 'C']],
      ['Waived', 'waived', ['D']],
      ['Out', 'unread', ['A', 'E']],
      ['Nobody', 'gap', []],
    ],
  );
  assert.match(coverageLines(coverage)[4]!, /no check names it — Nobody/);
});

test("the validation planner is told the goal's criteria and asked for a check each", () => {
  const briefing = authoringBriefing({ hint: null, parts: [], environments: '', criteria: ['No double entry'] });
  assert.match(briefing, /What the operator said "done" means/);
  assert.match(briefing, /- No double entry/);
  assert.match(briefing, /at least one check per criterion/);
  assert.doesNotMatch(authoringBriefing({ hint: null, parts: [], environments: '' }), /"done" means/);
});

test('the close-out carries one line per criterion', () => {
  const delivery: IssueDelivery = {
    originRef: 'issue:12',
    summary: 'shipped',
    detail: null,
    by: 'assessor',
    agentId: null,
    taskId: null,
    decidedAt: '2026-08-11T10:00:00.000Z',
    updatedAt: '2026-08-11T10:00:00.000Z',
  };
  const steps = closeOutPass({
    issues: [{ id: 'i12', number: 12, title: 'Refunds', body: '', labels: [], state: 'open', linkedPrNumber: null }],
    deliveries: [delivery],
    shortfalls: [],
    existing: [],
    validation: new Map(),
    criteria: new Map([['issue:12', ['- ✅ met — No double entry (A)']]]),
    opened: null,
    validating: new Set(),
    watch: new Map(),
    watchCleared: null,
    canClose: true,
  });
  const filed = steps.find((s) => s.kind === 'file');
  assert.ok(filed && filed.kind === 'file');
  assert.match(filed.detail, /\*\*Your criteria\*\*\n\n- ✅ met — No double entry \(A\)/);
});

test('a check set round-trips what it satisfies, and the criteria route reads the coverage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lubbdubb-satisfies-'));
  const system = buildSystem(
    loadConfig({
      selfUpdate: { enabled: false } as never,
      auth: { enabled: false } as never,
      labelPrefix: '',
      dbPath: ':memory:',
      agentMode: 'raw',
      deskRoot: join(dir, 'desk'),
      worktreeRoot: join(dir, 'wt'),
      repoRoot: dir,
      heartbeatIntervalMs: 999_999,
      goalCriteria: { enabled: true },
    }),
    {
      backend: new FakePtyBackend(),
      gitObserver: new FakeGitObserver(),
      worktrees: new FakeWorktreeManager(),
      errorMirror: () => {},
    },
  );
  const { app } = await buildApp(system);
  try {
    planWithOnePart(system.store, 12);
    system.store.goalCriteria.appendCriteria({
      originRef: 'issue:12',
      text: '- No double entry\n- Audited',
      author: null,
      reason: null,
    });
    const [written] = system.store.validation.ingestValidation('issue:12', {
      checks: [
        {
          id: 'refund',
          seq: 1,
          title: 'Refund',
          do: 'Refund an order',
          expect: 'One ledger row',
          proof: null,
          uses: [],
          covers: [],
          satisfies: ['No double entry'],
          fleetCandidate: false,
          candidateWhy: null,
        },
      ],
      resources: [],
      supersededReason: 'replaced',
      amendNote: 'authored',
    });
    assert.deepEqual(written!.satisfies, ['No double entry']);
    assert.deepEqual(system.store.validation.listValidationChecks('issue:12')[0]!.satisfies, ['No double entry']);

    const [replanned] = system.store.validation.ingestValidation('issue:12', {
      checks: validationCheckInputs(
        {
          checks: [
            {
              id: 'refund',
              title: 'Refund',
              do: 'Refund an order',
              expect: 'One ledger row',
              uses: [],
              covers: [],
              fleetCandidate: false,
            },
          ],
        },
        [],
        criteriaItems('- No double entry\n- Audited'),
      ),
      resources: [],
      supersededReason: 'replaced',
      amendNote: 'replanned',
    });
    assert.deepEqual(replanned!.satisfies, ['No double entry'], 'a re-ingest that says nothing keeps what it answered');
    const [fromPlan] = validationCheckInputs(
      {
        checks: [
          {
            id: 'audit',
            title: 'Audit',
            do: 'd',
            expect: 'e',
            uses: [],
            covers: [],
            satisfies: ['Audited'],
            fleetCandidate: false,
          },
        ],
      },
      [],
      criteriaItems('- No double entry\n- Audited'),
    );
    assert.deepEqual(fromPlan!.satisfies, ['Audited'], "the plan file's path keeps what the criteria state");

    const reading = (await app.inject({ method: 'GET', url: '/api/goals/12/criteria' })).json() as {
      coverage: { criterion: string; reading: string }[];
    };
    assert.deepEqual(
      reading.coverage.map((c) => [c.criterion, c.reading]),
      [
        ['No double entry', 'unread'],
        ['Audited', 'gap'],
      ],
    );
  } finally {
    await app.close();
    system.store.close();
  }
});
