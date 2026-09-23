import { useEffect, useState, type JSX } from 'react';
import type { TenantCommandOutput, TenantCommandView, TenantPreparation } from '../types.js';
import { TranscriptPane } from './TranscriptPane.js';
import { elapsed, relTime } from './util.js';

// → docs/spec/36-remote-validation.md#what-the-gate-shows-while-it-runs

const POLL_MS = 2000;
const QUIET_MS = 5 * 60 * 1000;

const CALL_LABEL = { ensure: 'Provisioning', reseed: 'Reseeding' } as const;

export function TenantCommandsPanel({
  commands,
  now,
  fetchOutput,
}: {
  commands: TenantCommandView[];
  now: number;
  fetchOutput: (environment: string) => Promise<TenantCommandOutput>;
}): JSX.Element {
  if (commands.length === 0) return <p className="cn-empty">No environment declares a tenant command.</p>;
  return (
    <div className="lrun">
      {commands.map((view) => (
        <TenantCommands key={view.environment} view={view} now={now} fetchOutput={fetchOutput} />
      ))}
      <p className="lrun-note">
        A command is started from a goal’s validation sheet. It keeps running if this page is closed or the harness
        restarts.
      </p>
    </div>
  );
}

function TenantCommands({
  view,
  now,
  fetchOutput,
}: {
  view: TenantCommandView;
  now: number;
  fetchOutput: (environment: string) => Promise<TenantCommandOutput>;
}): JSX.Element {
  const prep = view.preparation;
  const running = prep !== null && prep.finishedAt === null;
  const [output, setOutput] = useState<TenantCommandOutput>({ lines: [], lastOutputAt: null });
  const [open, setOpen] = useState<boolean | null>(null);

  const tick = running ? Math.floor(now / POLL_MS) : 0;
  useEffect(() => {
    let live = true;
    void fetchOutput(view.environment).then((next) => {
      if (live) setOutput(next);
    });
    return () => {
      live = false;
    };
  }, [fetchOutput, view.environment, prep?.launchedAt, prep?.finishedAt, tick]);

  const quietFor = running && output.lastOutputAt !== null ? now - new Date(output.lastOutputAt).getTime() : Number.NaN;
  const quiet = quietFor >= QUIET_MS;

  return (
    <section className="lrun-env" aria-label={`Tenant commands on ${view.environment}`}>
      <header className="lrun-head">
        <div className="lrun-status">
          <span className={`lrun-dot ${tone(prep)}`} aria-hidden />
          <h3>
            {view.environment}
            {' · '}
            <Status prep={prep} now={now} />
          </h3>
        </div>
      </header>
      {view.ensureTenant !== null && (
        <p className="lrun-meta lrun-where">
          ensureTenant <code>{view.ensureTenant}</code>
        </p>
      )}
      {view.reseed !== null && (
        <p className="lrun-meta lrun-where">
          reseed <code>{view.reseed}</code>
        </p>
      )}
      {quiet && (
        <p className="lrun-note lrun-warn">
          Nothing printed for {elapsed(output.lastOutputAt ?? '', null, now)} — it may be waiting on something.
        </p>
      )}
      {prep?.detail != null && <p className="lrun-note">{prep.detail}</p>}
      {prep?.launchedAt != null && (
        <details className="lrun-fold lrun-out" open={open ?? running} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary>
            <span>Output</span>
            {output.lines.length > 0 && <span className="lrun-fold-hint">{output.lines[output.lines.length - 1]}</span>}
          </summary>
          {output.lines.length > 0 ? (
            <TranscriptPane
              text={output.lines.join('\n')}
              streamId={`${view.environment} ${prep.launchedAt}`}
              label={`Tenant command output on ${view.environment}`}
              className="compact"
            />
          ) : (
            <p className="lrun-note">Nothing printed yet.</p>
          )}
        </details>
      )}
    </section>
  );
}

function Status({ prep, now }: { prep: TenantPreparation | null; now: number }): JSX.Element {
  if (prep === null) return <>never run from here</>;
  const what = prep.call === null ? 'Preparing' : CALL_LABEL[prep.call];
  if (prep.finishedAt === null) return <>{`${what} · ${elapsed(prep.startedAt, null, now)}`}</>;
  const how = prep.ok === true ? 'finished' : prep.ok === false ? 'failed' : 'ended, outcome unknown';
  return <>{`last run ${how} ${relTime(prep.finishedAt, now)}`}</>;
}

function tone(prep: TenantPreparation | null): string {
  if (prep === null) return 'off';
  if (prep.finishedAt === null) return 'busy';
  if (prep.ok === true) return 'up';
  if (prep.ok === false) return 'bad';
  return 'off';
}
