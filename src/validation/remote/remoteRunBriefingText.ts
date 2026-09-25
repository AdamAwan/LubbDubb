import { SELECTOR_DELIMITER } from './runner.js';

// → docs/spec/36-remote-validation.md#the-dispatch--rule-remote-validation

/** One check's one-off script, and the id it reports under — which is the check's own. */
export interface RunScript {
  checkId: string;
  title: string;
  source: string;
}

/** One check that hands a screen back, and the id it reports the image under — the check's own. */
export interface RunScreen {
  checkId: string;
  title: string;
  do: string;
}

/** One check an agent drives at the browser, and the id it reports under — the check's own. */
export interface RunDrive {
  checkId: string;
  title: string;
  /** The `browser` steps the fleet carries, in the order they were authored. */
  steps: string[];
  /**
   * What a pass must hand back, where the check's author demanded it. Null is *none demanded*, and
   * the brief asks for nothing. → docs/spec/20-validation.md#proof
   */
  proof: string | null;
}

/**
 * The browser, offered as a **claim to check** rather than as a fact. Whether the server connected is
 * not something a brief can know: it is fetched and launched at the same moment the agent is, so it
 * can be missing because the machine is offline, because the package is blocked, or because no browser
 * is installed for it to drive — and the last of those does not surface until the first page.
 *
 * The answer to a browser that will not start is **`blocked`, never `failed`**: a failure dispatches
 * rule `validation-failed` to fix a defect, and a browser that would not start is not a defect in the
 * goal. → docs/spec/36-remote-validation.md#the-browser-the-run-drives
 */
function browserSection(input: BriefingInput): string[] {
  if (input.browserKey === null)
    return [
      '## There is no browser',
      '',
      'This deployment has configured none, so you cannot open a page yourself. The project’s own runner ' +
        'brings its own — that is a separate program and this is about **you** — so invoke what is declared ' +
        'below as usual, and report `blocked` for anything that needed a screen of your own. Do not describe ' +
        'a page you did not see.',
    ];
  return [
    '## The browser',
    '',
    `You **should** have one, on the \`${input.browserKey}\` MCP server. It keeps its profile between runs ` +
      `against ${input.environment} — so a sign-in somebody completed last time is probably still good — and ` +
      'the profile is this environment’s own, never the dev machine’s.',
    '',
    '**Check that before you plan around it.** That sentence is read off this deployment’s configuration ' +
      'and not off anything anybody looked at: the server is fetched and launched at the same moment you are, ' +
      'so it can be missing because the machine is offline, because the package is blocked, or because there ' +
      'is no browser installed for it to drive — and the last of those does not surface until the first page ' +
      `you try to open. If the \`${input.browserKey}\` tools are not there, or a navigation fails in a way ` +
      'that is about the browser rather than about the application, **that is not a finding about this goal**: ' +
      'give `blocked` and say the browser was unavailable, naming it. **Do not report `failed`** — a failure ' +
      'dispatches an agent to fix a defect, and there is no defect here.',
    '',
    '**It acts, so it stays inside this run’s tenant** — ' +
      `${input.tenant === null || input.tenant === '' ? 'and this environment declares none, which is why any row that needed one is blocked rather than driven' : `\`${input.tenant}\``}` +
      '. Do not sign in as anybody else, and do not invent a tenant.',
  ];
}

/**
 * The checks the agent carries **itself**, at the browser. Everything else this run does is a program
 * running — reviewed suite code, a one-off script, a camera — and the difference is the whole of why
 * this reading is worth `agent` and not `spec`, so the brief says so to the agent producing it.
 * → docs/spec/36-remote-validation.md#a-check-the-agent-drives-itself
 */
function drivenSection(input: BriefingInput): string[] {
  return [
    '',
    '## The checks you drive yourself',
    '',
    'These name no suite area and carry no script: the test plan asks for a **browser step**, and you are the ' +
      'one at the browser. What each one says is where to go and what to find out — **not a route**. How you ' +
      'get there is yours: navigate, sign in, arrange the data, click through whatever the application actually ' +
      'puts in front of you. Take the steps in the order they are written, one at a time — a reading taken ' +
      'early answers a different question — and take them against this run’s tenant and the deployed ' +
      'build you are pinned to.',
    ...input.drives.flatMap((drive) => [
      '',
      `### \`${drive.checkId}\` — ${drive.title}`,
      '',
      ...drive.steps.map((step, at) => `${String(at + 1)}. ${step}`),
      ...(drive.proof === null
        ? []
        : [
            '',
            `**Proof — this check is refused a pass without it:** ${drive.proof}`,
            '',
            'Write the image into the artefact directory below and name the file on this check’s report row, ' +
              'in `capture`. A `passed` row that names no capture is recorded as **blocked**, because the author ' +
              'of this check said in advance that your word was not going to be enough on its own.',
          ]),
    ]),
    '',
    '**Each one reports under the check’s own id**, in the same shape and into the same report file as every ' +
      `other row of this run — \`{ "selector": "<the check id above>", "status": "passed" | "failed" }\`. That ` +
      'file is the only thing the harness reads: a step you carried out and wrote up in your reply alone ' +
      'reported nothing, and the row blocks rather than passing.',
    '',
    'A reading you produced this way is recorded as **`agent`** — the fleet, unattended — and never as ' +
      '`spec`. A reviewed spec is repository code a pull request’s reviewer read; this is you, once, and the ' +
      'sheet says which of the two an operator is counting.',
    '',
    'Where you cannot carry a step out at all — the browser will not start, the page never loads, the tenant ' +
      'will not sign in — that row is `blocked` with your reason, and **not** `failed`. A failure means the ' +
      'deployed product did the wrong thing, which is a different sentence and dispatches a different agent.',
    '',
    'A screen is worth taking beside anything you report: write it into the artefact directory below and name ' +
      'the file in the report, exactly as a screen row does. A finding with a picture is one nobody has to ' +
      'reproduce to believe.',
  ];
}

