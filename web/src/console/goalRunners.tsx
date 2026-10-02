import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView } from '../view/goalPage.js';
import type { Agent, Issue } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Icon } from '../components/icons.js';
import { CONTROL_CLASS } from '../components/controls.js';
import {
  pressableRows,
  remoteRunGaps,
  tenantAlerts,
  type RemoteRunGap,
  type TenantAlert,
} from '../view/validatePane.js';
import { SignalsSection } from '../components/SignalsSection.js';
import { SheetOkRow } from './sheetOk.js';
import { RemoteValidationSection, ReseedControl } from '../components/RemoteValidationSection.js';
import { ValidateLocallyModal } from '../components/ValidateLocallyModal.js';
import { LocalValidationReport } from './LocalValidationReport.js';
import {
  inFlight,
  localValidationOffer,
  localValidationSaid,
  STATUS_WORD,
  validateLocallyQuestion,
} from '../view/localValidation.js';
import { Disclosure, type Fold } from './goalFold.js';
import { BareButton } from '../components/button.js';

export const LIVE_AGENT = new Set<Agent['status']>(['starting', 'running', 'waiting']);

// → docs/spec/17-cockpit.md

const LOCAL_VALIDATION_ANCHOR = 'cn-local-validation';

export function LocalValidation({
  page,
  view,
  actions,
  fold,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  fold: Fold;
}): JSX.Element {
  const { issue } = page;
  const validation = issue.localValidation;
  const liveAgents = new Set(page.agents.filter((a) => LIVE_AGENT.has(a.agent.status)).map((a) => a.agent.id));

  return (
    <section className="cn-card" id={LOCAL_VALIDATION_ANCHOR}>
      <h3>
        <Disclosure subject="local-run" open={fold.open} onToggle={fold.onToggle} label="Runs on your machine" />
        <i className="cn-n">
          {validation === null
            ? 'never run'
            : inFlight(validation)
              ? localValidationSaid(validation)
              : STATUS_WORD[validation.status]}
        </i>
        {/* What tells this apart from the check set above it: that one is the set, this is an
            agent's run at the machine in front of them — and what it does not do, which is answer
            any of them. → docs/spec/32-local-validation.md */}
        <span className="cn-more">
          one agent, in your own dev environment — it writes no reading on the checks above
        </span>
      </h3>
      {fold.open && (
        <div className="cn-vin">
          {/* The press is on the strip at the top of the pane, with every other runner's: a run is
              started in one place and read in another, and this panel is the reading.
              → docs/spec/17-cockpit.md#the-validate-pane */}
          <LocalValidationReport
            validation={validation}
            why={null}
            issueNumber={issue.number}
            liveAgents={liveAgents}
            refUrls={view.state.refUrls}
            now={view.now}
            actions={actions}
          />
        </div>
      )}
    </section>
  );
}

/**
 * Every runner that could take a check on this goal, on one line each, above the list they answer.
 * **The one place a run is started.** The panels below read what a run did; a press offered in both
 * places is two controls for one act, and the question an operator arrives with — *is there a run
 * that would answer some of this, before I start answering by hand* — is asked before the list
 * rather than under it. → docs/spec/17-cockpit.md#the-validate-pane
 */
