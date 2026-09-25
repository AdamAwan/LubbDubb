import { issueOriginNumber } from '../issueOrigins.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import { substituteBrowserArgs } from '../localValidation/policy.js';
import type { Store } from '../store/store.js';
import type { ExtraMcpServer, RemoteRun, RemoteRunBrief, RemoteSheetRow } from '../types.js';
import { handsBackAScreen, stepArea, stepDriven, stepScript } from '../validation/steps.js';
import {
  remoteValidationKey,
  remoteValidationOrigin,
  remoteValidationProfileDir,
  remoteValidationRunDir,
} from './origin.js';
import { briefing, type RunDrive, type RunScreen, type RunScript } from './remoteRunBriefingText.js';
import { resolveTenant, type TenantEnvironment } from './tenants.js';

// → docs/spec/36-remote-validation.md#the-dispatch--rule-remote-validation

interface BriefInput {
  store: Store;
  environments: readonly EnvironmentConfig[];
  validationRoot: string;
  /**
   * The deployment's browser MCP server — `localValidation.browser`, the one block, read by both
   * dispatches. Null is a real configuration: the brief says there is no browser, and a row that
   * needed one comes back `blocked`.
   */
  browser?: ExtraMcpServer | null;
  now?: () => number;
  /** Where a `tenantEnv`'s value is read from. Never folded into a brief — the *name* is. */
  env?: TenantEnvironment;
}

/**
 * Every live run, with everything the dispatcher needs already rendered. It is computed here rather
 * than in the rule for the reason [29](docs/spec/29-post-deploy-watch.md) computes its notes here:
 * `src/remoteValidation/` is a lens as far as the dispatcher is concerned, and the rule imports
 * nothing from it — what reaches it is a run row and a string.
 *
 * A run with no confirmed `check` row carries `confirmed: 0`, and the rule dispatches for none: the
 * press already read that sheet's deterministic rows synchronously, and there is no browser half to
 * put an agent on.
 */
export function remoteRunBriefs(input: BriefInput): RemoteRunBrief[] {
  const { store } = input;
  const runs = store.remoteValidation
    .listRemoteRuns()
    .filter((run) => run.status === 'pending' || run.status === 'dispatched');
  if (runs.length === 0) return [];
  const rows = store.remoteValidation.listRemoteSheetRows();
  const out: RemoteRunBrief[] = [];
  for (const run of runs) {
    const brief = runBrief(input, run, rows);
    if (brief !== null) out.push(brief);
  }
  return out;
}

function runBrief(input: BriefInput, run: RemoteRun, rows: readonly RemoteSheetRow[]): RemoteRunBrief | null {
  const { store } = input;
  const issueNumber = issueOriginNumber('root', run.goalRef);
  if (issueNumber === null) return null;
  const environment = input.environments.find((e) => e.name === run.environment);
  const browser = environment?.validate?.browser;
  if (environment === undefined || browser?.runner === undefined) return null;
  if (run.startedSha === null) return null;

  const confirmed = confirmedCheckRows(rows, run.goalRef, run.environment);
  const selectors = areasOf(store, run.goalRef, confirmed);
  const scripts = scriptsOf(store, run.goalRef, confirmed);
  const screens = screensOf(store, run.goalRef, confirmed);
  const drives = drivesOf(store, run.goalRef, confirmed);
  const origin = remoteValidationOrigin(issueNumber, run.id);
  const runDir = remoteValidationRunDir(input.validationRoot, run.goalRef, run.id);
  const browserServer = browserServerFor(input, run, runDir);
  const tenant = resolveTenant({
    environment,
    stamped: store.remoteValidation.listRemoteTenants(),
    now: input.now?.() ?? Date.now(),
    env: input.env,
  }).standing.tenant;

  return {
    runId: run.id,
    goalRef: run.goalRef,
    issueNumber,
    environment: run.environment,
    status: run.status,
    origin,
    leaseKey: remoteValidationKey(issueNumber, run.id),
    deployedSha: run.startedSha,
    confirmed: selectors.length + scripts.length + screens.length + drives.length,
    browser: browserServer,
    briefing: briefing({
      environment: environment.name,
      profile: browser.profile ?? null,
      runner: browser.runner,
      listSelectors: browser.listSelectors ?? null,
      publish: browser.publishArtefacts ?? null,
      tenant,
      selectors,
      scripts,
      screens,
      drives,
      browserKey: browserServer?.key ?? null,
      titles: confirmed.map((row) => row.title),
      reportDir: `${runDir}/report`,
      artefactDir: `${runDir}/artefacts`,
      listingDir: `${runDir}/listing`,
      deployedSha: run.startedSha,
    }),
  };
}

