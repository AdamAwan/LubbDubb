import { useEffect, useState, type JSX, type MouseEvent } from 'react';
import type {
  Issue,
  LocalRunFreshness,
  LocalRunPorts,
  LocalRunRefFacts,
  LocalRunTargetView,
  LocalRunTurn,
  LocalRunView,
} from '../types.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { Ref } from './refs.js';
import { TranscriptPane } from './TranscriptPane.js';
import { elapsed, fmtUsd, relTime } from './util.js';

/** How often the tail is refetched while the run is live. */
const POLL_MS = 2000;

/** What the picker is selecting: a goal, and which of its branches. */
interface Pick {
  issueNumber: number;
  /** Undefined means the goal's default — the tip of its stack. */
  ref?: string;
}

/** The stage line's caption for each turn — what the session is in the middle of. */
const TURN_LABEL: Record<LocalRunTurn, string> = {
  start: 'starting',
  stop: 'stopping',
  refresh: 'refreshing',
  message: 'replying',
};

/**
 * The machine's one dev environment: which goal's code is in it, whether it came
 * up, what it is listening on, how far behind its branch it has fallen, and how to
 * talk to it or point it at something else.
 *
 * **One environment is the whole design, so this is a card and a picker, not a
 * list.** There is one dev environment on the operator's machine — the same
 * constraint the validation claim is built on — so the panel's shape is a single
 * state plus a picker, never a table of runs with their own buttons. A list would
 * imply two could be up, which is the one thing the store refuses.
 *
 * **The environment is the subject; the picker is secondary.** While something is
 * up, the picker folds away under "Run a different goal" and the card carries the
 * readings and the controls. Nothing here is a `Place`: which fold is open and
 * which row is picked are not *where you are*, and the panel itself is the place.
 *
 * **It says what it knows and not more, and now it knows a little.** `running`
 * still means the session that was told to bring the environment up finished
 * without failing; the watch adds whether the declared port answers a TCP connect,
 * which ports the session's own processes hold, and how many commits the branch has
 * beyond the checkout. Each reading is three-valued and drawn as such — "not
 * checked" and "could not read" are different words from a zero.
 *
 * **Controls say what they are.** Stop is the danger button with a two-click arm;
 * Refresh is primary and drawn only while there is something to pick up; Start
 * appears once a row is picked. A button that would be disabled is not drawn — the
 * stage line under the status says what is happening instead.
 *
 * **Every row describes the ref it would check out, and nothing else.** A pull
 * request is a fact about a branch, not about a goal, so a ref with no pull request
 * of its own says so, beside what did land there.
 */
