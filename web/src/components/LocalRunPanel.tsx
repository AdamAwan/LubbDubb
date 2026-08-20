import { useEffect, useState, type JSX } from 'react';
import type { Issue, LocalRunView } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref } from './refs.js';
import { relTime } from './util.js';

/**
 * The machine's one dev environment: which goal's code is in it, whether it came
 * up, and how to point it at something else.
 *
 * **One environment is the whole design, so this is a swap and not a list.** There
 * is one dev environment on the operator's machine — the same constraint the
 * validation claim is built on — so the panel's shape is a single state plus a
 * picker, never a table of runs with their own buttons. A list would imply two
 * could be up, which is the one thing the store refuses.
 *
 * **It says what it knows and not more.** `running` means the session that was told
 * to bring the environment up finished without failing and its process is alive; it
 * does not mean anything answered on the port. So the URL is drawn as a link to try
 * rather than as a reading, and the log tail is here because the case an operator
 * actually hits is a start that did not work — a panel that said `failed` with
 * nowhere to look would send them back to a terminal.
 */
export function LocalRunPanel({
  run,
  configured,
  goals,
  now,
  onStart,
  onStop,
  fetchOutput,
}: {
  run: LocalRunView | null;
  /** `localRun.instruction` is set, so a start has something to run. */
  configured: boolean;
  /** What can be started — the goals the cockpit is already drawing. */
  goals: Issue[];
  now: number;
  onStart: (issueNumber: number) => Promise<unknown> | unknown;
  onStop: () => Promise<unknown> | unknown;
  fetchOutput: () => Promise<string[]>;
}): JSX.Element {
  const [picked, setPicked] = useState<number | null>(null);
  const [lines, setLines] = useState<string[]>([]);

  // Refetched when the run changes rather than polled: the tail is off the snapshot
  // on purpose, and `run` is what the snapshot moves when anything happens to it —
  // so a start, a stop and the session's own output all land here as one dependency.
  useEffect(() => {
    let live = true;
    void fetchOutput().then((next) => {
      if (live) setLines(next);
    });
    return () => {
      live = false;
    };
  }, [fetchOutput, run?.id, run?.status, run?.note]);

  const target = picked ?? goals[0]?.number ?? null;

  return (
    <div className="lrun">
      {!configured && (
        // The refusal a start would have given, said before it is pressed. The
        // control below is still drawn and still refuses, because a button that
        // vanishes leaves nothing to explain itself.
        <p className="lrun-note">
          Nothing is configured to start. Set <code>localRun.instruction</code> on the Config page — what you would tell
          somebody to get this project running on your machine.
        </p>
      )}

      <header className="lrun-head">
        <div>
          <h3>{run === null ? 'Nothing has been run locally' : <StatusLine run={run} now={now} />}</h3>
          {run !== null && (
            <p className="lrun-meta">
              <Ref to={run.originRef} /> · <code>{run.ref}</code>
              {run.url !== null && (
                <>
                  {' · '}
                  {/* A link to try, not a reading: nothing here has opened that port. */}
                  <a href={run.url} target="_blank" rel="noreferrer">
                    {run.url}
                  </a>
                </>
              )}
            </p>
          )}
        </div>
        {run !== null && run.live && (
          <AsyncButton className="btn ghost" onClick={() => onStop()}>
            Stop it
          </AsyncButton>
        )}
      </header>

      {/* What the session said — its own account of the run, which is the only
          account of a failure there is. */}
      {run?.note !== null && run !== null && <p className="lrun-note">{run.note}</p>}

      <div className="lrun-swap">
        <label htmlFor="lrun-goal">{run !== null && run.live ? 'Run a different goal' : 'Run a goal'}</label>
        <select
          id="lrun-goal"
          value={target ?? ''}
          onChange={(e) => setPicked(Number(e.target.value))}
          disabled={goals.length === 0}
        >
          {goals.map((goal) => (
            <option key={goal.number} value={goal.number}>
              #{goal.number} {goal.title}
            </option>
          ))}
        </select>
        <AsyncButton
          className="btn"
          disabled={target === null}
          onClick={() => (target === null ? undefined : onStart(target))}
        >
          {run !== null && run.live ? 'Swap to it' : 'Start it'}
        </AsyncButton>
        {run !== null && run.live && (
          // Said where the control is, because it is the one consequence of this
          // button that is not obvious: there is one environment, so starting is
          // also stopping.
          <span className="lrun-hint">stops what is running now</span>
        )}
      </div>

      {lines.length > 0 && <pre className="lrun-log">{lines.join('\n')}</pre>}
    </div>
  );
}

/** The headline: what state the environment is in, in words rather than a chip. */
function StatusLine({ run, now }: { run: LocalRunView; now: number }): JSX.Element {
  if (run.status === 'starting') return <>Starting, {relTime(run.startedAt, now)}</>;
  if (run.status === 'running') return <>Running since {relTime(run.startedAt, now)}</>;
  if (run.status === 'failed') return <>It did not start</>;
  return <>Stopped {run.endedAt === null ? '' : relTime(run.endedAt, now)}</>;
}
