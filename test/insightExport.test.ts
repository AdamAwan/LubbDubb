import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import type { ReliabilityInsights, SpendInsights, SpendPhase } from '../web/src/types.js';

/**
 * The two insight panels as files.
 *
 * Two things separate an export from a screenshot, and both are what this pins:
 * a figure leaves **unrounded**, because the cockpit's formatting is for a glance
 * and a column of `$0.00` sums to nothing; and every **caveat the panel states in
 * prose** — the truncated ranking, the unattributed remainder, the two halves
 * measured over different windows — leaves with it, because a spreadsheet opened
 * in six months has no panel beside it to read them from.
 */

// The panels are JSX compiled with the classic runtime; the global goes in before
// they load, as `console.test.ts` does.
(globalThis as { React?: typeof React }).React = React;

const { toCsv } = await import('../web/src/components/Downloads.js');
const { spendCsv } = await import('../web/src/components/SpendModal.js');
const { reliabilityCsv } = await import('../web/src/components/ReliabilityModal.js');

/** The rows of a named section, up to the blank line that ends it. */
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
  // A reader that trims a field silently changes a title, so the spaces are kept
  // by quoting rather than trusted to survive.
  assert.equal(toCsv([[' padded ']]), '" padded "');
  // Null is "not recorded", which is what a blank cell already means — never the
  // four letters.
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
    job: 0,
    other: 0,
  });
  return {
    generatedAt: '2026-08-13T09:00:00.000Z',
    totals: {
      costUsd: 0.004,
      inputTokens: 1234567,
      outputTokens: 8901,
      turns: 42,
      measuredRuns: 3,
      unmeasuredRuns: 5,
    },
    windows: { fiveHourCostUsd: 0.002, sevenDayCostUsd: 0.004 },
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
        title: 'Rework the intake, "properly"',
        byPhase: { ...zero(), deliberation: 0.001, build: 0.002 },
        lastAt: '2026-08-13T08:00:00.000Z',
      },
    ],
    unattributedCostUsd: 0.001,
    runs: [
      {
        agentId: 'a1',
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
  // Every one of these renders as `$0.00` or `1.2M` on the panel. A hundred rows
  // of `$0.00` add up to real money, so the file carries the number.
  assert.ok(section(csv, 'Totals').includes('All-time cost (USD),0.004'));
  assert.ok(section(csv, 'Totals').includes('Input tokens,1234567'));
  assert.ok(section(csv, 'Runs').some((r) => r.includes(',0.003,')));
  assert.ok(!csv.includes('$'), 'a formatted figure is a presentation, not an export');
});

test('spend carries every table the panel draws, in the order it draws them', () => {
  const csv = spendCsv(insights());
  // Led with a break so the first section, which opens the file, matches the same
  // "on a line of its own" shape as the rest.
  const lead = `\r\n${csv}`;
  // A table added to the panel and not to this list is the failure the export
  // exists to prevent: a complete-looking file that under-reports.
  const names = ['Totals', 'Phases', 'Daily', 'Task types', 'Failing checks', 'Goals', 'Runs'];
  const order = names.map((s) => lead.indexOf(`\r\n${s}\r\n`));
  assert.ok(
    order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1]!)),
    'the sections must all be present and in panel order',
  );
  // The phase split rides inside the goal row, as it does inside the goal's bar.
  const goals = section(csv, 'Goals');
  assert.ok(goals[0]?.endsWith('deliberation,build'), 'a goal row carries a column per phase');
  assert.ok(goals[1]?.includes('"Rework the intake, ""properly"""'));
});

