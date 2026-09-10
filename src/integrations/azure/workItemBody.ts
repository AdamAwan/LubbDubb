// → docs/spec/15-integrations.md#where-a-work-items-body-lives

const NAMED_BODY_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['System.Description', 'Description'],
  ['Microsoft.VSTS.TCM.ReproSteps', 'Repro steps'],
  ['Microsoft.VSTS.Common.AcceptanceCriteria', 'Acceptance criteria'],
  ['Microsoft.VSTS.TCM.SystemInfo', 'System info'],
];

const NEVER_BODY_FIELDS = new Set(['System.Title', 'System.Tags', 'System.History']);

const RICH_TEXT = /<\/?(?:p|div|br|ul|ol|li|h[1-6]|span|table|tr|td|strong|b|em|i|a|pre|code|img)\b[^>]*>/i;

export function composeWorkItemBody(fields: Record<string, unknown>): string {
  const named = new Set(NAMED_BODY_FIELDS.map(([name]) => name));
  const sections: Array<{ heading: string; html: string }> = [];
  for (const [name, heading] of NAMED_BODY_FIELDS) {
    const html = text(fields[name]);
    if (html !== '') sections.push({ heading, html });
  }
  for (const [name, value] of Object.entries(fields)) {
    if (named.has(name) || NEVER_BODY_FIELDS.has(name)) continue;
    const html = text(value);
    if (html !== '' && RICH_TEXT.test(html)) sections.push({ heading: fieldHeading(name), html });
  }
  if (sections.length === 0) return '';
  const [only] = sections;
  if (sections.length === 1 && only!.heading === 'Description') return only!.html;
  return sections.map((s) => `<h3>${s.heading}</h3>\n${s.html}`).join('\n');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function fieldHeading(name: string): string {
  const leaf = name.slice(name.lastIndexOf('.') + 1);
  const spaced = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
