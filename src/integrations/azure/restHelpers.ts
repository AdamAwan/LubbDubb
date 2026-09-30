// → docs/spec/15-integrations.md

export function headsRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
}

export function chunkIds(ids: number[], size: number): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

export function tagWriteOp(
  current: readonly string[],
  tags: readonly string[],
): { op: string; path: string; value?: string } {
  const path = '/fields/System.Tags';
  if (tags.length === 0) return { op: 'remove', path };
  if (current.length === 0) return { op: 'add', path, value: tags.join('; ') };
  return { op: 'replace', path, value: tags.join('; ') };
}

export function sameTag(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}
