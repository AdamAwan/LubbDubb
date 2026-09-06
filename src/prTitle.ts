import { renderTemplate } from './dispatcher/promptTemplates.js';

// → docs/spec/07-pull-requests.md#naming

interface PrTitleFieldsInput {
  number: number;
  title: string;
  position: number;
  total: number;
  type?: string;
  scope?: string;
  summary: string;
}

export function prTitleFields(input: PrTitleFieldsInput): Record<string, string> {
  const type = input.type?.trim() ?? '';
  const scope = input.scope?.trim() ?? '';
  return {
    number: String(input.number),
    title: input.title,
    position: input.total > 1 ? `[${input.position}/${input.total}] ` : '',
    total: String(input.total),
    type,
    scope,
    kind: type ? (scope ? `${type}(${scope}): ` : `${type}: `) : '',
    summary: input.summary.trim(),
  };
}

export function renderPrTitle(template: string, fields: Record<string, string>): string {
  return renderTemplate(template, fields).replace(/\s+/g, ' ').trim();
}
