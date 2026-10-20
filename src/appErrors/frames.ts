// → docs/spec/39-app-errors.md#frames-against-diffs

const LINE_SUFFIX = /(?::line\s*\d+|:\d+(?::\d+)?|\(\d+(?:,\s*\d+)?\))$/i;
const DRIVE = /^[a-z]:\//i;

/** A frame or a changed path as it names a file: forward slashes, no line number, no drive letter. */
export function framePath(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(LINE_SUFFIX, '').trim().replace(DRIVE, '');
}

function segments(path: string): string[] {
  return framePath(path)
    .toLowerCase()
    .split('/')
    .filter((s) => s !== '' && s !== '.');
}

/**
 * Whether two paths name the same file: the shorter is a whole-segment suffix of the longer, so a
 * deployed `/app/src/Orders/OrderService.cs` and a frame of `Orders/OrderService.cs` both meet the
 * repository's `src/Orders/OrderService.cs`. Case is ignored.
 */
export function samePath(a: string, b: string): boolean {
  const x = segments(a);
  const y = segments(b);
  if (x.length === 0 || y.length === 0) return false;
  const n = Math.min(x.length, y.length);
  for (let i = 1; i <= n; i += 1) if (x[x.length - i] !== y[y.length - i]) return false;
  return true;
}

/** The distinct files among a group's frames, in the order the telemetry printed them. */
export function frameFiles(frames: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const frame of frames) {
    const key = segments(frame).join('/');
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(framePath(frame));
  }
  return out;
}

/** Which of those files a commit's changed paths touch. */
export function filesTouched(files: readonly string[], changed: readonly string[]): string[] {
  return files.filter((file) => changed.some((path) => samePath(file, path)));
}
