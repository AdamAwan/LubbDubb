import { DESK_SETTLED } from '../benchSettlement.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { GoalWatch, HumanTask, WatchAsk, WatchAskKind, WatchWindow } from '../types.js';
import type { WatchAskView } from '../wire.js';
import { withPeriod } from '../validation/watchQueryShape.js';
import { settledWatchPeriod } from './exposure.js';
import { goalMergedAt } from './landings.js';
import type { EnvironmentConfig } from './policy.js';
import { dryRunOf } from './watchDryRun.js';
import { watchCheckBlock, watchCheckQuery } from './watchFinding.js';
import { watchExpectation } from './watchOutcome.js';
import { parseOperatorAnswer, type WatchPeriod, type WatchResult } from './watchResult.js';
import { resolveWatchSource, type WatchSource } from './watchSource.js';
import { watchCheckVerdict } from './watchVerdict.js';
import { beforeMergePeriod, operatorGraceMs } from './watchWindow.js';

// → docs/spec/29-post-deploy-watch.md#a-source-only-the-operator-can-run

const KIND = 'watch_reading';

const HOUR_MS = 60 * 60 * 1000;

interface WatchAsksDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  errors?: ErrorRecorder;
  now?: () => number;
}

/** A person's answer to one ask: the rows, or a measure's one number, and a signal's presence rows. */
export interface WatchAskAnswer {
  answer: string;
  presence: string | null;
}

interface WatchAskRefused {
  ok: false;
  status: 400 | 404 | 409;
  error: string;
}

type WatchAskAnswered = { ok: true; ask: WatchAsk; recorded: string } | WatchAskRefused;

/**
 * The readings only a person can take: the asks for them, and what an answer records. The one object the
 * cockpit's paste box, the desktop `watch_reading` tool and the window pass all go through, so an answer
 * recorded from Claude is the answer recorded from the cockpit.
 */
export class WatchAsks {
  private readonly now: () => number;

