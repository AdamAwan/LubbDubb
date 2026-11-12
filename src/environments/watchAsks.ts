import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { GoalWatch, HumanTask, WatchAsk, WatchAskKind, WatchWindow } from '../types.js';
import type { WatchAskView } from '../wire.js';
import { groupBy } from '../primitives.js';
import { settledWatchPeriod } from './exposure.js';
import { goalMergedAt } from './landings.js';
import type { EnvironmentConfig } from './policy.js';
import { dryRunOf } from './watchDryRun.js';
import { watchCheckBlock, watchCheckQuery } from './watchFinding.js';
import { watchExpectation } from './watchOutcome.js';
import { parseOperatorAnswer, type WatchPeriod, type WatchResult } from './watchResult.js';
import { resolveWatchSource, watchSources, type WatchSource } from './watchSource.js';
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

/** An ask still worth answering: its check is live and still reads a source only a person can run there. */
interface ResolvedAsk {
  check: GoalWatch;
  environment: EnvironmentConfig;
  source: WatchSource;
}

interface AskFiling extends ResolvedAsk {
  ask: WatchAskKind;
  period: WatchPeriod;
}

type WatchAskStep =
  | { kind: 'file'; taskId: string | null; filing: AskFiling }
  | { kind: 'reopen'; taskId: string; filing: AskFiling }
  | { kind: 'settle'; taskId: string; why: string; nobodyRan: { ask: WatchAsk; detail: string } | null };

/**
 * The readings only a person can take: the asks for them, and what an answer records. The one object the
 * cockpit's paste box, the desktop `watch_reading` tool and the window pass all go through, so an answer
 * recorded from Claude is the answer recorded from the cockpit.
 */
export class WatchAsks {
  private readonly now: () => number;
  /** The environments with a source only a person can run; with none, every method here is a no-op. */
  private readonly operated: readonly EnvironmentConfig[];

  constructor(private readonly deps: WatchAsksDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.operated = deps.environments.filter((e) => watchSources(e.watch).some((s) => s.runBy === 'operator'));
  }

  /**
   * The baseline ask, once per live check per environment that reads its source only through a person —
   * at the accept, at an operator's own edit, and at a plan document's dry run. The period is the window
   * before the merge, or the window ending now where nothing has merged yet.
   */
  askBaselines(goalRef: string): void {
    if (this.operated.length === 0) return;
    const { store } = this.deps;
    const mine = store.watches.listWatchAsks(goalRef);
    const asked = new Set(mine.filter((a) => a.ask === 'baseline').map((a) => `${a.checkId} ${a.environment}`));
    const standing = new Set(mine.map((a) => a.taskId));
    const existing = tasksByTitle(store.humanTasks.listHumanTasksOfKind(KIND));
    const merged = goalMergedAt(store.environments.listGoalLandings(), goalRef);
    const steps: WatchAskStep[] = [];
    for (const check of store.watches.listLiveGoalWatches(goalRef))
      for (const environment of this.operated) {
        const source = operatorSource(environment, check);
        if (source === null || asked.has(`${check.id} ${environment.name}`)) continue;
        const period = beforeMergePeriod(environment, merged, this.now());
        const step = fileStep({ check, environment, source, ask: 'baseline', period }, existing, standing);
        if (step !== null) steps.push(step);
      }
    this.apply(steps);
  }

  /**
   * The window pass's part, run below settling: the closing ask for each window that has closed within
   * grace, a baseline its window outran retracted, a closing ask past grace settled `unknown`, and any ask
   * whose check was changed or dropped retracted. Takes the windows and checks the desk already read.
   */
  pass(read?: { windows: readonly WatchWindow[]; checks: readonly GoalWatch[] }): void {
    if (this.operated.length === 0) return;
    const { store, errors } = this.deps;
    try {
      const windows = read?.windows ?? store.watches.listWatchWindows();
      const checks = read?.checks ?? store.watches.listGoalWatches();
      const tasks = store.humanTasks.listHumanTasksOfKind(KIND);
      const asks = store.watches.listWatchAsks();
      const closings = this.askClosings(windows, checks, tasks, asks);
      const planned = new Set(closings.flatMap((s) => (s.taskId === null ? [] : [s.taskId])));
      this.apply([...closings, ...this.settleAsks(windows, checks, tasks, asks, planned)]);
    } catch (err) {
      errors?.record({ source: 'cycle', message: `asking for operator readings failed: ${(err as Error).message}` });
    }
  }

