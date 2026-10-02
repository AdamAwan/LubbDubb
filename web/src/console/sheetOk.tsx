import { useState, type JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { OkScope, OkStatus, RemoteSheetView } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Button } from '../components/button.js';
import { Tag, type TagTone } from '../components/tag.js';

// → docs/spec/36-remote-validation.md#the-ok

const STATUS: Record<OkStatus, { word: string; tone: TagTone | undefined }> = {
  'needs-you': { word: 'needs you', tone: 'amber' },
  queued: { word: 'queued', tone: 'blue' },
  running: { word: 'running', tone: 'blue' },
  done: { word: 'done', tone: 'green' },
  'not-here': { word: 'not validating here', tone: 'grey' },
  open: { word: 'answered', tone: 'grey' },
  nothing: { word: 'nothing to run', tone: 'grey' },
};

/**
 * One environment's page on the run strip: where it stands, and the one answer it asks for. The OK
 * runs everything the page holds; the harness does the rest and says only what needs a person.
 */
export function SheetOkRow({
  sheet,
  issueNumber,
  actions,
  onRefused,
}: {
  sheet: RemoteSheetView;
  issueNumber: number;
  actions: CockpitActions;
  onRefused: (reason: string) => void;
}): JSX.Element {
  const { status, why } = sheet.ok;
  const [declining, setDeclining] = useState<string | null>(null);
  const env = sheet.environment;
  const okText = declining === null ? okLabel(status, sheet.okable) : null;
  return (
    <div className="cn-runstrip-row">
      <span className="cn-runstrip-who">{env}</span>
      <Tag tone={STATUS[status].tone} fill={status === 'needs-you'}>
        {STATUS[status].word}
      </Tag>
      {okText !== null && (
        <AsyncButton
          usage="validation.create"
          tone="primary"
          size="small"
          onClick={() => actions.giveRemoteOk(issueNumber, env)}
          onRefused={onRefused}
          title={`Approve this page's queries on ${env}, accept its checks, and run everything on it as soon as ${env} is free`}
        >
          {okText}
        </AsyncButton>
      )}
      {status === 'queued' && (
        <AsyncButton usage="validation.stop" onClick={() => actions.withdrawRemoteOk(issueNumber, env)}>
          Withdraw OK
        </AsyncButton>
      )}
      {(status === 'needs-you' || status === 'open') && declining === null && (
        <Button size="small" ghost usage="validation.edit" onClick={() => setDeclining('')}>
          Not validating here
        </Button>
      )}
      {declining !== null && (
        <>
          <input
            className="vp-why cn-ok-why"
            autoFocus
            placeholder={`Why ${env} will not be validated for this goal — required`}
            value={declining}
            onChange={(e) => setDeclining(e.target.value)}
          />
          <AsyncButton
            usage="validation.edit"
            disabled={declining.trim() === ''}
            onClick={async () => {
              await actions.markRemoteNotHere(issueNumber, env, declining.trim());
              setDeclining(null);
            }}
            onRefused={onRefused}
          >
            Say so
          </AsyncButton>
          <Button size="small" ghost usage="validation.edit" onClick={() => setDeclining(null)}>
            Keep it
          </Button>
        </>
      )}
      {status === 'running' && <span className="cn-sub">a run is going — the panel below follows it</span>}
      {declining === null && (status === 'needs-you' || status === 'open') && (
        <span className="cn-sub">{scopeLine(sheet.okable)}</span>
      )}
      {why !== null && <span className="cn-sub">{why}</span>}
    </div>
  );
}

function asksFor(scope: OkScope): boolean {
  return scope.checks + scope.queries > 0;
}

function okLabel(status: OkStatus, scope: OkScope): string | null {
  if (status === 'needs-you') return 'OK, run it';
  if (status === 'done') return 'Run again';
  return (status === 'open' || status === 'not-here') && asksFor(scope) ? 'OK, run it' : null;
}

function scopeLine({ checks, queries, approvals }: OkScope): string {
  const parts = [
    ...(checks > 0 ? [plural(checks, 'check')] : []),
    ...(queries > 0 ? [plural(queries, 'state query', 'state queries')] : []),
  ];
  const runs = `runs ${parts.join(' and ')}`;
  return approvals > 0 ? `${runs} · approves ${plural(approvals, 'query', 'queries')}` : runs;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
