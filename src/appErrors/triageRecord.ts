import { issueOriginNumber } from '../issueOrigins.js';
import type { Store } from '../store/store.js';
import type {
  AppErrorTriageConfidence,
  AppErrorTriageRun,
  AppErrorTriageSubject,
  AppErrorTriageVerdict,
  Task,
} from '../types.js';
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
  { ok: true; key: string; message: string | null; stack: string | null } | { ok: false; error: string };

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
  const ref = bare === null ? null : `issue:${bare[1]!}`;
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
  let goalRef: string | null = null;
  if (input.verdict === 'caused-by') {
    if (input.goalRef === null || input.goalRef.trim() === '')
      return { ok: false, error: 'caused-by needs a goalRef: the candidate goal you think caused it.' };
    goalRef = candidateNamed(subject, input.goalRef);
    if (goalRef === null)
      return {
        ok: false,
        error:
          subject.candidates.length === 0
            ? `${subject.key} has no candidate goals, so it cannot be caused-by one. Say pre-existing or unclear.`
            : `${input.goalRef} is not one of ${subject.key}'s candidates (${subject.candidates
                .map((c) => `#${String(issueOriginNumber('root', c) ?? c)}`)
                .join(', ')}). Name one of them, or say pre-existing or unclear.`,
      };
  } else if (input.goalRef !== null && input.goalRef.trim() !== '')
    return {
      ok: false,
      error: `goalRef goes only with caused-by. For ${input.verdict}, leave it out and say in reason what you found.`,
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

/** The stored sample message and stack, and nothing else: every read is recorded and drawn on the Errors tab. */
export function readAppErrorDetail(store: Store, task: Task, key: string): AppErrorDetailRead {
  const fenced = fence(store, 'app_error_detail', task.originRef, key);
  if (!fenced.ok) return fenced;
  const { run, subject } = fenced;
  const detail = store.appErrors.getDetail(subject.environment, subject.fingerprint);
  store.appErrorTriage.recordDetailRead({ ...subject, runId: run.id, taskId: task.id });
  return { ok: true, key: subject.key, message: detail?.message ?? null, stack: detail?.stack ?? null };
}
