import type { JSX } from 'react';
import type {
  RemoteReadingView,
  RemoteRowOutcome,
  RemoteRunView,
  RemoteSheetRowView,
  RemoteSheetView,
  RemoteTenantView,
} from '../types.js';
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

interface SheetControls {
  onRule: (environment: string, rowId: string, accept: boolean) => Promise<void>;
  onSelect: (environment: string, rowId: string, selected: boolean) => Promise<void>;
  onPress: (environment: string) => Promise<void>;
  onCancel: (environment: string) => Promise<void>;
  onReseed: (environment: string) => Promise<void>;
}

/**
 * One block per environment the goal has a sheet for: the gate — the tenant and its age, the
 * deployed commit the last run pinned, and the press — and the rows the arrival assembled, with what
 * each one came back as.
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
  controls,
}: {
  sheets: RemoteSheetView[];
  showing: string | null;
  onShow: (environment: string | null) => void;
  controls: SheetControls;
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
      <Gate sheet={open} controls={controls} />
      {open.rows.map((row) => (
        <SheetRow key={row.rowId} row={row} controls={controls} />
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

/**
 * The gate: what an operator reads at the moment they decide to press. The tenant's age is drawn
 * here because this is where they can act on it — reseed first, then press.
 */
function Gate({ sheet, controls }: { sheet: RemoteSheetView; controls: SheetControls }): JSX.Element {
  const live = sheet.run !== null && (sheet.run.status === 'pending' || sheet.run.status === 'dispatched');
  const selected = sheet.rows.filter((r) => r.selected).length;
  return (
    <div className="cn-sheet-gate">
      <HeadRow className="cn-sig-head">
        <TenantLine tenant={sheet.tenant} environment={sheet.environment} />
        {sheet.run !== null && <RunLine run={sheet.run} />}
      </HeadRow>
      <div className="cn-sig-ctrls">
        {live ? (
          <AsyncButton onClick={() => controls.onCancel(sheet.environment)}>Call this run off</AsyncButton>
        ) : (
          <AsyncButton
            onClick={() => controls.onPress(sheet.environment)}
            title={`Re-read every selected row against the commit ${sheet.environment} stands at right now`}
          >
            {selected === 1 ? 'Run 1 row' : `Run ${selected} rows`}
          </AsyncButton>
        )}
        {sheet.tenant.reseedable && (
          <AsyncButton
            onClick={() => controls.onReseed(sheet.environment)}
            title="Run this environment’s own tenant commands — the harness never invents a tenant name"
          >
            Reseed the tenant
          </AsyncButton>
        )}
      </div>
    </div>
  );
}

function TenantLine({ tenant, environment }: { tenant: RemoteTenantView; environment: string }): JSX.Element {
  if (tenant.blockedReason !== null) return <span className="cn-sig-read unknown">{tenant.blockedReason}</span>;
  if (tenant.tenant === null)
    return <span className="cn-sub">{environment} declares no tenant, so nothing here is put to one.</span>;
  return (
    <>
      <Tag lower title="The tenant every row on this sheet is put to">
        {tenant.tenant}
      </Tag>
      {tenant.stale ? (
        <Tag tone="amber" fill title="Beyond the freshness window this environment declared">
          {ageOf(tenant)}
        </Tag>
      ) : (
        <span className="cn-sub">{ageOf(tenant)}</span>
      )}
    </>
  );
}

function ageOf(tenant: RemoteTenantView): string {
  if (tenant.reseededAt === null) return 'never reseeded';
  const n = Math.max(0, Math.round((tenant.ageMs ?? 0) / 86_400_000));
  return n === 0 ? 'reseeded today' : `reseeded ${String(n)} day${n === 1 ? '' : 's'} ago`;
}

function RunLine({ run }: { run: RemoteRunView }): JSX.Element {
  if (run.status === 'pending') return <Tag tone="violet">waiting for an agent</Tag>;
  if (run.status === 'dispatched') return <Tag tone="violet">running</Tag>;
  if (run.status === 'abandoned')
    return <span className="cn-sig-read unknown">The last press ran nothing — {run.note ?? 'it was called off.'}</span>;
  return (
    <span className="cn-sub">
      Last run against {short(run.startedSha)}
      {run.endedSha !== null && run.endedSha !== run.startedSha ? ` … ${short(run.endedSha)}` : ''}
    </span>
  );
}

function short(sha: string | null): string {
  return sha === null ? 'a commit it would not name' : sha.slice(0, 7);
}

function SheetRow({ row, controls }: { row: RemoteSheetRowView; controls: SheetControls }): JSX.Element {
  const outcome = row.blockedReason !== null ? 'blocked' : (row.reading?.outcome ?? null);
  const tone = outcome === null ? 'unread' : outcome;
  return (
    <div className={`cn-sig-row ${tone}${row.selected ? '' : ' dropped'}`}>
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
          {!row.selected && <Tag title="Taken out of the next press">not selected</Tag>}
        </HeadRow>
        <p className="cn-sig-read">{said(row)}</p>
      </div>
      <div className="cn-sig-ctrls">
        {row.awaitingApproval && (
          <>
            <AsyncButton onClick={() => controls.onRule(row.environment, row.rowId, true)}>
              Accept &amp; run
            </AsyncButton>
            <AsyncButton onClick={() => controls.onRule(row.environment, row.rowId, false)}>Decline</AsyncButton>
          </>
        )}
        <AsyncButton
          onClick={() => controls.onSelect(row.environment, row.rowId, !row.selected)}
          title={
            row.selected
              ? 'Take this row out of the next press — it does not apply here, or you will do it by hand'
              : 'Put this row back into the next press'
          }
        >
          {row.selected ? 'Deselect' : 'Select'}
        </AsyncButton>
      </div>
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
