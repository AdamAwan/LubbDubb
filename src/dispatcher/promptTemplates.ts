import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/**
 * Operator-customisable dispatch prompts.
 *
 * Every agent- (and escalation-) facing prompt the harness composes itself has a
 * stable id and a built-in default here — the {@link RuleDispatcher}'s, plus the
 * route-driven `finding-ticket`, which is here rather than inline in the route
 * precisely because *how a ticket should be written* is the operator's opinion,
 * not the harness's. An operator can override any of
 * them by dropping a `<id>.md` file into the prompt-templates directory
 * (`promptTemplatesDir`, default `.lubbdubb/prompts`); unset ids keep their
 * default. Overrides are read once at boot — templates don't change per-cycle.
 *
 * A template is a plain string with `{placeholder}` tokens filled at dispatch
 * time. Each id declares the exact placeholders it supports; an override that
 * references an unknown placeholder (or lives in a file whose name matches no
 * id) fails fast at load, so a typo can't silently ship a broken prompt.
 *
 * The `claude` dispatcher composes its prompts via the LLM and is unaffected —
 * this is the rule dispatcher's template book.
 */
type PromptId =
  | 'issue-plan'
  | 'issue-replan'
  | 'plan-part'
  | 'plan-approval'
  | 'plan-part-escalation'
  | 'issue-pickup'
  | 'issue-pickup-escalation'
  | 'issue-assess'
  | 'pr-ci-fix'
  | 'pr-base-update-behind'
  | 'pr-base-update-conflict'
  | 'pr-review-comment'
  | 'pr-concern-escalation'
  | 'story-groom'
  | 'story-waf'
  | 'story-pickup'
  | 'finding-ticket';

interface TemplateDef {
  /** The placeholder names this template may reference (validated on override). */
  readonly placeholders: readonly string[];
  /** Built-in default, used unless an operator override replaces it. */
  readonly template: string;
  /**
   * Human-facing note on what the prompt is for and when it fires, plus its
   * placeholders. Seeds the strippable doc header of the sample override files
   * so operators start from a self-documenting template.
   */
  readonly doc: string;
}

