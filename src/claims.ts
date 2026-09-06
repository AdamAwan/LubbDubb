// → docs/spec/13-jobs-and-tickets.md

export function claimKey(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const MIN_CONTAINMENT = 24;

export function claimsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < MIN_CONTAINMENT) return false;
  return ` ${long} `.includes(` ${short} `);
}