// The run's own artefact directory is what the browser writes into, so a screen it took is
// already where the report names it by file name alone; the profile is the environment's, and
// persists. → docs/spec/36-remote-validation.md#the-browser-the-run-drives
function browserServerFor(input: BriefInput, run: RemoteRun, runDir: string): ExtraMcpServer | null {
  return input.browser === undefined || input.browser === null
    ? null
    : substituteBrowserArgs(input.browser, {
        outputDir: `${runDir}/artefacts`,
        profileDir: remoteValidationProfileDir(input.validationRoot, run.environment),
      });
}

/**
 * The `check` rows this run is for: selected, unblocked, and naming an area the check declares. A
 * check that names none is a person's, exactly as every check is today.
 *
 * The press reads it too, and must: a run left open for an agent nothing will ever dispatch is a
 * sheet whose press stays absent for good, and a run settled with an agent's half still owed is a
 * press that quietly did less than it said.
 *
 * @public read by `RemoteRunDesk` to decide whether a press still owes an agent
 */
export function runnableSelectors(
  store: Store,
  environment: EnvironmentConfig,
  goalRef: string,
  rows: readonly RemoteSheetRow[],
): string[] {
  if (environment.validate?.browser?.runner === undefined) return [];
  return areasOf(store, goalRef, confirmedCheckRows(rows, goalRef, environment.name));
}

/**
 * The one-off scripts this run is for. They are the **other** reason a run owes an agent: a check
 * carrying a script names no suite area at all, so a press counting only selectors would settle a
 * run with the script half still owed — the quiet half of the same failure `runnableSelectors`
 * exists to prevent, one instrument over.
 *
 * @public read by `RemoteRunDesk` to decide whether a press still owes an agent
 */
export function runnableScripts(
  store: Store,
  environment: EnvironmentConfig,
  goalRef: string,
  rows: readonly RemoteSheetRow[],
): RunScript[] {
  if (environment.validate?.browser?.runner === undefined) return [];
  return scriptsOf(store, goalRef, confirmedCheckRows(rows, goalRef, environment.name));
}

/**
 * The screens this run is asked to hand back. They are the **third** reason a run owes an agent, and
 * the quietest of the three: a check that only hands a screen back names no suite area and carries
 * no script, so a press counting the two instruments would settle the run with the whole point of
 * that check still owed — and the check would sit `unrun` for ever with nothing red.
 *
 * @public read by `RemoteRunDesk` to decide whether a press still owes an agent
 */
export function runnableScreens(
  store: Store,
  environment: EnvironmentConfig,
  goalRef: string,
  rows: readonly RemoteSheetRow[],
): RunScreen[] {
  if (environment.validate?.browser?.runner === undefined) return [];
  return screensOf(store, goalRef, confirmedCheckRows(rows, goalRef, environment.name));
}

/**
 * The checks this run's agent drives **itself**, at the browser it was launched with. They are the
 * **fourth** reason a run owes an agent and the last one anybody would think of: such a check names no
 * suite area, carries no script and asks for no screen, so a press counting the three instruments
 * would end the run on the spot with the whole of what it was pressed for still owed — the check
 * `unrun` for ever and the sheet reading as a run that answered.
 *
 * A reading one of these produces is attributed **`agent`**: the fleet, unattended, at a browser.
 * Nothing reviewed it and no script was written for it.
 * → docs/spec/36-remote-validation.md#a-check-the-agent-drives-itself
 *
 * @public read by `RemoteRunDesk` to decide whether a press still owes an agent
 */