const REGISTRY: Record<PromptId, TemplateDef> = {
  'issue-plan': {
    placeholders: ['number', 'title', 'body', 'branch', 'planFile'],
    template:
      'Issue #{number} ("{title}") needs a delivery plan before any code is written.\n\n{body}\n\n' +
      'Read the repository and decide whether this work is ONE pull request or several. ' +
      'Bias hard toward one: splitting is the exception, and turning a twenty-minute fix into three PRs ' +
      'costs far more than it saves. Split only when the work genuinely cannot land as a single reviewable ' +
      'PR — for example when a schema or interface change must merge before the code that consumes it.\n\n' +
      'Submit your verdict with the plan_submit tool if you have it — it validates on the spot, so a ' +
      'rejected plan comes back with the reason and you can fix it and call again. Otherwise write the ' +
      'same document to {planFile} in this worktree, creating the directory if needed. For one PR:\n\n' +
      '  {"version": 1, "verdict": "single", "reason": "<one sentence>"}\n\n' +
      'For several, each part being one reviewable PR:\n\n' +
      '  {"version": 1, "verdict": "parts", "reason": "<one sentence>", "parts": [\n' +
      '    {"slug": "schema", "title": "...", "scope": "src/store/...", "dependsOn": []},\n' +
      '    {"slug": "dispatcher", "title": "...", "scope": "src/dispatcher/...", "dependsOn": ["schema"]}\n' +
      '  ]}\n\n' +
      'Slugs are short, lowercase, kebab-case and unique; "scope" names the files or areas that part owns, ' +
      'so parts running at the same time do not collide; "dependsOn" names **at most one** sibling slug — a part ' +
      'stacks on a single branch, so two dependencies is not expressible and the plan will be rejected.\n\n' +
      'Do not implement anything and do not open a pull request. Writing {planFile} is the whole job — you ' +
      'are on branch {branch} only so you have the repository to read.',
    doc: 'Sent to a code agent when the planning funnel is enabled and a watched open issue has no plan yet (rule 3c). The agent writes its verdict to the plan file; nothing else it does is read. Placeholders: {number} {title} {body} {branch} {planFile}.',
  },
  'issue-replan': {
    placeholders: ['number', 'title', 'body', 'branch', 'planFile', 'current'],
    template:
      'Issue #{number} ("{title}") already has a delivery plan, and an operator has asked for it to be replanned. ' +
      'Amend the existing plan — do not start from scratch.\n\n{body}\n\n{current}\n\n' +
      'Read the repository and the state above, then submit the amended plan with the plan_submit tool if you ' +
      'have it (it validates on the spot and tells you why if it rejects), otherwise write it to {planFile} in ' +
      'this worktree. Either way it is the same document as the original:\n\n' +
      '  {"version": 1, "verdict": "parts", "reason": "<one sentence>", "parts": [\n' +
      '    {"slug": "schema", "title": "...", "scope": "src/store/...", "dependsOn": []}\n' +
      '  ]}\n\n' +
      'Rules that make an amendment safe:\n\n' +
      '- **Slugs are the merge key.** Re-use the exact slug of every part you are keeping, whatever else you change ' +
      'about it. A part you re-declare under a new slug is not the same part: the old one is treated as dropped and ' +
      'a fresh branch is cut for the new one.\n' +
      '- **Re-declare parts that are already merged, dispatched or in review.** Their branches and pull requests ' +
      'exist and are not yours to withdraw; leaving them out does not undo them.\n' +
      '- **A part you leave out is retired**, and only if nothing was started for it. That is how you remove work ' +
      'that is no longer needed.\n' +
      '- New parts may be added, and dependencies rewired, subject to the same rule as before: "dependsOn" names ' +
      '**at most one** sibling slug.\n' +
      '- A "single" verdict is only honoured while no part has a branch or a pull request yet.\n\n' +
      'Do not implement anything and do not open a pull request. Writing {planFile} is the whole job — you are on ' +
      'branch {branch} only so you have the repository to read.',
    doc: 'Sent to a code agent when an operator hits Replan on an existing plan (rule 3c, with the plan row back in `planning`). Unlike {issue-plan} it amends rather than plans cold: {current} is the plan and its parts as they stand, and the prompt spells out that slugs are the merge key and that in-flight parts must be re-declared. Placeholders: {number} {title} {body} {branch} {planFile} {current}.',
  },
  'plan-part': {
    placeholders: ['number', 'title', 'part', 'scope', 'branch', 'base', 'plan', 'done', 'remaining'],
    template:
      'Issue #{number} ("{title}") was split into parts, and you own the part "{part}".\n\n' +
      'Why it was split: {plan}\n\n' +
      'Your scope — the files and areas this part owns. Stay inside it; a sibling part may be running right now:\n' +
      '{scope}\n\n' +
      'Other parts whose work already exists (do not redo it; some of it may already be on your branch):\n' +
      '{done}\n\n' +
      'Other parts still to come. These are explicitly NOT yours — leave them alone:\n' +
      '{remaining}\n\n' +
      'Work on branch {branch}, which is cut from {base}. Open a pull request from {branch} **into {base}** — if ' +
      'that is not the default branch, this PR is stacked on another part and must target it, not the default. ' +
      'Say in the PR body which part of #{number} this is and what it stacks on. Reference the issue as ' +
      '"part of #{number}" and never as "closes #{number}": other parts still have to land.',
    doc: "Sent to a code agent for one part of a multi-PR plan (rule 4a). {plan} is the planner's justification, {done}/{remaining} the sibling parts either side of this one, {base} the branch this part stacks on (the default branch when it stacks on nothing). Placeholders: {number} {title} {part} {scope} {branch} {base} {plan} {done} {remaining}.",
  },
  'plan-approval': {
    placeholders: ['number', 'title', 'parts', 'reason', 'list'],
    template:
      'Issue #{number} ("{title}") was planned as {parts} stacked pull request(s), and nothing is scheduled until ' +
      'you approve the decomposition.\n\nWhy it was split: {reason}\n\n{list}\n\n' +
      'Approve and each part gets its own agent, branch and pull request, bottom of the stack first. Reject and the ' +
      'issue is worked as a single pull request instead — parts nothing has been started for are retired. If you ' +
      'want a different split, use Replan on the plan panel: that asks the planner again and comes back here.',
    doc: 'Put to a human when `planning.requireApproval` is on and a `parts` verdict has landed (rule 3d). It is a proposal, not a question: the accept/reject buttons settle it, and free text cannot. Placeholders: {number} {title} {parts} {reason} {list}.',
  },
  'plan-part-escalation': {
    placeholders: ['number', 'part', 'attempts'],
    template:
      'Part "{part}" of issue #{number} keeps failing: {attempts} agent attempt(s) produced no pull request. The rest of the plan may be stacked on it — please take a look.',
    doc: 'Escalated to a human when one part of a plan keeps failing to produce a PR. Placeholders: {number} {part} {attempts}.',
  },
  'issue-pickup': {
    placeholders: ['number', 'title', 'body', 'branch'],
    template:
      'GitHub issue #{number} ("{title}") needs resolving.\n\n{body}\n\nImplement the fix on branch {branch} and open a pull request that resolves it. Reference the issue as "closes #{number}" only if this PR completes the whole thing; if work remains afterwards, reference it as "part of #{number}" so it stays open for the rest.',
    doc: 'Sent to a code agent when an open work item / issue has no open PR and no agent is on it (rule 4). Placeholders: {number} {title} {body} {branch}.',
  },
  'issue-pickup-escalation': {
    placeholders: ['number', 'title', 'attempts'],
    template:
      'Auto-resolution of issue #{number} ("{title}") keeps failing: {attempts} agent attempt(s) produced no linked PR. Please take a look.',
    doc: 'Escalated to a human when issue pickup keeps failing to produce a linked PR. Placeholders: {number} {title} {attempts}.',
  },
  'issue-assess': {
    placeholders: ['number', 'title', 'body', 'branch'],
    template:
      'Issue #{number} ("{title}") has had work done on it and has nothing in flight right now. Decide whether it is finished.\n\n{body}\n\nYou are on branch {branch}, cut from the default branch, so the repository you can see is the delivered state. Read it. Call world_read("issue", "issue:{number}") for the harness\'s own record of what was done — the pull requests that delivered this issue, including ones long gone from the world, each marked `observed` (the harness watched it merge) or `inferred` (it left the open list and the merge was assumed). An inferred merge is weaker evidence; say so if your verdict rests on one.\n\nThen call assess_issue:\n\n- "delivered" if what the issue asked for is actually present in the repository. This stops the harness scheduling anything further for it. It does NOT close the ticket — a human does that after testing, and your verdict is reversible.\n- "more_work" if something the issue asked for is missing. Say precisely what, because the next agent is given your words.\n\nDo not implement anything and do not open a pull request. Judge from what is there. If you genuinely cannot tell, say "more_work" and explain what you could not verify — a wrong "delivered" parks real work silently, while a wrong "more_work" costs one more agent.',
    doc: 'Sent to a code agent for an issue that has had work and has nothing in flight (rule 3e). It reads the delivered state on the default branch plus the work graph via world_read, and casts a verdict with assess_issue. Placeholders: {number} {title} {body} {branch}.',
  },
  'pr-ci-fix': {
    placeholders: ['number', 'title', 'branch'],
    template: 'CI is failing on PR #{number} ("{title}", branch {branch}). Investigate the failure and push a fix.',
    doc: 'Sent to a code agent when a PR has failing CI and no agent is on its branch. Placeholders: {number} {title} {branch}.',
  },
  'pr-base-update-behind': {
    placeholders: ['number', 'title', 'branch', 'base'],
    template:
      'PR #{number} ("{title}") is behind its base branch {base}. Merge {base} into {branch} to bring it up to date, then push. No conflicts are expected — this is a routine update.',
    doc: 'Sent to a code agent when a PR is behind its base branch (clean, no conflicts). Placeholders: {number} {title} {branch} {base}.',
  },
  'pr-base-update-conflict': {
    placeholders: ['number', 'title', 'branch', 'base'],
    template:
      'PR #{number} ("{title}") has merge conflicts with its base branch {base}. Merge {base} into {branch}, resolve the conflicts, and push. If you cannot resolve them cleanly, escalate for a human.',
    doc: 'Sent to a code agent when a PR conflicts with its base branch. Placeholders: {number} {title} {branch} {base}.',
  },
  'pr-review-comment': {
    placeholders: ['number', 'branch', 'author', 'comment'],
    template:
      'A reviewer commented on PR #{number} (branch {branch}):\n\n"{comment}"\n\nDecide whether to fix the code or defend the current approach. If defending, prepare a concise reply.',
    doc: 'Sent to a code agent to address an unhandled review comment on a PR. Placeholders: {number} {branch} {author} {comment}.',
  },
  'pr-concern-escalation': {
    placeholders: ['number', 'title', 'attempts'],
    template:
      'Auto-resolution of "{title}" keeps failing: {attempts} agent attempt(s) on PR #{number} left the concern unresolved. Please handle it manually.',
    doc: 'Escalated to a human when a PR concern (CI / base / comment) keeps failing to clear. Placeholders: {number} {title} {attempts}.',
  },
  'story-groom': {
    placeholders: ['title', 'missing'],
    template: 'Story "{title}" is missing {missing}. Draft them.',
    doc: 'Sent to a desk agent to groom a ready story lacking a description and/or acceptance criteria. {missing} is the computed phrase (e.g. "a description and acceptance criteria"). Placeholders: {title} {missing}.',
  },
  'story-waf': {
    placeholders: ['title'],
    template:
      'Story "{title}" has no Well-Architected Framework pillars set. Determine which pillars apply and document them.',
    doc: 'Sent to a desk agent to fill in WAF pillars on a ready story. Placeholders: {title}.',
  },
  'story-pickup': {
    placeholders: ['title', 'description', 'acceptanceCriteria'],
    template: 'Implement story "{title}".\n\nDescription: {description}\n\nAcceptance criteria: {acceptanceCriteria}',
    doc: 'Sent to a code agent to implement the highest-priority groomed story when there is idle capacity. Placeholders: {title} {description} {acceptanceCriteria}.',
  },
  'finding-ticket': {
    placeholders: ['kind', 'kindHelp', 'ref', 'summary', 'originRef', 'tracker'],
    template:
      'An operator wants a finding filed as a ticket so it can be dealt with later. File it — do not fix it.\n\n' +
      'It was reported by an agent working {originRef}, about {ref}, as a "{kind}" finding ({kindHelp}).\n\n' +
      'The report, verbatim:\n\n{summary}\n\n' +
      'File it in {tracker}\n\n' +
      'Before you create anything, search the existing open items for the same thing. If one already ' +
      'covers it, do not file a second — link the existing one instead. Write the ticket for someone ' +
      'who was not there: a title that says what is wrong, and a body carrying the report above, where ' +
      'it was found, and what you were able to verify. Verify what you reasonably can from the ' +
      'repository first, and say in the body which parts you confirmed and which are the reporting ' +
      "agent's word — it is one agent's reading, not established fact.\n\n" +
      'When the ticket exists, call the link_ticket tool with its ref ("issue:314") so it shows up ' +
      'against the finding in the cockpit. That call is what finishes this task: without it the ' +
      'operator sees a filing that never completed. If you decided not to file because it already ' +
      'exists, call link_ticket with the existing item’s ref.',
    doc:
      'Sent to a desk agent when an operator clicks "File ticket" on a finding, to create it in ' +
      'GitHub/Azure DevOps and report the ref back via link_ticket. Override this to control how ' +
      'tickets are worded, labelled, or typed in your tracker. Placeholders: {kind} {kindHelp} {ref} ' +
      '{summary} {originRef} {tracker}.',
  },
};

