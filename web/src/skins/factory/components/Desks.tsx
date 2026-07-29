import type { JSX } from 'react';
import type { SkinProps } from '../../types.js';
import { ConfirmButton } from '../../../components/ConfirmButton.js';
import { EscalationCard } from '../../../components/EscalationCard.js';
import { InjectPanel } from '../../../components/InjectPanel.js';
import { LaunchPanel } from '../../../components/LaunchPanel.js';
import { relTime } from '../../../components/util.js';
import { Icon } from './Sprite.js';

/**
 * The three desks: what the operator is the blocker for.
 *
 * These were three panels standing in a permanent left-hand rail, and all three
 * are read as a *count* far more often than as contents — so the count is a gauge
 * in the status bar and the desk opens from it as a `Modal`. See
 * `docs/spec/2026-07-29-factory-two-rail-layout-design.md`.
 *
 * They are components rather than JSX inlined into `FactoryRoot` for the reason
 * `StatusBar` is: a `ConfirmButton`, a forty-row log and a demo gate are
 * *contents*, and `FactoryRoot`'s job is placement. It also leaves each one
 * renderable on its own, which is the only way `renderToStaticMarkup` can reach
 * a panel that is behind a click.
 *
 * Each takes `{ view, actions }` like `StatusBar`, so adding a reading to one
 * never grows a prop list.
 */

/**
 * The stamp desk — the *whole* inbox, not a summary of one.
 *
 * The alert bay this replaced was a summary sitting above the panel that listed
 * the same escalations in full, which is one reading in two places. Answering has
 * always happened on the shared `EscalationCard`, which owns the refusal rules
 * and the async flow; this is only where it is placed.
 */
export function StampDesk({ view, actions }: SkinProps): JSX.Element {
  const { state, now } = view;
  return (
    <div className="fx-body">
      {view.openEscalations.length === 0 && (
        <p className="fx-empty">Nothing needs your judgment. The line runs itself.</p>
      )}
      {view.openEscalations.map((e) => (
        <EscalationCard
          key={e.id}
          escalation={e}
          proposal={view.proposalFor.get(e.id)}
          resumedAt={e.agentId ? (view.agentById.get(e.agentId)?.resumedAt ?? null) : null}
          now={now}
          refUrls={state.refUrls}
          onAnswer={(text) => actions.answerEscalation(e.id, text)}
          onDecide={(id, verdict, note) => actions.decideProposal(id, verdict, note)}
          onPermission={(id, allow, note) => actions.decidePermission(id, allow, note)}
          onDismiss={(id, note) => actions.dismissEscalation(id, note)}
          onOpenAgent={(id) => actions.select(id)}
          onComplete={(id) => actions.completeAgent(id)}
          onViewPlan={(id) => actions.viewPlan(id)}
        />
      ))}
    </div>
  );
}

/** How many faults the log draws. A rail had room for eight; this is the surface
 *  you went looking for, so it is not cropped to a column's height. */
const FAULT_ROWS = 40;

/**
 * The fault log. Nothing in the harness reads these back, so it blocks nothing
 * and is never red — amber is the whole of its claim on your attention.
 */
export function FaultLog({ view, actions }: SkinProps): JSX.Element {
  const { state, now } = view;
  return (
    <>
      {/* Two-step, because the rows go: nothing in the harness reads the fault log
          back, so a clear costs nothing it decides on — but it costs the only
          copy, and for every cockpit rather than this one. Above the log rather
          than in the head beside Close: one misclick between "leave" and "delete
          the only copy" is too few. */}
      {state.errors.length > 0 && (
        <div className="fx-head-act fx-modal-bar">
          <ConfirmButton
            className="ghost small"
            label="clear"
            confirmLabel={`clear all ${state.errors.length}?`}
            title="Delete every recorded fault — this cannot be undone"
            onConfirm={() => actions.clearErrors()}
          />
        </div>
      )}
      <div className="fx-body">
        {state.errors.length === 0 && <p className="fx-empty">No faults recorded.</p>}
        {state.errors.slice(0, FAULT_ROWS).map((err) => (
          <article key={err.id} className="fx-bot fx-sunk idle">
            <div className="fx-bot-top">
              <Icon name="alert" />
              <span className="fx-job">{err.source}</span>
              <span className="fx-ref">{relTime(err.createdAt, now)}</span>
            </div>
            <p>{err.message}</p>
            {err.detail && <p className="fx-empty">{err.detail}</p>}
          </article>
        ))}
      </div>
    </>
  );
}

/**
 * The blueprint desk: stamp a job, and see what is queued behind it.
 *
 * Injection is a *demo* control, not a provider one — it fakes a world change,
 * which is only ever something the static Pages build needs. A real run against a
 * fake provider is still a real run, and a panel that lies to the harness there is
 * a way to lie to yourself about what it is reacting to. Hence `view.demo` and not
 * `config.injectable`.
 */
export function BlueprintDesk({ view, actions }: SkinProps): JSX.Element {
  return (
    <>
      <LaunchPanel jobs={view.state.jobs} onChanged={actions.refresh} />
      {view.demo && <InjectPanel onInjected={actions.refresh} world={view.state.world} />}
    </>
  );
}
