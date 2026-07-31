import { renderTemplate } from './dispatcher/promptTemplates.js';

/**
 * The one place a pull request's title is decided.
 *
 * The fields are assembled as *finished clauses*, not raw values, and that is the
 * whole design. `pr-title` is an operator-overridable template, so anything
 * conditional — the position clause on a PR that stacks on nothing, the
 * parentheses around a scope the agent never declared — has to be resolved here
 * or every override re-implements it and they drift. An override stays a plain
 * substitution, which is what makes house style a file drop rather than a patch.
 *
 * Pure: no provider call, no world read. The agent supplies the summary (and
 * optionally the type and scope, the one thing it knows that the harness does
 * not); everything else comes off rows the harness already holds.
 */

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
    // A PR that stacks on nothing is not "1/1" — it has no position to state.
    position: input.total > 1 ? `[${input.position}/${input.total}] ` : '',
    total: String(input.total),
    type,
    scope,
    // Undeclared type => no prefix at all, rather than a stray colon.
    kind: type ? (scope ? `${type}(${scope}): ` : `${type}: `) : '',
    summary: input.summary.trim(),
  };
}

/**
 * Substitute the fields into a template.
 *
 * The substitution is `renderTemplate`'s, not a second one — an override is
 * placeholder-validated at load against the same book, so the two must agree
 * about what a `{token}` means. What this adds is the whitespace collapse: the
 * default template needs none (the clauses carry their own trailing space and sit
 * adjacent), but an override that spaces its tokens apart would otherwise render
 * a double space wherever an empty clause fell out.
 */
export function renderPrTitle(template: string, fields: Record<string, string>): string {
  return renderTemplate(template, fields).replace(/\s+/g, ' ').trim();
}