const KNOWN_IDS = Object.keys(REGISTRY) as PromptId[];

/** Every `{token}` referenced in a template body. */
function placeholdersIn(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

/**
 * Fill `{name}` tokens from `vars`. Pure. A token with no matching var is left
 * untouched (a default template only ever references vars the caller supplies;
 * an override is placeholder-validated at load, so this can't silently drop
 * data). Values stringify — numbers included.
 */
export function renderTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars && vars[name] !== undefined ? String(vars[name]) : whole,
  );
}

/**
 * Strip a single leading HTML-comment block (the operator's "what/when" doc)
 * plus surrounding whitespace, so a documented override file never leaks its
 * documentation into the agent's prompt. Only a *leading* comment is removed —
 * a comment inside the prompt body is left alone.
 */
export function stripTemplateDoc(raw: string): string {
  return raw.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
}

/** The `<!-- doc -->` + body a sample/scaffold override file should contain. */
export function sampleTemplateFile(id: PromptId): string {
  return `<!--\n  ${REGISTRY[id].doc}\n-->\n\n${REGISTRY[id].template}\n`;
}

/**
 * The resolved template book handed to the dispatcher: defaults overlaid with
 * any operator overrides. Construct via {@link loadPromptTemplates} (reads the
 * override dir) or {@link defaultPromptTemplates} (defaults only, for tests).
 */
