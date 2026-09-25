import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { GoalPageView } from '../view/goalPage.js';
import type { Agent, Issue } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Icon } from '../components/icons.js';
import { CONTROL_CLASS } from '../components/controls.js';
import { pressBreakdown, pressableRows } from '../view/validatePane.js';
import { SignalsSection } from '../components/SignalsSection.js';
import { RemoteValidationSection } from '../components/RemoteValidationSection.js';
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

const LIVE_AGENT = new Set<Agent['status']>(['starting', 'running', 'waiting']);

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
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Runs on your machine" />
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
      {/* One line per environment with a sheet, carrying the gate's own count so the strip never
          offers a run of rows a press would touch in no way at all. **Rows, not checks**: a sheet
          carries queries and measures beside its check rows, and a press re-reads the answered ones
          too — so the line says what a press does and, separately, how many checks are still
          unanswered there. → docs/spec/36-remote-validation.md#a-row-no-press-can-read */}
      {page.remoteSheets.map((sheet) => (
        <SheetRunRow
          key={sheet.environment}
          sheet={sheet}
          issueNumber={issue.number}
          actions={actions}
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

function SheetRunRow({
  sheet,
  issueNumber,
  actions,
  onRefused,
}: {
  sheet: GoalPageView['remoteSheets'][number];
  issueNumber: number;
  actions: CockpitActions;
  onRefused: (reason: string) => void;
}): JSX.Element {
  const rows = pressableRows(sheet);
  const made = pressBreakdown(sheet);
  const live = sheet.run !== null && (sheet.run.status === 'pending' || sheet.run.status === 'dispatched');
  return (
    <div className="cn-runstrip-row">
      <span className="cn-runstrip-who">{sheet.environment}</span>
      {live ? (
        <span className="cn-sub">a run is going — the panel below follows it</span>
      ) : (
        <>
          <AsyncButton
            className={`${CONTROL_CLASS} primary`}
            onClick={() => actions.pressRemoteSheet(issueNumber, sheet.environment)}
            onRefused={onRefused}
            title={`Re-read every selected row on this sheet against the commit ${sheet.environment} stands at right now — the ones already answered included`}
          >
            {rows === 1 ? 'Run 1 row' : `Run ${String(rows)} rows`}
          </AsyncButton>
          {/* What the number is made of, because it is bigger than the ticks below it: the
              sheet carries queries and measures that have no check to tick, and a press
              re-reads the checks already answered. */}
          <span className="cn-sub">
            {made.checks === 1 ? '1 check ticked below' : `${String(made.checks)} checks ticked below`}
            {made.own > 0 &&
              ` · ${String(made.own)} ${made.own === 1 ? 'query or measure' : 'queries and measures'} of its own`}
          </span>
          {/* What staleness means, where it can be acted on. A tenant accumulates the residue
              of every run that used it, so past the window the environment declares a red row
              may be that residue rather than the code — which is why the answer is to reseed
              first and press after. → docs/spec/36-remote-validation.md#tenants */}
          {sheet.tenant.stale && (
            <span className="cn-sub cn-runstrip-stale">
              Its test data is older than {sheet.environment} allows — reseed it below first, or a failure here may be
              leftovers from earlier runs rather than this goal&rsquo;s work.
            </span>
          )}
        </>
      )}
    </div>
  );
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
        <Disclosure open={fold.open} onToggle={fold.onToggle} label="Signals" />
        <i className="cn-n">
          {signals.length === 1 ? '1 reading' : `${signals.length} readings`}
          {pending > 0 && ` · ${pending} awaiting you`}
        </i>
        <span className="cn-more">
          asked of a live environment after this ships
          {plan !== null && (
            <button type="button" className="cn-linkish" onClick={() => actions.viewPlan(plan.id)}>
              see the plan ↗
            </button>
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

/**
 * Absent entirely where the goal has no sheet — and, on the server, where no environment declares a
 * `validate` block at all. Not an empty card and not a row of question marks: a deployment that has
 * not turned this on must not read as a deployment where it is broken.
 */
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
}): JSX.Element | null {
  const sheets = page.remoteSheets;
  if (sheets.length === 0) return null;
  const showing = view.sheetEnvironment;
  /* The pane above picks the environment, so a pick with no sheet draws no sheet — falling
     back to the first would put another environment's rows under this one's heading. */
  const open = showing === null ? sheets[0] : sheets.find((s) => s.environment === showing);
  if (open === undefined) return null;
  const waiting = open.rows.filter((r) => r.awaitingApproval).length;
  /* The same count the gate's own button carries, said on the header so an operator scanning the
     pane knows a press is waiting without opening it. → docs/spec/36-remote-validation.md */
  const pressable = pressableRows(open);
  return (
    <section className="cn-card" id="cn-remote-validation">
      <h3>
        <Disclosure open={fold.open} onToggle={fold.onToggle} label={`Runs on ${open.environment}`} />
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
