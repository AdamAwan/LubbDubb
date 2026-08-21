import { useEffect, useState, type JSX } from 'react';
import type { Issue, LocalRunRefFacts, LocalRunTargetView, LocalRunView } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref } from './refs.js';
import { elapsed, relTime } from './util.js';

/** How often the tail is refetched while the run is live. */
const POLL_MS = 2000;

/** What the picker is selecting: a goal, and which of its branches. */
interface Pick {
  issueNumber: number;
  /** Undefined means the goal's default — the tip of its stack. */
  ref?: string;
}

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
 *
 * **Every row describes the ref it would check out, and nothing else.** A pull
 * request is a fact about a branch, not about a goal: a goal's work can sit on an
 * integration branch that combines several parts and is never opened as a PR, and a
 * goal can carry three PRs none of which describes the branch about to be started.
 * So a ref with no pull request of its own says so, beside what did land there. The
 * facts are shipped per ref for that reason — the one thing the cockpit must not do
 * here is decide which of a goal's PRs speaks for a branch.
 */
export function LocalRunPanel({
  run,
  configured,
  stopConfigured,
  goals,
  targets,
  now,
  onStart,
  onStop,
  fetchOutput,
}: {
  run: LocalRunView | null;
  /** `localRun.instruction` is set, so a start has something to run. */
  configured: boolean;
  /** `localRun.stopInstruction` is set, so a stop can take the environment down and not just the session. */
  stopConfigured: boolean;
  /** What can be started — the goals the cockpit is already drawing. */
  goals: Issue[];
  /** Where each of those goals would run, and what has happened there. */
  targets: LocalRunTargetView[];
  now: number;
  onStart: (issueNumber: number, ref?: string) => Promise<unknown> | unknown;
  onStop: () => Promise<unknown> | unknown;
  fetchOutput: () => Promise<string[]>;
}): JSX.Element {
  const [picked, setPicked] = useState<Pick | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  // Polled while the run is live, off the clock the panel already has rather than a
  // timer of its own — `tick` is the dependency that does it, and it is deliberate
  // for a reason worth stating: the tail is off the snapshot on purpose, so nothing
  // else in the cockpit ever refetches it. A bring-up that prints for two minutes
  // and a bring-up that hung look identical without this.
  //
  // `fetchOutput` is a fresh closure on every render and so would poll on its own.
  // That is incidental, not the mechanism: wrapping it in a `useCallback` upstream
  // is a perfectly reasonable thing to do and would silently freeze the tail.
  const tick = run?.live === true ? Math.floor(now / POLL_MS) : 0;
  useEffect(() => {
    let live = true;
    void fetchOutput().then((next) => {
      if (live) setLines(next);
    });
    return () => {
      live = false;
    };
  }, [fetchOutput, run?.id, run?.status, run?.note, tick]);

  // What it is doing, and if it never said, the last thing it printed.
  //
  // Only while it is *starting*: a stage is a claim about work in flight, and an
  // environment that is up has none — captioning a running one with the last step of
  // its own start would be the panel describing something that is not happening.
  //
  // The fallback is drawn as the session's own words rather than as a caption,
  // because that is what it is. An instruction can be overridden and a model can
  // ignore a rule, and a panel that presented a stray line of install output in the
  // voice of a milestone would be inventing the one thing it is here to report.
  // Starting **or** stopping: both are a session's turn with somebody watching, and a
  // teardown that says nothing for a minute is the same failure at the other end of
  // the run.
  const inFlight = run !== null && (run.status === 'starting' || run.status === 'stopping');
  const phase = inFlight ? run.phase : null;
  const said = inFlight && phase === null ? (lines[lines.length - 1] ?? null) : null;

  const byNumber = new Map(targets.map((t) => [t.issueNumber, t]));
  // Everything that *could* be drawn: a goal the cockpit is showing, with somewhere
  // for it to run. Both halves are needed — a target for a goal that is not in the
  // list is not a row anything can reveal.
  const candidates = goals.flatMap((goal) => {
    const target = byNumber.get(goal.number);
    return target === undefined ? [] : [{ goal, target }];
  });
  // Goals with a branch of their own by default. Everything else resolves to the
  // integration branch, which is one choice however many goals offer it.
  const rows = showAll ? candidates : candidates.filter((row) => row.target.runnable);
  // Counted off the **same** population the rows come from, which is the whole point
  // of doing it here: counting hidden *targets* instead let the checkbox and the
  // empty state disagree, and in the case that matters they disagreed the wrong way —
  // no rows drawn, nothing hidden by this list's reckoning, and so no control offered
  // to reveal what the filter was holding back.
  const holdingBack = candidates.length - rows.length;
  const chosen = picked === null ? null : (byNumber.get(picked.issueNumber) ?? null);
  const chosenFacts =
    chosen === null
      ? null
      : picked?.ref === undefined
        ? chosen.target
        : (chosen.options.find((o) => o.option.ref === picked.ref)?.facts ?? chosen.target);

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
      {configured && !stopConfigured && (
        // Said where Stop is, because Stop *works* — it kills the session — and does
        // less than it looks like it does. A dev environment is not a process tree:
        // the containers a start brought up belong to the Docker daemon, and no signal
        // the harness can send reaches them.
        <p className="lrun-note lrun-warn">
          Nothing is configured to stop it. Set <code>localRun.stopInstruction</code> on the Config page — until then,
          Stop kills the session but whatever it started keeps running.
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
          {/* What is on the branch that is up — the same reading the rows below
              carry, so "what am I looking at" is answered in one vocabulary. */}
          {run?.refFacts != null && <RefLine facts={run.refFacts} now={now} />}
          {phase !== null && <p className="lrun-stage">{phase}</p>}
          {said !== null && <p className="lrun-stage lrun-stage-said">{said}</p>}
        </div>
        {run !== null && run.live && (
          <AsyncButton className="btn ghost" disabled={run.status === 'stopping'} onClick={() => onStop()}>
            {run.status === 'stopping' ? 'Stopping…' : 'Stop it'}
          </AsyncButton>
        )}
      </header>

      {/* What the session said — its own account of the run, which is the only
          account of a failure there is. Not while a teardown is in flight: the note
          still holds the bring-up's last words, and "Up on :5173" under "Stopping…"
          reads as a panel contradicting itself. */}
      {run?.note !== null && run !== null && run.status !== 'stopping' && <p className="lrun-note">{run.note}</p>}

      <div className="lrun-pick">
        <div className="lrun-pick-head">
          <h4>{run !== null && run.live ? 'Run a different goal' : 'Run a goal'}</h4>
          {(holdingBack > 0 || showAll) && (
            <label className="lrun-filter">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              show every goal
            </label>
          )}
        </div>

        {rows.length === 0 && (
          // Which of the two empty states this is, said in words: a filter hiding
          // everything and a cockpit with no goals in it read identically otherwise,
          // and only one of them has anything an operator can do about it.
          //
          // The two arms line up with the checkbox by construction, because both read
          // `holdingBack`: the arm that says "tick it" is only ever drawn when it is
          // there to tick, and the other one says why there is nothing instead of
          // leaving somebody looking for a control that would not help.
          <p className="lrun-note">
            {holdingBack > 0
              ? `No goal has a branch of its own yet. ${String(holdingBack)} would run the integration branch — tick “show every goal” to pick one.`
              : goals.length === 0
                ? 'The cockpit is not drawing any goals yet, so there is nothing to run.'
                : 'None of these goals has anywhere to run yet.'}
          </p>
        )}

        {rows.map(({ goal, target }) => {
          const live = run !== null && run.live && run.originRef === target.originRef;
          const isPicked = picked?.issueNumber === goal.number;
          // Only worth an expander when there is something else behind the tip.
          const others = target.options.filter((o) => o.option.ref !== target.target.ref);
          return (
            <div className={`lrun-row${isPicked ? ' on' : ''}`} key={goal.number}>
              <div className="lrun-row-top">
                {/* The row's name is the control; its refs sit beside it. One click
                    cannot have two destinations. */}
                <button
                  type="button"
                  className="lrun-row-pick"
                  onClick={() => setPicked({ issueNumber: goal.number })}
                  aria-pressed={isPicked && picked?.ref === undefined}
                >
                  <span className="lrun-row-name">
                    #{goal.number} {goal.title}
                  </span>
                  <RefSummary facts={target.target} now={now} />
                </button>
                <span className="lrun-refs">
                  {live && <span className="lrun-tag">running</span>}
                  <Ref to={target.originRef} />
                  {target.target.pr !== null && <Ref to={`pr:${String(target.target.pr.number)}`} />}
                </span>
              </div>

              {others.length > 0 && (
                <button
                  type="button"
                  className="lrun-more"
                  onClick={() => setExpanded(expanded === goal.number ? null : goal.number)}
                >
                  {expanded === goal.number ? '▾' : '▸'} run an earlier part ({others.length})
                </button>
              )}
              {expanded === goal.number &&
                others.map(({ option, facts }) => (
                  <div className="lrun-row-top lrun-sub" key={option.ref}>
                    <button
                      type="button"
                      className="lrun-row-pick"
                      onClick={() => setPicked({ issueNumber: goal.number, ref: option.ref })}
                      aria-pressed={isPicked && picked?.ref === option.ref}
                    >
                      <span className="lrun-row-name">
                        {option.part === null
                          ? 'the goal’s own branch'
                          : `part ${String(option.part.seq)} · ${option.part.title}`}
                      </span>
                      <RefSummary facts={facts} now={now} />
                    </button>
                    <span className="lrun-refs">
                      {facts.pr !== null && <Ref to={`pr:${String(facts.pr.number)}`} />}
                    </span>
                  </div>
                ))}
            </div>
          );
        })}

        <div className="lrun-go">
          <AsyncButton
            className="btn"
            disabled={picked === null}
            onClick={() => (picked === null ? undefined : onStart(picked.issueNumber, picked.ref))}
          >
            {picked === null
              ? 'Pick a goal'
              : `${run !== null && run.live ? 'Swap to' : 'Start'} #${String(picked.issueNumber)}`}
          </AsyncButton>
          {/* The ref, on the button's own line: this is the last chance to see what
              is about to be checked out, and the goal number does not say it. */}
          {chosenFacts !== null && <code className="lrun-go-ref">{chosenFacts.ref}</code>}
          {run !== null && run.live && (
            // Said where the control is, because it is the one consequence of this
            // button that is not obvious: there is one environment, so starting is
            // also stopping.
            <span className="lrun-hint">stops what is running now</span>
          )}
        </div>
      </div>

      {lines.length > 0 && <pre className="lrun-log">{lines.join('\n')}</pre>}
    </div>
  );
}

/** The headline of a row: where in the plan this ref is, and what is on it. */
function RefSummary({ facts, now }: { facts: LocalRunRefFacts; now: number }): JSX.Element {
  const bits: string[] = [];
  if (facts.part !== null) {
    bits.push(`part ${String(facts.part.seq)} of ${String(facts.part.total)}`);
    if (facts.part.status === 'merged') bits.push('merged — an older state than the goal delivered');
  } else if (facts.isDefaultBranch) {
    // The honest reading of a goal with nothing of its own outstanding: its work is
    // in the integration branch, and that is what running it means.
    bits.push(
      facts.mergedParts > 0
        ? `the integration branch · ${String(facts.mergedParts)} part${facts.mergedParts === 1 ? '' : 's'} merged in`
        : 'the integration branch · nothing of this goal has landed',
    );
  }
  return (
    <span className="lrun-row-sub">
      <code>{facts.ref}</code>
      {bits.length > 0 && ` · ${bits.join(' · ')}`}
      <PrBit facts={facts} />
      {facts.agentOnIt ? (
        <span className="lrun-warn"> · an agent is working on this branch now</span>
      ) : (
        facts.lastActivityAt !== null && ` · last agent activity ${relTime(facts.lastActivityAt, now)}`
      )}
    </span>
  );
}

/**
 * The pull request **on this ref**, or the fact that there is none.
 *
 * The no-PR arm is the point of the component. "no pull request of its own" is a
 * different statement from silence: silence reads as a row that forgot to say, and
 * one glance at another goal's PR number would answer a question nobody asked.
 */
function PrBit({ facts }: { facts: LocalRunRefFacts }): JSX.Element {
  if (facts.pr === null) return <> · no pull request of its own</>;
  const ci =
    facts.pr.ciStatus === 'failing'
      ? `CI failing${facts.pr.failing.length > 0 ? ` (${facts.pr.failing.join(', ')})` : ''}`
      : facts.pr.ciStatus === 'passing'
        ? 'CI passing'
        : facts.pr.ciStatus === 'pending'
          ? 'CI running'
          : 'CI unknown';
  return (
    <>
      {' · '}
      <span className={facts.pr.ciStatus === 'failing' ? 'lrun-warn' : undefined}>{ci}</span>
      {facts.pr.state === 'merged' && ' · merged'}
      {facts.pr.state === 'closed' && ' · closed unmerged'}
      {facts.pr.approved && ' · approved'}
      {facts.pr.unresolved > 0 &&
        ` · ${String(facts.pr.unresolved)} unresolved comment${facts.pr.unresolved === 1 ? '' : 's'}`}
    </>
  );
}

/** The same reading as a row's, for the branch that is actually up. */
function RefLine({ facts, now }: { facts: LocalRunRefFacts; now: number }): JSX.Element {
  return (
    <p className="lrun-meta lrun-on">
      <RefSummary facts={facts} now={now} />
    </p>
  );
}

/**
 * The headline: what state the environment is in, in words rather than a chip.
 *
 * A live run is timed with {@link elapsed} rather than "3m ago", and the difference
 * is not cosmetic: a bring-up takes minutes, and a clock that ticks second by second
 * is the panel's answer to "is this still going". Rounded relative time sat on "2m
 * ago" for ninety seconds, which reads as a frozen screen.
 */
function StatusLine({ run, now }: { run: LocalRunView; now: number }): JSX.Element {
  if (run.status === 'starting') return <>Starting · {elapsed(run.startedAt, null, now)}</>;
  if (run.status === 'running') return <>Running · up {elapsed(run.startedAt, null, now)}</>;
  // No clock here, unlike the two above: the only timestamp on the row is when the
  // *run* started, and "Stopping · 18:04" reads as a stop that has been going for
  // eighteen minutes. The stage line under this is what moves while a teardown is in
  // flight.
  if (run.status === 'stopping') return <>Stopping…</>;
  if (run.status === 'failed') return <>It did not start</>;
  return <>Stopped {run.endedAt === null ? '' : relTime(run.endedAt, now)}</>;
}