  constructor(private readonly deps: WatchAsksDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * The baseline ask, once per live check per environment that reads its source only through a person —
   * at the accept, at an operator's own edit, and at a plan document's dry run. The period is the window
   * before the merge, or the window ending now where nothing has merged yet.
   */
  askBaselines(goalRef: string): void {
    const { store } = this.deps;
    if (!this.watching()) return;
    const merged = goalMergedAt(store.environments.listGoalLandings(), goalRef);
    for (const check of store.watches.listLiveGoalWatches(goalRef))
      for (const { environment, source } of this.operatorEnvironments(check)) {
        if (store.watches.findWatchAsk({ goalRef, checkId: check.id, environment: environment.name, ask: 'baseline' }))
          continue;
        const period = beforeMergePeriod(environment, merged, this.now());
        this.file(check, environment, source, 'baseline', period);
      }
  }

  /**
   * The window pass's part, run below settling: the closing ask for each window that has closed within
   * grace, a baseline its window outran retracted, a closing ask past grace settled `unknown`, and any ask
   * whose check was changed or dropped retracted.
   */
  pass(): void {
    const { store, errors } = this.deps;
    if (!this.watching()) return;
    try {
      const windows = store.watches.listWatchWindows();
      const checks = store.watches.listGoalWatches();
      this.askClosings(windows, checks);
      this.settleAsks(windows, checks);
    } catch (err) {
      errors?.record({ source: 'cycle', message: `asking for operator readings failed: ${(err as Error).message}` });
    }
  }

  /** Every ask still open, with its query ready to run. */
  open(read?: { asks: readonly WatchAsk[]; checks: readonly GoalWatch[] }): WatchAskView[] {
    const { store } = this.deps;
    if (!this.watching()) return [];
    const open = read?.asks ?? openWatchAsks(store);
    if (open.length === 0) return [];
    const checks = new Map((read?.checks ?? store.watches.listGoalWatches()).map((c) => [`${c.originRef} ${c.id}`, c]));
    return open.flatMap((ask) => {
      const check = checks.get(`${ask.goalRef} ${ask.checkId}`);
      const environment = this.deps.environments.find((e) => e.name === ask.environment);
      const source = environment === undefined || check === undefined ? null : operatorSource(environment, check);
      if (check === undefined || environment === undefined || source === null) return [];
      return [askView(ask, check, environment, source)];
    });
  }

  /**
   * Record a person's answer to one ask. A closing answer is the window's reading of the check, `read_by:
   * 'operator'`; a baseline answer is the check's dry run, and a measure's baseline. Refused, recording
   * nothing, where the answer does not keep the output contract — a person can paste it again.
   */
  answer(taskId: string, given: WatchAskAnswer): WatchAskAnswered {
    const asked = this.answerable(taskId);
    if (!asked.ok) return asked;
    const { ask, check, environment } = asked;
    const parsed = parseAnswer(check, given);
    if (!parsed.ok) return parsed;
    const { presence, reading } = parsed;
    const recorded =
      ask.ask === 'closing'
        ? this.recordClosing(ask, check, presence, reading)
        : this.recordBaseline(ask, check, environment, presence, reading);
    this.deps.store.humanTasks.settleHumanTask(taskId, 'done', `Answered by the operator — ${recorded}`);
    return { ok: true, ask, recorded };
  }

  private answerable(
    taskId: string,
  ): { ok: true; ask: WatchAsk; check: GoalWatch; environment: EnvironmentConfig } | WatchAskRefused {
    const { store } = this.deps;
    const task = store.humanTasks.getHumanTask(taskId);
    if (task?.kind !== KIND) return { ok: false, status: 404, error: 'no reading is asked for under that id' };
    if (task.status !== 'open')
      return { ok: false, status: 409, error: 'that ask has already been answered or settled' };
    const ask = store.watches.getWatchAsk(taskId);
    const check =
      ask === null ? undefined : store.watches.listLiveGoalWatches(ask.goalRef).find((c) => c.id === ask.checkId);
    const environment = ask === null ? undefined : this.deps.environments.find((e) => e.name === ask.environment);
    if (ask === null || check === undefined || environment === undefined || operatorSource(environment, check) === null)
      return {
        ok: false,
        status: 409,
        error: 'the check this asked about has changed or gone, so nothing is recorded',
      };
    return { ok: true, ask, check, environment };
  }

  private recordClosing(ask: WatchAsk, check: GoalWatch, presence: WatchResult | null, reading: WatchResult): string {
    const verdict = watchCheckVerdict({ check, environment: ask.environment, presence, reading });
    this.deps.store.watches.recordWatchReading({
      goalRef: ask.goalRef,
      environment: ask.environment,
      checkId: check.id,
      value: reading.value,
      ...verdict,
      readBy: 'operator',
    });
    return `${ask.environment} read ${verdict.verdict}`;
  }

  private recordBaseline(
    ask: WatchAsk,
    check: GoalWatch,
    environment: EnvironmentConfig,
    presence: WatchResult | null,
    reading: WatchResult,
  ): string {
    const dryRun = dryRunOf(environment, check, presence, reading);
    this.deps.store.watches.recordWatchDryRun(ask.goalRef, check.id, { environment: environment.name, ...dryRun });
    if (check.kind === 'measure' && dryRun.value !== null) return `the baseline is ${String(dryRun.value)}`;
    return dryRun.rows === null
      ? `the baseline read ${dryRun.verdict}`
      : `the baseline read ${String(dryRun.rows)} rows`;
  }

  private askClosings(windows: readonly WatchWindow[], checks: readonly GoalWatch[]): void {
    const { store } = this.deps;
    const now = this.now();
    for (const window of windows) {
      if (window.settledAt === null) continue;
      const environment = this.deps.environments.find((e) => e.name === window.environment);
      if (environment?.watch === undefined) continue;
      const period = settledWatchPeriod(window);
      if (Date.parse(period.until) + operatorGraceMs(environment) <= now) continue;
      for (const check of checks) {
        if (check.originRef !== window.goalRef) continue;
        const source = operatorSource(environment, check);
        if (source === null) continue;
        const key = { goalRef: window.goalRef, checkId: check.id, environment: environment.name };
        const baseline = store.watches.findWatchAsk({ ...key, ask: 'baseline' });
        if (baseline !== null)
          this.retract(baseline.taskId, `${environment.name}'s window closed before the baseline was taken`);
        const closing = store.watches.findWatchAsk({ ...key, ask: 'closing' });
        if (closing !== null && closing.until === period.until) continue;
        this.file(check, environment, source, 'closing', period);
      }
    }
  }

  private settleAsks(windows: readonly WatchWindow[], checks: readonly GoalWatch[]): void {
    const { store } = this.deps;
    const now = this.now();
    for (const task of store.humanTasks.listHumanTasksOfKind(KIND)) {
      if (task.status !== 'open') continue;
      const ask = store.watches.getWatchAsk(task.id);
      const check = ask === null ? undefined : checks.find((c) => c.originRef === ask.goalRef && c.id === ask.checkId);
      const environment = ask === null ? undefined : this.deps.environments.find((e) => e.name === ask.environment);
      if (
        ask === null ||
        check === undefined ||
        environment === undefined ||
        operatorSource(environment, check) === null
      ) {
        this.retract(task.id, 'the check it asked about was changed or dropped');
        continue;
      }
      if (ask.ask !== 'closing') continue;
      const window = windows.find((w) => w.goalRef === ask.goalRef && w.environment === ask.environment);
      if (window?.settledAt === null) {
        this.retract(task.id, `${ask.environment}'s window was extended, and asks again when it closes`);
        continue;
      }
      if (Date.parse(ask.until) + operatorGraceMs(environment) > now) continue;
      store.watches.recordWatchReading({
        goalRef: ask.goalRef,
        environment: ask.environment,
        checkId: ask.checkId,
        verdict: 'unknown',
        rows: null,
        value: null,
        detail: `nobody ran it — ${ask.environment} reads this check only through a person, and the ask went unanswered for ${graceWords(environment)} after its window closed`,
      });
      this.retract(task.id, `nobody ran it within ${graceWords(environment)}, so it reads unknown`);
    }
  }

  private file(
    check: GoalWatch,
    environment: EnvironmentConfig,
    source: WatchSource,
    ask: WatchAskKind,
    period: WatchPeriod,
  ): void {
    const { store } = this.deps;
    const title = askTitle(check, environment.name, ask);
    const detail = askDetail(check, environment, source, ask, period);
    const filed = store.humanTasks.recordHumanTask({
      title,
      detail,
      originRef: check.originRef,
      kind: KIND,
      agentId: null,
      taskId: null,
    });
    if (filed.task.status !== 'open') store.humanTasks.reopenHumanTask(filed.task.id, detail);
    store.watches.recordWatchAsk({
      taskId: filed.task.id,
      goalRef: check.originRef,
      checkId: check.id,
      environment: environment.name,
      ask,
      ...period,
    });
  }

  private retract(taskId: string, why: string): void {
    this.deps.store.humanTasks.settleHumanTask(taskId, 'declined', DESK_SETTLED + why);
  }

  private watching(): boolean {
    return this.deps.environments.some((e) => e.watch !== undefined);
  }

  private operatorEnvironments(check: GoalWatch): { environment: EnvironmentConfig; source: WatchSource }[] {
    return this.deps.environments.flatMap((environment) => {
      const source = operatorSource(environment, check);
      return source === null ? [] : [{ environment, source }];
    });
  }
}

/**
 * A person's answer read through the output contract a harness reading keeps, apart from the id echo. A signal
 * is asked both questions, so it is refused without its presence rows.
 */
function parseAnswer(
  check: GoalWatch,
  given: WatchAskAnswer,
): { ok: true; reading: WatchResult; presence: WatchResult | null } | WatchAskRefused {
  if (check.presence !== null && (given.presence === null || given.presence.trim() === ''))
    return {
      ok: false,
      status: 400,
      error:
        'this signal carries a presence query as well — paste its rows too, since a signal cannot read clean ' +
        'while it is silent',
    };
  const reading = parseOperatorAnswer(given.answer, check.kind === 'measure' ? 'measure' : 'signal');
  if (reading.verdict === 'unknown')
    return { ok: false, status: 400, error: reading.detail ?? 'the answer could not be read' };
  const presence = check.presence === null ? null : parseOperatorAnswer(given.presence ?? '', 'presence');
  if (presence?.verdict === 'unknown')
    return { ok: false, status: 400, error: `the presence answer: ${presence.detail ?? 'it could not be read'}` };
  return { ok: true, reading, presence };
}

/**
 * The `watch_reading` asks still open, each with what it asks — off the bench rows the caller already holds
 * where it has them, and without reading `watch_asks` at all while nothing is open.
 */
export function openWatchAsks(store: Store, tasks?: readonly HumanTask[]): WatchAsk[] {
  const open = (tasks ?? store.humanTasks.listHumanTasksOfKind(KIND)).filter(
    (t) => t.kind === KIND && t.status === 'open',
  );
  if (open.length === 0) return [];
  const asks = new Map(store.watches.listWatchAsks().map((a) => [a.taskId, a]));
  return open.flatMap((t) => {
    const ask = asks.get(t.id);
    return ask === undefined ? [] : [ask];
  });
}

function operatorSource(environment: EnvironmentConfig, check: GoalWatch): WatchSource | null {
  if (environment.watch === undefined) return null;
  return resolveWatchSource(environment, check).operator;
}

function askTitle(check: GoalWatch, environment: string, ask: WatchAskKind): string {
  return ask === 'baseline'
    ? `Run “${check.title}” on ${environment} for its baseline — only a person can`
    : `Run “${check.title}” on ${environment} now its window has closed — only a person can`;
}

function askView(ask: WatchAsk, check: GoalWatch, environment: EnvironmentConfig, source: WatchSource): WatchAskView {
  const query = watchCheckQuery(check, environment, ask);
  return {
    ...ask,
    checkTitle: check.title,
    kind: check.kind,
    source: source.name,
    language: query.language,
    query: query.query,
    presence: check.presence === null ? null : withPeriod(check.presence, ask.since, ask.until),
    queryUrl: query.queryUrl,
    closesAt:
      ask.ask === 'closing' ? new Date(Date.parse(ask.until) + operatorGraceMs(environment)).toISOString() : null,
  };
}

function askDetail(
  check: GoalWatch,
  environment: EnvironmentConfig,
  source: WatchSource,
  ask: WatchAskKind,
  period: WatchPeriod,
): string {
  const env = environment.name;
  const what =
    ask === 'baseline'
      ? `This is the reading from **before the merge** — one window's length up to the moment the work merged — ` +
        'which every reading after it is compared against. Unanswered by the time the window closes, a measure ' +
        'that is judged against its baseline reads unknown.'
      : `This is the reading the window **closed on** — from the moment the work arrived on ${env} to the end of ` +
        `the window. Unanswered for ${graceWords(environment)}, the check reads unknown: nobody ran it.`;
  const answer =
    check.kind === 'measure'
      ? 'Paste the one row it returns as JSON, or just its number.'
      : 'Paste the rows it returns as JSON — every matching row, never a count — and the presence rows beside them.';
  return [
    `**\`${source.name}\` on ${env} is run by a person**, so the harness has put nothing to it: it is asking you. ${what}`,
    '',
    ...watchCheckBlock({
      heading: check.title,
      body: [`**Expected:** ${watchExpectation(check)}`],
      why: check.why,
      lead: `**Run this as it stands** — the period from ${period.since} to ${period.until} is filled in:`,
      environment: env,
      query: watchCheckQuery(check, environment, period),
    }),
    ...(check.presence === null
      ? []
      : [
          '**And its presence query**, which proves the code path ran at all — a signal cannot read clean while it is silent:',
          '',
          '```' + source.language,
          withPeriod(check.presence, period.since, period.until),
          '```',
          '',
        ]),
    `${answer} Or have your own Claude Code run it: the \`watch_reading\` tool lists this ask and records the answer.`,
  ].join('\n');
}

function graceWords(environment: EnvironmentConfig): string {
  const hours = Math.round(operatorGraceMs(environment) / HOUR_MS);
  return hours >= 1 ? `${String(hours)}h` : `${String(Math.round(operatorGraceMs(environment) / 60_000))}m`;
}