export function LocalRunPanel({
  run,
  configured,
  stopConfigured,
  refreshConfigured,
  goals,
  targets,
  now,
  onStart,
  onStop,
  onMessage,
  onRefresh,
  fetchOutput,
}: {
  run: LocalRunView | null;
  /** `localRun.instruction` is set, so a start has something to run. */
  configured: boolean;
  /** `localRun.stopInstruction` is set, so a stop can take the environment down and not just the session. */
  stopConfigured: boolean;
  /** `localRun.refreshInstruction` is set, so a refresh tells the session the project's own steps. */
  refreshConfigured: boolean;
  /** What can be started — the goals the cockpit is already drawing. */
  goals: Issue[];
  /** Where each of those goals would run, and what has happened there. */
  targets: LocalRunTargetView[];
  now: number;
  onStart: (issueNumber: number, ref?: string) => Promise<unknown> | unknown;
  onStop: () => Promise<unknown> | unknown;
  onMessage: (text: string) => Promise<unknown> | unknown;
  onRefresh: () => Promise<unknown> | unknown;
  fetchOutput: () => Promise<string[]>;
}): JSX.Element {
  const [picked, setPicked] = useState<Pick | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  // The two folds. Null follows the default for the run's state; a value is the
  // operator's own choice and wins from then on.
  const [outputOpen, setOutputOpen] = useState<boolean | null>(null);
  const [pickerOpen, setPickerOpen] = useState<boolean | null>(null);

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
  }, [fetchOutput, run?.id, run?.status, run?.note, run?.turn, tick]);

  const live = run !== null && run.live;
  const turn = run === null ? null : run.turn;
  // What it is doing, and if it never said, the last thing it printed — for as long
  // as a turn is in flight. A start, a stop, a refresh and a message are all a
  // session's turn with somebody watching, and a turn that says nothing for a minute
  // is the same failure at any end of the run. Once nothing is in flight there is
  // no stage: captioning an environment that is up with the last step of its own
  // start would be the panel describing something that is not happening.
  //
  // The fallback is drawn as the session's own words rather than as a caption,
  // because that is what it is. An instruction can be overridden and a model can
  // ignore a rule, and a panel that presented a stray line of install output in the
  // voice of a milestone would be inventing the one thing it is here to report.
  const phase = turn !== null && run !== null ? run.phase : null;
  const said = turn !== null && phase === null ? (lines[lines.length - 1] ?? null) : null;

  const behind = run?.freshness?.behindTip ?? null;
  const stale = live && behind !== null && behind > 0;
  // Only while nothing else is going on: a refresh during a message turn would queue
  // behind it, and the server refuses exactly that. Not disabled — absent, with the
  // stage line saying why.
  const idle = live && run.status === 'running' && turn === null;
  const canRefresh = stale && idle;
  const canMessage = idle && run.holdsSession;
  const goalTitle =
    run === null ? null : (goals.find((g) => `issue:${String(g.number)}` === run.originRef)?.title ?? null);

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

      {/* The environment: the subject of the panel, and the only thing that changes
          while somebody is watching. */}
      <section className="lrun-env" aria-label="The local environment">
        <header className="lrun-head">
          <div className="lrun-status">
            <span className={`lrun-dot ${tone(run)}`} aria-hidden />
            <h3>{run === null ? 'Nothing has been run locally' : <StatusLine run={run} now={now} />}</h3>
          </div>
          {run !== null && (canRefresh || (live && run.status !== 'stopping')) && (
            <div className="lrun-actions">
              {canRefresh && (
                // Primary, and only while there is something to pick up: the one
                // action the panel is asking for. Gone the moment it is not.
                <AsyncButton
                  className="primary"
                  onClick={() => onRefresh()}
                  title={
                    refreshConfigured
                      ? `Move the checkout to the tip of ${run.ref} and run the refresh instruction`
                      : `Move the checkout to the tip of ${run.ref} and tell the session what moved — set localRun.refreshInstruction to say what to do about it`
                  }
                >
                  Refresh
                </AsyncButton>
              )}
              {live && run.status !== 'stopping' && (
                // Two clicks, because a mis-click costs a warm environment and several
                // minutes. Not drawn while stopping: the status line already says so,
                // and a disabled button beside it would say it twice.
                <ConfirmButton
                  label="Stop"
                  confirmLabel="Stop it — really"
                  pendingLabel="Stopping…"
                  onConfirm={() => onStop()}
                  title={
                    stopConfigured
                      ? 'Run the stop instruction, then take the session down'
                      : 'Kills the session — nothing is configured to stop what it started'
                  }
                />
              )}
            </div>
          )}
        </header>

        {run !== null && (
          <>
            <p className="lrun-meta">
              <Ref to={run.originRef} />
              {goalTitle !== null && <span className="lrun-title"> {goalTitle}</span>}
              {run.refFacts?.part != null &&
                ` · part ${String(run.refFacts.part.seq)} of ${String(run.refFacts.part.total)}`}
            </p>
            <p className="lrun-meta lrun-where">
              <code>{run.ref}</code>
              {run.commit !== null && (
                <>
                  {' @ '}
                  <code title={run.commit}>{run.commit.slice(0, 7)}</code>
                </>
              )}
            </p>
            {/* What is on the branch that is up — the same reading the rows below
                carry, so "what am I looking at" is answered in one vocabulary. */}
            {run.refFacts != null && <RefLine facts={run.refFacts} now={now} />}
            {turn !== null && (
              <p className={`lrun-stage${phase === null && said !== null ? ' lrun-stage-said' : ''}`}>
                <span className="lrun-stage-turn">{TURN_LABEL[turn]}</span>
                {phase !== null ? ` · ${phase}` : said !== null ? ` · ${said}` : '…'}
              </p>
            )}
            {/* What the session said — its own account of the run, which is the only
                account of a failure there is. Not while a teardown is in flight: the
                note still holds the bring-up's last words, and "Up on :5173" under
                "Stopping…" reads as a panel contradicting itself. */}
            {run.note !== null && run.status !== 'stopping' && <p className="lrun-note">{run.note}</p>}
            {live && <Readings run={run} now={now} stale={stale} />}
            {canMessage && <MessageForm onMessage={onMessage} />}
          </>
        )}
      </section>

      {/* The session's own words, in the pane the fleet's transcripts use. These are
          the same bytes off the same `output` event, so anything else here shows the
          operator the SGR escapes raw and every tool call at full length — which is
          the whole of what there is to read when a bring-up did not work. Open while
          a turn is in flight or the run has settled — the cases with something to
          read — and folded under a steady environment. A `details`, so the browser
          draws the fold and the content is in the markup whichever way it stands. */}
      {run !== null && (
        <details
          className="lrun-fold lrun-out"
          open={outputOpen ?? !idle}
          onClick={(e) => summaryClick(e, () => setOutputOpen(!(outputOpen ?? !idle)))}
        >
          <summary>
            <span>Output</span>
            {lines.length > 0 && <span className="lrun-fold-hint">{lines[lines.length - 1]}</span>}
          </summary>
          {lines.length > 0 ? (
            <TranscriptPane text={lines.join('\n')} streamId={run.id} label="Local run output" className="compact" />
          ) : (
            <p className="lrun-note">Nothing printed yet.</p>
          )}
        </details>
      )}

      {/* The picker, folded while something is up. Rows rather than a `select`: what
          a row has to say does not fit in an option's label, and a choice you cannot
          see is what this panel got wrong first. */}
      <details
        className="lrun-fold lrun-pick"
        open={pickerOpen ?? !live}
        onClick={(e) => summaryClick(e, () => setPickerOpen(!(pickerOpen ?? !live)))}
      >
        <summary>
          <span>{live ? 'Run a different goal' : 'Run a goal'}</span>
          {live && (
            // Said where the control is, because it is the one consequence of starting
            // that is not obvious: there is one environment, so starting is also stopping.
            <span className="lrun-fold-hint">stops what is running now</span>
          )}
        </summary>
        <div className="lrun-pick-body">
          {(holdingBack > 0 || showAll) && (
            <label className="lrun-filter">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              show every goal
            </label>
          )}

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
            const running = live && run.originRef === target.originRef;
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
                    {running && <span className="lrun-tag">running</span>}
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

          {/* The Start button appears with a choice, not before it: a disabled "Pick a
              goal" is a control that cannot be used, standing where the instruction
              should be. The rows are the instruction. */}
          {picked !== null && chosenFacts !== null && (
            <div className="lrun-go">
              <AsyncButton className="primary" onClick={() => onStart(picked.issueNumber, picked.ref)}>
                {`${live ? 'Swap to' : 'Start'} #${String(picked.issueNumber)}`}
              </AsyncButton>
              {/* The ref, on the button's own line: this is the last chance to see what
                  is about to be checked out, and the goal number does not say it. */}
              <code className="lrun-go-ref">{chosenFacts.ref}</code>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

/**
 * A click on a fold's summary, and nothing else inside the fold. The folds are
 * controlled — their default follows the run's state until the operator chooses — so
 * the browser's own toggle is stopped and the state does the opening. `onToggle` is
 * the wrong hook for that: it fires for a programmatic open too, and a turn opening
 * the output would read as the operator having asked for it to stay open.
 */
function summaryClick(e: MouseEvent<HTMLDetailsElement>, flip: () => void): void {
  if (!(e.target instanceof Element) || e.target.closest('summary') === null) return;
  e.preventDefault();
  flip();
}

/** The status dot's hue: green up, amber in motion, red failed, muted for nothing or stopped. */
function tone(run: LocalRunView | null): string {
  if (run === null) return 'off';
  if (run.status === 'running') return 'up';
  if (run.status === 'starting' || run.status === 'stopping') return 'busy';
  if (run.status === 'failed') return 'bad';
  return 'off';
}

/**
 * The readings on a live environment: the declared URL and whether its port answers,
 * what the session's own processes are listening on, how far the checkout has fallen
 * behind its branch, and what the run has cost.
 *
 * Each is three-valued and worded as such. "not checked" is the watch not having
 * looked yet; "could not read" is the watch having looked and the machine not saying;
 * neither is a zero, and neither is drawn as one.
 */
function Readings({ run, now, stale }: { run: LocalRunView; now: number; stale: boolean }): JSX.Element {
  return (
    <div className="lrun-grid">
      <Tile label="URL">
        {run.url === null ? (
          <span className="lrun-dim">none configured</span>
        ) : (
          <>
            {/* A link to try — and now, beside it, whether the port answered. */}
            <a href={run.url} target="_blank" rel="noreferrer">
              {run.url.replace(/^https?:\/\//, '')}
            </a>
            <PortWord ports={run.ports} />
          </>
        )}
      </Tile>
      <Tile label="Listening" sub="the session’s own processes">
        <ListeningWord ports={run.ports} />
      </Tile>
      <Tile label="Code" tone={stale ? 'stale' : undefined} sub={<FreshnessSub freshness={run.freshness} now={now} />}>
        <FreshnessWord freshness={run.freshness} branch={run.ref} />
      </Tile>
      {/* What the sessions behind this run have cost. Absent rather than $0.00 when
          nothing was measured: a PTY deployment reports no usage at all. */}
      {run.costUsd !== null && (
        <Tile
          label="Spent"
          sub={run.numTurns === null ? undefined : `${String(run.numTurns)} turn${run.numTurns === 1 ? '' : 's'}`}
        >
          {fmtUsd(run.costUsd)}
        </Tile>
      )}
    </div>
  );
}

function Tile({
  label,
  sub,
  tone,
  children,
}: {
  label: string;
  sub?: JSX.Element | string | undefined;
  tone?: 'stale' | undefined;
  children: JSX.Element | string | (JSX.Element | string | false | null)[];
}): JSX.Element {
  return (
    <div className={`lrun-tile${tone === undefined ? '' : ` ${tone}`}`}>
      <span className="lrun-tile-label">{label}</span>
      <span className="lrun-tile-value">{children}</span>
      {sub !== undefined && <span className="lrun-tile-sub">{sub}</span>}
    </div>
  );
}

function PortWord({ ports }: { ports: LocalRunPorts | null }): JSX.Element {
  if (ports === null || ports.declared === null) return <span className="lrun-tile-sub">not checked</span>;
  return (
    <span className={`lrun-tile-sub ${ports.declared.answering ? 'lrun-ok' : 'lrun-warn'}`}>
      {ports.declared.answering ? 'answering' : 'not answering'}
    </span>
  );
}

function ListeningWord({ ports }: { ports: LocalRunPorts | null }): JSX.Element {
  if (ports === null) return <span className="lrun-dim">not checked</span>;
  if (ports.listening === null) return <span className="lrun-dim">could not read</span>;
  if (ports.listening.length === 0) return <span className="lrun-dim">nothing yet</span>;
  return <code>{ports.listening.join(' · ')}</code>;
}

// `branch`, not `ref`: a prop called `ref` is React's, and a function component given
// one throws before it renders a thing.
function FreshnessWord({ freshness, branch }: { freshness: LocalRunFreshness | null; branch: string }): JSX.Element {
  if (freshness === null) return <span className="lrun-dim">not checked</span>;
  if (freshness.behindTip === null) return <span className="lrun-dim">could not compare</span>;
  if (freshness.behindTip === 0) return <>current</>;
  return (
    <>
      {String(freshness.behindTip)} commit{freshness.behindTip === 1 ? '' : 's'} behind the tip of <code>{branch}</code>
    </>
  );
}

function FreshnessSub({ freshness, now }: { freshness: LocalRunFreshness | null; now: number }): JSX.Element | null {
  if (freshness === null) return null;
  const base = freshness.base;
  const baseWord =
    base === null
      ? null
      : base.behind === null
        ? `against ${base.ref}: could not compare`
        : base.behind === 0
          ? `level with ${base.ref}`
          : `branch behind ${base.ref} by ${String(base.behind)}`;
  return (
    <>
      {baseWord !== null && `${baseWord} · `}checked {relTime(freshness.checkedAt, now)}
    </>
  );
}

/**
 * Type into the session holding the environment — the fleet's reply box, for the one
 * session that is not an agent. The refusal stays on screen, because the server's
 * reasons ("still coming up", "busy replying") are the useful half of a refused send.
 */
function MessageForm({ onMessage }: { onMessage: (text: string) => Promise<unknown> | unknown }): JSX.Element {
  const [text, setText] = useState('');
  const send = useAsyncAction();
  return (
    <form
      className="lrun-say"
      onSubmit={(e) => {
        e.preventDefault();
        const value = text.trim();
        if (!value) return;
        void send.run(async () => {
          await onMessage(value);
          setText('');
        });
      }}
    >
      <div className="lrun-say-row">
        <input
          placeholder="Tell the session something — run the migrations, restart the API…"
          aria-label="Message to the session holding the environment"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <SubmitButton phase={send.phase}>Send</SubmitButton>
      </div>
      {send.refusal !== null && <p className="lrun-note lrun-warn">{send.refusal}</p>}
    </form>
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
  if (run.status === 'starting')
    return (
      <>
        Starting <span className="lrun-clock">{elapsed(run.startedAt, null, now)}</span>
      </>
    );
  if (run.status === 'running')
    return (
      <>
        Running <span className="lrun-clock">up {elapsed(run.startedAt, null, now)}</span>
      </>
    );
  // No clock here, unlike the two above: the only timestamp on the row is when the
  // *run* started, and "Stopping · 18:04" reads as a stop that has been going for
  // eighteen minutes. The stage line under this is what moves while a teardown is in
  // flight.
  if (run.status === 'stopping') return <>Stopping…</>;
  if (run.status === 'failed') return <>It did not start</>;
  return <>Stopped {run.endedAt === null ? '' : relTime(run.endedAt, now)}</>;
}