export function runnableDrives(
  store: Store,
  environment: EnvironmentConfig,
  goalRef: string,
  rows: readonly RemoteSheetRow[],
): RunDrive[] {
  if (environment.validate?.browser?.runner === undefined) return [];
  return drivesOf(store, goalRef, confirmedCheckRows(rows, goalRef, environment.name));
}

function confirmedCheckRows(rows: readonly RemoteSheetRow[], goalRef: string, environment: string): RemoteSheetRow[] {
  return rows.filter(
    (row) =>
      row.goalRef === goalRef &&
      row.environment === environment &&
      row.kind === 'check' &&
      row.selected &&
      row.blockedReason === null,
  );
}

/**
 * A selector names an **area**, never a file path, and it is named by the check's own `suite` step
 * and by nothing else.
 */
function areasOf(store: Store, goalRef: string, rows: readonly RemoteSheetRow[]): string[] {
  const areas = new Map(
    store.validation.listValidationChecks(goalRef).map((check) => [check.id, stepArea(check.steps)]),
  );
  const out: string[] = [];
  for (const row of rows) {
    const area = areas.get(row.sourceId) ?? null;
    if (area !== null && !out.includes(area)) out.push(area);
  }
  return out;
}

/**
 * A check's script, where it has one. A check that names an **area** is not here: it runs the
 * project's reviewed suite, and that is a different instrument with a different worth. Nothing folds
 * the two.
 */
function scriptsOf(store: Store, goalRef: string, rows: readonly RemoteSheetRow[]): RunScript[] {
  const checks = new Map(store.validation.listValidationChecks(goalRef).map((check) => [check.id, check]));
  const out: RunScript[] = [];
  for (const row of rows) {
    const check = checks.get(row.sourceId);
    if (check === undefined || stepArea(check.steps) !== null) continue;
    const source = stepScript(check.steps);
    if (source === null) continue;
    out.push({ checkId: check.id, title: check.title, source });
  }
  return out;
}

/**
 * The checks whose test plan carries a `screenshot` step. This is the only channel that can take one:
 * the `validate-check` dispatch is told in its own prompt that the fleet has no interactive login, no
 * browser and no account on the environment, and here there are all three.
 * → docs/spec/36-remote-validation.md#a-screen-from-the-sheets-own-run
 */
function screensOf(store: Store, goalRef: string, rows: readonly RemoteSheetRow[]): RunScreen[] {
  const checks = new Map(store.validation.listValidationChecks(goalRef).map((check) => [check.id, check]));
  const out: RunScreen[] = [];
  for (const row of rows) {
    const check = checks.get(row.sourceId);
    if (check === undefined || !handsBackAScreen(check.steps)) continue;
    const step = check.steps.find((s) => s.kind === 'screenshot');
    out.push({ checkId: check.id, title: check.title, do: step?.do ?? check.do });
  }
  return out;
}

/**
 * The checks whose test plan asks the fleet to **drive the browser** and nothing else: a `browser`
 * step the fleet carries, with no area and no script. The three other instruments are all something
 * else running — reviewed repository code, a program written for this check, a camera — and this is
 * the agent itself at the application, which is why its reading is worth `agent` and not `spec`.
 *
 * A step is only here when `resolveSteps` gave it to the fleet. Where no environment declares a
 * `validate.browser` block, or none names a tenant, every such step is already a person's and names
 * the declaration that would have carried it — the harness forms no second opinion about that.
 * → docs/spec/20-validation.md#who-carries-a-step
 */
function drivesOf(store: Store, goalRef: string, rows: readonly RemoteSheetRow[]): RunDrive[] {
  const checks = new Map(store.validation.listValidationChecks(goalRef).map((check) => [check.id, check]));
  const out: RunDrive[] = [];
  for (const row of rows) {
    const check = checks.get(row.sourceId);
    if (check === undefined || !stepDriven(check.steps)) continue;
    out.push({
      checkId: check.id,
      title: check.title,
      steps: check.steps.filter((step) => step.kind === 'browser' && step.actor === 'fleet').map((step) => step.do),
      proof: check.proof,
    });
  }
  return out;
}