export function RunStrip({
  page,
  view,
  actions,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element | null {
  const { issue } = page;
  const run = view.state.localRun;
  const target = view.state.localRunTargets.find((t) => t.issueNumber === issue.number);
  const offer = localValidationOffer(issue, target, view.state.config.localRunConfigured);
  const [validating, setValidating] = useState<'swap' | 'refresh' | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const runTitle =
    run === null
      ? null
      : (view.state.world.issues.find((i) => `issue:${String(i.number)}` === run.originRef)?.title ?? null);
  /* The press asks first where a live run is on another goal or has fallen behind the branch: what
     it starts is the machine's *one* dev environment, so the question is which goal gets it.
     → docs/spec/23-local-runs.md */
  const gaps = remoteRunGaps(view.state.config.environments, page.remoteSheets, page.environments);
  const onValidate = async (): Promise<void> => {
    const question = validateLocallyQuestion(issue.number, run);
    if (question !== null) {
      setValidating(question);
      return;
    }
    setRefusal(null);
    await actions.validateLocally(issue.number);
  };
  return (
    <section className="cn-runstrip">
      <LocalRunRow issue={issue} offer={offer} onValidate={onValidate} onRefused={setRefusal} />
      {/* One line per environment with a page: where it stands, and the one answer it asks for.
          → docs/spec/36-remote-validation.md#the-ok */}
      {page.remoteSheets.map((sheet) => (
        <SheetOkRow
          key={sheet.environment}
          sheet={sheet}
          issueNumber={issue.number}
          actions={actions}
          onRefused={setRefusal}
        />
      ))}
      {gaps.map((gap) => (
        <GapRow
          key={gap.environment ?? ''}
          gap={gap}
          onSetUp={(environment) => actions.setUpRemoteSheet(issue.number, environment)}
          onRefused={setRefusal}
        />
      ))}
      {refusal !== null && (
        <p className="launch-error" role="alert">
          {refusal}
        </p>
      )}
      {validating !== null && run !== null && (
        <ValidateLocallyModal
          mode={validating}
          issueNumber={issue.number}
          issueTitle={issue.title}
          targetRef={target?.target.ref ?? null}
          run={run}
          runTitle={runTitle}
          onSubmit={(opts) => actions.validateLocally(issue.number, opts)}
          onClose={() => setValidating(null)}
        />
      )}
    </section>
  );
}

function LocalRunRow({
  issue,
  offer,
  onValidate,
  onRefused,
}: {
  issue: Issue;
  offer: ReturnType<typeof localValidationOffer>;
  onValidate: () => Promise<void>;
  onRefused: (reason: string) => void;
}): JSX.Element {
  const flight = inFlight(issue.localValidation) ? issue.localValidation : null;
  return (
    <div className="cn-runstrip-row">
      <span className="cn-runstrip-who">your machine</span>
      {flight !== null ? (
        <span className="cn-sub">{localValidationSaid(flight)} — the panel below follows it</span>
      ) : offer.offered ? (
        <>
          <AsyncButton
            usage="validation.create"
            className={`${CONTROL_CLASS} primary`}
            onClick={onValidate}
            onRefused={onRefused}
            pendingLabel={
              <>
                <Icon name="flask" />
                Starting…
              </>
            }
            title="Bring this goal's code up in your dev environment and send one agent to write a test plan, drive the running application through it, and report here. Asks first if something else is running."
          >
            <Icon name="flask" />
            {issue.localValidation === null ? 'Run it here' : 'Run it here again'}
          </AsyncButton>
          <span className="cn-sub">an exploratory run against work in flight — it answers no check</span>
        </>
      ) : (
        <span className="cn-sub">{offer.why}</span>
      )}
    </div>
  );
}

function GapRow({
  gap,
  onSetUp,
  onRefused,
}: {
  gap: RemoteRunGap;
  onSetUp: (environment: string) => Promise<void>;
  onRefused: (reason: string) => void;
}): JSX.Element {
  const { environment } = gap;
  return (
    <div className="cn-runstrip-row">
      <span className="cn-runstrip-who">{environment ?? 'remote'}</span>
      {gap.setUp === true && environment !== null && (
        <AsyncButton
          usage="validation.create"
          className={CONTROL_CLASS}
          onClick={() => onSetUp(environment)}
          onRefused={onRefused}
          title={`Set up the run on ${environment} that was not set up automatically, from this goal's accepted checks`}
        >
          Set up a run
        </AsyncButton>
      )}
      <span className="cn-sub">{gap.why}</span>
    </div>
  );
}

/**
 * An environment whose tenant would make any reading on it untrustworthy, said once at the top of the
 * pane with the control that fixes it. It used to be a line in the run strip and a red outcome at the
 * foot of the page, below the checks it was quietly undermining — read last, when it should decide
 * whether anything below is worth reading. → docs/spec/17-cockpit.md#the-validate-pane
 */
export function TenantBanner({
  page,
  showing,
  actions,
}: {
  page: GoalPageView;
  showing: string | null;
  actions: CockpitActions;
}): JSX.Element | null {
  const alerts = tenantAlerts(page.remoteSheets, showing);
  if (alerts.length === 0) return null;
  return (
    <>
      {alerts.map((alert) => {
        const sheet = page.remoteSheets.find((s) => s.environment === alert.environment);
        return (
          <section key={alert.environment} className="cn-tenant-alert" role="alert">
            <Icon name="alert" />
            <div className="cn-tenant-alert-body">
              <b>{alertHeadline(alert)}</b>
              <span className="cn-sub">{alertConsequence(alert)}</span>
            </div>
            {sheet !== undefined && (
              <ReseedControl
                tenant={sheet.tenant}
                onReseed={() => actions.reseedRemoteTenant(page.issue.number, alert.environment)}
              />
            )}
          </section>
        );
      })}
    </>
  );
}

function alertHeadline(alert: TenantAlert): string {
  const who = alert.tenant === null ? `${alert.environment}'s tenant` : `${alert.environment} · ${alert.tenant}`;
  if (alert.why === 'blocked') return `${who} can't be used`;
  if (alert.why === 'failed') return `${who} — its last reseed failed`;
  return `${who} — its test data is past ${alert.environment}'s freshness window`;
}

function alertConsequence(alert: TenantAlert): string {
  if (alert.why === 'blocked') return alert.detail ?? 'Nothing on this environment can be put to it.';
  const tail = `A failure on ${alert.environment} may be leftovers from earlier runs rather than this goal's work — reseed first, then run.`;
  return alert.why === 'failed' && alert.detail !== null ? `${alert.detail} ${tail}` : tail;
}

export function Signals({
  page,
  actions,
  refUrls,
  fold,
}: {
  page: GoalPageView;
  actions: CockpitActions;
  refUrls: Record<string, string>;
  fold: Fold;
}): JSX.Element | null {
  const { issue, signals, plan } = page;
  if (signals.length === 0 && plan === null) return null;
  const pending = signals.filter((c) => !c.live).length;
  return (
    <section className="cn-card" id="cn-signals">
      <h3>
        <Disclosure subject="watch" open={fold.open} onToggle={fold.onToggle} label="Signals" />
        <i className="cn-n">
          {signals.length === 1 ? '1 reading' : `${signals.length} readings`}
          {pending > 0 && ` · ${pending} awaiting you`}
        </i>
        <span className="cn-more">
          asked of a live environment after this ships
          {plan !== null && (
            <BareButton
              usage={{ counted: 'plan.view' }}
              className="cn-linkish"
              onClick={() => actions.viewPlan(plan.id)}
            >
              see the plan ↗
            </BareButton>
          )}
        </span>
      </h3>
      {fold.open && (
        <SignalsSection
          signals={signals}
          refUrls={refUrls}
          onSave={(check) => actions.saveWatchCheck(issue.number, check)}
          onDelete={(checkId) => actions.deleteWatchCheck(issue.number, checkId)}
          onRule={(checkId, accept) => actions.ruleWatchProposal(issue.number, checkId, accept)}
        />
      )}
    </section>
  );
}

/** Always drawn: with no sheet to show, it says why in place of the rows. → 17-cockpit.md#the-validate-pane */
export function RemoteValidation({
  page,
  view,
  actions,
  fold,
}: {
  page: GoalPageView;
  view: CockpitView;
  actions: CockpitActions;
  fold: Fold;
}): JSX.Element {
  const sheets = page.remoteSheets;
  const showing = view.sheetEnvironment;
  /* The pane above picks the environment, so a pick with no sheet draws no sheet — falling
     back to the first would put another environment's rows under this one's heading. */
  const open = showing === null ? sheets[0] : sheets.find((s) => s.environment === showing);
  if (open === undefined) {
    const gaps = remoteRunGaps(view.state.config.environments, sheets, page.environments, showing);
    return (
      <section className="cn-card" id="cn-remote-validation">
        <h3>
          <span>{showing === null ? 'Runs remotely' : `Runs on ${showing}`}</span>
          <i className="cn-n">no run offered</i>
        </h3>
        {gaps.map((gap) => (
          <p key={gap.environment ?? ''} className="cn-sub">
            {gap.environment !== null && showing === null && <b>{gap.environment}: </b>}
            {gap.why}
          </p>
        ))}
      </section>
    );
  }
  const waiting = open.rows.filter((r) => r.awaitingApproval).length;
  /* The same count the gate's own button carries, said on the header so an operator scanning the
     pane knows a press is waiting without opening it. → docs/spec/36-remote-validation.md */
  const pressable = pressableRows(open);
  return (
    <section className="cn-card" id="cn-remote-validation">
      <h3>
        <Disclosure
          subject="validation"
          open={fold.open}
          onToggle={fold.onToggle}
          label={`Runs on ${open.environment}`}
        />
        <i className="cn-n">
          {pressable === 1 ? '1 row a press would read' : `${pressable} rows a press would read`}
          {waiting > 0 && ` · ${waiting} waiting on an approval`}
        </i>
        <span className="cn-more">where this goal&rsquo;s work has arrived</span>
      </h3>
      {fold.open && (
        <RemoteValidationSection
          sheets={sheets}
          showing={showing}
          switcher={false}
          foldRows
          press={false}
          alertAbove
          onShow={(environment) => actions.openRemoteSheet(environment)}
          controls={{
            onRule: (environment, rowId, accept) =>
              actions.ruleRemoteQuery(page.issue.number, environment, rowId, accept),
            onSelect: (environment, rowId, selected) =>
              actions.selectRemoteRow(page.issue.number, environment, rowId, selected),
            onPress: (environment) => actions.pressRemoteSheet(page.issue.number, environment),
            onCancel: (environment) => actions.cancelRemoteRun(page.issue.number, environment),
            onReseed: (environment) => actions.reseedRemoteTenant(page.issue.number, environment),
            onOpenAgent: (agentId) => actions.select(agentId),
          }}
        />
      )}
    </section>
  );
}
