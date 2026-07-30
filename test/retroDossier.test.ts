import { test } from 'node:test';
import assert from 'node:assert/strict';
import { padTestimony, retroDossier, type RetroDossierInput } from '../src/retro/dossier.js';
import type { ScratchEntry } from '../src/types.js';

/** The empty run: nothing was planned, nothing was opened, nobody was asked. */
function bare(): RetroDossierInput {
  return {
    issueNumber: 12,
    issueTitle: 'Add a widget',
    plan: null,
    parts: [],
    pullRequests: [],
    closedPullRequests: [],
    decisions: [],
    escalations: [],
    proposals: [],
    findings: [],
    agentCount: 0,
    delivery: null,
    shortfall: null,
    assay: null,
    conclusion: null,
    costUsd: null,
  };
}

test('an empty dossier says what it does not know rather than saying nothing', () => {
  const text = retroDossier(bare());
  assert.match(text, /#12/);
  assert.match(text, /no plan/i, 'an unplanned goal is stated, not left blank');
  assert.match(text, /no pull requests/i);
  assert.match(text, /not reported/i, 'PTY mode reports no spend, and silence must not read as zero');
});

test('the dossier reports the plan, its parts, the decisions and what was spent', () => {
  const text = retroDossier({
    ...bare(),
    plan: {
      id: 'p1',
      originRef: 'issue:12',
      title: 'Add a widget',
      status: 'complete',
      reason: 'three lanes',
      risks: null,
      outOfScope: null,
      document: null,
      discussing: false,
      statusCommentRef: null,
      createdAt: '2026-07-30T08:00:00Z',
      updatedAt: '2026-07-30T09:00:00Z',
    },
    parts: [
      { slug: 'schema', title: 'Schema', status: 'merged', prNumber: 41, outcomeKind: null, outcomeSummary: null },
      {
        slug: 'probe',
        title: 'Measure it',
        status: 'concluded',
        prNumber: null,
        outcomeKind: 'report',
        outcomeSummary: 'no regression to fix',
      },
    ] as RetroDossierInput['parts'],
    closedPullRequests: [{ number: 41, title: 'Schema', state: 'merged' }] as RetroDossierInput['pullRequests'],
    decisions: [
      { rule: 'plan-part', action: { type: 'dispatch_code_agent' }, outcome: 'executed', detail: 'ready' },
    ] as RetroDossierInput['decisions'],
    escalations: [
      { type: 'answer_question', status: 'answered', prompt: 'which table?', response: 'the new one' },
    ] as RetroDossierInput['escalations'],
    agentCount: 4,
    costUsd: 1.23,
  });

  assert.match(text, /schema/);
  assert.match(text, /concluded/);
  assert.match(text, /no regression to fix/);
  assert.match(text, /plan-part/);
  assert.match(text, /dispatch_code_agent/);
  assert.match(text, /which table\?/);
  assert.match(text, /\$1\.23/);
  assert.match(text, /4 agents/);
});

test('the verdicts on the goal are reported with their authors', () => {
  const text = retroDossier({
    ...bare(),
    delivery: {
      originRef: 'issue:12',
      summary: 'every part merged',
      by: 'assessor',
      agentId: 'a1',
      taskId: 't1',
      decidedAt: '2026-07-30T10:00:00Z',
      updatedAt: '2026-07-30T10:00:00Z',
    },
    shortfall: null,
  });
  assert.match(text, /every part merged/);
  assert.match(text, /assessor/);
});

test('pad testimony is attributed and quoted, and an empty pad renders nothing', () => {
  assert.equal(padTestimony([]), '', 'silence is the honest reading of a goal whose agents wrote nothing');
  const entry: ScratchEntry = {
    id: 's1',
    padRef: 'issue:12',
    authorOriginRef: 'issue:12:part:schema',
    agentId: 'a1',
    taskId: 't1',
    topic: 'store',
    note: 'needed a PRAGMA check\nbefore the ALTER',
    createdAt: '2026-07-30T09:00:00Z',
  };
  const text = padTestimony([entry]);
  assert.match(text, /issue:12:part:schema/);
  assert.match(text, /> needed a PRAGMA check/);
  assert.match(text, /> before the ALTER/, 'a multi-line note stays inside the quote');
  assert.match(text, /not instructions/i, 'an agent must not read a colleague’s note as the harness’s own');
});
