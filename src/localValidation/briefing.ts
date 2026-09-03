import type { LocalRun, LocalValidation, Plan, PlanPart, ValidationCheck } from '../types.js';

/**
 * What a validating agent is handed beyond the rendered prompt, and what a fix
 * agent is handed beyond its own.
 *
 * **Appended, never interpolated**, the prompt book's rule
 * ([05](../../docs/spec/05-dispatcher.md#prompt-templates)): `loadPromptTemplates`
 * rejects only *unknown* placeholders, so an operator override written before a
 * token existed drops it in silence — and everything here is the half the agent
 * cannot act without. An agent that lost the URL would validate nothing; one that
 * lost the findings would fix nothing.
 *
 * Pure over the snapshot, so a rule can build it. What is deliberately **not** here
 * is anything that would be a reading: the ports the watch took and the session's
 * output tail are live, and a copy of them frozen into a prompt at dispatch would be
 * minutes stale by the time the agent got to them. `local_run_read` answers those,
 * at the moment the answer is wanted.
 */

interface ValidationBrief {
  issue: { number: number; title: string; body: string | null };
  plan: Plan | null;
  parts: PlanPart[];
  /** The goal's own validation checks — **input**, never something to report against. */
  checks: ValidationCheck[];
  run: LocalRun;
  /** The branch this ref was cut from, where the harness could say. */
  base: string | null;
  /** `localValidation.instruction`, verbatim. */
  instruction: string;
  outputDir: string;
  /** The `mcpServers` key the browser is under, or null when none is configured. */
  browserKey: string | null;
}

/** Trim and drop what the planner left empty, so a blank field is absent rather than a heading over nothing. */
function said(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}

function goalSection(issue: ValidationBrief['issue']): string {
  const body = said(issue.body);
  return `## The goal — #${issue.number} ${issue.title}\n\n${body ?? '_The ticket carries no description._'}\n`;
}

function planSection(plan: Plan | null, parts: PlanPart[]): string {
  if (plan === null) return `## The plan\n\nThere is no delivery plan for this goal. Read the diff instead.\n`;
  const lines = [`## The plan — ${plan.title}\n`];
  const approach = said(plan.approach);
  const verification = said(plan.verification);
  if (approach !== null) lines.push(`${approach}\n`);
  if (parts.length > 0)
    lines.push(
      `Its parts, in order:\n\n${parts
        .map((part) => `${String(part.seq)}. **${part.title}** — ${said(part.acceptance) ?? 'no acceptance stated'}`)
        .join('\n')}\n`,
    );
  // The planner's own answer to "how would anyone know this worked" — the narrative
  // field the validation checks are the executable form of. It is the closest thing
  // in the record to a test plan, so it is the one part of the plan worth quoting
  // rather than summarising.
  if (verification !== null)
    lines.push(`The planner said the whole thing is verified like this:\n\n> ${quote(verification)}\n`);
  return lines.join('\n');
}

function quote(text: string): string {
  return text.replace(/\n/g, '\n> ');
}

/**
 * The goal's declared validation checks, handed over as **input and nothing else**.
 *
 * They are the best statement anyone has written of what this goal is supposed to
 * do, and a test plan that ignored them would re-derive it worse. But a check is a
 * reading against the *delivered* goal, taken by whoever ran it
 * ([20](../../docs/spec/20-validation.md)) — and this agent is running against work
 * still in flight. So the heading says what they are for, and the tools say the rest:
 * there is no reachable code path from this dispatch to `validation_report`.
 */
function checksSection(checks: ValidationCheck[]): string {
  if (checks.length === 0) return '';
  const rows = checks
    .map((check) => `### ${check.letter} — ${check.title}\n\n${check.do}\n\n**A pass looks like:** ${check.expect}`)
    .join('\n\n');
  return (
    `## What the operator already says this goal has to satisfy\n\n` +
    `These are the goal's validation checks. They are the sharpest statement of intent anybody has written, so ` +
    `read them and let them shape your plan — a check that can be run against what is up now is worth running.\n\n` +
    `**You are not recording readings against them.** They are checked against the delivered goal by whoever ` +
    `runs them, and this goal is not delivered. You have no tool that could write one, which is deliberate.\n\n${rows}\n`
  );
}

