import type { JSX } from 'react';
import type { RemoteReadingView, RemoteRowOutcome, RemoteSheetRowView, RemoteSheetView } from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { Button } from './button.js';
import { HeadRow } from './panel.js';
import { Tag, type TagTone } from './tag.js';

// → docs/spec/36-remote-validation.md#the-cockpit

const OUTCOME_TONE: Record<RemoteRowOutcome, TagTone> = {
  passed: 'green',
  failed: 'red',
  blocked: 'grey',
};

/**
 * One block per environment the goal has a sheet for: the rows the arrival assembled, what each one
 * came back as, and the one control the gate has in this build — accepting a query against this
 * environment, on the evidence of what it returned.
 *
 * A blocked row and an unread one say **why in words** and never in a clean reading's vocabulary: a
 * row nothing was learned from is not a row that passed quietly.
 *
 * @public embedded by the goal page, which owns its chrome
 */
export function RemoteValidationSection({
  sheets,
  showing,
  onShow,
  onRule,
}: {
  sheets: RemoteSheetView[];
  showing: string | null;
  onShow: (environment: string | null) => void;
  onRule: (environment: string, rowId: string, accept: boolean) => Promise<void>;
}): JSX.Element {
  const open = sheets.find((s) => s.environment === showing) ?? sheets[0]!;
  return (
    <div className="cn-sig">
      {sheets.length > 1 && (
        <HeadRow className="cn-sig-add">
          {sheets.map((sheet) => (
            <Button
              key={sheet.environment}
              onClick={() => onShow(sheet.environment)}
              title={`The sheet assembled against ${sheet.environment}`}
            >
              {sheet.environment}
              {sheet.environment === open.environment ? ' ·' : ''}
            </Button>
          ))}
        </HeadRow>
      )}
      {open.rows.map((row) => (
        <SheetRow key={row.rowId} row={row} onRule={onRule} />
      ))}
      <div className="cn-sig-add">
        <span className="cn-sub">
          Assembled when this goal&rsquo;s work arrived in {open.environment}. Nothing here deploys, promotes or writes:
          every query is read-only and runs with your own credential.
        </span>
      </div>
    </div>
  );
}

function SheetRow({
  row,
  onRule,
}: {
  row: RemoteSheetRowView;
  onRule: (environment: string, rowId: string, accept: boolean) => Promise<void>;
}): JSX.Element {
  const outcome = row.blockedReason !== null ? 'blocked' : (row.reading?.outcome ?? null);
  const tone = outcome === null ? 'unread' : outcome;
  return (
    <div className={`cn-sig-row ${tone}`}>
      <span className="cn-sig-stripe" />
      <div className="cn-sig-body">
        <HeadRow className="cn-sig-head">
          <b className="cn-name">{row.title}</b>
          <Tag>{row.kind}</Tag>
          <Tag lower title="The author’s own id, and what this row stands for">
            {row.sourceId}
          </Tag>
          {outcome !== null && (
            <Tag tone={OUTCOME_TONE[outcome]} fill>
              {outcome}
            </Tag>
          )}
        </HeadRow>
        <p className="cn-sig-read">{said(row)}</p>
      </div>
      {row.awaitingApproval && (
        <div className="cn-sig-ctrls">
          <AsyncButton onClick={() => onRule(row.environment, row.rowId, true)}>Accept &amp; run</AsyncButton>
          <AsyncButton onClick={() => onRule(row.environment, row.rowId, false)}>Decline</AsyncButton>
        </div>
      )}
    </div>
  );
}

function said(row: RemoteSheetRowView): string {
  if (row.blockedReason !== null) return `Nothing was learned here — ${row.blockedReason}`;
  const reading: RemoteReadingView | null = row.reading;
  if (reading === null)
    return row.kind === 'check'
      ? 'Nothing has run this. A check is yours to run, and its result is recorded on the goal’s own validation row.'
      : 'Nothing has been read on this row yet.';
  if (reading.detail !== null) return reading.detail;
  return reading.outcome === 'passed'
    ? `${row.environment} answered what this row declared.`
    : `${row.environment} did not answer what this row declared.`;
}