interface BriefingInput {
  environment: string;
  profile: string | null;
  runner: string;
  /** `validate.browser.listSelectors` — the listing the run agent takes in its pinned checkout. */
  listSelectors: string | null;
  publish: string | null;
  /** The tenant's **name** — for a `tenantEnv` shape, the variable's own name. Never its value. */
  tenant: string | null;
  selectors: readonly string[];
  scripts: readonly RunScript[];
  screens: readonly RunScreen[];
  drives: readonly RunDrive[];
  /** The MCP server the agent's browser is on, or null where the deployment configured none. */
  browserKey: string | null;
  titles: readonly string[];
  reportDir: string;
  artefactDir: string;
  listingDir: string;
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
export function briefing(input: BriefingInput): string {
  return [
    ...runSection(input),
    ...browserSection(input),
    '',
    ...(input.listSelectors === null ? [] : listingSection(input.listSelectors, input.listingDir)),
    ...commandSection(input),
    ...runsForSection(input),
    ...(input.drives.length > 0 ? drivenSection(input) : []),
    ...(input.scripts.length > 0 ? scriptsSection(input) : []),
    ...(input.screens.length > 0 ? screensSection(input) : []),
    ...(input.publish === null ? [] : publishSection(input.publish, input.reportDir)),
    ...reportSection(),
    ...answerSection(input),
    ...rulesSection(input),
  ].join('\n');
}

function runSection(input: BriefingInput): string[] {
  return [
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
  ];
}

function listingSection(command: string, listingDir: string): string[] {
  return [
    '## Listing what this runner offers',
    '',
    'First, and before you invoke anything: ask the deployed runner which selectors it actually offers. The ' +
      'project declares that command too, and you invoke **that**, from this pinned checkout, with the same ' +
      'environment set as below:',
    '',
    '```',
    command,
    '```',
    '',
    `Write what it prints to a file in \`${listingDir}\`, and call **remote_validation_listing** with ` +
      '`listingPath` set to that file. The harness parses the runner’s own output and reads every confirmed ' +
      'row’s area against it.',
    '',
    '**You say nothing about what is in it.** The tool has no field for a selector and none for a count, ' +
      'deliberately: how many tests an area holds is the denominator every row is read against, and a ' +
      'denominator an agent stated is a denominator nobody took. A path says where a file is, not what is ' +
      'in it, which is why this can come through you at all.',
    '',
    'It answers with **the selectors that survived**, and those are the ones you run — those and no others. ' +
      'A row whose area the listing did not survive is already blocked here, with the reason in front of the ' +
      'operator, and nothing you invoke afterwards turns it green.',
    '',
    'It matters that this is taken **here**, in a checkout pinned to the commit the environment is running: ' +
      'a listing taken anywhere else describes a different build, and the denominator would then belong to ' +
      'some other product than the one under test.',
    '',
    'If the runner cannot be asked at all — it will not answer, the install failed, the credentials are not ' +
      'here — give `blocked` and the reason instead of a path. Every check row it would have answered for ' +
      'carries your reason to the operator, and whatever else this run owes is still yours to carry out.',
    '',
  ];
}

function commandSection(input: BriefingInput): string[] {
  return [
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
    input.listSelectors === null
      ? `LUBBDUBB_SELECTORS=${input.selectors.join(SELECTOR_DELIMITER)}`
      : 'LUBBDUBB_SELECTORS=<the selectors remote_validation_listing answered with, comma-joined>',
    `LUBBDUBB_REPORT_DIR=${input.reportDir}`,
    '```',
    '',
    'All of the selected rows go in **one** invocation. Auth setup has a fixed per-invocation cost — an ' +
      'identity-provider round trip, often several — that dominates a small spec’s runtime, so running them one ' +
      'at a time is the same readings for several times the minutes.',
    '',
  ];
}

function runsForSection(input: BriefingInput): string[] {
  return [
    '## What this run is for',
    '',
    'One row each, and the selector each one is verified against:',
    '',
    ...(input.selectors.length === 0 &&
    input.scripts.length === 0 &&
    input.screens.length === 0 &&
    input.drives.length === 0
      ? ['- (nothing is confirmed on this sheet)']
      : input.selectors.map((selector, at) => `- \`${selector}\` — ${input.titles[at] ?? 'a confirmed check'}`)),
    ...(input.scripts.length === 0
      ? []
      : input.scripts.map((script) => `- \`${script.checkId}\` — ${script.title}, by the one-off script below`)),
    ...(input.screens.length === 0
      ? []
      : input.screens.map((screen) => `- \`${screen.checkId}\` — ${screen.title}, a screen to hand back`)),
    ...(input.drives.length === 0
      ? []
      : input.drives.map((drive) => `- \`${drive.checkId}\` — ${drive.title}, which you drive yourself`)),
  ];
}

function scriptsSection(input: BriefingInput): string[] {
  return [
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
  ];
}

function screensSection(input: BriefingInput): string[] {
  return [
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
  ];
}

function publishSection(command: string, reportDir: string): string[] {
  return [
    '',
    '## Publishing the artefacts',
    '',
    'Then invoke the project’s own publish command, with the same environment set and ' +
      `\`LUBBDUBB_REPORT_DIR=${reportDir}\`:`,
    '',
    '```',
    command,
    '```',
    '',
    'It prints a URL. That URL is the difference between a red row somebody clicks into and understands in ' +
      'thirty seconds and a red row somebody reproduces by hand, so pass on exactly what it printed.',
  ];
}

function reportSection(): string[] {
  return [
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
  ];
}

function answerSection(input: BriefingInput): string[] {
  return [
    '## How to answer',
    '',
    ...(input.listSelectors === null
      ? []
      : [
          'The listing was its own call, earlier and separate: that one takes the path to what the listing ' +
            'command printed, and this one takes the path to the report. Neither says what is in the file it ' +
            'points at.',
          '',
        ]),
    'Call **remote_validation_report** exactly once, at the end. Which run you are reporting on is already ' +
      'decided by what you were dispatched for, so what you say is only where things landed:',
    '',
    `- \`reportPath\` — the runner’s machine-readable report, inside \`${input.reportDir}\`.`,
    ...(input.publish === null ? [] : ['- `artefacts` — the URL the publish command printed.']),
    '- `blocked` — a reason, **instead of** a report: the run could not be carried out at all. It records ' +
      'nothing, leaves every row exactly as it was, and carries your reason to the operator. It is a right ' +
      'answer rather than a last resort — an agent that could not reach the environment has learned nothing ' +
      'about the goal, and with only a report available its options would be a lie and silence.',
    '',
    '**You state no outcome, and the tool has no field you could state one in.** The report file decides every ' +
      'row, and the exit code decides nothing: one invocation carries many rows and one code, so anything ' +
      'inferred from that code is guaranteed to be wrong for some row. A non-zero exit with a report beside it ' +
      'is still a run that answered; report where it landed and let the harness read it.',
    '',
  ];
}

function rulesSection(input: BriefingInput): string[] {
  return [
    '## The rules of the run',
    '',
    `- **You are in a read-only checkout**, pinned to \`${input.deployedSha}\`. Nothing here is committed or pushed.`,
    '- **Do not edit the suite.** Not a selector, not a timeout, not a retry, not a skip. A spec changed to ' +
      'make a run go green is a reading of nothing, and the specs are reviewed in pull requests, which is the ' +
      'whole of what makes them worth running.',
    input.listSelectors === null
      ? `- **Write nothing outside \`${input.reportDir}\` and \`${input.artefactDir}\`.**`
      : `- **Write nothing outside \`${input.reportDir}\`, \`${input.artefactDir}\` and \`${input.listingDir}\`.**`,
    '- **Do not diagnose what you find.** A failed row reaches its own rule with its own agent. Your job ends ' +
      'at saying where the report is.',
  ];
}
