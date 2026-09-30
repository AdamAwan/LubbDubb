// → docs/spec/15-integrations.md

export function stripLogTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
}

export function taskIssueLine(record: { name: string }, message: string): string {
  return `${record.name}: ${message.replace(/\s*\n\s*/g, ' ').trim()}`;
}
