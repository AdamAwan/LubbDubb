import type { JSX } from 'react';
import type {
  RemoteReadingView,
  RemoteRowOutcome,
  RemoteRunView,
  RemoteSheetRowView,
  RemoteSheetView,
  RemoteTenantView,
  TenantPreparation,
} from '../types.js';
import { AsyncButton } from './AsyncButton.js';
import { Button } from './button.js';
import { ConfirmButton } from './ConfirmButton.js';
import { ExtLink } from './util.js';
import { HeadRow } from './panel.js';
import { Tag, type TagTone } from './tag.js';

// → docs/spec/36-remote-validation.md#the-cockpit

const OUTCOME_TONE: Record<RemoteRowOutcome, TagTone> = {
  passed: 'green',
  failed: 'red',
  blocked: 'grey',
  // Its own hue, the check row's: not green, which would say the run judged the screen, and not grey,
  // which would say nothing came back. → docs/spec/36-remote-validation.md#a-screen-from-the-sheets-own-run
  captured: 'captured',
};

interface SheetControls {
  onRule: (environment: string, rowId: string, accept: boolean) => Promise<void>;
  onSelect: (environment: string, rowId: string, selected: boolean) => Promise<void>;
  onPress: (environment: string) => Promise<void>;
  onCancel: (environment: string) => Promise<void>;
  onReseed: (environment: string) => Promise<void>;
  /** Open an agent's transcript. The reading a run produced is only readable beside what it did. */
  onOpenAgent: (agentId: string) => void;
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
  switcher = true,
}: {
  sheets: RemoteSheetView[];
  showing: string | null;
  onShow: (environment: string | null) => void;
  controls: SheetControls;
  /** False where the surface embedding this already picks the environment. */
  switcher?: boolean;
}): JSX.Element {
  const open = sheets.find((s) => s.environment === showing) ?? sheets[0]!;
  return (
    <div className="cn-sig">
      {switcher && sheets.length > 1 && (
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
          Assembled when this goal&rsquo;s work arrived in {open.environment}. No row here deploys, promotes or writes:
          every query is read-only and runs with your own credential.
          {open.tenant.reseedable && open.tenant.destructive
            ? ' The reseed control above is the one thing on this card that changes the environment.'
            : ''}
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
  // What a press will actually read or dispatch for, which is not the same as what is selected: a
  // blocked row is skipped, and a row the server folded an `idleReason` onto names no instrument to
  // run it with. Counting the selection instead offers to run rows nothing would touch, and the run
  // settles on the spot reading as one that ran.
  // → docs/spec/36-remote-validation.md#a-row-no-press-can-read
  const pressable = sheet.rows.filter((r) => r.selected && r.blockedReason === null && r.idleReason === null).length;
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
            {pressable === 1 ? 'Run 1 row' : `Run ${pressable} rows`}
          </AsyncButton>
        )}
        {sheet.tenant.reseedable &&
          preparing(sheet.tenant) === null &&
          (sheet.tenant.destructive ? (
            <ConfirmButton
              label="Reseed the tenant"
              confirmLabel={
                sheet.tenant.tenant === null
                  ? 'Confirm — this destroys its data'
                  : `Confirm — this destroys ${sheet.tenant.tenant}’s data`
              }
              pendingLabel="Reseeding…"
              title={reseedWarning(sheet.tenant)}
              onConfirm={() => controls.onReseed(sheet.environment)}
            />
          ) : (
            <AsyncButton
              onClick={() => controls.onReseed(sheet.environment)}
              title="Provision this environment’s tenant with its own command — the harness never invents a tenant name"
            >
              Provision the tenant
            </AsyncButton>
          ))}
      </div>
      <PrepareLine tenant={sheet.tenant} />
      {sheet.tenant.reseedable && sheet.tenant.destructive && preparing(sheet.tenant) === null && (
        <span className="cn-sub cn-sheet-warn">{reseedWarning(sheet.tenant)}</span>
      )}
    </div>
  );
}

/** The preparation still running, or null. `finishedAt` null is the whole test. */
function preparing(tenant: RemoteTenantView): TenantPreparation | null {
  return tenant.preparation !== null && tenant.preparation.finishedAt === null ? tenant.preparation : null;
}

/**
 * What the gate shows while the environment's own tenant commands run, and what they came back as.
 * They take tens of minutes, so an operator who pressed and was shown nothing cannot tell a job still
 * running from one that died — and the outcome is where the tenant's new name comes from on an
 * `ensureTenant` environment. Read off the record rather than the click, so it survives a reload and
 * shows in a second browser. → docs/spec/36-remote-validation.md#what-the-gate-shows-while-it-runs
 */
function PrepareLine({ tenant }: { tenant: RemoteTenantView }): JSX.Element | null {
  const p = tenant.preparation;
  if (p === null) return null;
  if (p.finishedAt === null)
    return (
      <span className="cn-sheet-warn">
        <Tag tone="violet">
          {tenant.destructive ? 'reseeding' : 'provisioning'} — started {since(p.startedAt)}
        </Tag>{' '}
        <span className="cn-sub">
          This runs the environment&rsquo;s own command and can take tens of minutes. It keeps going if you close this
          page.
        </span>
      </span>
    );
  // `ok` null on a finished row is the third verdict, and it is not a failure: the harness restarted
  // while the command was running, and what it did is not knowable from here.
  const tone = p.ok === null ? 'amber' : p.ok ? 'green' : 'red';
  return (
    <span className="cn-sheet-warn">
      <Tag tone={tone}>{p.ok === null ? 'outcome unknown' : p.ok ? 'done' : 'it did not run'}</Tag>{' '}
      <span className="cn-sub">
        {p.detail ?? 'The command said nothing.'} ({since(p.finishedAt)})
      </span>
    </span>
  );
}

