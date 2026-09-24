// → docs/spec/08-planning.md#the-alignment-check

const HEADING = /^acceptance\s+criteria\s*:?$/i;

/**
 * The ticket's own acceptance criteria: the section under an "Acceptance criteria"
 * heading, up to the next heading. Markdown (`## Acceptance criteria`, or a line that
 * is only `**Acceptance criteria**`) and the HTML Azure DevOps bodies are composed of
 * (`<h3>Acceptance criteria</h3>`) are both read. Null when there is no such heading,
 * or nothing under it.
 */
export function ticketCriteria(body: string | null | undefined): string | null {
  if (!body) return null;
  return htmlSection(body) ?? markdownSection(body);
}

function markdownSection(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => heading(line) !== null && HEADING.test(heading(line)!));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => heading(line) !== null);
  const section = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return section === '' ? null : section;
}

function heading(line: string): string | null {
  const trimmed = line.trim();
  const hashes = /^#{1,6}\s+(.+?)\s*#*$/.exec(trimmed);
  if (hashes) return hashes[1]!.trim();
  const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)$/.exec(trimmed);
  if (bold) return bold[1]!.trim();
  return null;
}

function htmlSection(body: string): string | null {
  const open = /<h([1-6])[^>]*>\s*acceptance\s+criteria\s*:?\s*<\/h\1>/i.exec(body);
  if (!open) return null;
  const rest = body.slice(open.index + open[0].length);
  const next = /<h[1-6][^>]*>/i.exec(rest);
  const section = (next ? rest.slice(0, next.index) : rest).trim();
  return section === '' ? null : section;
}
