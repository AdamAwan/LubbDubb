import type { RemoteRowOutcome } from '../types.js';

// → docs/spec/36-remote-validation.md#the-report-is-the-only-source-of-row-outcomes

/**
 * One test the runner's machine-readable report carries. **Rows, never counts** — the state
 * contract's own refusal, one subsystem over and for the same reason: a report that declares totals
 * defeats every guard this design has, because matched-versus-executed is the guard and a declared
 * count is the thing being checked.
 */
interface ReportTest {
  /** The area this test belongs to. It is compared against `validation_checks.area` and nothing else. */
  selector: string;
  status: 'passed' | 'failed' | 'skipped';
  retries: number;
  durationMs: number | null;
  /** What the runner said about a test that did not run — a failed dependency, most of all. */
  note: string | null;
}

/** What a report came back as. **Null tests means it could not be read** — never an empty report. */
export interface RunReport {
  tests: ReportTest[] | null;
  detail: string | null;
}

/**
 * What one row's tests came to. `matched` is **not** in here: it comes off `remote_sheet_rows.matched`,
 * written by the pre-flight's own listing, and derived from a report instead a selector that matched
 * nothing reads as a clean pass.
 */
export interface RowOutcome {
  outcome: RemoteRowOutcome;
  detail: string | null;
  executed: number;
  retries: number;
  durationMs: number | null;
}

/**
 * A status vocabulary wide enough for the runners projects actually have, folded onto the three the
 * harness reasons about. **Anything it does not recognise is `skipped`** rather than `passed`: an
 * unread word must never be the one that colours a row green.
 */
function statusOf(raw: string): ReportTest['status'] {
  const word = raw.trim().toLowerCase();
  if (word === 'passed' || word === 'pass' || word === 'ok' || word === 'expected') return 'passed';
  if (word === 'failed' || word === 'fail' || word === 'unexpected' || word === 'timedout' || word === 'error')
    return 'failed';
  return 'skipped';
}

function numberOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

function stringOf(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/**
 * The harness's own report contract, which the project's runner emits through its own reporter —
 * `validate.state.run`'s arrangement exactly, and for the governing principle's reason: the harness
 * declares the shape and the project owns every command that produces it.
 *
 * A JSON array of tests, or an object carrying one under `tests`. Each test names its `selector`
 * and its `status`, and may carry `retries`, `durationMs` and a `note`.
 */
export function parseRunReport(text: string): RunReport {
  const body = text.trim();
  if (body === '')
    return { tests: null, detail: 'the report file is empty, so nothing in it says what any row came back as' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { tests: null, detail: `the report did not parse as JSON — ${(err as Error).message}` };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>)['tests'])
      ? ((parsed as Record<string, unknown>)['tests'] as unknown[])
      : null;
  if (list === null)
    return {
      tests: null,
      detail:
        'the report is neither a list of tests nor an object carrying one under "tests". It states counts ' +
        'or something else, and a report of counts defeats the matched-versus-executed guard this design ' +
        'leans on',
    };
  const tests: ReportTest[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const selector = stringOf(record['selector']);
    const status = stringOf(record['status']);
    if (selector === null || status === null) continue;
    tests.push({
      selector,
      status: statusOf(status),
      retries: numberOf(record['retries']) ?? 0,
      durationMs: numberOf(record['durationMs']),
      note: stringOf(record['note']),
    });
  }
  return { tests, detail: null };
}

interface FoldInput {
  environment: string;
  /** The check's own area, which is the selector this row is verified against. */
  area: string;
  /** `remote_sheet_rows.matched`, from the pre-flight's listing. Null where it never counted. */
  matched: number | null;
  report: RunReport;
}

/**
 * One row's outcome, out of the report and out of nothing else. **The exit code is never read**: one
 * invocation carries many rows and one code, so anything inferred from it is guaranteed to be wrong
 * for some row.
 *
 * The order the four arms are tried in is load-bearing:
 *
 * - a report nobody could read learns nothing, so every row through it is `blocked`;
 * - a selector the report names **no test** under is `blocked` and never `passed` — with generated
 *   specs gone this is the ordinary failure rather than an exotic one. What it says happened depends
 *   on what else the report holds: a runner that reports the tests a failed dependency held as
 *   `skipped` reaches the narrowing arm with its own words, and a runner that omits them entirely
 *   arrives here instead, where a failure under another selector is the only evidence of that
 *   available — so it is named rather than left as a renamed area;
 * - a test that genuinely **failed** is a failure, and it is a failure whatever else the row did.
 *   A narrowed run is a run that verified less than it claimed; it is not a reason to withhold a
 *   red the deployed product actually earned;
 * - and only then the narrowing case: fewer tests ran than the pre-flight matched — a focus marker,
 *   a filter, or the tests a failed auth-setup project was holding up. That is `blocked`, **never
 *   `failed`**, and only the report distinguishes it.
 */
