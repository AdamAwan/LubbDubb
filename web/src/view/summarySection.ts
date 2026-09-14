// → docs/spec/17-cockpit.md#the-feature-summary

type SummarySection = { kind: 'bullets'; items: string[] } | { kind: 'prose'; text: string };

const MARKER = /^\s*[-*•–—]\s+/;

export function summarySection(body: string): SummarySection {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return { kind: 'prose', text: body.trim() };
  if (!lines.some((line) => MARKER.test(line))) return { kind: 'prose', text: lines.join(' ') };
  const items = lines.map((line) => line.replace(MARKER, '')).filter((line) => line !== '');
  return items.length === 0 ? { kind: 'prose', text: lines.join(' ') } : { kind: 'bullets', items };
}
