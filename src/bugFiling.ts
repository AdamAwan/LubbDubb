// → docs/spec/13-jobs-and-tickets.md#filing-a-ticket

const MAX_TITLE = 80;

export function bugTicketFields(
  issue: { number: number; title: string },
  summary: string,
  tracker: string,
): { title: string; vars: Record<string, string> } {
  const firstLine =
    summary
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? summary;
  const title = `Raise bug on #${issue.number}: ${firstLine}`.slice(0, MAX_TITLE);
  return {
    title,
    vars: { number: String(issue.number), title: issue.title, summary, tracker },
  };
}
