import type { EnvironmentConfig } from '../environments/policy.js';
import type { Store } from '../store/store.js';
import type { RemoteRunBrief, RemoteSheetRow } from '../types.js';
import { handsBackAScreen, stepScript } from '../validation/steps.js';
import { remoteValidationKey, remoteValidationOrigin, remoteValidationRunDir } from './origin.js';
import { resolveTenant, type TenantEnvironment } from './tenants.js';

// → docs/spec/36-remote-validation.md#the-dispatch--rule-remote-validation

interface BriefInput {
  store: Store;
  environments: readonly EnvironmentConfig[];
  validationRoot: string;
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
  const runs = store.listRemoteRuns().filter((run) => run.status === 'pending' || run.status === 'dispatched');
  if (runs.length === 0) return [];
  const rows = store.listRemoteSheetRows();
  const out: RemoteRunBrief[] = [];
  for (const run of runs) {
    const issueNumber = Number(/^issue:(\d+)$/.exec(run.goalRef)?.[1] ?? NaN);
    if (!Number.isInteger(issueNumber)) continue;
    const environment = input.environments.find((e) => e.name === run.environment);
    const browser = environment?.validate?.browser;
    if (environment === undefined || browser?.runner === undefined) continue;
    if (run.startedSha === null) continue;

    const confirmed = confirmedCheckRows(rows, run.goalRef, run.environment);
    const selectors = areasOf(store, run.goalRef, confirmed);
    const scripts = scriptsOf(store, run.goalRef, confirmed);
    const screens = screensOf(store, run.goalRef, confirmed);
    const origin = remoteValidationOrigin(issueNumber, run.id);
    const runDir = remoteValidationRunDir(input.validationRoot, run.goalRef, run.id);
    const tenant = resolveTenant({
      environment,
      stamped: store.listRemoteTenants(),
      now: input.now?.() ?? Date.now(),
      env: input.env,
    }).standing.tenant;

    out.push({
      runId: run.id,
      goalRef: run.goalRef,
      issueNumber,
      environment: run.environment,
      status: run.status,
      origin,
      leaseKey: remoteValidationKey(issueNumber, run.id),
      deployedSha: run.startedSha,
      confirmed: selectors.length + scripts.length + screens.length,
      briefing: briefing({
        environment: environment.name,
        profile: browser.profile ?? null,
        runner: browser.runner,
        publish: browser.publishArtefacts ?? null,
        tenant,
        selectors,
        scripts,
        screens,
        titles: confirmed.map((row) => row.title),
        reportDir: `${runDir}/report`,
        artefactDir: `${runDir}/artefacts`,
        deployedSha: run.startedSha,
      }),
    });
  }
  return out;
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

/** A selector names an **area**, never a file path, and it is the check's own `area` and nothing else. */
function areasOf(store: Store, goalRef: string, rows: readonly RemoteSheetRow[]): string[] {
  const areas = new Map(store.listValidationChecks(goalRef).map((check) => [check.id, check.area]));
  const out: string[] = [];
  for (const row of rows) {
    const area = areas.get(row.sourceId) ?? null;
    if (area !== null && !out.includes(area)) out.push(area);
  }
  return out;
}

/** One check's one-off script, and the id it reports under — which is the check's own. */
interface RunScript {
  checkId: string;
  title: string;
  source: string;
}

/**
 * A check's script, where it has one. A check that names an **area** is not here: it runs the
 * project's reviewed suite, and that is a different instrument with a different worth. Nothing folds
 * the two.
 */
function scriptsOf(store: Store, goalRef: string, rows: readonly RemoteSheetRow[]): RunScript[] {
  const checks = new Map(store.listValidationChecks(goalRef).map((check) => [check.id, check]));
  const out: RunScript[] = [];
  for (const row of rows) {
    const check = checks.get(row.sourceId);
    if (check === undefined || check.area !== null) continue;
    const source = stepScript(check.steps);
    if (source === null) continue;
    out.push({ checkId: check.id, title: check.title, source });
  }
  return out;
}

/** One check that hands a screen back, and the id it reports the image under — the check's own. */
interface RunScreen {
  checkId: string;
  title: string;
  do: string;
}

/**
 * The checks whose test plan carries a `screenshot` step. This is the only channel that can take one:
 * the `validate-check` dispatch is told in its own prompt that the fleet has no interactive login, no
 * browser and no account on the environment, and here there are all three.
 * → docs/spec/36-remote-validation.md#a-screen-from-the-sheets-own-run
 */
function screensOf(store: Store, goalRef: string, rows: readonly RemoteSheetRow[]): RunScreen[] {
  const checks = new Map(store.listValidationChecks(goalRef).map((check) => [check.id, check]));
  const out: RunScreen[] = [];
  for (const row of rows) {
    const check = checks.get(row.sourceId);
    if (check === undefined || !handsBackAScreen(check.steps)) continue;
    const step = check.steps.find((s) => s.kind === 'screenshot');
    out.push({ checkId: check.id, title: check.title, do: step?.do ?? check.do });
  }
  return out;
}

interface BriefingInput {
  environment: string;
  profile: string | null;
  runner: string;
  publish: string | null;
  /** The tenant's **name** — for a `tenantEnv` shape, the variable's own name. Never its value. */
  tenant: string | null;
  selectors: readonly string[];
  scripts: readonly RunScript[];
  screens: readonly RunScreen[];
  titles: readonly string[];
  reportDir: string;
  artefactDir: string;
  deployedSha: string;
}

/**
 * Appended to the rendered prompt, never interpolated into it: `loadPromptTemplates` rejects only
 * *unknown* placeholders, so an override that never learned a new `{token}` drops it silently — on
 * exactly the deployments that customised most.
 *
 * A `tenantEnv`'s **value** never appears here. What a surface and a prompt carry is the variable's
 * own name; the value goes into the spawn env and nowhere else.
 */
function briefing(input: BriefingInput): string {
  const lines: string[] = [
    '',
    '',
    '## The run',
    '',
    `**Environment** — \`${input.environment}\`${input.profile === null ? '' : `, which the suite calls \`${input.profile}\``}.`,
    `**Deployed commit** — \`${input.deployedSha}\`. Your checkout is pinned to it: the specs that describe ` +
      'the deployed build are the ones in it, and a branch tip describes a product nobody is running.',
    `**Tenant** — ${input.tenant === null || input.tenant === '' ? 'this environment declares none' : `\`${input.tenant}\``}. ` +
      'Do not invent one, and do not substitute another: environments reap tenants matching a name pattern past ' +
      'a short age, so an invented name survives about an hour and its disappearance presents as mysterious ' +
      'mass failure.',
    '',
    '## The command to invoke',
    '',
    'The project declares it and you invoke **that**, verbatim. Never construct an invocation of your own: a ' +
      'browser suite has a runner config with a dependency graph — auth-setup projects others depend on, ' +
      'deliberately serialised pairs, per-project stored credential state — and calling a runner binary against ' +
      'a spec file directly bypasses all of it and fails at the first authenticated call.',
    '',
    '```',
    input.runner,
    '```',
    '',
    'Its parameters ride in the environment, and a command is never assembled from them. Export these before ' +
      'you invoke it:',
    '',
    '```',
    `LUBBDUBB_ENVIRONMENT=${input.environment}`,
    ...(input.profile === null ? [] : [`LUBBDUBB_PROFILE=${input.profile}`]),
    ...(input.tenant === null || input.tenant === '' ? [] : [`LUBBDUBB_TENANT=${input.tenant}`]),
    `LUBBDUBB_SELECTORS=${input.selectors.join(',')}`,
    `LUBBDUBB_REPORT_DIR=${input.reportDir}`,
    '```',
    '',
    'All of the selected rows go in **one** invocation. Auth setup has a fixed per-invocation cost — an ' +
      'identity-provider round trip, often several — that dominates a small spec’s runtime, so running them one ' +
      'at a time is the same readings for several times the minutes.',
    '',
    '## What this run is for',
    '',
    'One row each, and the selector each one is verified against:',
    '',
    ...(input.selectors.length === 0 && input.scripts.length === 0 && input.screens.length === 0
      ? ['- (nothing is confirmed on this sheet)']
      : input.selectors.map((selector, at) => `- \`${selector}\` — ${input.titles[at] ?? 'a confirmed check'}`)),
    ...(input.scripts.length === 0
      ? []
      : input.scripts.map((script) => `- \`${script.checkId}\` — ${script.title}, by the one-off script below`)),
    ...(input.screens.length === 0
      ? []
      : input.screens.map((screen) => `- \`${screen.checkId}\` — ${screen.title}, a screen to hand back`)),
  ];

  if (input.scripts.length > 0) {
    lines.push(
      '',
      '## The one-off scripts',
      '',
      'These are **not** part of the project’s suite and there is no selector for them. Each was written for ' +
        'one check, is run exactly as it stands, and is never committed — so do not add it to the repository, ' +
        'do not tidy it, and do not fix it if it is wrong. A script you edited is a script nobody wrote and ' +
        'nobody reviewed, reported as evidence about the goal.',
      '',
      '**They act**, which the rest of this run does not: they arrange data into the situation the check is ' +
        'about. So they run inside this run’s tenant — ' +
        `${input.tenant === null || input.tenant === '' ? 'and this environment declares none, which is why any such row is blocked rather than run' : `\`${input.tenant}\``} ` +
        '— and nowhere else. Do not point one at another tenant, and do not invent one.',
      ...input.scripts.flatMap((script) => [
        '',
        `### \`${script.checkId}\` — ${script.title}`,
        '',
        '```',
        script.source,
        '```',
      ]),
      '',
      '**Each one reports under the check’s own id**, in the same shape and into the same report file as the ' +
        `suite’s rows — \`{ "selector": "<the check id above>", "status": "passed" | "failed" }\`. One report ` +
        'file carries every row of this run, the suite’s and the scripts’, and it is the only thing the harness ' +
        'reads: a script that printed its result to the console and nothing else reported nothing, and the row ' +
        'blocks rather than passing.',
      '',
      'A reading a script produces is recorded as **`script`**, never `spec`, and its source is drawn on the ' +
        'sheet beside it. Nothing reviewed it, and the sheet says so.',
    );
  }

  if (input.screens.length > 0) {
    lines.push(
      '',
      '## The screens to hand back',
      '',
      'These checks ask for a **screenshot**, and a screenshot **asserts nothing** — neither do you on its ' +
        'account. Take the screen the step describes, write the image into the artefact directory below, and ' +
        'name the file in the report under the check’s own id. A person looks at it and decides what it shows.',
      '',
      ...input.screens.flatMap((screen) => [`- \`${screen.checkId}\` — ${screen.do}`]),
      '',
      `Write them into \`${input.artefactDir}\`, and name each one in the report by **file name only** — not a ` +
        'path and not a URL. The harness moves the image out of this run’s artefacts and keeps it with the goal, ' +
        'because the artefacts are swept on the project’s own schedule and a screen somebody still has to look ' +
        'at outlives the run that took it:',
      '',
      '```json',
      '{ "selector": "<the check id above>", "status": "skipped", "capture": "confirmation-screen.png" }',
      '```',
      '',
      '**Do not say whether it looks right.** Whether a column reads legibly, whether a truncation is ' +
        'acceptable, whether a number is believable beside the source it came from — these are judgements, and ' +
        'a run that claimed them would be green about something else. The row reaches *captured, waiting to be ' +
        'looked at*, and a person settles it.',
      '',
      'A check that asks for a screen and comes back without one is **blocked**, not passed: handing the screen ' +
        'back is the whole of what the step is for.',
    );
  }

  if (input.publish !== null) {
    lines.push(
      '',
      '## Publishing the artefacts',
      '',
      'Then invoke the project’s own publish command, with the same environment set and ' +
        `\`LUBBDUBB_REPORT_DIR=${input.reportDir}\`:`,
      '',
      '```',
      input.publish,
      '```',
      '',
      'It prints a URL. That URL is the difference between a red row somebody clicks into and understands in ' +
        'thirty seconds and a red row somebody reproduces by hand, so pass on exactly what it printed.',
    );
  }

  lines.push(
    '',
    '## What the harness reads out of the report',
    '',
    'A JSON list of the tests that ran — **rows, never counts**. Point `reportPath` at a file of this shape; ' +
      'the project’s own runner emits it through its own reporter, and it is not yours to write by hand or to ' +
      'edit afterwards:',
    '',
    '```json',
    '[',
    '  { "selector": "<the area, exactly as above>", "status": "passed", "retries": 0, "durationMs": 4100 },',
    '  { "selector": "<the area>", "status": "skipped", "note": "the auth-setup project failed" }',
    ']',
    '```',
    '',
    '**Every selector above appears in it, including the ones nothing ran under.** A runner whose tests never ' +
      'ran because a dependency failed commonly omits them from its own report rather than reporting them ' +
      'skipped — and a report that omits them says, to this harness, that the area holds no test at all, which ' +
      'is what a renamed area says. So a selector no test ran under must appear as a `skipped` row whose ' +
      '`note` names the dependency that failed. The harness cannot know the suite’s dependency graph; that ' +
      'note is the only place the difference between a failed auth setup and a deleted spec is written down.',
    '',
    'A totals line is not a report: matched-versus-executed is the guard this design leans on, and a declared ' +
      'count is the thing being checked. If the runner emits several files, point at the machine-readable one.',
    '',
    '## How to answer',
    '',
    'Call **remote_validation_report** exactly once, at the end. Which run you are reporting on is already ' +
      'decided by what you were dispatched for, so what you say is only where things landed:',
    '',
    `- \`reportPath\` — the runner’s machine-readable report, inside \`${input.reportDir}\`.`,
    ...(input.publish === null ? [] : ['- `artefacts` — the URL the publish command printed.']),
    '- `handback` — a reason, **instead of** a report: the run could not be carried out at all. It records ' +
      'nothing, leaves every row exactly as it was, and carries your reason to the operator. It is a right ' +
      'answer rather than a last resort — an agent that could not reach the environment has learned nothing ' +
      'about the goal, and with only a report available its options would be a lie and silence.',
    '',
    '**You state no outcome, and the tool has no field you could state one in.** The report file decides every ' +
      'row, and the exit code decides nothing: one invocation carries many rows and one code, so anything ' +
      'inferred from that code is guaranteed to be wrong for some row. A non-zero exit with a report beside it ' +
      'is still a run that answered; report where it landed and let the harness read it.',
    '',
    '## The rules of the run',
    '',
    `- **You are in a read-only checkout**, pinned to \`${input.deployedSha}\`. Nothing here is committed or pushed.`,
    '- **Do not edit the suite.** Not a selector, not a timeout, not a retry, not a skip. A spec changed to ' +
      'make a run go green is a reading of nothing, and the specs are reviewed in pull requests, which is the ' +
      'whole of what makes them worth running.',
    `- **Write nothing outside \`${input.reportDir}\` and \`${input.artefactDir}\`.**`,
    '- **Do not diagnose what you find.** A failed row reaches its own rule with its own agent. Your job ends ' +
      'at saying where the report is.',
  );
  return lines.join('\n');
}