function environmentSection(brief: ValidationBrief): string {
  const url = said(brief.run.url);
  const lines = [
    `## The environment\n`,
    `The harness is bringing this goal's code up in the machine's one dev environment. It is **not yours to ` +
      `start, stop, restart or message** — it is shared with the operator, who is very likely watching it.\n`,
    `| | |\n| --- | --- |\n` +
      `| Application | ${url ?? '_no URL is configured — ask `local_run_read` what ports came up_'} |\n` +
      `| Checkout | \`${brief.run.dir}\` |\n` +
      `| Branch | \`${brief.run.ref}\`${brief.base === null ? '' : ` (cut from \`${brief.base}\`)`} |\n` +
      `| Commit | \`${brief.run.commit ?? 'unrecorded'}\` |\n` +
      `| When you were dispatched it was | ${brief.run.status} |\n`,
  ];
  const instruction = said(brief.instruction);
  if (instruction !== null) lines.push(`### What the operator says about reaching it\n\n${instruction}\n`);
  return lines.join('\n');
}

function browserSection(browserKey: string | null, outputDir: string): string {
  if (browserKey === null)
    return (
      `### There is no browser\n\n` +
      `This deployment has configured none, so you cannot open a page. Validate what you can through the API, ` +
      `the database and the logs, and report \`blocked\` for any step that genuinely needs a screen — do not ` +
      `describe a page you did not see.\n`
    );
  return (
    `### The browser\n\n` +
    `You **should** have one, on the \`${browserKey}\` MCP server. It opens in a window the operator can watch, ` +
    `and it keeps its profile between runs — so a login somebody completed last time is probably still good.\n\n` +
    `**Check that before you plan around it.** That sentence is read off this deployment's configuration and ` +
    `not off anything anybody looked at: the server is fetched and launched at the same moment you are, so it ` +
    `can be missing because the machine is offline, because the package is blocked, or because there is no ` +
    `browser installed for it to drive — and the last of those does not surface until the first page you try ` +
    `to open. If the \`${browserKey}\` tools are not there, or a navigation fails in a way that is about the ` +
    `browser rather than about the application, **that is not a finding about this goal**: report \`blocked\`, ` +
    `say the browser was unavailable and name it. Do not report \`failed\` — a failure dispatches an agent to ` +
    `fix a defect, and there is no defect here.\n\n` +
    `Save a screenshot of anything you report, into \`${outputDir}\`. They are drawn beside your findings on ` +
    `the goal's page, and a finding with a picture is one nobody has to reproduce to believe.\n`
  );
}

/** The rules the harness imposes, which no operator instruction may be relied on to carry. */
function rulesSection(): string {
  return (
    `## How this run goes\n\n` +
    `1. **Write the plan first, before the environment is up.** A bring-up takes minutes and you are dispatched ` +
    `at the start of it, so the wait is free if you spend it reading the diff. Call \`local_validation_plan\` ` +
    `with a test plan for *these changes*: what behaviour to exercise, the exact steps, and what a pass looks ` +
    `like for each. It lands on the goal's page the moment you send it.\n` +
    `2. **Then wait for the environment.** Poll \`local_run_read\` until it says \`running\`, then open the ` +
    `application yourself.\n` +
    `3. **Run the plan, one step at a time.** Batching unverified steps produces output you cannot trust — each ` +
    `step's result is what tells you whether the next one means anything.\n` +
    `4. **Report once**, with \`local_validation_report\`.\n\n` +
    `### What is not evidence\n\n` +
    `\`running\` means the session that brought the environment up did not fail. A port answering means ` +
    `something accepted a connection. **Neither says the application works**, and reporting a pass on the ` +
    `strength of either is the one outcome this whole feature exists to prevent. Open the page and look.\n\n` +
    `### Where you would ask a person\n\n` +
    `This repository's own testing skills are written for somebody sitting at the keyboard, and they will tell ` +
    `you to ask when a step is ambiguous or a credential is missing. **Follow them otherwise, but there is ` +
    `nobody to ask.** Record that step as a blocked one in your report and carry on with the rest — a run that ` +
    `answers most of the plan and says plainly what it could not reach is worth far more than one that stops.\n\n` +
    `### And what you do not do\n\n` +
    `- **Change nothing.** No commits, no pushes, no edits to the code. This checkout is read-only and the ` +
    `environment is somebody else's. If the fix is obvious, say so in the finding — an agent is dispatched to ` +
    `make it.\n` +
    `- **Do not work around a failure to make a step pass.** A workaround that skips the broken thing is the ` +
    `test not being run. If the block is the bug, that *is* the result.\n` +
    `- **Do not report \`passed\` for something you did not exercise.** \`blocked\` is a right answer.\n`
  );
}

