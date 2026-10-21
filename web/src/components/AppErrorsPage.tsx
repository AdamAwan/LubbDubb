import type { JSX } from 'react';
import type { AppErrorBandView, AppErrorEnvironmentView, AppErrorsPayload } from '../types.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { ErrorsShow, ErrorsSort } from '../cockpit/place.js';
import type { CockpitView } from '../view/viewModel.js';
import {
  bandLabel,
  bandMembers,
  bandRows,
  filteredRows,
  HOW_SAID,
  isMoved,
  perDay,
  pickBand,
  shownRows,
  sortedRows,
  stateCounts,
  type ErrorLink,
  type ErrorReading,
  type ErrorRow,
  type ErrorState,
  type StateCounts,
} from '../view/appErrors.js';
import { AppErrorDetailFold } from './AppErrorDetail.js';
import { AppErrorFilters, SortHead } from './AppErrorsFilters.js';
import { TrackerCell } from './AppErrorsTracker.js';
import { BareButton, Button } from './button.js';
import { Ref } from './refs.js';
import { Tag, type TagTone } from './tag.js';
import { ExtLink, relTime } from './util.js';
import { useAppErrors } from './useAppErrors.js';

// → docs/spec/39-app-errors.md#in-the-cockpit

const STATE_TONE: Record<ErrorState, TagTone> = {
  new: 'red',
  spiking: 'amber',
  returned: 'violet',
  steady: 'grey',
  gone: 'green',
};

/** How many of the fortnight's days at the end are drawn in the state's own hue. */
const RECENT_DAYS = 3;