function since(at: string): string {
  const ms = Math.max(0, Date.now() - Date.parse(at));
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${String(mins)} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
}

/**
 * Said in words beside the control and again in its tooltip, because a reseed runs the project's own
 * destructive command against a live deployment and there is nothing to undo it with. Only an
 * environment that declares a `reseed` gets this — `ensureTenant` alone provisions and destroys
 * nothing. → docs/spec/36-remote-validation.md#reseeding-is-destructive-and-the-gate-says-so
 */
function reseedWarning(tenant: RemoteTenantView): string {
  const who = tenant.tenant === null ? 'this environment’s tenant' : tenant.tenant;
  return `Reseeding runs this environment’s own reseed command against ${who}, which wipes everything in it back to seeded fixture data — uploads, records and anything else a run or a person left there. It cannot be undone from here.`;
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
        {/* The screen itself, on the row that actually holds it. A run that declined to overwrite a
            check somebody else settled keeps its reading here — and the screen with it — so drawing
            it only on the check row left the image reachable nowhere but the harness's own disk,
            which defeats the whole point of a capture outliving its run.
            → docs/spec/36-remote-validation.md#where-a-sheet-kept-capture-is-looked-at */}
        {row.reading?.captureUrl != null && (
          <div className="cn-sig-cap">
            <a href={row.reading.captureUrl} target="_blank" rel="noreferrer" title="Open the full capture">
              <img src={row.reading.captureUrl} alt={`The screen captured for “${row.title}”`} />
            </a>
          </div>
        )}
        <Measured row={row} controls={controls} />
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

/**
 * What a browser row is worth reading afterwards: how much of what the pre-flight matched actually
 * ran, what it cost in retries and minutes, and the report somebody can click into.
 *
 * **`matched` is the pre-flight's own count**, off the row, and never derived from the report — that
 * is the shape that makes a selector matching nothing read as a clean pass. The artefact is drawn as
 * a link and never as a button: it leaves the cockpit, and the gap between a red row understood in
 * thirty seconds and one reproduced by hand is the whole reason the publish command exists.
 *
 * The agent's transcript is the other half of that, and it is here for the reading an **agent**
 * produced most of all: a row a reviewed suite answered is backed by code in the repository, and a row
 * the fleet drove at a browser is backed by nothing but what the agent did, so the record of what it
 * did is the evidence. → docs/spec/36-remote-validation.md#the-reading-an-agent-produced
 */
function Measured({ row, controls }: { row: RemoteSheetRowView; controls: SheetControls }): JSX.Element | null {
  const reading = row.reading;
  const artefacts = reading?.artefacts ?? null;
  const agentId = reading?.agentId ?? null;
  const parts: string[] = [];
  if (row.matched !== null)
    parts.push(
      reading?.executed === null || reading?.executed === undefined
        ? `${String(row.matched)} matched`
        : `${String(reading.executed)} of ${String(row.matched)} run`,
    );
  if (reading?.retries !== null && reading?.retries !== undefined && reading.retries > 0)
    parts.push(`${String(reading.retries)} ${reading.retries === 1 ? 'retry' : 'retries'}`);
  if (reading?.durationMs !== null && reading?.durationMs !== undefined) parts.push(clock(reading.durationMs));
  if (parts.length === 0 && artefacts === null && agentId === null) return null;
  return (
    <div className="cn-sig-add">
      {parts.length > 0 && <span className="cn-sub">{parts.join(' · ')}</span>}
      {(artefacts !== null || agentId !== null) && (
        <span className="cn-refs">
          {artefacts !== null && (
            <ExtLink href={artefacts} title="The runner’s own report for this run — traces, screenshots and video">
              the run’s report ↗
            </ExtLink>
          )}
          {agentId !== null && (
            <button
              type="button"
              className="cn-openagent"
              title="Open the agent that ran this row — everything it did, and what it cost"
              onClick={() => controls.onOpenAgent(agentId)}
            >
              the agent that ran it ↗
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function clock(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${String(seconds)}s`;
  return `${String(Math.round(seconds / 60))}m`;
}

function said(row: RemoteSheetRowView): string {
  if (row.blockedReason !== null) return `Nothing was learned here — ${row.blockedReason}`;
  const reading: RemoteReadingView | null = row.reading;
  if (reading === null) {
    // The server's own sentence, drawn as it was folded. A row nothing will run reads as one nobody
    // has got to yet unless it says why, which is the quietest way for a check to be lost.
    if (row.idleReason !== null) return `Nothing here will be run — ${row.idleReason}`;
    return row.kind === 'check'
      ? 'Nothing has run this. A check is yours to run, and its result is recorded on the goal’s own validation row.'
      : 'Nothing has been read on this row yet.';
  }
  if (reading.detail !== null) return reading.detail;
  if (reading.outcome === 'captured')
    return `${row.environment} handed a screen back on this row, and it is waiting for somebody to look at it.`;
  return reading.outcome === 'passed'
    ? `${row.environment} answered what this row declared.`
    : `${row.environment} did not answer what this row declared.`;
}
