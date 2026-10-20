// → docs/spec/39-app-errors.md

const MAX_FINGERPRINT_CHARS = 200;
const MAX_TITLE_CHARS = 300;
const MAX_TEXT_CHARS = 200;
const MAX_FRAMES = 20;
const MAX_FRAME_CHARS = 300;
const MAX_URL_CHARS = 2000;
export const MAX_ROWS_PER_READ = 500;

export const SINCE_TOKEN = '{since}';

/** One row of the `errors` command's output, after the contract has been checked. */
export interface AppErrorRow {
  fingerprint: string;
  title: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  version: string | null;
  operation: string | null;
  frames: string[];
  url: string | null;
}

export type AppErrorReport =
  { status: 'ok'; rows: AppErrorRow[]; refused: string[]; dropped: number } | { status: 'unknown'; detail: string };

export function unreadableErrors(detail: string): AppErrorReport {
  return { status: 'unknown', detail };
}

export function errorsCommand(list: string, since: string): string {
  return list.split(SINCE_TOKEN).join(since);
}

export function parseAppErrorReport(stdout: string): AppErrorReport {
  const text = stdout.trim();
  if (text === '') return unreadableErrors('the errors command printed nothing — an empty list is [], not silence');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return unreadableErrors(`the errors command did not answer with JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(json))
    return unreadableErrors('the errors command answered with something other than a list of error groups');
  const refused: string[] = [];
  const byFingerprint = new Map<string, AppErrorRow>();
  json.forEach((value, i) => {
    const row = readRow(value);
    if (typeof row === 'string') {
      refused.push(`row ${String(i)}: ${row}`);
      return;
    }
    const seen = byFingerprint.get(row.fingerprint);
    byFingerprint.set(row.fingerprint, seen === undefined ? row : fold(seen, row));
  });
  if (json.length > 0 && byFingerprint.size === 0)
    return unreadableErrors(`every row the errors command printed was refused — ${refused[0] ?? ''}`);
  const rows = [...byFingerprint.values()].sort((a, b) => b.count - a.count);
  return {
    status: 'ok',
    rows: rows.slice(0, MAX_ROWS_PER_READ),
    refused,
    dropped: Math.max(0, rows.length - MAX_ROWS_PER_READ),
  };
}

function fold(a: AppErrorRow, b: AppErrorRow): AppErrorRow {
  const later = b.lastSeen > a.lastSeen ? b : a;
  return {
    ...later,
    count: a.count + b.count,
    firstSeen: a.firstSeen < b.firstSeen ? a.firstSeen : b.firstSeen,
    lastSeen: later.lastSeen,
  };
}

function readRow(value: unknown): AppErrorRow | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object';
  const row = value as Record<string, unknown>;
  const identity = readIdentity(row);
  if (typeof identity === 'string') return identity;
  const detail = readDetail(row);
  if (typeof detail === 'string') return detail;
  return { ...identity, ...detail };
}

type Identity = Pick<AppErrorRow, 'fingerprint' | 'title' | 'count' | 'firstSeen' | 'lastSeen'>;

function readIdentity(row: Record<string, unknown>): Identity | string {
  const fingerprint = row['fingerprint'];
  if (typeof fingerprint !== 'string' || fingerprint.trim() === '') return '"fingerprint" must be a non-empty string';
  if (fingerprint.length > MAX_FINGERPRINT_CHARS)
    return `"fingerprint" is longer than ${String(MAX_FINGERPRINT_CHARS)} characters — it is an identity, not a message`;
  const title = row['title'];
  if (typeof title !== 'string' || title.trim() === '') return '"title" must be a non-empty string';
  const count = row['count'];
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1)
    return '"count" must be a whole number of at least 1';
  const firstSeen = instant(row['firstSeen']);
  if (firstSeen === null) return '"firstSeen" must be an ISO timestamp';
  const lastSeen = instant(row['lastSeen']);
  if (lastSeen === null) return '"lastSeen" must be an ISO timestamp';
  if (firstSeen > lastSeen) return '"firstSeen" is after "lastSeen"';
  return { fingerprint: fingerprint.trim(), title: title.trim().slice(0, MAX_TITLE_CHARS), count, firstSeen, lastSeen };
}

function readDetail(row: Record<string, unknown>): Omit<AppErrorRow, keyof Identity> | string {
  const version = optionalText(row['version'], 'version');
  if (typeof version === 'object' && version !== null) return version.refused;
  const operation = optionalText(row['operation'], 'operation');
  if (typeof operation === 'object' && operation !== null) return operation.refused;
  const frames = readFrames(row['frames']);
  if (typeof frames === 'string') return frames;
  const url = readUrl(row['link']);
  if (typeof url === 'object' && url !== null) return url.refused;
  return { version, operation, frames, url };
}

function instant(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function optionalText(value: unknown, name: string): string | null | { refused: string } {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return { refused: `"${name}" must be a string, or be left out` };
  const text = value.trim();
  return text === '' ? null : text.slice(0, MAX_TEXT_CHARS);
}

function readFrames(value: unknown): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((f) => typeof f !== 'string'))
    return '"frames" must be a list of strings, or be left out';
  return (value as string[])
    .map((f) => f.trim().slice(0, MAX_FRAME_CHARS))
    .filter((f) => f !== '')
    .slice(0, MAX_FRAMES);
}

function readUrl(value: unknown): string | null | { refused: string } {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS) return { refused: '"link" must be a URL string' };
  if (!URL.canParse(value)) return { refused: '"link" must be an absolute http(s) URL' };
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    return { refused: '"link" must be an absolute http(s) URL' };
  return value;
}
