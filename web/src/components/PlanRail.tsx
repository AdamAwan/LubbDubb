import type { PlanHistory } from '../types.js';
import { proofCounts } from './ProofBand.js';
import { logUsage } from '../cockpit/usage.js';
import type { Derived, PlanModalProps, SheetView } from './planModalShared.js';

export function PlanRail({
  checks,
  watches,
  queries,
  onRegroupView,
  live,
  decidable,
  caveats,
  ack,
  jump,
  regroupable,
  regroup,
  history,
  view,
  setView,
}: PlanModalProps &
  Derived & {
    jump: (key: string) => void;
    regroupable: boolean;
    regroup: boolean;
    history: PlanHistory | null;
    view: SheetView;
    setView: (view: SheetView) => void;
  }) {
  const liveChecks = checks.filter((c) => c.supersededReason === null);
  const settledChecks = liveChecks.filter((c) => c.state === 'passed' || c.state === 'waived').length;
  const held = ack.outstanding.length > 0;
  return (
    <div className="pm-rail">
      <button className="pm-jump" onClick={() => jump('verdict')}>
        Verdict
      </button>
      <button className="pm-jump" onClick={() => jump('proof')}>
        Proof{' '}
        <i className="k">
          {proofCounts(checks, live, watches, queries)
            .map((c) => c.count)
            .join(' · ')}
        </i>
      </button>
      {live.length > 0 && (
        <button className="pm-jump" onClick={() => jump('shape')}>
          The shape
        </button>
      )}
      <button className="pm-jump" onClick={() => jump('parts')}>
        Parts <i className="k">{live.length > 0 ? live.length : 'one PR'}</i>
      </button>
      <button className="pm-jump" onClick={() => jump('validation')}>
        Validation <i className="k">{liveChecks.length > 0 ? `${settledChecks}/${liveChecks.length}` : 'none'}</i>
      </button>
      {/* The one tab that can be asking for something. The checklist lives in the
          section below now, so an operator who reaches for a held Approve without
          having scrolled that far has nothing on the sheet telling them where the
          boxes are — the rail is where they are already looking, and the count is
          the way back. Amber while any box is outstanding, plain the moment the
          last one is ticked. */}
      <button className={`pm-jump${held ? ' waiting' : ''}`} onClick={() => jump('caveats')}>
        Caveats
        {decidable && caveats.length > 0 && (
          <i className="k">
            {caveats.length - ack.outstanding.length}/{caveats.length}
          </i>
        )}
      </button>
      <button className="pm-jump" onClick={() => jump('writeup')}>
        Write-up
      </button>
      <span className="spacer" />
      <ViewToggles
        onRegroupView={onRegroupView}
        regroupable={regroupable}
        regroup={regroup}
        history={history}
        view={view}
        setView={setView}
      />
    </div>
  );
}

function ViewToggles({
  onRegroupView,
  regroupable,
  regroup,
  history,
  view,
  setView,
}: {
  onRegroupView: ((on: boolean) => void) | undefined;
  regroupable: boolean;
  regroup: boolean;
  history: PlanHistory | null;
  view: SheetView;
  setView: (view: SheetView) => void;
}) {
  return (
    <>
      {/* A view, not a jump — a different document, so it reads as a different
            control. Absent until there is a second revision to be a change from,
            or a change waiting on the operator to be asked about. */}
      {regroupable && (
        <button
          className={`pm-jump history${regroup ? ' on' : ''}`}
          title="Move an atom from one part to another — the work is the same, the merge boundaries are not"
          onClick={() => onRegroupView?.(!regroup)}
        >
          {regroup ? 'Back to the plan' : 'Regroup'}
        </button>
      )}
      {history !== null && (history.revisions.length > 1 || history.pending !== null) && (
        <button
          className={`pm-jump history${view === 'history' ? ' on' : ''}${history.pending ? ' waiting' : ''}`}
          onClick={() => {
            if (view !== 'history') logUsage('plan.expand');
            setView(view === 'history' ? 'plan' : 'history');
          }}
        >
          {/* A change waiting on the operator outranks the history it would
                become: it is the one thing on this sheet that is asking them
                something, and it is why the control is offered at all on a plan
                with a single revision. */}
          {history.pending ? 'Change waiting' : history.diff === null ? 'History' : 'What changed'}{' '}
          <i className="k">v{history.revisions.length}</i>
        </button>
      )}
    </>
  );
}
