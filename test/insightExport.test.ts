import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import type { ReliabilityInsights, SpendInsights, SpendPhase } from '../web/src/types.js';
import { repoText } from './support/paths.js';

(globalThis as { React?: typeof React }).React = React;

const { toCsv } = await import('../web/src/components/Downloads.js');
const { spendCsv } = await import('../web/src/components/EconomicsTab.js');
const { reliabilityCsv } = await import('../web/src/components/ReliabilityTab.js');

const WINDOW = {
  key: '7d',
  label: '7d',
  bucketLabel: '6h buckets',
  since: '2026-08-06T09:00:00.000Z',
  startsAt: '2026-08-06T09:00:00.000Z',
  bucketMs: 6 * 60 * 60 * 1000,
  buckets: 28,
  session: null,
} as const;

function section(csv: string, name: string): string[] {
  const lines = csv.split('\r\n');
  const at = lines.indexOf(name);
  assert.notEqual(at, -1, `the export is missing its "${name}" section`);
  const rest = lines.slice(at + 1);
  const end = rest.indexOf('');
  return end === -1 ? rest : rest.slice(0, end);
}

test('a field is quoted when it must be, and left alone when it need not be', () => {
  assert.equal(toCsv([['plain', 1]]), 'plain,1');
  assert.equal(toCsv([['a,b']]), '"a,b"');
  assert.equal(toCsv([['say "hi"']]), '"say ""hi"""');
  assert.equal(toCsv([['two\nlines']]), '"two\nlines"');
  assert.equal(toCsv([[' padded ']]), '" padded "');
  assert.equal(toCsv([[null, 'x']]), ',x');
  assert.equal(toCsv([['a'], [], ['b']]), 'a\r\n\r\nb');
});

const PHASES: SpendPhase[] = ['deliberation', 'build'];

function insights(over: Partial<SpendInsights> = {}): SpendInsights {
  const zero = (): Record<SpendPhase, number> => ({
    deliberation: 0,
    build: 0,
    landing: 0,
    ci: 0,
    evidence: 0,
    local: 0,
    obstacle: 0,
    job: 0,
    other: 0,
  });
  return {
    generatedAt: '2026-08-13T09:00:00.000Z',
    totals: {
      costUsd: 0.004,
      inputTokens: 1234567,
      outputTokens: 8901,
      cacheReadTokens: 900000,
      cacheCreationTokens: 34567,
      cacheMeasuredInputTokens: 1000000,
      turns: 42,
      measuredRuns: 3,
      unmeasuredRuns: 5,
    },
    window: WINDOW,
    landed: 2,
    lostCostUsd: 0.001,
    phases: PHASES.map((phase) => ({
      phase,
      label: phase === 'build' ? 'Build' : 'Deliberation',
      blurb: 'what it is, per the server',
      costUsd: 0.002,
      inputTokens: 600000,
      outputTokens: 4000,
      runs: 1,
    })),
    goals: [
      {
        originRef: 'issue:7',
        issueNumber: 7,
        costUsd: 0.003,
        inputTokens: 1000,
        outputTokens: 100,
        agents: 2,
        localRuns: 0,
        title: 'Rework the intake, "properly"',
        byPhase: { ...zero(), deliberation: 0.001, build: 0.002 },
        lastAt: '2026-08-13T08:00:00.000Z',
      },
    ],
    unattributedCostUsd: 0.001,
    runs: [
      {
        id: 'a1',
        kind: 'agent',
        originRef: 'issue:7',
        title: 'Plan it',
        phase: 'deliberation',
        issueNumber: 7,
        costUsd: 0.003,
        inputTokens: 1000,
        outputTokens: 100,
        numTurns: null,
        startedAt: '2026-08-13T07:00:00.000Z',
        endedAt: null,
      },
    ],
    rankedFrom: 9,
    taskTypes: [
      {
        rule: 'issue-pickup',
        label: 'Pick a goal up',
        description: 'Starts the first agent on a watched goal',
        costUsd: 0.002,
        runs: 1,
        perRunUsd: 0.002,
      },
    ],
    checks: { checks: [], seen: 0, attributedCostUsd: 0, unnamedCostUsd: 0.0005 },
    timeline: {
      bucketMs: 86_400_000,
      startsAt: '2026-08-12T09:00:00.000Z',
      buckets: [{ startsAt: '2026-08-12T09:00:00.000Z', costUsd: 0.004 }],
    },
    ...over,
  };
}