export function AppErrorsPage({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { reading, failed, reload } = useAppErrors();
  if (failed && reading === null) {
    return <p className="empty">The app errors could not be read. The rest of the cockpit is unaffected.</p>;
  }
  if (reading === null) return <p className="empty">Reading app errors…</p>;
  return (
    <AppErrorsView
      payload={reading}
      band={view.errorsBand}
      steady={view.errorsSteady}
      sort={view.errorsSort}
      show={view.errorsShow}
      text={view.errorsText}
      now={view.now}
      actions={actions}
      onPressed={reload}
    />
  );
}

/** @public the seam the page is rendered through in `test/appErrorsCockpit.test.ts` */
export function AppErrorsView({
  payload,
  band,
  steady,
  sort,
  show,
  text,
  now,
  actions,
  onPressed = () => {},
}: {
  payload: AppErrorsPayload;
  band: string | null;
  steady: boolean;
  sort: ErrorsSort;
  show: ErrorsShow;
  text: string | null;
  now: number;
  actions: CockpitActions;
  /** Called once a tracker press lands, so the row redraws from what the route recorded. */
  onPressed?: () => void;
}): JSX.Element {
  const picked = pickBand(payload, band);
  if (picked === null) {
    return (
      <div className="ae">
        <Head />
        <p className="empty">
          No environment declares an <code>errors</code> block, so nothing is read. Add{' '}
          <code>{'"errors": { "list": "…{since}" }'}</code> to an environment and restart.
        </p>
      </div>
    );
  }
  const rows = bandRows(payload, picked);
  const shown = shownRows(rows, steady);
  return (
    <div className="ae">
      <Head />
      <BandTabs payload={payload} picked={picked} actions={actions} />
      <Readings members={bandMembers(payload, picked)} project={payload.project} now={now} />
      <Counts counts={stateCounts(rows)} steady={steady} actions={actions} />
      <AppErrorFilters key={text ?? ''} show={show} text={text} actions={actions} />
      <ErrorTable
        rows={sortedRows(filteredRows(shown, show, text), sort)}
        narrowed={shown.length > 0 && (show !== 'all' || text !== null)}
        sort={sort}
        multi={picked.environments.length > 1}
        now={now}
        actions={actions}
        onPressed={onPressed}
      />
    </div>
  );
}

function Head(): JSX.Element {
  return (
    <header className="ae-head">
      <h2>Errors</h2>
      <p className="ae-blurb">
        What each environment’s own telemetry reports, grouped by fingerprint and drawn by what moved: new since the
        deploy, back after a quiet spell, or running well above its baseline. Steady noise and errors that have stopped
        are folded away.
      </p>
    </header>
  );
}

function BandTabs({
  payload,
  picked,
  actions,
}: {
  payload: AppErrorsPayload;
  picked: AppErrorBandView;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <div className="insights-tabs" role="tablist" aria-label="Environments">
      {payload.bands.map((b) => {
        const moved = b.groups.filter((g) => isMoved(g.state)).length;
        const on = b.band === picked.band;
        return (
          <BareButton
            usage="app-error.filter"
            logs={!on}
            key={b.band}
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            className={on ? 'on' : ''}
            onClick={() => actions.openErrors({ errorsBand: b.band })}
          >
            {bandLabel(b)}
            {moved > 0 && <i className="ae-moved">{moved}</i>}
            {b.status === 'unknown' && (
              <Tag tone="amber" lower>
                unknown
              </Tag>
            )}
          </BareButton>
        );
      })}
    </div>
  );
}

function Readings({
  members,
  project,
  now,
}: {
  members: AppErrorEnvironmentView[];
  project: string;
  now: number;
}): JSX.Element {
  return (
    <div className="ae-cards">
      <section className="cn-card ae-card">
        <h3>Deploy window</h3>
        {members.map((m) => (
          <DeployLine key={m.environment} env={m.environment} head={m.head} multi={members.length > 1} now={now} />
        ))}
      </section>
      <section className="cn-card ae-card">
        <h3>Last read</h3>
        {members.map((m) => (
          <ReadLine key={m.environment} env={m.environment} reading={m.reading} multi={members.length > 1} now={now} />
        ))}
      </section>
      <section className="cn-card ae-card">
        <h3>Project</h3>
        <p className="ae-line">
          <code>{project}</code>
        </p>
        <p className="ae-note">The middle of every key, so every fleet on this project names a fault the same way.</p>
      </section>
    </div>
  );
}

function DeployLine({
  env,
  head,
  multi,
  now,
}: {
  env: string;
  head: AppErrorEnvironmentView['head'];
  multi: boolean;
  now: number;
}): JSX.Element {
  return (
    <p className="ae-line">
      {multi && <b>{env} </b>}
      {head === null ? (
        <span className="ae-note">no deployed commit read yet</span>
      ) : (
        <>
          {head.previousSha !== null && <code>{short(head.previousSha)} → </code>}
          <code>{short(head.sha)}</code>
          <span className="ae-note">
            {head.changedAt !== null
              ? ` · noticed ${relTime(head.changedAt, now)}`
              : ' · the first build read, so no deploy time — new means the last day'}
          </span>
        </>
      )}
    </p>
  );
}

function ReadLine({
  env,
  reading,
  multi,
  now,
}: {
  env: string;
  reading: ErrorReading | null;
  multi: boolean;
  now: number;
}): JSX.Element {
  if (reading === null) {
    return (
      <p className="ae-line">
        {multi && <b>{env} </b>}
        <Tag lower>not read</Tag> <span className="ae-note">nothing has been read here yet</span>
      </p>
    );
  }
  return (
    <div className="ae-line">
      {multi && <b>{env} </b>}
      <Tag tone={reading.status === 'ok' ? 'green' : 'amber'} fill={reading.status === 'unknown'} lower>
        {reading.status}
      </Tag>{' '}
      {relTime(reading.readAt, now)}
      {reading.status === 'unknown' && (
        <p className="ae-warn">
          Could not read the errors here — this is not “no errors”.
          {reading.okAt !== null && ` Last answered ${relTime(reading.okAt, now)}.`}
        </p>
      )}
      {reading.detail !== null && <p className="ae-note">{reading.detail}</p>}
    </div>
  );
}

function Counts({
  counts,
  steady,
  actions,
}: {
  counts: StateCounts;
  steady: boolean;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <div className="ae-strip">
      <Tag tone={STATE_TONE.new} fill={counts.new > 0}>
        {counts.new} new
      </Tag>
      <Tag tone={STATE_TONE.spiking} fill={counts.spiking > 0}>
        {counts.spiking} spiking
      </Tag>
      <Tag tone={STATE_TONE.returned} fill={counts.returned > 0}>
        {counts.returned} returned
      </Tag>
      <span className="ae-folded">
        {counts.steady} steady, {counts.gone} gone{steady ? '' : ' (hidden)'}
      </span>
      <Button
        ghost
        size="small"
        usage="app-error.filter"
        aria-pressed={steady}
        onClick={() => actions.openErrors({ errorsSteady: !steady })}
      >
        {steady ? 'Hide steady and gone' : 'Show steady and gone'}
      </Button>
    </div>
  );
}

function ErrorTable({
  rows,
  narrowed,
  sort,
  multi,
  now,
  actions,
  onPressed,
}: {
  rows: ErrorRow[];
  narrowed: boolean;
  sort: ErrorsSort;
  multi: boolean;
  now: number;
  actions: CockpitActions;
  onPressed: () => void;
}): JSX.Element {
  if (rows.length === 0) {
    return <p className="empty">{narrowed ? 'Nothing here matches the filter.' : 'Nothing has moved here.'}</p>;
  }
  const head = { sort, actions };
  return (
    <div className="ae-scroll">
      <table className="ae-tbl">
        <thead>
          <tr>
            <SortHead by="state" {...head}>
              State
            </SortHead>
            <th>Error</th>
            <SortHead by="first" {...head}>
              First seen
            </SortHead>
            <SortHead by="last" {...head}>
              Last seen
            </SortHead>
            <th>14 days</th>
            <SortHead by="count" className="ae-n" {...head}>
              Count
            </SortHead>
            <th>Linked to</th>
            <th>Tracker</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ErrorTableRow key={row.key} row={row} multi={multi} now={now} onPressed={onPressed} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorTableRow({
  row,
  multi,
  now,
  onPressed,
}: {
  row: ErrorRow;
  multi: boolean;
  now: number;
  onPressed: () => void;
}): JSX.Element {
  return (
    <tr className={isMoved(row.state) ? '' : 'ae-quiet'}>
      <td>
        <Tag tone={STATE_TONE[row.state]} fill={isMoved(row.state)} lower>
          {row.state}
        </Tag>
        {row.state === 'spiking' && row.spike !== null && (
          <span className="ae-rate">
            {perDay(row.spike.perDay)}/day vs {perDay(row.spike.baselinePerDay)} usual
            {multi && ` on ${row.environment}`}
          </span>
        )}
      </td>
      <td className="ae-title">
        <b>{row.title}</b>
        <span className="ae-meta">
          <code>{row.key}</code>
          {row.operation !== null && <span>{row.operation}</span>}
          {row.frames[0] !== undefined && <code className="ae-frame">{row.frames[0]}</code>}
          {multi && <span>on {row.environments.join(', ')}</span>}
          {row.url !== null && <ExtLink href={row.url}>Open in telemetry</ExtLink>}
        </span>
        <AppErrorDetailFold row={row} />
      </td>
      <td className="ae-when">{relTime(row.firstSeen, now)}</td>
      <td className="ae-when">{relTime(row.lastSeen, now)}</td>
      <td>
        <Spark daily={row.daily} state={row.state} />
      </td>
      <td className="ae-n">{row.count}</td>
      <td>
        <LinkCell link={row.link} />
      </td>
      <td>
        <TrackerCell row={row} onPressed={onPressed} />
      </td>
    </tr>
  );
}

function Spark({ daily, state }: { daily: number[]; state: ErrorState }): JSX.Element {
  const top = Math.max(1, ...daily);
  return (
    <span className="ae-spark" title={`${daily.join(', ')} a day over the last ${daily.length} days`}>
      {daily.map((count, i) => (
        <i
          key={i}
          className={i >= daily.length - RECENT_DAYS ? `ae-bar ae-${state}` : 'ae-bar'}
          style={{ height: `${Math.max(count === 0 ? 0 : 8, Math.round((count / top) * 100))}%` }}
        />
      ))}
    </span>
  );
}

function LinkCell({ link }: { link: ErrorLink | null }): JSX.Element {
  if (link === null) return <span className="ae-none">—</span>;
  const refs = link.goalRef === null ? link.tied : [link.goalRef];
  const candidates = link.candidates === null ? 'unknown' : String(link.candidates);
  return (
    <div className="ae-link" title={`${link.why} (candidates: ${candidates})`}>
      {link.goalRef === null && (
        <Tag tone="grey" lower>
          no link
        </Tag>
      )}
      {refs.length > 0 && (
        <span className="cn-refs">
          {refs.map((goalRef) => (
            <Ref key={goalRef} to={goalRef} />
          ))}
        </span>
      )}
      {link.how.map((how) => (
        <Tag key={how} tone="grey" lower>
          {HOW_SAID[how]}
        </Tag>
      ))}
      {link.goalRef === null && (
        <span className="ae-note">
          {link.why} (candidates: {candidates})
        </span>
      )}
    </div>
  );
}

function short(sha: string): string {
  return sha
    .split(' ')
    .map((s) => s.slice(0, 7))
    .join(' ');
}
