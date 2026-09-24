import { useEffect, useState, type JSX } from 'react';
import type { Issue, LocalRunTargetView, LocalRunTurn, LocalRunView, LocalValidationView } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { Ref } from './refs.js';
import { inFlight, localValidationSaid } from '../view/localValidation.js';
import { ValidateLocallyModal } from './ValidateLocallyModal.js';
import { TranscriptPane } from './TranscriptPane.js';
import { MessageForm, Readings, RefLine, StatusLine, summaryClick } from './LocalRunReadings.js';
import { GoalPicker } from './LocalRunPicker.js';

// → docs/spec/17-cockpit.md

const POLL_MS = 2000;

const TURN_LABEL: Record<LocalRunTurn, string> = {
  start: 'starting',
  stop: 'stopping',
  refresh: 'refreshing',
  message: 'replying',
};

type Act = () => Promise<unknown> | unknown;
type Validate = (issueNumber: number, opts: { refresh?: boolean }) => Promise<unknown> | unknown;

interface RunReading {
  live: boolean;
  turn: LocalRunTurn | null;
  phase: string | null;
  said: string | null;
  stale: boolean;
  idle: boolean;
  canRefresh: boolean;
  canMessage: boolean;
  runNumber: number | null;
  canValidate: boolean;
  goalTitle: string | null;
}

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
  onValidate: Validate;
  validation: LocalValidationView | null;
  validationConfigured: boolean;
  fetchOutput: () => Promise<string[]>;
}): JSX.Element {
  const [lines, setLines] = useState<string[]>([]);
  const [outputOpen, setOutputOpen] = useState<boolean | null>(null);

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

  const reading = readRun(run, lines, goals, targets, validation, validationConfigured);
  const outOpen = outputOpen ?? !reading.idle;

  return (
    <div className="lrun">
      <ConfigNotes configured={configured} stopConfigured={stopConfigured} />
      <EnvSection
        run={run}
        reading={reading}
        now={now}
        validation={validation}
        stopConfigured={stopConfigured}
        refreshConfigured={refreshConfigured}
        onRefresh={onRefresh}
        onStop={onStop}
        onMessage={onMessage}
        onValidate={onValidate}
      />
      {run !== null && <OutputFold run={run} lines={lines} open={outOpen} onFlip={() => setOutputOpen(!outOpen)} />}
      <GoalPicker run={run} live={reading.live} goals={goals} targets={targets} now={now} onStart={onStart} />
    </div>
  );
}

function readRun(
  run: LocalRunView | null,
  lines: string[],
  goals: Issue[],
  targets: LocalRunTargetView[],
  validation: LocalValidationView | null,
  validationConfigured: boolean,
): RunReading {
  const live = run !== null && run.live;
  const { turn, phase, said } = turnOf(run, lines);
  const stale = live && isBehind(run);
  const idle = live && run.status === 'running' && turn === null;
  const runNumber = runNumberOf(run);
  return {
    live,
    turn,
    phase,
    said,
    stale,
    idle,
    canRefresh: stale && idle,
    canMessage: idle && run.holdsSession,
    runNumber,
    canValidate: idle && validationConfigured && validatable(runNumber, targets, validation),
    goalTitle: goalTitleOf(run, goals),
  };
}

function turnOf(
  run: LocalRunView | null,
  lines: string[],
): { turn: LocalRunTurn | null; phase: string | null; said: string | null } {
  const turn = run === null ? null : run.turn;
  const phase = turn !== null && run !== null ? run.phase : null;
  const said = turn !== null && phase === null ? (lines[lines.length - 1] ?? null) : null;
  return { turn, phase, said };
}

function isBehind(run: LocalRunView): boolean {
  const behind = run.freshness?.behindTip ?? null;
  return behind !== null && behind > 0;
}

function runNumberOf(run: LocalRunView | null): number | null {
  return run === null ? null : Number(/^issue:(\d+)$/.exec(run.originRef)?.[1] ?? Number.NaN);
}

function validatable(
  runNumber: number | null,
  targets: LocalRunTargetView[],
  validation: LocalValidationView | null,
): boolean {
  if (runNumber === null || !Number.isFinite(runNumber) || inFlight(validation)) return false;
  return targets.find((t) => t.issueNumber === runNumber)?.runnable ?? false;
}

function goalTitleOf(run: LocalRunView | null, goals: Issue[]): string | null {
  return run === null ? null : (goals.find((g) => `issue:${String(g.number)}` === run.originRef)?.title ?? null);
}

/* The environment: the subject of the panel, and the only thing that changes
   while somebody is watching. */