test('spend leaves at full precision — the cockpit’s rounding stops at the screen', () => {
  const csv = spendCsv(insights());
  assert.ok(section(csv, 'Totals').includes('Cost in window (USD),0.004'));
  assert.ok(section(csv, 'Totals').includes('Input tokens,1234567'));
  assert.ok(section(csv, 'Runs').some((r) => r.includes(',0.003,')));
  assert.ok(!csv.includes('$'), 'a formatted figure is a presentation, not an export');
});

test('spend carries every table the panel draws, in the order it draws them', () => {
  const csv = spendCsv(insights());
  const lead = `\r\n${csv}`;
  const names = ['Totals', 'Phases', 'Daily', 'Task types', 'Failing checks', 'Goals', 'Runs'];
  const order = names.map((s) => lead.indexOf(`\r\n${s}\r\n`));
  assert.ok(
    order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1]!)),
    'the sections must all be present and in panel order',
  );
  const goals = section(csv, 'Goals');
  assert.ok(goals[0]?.endsWith('deliberation,build'), 'a goal row carries a column per phase');
  assert.ok(goals[1]?.includes('"Rework the intake, ""properly"""'));
});

test('the caveats the panel says in prose leave as rows', () => {
  const csv = spendCsv(insights());
  assert.ok(section(csv, 'Goals').some((r) => r.startsWith(',Reached no goal,0.001')));
  assert.ok(csv.includes('The 1 costliest of 9 measured runs.'));
  assert.ok(section(csv, 'Totals').includes('Unmeasured runs,5'));
  assert.ok(section(csv, 'Failing checks').includes('Named no check,0.0005'));
  assert.ok(section(csv, 'Failing checks').some((r) => r.includes('costliest of 0 checks seen')));
});

function yieldOf(over: Partial<ReliabilityInsights> = {}): ReliabilityInsights {
  return {
    generatedAt: '2026-08-13T09:00:00.000Z',
    window: WINDOW,
    runs: {
      settled: 8,
      live: 1,
      completed: 6,
      lost: 1,
      stopped: 1,
      completionRate: 0.75,
      costUsd: 12.5,
      lostCostUsd: 1.25,
      unmeasuredRuns: 2,
      byOutcome: [{ outcome: 'done', label: 'Finished', blurb: 'The agent ran to its own end', runs: 6, costUsd: 10 }],
      byPhase: [
        {
          phase: 'build',
          label: 'Build',
          settled: 4,
          completed: 3,
          lost: 1,
          stopped: 0,
          completionRate: 0.75,
          lostCostUsd: 1.25,
          medianMs: 12_600_000,
        },
      ],
      repeats: [
        {
          originRef: 'issue:7',
          title: 'Rework the intake',
          runs: 3,
          lost: 1,
          costUsd: 4.5,
          lastAt: '2026-08-13T08:00:00.000Z',
        },
      ],
      repeatedOrigins: 4,
      timeline: { bucketMs: 86_400_000, startsAt: '2026-08-12T09:00:00.000Z', buckets: [] },
    },
    ci: {
      reds: 9,
      greens: 21,
      redRate: 0.3,
      prsAffected: 3,
      prsObserved: 5,
      recoveries: 2,
      medianToGreenMs: 900_000,
      slowestToGreenMs: 3_600_000,
      unrecovered: 1,
      flakiest: [{ ref: 'pr:143', prNumber: 143, reds: 5, greens: 2, redMs: 7_200_000, costUsd: 1.5, stillRed: true }],
      ciCostUsd: 3.4,
      landingCostUsd: 2.75,
      timeline: {
        bucketMs: 86_400_000,
        startsAt: '2026-08-12T09:00:00.000Z',
        buckets: [{ startsAt: '2026-08-12T09:00:00.000Z', red: 2, green: 5 }],
      },
    },
    ...over,
  };
}

test('yield leaves at full precision too — a rate as a fraction, a wait in milliseconds', () => {
  const csv = reliabilityCsv(yieldOf(), null);
  assert.ok(section(csv, 'Tallies').includes('Completion rate,0.75'), 'not the panel’s 75%');
  assert.ok(section(csv, 'Tallies').includes('CI red rate,0.3'));
  assert.ok(section(csv, 'Tallies').includes('Median back to green (ms),900000'));
  assert.ok(
    section(csv, 'Phases').some((r) => r.endsWith(',12600000')),
    'a median run leaves in ms, not as 3.5h',
  );
  assert.ok(!csv.includes('%') && !csv.includes('$'), 'a formatted figure is a presentation, not an export');
});

