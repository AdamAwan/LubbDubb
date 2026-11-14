import type { JSX } from 'react';
import { api } from '../api.js';
import { canTriage, type ErrorRow, type ErrorTriage, VERDICT_SAID } from '../view/appErrors.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref } from './refs.js';
import { Tag } from './tag.js';
import { relTime } from './util.js';

// → docs/spec/39-app-errors.md#in-the-cockpit

/**
 * The triage agent's word beside the deterministic link, kept apart from it: what it said, whether a
 * run holding the group is still out, whether it read the stored stack, and the Triage press.
 */
export function TriageNote({
  row,
  now,
  onPressed,
}: {
  row: ErrorRow;
  now: number;
  onPressed: () => void;
}): JSX.Element | null {
  const { triage } = row;
  const press = canTriage(row);
  if (triage === null && !press) return null;
  const answered = triage !== null && triage.verdict !== null;
  return (
    <div className="ae-triage">
      {triage !== null && <AgentSaid triage={triage} now={now} />}
      {triage?.queued === true && <span className="ae-note">The triage agent has this group.</span>}
      {triage !== null && triage.detailReadAt !== null && (
        <span className="ae-note">The triage agent read the stack.</span>
      )}
      {triage?.detailQuery != null && (
        <span className="ae-note" title={`ran ${relTime(triage.detailQuery.at, now)}`}>
          {triage.detailQuery.ok
            ? 'The triage agent ran the detail query.'
            : 'The triage agent ran the detail query, and it failed.'}
        </span>
      )}
      {press && (
        <span className="ae-acts">
          <AsyncButton
            usage="app-error.send"
            size="small"
            onClick={async () => {
              await api.triageAppError(row.environment, row.fingerprint);
              onPressed();
            }}
          >
            {answered ? 'Triage again' : 'Triage'}
          </AsyncButton>
        </span>
      )}
    </div>
  );
}

function AgentSaid({ triage, now }: { triage: ErrorTriage; now: number }): JSX.Element | null {
  if (triage.verdict === null) return null;
  return (
    <span className="ae-agent" title={triage.at === null ? undefined : `said ${relTime(triage.at, now)}`}>
      <span className="ae-agent-said">Agent: {VERDICT_SAID[triage.verdict]}</span>
      {triage.goalRef !== null && (
        <span className="cn-refs">
          <Ref to={triage.goalRef} />
        </span>
      )}
      {triage.confidence !== null && (
        <Tag tone="grey" lower>
          {triage.confidence}
        </Tag>
      )}
      {triage.reason !== null && <span className="ae-note">{triage.reason}</span>}
    </span>
  );
}