function EnvSection({
  run,
  reading,
  now,
  validation,
  stopConfigured,
  refreshConfigured,
  onRefresh,
  onStop,
  onMessage,
  onValidate,
}: {
  run: LocalRunView | null;
  reading: RunReading;
  now: number;
  validation: LocalValidationView | null;
  stopConfigured: boolean;
  refreshConfigured: boolean;
  onRefresh: Act;
  onStop: Act;
  onMessage: (text: string) => Promise<unknown> | unknown;
  onValidate: Validate;
}): JSX.Element {
  const [askRefresh, setAskRefresh] = useState(false);
  const { runNumber, goalTitle } = reading;
  return (
    <section className="lrun-env" aria-label="The local environment">
      <header className="lrun-head">
        <div className="lrun-status">
          <span className={`lrun-dot ${tone(run)}`} aria-hidden />
          <h3>{run === null ? 'Nothing has been run locally' : <StatusLine run={run} now={now} />}</h3>
        </div>
        {run !== null && (
          <RunActions
            run={run}
            reading={reading}
            stopConfigured={stopConfigured}
            refreshConfigured={refreshConfigured}
            onRefresh={onRefresh}
            onStop={onStop}
            onValidate={(n) => (reading.stale ? setAskRefresh(true) : onValidate(n, {}))}
          />
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
        <RunDetails run={run} reading={reading} now={now} validation={validation} onMessage={onMessage} />
      )}
    </section>
  );
}

function ConfigNotes({ configured, stopConfigured }: { configured: boolean; stopConfigured: boolean }): JSX.Element {
  return (
    <>
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
    </>
  );
}

function RunActions({
  run,
  reading,
  stopConfigured,
  refreshConfigured,
  onRefresh,
  onStop,
  onValidate,
}: {
  run: LocalRunView;
  reading: RunReading;
  stopConfigured: boolean;
  refreshConfigured: boolean;
  onRefresh: Act;
  onStop: Act;
  onValidate: (runNumber: number) => unknown;
}): JSX.Element | null {
  const { live, canRefresh, canValidate, runNumber } = reading;
  const canStop = live && run.status !== 'stopping';
  if (!canRefresh && !canValidate && !canStop) return null;
  return (
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
          onClick={() => onValidate(runNumber)}
          title="Send one agent to write a test plan against what is running, drive it in a browser, and report on the goal's page"
        >
          Validate #{runNumber}
        </AsyncButton>
      )}
      {canStop && (
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
  );
}

function RunDetails({
  run,
  reading,
  now,
  validation,
  onMessage,
}: {
  run: LocalRunView;
  reading: RunReading;
  now: number;
  validation: LocalValidationView | null;
  onMessage: (text: string) => Promise<unknown> | unknown;
}): JSX.Element {
  const { live, stale, canMessage } = reading;
  return (
    <>
      <RunMeta run={run} goalTitle={reading.goalTitle} now={now} />
      <RunStages reading={reading} validation={validation} />
      {/* What the session said — its own account of the run, which is the only
          account of a failure there is. Not while a teardown is in flight: the
          note still holds the bring-up's last words, and "Up on :5173" under
          "Stopping…" reads as a panel contradicting itself. */}
      {run.note !== null && run.status !== 'stopping' && <p className="lrun-note">{run.note}</p>}
      {live && <Readings run={run} now={now} stale={stale} />}
      {canMessage && <MessageForm onMessage={onMessage} />}
    </>
  );
}

function RunMeta({ run, goalTitle, now }: { run: LocalRunView; goalTitle: string | null; now: number }): JSX.Element {
  return (
    <>
      <p className="lrun-meta">
        <Ref to={run.originRef} />
        {goalTitle !== null && <span className="lrun-title"> {goalTitle}</span>}
        {run.refFacts?.part != null && ` · part ${String(run.refFacts.part.seq)} of ${String(run.refFacts.part.total)}`}
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
    </>
  );
}

function RunStages({
  reading,
  validation,
}: {
  reading: RunReading;
  validation: LocalValidationView | null;
}): JSX.Element {
  const { turn, phase, said } = reading;
  return (
    <>
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
    </>
  );
}

/* The session's own words, in the pane the fleet's transcripts use. These are
   the same bytes off the same `output` event, so anything else here shows the
   operator the SGR escapes raw and every tool call at full length — which is
   the whole of what there is to read when a bring-up did not work. Open while
   a turn is in flight or the run has settled — the cases with something to
   read — and folded under a steady environment. A `details`, so the browser
   draws the fold and the content is in the markup whichever way it stands. */
function OutputFold({
  run,
  lines,
  open,
  onFlip,
}: {
  run: LocalRunView;
  lines: string[];
  open: boolean;
  onFlip: () => void;
}): JSX.Element {
  return (
    <details className="lrun-fold lrun-out" open={open} onClick={(e) => summaryClick(e, onFlip)}>
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
  );
}

function tone(run: LocalRunView | null): string {
  if (run === null) return 'off';
  if (run.status === 'running') return 'up';
  if (run.status === 'starting' || run.status === 'stopping') return 'busy';
  if (run.status === 'failed') return 'bad';
  return 'off';
}
