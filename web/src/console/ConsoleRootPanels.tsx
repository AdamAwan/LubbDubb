import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions, ConsolePanel } from '../cockpit/actions.js';
import type { NeedRow } from '../view/needsYou.js';
import { KIND_LABEL, KIND_SYMBOL, KIND_TONE, holdingLabel, subjectLabel } from './QueueRail.js';
import { needBody } from './NeedsBand.js';
import { openGoalForAsk } from './jump.js';
import { queueRow } from './Overview.js';
import { projectName } from '../view/updateAsks.js';
import { WorldSignals } from './WorldSignals.js';
import { EnvironmentsPanel } from './EnvironmentsPanel.js';
import { PanelRows } from './PanelRow.js';
import { RecordPanel } from '../components/RecordPanel.js';
import { LaunchPanel } from '../components/LaunchPanel.js';
import { SetupPanel } from '../components/SetupPanel.js';
import { BuildPanel } from '../components/BuildPanel.js';
import { LocalRunPanel } from '../components/LocalRunPanel.js';
import { TenantCommandsPanel } from '../components/TenantCommandsPanel.js';
import { SchedulePanel } from '../components/SchedulePanel.js';
import { InjectPanel } from '../components/InjectPanel.js';
import { ConfirmButton } from '../components/ConfirmButton.js';
import { Modal } from '../components/Modal.js';
import { Button, ButtonRow } from '../components/button.js';
import { relTime } from '../components/util.js';
import { Ref } from '../components/refs.js';

// → docs/spec/17-cockpit.md

const PANEL_TITLE: Record<Exclude<ConsolePanel, null | { ask: string }>, string> = {
  faults: 'Faults',
  launch: 'Launch',
  build: 'Build',
  localRun: 'Running locally',
  tenants: 'Tenant commands',
  setup: 'Setup',
  record: 'The record',
  upnext: 'Up next',
  signals: 'World signals',
  environments: 'Environments',
};

function PanelShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Modal face="panel" label={title} onClose={onClose}>
      <header className="cn-panel-head">
        <h2>{title}</h2>
        <Button onClick={onClose}>Close</Button>
      </header>
      {children}
    </Modal>
  );
}

export function renderPanel(view: CockpitView, actions: CockpitActions): JSX.Element | null {
  const panel = view.consolePanel;
  if (panel === null) return null;
  const close = () => actions.openPanel(null);

  if (typeof panel === 'object') {
    const row = view.needsYou.find((r) => r.id === panel.ask);
    if (!row) return null;
    const body = needBody(row, view, actions);
    if (body === null) return null;
    return <AskShell row={row} view={view} actions={actions} onClose={close} body={body} />;
  }

  return (
    <PanelShell title={PANEL_TITLE[panel]} onClose={close}>
      <div className="cn-pbody">{panelBody(panel, view, actions)}</div>
    </PanelShell>
  );
}

/**
 * One ask, alone and in front.
 *
 * The head is chrome and says so: the kind, where the ask came from and how old
 * it is, in one line of small type. It was two stacked bars — a title spelling
 * `Needs you · Escalation` at the panel's largest size, and a subject line under
 * it — which spent the top of the surface, and all of its weight, on the category
 * the operator had just clicked. The ask's own sentence then arrived below them at
 * body size, indistinguishable from the evidence under it. What the panel is for
 * is that sentence, so the body leads with it at headline size and the head gives
 * way. → docs/spec/17-cockpit.md#the-queue-rail--needs-you
 */