test('yield carries the six tables the panel draws, in the order it draws them', () => {
  const csv = reliabilityCsv(yieldOf(), null);
  const lead = `\r\n${csv}`;
  const names = ['Tallies', 'Outcomes', 'CI verdicts by day', 'Phases', 'Reddest pull requests', 'Ran more than once'];
  const order = names.map((s) => lead.indexOf(`\r\n${s}\r\n`));
  assert.ok(
    order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1]!)),
    'the sections must all be present and in panel order',
  );
  assert.ok(section(csv, 'Reddest pull requests').some((r) => r.startsWith('pr:143,143,5,2,7200000,1.5,yes')));
});

test('the causes half leaves with its caveat, or does not leave at all', () => {
  assert.ok(!reliabilityCsv(yieldOf(), null).includes('\r\nCauses\r\n'));

  const csv = reliabilityCsv(yieldOf(), {
    accounts: 2,
    costUsd: 8.5,
    unaccounted: 3,
    byKind: [
      {
        kind: 'ci',
        accounts: 2,
        costUsd: 8.5,
        byCause: [
          {
            cause: 'missed_gate',
            label: 'Missed gate',
            blurb: 'the gate would have',
            accounts: 2,
            costUsd: 8.5,
            undocumented: 1,
            topCheck: { name: 'format:check', accounts: 2 },
          },
        ],
      },
      { kind: 'review', accounts: 0, costUsd: 0, byCause: [] },
    ],
    byGuard: [{ guard: 'local_check', label: 'The local check', blurb: 'run the gate', accounts: 2, costUsd: 8.5 }],
    recent: [
      {
        id: 'rmd_1',
        kind: 'ci',
        ref: 'pr:143',
        prNumber: 143,
        cause: 'missed_gate',
        causeLabel: 'Missed gate',
        guard: 'local_check',
        guardLabel: 'The local check',
        summary: 'line endings',
        checks: ['format:check'],
        at: '2026-08-20T09:00:00.000Z',
      },
    ],
  });

  const causes = section(csv, 'Causes');
  assert.ok(causes.includes('Dispatches that filed nothing,3'));
  assert.ok(causes.some((r) => r.startsWith('An account is,')), 'an account is not a red'); // prettier-ignore
  assert.ok(causes.some((r) => r.startsWith('Cost is,')), 'divided money must say it is divided'); // prettier-ignore
  assert.ok(section(csv, 'By cause').some((r) => r.startsWith('ci,missed_gate,')));
  assert.ok(section(csv, 'Lately').some((r) => r.includes('format:check')));
});

test('the method note leaves as rows — the two windows, what a red is, what stopped is not', () => {
  const csv = reliabilityCsv(yieldOf(), null);
  const tallies = section(csv, 'Tallies');
  assert.ok(tallies.includes('Window,7d'));
  assert.ok(tallies.some((r) => r.startsWith('Window opened (ISO),')));
  assert.ok(tallies.some((r) => r.startsWith('A red is,')), 'a reader summing reds must know they are verdicts'); // prettier-ignore
  assert.ok(tallies.some((r) => r.startsWith('Cost per red is,')));
  assert.ok(tallies.some((r) => r.startsWith('Counts against the completion rate,')));
  assert.ok(csv.includes('The 1 reddest of 3 pull requests that went red.'));
  assert.ok(csv.includes('The 1 most-repeated of 4 origins that ran more than once.'));
});

test('the page exports nothing it could not fetch — there is no file of zeroes', () => {
  const src = repoText('web/src/components/InsightsPage.tsx');
  const first = src.indexOf('<Downloads');
  assert.notEqual(first, -1, 'the page must offer an export');
  assert.ok(src.includes('spend !== null'), "the spend tabs' export must be gated on a payload");
  assert.ok(src.includes('reliability !== null'), "the run tabs' export must be gated on a payload");
  assert.ok(src.includes('node: () => page.current'), 'the print sheet must be handed the page it prints');
  assert.ok(src.includes('lubbdubb-${view}'), 'the file must be named for the tab it came from');
});