  /** Every ask still open, with its query ready to run. */
  open(read?: { asks: readonly WatchAsk[]; checks: readonly GoalWatch[] }): WatchAskView[] {
    if (this.operated.length === 0) return [];
    const { store } = this.deps;
    const open = read?.asks ?? openWatchAsks(store);
    if (open.length === 0) return [];
    const checks = checksByKey(read?.checks ?? store.watches.listGoalWatches());
    return open.flatMap((ask) => {
      const resolved = this.resolve(ask, checks);
      return resolved === null ? [] : [askView(ask, resolved)];
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

  /**
   * The one rule for whether an ask is still worth answering: its check is still live, its environment
   * still declared, and the check still reads a source only a person can run there.
   */
  private resolve(ask: WatchAsk, checks: ReadonlyMap<string, GoalWatch>): ResolvedAsk | null {
    const check = checks.get(`${ask.goalRef} ${ask.checkId}`);
    const environment = this.operated.find((e) => e.name === ask.environment);
    if (check === undefined || environment === undefined) return null;
    const source = operatorSource(environment, check);
    return source === null ? null : { check, environment, source };
  }

  private answerable(taskId: string): ({ ok: true; ask: WatchAsk } & ResolvedAsk) | WatchAskRefused {
    const { store } = this.deps;
    const task = store.humanTasks.getHumanTask(taskId);
    if (task?.kind !== KIND) return { ok: false, status: 404, error: 'no reading is asked for under that id' };
    if (task.status !== 'open')
      return { ok: false, status: 409, error: 'that ask has already been answered or settled' };
    const ask = store.watches.getWatchAsk(taskId);
    const resolved =
      ask === null ? null : this.resolve(ask, checksByKey(store.watches.listLiveGoalWatches(ask.goalRef)));
    if (ask === null || resolved === null)
      return {
        ok: false,
        status: 409,
        error: 'the check this asked about has changed or gone, so nothing is recorded',
      };
    return { ok: true, ask, ...resolved };
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

  private askClosings(
    windows: readonly WatchWindow[],
    checks: readonly GoalWatch[],
    tasks: readonly HumanTask[],
    asks: readonly WatchAsk[],
  ): WatchAskStep[] {
    const now = this.now();
    const byGoal = groupBy(checks, (c) => c.originRef);
    const asked = new Map(asks.map((a) => [askKey(a), a]));
    const status = new Map(tasks.map((t) => [t.id, t.status]));
    const standing = new Set(asks.map((a) => a.taskId));
    const existing = tasksByTitle(tasks);
    const steps: WatchAskStep[] = [];
    for (const window of windows) {
      if (window.settledAt === null) continue;
      const environment = this.operated.find((e) => e.name === window.environment);
      if (environment === undefined) continue;
      const period = settledWatchPeriod(window);
      if (Date.parse(period.until) + operatorGraceMs(environment) <= now) continue;
      for (const check of byGoal.get(window.goalRef) ?? []) {
        const source = operatorSource(environment, check);
        if (source === null) continue;
        const key = { goalRef: window.goalRef, checkId: check.id, environment: environment.name };
        const baseline = asked.get(askKey({ ...key, ask: 'baseline' }));
        if (baseline !== undefined && status.get(baseline.taskId) === 'open')
          steps.push(retraction(baseline.taskId, `${environment.name}'s window closed before the baseline was taken`));
        const closing = asked.get(askKey({ ...key, ask: 'closing' }));
        if (closing?.until === period.until) continue;
        const step = fileStep({ check, environment, source, ask: 'closing', period }, existing, standing);
        if (step !== null) steps.push(step);
      }
    }
    return steps;
  }

  private settleAsks(
    windows: readonly WatchWindow[],
    checks: readonly GoalWatch[],
    tasks: readonly HumanTask[],
    asks: readonly WatchAsk[],
    planned: ReadonlySet<string>,
  ): WatchAskStep[] {
    const open = tasks.filter((t) => t.status === 'open' && !planned.has(t.id));
    if (open.length === 0) return [];
    const now = this.now();
    const byTask = new Map(asks.map((a) => [a.taskId, a]));
    const byCheck = checksByKey(checks);
    const byWindow = new Map(windows.map((w) => [`${w.goalRef} ${w.environment}`, w]));
    const steps: WatchAskStep[] = [];
    for (const task of open) {
      const ask = byTask.get(task.id);
      const resolved = ask === undefined ? null : this.resolve(ask, byCheck);
      if (ask === undefined || resolved === null) {
        steps.push(retraction(task.id, 'the check it asked about was changed or dropped'));
        continue;
      }
      if (ask.ask !== 'closing') continue;
      const window = byWindow.get(`${ask.goalRef} ${ask.environment}`);
      if (window?.settledAt === null) {
        steps.push(retraction(task.id, `${ask.environment}'s window was extended, and asks again when it closes`));
        continue;
      }
      const { environment } = resolved;
      if (Date.parse(ask.until) + operatorGraceMs(environment) > now) continue;
      steps.push({
        kind: 'settle',
        taskId: task.id,
        why: `nobody ran it within ${graceWords(environment)}, so it reads unknown`,
        nobodyRan: {
          ask,
          detail: `nobody ran it — ${ask.environment} reads this check only through a person, and the ask went unanswered for ${graceWords(environment)} after its window closed`,
        },
      });
    }
    return steps;
  }

  private apply(steps: readonly WatchAskStep[]): void {
    const { store } = this.deps;
    for (const step of steps) {
      if (step.kind === 'settle') {
        if (step.nobodyRan !== null)
          store.watches.recordWatchReading({
            goalRef: step.nobodyRan.ask.goalRef,
            environment: step.nobodyRan.ask.environment,
            checkId: step.nobodyRan.ask.checkId,
            verdict: 'unknown',
            rows: null,
            value: null,
            detail: step.nobodyRan.detail,
          });
        store.humanTasks.settleHumanTask(step.taskId, 'declined', DESK_SETTLED + step.why);
        continue;
      }
      const { check, environment, ask, period } = step.filing;
      const detail = askDetail(step.filing);
      const taskId =
        step.kind === 'reopen'
          ? (store.humanTasks.reopenHumanTask(step.taskId, detail), step.taskId)
          : store.humanTasks.recordHumanTask({
              title: askTitle(check, environment.name, ask),
              detail,
              originRef: check.originRef,
              kind: KIND,
              agentId: null,
              taskId: null,
            }).task.id;
      store.watches.recordWatchAsk({
        taskId,
        goalRef: check.originRef,
        checkId: check.id,
        environment: environment.name,
        ask,
        ...period,
      });
    }
  }
}

/**
 * Filing an ask: a new row, the open row refreshed, or a settled row re-opened — where the harness settled
 * it, or where an edit to the check cleared the ask it answered (`asked` no longer holds its task), so the
 * question it answered no longer exists. A row a person answered or declined, on a question that still
 * stands, is theirs and is never re-opened: the step is null.
 */
function fileStep(
  filing: AskFiling,
  existing: ReadonlyMap<string, HumanTask>,
  asked: ReadonlySet<string>,
): WatchAskStep | null {
  const task = existing.get(`${filing.check.originRef} ${askTitle(filing.check, filing.environment.name, filing.ask)}`);
  if (task === undefined || task.status === 'open') return { kind: 'file', taskId: task?.id ?? null, filing };
  return deskSettled(task) || !asked.has(task.id) ? { kind: 'reopen', taskId: task.id, filing } : null;
}

function retraction(taskId: string, why: string): WatchAskStep {
  return { kind: 'settle', taskId, why, nobodyRan: null };
}

function tasksByTitle(tasks: readonly HumanTask[]): Map<string, HumanTask> {
  return new Map(tasks.map((t) => [`${t.originRef ?? ''} ${t.title}`, t]));
}

function checksByKey(checks: readonly GoalWatch[]): Map<string, GoalWatch> {
  return new Map(checks.map((c) => [`${c.originRef} ${c.id}`, c]));
}

function askKey(ask: Pick<WatchAsk, 'goalRef' | 'checkId' | 'environment' | 'ask'>): string {
  return `${ask.goalRef} ${ask.checkId} ${ask.environment} ${ask.ask}`;
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
 * where it has them, one goal's where it names one, and without reading `watch_asks` at all while nothing is
 * open.
 */
export function openWatchAsks(
  store: Store,
  scope: { tasks?: readonly HumanTask[]; goalRef?: string } = {},
): WatchAsk[] {
  const open = (scope.tasks ?? store.humanTasks.listHumanTasksOfKind(KIND)).filter(
    (t) => t.kind === KIND && t.status === 'open' && (scope.goalRef === undefined || t.originRef === scope.goalRef),
  );
  if (open.length === 0) return [];
  const asks = new Map(store.watches.listWatchAsks(scope.goalRef).map((a) => [a.taskId, a]));
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

function askView(ask: WatchAsk, { check, environment, source }: ResolvedAsk): WatchAskView {
  const query = watchCheckQuery(check, environment, ask);
  return {
    ...ask,
    checkTitle: check.title,
    kind: check.kind,
    source: source.name,
    language: query.language,
    query: query.query,
    presence: query.presence,
    queryUrl: query.queryUrl,
    closesAt:
      ask.ask === 'closing' ? new Date(Date.parse(ask.until) + operatorGraceMs(environment)).toISOString() : null,
  };
}

function askDetail({ check, environment, source, ask, period }: AskFiling): string {
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
      presenceLead:
        '**And its presence query**, which proves the code path ran at all — a signal cannot read clean while it is silent:',
      environment: env,
      query: watchCheckQuery(check, environment, period),
    }),
    `${answer} Or have your own Claude Code run it: the \`watch_reading\` tool lists this ask and records the answer.`,
  ].join('\n');
}

function graceWords(environment: EnvironmentConfig): string {
  const hours = Math.round(operatorGraceMs(environment) / HOUR_MS);
  return hours >= 1 ? `${String(hours)}h` : `${String(Math.round(operatorGraceMs(environment) / 60_000))}m`;
}
