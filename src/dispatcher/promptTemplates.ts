import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/**
 * Operator-customisable dispatch prompts.
 *
 * Every agent- (and escalation-) facing prompt the {@link RuleDispatcher} emits
 * has a stable id and a built-in default here. An operator can override any of
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
export type PromptId =
  | 'issue-pickup'
  | 'issue-pickup-escalation'
  | 'pr-ci-fix'
  | 'pr-base-update-behind'
  | 'pr-base-update-conflict'
  | 'pr-review-comment'
  | 'pr-concern-escalation'
  | 'meeting-prep';

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
  'issue-pickup': {
    placeholders: ['number', 'title', 'body', 'branch'],
    template:
      'GitHub issue #{number} ("{title}") needs resolving.\n\n{body}\n\nImplement the fix on branch {branch} and open a pull request that closes this issue.',
    doc: 'Sent to a code agent when an open work item / issue has no linked PR and no agent is on it (rule 4). Placeholders: {number} {title} {body} {branch}.',
  },
  'issue-pickup-escalation': {
    placeholders: ['number', 'title', 'attempts'],
    template:
      'Auto-resolution of issue #{number} ("{title}") keeps failing: {attempts} agent attempt(s) produced no linked PR. Please take a look.',
    doc: 'Escalated to a human when issue pickup keeps failing to produce a linked PR. Placeholders: {number} {title} {attempts}.',
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
  'meeting-prep': {
    placeholders: ['title', 'startsAt', 'docs'],
    template: 'You have a meeting "{title}" at {startsAt}. Read and summarise these docs so I\'m ready: {docs}.',
    doc: 'Sent to a desk agent to prepare for a meeting with unread prep docs. Placeholders: {title} {startsAt} {docs}.',
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
