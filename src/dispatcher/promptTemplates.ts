import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { ISSUE_PROMPTS } from './issuePrompts.js';
import { VALIDATION_PROMPTS } from './validationPrompts.js';
import { PULL_REQUEST_PROMPTS } from './pullRequestPrompts.js';
import { TICKET_PROMPTS } from './ticketPrompts.js';

// → docs/spec/05-dispatcher.md

type PromptId =
  | 'issue-plan'
  | 'issue-replan'
  | 'discuss-plan'
  | 'plan-part'
  | 'plan-approval'
  | 'plan-amendment'
  | 'issue-shortfall'
  | 'plan-part-escalation'
  | 'issue-pickup'
  | 'issue-pickup-escalation'
  | 'issue-assess'
  | 'issue-assay'
  | 'issue-appraisal'
  | 'criteria-alignment'
  | 'prediction-judge'
  | 'issue-retro'
  | 'feature-sequence'
  | 'feature-resequence'
  | 'feature-summary'
  | 'validation-plan'
  | 'validation-check'
  | 'validation-plan-approval'
  | 'validation-failed'
  | 'local-validation'
  | 'local-validation-fix'
  | 'remote-validation'
  | 'obstacle-repair'
  | 'obstacle-ticket-body'
  | 'local-run'
  | 'pr-ci-fix'
  | 'pr-ci-gate'
  | 'pr-base-update-behind'
  | 'pr-base-update-conflict'
  | 'pr-review-triage'
  | 'pr-split'
  | 'pr-describe'
  | 'pr-description-check'
  | 'pr-review'
  | 'pr-review-comment'
  | 'review-pack-author'
  | 'review-pack-check'
  | 'pr-concern-escalation'
  | 'finding-ticket'
  | 'docs-change'
  | 'work-item-ticket'
  | 'raise-bug'
  | 'blueprint-ticket'
  | 'work-item-ticket-body'
  | 'blueprint-ticket-body'
  | 'brief-ticket-body'
  | 'pr-title';

export interface TemplateDef {
  readonly placeholders: readonly string[];
  readonly template: string;
  readonly doc: string;
  readonly retired?: true;
}

const REGISTRY: Record<PromptId, TemplateDef> = {
  ...ISSUE_PROMPTS,
  ...VALIDATION_PROMPTS,
  ...PULL_REQUEST_PROMPTS,
  ...TICKET_PROMPTS,
};

const KNOWN_IDS = Object.keys(REGISTRY) as PromptId[];

function placeholdersIn(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

export function renderTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars && vars[name] !== undefined ? String(vars[name]) : whole,
  );
}

export function stripTemplateDoc(raw: string): string {
  return raw.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
}

export function sampleTemplateFile(id: PromptId): string {
  return `<!--\n  ${REGISTRY[id].doc}\n-->\n\n${REGISTRY[id].template}\n`;
}

export interface PromptTemplateDescription {
  readonly id: PromptId;
  readonly doc: string;
  readonly placeholders: readonly string[];
  readonly template: string;
  readonly overridden: boolean;
  readonly retired: boolean;
}

export class PromptTemplates {
  private readonly templates: Record<PromptId, string>;
  private readonly overridden: Set<PromptId>;
  constructor(overrides: Partial<Record<PromptId, string>> = {}) {
    this.templates = {} as Record<PromptId, string>;
    for (const id of KNOWN_IDS) this.templates[id] = overrides[id] ?? REGISTRY[id].template;
    this.overridden = new Set(KNOWN_IDS.filter((id) => overrides[id] !== undefined));
  }
  render(id: PromptId, vars: Record<string, string | number | undefined>): string {
    return renderTemplate(this.templates[id], vars);
  }
  describe(): PromptTemplateDescription[] {
    return KNOWN_IDS.map((id) => ({
      id,
      doc: REGISTRY[id].doc,
      placeholders: REGISTRY[id].placeholders,
      template: this.templates[id],
      overridden: this.overridden.has(id),
      retired: REGISTRY[id].retired === true,
    }));
  }
}

export function defaultPromptTemplates(): PromptTemplates {
  return new PromptTemplates();
}

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