export class PromptTemplates {
  private readonly templates: Record<PromptId, string>;
  constructor(overrides: Partial<Record<PromptId, string>> = {}) {
    this.templates = {} as Record<PromptId, string>;
    for (const id of KNOWN_IDS) this.templates[id] = overrides[id] ?? REGISTRY[id].template;
  }
  /** Render prompt `id` with `vars`. */
  render(id: PromptId, vars: Record<string, string | number | undefined>): string {
    return renderTemplate(this.templates[id], vars);
  }
}

/** Defaults only — the built-in prompts, no overrides. */
export function defaultPromptTemplates(): PromptTemplates {
  return new PromptTemplates();
}

/**
 * Read `<id>.md` overrides from `dir` and fold them onto the defaults. Absent
 * dir => defaults. Fails fast on a file that names no known id, references an
 * unknown placeholder, or is empty once its doc header is stripped — an
 * operator typo surfaces at boot, not as a silently broken prompt.
 */
export function loadPromptTemplates(dir: string | undefined): PromptTemplates {
  if (!dir || !existsSync(dir)) return defaultPromptTemplates();
  const overrides: Partial<Record<PromptId, string>> = {};
  for (const file of readdirSync(dir)) {
    if (extname(file) !== '.md') continue;
    const id = basename(file, '.md') as PromptId;
    if (!KNOWN_IDS.includes(id)) {
      throw new Error(
        `Prompt template "${file}" in ${dir} names no known prompt id. Known ids: ${KNOWN_IDS.join(', ')}.`,
      );
    }
    const body = stripTemplateDoc(readFileSync(join(dir, file), 'utf8'));
    if (!body) throw new Error(`Prompt template "${file}" in ${dir} is empty after its doc header.`);
    const allowed = REGISTRY[id].placeholders;
    const unknown = [...new Set(placeholdersIn(body))].filter((p) => !allowed.includes(p));
    if (unknown.length > 0) {
      throw new Error(
        `Prompt template "${file}" references unknown placeholder(s) {${unknown.join('}, {')}}. ` +
          `Allowed for "${id}": ${allowed.length ? `{${allowed.join('}, {')}}` : '(none)'}.`,
      );
    }
    overrides[id] = body;
  }
  return new PromptTemplates(overrides);
}