/** The three tools this dispatch has, named where they are used — the point-of-use rule. */
function toolsSection(): string {
  return (
    `## Your tools\n\n` +
    `- \`local_validation_plan\` — record the test plan. Once, up front.\n` +
    `- \`local_run_read\` — what the environment is doing right now: status, URL, the ports it holds, and the ` +
    `tail of the session bringing it up. Read it rather than guessing, and read it again rather than ` +
    `remembering.\n` +
    `- \`local_validation_report\` — \`passed\`, \`failed\` or \`blocked\`, with a summary and, for a failure, ` +
    `the findings. This ends the run.\n`
  );
}

/** Everything a validating agent is handed, in reading order. */
export function localValidationBriefing(brief: ValidationBrief): string {
  return [
    '\n\n---\n',
    goalSection(brief.issue),
    planSection(brief.plan, brief.parts),
    checksSection(brief.checks),
    environmentSection(brief),
    browserSection(brief.browserKey, brief.outputDir),
    rulesSection(),
    toolsSection(),
  ]
    .filter((section) => section !== '')
    .join('\n');
}

const SEVERITY_WORD: Record<string, string> = {
  blocker: 'Blocker',
  defect: 'Defect',
  nit: 'Nit',
};

/**
 * What the fix agent is handed: the plan that was run, and what running it found.
 *
 * The findings are quoted rather than summarised for `failureBriefing`'s reason —
 * somebody drove the application and wrote down what they saw, and that account is
 * the only thing in the record that cannot be re-derived from the code. The plan
 * comes with them because a finding is only as clear as the step that produced it.
 */
export function localValidationFixBriefing(row: LocalValidation, run: LocalRun | null): string {
  const lines = [
    `\n\n---\n`,
    `## What was found\n`,
    `An agent brought this goal's code up on the operator's machine, ran a test plan against it and reported ` +
      `**failed**. Its account:\n`,
    `> ${quote(row.summary ?? '(no summary was recorded)')}\n`,
    `### The findings\n`,
  ];
  for (const [index, finding] of row.findings.entries()) {
    const where = finding.url === null ? '' : `\n\n  Found on: ${finding.url}`;
    const shot =
      finding.screenshot === null
        ? ''
        : `\n\n  Screenshot: \`${finding.screenshot}\` (in the goal's validation directory)`;
    lines.push(
      `${String(index + 1)}. **${SEVERITY_WORD[finding.severity] ?? finding.severity} — ${finding.title}**\n\n  ${finding.detail.replace(/\n/g, '\n  ')}${where}${shot}\n`,
    );
  }
  if (row.plan !== null) lines.push(`### The plan it ran\n\n${row.plan}\n`);
  lines.push(
    `## What you are being asked to do\n\n` +
      `Fix these on \`${row.ref}\`, which is the branch that was validated. Commit and push there.\n\n` +
      `- **A finding may be wrong.** The agent could not ask anybody, and it was reading a running application ` +
      `rather than the intent. If one describes behaviour that is correct, say so and leave it — do not change ` +
      `working code to satisfy it.\n` +
      `- **The environment may still be up** at ${run?.url ?? 'the configured URL'}, but it is the operator's ` +
      `and not yours: do not start, stop or restart it, and do not expect your changes to be in it.\n` +
      `- **Do not open a pull request.** If this branch has one, your push reaches it; if it has not, opening ` +
      `one is the part's own job and not this dispatch's.\n`,
  );
  return lines.join('\n');
}
