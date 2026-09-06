import { useEffect, useState, type JSX, type MouseEvent } from 'react';
import type {
  Issue,
  LocalRunFreshness,
  LocalRunPorts,
  LocalRunRefFacts,
  LocalRunTargetView,
  LocalRunTurn,
  LocalRunView,
  LocalValidationView,
} from '../types.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { Ref } from './refs.js';
import { inFlight, localValidationSaid } from '../view/localValidation.js';
import { ValidateLocallyModal } from './ValidateLocallyModal.js';
import { TranscriptPane } from './TranscriptPane.js';
import { elapsed, fmtUsd, relTime } from './util.js';
import { Label } from './label.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

const POLL_MS = 2000;

interface Pick {
  issueNumber: number;
  ref?: string;
}

const TURN_LABEL: Record<LocalRunTurn, string> = {
  start: 'starting',
  stop: 'stopping',
  refresh: 'refreshing',
  message: 'replying',
};

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
  onValidate,
  validation,
  validationConfigured,
  fetchOutput,
}: {
  run: LocalRunView | null;
  configured: boolean;
  stopConfigured: boolean;
  refreshConfigured: boolean;
  goals: Issue[];
  targets: LocalRunTargetView[];
  now: number;
  onStart: (issueNumber: number, ref?: string) => Promise<unknown> | unknown;
  onStop: () => Promise<unknown> | unknown;
  onMessage: (text: string) => Promise<unknown> | unknown;
  onRefresh: () => Promise<unknown> | unknown;
  onValidate: (issueNumber: number, opts: { refresh?: boolean }) => Promise<unknown> | unknown;
  validation: LocalValidationView | null;
  validationConfigured: boolean;
  fetchOutput: () => Promise<string[]>;
}): JSX.Element {
  const [picked, setPicked] = useState<Pick | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [outputOpen, setOutputOpen] = useState<boolean | null>(null);
  const [pickerOpen, setPickerOpen] = useState<boolean | null>(null);
  const [askRefresh, setAskRefresh] = useState(false);

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
  const phase = turn !== null && run !== null ? run.phase : null;
  const said = turn !== null && phase === null ? (lines[lines.length - 1] ?? null) : null;

  const behind = run?.freshness?.behindTip ?? null;
  const stale = live && behind !== null && behind > 0;
  const idle = live && run.status === 'running' && turn === null;
  const canRefresh = stale && idle;
  const canMessage = idle && run.holdsSession;
  const runNumber = run === null ? null : Number(/^issue:(\d+)$/.exec(run.originRef)?.[1] ?? Number.NaN);
  const runsAGoal = runNumber !== null && Number.isFinite(runNumber);
  const canValidate =
    idle &&
    runsAGoal &&
    validationConfigured &&
    !inFlight(validation) &&
    (runNumber === null ? false : (targets.find((t) => t.issueNumber === runNumber)?.runnable ?? false));
  const goalTitle =
    run === null ? null : (goals.find((g) => `issue:${String(g.number)}` === run.originRef)?.title ?? null);

  const byNumber = new Map(targets.map((t) => [t.issueNumber, t]));
  const candidates = goals.flatMap((goal) => {
    const target = byNumber.get(goal.number);
    return target === undefined ? [] : [{ goal, target }];
  });
  const rows = showAll ? candidates : candidates.filter((row) => row.target.runnable);
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
        <p className="lrun-note">
          Nothing is configured to start. Set <code>localRun.instruction</code> on the Config page — what you would tell
          somebody to get this project running on your machine.
        </p>
      )}
      {configured && !stopConfigured && (
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
          {run !== null && (canRefresh || canValidate || (live && run.status !== 'stopping')) && (
            <div className="lrun-actions">
              {canRefresh && (
                <AsyncButton
                  tone="primary"
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
              {canValidate && runNumber !== null && (
                <AsyncButton
                  className="primary"
                  onClick={() => (stale ? setAskRefresh(true) : onValidate(runNumber, {}))}
                  title="Send one agent to write a test plan against what is running, drive it in a browser, and report on the goal's page"
                >
                  Validate #{runNumber}
                </AsyncButton>
              )}
              {live && run.status !== 'stopping' && (
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

        {askRefresh && run !== null && runNumber !== null && (
          <ValidateLocallyModal
            mode="refresh"
            issueNumber={runNumber}
            issueTitle={goalTitle ?? `#${String(runNumber)}`}
            targetRef={run.ref}
            run={run}
            runTitle={goalTitle}
            onSubmit={(opts) => Promise.resolve(onValidate(runNumber, opts))}
            onClose={() => setAskRefresh(false)}
          />
        )}
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
            {/* A validation in flight, in the same stage line the run's own turns
                use: it is the other thing that takes minutes with somebody
                watching, and it belongs beside the environment it is being run
                against rather than only on the goal's page. */}
            {validation !== null && inFlight(validation) && (
              <p className="lrun-stage">
                <span className="lrun-stage-turn">validating</span>
                {` · ${localValidationSaid(validation)}`}
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
          {live && <span className="lrun-fold-hint">stops what is running now</span>}
        </summary>
        <div className="lrun-pick-body">
          {(holdingBack > 0 || showAll) && (
            <label className="lrun-filter">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              show every goal
            </label>
          )}

          {rows.length === 0 && (
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
                    {running && <Tag tone="green">running</Tag>}
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
              <AsyncButton tone="primary" onClick={() => onStart(picked.issueNumber, picked.ref)}>
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

function summaryClick(e: MouseEvent<HTMLDetailsElement>, flip: () => void): void {
  if (!(e.target instanceof Element) || e.target.closest('summary') === null) return;
  e.preventDefault();
  flip();
}

function tone(run: LocalRunView | null): string {
  if (run === null) return 'off';
  if (run.status === 'running') return 'up';
  if (run.status === 'starting' || run.status === 'stopping') return 'busy';
  if (run.status === 'failed') return 'bad';
  return 'off';
}

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
      <Label dense>{label}</Label>
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

function RefSummary({ facts, now }: { facts: LocalRunRefFacts; now: number }): JSX.Element {
  const bits: string[] = [];
  if (facts.part !== null) {
    bits.push(`part ${String(facts.part.seq)} of ${String(facts.part.total)}`);
    if (facts.part.status === 'merged') bits.push('merged — an older state than the goal delivered');
  } else if (facts.isDefaultBranch) {
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

function RefLine({ facts, now }: { facts: LocalRunRefFacts; now: number }): JSX.Element {
  return (
    <p className="lrun-meta lrun-on">
      <RefSummary facts={facts} now={now} />
    </p>
  );
}

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
  if (run.status === 'stopping') return <>Stopping…</>;
  if (run.status === 'failed') return <>It did not start</>;
  return <>Stopped {run.endedAt === null ? '' : relTime(run.endedAt, now)}</>;
}
