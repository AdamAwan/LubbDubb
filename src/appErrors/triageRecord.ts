import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';
import type { Store } from '../store/store.js';
import type {
  AppErrorTriageConfidence,
  AppErrorTriageRun,
  AppErrorTriageSubject,
  AppErrorTriageVerdict,
  Task,
} from '../types.js';
import type { ErrorRecorder } from '../errorLog.js';
import { detailRequest, type AppErrorDetailOutput, type AppErrorDetailRunner } from './detailCommand.js';
import { appErrorTriageRunId } from './triageOrigin.js';

// → docs/spec/39-app-errors.md#agent-triage

export const MAX_TRIAGE_REASON = 600;

export interface AppErrorTriageInput {
  key: string;
  verdict: AppErrorTriageVerdict;
  goalRef: string | null;
  confidence: AppErrorTriageConfidence;
  reason: string;
}

export type AppErrorTriageRecorded = { ok: true; remaining: string[] } | { ok: false; error: string };

export type AppErrorDetailRead =
  | {
      ok: true;
      key: string;
      message: string | null;
      stack: string | null;
      /** What the environment's `errors.detail` printed, or why it did not; null where none is declared. */
      query: AppErrorDetailOutput | null;
    }
  | { ok: false; error: string };

/** The environment's declared `errors.detail`, and what runs it. */
export interface AppErrorDetailQuery {
  command: (environment: string) => string | null;
  runner: AppErrorDetailRunner;
}

interface DetailReadDeps {
  store: Store;
  query?: AppErrorDetailQuery;
  errors?: ErrorRecorder;
  now?: () => number;
}

type Fenced = { ok: true; run: AppErrorTriageRun; subject: AppErrorTriageSubject } | { ok: false; error: string };

/** The run is resolved from the dispatch origin, so an agent can only speak to the groups it was handed. */
function fence(store: Store, tool: string, originRef: string | null, key: string): Fenced {
  const runId = appErrorTriageRunId(originRef);
  const run = runId === null ? null : store.appErrorTriage.getRun(runId);
  if (run === null)
    return {
      ok: false,
      error: `${tool} is only for the agent dispatched to triage app errors, and this task's origin is ${originRef ?? '(none)'}.`,
    };
  const subject = run.subjects.find((s) => s.key === key.trim());
  if (subject === undefined)
    return {
      ok: false,
      error: `${key} is not in this run. The run holds ${run.subjects.map((s) => s.key).join(', ')}.`,
    };
  return { ok: true, run, subject };
}

/** A goal named as `issue:412`, `#412` or `412`, as the candidate it is; null when it is none of them. */
function candidateNamed(subject: AppErrorTriageSubject, named: string): string | null {
  const text = named.trim();
  if (subject.candidates.includes(text)) return text;
  const bare = /^#?(\d+)$/.exec(text);
  const ref = bare === null ? null : issueOriginRef('root', Number(bare[1]));
  return ref !== null && subject.candidates.includes(ref) ? ref : null;
}

export function recordAppErrorTriage(
  store: Store,
  originRef: string | null,
  input: AppErrorTriageInput,
): AppErrorTriageRecorded {
  const fenced = fence(store, 'app_error_triage', originRef, input.key);
  if (!fenced.ok) return fenced;
  const { run, subject } = fenced;
  const named = input.goalRef?.trim() || null;
  const causedBy = input.verdict === 'caused-by';
  if (causedBy && named === null)
    return { ok: false, error: 'caused-by needs a goalRef: the candidate goal you think caused it.' };
  if (!causedBy && named !== null)
    return {
      ok: false,
      error: `goalRef goes only with caused-by. For ${input.verdict}, leave it out and say in reason what you found.`,
    };
  const goalRef = named === null ? null : candidateNamed(subject, named);
  if (named !== null && goalRef === null)
    return {
      ok: false,
      error:
        subject.candidates.length === 0
          ? `${subject.key} has no candidate goals, so it cannot be caused-by one. Say pre-existing or unclear.`
          : `${named} is not one of ${subject.key}'s candidates (${subject.candidates
              .map((c) => `#${String(issueOriginNumber('root', c) ?? c)}`)
              .join(', ')}). Name one of them, or say pre-existing or unclear.`,
    };
  const reason = input.reason.trim();
  if (reason === '') return { ok: false, error: 'reason is empty: say what you found, in a sentence or two.' };
  if (reason.length > MAX_TRIAGE_REASON)
    return {
      ok: false,
      error: `reason is ${String(reason.length)} characters; keep it to ${String(MAX_TRIAGE_REASON)} — two or three sentences.`,
    };
  store.appErrorTriage.recordVerdict({
    environment: subject.environment,
    fingerprint: subject.fingerprint,
    state: subject.state,
    anchor: subject.anchor,
    key: subject.key,
    verdict: input.verdict,
    goalRef,
    confidence: input.confidence,
    reason,
    runId: run.id,
  });
  const done = store.appErrorTriage.answeredIn(run.id);
  return { ok: true, remaining: run.subjects.map((s) => s.key).filter((k) => !done.has(k)) };
}

/**
 * The stored sample message and stack and, where the environment declares `errors.detail`, what that
 * query prints for the group — the fingerprint passed in the env, never in the command's text. Every
 * read is recorded, with whether the query ran and answered, and drawn on the Errors tab.
 */
export async function readAppErrorDetail(deps: DetailReadDeps, task: Task, key: string): Promise<AppErrorDetailRead> {
  const { store } = deps;
  const fenced = fence(store, 'app_error_detail', task.originRef, key);
  if (!fenced.ok) return fenced;
  const { run, subject } = fenced;
  const detail = store.appErrors.getDetail(subject.environment, subject.fingerprint);
  const query = await runDetailQuery(deps, subject);
  store.appErrorTriage.recordDetailRead({
    ...subject,
    runId: run.id,
    taskId: task.id,
    queryStatus: query === null ? null : query.ok ? 'ok' : 'failed',
  });
  return { ok: true, key: subject.key, message: detail?.message ?? null, stack: detail?.stack ?? null, query };
}

async function runDetailQuery(
  deps: DetailReadDeps,
  subject: AppErrorTriageSubject,
): Promise<AppErrorDetailOutput | null> {
  const command = deps.query?.command(subject.environment) ?? null;
  if (deps.query === undefined || command === null) return null;
  const request = detailRequest({
    environment: subject.environment,
    detail: command,
    fingerprint: subject.fingerprint,
    firstSeen: deps.store.appErrors.firstSeen(subject.environment, subject.fingerprint),
    now: (deps.now ?? Date.now)(),
  });
  let output: AppErrorDetailOutput;
  try {
    output = await deps.query.runner.detail(request);
  } catch (err) {
    output = { ok: false, failure: `the detail query could not be run: ${(err as Error).message}` };
  }
  if (!output.ok)
    deps.errors?.record({
      source: 'agent',
      message: `the errors.detail query for ${subject.environment} failed for ${subject.key}`,
      detail: output.failure,
    });
  return output;
}
