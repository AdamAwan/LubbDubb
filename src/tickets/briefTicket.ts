// → docs/spec/13-jobs-and-tickets.md

const MAX_TITLE = 80;

export function briefTicketFields(request: string): { title: string; vars: Record<string, string> } {
  const firstLine =
    request
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? request;
  return { title: firstLine.slice(0, MAX_TITLE), vars: { request } };
}
