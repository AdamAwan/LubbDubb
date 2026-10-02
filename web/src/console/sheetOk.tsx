import { useState, type JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { RemoteSheetView } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { CONTROL_CLASS } from '../components/controls.js';
import { Button } from '../components/button.js';
import { Tag, type TagTone } from '../components/tag.js';
import { okStanding, type OkStatus } from '../view/validatePane.js';

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
  const { status, why } = okStanding(sheet);
  const [declining, setDeclining] = useState<string | null>(null);
  const env = sheet.environment;
  const ok = (label: string) => (
    <AsyncButton
      usage="validation.create"
      className={`${CONTROL_CLASS} primary`}
      onClick={() => actions.giveRemoteOk(issueNumber, env)}
      onRefused={onRefused}
      title={`Approve this page's queries on ${env}, accept its checks, and run everything on it as soon as ${env} is free`}
    >
      {label}
    </AsyncButton>
  );
  return (
    <div className="cn-runstrip-row">
      <span className="cn-runstrip-who">{env}</span>
      <Tag tone={STATUS[status].tone} fill={status === 'needs-you'}>
        {STATUS[status].word}
      </Tag>
      {status === 'needs-you' && ok('OK, run it')}
      {(status === 'open' || status === 'not-here') && sheet.okable > 0 && ok('OK, run it')}
      {status === 'done' && ok('Run again')}
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
            onClick={() => actions.markRemoteNotHere(issueNumber, env, declining.trim())}
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
      {why !== null && <span className="cn-sub">{why}</span>}
    </div>
  );
}