export function foldRowOutcome(input: FoldInput): RowOutcome {
  const { environment, area, matched, report } = input;
  if (report.tests === null)
    return {
      outcome: 'blocked',
      detail:
        `the runner's report could not be read — ${report.detail ?? 'it said nothing this harness understands'}. ` +
        'Nothing was learned about this row, because a reading nobody can read is not a reading.',
      executed: 0,
      retries: 0,
      durationMs: null,
    };

  const mine = report.tests.filter((test) => test.selector === area);
  const executed = mine.filter((test) => test.status !== 'skipped').length;
  const retries = mine.reduce((sum, test) => sum + test.retries, 0);
  const durationMs = mine.some((test) => test.durationMs !== null)
    ? mine.reduce((sum, test) => sum + (test.durationMs ?? 0), 0)
    : null;
  const measured = { executed, retries, durationMs };

  if (mine.length === 0) return { outcome: 'blocked', detail: unnamed(area, report.tests), ...measured };

  const failed = mine.filter((test) => test.status === 'failed');
  if (failed.length > 0)
    return {
      outcome: 'failed',
      detail:
        `${environment} ran ${count(executed, 'test')} under \`${area}\` and ${String(failed.length)} of them ` +
        `did not pass${retried(retries)}.`,
      ...measured,
    };

  if (matched !== null && executed < matched)
    return {
      outcome: 'blocked',
      detail:
        `the pre-flight matched ${count(matched, 'test')} under \`${area}\` and only ${String(executed)} ran` +
        `${skips(mine)}. A run that verified less than it matched is not a pass — nothing was learned about ` +
        'the tests that never ran, and a dependency that failed is the ordinary reason for it.',
      ...measured,
    };

  if (matched === null || matched === 0)
    return {
      outcome: 'blocked',
      detail:
        `the pre-flight attributed no tests to \`${area}\`, so there is nothing here to read the report ` +
        'against. A row whose selector matched nothing is never a pass.',
      ...measured,
    };

  return {
    outcome: 'passed',
    detail: `${environment} ran ${count(executed, 'test')} under \`${area}\` and every one passed${retried(retries)}.`,
    ...measured,
  };
}

/**
 * A selector the report holds nothing under. The reason matters more than the outcome here, because
 * the reason is what an operator acts on, and two very different things arrive at this arm.
 *
 * A **renamed area, a deleted spec or a wrong profile** is one. The other is a dependency that
 * failed before this area was ever reached: the contract asks a project to report the tests it never
 * ran as `skipped` rows naming the dependency — which lands in the narrowing arm with the right
 * words — but a runner mapping its own report one-to-one commonly **omits** them, and then this arm
 * is where a failed auth setup arrives. The harness cannot know a suite's dependency graph, so it
 * names what it can see: a failure under some other selector, which is the shape that reading has.
 */
function unnamed(area: string, tests: readonly ReportTest[]): string {
  const elsewhere = [...new Set(tests.filter((t) => t.status === 'failed').map((t) => t.selector))];
  const dependency =
    elsewhere.length === 0
      ? ''
      : ` Nothing under it failed either, but ${elsewhere.map((s) => `\`${s}\``).join(', ')} did — where the ` +
        'runner omits the tests a failed dependency was holding up rather than reporting them skipped, that ' +
        'is what this looks like.';
  return (
    `the report names no test under \`${area}\` — a renamed area, a deleted spec or a wrong profile.` +
    `${dependency} A selector that matched zero tests is never a pass.`
  );
}

/** A retried pass **is a pass**, and the row records that it was retried. Retry policy is the project's. */
function retried(retries: number): string {
  return retries === 0 ? '' : `, after ${count(retries, 'retry', 'retries')}`;
}

function skips(mine: readonly ReportTest[]): string {
  const notes = [...new Set(mine.filter((t) => t.status === 'skipped' && t.note !== null).map((t) => t.note))];
  return notes.length === 0 ? '' : ` — ${notes.join('; ')}`;
}

function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${String(n)} ${n === 1 ? noun : plural}`;
}
