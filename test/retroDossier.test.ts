import { test } from 'node:test';
import assert from 'node:assert/strict';
import { padTestimony, retroDossier, retroPad, type RetroDossierInput } from '../src/retro/dossier.js';
import type { ScratchEntry } from '../src/types.js';

/** A decision the harness carried out: the row the dossier is allowed to summarise away. */
function routine(n: number): RetroDossierInput['decisions'][number] {
  return {
    rule: 'plan-part',
    action: { type: 'dispatch_code_agent' },
    outcome: 'executed',
    detail: `part ${n}`,
    admission: null,
  } as RetroDossierInput['decisions'][number];
}

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
    agentCount: 0,
    delivery: null,
    shortfall: null,
    appraisal: null,
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
      diagnosis: null,
      approach: null,
      risks: null,
      outOfScope: null,
      alternatives: null,
      openQuestions: null,
      verification: null,
      evidence: [],
      document: null,
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
      {
        rule: 'plan-part',
        action: { type: 'dispatch_code_agent' },
        outcome: 'executed',
        detail: 'ready',
        admission: null,
      },
      {
        rule: 'pr-ci',
        action: { type: 'dispatch_code_agent' },
        outcome: 'deferred',
        detail: 'cooldown',
        admission: null,
      },
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
      detail: null,
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

test('an uneventful run states the shape of its decision log instead of listing it', () => {
  const text = retroDossier({ ...bare(), decisions: Array.from({ length: 40 }, (_, i) => routine(i)) });

  assert.match(text, /40 decisions: 40 × `plan-part` — 40 executed\./);
  assert.match(text, /carried out as proposed/i, 'the reader is told the log holds no exceptions');
  assert.doesNotMatch(text, /part 7/, 'forty routine rows are what the shape line replaces');
  assert.doesNotMatch(text, /not shown here/, 'nothing was dropped: the counts say everything the rows would');
});

test('an eventful run keeps every exception in full, and names the admission that transformed it', () => {
  const decisions = [
    ...Array.from({ length: 40 }, (_, i) => routine(i)),
    {
      rule: 'pr-ci',
      action: { type: 'dispatch_code_agent' },
      outcome: 'skipped',
      detail: 'attempt cap',
      admission: 'cooldown-escalate',
    },
    {
      rule: 'issue-pickup',
      action: { type: 'notify_agent' },
      outcome: 'rejected',
      detail: 'branch busy',
      admission: null,
    },
  ] as RetroDossierInput['decisions'];
  const text = retroDossier({ ...bare(), decisions });

  assert.match(text, /42 decisions:/);
  assert.match(text, /40 executed/);
  assert.match(text, /attempt cap/, 'a skipped decision is rendered as a row, never as a count');
  assert.match(text, /cooldown-escalate/, 'what became of the proposal is the retrospective’s subject');
  assert.match(text, /branch busy/);
  // The routine tail rides along for context, and says how much of itself it dropped.
  assert.match(text, /part 39/, 'the end of the run is what a retrospective is usually about');
  assert.doesNotMatch(text, /part 0\b/, 'the earliest routine rows go first');
  assert.match(text, /30 of the 40 decisions that were carried out are not shown here/);
});

test('a sparse list survives alongside a saturated one, and every cap names its total', () => {
  const text = retroDossier({
    ...bare(),
    decisions: Array.from({ length: 300 }, (_, i) => ({ ...routine(i), outcome: 'deferred' }) as never),
    escalations: Array.from(
      { length: 20 },
      (_, i) => ({ type: 'answer_question', status: 'answered', prompt: `q${i}`, response: null }) as never,
    ),
  });

  // Three hundred decisions must not crowd out twenty escalations.

  assert.match(text, /280 of the 300 decisions that went another way are not shown here/);
  assert.match(text, /8 of the 20 escalations are not shown here/);
  assert.match(text, /q19/, 'the newest escalations are the ones kept');
  assert.doesNotMatch(text, /q7\b/);
});

test('a run below every cap renders exactly the rows it always did', () => {
  const prs = [
    { number: 41, title: 'Schema', state: 'merged' },
    { number: 42, title: 'Wiring', state: 'open' },
  ] as RetroDossierInput['pullRequests'];
  const text = retroDossier({ ...bare(), closedPullRequests: prs.slice(0, 1), pullRequests: prs.slice(1) });

  assert.match(text, /#41 Schema — merged/);
  assert.match(text, /#42 Wiring — open/);
  assert.doesNotMatch(text, /not shown here/, 'a dossier that dropped nothing must not read as a partial one');
});

test('the retro pad is bounded far above what a goal writes, and says so when it bites', () => {
  const entry = (i: number): ScratchEntry =>
    ({
      authorOriginRef: `issue:12:part:p${i}`,
      topic: null,
      note: `note ${i}`,
      decision: null,
      createdAt: '2026-07-30T09:00:00Z',
    }) as ScratchEntry;

  assert.equal(retroPad([]), '', 'an empty pad still renders nothing at all');

  const small = retroPad(Array.from({ length: 20 }, (_, i) => entry(i)));
  assert.match(small, /note 0/, 'a normal goal’s testimony is nowhere near the cap');
  assert.doesNotMatch(small, /not shown here/);

  const huge = retroPad(Array.from({ length: 70 }, (_, i) => entry(i)));
  assert.match(huge, /note 69/);
  assert.doesNotMatch(huge, /note 5\b/, 'over the cap the oldest go — recent notes are still true of the code');
  assert.match(huge, /10 of the 70 notes on this pad are not shown here/);
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
    decision: null,
    createdAt: '2026-07-30T09:00:00Z',
  };
  const text = padTestimony([entry]);
  assert.match(text, /issue:12:part:schema/);
  assert.match(text, /> needed a PRAGMA check/);
  assert.match(text, /> before the ALTER/, 'a multi-line note stays inside the quote');
  assert.match(text, /not instructions/i, 'an agent must not read a colleague’s note as the harness’s own');
});
