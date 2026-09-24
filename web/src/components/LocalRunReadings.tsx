import { useState, type JSX, type MouseEvent } from 'react';
import type { LocalRunFreshness, LocalRunPorts, LocalRunRefFacts, LocalRunView } from '../types.js';
import { SubmitButton, useAsyncAction } from './AsyncButton.js';
import { elapsed, fmtUsd, relTime } from './util.js';
import { Label } from './label.js';

// → docs/spec/17-cockpit.md

export function Readings({ run, now, stale }: { run: LocalRunView; now: number; stale: boolean }): JSX.Element {
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

export function MessageForm({ onMessage }: { onMessage: (text: string) => Promise<unknown> | unknown }): JSX.Element {
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

export function RefSummary({ facts, now }: { facts: LocalRunRefFacts; now: number }): JSX.Element {
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

export function RefLine({ facts, now }: { facts: LocalRunRefFacts; now: number }): JSX.Element {
  return (
    <p className="lrun-meta lrun-on">
      <RefSummary facts={facts} now={now} />
    </p>
  );
}

export function StatusLine({ run, now }: { run: LocalRunView; now: number }): JSX.Element {
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

export function summaryClick(e: MouseEvent<HTMLDetailsElement>, flip: () => void): void {
  if (!(e.target instanceof Element) || e.target.closest('summary') === null) return;
  e.preventDefault();
  flip();
}