test('the caveats the panel says in prose leave as rows', () => {
  const csv = spendCsv(insights());
  // The remainder: these figures are a partition, and one that does not carry
  // its own remainder reads as complete.
  assert.ok(section(csv, 'Goals').some((r) => r.startsWith(',Reached no goal,0.001')));
  // The cap: a silently truncated table reads as a complete one, on paper more
  // than on screen.
  assert.ok(csv.includes('The 1 costliest of 9 measured runs.'));
  // Unmeasured is not free, and it is not zero either.
  assert.ok(section(csv, 'Totals').includes('Unmeasured runs,5'));
  // The check table's own remainder, for the goal table's reason: per-check
  // figures read as a partition of CI money, and a provider that reported no
  // per-check detail must not vanish out of it.
  assert.ok(section(csv, 'Failing checks').includes('Named no check,0.0005'));
  assert.ok(section(csv, 'Failing checks').some((r) => r.includes('costliest of 0 checks seen')));
});

/** A minimal payload for the twin panel: enough of every table to export one row of it. */
function yieldOf(over: Partial<ReliabilityInsights> = {}): ReliabilityInsights {
  return {
    generatedAt: '2026-08-13T09:00:00.000Z',
    windowDays: 14,
    runs: {
      settled: 8,
      live: 1,
      completed: 6,
      lost: 1,
      stopped: 1,
      // 0.75 on the wire, `75%` on the panel. A rate rounded on the way out is a
      // rate nothing can be recomputed from.
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
          // 12,600,000ms is `3.5h` on the panel. Milliseconds here, for the same
          // reason the rate is a fraction.
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
  const csv = reliabilityCsv(yieldOf());
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
  const csv = reliabilityCsv(yieldOf());
  const lead = `\r\n${csv}`;
  const names = ['Tallies', 'Outcomes', 'CI verdicts by day', 'Phases', 'Reddest pull requests', 'Ran more than once'];
  const order = names.map((s) => lead.indexOf(`\r\n${s}\r\n`));
  assert.ok(
    order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1]!)),
    'the sections must all be present and in panel order',
  );
  assert.ok(section(csv, 'Reddest pull requests').some((r) => r.startsWith('pr:143,143,5,2,7200000,1.5,yes')));
});

test('the method note leaves as rows — the two windows, what a red is, what stopped is not', () => {
  const csv = reliabilityCsv(yieldOf());
  const tallies = section(csv, 'Tallies');
  // The window split reads as a mistake until it is stated, and there is no note
  // beside a spreadsheet to state it.
  assert.ok(tallies.includes('Outcomes measured over,all time'));
  assert.ok(tallies.includes('CI measured over (days),14'));
  assert.ok(tallies.some((r) => r.startsWith('A red is,')), 'a reader summing reds must know they are verdicts'); // prettier-ignore
  // One CI agent answers several reds at once, so the per-red figure divides one
  // repair across every verdict it cleared.
  assert.ok(tallies.some((r) => r.startsWith('Cost per red is,')));
  assert.ok(tallies.some((r) => r.startsWith('Counts against the completion rate,')));
  // Both rankings are capped, and both say so.
  assert.ok(csv.includes('The 1 reddest of 3 pull requests that went red.'));
  assert.ok(csv.includes('The 1 most-repeated of 4 origins that ran more than once.'));
});

test('neither panel exports what it could not fetch — there is no file of zeroes', () => {
  // Pinned on the sources rather than by rendering: both controls sit behind
  // `insights !== null`, which is each panel's own "a failed fetch must not read
  // as a clean fleet" rule applied to the artefact that outlives the tab.
  for (const panel of ['SpendModal', 'ReliabilityModal']) {
    const src = readFileSync(fileURLToPath(new URL(`../web/src/components/${panel}.tsx`, import.meta.url)), 'utf8');
    const at = src.indexOf('<Downloads');
    assert.notEqual(at, -1, `${panel} must offer an export`);
    assert.ok(src.lastIndexOf('insights !== null', at) !== -1, `${panel}'s export must be gated on a payload`);
    // The PDF is the panel printed, so it needs the node the panel drew.
    assert.ok(src.includes('sheet={{'), `${panel} must hand the print sheet its own node`);
  }
});
