// → docs/spec/16-http-api.md#byte-ranges

export type ByteRange = { start: number; end: number } | null | 'unsatisfiable';

/**
 * One `Range: bytes=…` request against a file of `size` bytes. Null means *serve the whole file*:
 * no header, a unit other than bytes, several ranges, or anything malformed — all of which a server
 * may answer with a plain 200.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (match === null) return null;
  const [, from = '', to = ''] = match;
  if (from === '' && to === '') return null;
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}