function AskShell({
  row,
  view,
  actions,
  onClose,
  body,
}: {
  row: NeedRow;
  view: CockpitView;
  actions: CockpitActions;
  onClose: () => void;
  body: ReactNode;
}): JSX.Element {
  const age = [
    row.raisedAt === '' ? null : relTime(row.raisedAt, view.now),
    row.holding > 0 ? holdingLabel(row.holding) : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');
  return (
    <Modal
      face="panel"
      className={`cn-ask cn-t-${KIND_TONE[row.kind]}`}
      label={`Needs you · ${KIND_LABEL[row.kind]}`}
      onClose={onClose}
    >
      <header className="cn-panel-head cn-askhead">
        <h2>
          <span className="cn-sym" aria-hidden="true">
            {KIND_SYMBOL[row.kind]}
          </span>
          {KIND_LABEL[row.kind]}
        </h2>
        <AskSubject row={row} actions={actions} />
        {age !== '' && <span className="cn-askage">{age}</span>}
        <Button ghost size="small" onClick={onClose}>
          Close
        </Button>
      </header>
      <div className="cn-pbody cn-askbody">{body}</div>
    </Modal>
  );
}

function AskSubject({ row, actions }: { row: NeedRow; actions: CockpitActions }): JSX.Element {
  const subject = subjectLabel(row);
  if (row.goalRef !== null) {
    const ref = row.goalRef;
    const read = () => {
      actions.openPanel(null);
      openGoalForAsk(actions, ref, row.kind);
    };
    return (
      <span className="cn-psub">
        on{' '}
        <button type="button" className="cn-goto" onClick={read}>
          {subject} — read it in context →
        </button>
      </span>
    );
  }
  const pr = /^pr:(\d+)/.exec(row.originRef ?? '');
  return (
    <span className="cn-psub cn-noGoal">
      No linked goal ·{' '}
      {pr ? (
        <>
          raised on <Ref to={`pr:${pr[1]}`} />, a pull request no ticket owns
        </>
      ) : (
        'this ask stands on its own — nothing in the tracker is waiting on it'
      )}
    </span>
  );
}

function panelBody(
  panel: Exclude<ConsolePanel, null | { ask: string }>,
  view: CockpitView,
  actions: CockpitActions,
): ReactNode {
  const { state } = view;
  switch (panel) {
    case 'faults':
      return <FaultLog view={view} actions={actions} />;
    case 'upnext': {
      const items = view.upNext;
      if (items.length === 0) return <p className="cn-empty">Nothing is queued.</p>;
      return <PanelRows rows={items.map((item) => queueRow(item, view, actions))} />;
    }
    case 'signals':
      return <WorldSignals view={view} />;
    case 'environments':
      return <EnvironmentsPanel view={view} />;
    case 'localRun':
      return <LocalRunBody view={view} actions={actions} />;
    case 'tenants':
      return (
        <TenantCommandsPanel
          commands={state.tenantCommands}
          now={view.now}
          fetchOutput={(environment) => actions.tenantCommandOutput(environment)}
        />
      );
    case 'setup':
      return <SetupPanel onClose={() => actions.openPanel(null)} />;
    case 'record':
      return <RecordPanel now={view.now} />;
    case 'build':
      return (
        <BuildPanel
          build={state.build}
          project={projectName(state)}
          now={view.now}
          onUpgrade={(action, opts) => actions.upgrade(action, opts)}
          onCheck={() => actions.checkBuild()}
          onPull={() => actions.pullProject()}
        />
      );
    case 'launch':
      return <LaunchBody view={view} actions={actions} />;
  }
}

const FAULT_ROWS = 40;

function FaultLog({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { errors } = view.state;
  return (
    <>
      <ButtonRow>
        <ConfirmButton
          ghost
          label="Clear"
          confirmLabel="Delete every recorded fault?"
          title={`Delete all ${errors.length} recorded faults — this cannot be undone, for any cockpit`}
          onConfirm={() => actions.clearErrors()}
        />
      </ButtonRow>
      <div className="cn-rows">
        {errors.length === 0 && <p className="cn-empty">No fault has been recorded.</p>}
        {errors.slice(0, FAULT_ROWS).map((err) => (
          <div className="cn-row" key={err.id}>
            <i className="cn-lamp cn-wait" />
            <span className="cn-grow">
              <b className="cn-name">{err.source}</b>
              <span className="cn-sub cn-wrap">{err.message}</span>
              {err.detail !== null && <span className="cn-sub cn-wrap">{err.detail}</span>}
            </span>
            <span className="cn-num">{relTime(err.createdAt, view.now)}</span>
          </div>
        ))}
        {errors.length > FAULT_ROWS && <p className="cn-empty">…{errors.length - FAULT_ROWS} older</p>}
      </div>
    </>
  );
}

function LocalRunBody({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { state } = view;
  return (
    <LocalRunPanel
      run={state.localRun}
      configured={state.config.localRunConfigured}
      stopConfigured={state.config.localRunStopConfigured}
      refreshConfigured={state.config.localRunRefreshConfigured}
      goals={state.world.issues}
      targets={state.localRunTargets}
      now={view.now}
      onStart={(issueNumber, ref) => actions.startLocalRun(issueNumber, ref)}
      onStop={() => actions.stopLocalRun()}
      onMessage={(text) => actions.messageLocalRun(text)}
      onRefresh={() => actions.refreshLocalRun()}
      onValidate={(issueNumber, opts) => actions.validateLocally(issueNumber, opts)}
      validation={
        state.localRun === null
          ? null
          : (state.world.issues.find((i) => `issue:${String(i.number)}` === state.localRun?.originRef)
              ?.localValidation ?? null)
      }
      validationConfigured={state.config.localRunConfigured}
      fetchOutput={() => actions.localRunOutput()}
    />
  );
}

function LaunchBody({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const { state } = view;
  return (
    <>
      <LaunchPanel
        jobs={state.jobs}
        attachments={state.attachments}
        attachmentUrls={state.attachmentUrls}
        onChanged={() => void actions.refresh()}
      />
      <SchedulePanel schedules={state.schedules} onChanged={() => void actions.refresh()} />
      {/* Injection fakes a world change, which only the static demo has any
          use for: a real run against a fake provider is still a real run, and
          a panel that lies to the harness there is a way to lie to yourself
          about what it is reacting to. `view.demo` is the whole gate — there
          is no server route behind it for a second predicate to disagree
          with. */}
      {view.demo && <InjectPanel onInjected={() => void actions.refresh()} world={state.world} />}
    </>
  );
}
