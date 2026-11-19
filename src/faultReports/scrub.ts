import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// → docs/spec/18-observability.md#reporting-a-fault-to-lubbdubb

const WITHHELD = '‹…›';

const MAX_MESSAGE = 400;
const MAX_FRAMES = 12;

const STANDARD_ERRORS = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'AbortError',
  'SqliteError',
]);

const KEPT_PUNCTUATION = new Set([':', ',', '.', ';', '(', ')', '[', ']', '=', '<', '>', '!', '?', '-', '—', '–', '#']);

const TOKEN =
  /("[^"]*"|(?<![A-Za-z])'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’)|([A-Za-z][A-Za-z0-9+.-]*:\/\/\S+)|(\S+@\S+)|([\w.~-]*(?:[\\/][\w.~@-]+)+[\\/]?)|([A-Za-z_$][\w$]*(?:[.-][A-Za-z_$][\w$]*)*)|(\d[\w.,:]*)|(\s+)|(.)/gsu;

export function wordsOf(text: string): string[] {
  return text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
}

export function isKnown(word: string, vocabulary: ReadonlySet<string>): boolean {
  return vocabulary.has(word.toLowerCase());
}

export function scrubText(text: string, vocabulary: ReadonlySet<string>): string {
  let out = '';
  for (const m of text.matchAll(TOKEN)) {
    const [, quoted, url, email, path, word, number, space, other] = m;
    if (quoted !== undefined) out += WITHHELD;
    else if (url !== undefined) out += '‹url›';
    else if (email !== undefined) out += '‹email›';
    else if (path !== undefined) out += '‹path›';
    else if (word !== undefined) out += word.split(/[.-]/).every((w) => isKnown(w, vocabulary)) ? word : WITHHELD;
    else if (number !== undefined) out += '‹n›';
    else if (space !== undefined) out += ' ';
    else if (other !== undefined && KEPT_PUNCTUATION.has(other)) out += other;
  }
  const collapsed = out
    .replace(/(‹[^›]+›)(?:[\s:.-]*‹[^›]+›)+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.length > MAX_MESSAGE ? `${collapsed.slice(0, MAX_MESSAGE)}…` : collapsed;
}

export function errorClass(detail: string | null, vocabulary: ReadonlySet<string>): string | null {
  const name = /^([A-Z][A-Za-z]*(?:Error|Exception))\b/.exec(detail?.trimStart() ?? '')?.[1];
  if (name === undefined) return null;
  return STANDARD_ERRORS.has(name) || isKnown(name, vocabulary) ? name : null;
}

export interface HarnessFrame {
  file: string;
  line: number;
  fn: string | null;
}

const FRAME = /^\s*at (?:(.+?) \()?((?:file:\/\/)?[^()]+?):(\d+):\d+\)?\s*$/;

export function harnessFrames(detail: string | null, root: string, vocabulary: ReadonlySet<string>): HarnessFrame[] {
  const frames: HarnessFrame[] = [];
  for (const line of (detail ?? '').split('\n')) {
    const m = FRAME.exec(line);
    if (!m) continue;
    const [, fnRaw, location, lineNo] = m;
    const file = harnessPath(location!, root, vocabulary);
    if (file === null) continue;
    const fn = fnRaw === undefined ? null : harnessFunction(fnRaw, vocabulary);
    frames.push({ file, line: Number(lineNo), fn });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

function harnessPath(location: string, root: string, vocabulary: ReadonlySet<string>): string | null {
  let absolute: string;
  try {
    absolute = location.startsWith('file://') ? fileURLToPath(location) : location;
  } catch {
    return null;
  }
  if (!isAbsolute(absolute)) return null;
  const rel = relative(root, absolute).split(sep).join('/');
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const parts = rel.split('/');
  if (!['src', 'dist', 'web'].includes(parts[0]!) || parts.includes('node_modules')) return null;
  const known = parts.every((part) => part.split('.').every((w) => w === '' || isKnown(w, vocabulary)));
  return known ? rel : null;
}

function harnessFunction(raw: string, vocabulary: ReadonlySet<string>): string | null {
  const cleaned = raw.replace(/^(?:async|new)\s+/, '').replace(/\s*\[as [^\]]*\]$/, '');
  if (!/^[\w$.<>]+$/.test(cleaned)) return null;
  const words = wordsOf(cleaned);
  if (words.length === 0) return null;
  return words.every((w) => w === 'anonymous' || isKnown(w, vocabulary)) ? cleaned : null;
}
