import { useState, type JSX, type ReactNode } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { AppliedFix } from '../view/needsYou.js';
import type { BuildReading, SetupCheck, SetupFix } from '../types.js';
import { Button } from '../components/button.js';

// → docs/spec/17-cockpit.md

export function CardFoot({
  why = null,
  wide = false,
  settled = false,
  children,
}: {
  why?: ReactNode;
  wide?: boolean;
  settled?: boolean;
  children: ReactNode;
}): JSX.Element {
  const cls = ['cn-qfoot', wide ? 'cn-wide' : '', settled ? 'cn-settled' : ''].filter((c) => c !== '').join(' ');
  return (
    <div className={cls}>
      {why !== null && <span className="cn-footwhy">{why}</span>}
      <span className="cn-footacts">{children}</span>
    </div>
  );
}

export function UpdateActs({
  kind,
  build,
  actions,
}: {
  kind: 'upgrade' | 'project_pull';
  build: BuildReading;
  actions: CockpitActions;
}): JSX.Element | null {
  const snooze = (
    <Button
      ghost
      size="small"
      onClick={() => void actions.snoozeUpdate(kind === 'upgrade' ? 'upgrade' : 'projectPull')}
    >
      Snooze
    </Button>
  );

  if (kind === 'project_pull')
    return <CardFoot why="Nothing to answer — the row clears when the checkout does.">{snooze}</CardFoot>;

  const { intent, live, supervised } = build;
  if (!supervised)
    return (
      <CardFoot why="No supervisor, so this build cannot restart itself — the panel says what to run.">
        {snooze}
      </CardFoot>
    );

  if (intent.state === 'applying') return null;

  if (intent.state === 'draining' || intent.state === 'ready')
    return (
      <CardFoot why={intent.state === 'ready' ? 'The fleet is clear.' : `Waiting for ${live} to finish.`}>
        <Button ghost size="small" onClick={() => void actions.upgrade('cancel')}>
          Cancel
        </Button>
        {intent.state === 'ready' ? (
          <Button tone="primary" size="small" onClick={() => void actions.upgrade('apply')}>
            Apply now
          </Button>
        ) : (
          <Button size="small" onClick={() => void actions.upgrade('apply', { interrupt: true })}>
            Don&apos;t wait — interrupt {live}
          </Button>
        )}
      </CardFoot>
    );

  if (live === 0)
    return (
      <CardFoot why="Exits, takes the update and comes back. Nothing is interrupted.">
        {snooze}
        <Button tone="primary" size="small" onClick={() => void actions.upgrade('drain')}>
          Upgrade
        </Button>
      </CardFoot>
    );

  return (
    <CardFoot
      why={
        <>
          Queue waits for {live} to finish; Now stops {live === 1 ? 'it' : 'them'} and restores{' '}
          {live === 1 ? 'it' : 'them'} on the way back up.
        </>
      }
    >
      {snooze}
      <Button size="small" onClick={() => void actions.upgrade('apply', { interrupt: true })}>
        Now
      </Button>
      <Button tone="primary" size="small" onClick={() => void actions.upgrade('drain')}>
        Queue
      </Button>
    </CardFoot>
  );
}

export function ConfigFix({ check, actions }: { check: SetupCheck; actions: CockpitActions }): JSX.Element | null {
  const fix: SetupFix | undefined = check.fix;
  const [value, setValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  if (fix === undefined) return null;

  if (fix.kind === 'shell') {
    return (
      <CardFoot why={fix.why} wide>
        <div className="cn-shell">
          <span aria-hidden="true">$</span>
          <code>{fix.command}</code>
          <button
            type="button"
            className={copied ? 'cn-copy cn-copied' : 'cn-copy'}
            onClick={() => {
              void navigator.clipboard?.writeText(fix.command).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : fix.label}
          </button>
        </div>
      </CardFoot>
    );
  }

  if (fix.kind === 'sheet' || fix.kind === 'goto') return <NavFix check={check} fix={fix} actions={actions} />;

  const paths = Object.keys(fix.set);
  const only = paths[0];
  const editable = fix.confidence === 'assumed' && paths.length === 1 && only !== undefined;
  const typed = value ?? (editable ? String(fix.set[only as string]) : '');
  const write = (): void => {
    setBusy(true);
    const set = editable ? { [only as string]: coerce(typed, fix.set[only as string]) } : fix.set;
    void actions.applyConfigFix(check.id, set).finally(() => setBusy(false));
  };

  return (
    <CardFoot why={editable ? null : (check.remedy ?? null)} wide={editable}>
      {editable ? (
        <div className="cn-fixline">
          <label className="cn-fixedit">
            Set <code>{only}</code> to
            <input className="cn-inline" value={typed} onChange={(e) => setValue(e.target.value)} aria-label={only} />
          </label>
          <Button size="small" disabled={busy} onClick={write}>
            Write it
          </Button>
        </div>
      ) : (
        <Button tone="primary" size="small" disabled={busy} onClick={write}>
          {fix.label}
        </Button>
      )}
    </CardFoot>
  );
}

function NavFix({
  check,
  fix,
  actions,
}: {
  check: SetupCheck;
  fix: Extract<SetupFix, { kind: 'sheet' | 'goto' }>;
  actions: CockpitActions;
}): JSX.Element {
  if (fix.kind === 'sheet') {
    return (
      <CardFoot why={check.remedy ?? null}>
        <Button tone="primary" size="small" onClick={() => actions.openPanel('setup')}>
          {fix.label}
        </Button>
      </CardFoot>
    );
  }

  return (
    <CardFoot why={check.remedy ?? null}>
      <Button
        tone="primary"
        size="small"
        onClick={() =>
          fix.to === 'tickets'
            ? actions.openTab('tickets')
            : actions.openConfig({
                configTab: fix.to === 'prompts' ? 'prompts' : 'values',
                configGroup: fix.group ?? null,
              })
        }
      >
        {fix.label}
      </Button>
    </CardFoot>
  );
}

function coerce(text: string, like: unknown): unknown {
  if (typeof like === 'boolean') return text === 'true';
  if (typeof like === 'number') return Number(text);
  return text;
}

export function SettledFix({ applied, actions }: { applied: AppliedFix; actions: CockpitActions }): JSX.Element {
  return (
    <CardFoot
      settled
      why={
        <span className="cn-settled-what">
          <b>{applied.summary}</b>
          <i className="cn-settled-file">→ {applied.file}</i>
        </span>
      }
    >
      <Button size="small" onClick={() => void actions.undoConfigFix(applied.checkId)}>
        Undo
      </Button>
      <Button size="small" onClick={() => actions.dismissConfigFix(applied.checkId)}>
        Dismiss
      </Button>
    </CardFoot>
  );
}
